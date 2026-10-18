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


def validate(body, signature, event, secret, now=None):
    if len(secret) < 32 or len(body) > MAX_BODY:
        raise ValueError("size/secret")
    expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("signature")
    if event != "workflow_run":
        raise ValueError("event")
    payload = json.loads(body)
    repo, run = payload["repository"], payload["workflow_run"]
    if (repo["id"] != REPOSITORY_ID or repo["full_name"] != REPOSITORY
            or payload["action"] != "completed" or run["status"] != "completed"
            or run["conclusion"] != "success" or run["head_branch"] != "main"
            or run["event"] not in ("push", "workflow_dispatch")
            or run["path"] != WORKFLOW or run["head_repository"]["id"] != REPOSITORY_ID):
        raise ValueError("unapproved run")
    stamp = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00")).timestamp()
    age = (time.time() if now is None else now) - stamp
    if not -60 <= age <= 600:
        raise ValueError("expired event; worker polling recovers missed updates")
    return hashlib.sha256(body).digest()


class Receiver(BaseHTTPRequestHandler):
    seen = {}
    last_wake = 0.0
    secret = b""

    def log_message(self, *_args):
        pass  # Never log request bodies, headers, or credentials.

    def do_POST(self):
        if self.path != "/hooks/bili-reader":
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
                           self.headers.get("X-GitHub-Event", ""), self.secret)
            now = time.monotonic()
            self.__class__.seen = {k: t for k, t in self.seen.items() if now - t < 660}
            if key not in self.seen and now - self.last_wake >= 10:
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
                    client.sendto(b"check", SIGNAL_SOCKET)
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
    os.umask(0o077)
    Receiver.secret = Path("/etc/bili-reader-hook/secret").read_bytes().strip()
    if len(Receiver.secret) < 32:
        raise SystemExit("webhook secret must contain at least 32 bytes")
    # Bind address is local administrator configuration, never webhook input.
    address = Path("/etc/bili-reader-hook/bind-address").read_text().strip()
    import ipaddress
    if not ipaddress.ip_address(address).is_private or address == "0.0.0.0":
        raise SystemExit("receiver requires a private host/proxy bridge address")
    BoundedHTTPServer((address, 18791), Receiver).serve_forever()
