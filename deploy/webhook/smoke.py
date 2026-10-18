"""Run inside the hardened receiver image, with /tmp tmpfs and no network."""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

assert os.getuid() != 0
status = Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in status
assert 'CapEff:\t0000000000000000' in status
try:
    Path('/app/should-not-write').write_text('forbidden')
except OSError:
    pass
else:
    raise AssertionError('application filesystem writable')
assert not Path('/var/run/docker.sock').exists()

with tempfile.TemporaryDirectory() as d:
    base = Path(d)
    for target in ('reader', 'second-target'):
        # Synthetic independent repositories exercise configuration, not real releases.
        policy = dict(repository=f'test/{target}', repository_id=123 if target == 'reader' else 456,
                      workflow='.github/workflows/publish.yml', branch='main',
                      route=f'/hooks/{target}', signal_socket=str(base / 'wake.sock'))
        secret = os.urandom(32).hex().encode()
        (base / 'secret').write_bytes(secret)
        (base / 'policy.json').write_text(json.dumps(policy))
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sink:
            sink.bind(policy['signal_socket'])
            sink.settimeout(0.2)
            process = subprocess.Popen([sys.executable, '/app/webhook.py', '--container',
                                        '--config', str(base / 'policy.json'),
                                        '--secret-file', str(base / 'secret')])
            def request(body, signature, path=None):
                conn = http.client.HTTPConnection('127.0.0.1', 18791, timeout=2)
                conn.request('POST', path or policy['route'], body,
                             {'X-GitHub-Event': 'workflow_run', 'X-Hub-Signature-256': signature})
                response = conn.getresponse()
                result = response.status
                response.read()
                conn.close()
                return result
            def sign(body):
                return 'sha256=' + hmac.new(secret, body, hashlib.sha256).hexdigest()
            try:
                for _ in range(50):
                    if process.poll() is not None:
                        raise AssertionError('receiver exited')
                    try:
                        with socket.create_connection(('127.0.0.1', 18791), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise AssertionError('receiver not ready')
                payload = dict(action='completed', repository=dict(id=policy['repository_id'],
                               full_name=policy['repository']), workflow_run=dict(
                               status='completed', conclusion='success', head_branch='main',
                               event='push', path=policy['workflow'],
                               head_repository=dict(id=policy['repository_id']),
                               updated_at=datetime.now(timezone.utc).isoformat()))
                body = json.dumps(payload).encode()
                assert request(body, 'sha256=' + '0' * 64) == 403
                assert request(body, sign(body), '/hooks/other-target') == 404
                payload['repository']['id'] += 1
                wrong = json.dumps(payload).encode()
                assert request(wrong, sign(wrong)) == 403
                try:
                    sink.recv(1024)
                except socket.timeout:
                    pass
                else:
                    raise AssertionError('unapproved request woke target')
                assert request(body, sign(body)) == 202
                assert sink.recv(1024) == b'check'
                assert request(body, sign(body)) == 202
                try:
                    sink.recv(1024)
                except socket.timeout:
                    pass
                else:
                    raise AssertionError('duplicate event woke target')
            finally:
                process.terminate()
                process.wait(timeout=5)
        Path(policy['signal_socket']).unlink()
print('PASS: non-root/read-only/no capabilities/no-new-privileges; two independent target policies; signature, route, repository, fixed wake and replay checks')
