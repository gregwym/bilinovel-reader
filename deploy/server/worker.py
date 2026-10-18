#!/usr/bin/env python3
"""Rootless reconciler. The socket is a wakeup only; no arguments cross it."""
import hashlib
import io
import json
import os
import re
import socket
import subprocess
import time
import zipfile
from pathlib import Path

REPOSITORY = "gregwym/bilinovel-reader"
REPOSITORY_ID = 1406537869
WORKFLOW = "server-image.yml"
IMAGE_PATTERN = r"ghcr\.io/gregwym/bilinovel-reader@sha256:[a-f0-9]{64}"
API = "repos/" + REPOSITORY
STATE = Path("/srv/bili-reader-cd")
SOCKET = "/run/bili-reader-cd/wake.sock"
DEPLOY = "/opt/bili-reader-cd/deploy-image.sh"


def gh(path, binary=False):
    # gh owns redirect/auth handling. Never take a URL from a webhook/artifact.
    result = subprocess.run(["/usr/bin/gh", "api", "--hostname", "github.com", path],
                            check=True, capture_output=True, timeout=120)
    if len(result.stdout) > 4 * 1024 * 1024:
        raise ValueError("oversized API response")
    return result.stdout if binary else json.loads(result.stdout)


def approved(run, head):
    return (run.get("status") == "completed" and run.get("conclusion") == "success"
            and run.get("head_branch") == "main" and run.get("head_sha") == head
            and run.get("event") in ("push", "workflow_dispatch")
            and run.get("path") == ".github/workflows/" + WORKFLOW
            and run.get("head_repository", {}).get("id") == REPOSITORY_ID
            and isinstance(run.get("id"), int) and run["id"] > 0)


def read_manifest(blob, run):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        if archive.namelist() != ["deployment.json"]:
            raise ValueError("unexpected archive entries")
        entry = archive.getinfo("deployment.json")
        if entry.file_size > 4096:
            raise ValueError("oversized manifest")
        manifest = json.loads(archive.read(entry))
    if (not re.fullmatch(IMAGE_PATTERN, manifest.get("image", ""))
            or manifest.get("revision") != run["head_sha"]
            or manifest.get("run_id") != str(run["id"])
            or manifest.get("run_attempt") != str(run["run_attempt"])):
        raise ValueError("manifest does not belong to this approved run")
    return manifest


def reconcile(api=gh, deploy=None, state=STATE):
    repo = api(API)
    if repo["id"] != REPOSITORY_ID or repo["full_name"] != REPOSITORY:
        raise ValueError("repository identity")
    head = api(API + "/commits/main")["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", head):
        raise ValueError("head SHA")
    runs = api(API + "/actions/workflows/" + WORKFLOW
               + "/runs?branch=main&status=success&per_page=20")["workflow_runs"]
    candidates = [r for r in runs if approved(r, head)]
    if not candidates:
        return "no approved image for current main"
    run = max(candidates, key=lambda r: (r["id"], r["run_attempt"]))
    receipt = state / "deployed.json"
    prior = json.loads(receipt.read_text()) if receipt.exists() else {}
    if prior.get("revision") == head:
        return "already deployed"
    if prior and int(run["id"]) <= int(prior["run_id"]):
        raise ValueError("refusing older run/replayed release")
    artifacts = api(API + f"/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
    artifacts = [a for a in artifacts if not a["expired"]
                 and a["name"] == f"server-deployment-{run['run_attempt']}"]
    if len(artifacts) != 1 or not 0 < artifacts[0]["size_in_bytes"] < 65536:
        raise ValueError("missing/ambiguous deployment artifact")
    artifact = artifacts[0]
    aid = artifact["id"]
    if not isinstance(aid, int) or aid <= 0:
        raise ValueError("artifact id")
    blob = api(API + f"/actions/artifacts/{aid}/zip", binary=True)
    if artifact.get("digest") != "sha256:" + hashlib.sha256(blob).hexdigest():
        raise ValueError("artifact digest mismatch or unavailable")
    manifest = read_manifest(blob, run)
    # Recheck just before mutating production, after the network operations.
    if api(API + "/commits/main")["sha"] != head:
        return "main advanced; wait for its image"
    if deploy is None:
        deploy = lambda image, revision: subprocess.run(
            [DEPLOY, image, revision], check=True, timeout=1800)
    deploy(manifest["image"], head)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = state / ".deployed.next"
    temporary.write_text(json.dumps(manifest))
    temporary.replace(receipt)
    return "deployed " + head


def main():
    if os.getuid() == 0:
        raise SystemExit("worker must not run as root")
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Prevent a second worker, including a manual invocation.
    import fcntl
    with (STATE / "worker.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = Path(SOCKET)
        if path.exists():
            path.unlink()
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
            server.bind(SOCKET)
            # Socket directory: worker-owned, group bili-signal, mode 0710.
            # Receiver can send, but cannot unlink/replace the socket.
            import grp
            os.chown(SOCKET, -1, grp.getgrnam("bili-signal").gr_gid)
            os.chmod(SOCKET, 0o620)
            deadline = 0.0
            last_check = -60.0
            while True:
                now = time.monotonic()
                if now >= deadline:
                    try:
                        print(reconcile(), flush=True)
                        deadline = time.monotonic() + 900
                    except Exception as exc:
                        # Exception type only: gh stderr may contain credential context.
                        print("reconcile failed: " + type(exc).__name__, flush=True)
                        deadline = time.monotonic() + 300
                    last_check = time.monotonic()
                server.settimeout(max(0.05, deadline - time.monotonic()))
                try:
                    server.recv(32)  # Intentionally discard all payload bytes.
                    if time.monotonic() - last_check >= 30:
                        deadline = 0
                except socket.timeout:
                    pass


if __name__ == "__main__":
    main()
