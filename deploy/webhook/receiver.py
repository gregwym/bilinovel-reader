#!/usr/bin/env python3
"""Unprivileged GitHub webhook: can only wake a local worker, never deploy."""
import hashlib
import hmac
import json
import os
import socket
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPOSITORY = "gregwym/bilinovel-reader"
REPOSITORY_ID = 1406537869
WORKFLOW = ".github/workflows/server-image.yml"
SIGNAL_SOCKET = "/run/bili-reader-cd/wake.sock"
MAX_BODY = 262144
DEFAULT_POLICY = dict(repository=REPOSITORY, repository_id=REPOSITORY_ID,
                      workflow=WORKFLOW, branch="main", route="/hooks/bili-reader",
                      signal_socket=SIGNAL_SOCKET)


def load_policy(path):
    """Only administrator-owned local configuration selects a wake target."""
    policy = json.loads(Path(path).read_text())
    if not isinstance(policy, dict) or set(policy) != set(DEFAULT_POLICY):
        raise ValueError("invalid receiver policy keys")
    if (type(policy["repository_id"]) is not int or policy["repository_id"] <= 0
            or any(not isinstance(policy[k], str) or not policy[k]
                   for k in policy if k != "repository_id")
            or len(policy["repository"].split("/")) != 2
            or not policy["workflow"].startswith(".github/workflows/")
            or not policy["route"].startswith("/hooks/")
            or not policy["signal_socket"].startswith("/")
            or ".." in Path(policy["signal_socket"]).parts):
        raise ValueError("invalid receiver policy")
    return policy


def validate(body, signature, event, secret, now=None, policy=None):
    policy = DEFAULT_POLICY if policy is None else policy
    if len(secret) < 32 or len(body) > MAX_BODY:
        raise ValueError("size/secret")
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("signature")
    if event != "workflow_run":
        raise ValueError("event")
    payload = json.loads(body)
    repo, run = payload["repository"], payload["workflow_run"]
    if (repo["id"] != policy["repository_id"] or repo["full_name"] != policy["repository"]
            or payload["action"] != "completed" or run["status"] != "completed"
            or run["conclusion"] != "success" or run["head_branch"] != policy["branch"]
            or run["event"] not in ("push", "workflow_dispatch")
            or run["path"] != policy["workflow"]
            or run["head_repository"]["id"] != policy["repository_id"]):
        raise ValueError("unapproved run")
    stamp = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00")).timestamp()
    age = (time.time() if now is None else now) - stamp
    if not -60 <= age <= 600:
        raise ValueError("expired event; worker polling recovers missed updates")
    return hashlib.sha256(body).digest()


class Receiver(BaseHTTPRequestHandler):
    policy = DEFAULT_POLICY
    seen = {}
    last_wake = 0.0
    secret = b""

    def log_message(self, *_args):
        pass  # Never log request bodies, headers, or credentials.

    def do_POST(self):
        if self.path != self.policy["route"]:
            self.send_error(404)
            return
        try:
            if len(self.headers.get_all("Content-Length", [])) != 1:
                raise ValueError("ambiguous body size")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                raise ValueError("body size")
            self.connection.settimeout(5)
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("truncated body")
            key = validate(body, self.headers.get("X-Hub-Signature-256", ""),
                           self.headers.get("X-GitHub-Event", ""), self.secret,
                           policy=self.policy)
            now = time.monotonic()
            self.__class__.seen = {k: t for k, t in self.seen.items() if now - t < 660}
            if key not in self.seen and now - self.last_wake >= 10:
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
                    client.sendto(b"check", self.policy["signal_socket"])
                self.__class__.last_wake = now
                if len(self.seen) < 4096:
                    self.seen[key] = now
            self.send_response(202)
            self.end_headers()
        except (ValueError, KeyError, TypeError, UnicodeError):
            self.send_error(403)
        except OSError:
            self.send_error(503)  # GitHub redelivery or periodic reconciliation.


class BoundedHTTPServer(HTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", help="administrator-owned local JSON policy")
    parser.add_argument("--secret-file", default="/etc/bili-reader-hook/secret")
    parser.add_argument("--container", action="store_true",
                        help="listen on container interfaces; requires isolated Docker network, no published ports")
    args = parser.parse_args()
    if args.config:
        Receiver.policy = load_policy(args.config)
    os.umask(0o077)
    Receiver.secret = Path(args.secret_file).read_bytes().strip()
    if len(Receiver.secret) < 32:
        raise SystemExit("webhook secret must contain at least 32 bytes")
    # Bind address is local administrator configuration, never webhook input.
    address = ("0.0.0.0" if args.container else
               Path("/etc/bili-reader-hook/bind-address").read_text().strip())
    import ipaddress
    if not args.container and (not ipaddress.ip_address(address).is_private or address == "0.0.0.0"):
        raise SystemExit("receiver requires a private host/proxy bridge address")
    BoundedHTTPServer((address, 18791), Receiver).serve_forever()
