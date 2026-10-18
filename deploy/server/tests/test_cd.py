import hashlib
import hmac
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, (HERE.parent / "webhook/receiver.py" if name == "webhook" else HERE / (name + ".py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook, worker = load("webhook"), load("worker")
SHA = "a" * 40
IMAGE = "ghcr.io/gregwym/bilinovel-reader@sha256:" + "b" * 64


def run_record():
    return dict(id=12, run_attempt=1, status="completed", conclusion="success",
                head_branch="main", head_sha=SHA, event="push", path=hook.WORKFLOW,
                head_repository={"id": hook.REPOSITORY_ID}, updated_at="2026-10-17T00:00:00Z")


def archive(manifest):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("deployment.json", json.dumps(manifest))
    return buf.getvalue()


class WebhookTests(unittest.TestCase):
    def setUp(self):
        self.payload = dict(repository={"id": hook.REPOSITORY_ID, "full_name": hook.REPOSITORY},
                            action="completed", workflow_run=run_record())
        self.secret = b"x" * 32

    def validate(self, signature=None):
        body = json.dumps(self.payload).encode()
        sig = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        return hook.validate(body, sig if signature is None else signature, "workflow_run",
                             self.secret, 1792195200)

    def test_valid(self):
        self.assertEqual(len(self.validate()), 32)

    def test_bad_signature(self):
        with self.assertRaises(ValueError):
            self.validate("sha256=" + "0" * 64)

    def test_signed_but_unapproved(self):
        for key, value in [("event", "pull_request"), ("head_branch", "feature"),
                           ("conclusion", "failure"), ("path", ".github/workflows/evil.yml"),
                           ("updated_at", "2020-01-01T00:00:00Z"),
                           ("head_repository", {"id": 99})]:
            with self.subTest(key=key):
                self.setUp()
                self.payload["workflow_run"][key] = value
                with self.assertRaises(ValueError):
                    self.validate()

    def test_repository_mismatch(self):
        self.payload["repository"]["id"] = 99
        with self.assertRaises(ValueError):
            self.validate()

    def test_oversized(self):
        with self.assertRaises(ValueError):
            hook.validate(b"x" * (hook.MAX_BODY + 1), "", "workflow_run", self.secret)

    def test_local_target_policy_isolation(self):
        policy = dict(hook.DEFAULT_POLICY, repository="test/other", repository_id=42,
                      workflow=".github/workflows/other.yml")
        body = json.dumps(self.payload).encode()
        sig = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        with self.assertRaises(ValueError):
            hook.validate(body, sig, "workflow_run", self.secret, 1792195200, policy)
        self.payload["repository"] = dict(id=42, full_name="test/other")
        self.payload["workflow_run"].update(path=policy["workflow"], head_repository=dict(id=42))
        body = json.dumps(self.payload).encode()
        sig = "sha256=" + hmac.new(self.secret, body, hashlib.sha256).hexdigest()
        self.assertEqual(len(hook.validate(body, sig, "workflow_run", self.secret,
                                          1792195200, policy)), 32)
        with self.assertRaises(ValueError):
            hook.validate(body, sig, "workflow_run", self.secret, 1792195200)

    def test_policy_rejects_commands_and_invalid_paths(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "policy.json"
            for changes in (dict(command="docker run arbitrary"),
                            dict(signal_socket="/run/../docker.sock"),
                            dict(repository_id=True), dict(route="/admin")):
                with self.subTest(changes=changes):
                    path.write_text(json.dumps(dict(hook.DEFAULT_POLICY, **changes)))
                    with self.assertRaises(ValueError):
                        hook.load_policy(path)

    def test_reader_example_policy(self):
        policy = hook.load_policy(HERE.parent / "webhook/reader.json")
        self.assertEqual(policy["repository_id"], hook.REPOSITORY_ID)
        self.assertEqual(policy["signal_socket"], "/run/cd-hook/wake.sock")


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.run = run_record()
        self.manifest = dict(image=IMAGE, revision=SHA, run_id="12", run_attempt="1")
        self.blob = archive(self.manifest)
        self.calls = []
        self.head = SHA
        self.bad_digest = False
        self.duplicate = False

    def api(self, path, binary=False):
        if path == worker.API:
            return dict(id=hook.REPOSITORY_ID, full_name=hook.REPOSITORY)
        if path.endswith("/commits/main"):
            return dict(sha=self.head)
        if "/actions/workflows/" in path:
            return dict(workflow_runs=[self.run])
        if path.endswith("/zip"):
            return self.blob
        if "/artifacts?" in path:
            artifact = dict(id=5, name="server-deployment-1", expired=False,
                            size_in_bytes=len(self.blob),
                            digest="sha256:" + hashlib.sha256(self.blob).hexdigest())
            if self.bad_digest:
                artifact["digest"] = "sha256:" + "0" * 64
            return dict(artifacts=[artifact, artifact] if self.duplicate else [artifact])
        raise AssertionError(path)

    def check(self, deploy=None):
        return worker.reconcile(self.api, deploy or (lambda *args: self.calls.append(args)), self.state)

    def test_deploy_then_idempotent(self):
        self.assertTrue(self.check().startswith("deployed"))
        self.assertEqual(self.calls, [(IMAGE, SHA)])
        self.assertEqual(self.check(), "already deployed")
        self.assertEqual(len(self.calls), 1)

    def test_pr_or_wrong_workflow_does_not_deploy(self):
        for key, value in [("event", "pull_request"), ("path", "evil.yml"),
                           ("head_repository", {"id": 1}), ("head_sha", "c" * 40)]:
            with self.subTest(key=key):
                self.run = run_record()
                self.run[key] = value
                self.assertEqual(self.check(), "no approved image for current main")
        self.assertFalse(self.calls)

    def test_untrusted_manifest(self):
        for key, value in [("image", "evil.io/image@sha256:" + "b" * 64),
                           ("image", IMAGE + "; touch /tmp/pwn"),
                           ("revision", "c" * 40), ("run_id", "999"),
                           ("run_attempt", "2")]:
            with self.subTest(key=key):
                bad = dict(self.manifest)
                bad[key] = value
                self.blob = archive(bad)
                with self.assertRaises(ValueError):
                    self.check()
        self.assertFalse(self.calls)

    def test_artifact_tamper_or_ambiguity(self):
        self.bad_digest = True
        with self.assertRaises(ValueError):
            self.check()
        self.bad_digest, self.duplicate = False, True
        with self.assertRaises(ValueError):
            self.check()
        self.assertFalse(self.calls)

    def test_stale_run(self):
        (self.state / "deployed.json").write_text(json.dumps(dict(run_id="15", revision="c" * 40)))
        with self.assertRaises(ValueError):
            self.check()
        self.assertFalse(self.calls)

    def test_deploy_failure_does_not_write_receipt(self):
        def fail(*_args):
            raise RuntimeError("failed rollout")
        with self.assertRaises(RuntimeError):
            self.check(fail)
        self.assertFalse((self.state / "deployed.json").exists())

    def test_main_advances_during_download(self):
        original = self.api
        def api(path, binary=False):
            value = original(path, binary)
            if path.endswith("/zip"):
                self.head = "c" * 40
            return value
        self.assertEqual(worker.reconcile(api, lambda *a: self.calls.append(a), self.state),
                         "main advanced; wait for its image")
        self.assertFalse(self.calls)

    def test_archive_traversal(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("../deployment.json", "{}")
        with self.assertRaises(ValueError):
            worker.read_manifest(buf.getvalue(), self.run)


class RolloutTests(unittest.TestCase):
    """Run real snapshot/recovery code against a fake daemon, not production."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        for name in ("root/data", "root/library", "state", "config", "bin", "mock"):
            (self.base / name).mkdir(parents=True)
        (self.base / "root/data/book").write_text("original")
        (self.base / "root/library/audio").write_text("audio")
        (self.base / "config/app.env").write_text("APP_PASSWORD=fixture-only\n")
        (self.base / "config/compose.yml").write_text("fixture")
        (self.base / "bin/check.mjs").write_text("// fixture")
        (self.base / "state/current-image").write_text("previous:fixture\n")
        script = (HERE / "deploy-image.sh").read_text()
        for key, directory in [("ROOT", "root"), ("STATE", "state"), ("CONFIG", "config"), ("BIN", "bin")]:
            import re
            script = re.sub(r"^" + key + r"=.*$", key + "=" + str(self.base / directory), script, flags=re.M)
        script = script.replace("export PATH=/usr/local/bin:/usr/bin:/bin",
                                "export PATH=" + str(self.base / "mock") + ":" + os.environ["PATH"])
        # The fixture runs no actual daemon and can run under root CI containers.
        script = script.replace("[[ $EUID -ne 0 ]]", "[[ 1 -eq 1 ]]")
        self.script = self.base / "rollout.sh"
        self.script.write_text(script)
        fake = self.base / "mock/docker"
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
b = Path(os.environ['CD_FIXTURE'])
a = sys.argv[1:]
with (b/'calls').open('a') as f: f.write(json.dumps(a)+'\\n')
if a[0] == 'info': print('["name=rootless"]')
if a[:2] == ['image', 'inspect']: print('a'*40)
if a[0] == 'compose' and 'up' in a and os.environ.get('BILI_IMAGE') != 'previous:fixture':
    (b/'root/data/book').write_text('new-data')
if a[0] == 'exec' and a[-1].startswith('https:') and (b/'fail-public').exists():
    (b/'fail-public').unlink()
    sys.exit(1)
''')
        fake.chmod(0o755)
        # GNU timeout is not installed on macOS; emulate it for a nonblocking fake.
        timeout = self.base / "mock/timeout"
        timeout.write_text('#!/bin/sh\nshift\nexec "$@"\n')
        timeout.chmod(0o755)
        if not __import__('shutil').which('flock'):
            flock = self.base / "mock/flock"
            flock.write_text('#!/bin/sh\nexit 0\n')
            flock.chmod(0o755)

    def execute(self, *args):
        return subprocess.run(["bash", str(self.script), *args],
                              env={**os.environ, "CD_FIXTURE": str(self.base)},
                              capture_output=True, text=True, timeout=30)

    def test_rollout_and_snapshot(self):
        result = self.execute(IMAGE, SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / "state/current-image").read_text().strip(), IMAGE)
        saved = Path((self.base / "state/last-backup").read_text().strip())
        self.assertTrue((saved / "snapshot-complete").exists())
        self.assertTrue((saved / "data-library.tgz").stat().st_size)

    def test_failed_public_check_restores_image_and_data(self):
        (self.base / "fail-public").touch()
        result = self.execute(IMAGE, SHA)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / "root/data/book").read_text(), "original")
        self.assertEqual((self.base / "state/current-image").read_text().strip(), "previous:fixture")
        preserved = list((self.base / "root").glob("before-rollback-*/data/book"))
        self.assertEqual(len(preserved), 1)
        self.assertEqual(preserved[0].read_text(), "new-data")
        calls = [json.loads(line) for line in (self.base / "calls").read_text().splitlines()]
        self.assertGreaterEqual(sum(c[0] == "compose" and "up" in c for c in calls), 2)

    def test_argument_injection_rejected_before_daemon(self):
        for bad in [IMAGE + ";id", "latest", "evil.io/reader@sha256:" + "a" * 64]:
            self.assertNotEqual(self.execute(bad, SHA).returncode, 0)
        self.assertFalse((self.base / "calls").exists())


if __name__ == "__main__":
    unittest.main()
