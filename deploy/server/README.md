# Server CD: isolated webhook receiver, locally authorized rollout

This is a deployment kit, **not an automatically installed host migration**.
GitHub gets no SSH credentials or sudo rights. A webhook can only send a constant
wakeup to an independent local reconciler. The reconciler asks GitHub for the
successful server-image workflow on the current main commit, verifies its
artifact digest, and deploys only that artifact's immutable image digest.

## Trust boundaries

* `bili-hook`: HTTP receiver; no sudo, Docker access, application data, GitHub
  token or access to the worker's configuration. Knows only the webhook secret.
* `bili-run`: local reconciler and **rootless** Docker owner; no sudo, no system
  Docker group, no rootful Docker socket. Owns only this application's state.
* Root owns code under `/opt/bili-reader-cd` and configuration under
  `/etc/bili-reader-cd`. Neither account can modify these. Deployment never checks
  out a repository or runs host scripts obtained from it.
* The application container gets only its data/library mounts and app credentials,
  not worker state, backups, webhook secret, registry token or Docker socket.
* Repository maintainers and the approved publishing workflow remain trusted to
  change application code. Protect main/workflow changes accordingly. HMAC proves
  webhook authenticity, **not image safety**. Rootless containers share the host
  kernel and are not a VM security boundary.

## Receiver on the existing rootful Docker engine

The receiver can run on the existing system Docker engine using
`../webhook/Dockerfile` and `../webhook/compose.yml`. This **does not** authorize the receiver
or worker to control that engine, and requires no unprivileged user namespaces.
The rootless prerequisites below concern the application deployment worker only.
Do not run both the container receiver and `bili-reader-hook.service`.

Administrator-managed receiver setup:

1. Create the dedicated `bili-hook` UID/GID and `bili-signal` group, with no login,
   sudo or Docker membership. Set `CD_HOOK_UID`, `CD_HOOK_GID`,
   `CD_SIGNAL_GID` to their numeric host IDs in an administrator-owned Compose
   env file. Provision the secret as root:bili-hook0640. Never commit secrets.
   Also set `CD_HOOK_CONFIG_DIR=/etc/bili-reader-hook`,
   `CD_HOOK_SIGNAL_DIR=/run/bili-reader-cd`, `CD_HOOK_NETWORK=bili_hook_net`,
   `CD_HOOK_DNS=cd-hook-reader` (unique across targets).
   Install `../webhook/reader.json` as policy.json (root:bili-hook0640) in the config
   directory. The socket path in this policy is the **container-side**
   `/run/cd-hook/wake.sock`, mapping to the worker's existing host socket.
2. Provision `/run/bili-reader-cd` as bili-run:bili-signal0710 using tmpfiles.
   The worker owns the directory and creates wake.sock as bili-run:bili-signal0620.
   Mount the directory read-only: Unix datagram send is allowed by socket
   permissions, but the receiver cannot create, remove or replace its entries.
   Start the worker first; without it valid notifications return503, not202.
3. Create a dedicated Docker bridge network `bili_hook_net`, attach only Caddy
   and this receiver, and proxy the exact `/hooks/bili-reader` path to
   `cd-hook-reader:18791`. Do not attach it to shared application networks or publish
   a host port. Binding0.0.0.0 is intentional **inside this container only**;
   host service mode still requires a private explicit address.
4. From the reviewed source checkout, run Docker Compose with
   `deploy/webhook/compose.yml` and the administrator-owned env file to
   build/start the receiver. For an installed copy outside the checkout, build
   the image from the reviewed source first and use `up --no-build` (the relative
   build context is for the source tree, not `/etc`). Recreate/restart the
   receiver after replacing its bind-mounted secret or recreating the runtime
   directory. Keep default seccomp enabled; do not disable SELinux or add
   privileged/socket mounts to bypass denials. Validate host policy explicitly.
5. Verify the effective UID, read-only mounts, resource limits, capabilities,
   no-new-privileges and absence of Docker socket. Test valid/invalid signatures,
   the fixed wake datagram, and public proxy routing before installing the GitHub
   webhook. Container202 is notification acceptance, not deployment success.

This isolates the receiver, not the whole deployment system. Containers still
share the host kernel. The existing CentOS7 host is not thereby made supported or
fully secure. **The deployment worker remains rootless-only and disabled until
its separate runtime migration gate is satisfied.** No system Docker authority
is granted by this receiver configuration.

## Reusing the receiver for other CD targets

The receiver is shared code, **not a shared deployment credential**. Its source
lives in `deploy/webhook/receiver.py`; the `--config` interface and Compose template are application-independent.
Run a separate Compose project/UID/secret/signal group/config directory/proxy
network per target (for example `-p cd-hook-reader` and `-p cd-hook-rsshub`).
Caddy routes each exact path to that target's unique upstream alias, such as
`cd-hook-reader:18791` or `cd-hook-rsshub:18791`, never the ambiguous common service name.
Never attach a receiver to another target's signal directory or proxy network.

Each root-owned local JSON policy fixes repository name **and numeric ID**,
workflow path, branch, public `/hooks/<target>` route and local socket path.
Each instance reads only its own policy/secret and has its own request cache.
Remote payloads cannot choose targets, images, shell commands or mount paths.
Keep identities distinct from the accounts that own application data.

An RSSHub receiver can reuse the same image with a different policy, but its
repository/workflow must first be verified; no guessed RSSHub workflow or live
RSSHub deployment is supplied here. Its independent worker must verify release
provenance and immutable digest, enforce a fixed local runtime configuration,
serialize updates, and provide application-appropriate health checks/rollback.
The reader worker/deploy script are intentionally **not** a generic privileged
Docker API. The shared receiver does not solve the separate executor permission
decision or enable CD automatically for any target.

## Supported installation prerequisites

Use a maintained Linux OS with working user namespaces, a tested rootless Docker
installation for `bili-run`, Python >=3.9, `/usr/bin/gh`, Bash, GNU timeout/flock,
and Compose v2. Use cgroup v2 if resource limits are required. Do not enable this
on an unverified host, ignore hardening failures, or fall back to system Docker.
Initial administration may require root; **routine deployment does not**.

The existing VPS was inspected on 2026-10-17: CentOS7, kernel3.10, systemd219,
`user.max_user_namespaces=0`, `unshare --user` fails, no Python3 or gh. Thus this
kit is not yet production-enabled there. Kernel/sysctl changes, dependency
installation and rootless compatibility validation are separate migration gates.
Several service hardening options also require newer systemd; ignoring unknown
directives is not successful isolation validation.

## Administrator setup (after prerequisites pass)

1. Create `bili-run`, `bili-hook` and group `bili-signal`; no password/SSH login,
   sudo rules or Docker group membership. Keep the run user's home separate from
   application data. Provision subordinate UID/GID ranges and rootless Docker per
   its official instructions; enable the user daemon with lingering. The provided
   services are clients of that daemon, not a system-wide rootless dockerd unit.
2. Install `worker.py`, `.sh`, and `check.mjs` from this reviewed kit, plus
   `../webhook/receiver.py` as `webhook.py`, at
   `/opt/bili-reader-cd` root:root; directories0755, code0644, deploy script0755.
   Provision `/srv/bili-reader/{data,library}` and `/srv/bili-reader-cd` as
   bili-run:bili-run0700, plus its backups directory. Install tmpfiles.conf and
   create its runtime directory before starting the worker.
3. Create `/etc/bili-reader-cd` root:bili-run0750. Install compose.yml0640,
   app.env0640 with the existing application password, runtime.env0640 with
   `BILI_BIND_IP=<host-side Caddy bridge gateway>`, and github.env0640 containing
   `GH_TOKEN=<fine-grained token>` scoped **only** to this repo: Actions read and
   Contents read. No repository write/admin token is needed by the worker.
   Private GHCR pulls separately require a registry-supported read:packages
   credential; public package visibility avoids that extra secret. Never print
   either credential in logs or put credentials in Git.
4. Create `/etc/bili-reader-hook` root:bili-hook0750 with secret0640 (at least
   32 random bytes; generated locally, never committed) and bind-address0640
   containing the host-side Caddy bridge gateway IP. Configure the repository's
   webhook using the same secret, JSON, only workflow_run events, HTTPS URL
   `https://bili.dolast.com/hooks/bili-reader`. This requires repository admin
   access, **not an Actions secret**. Receiver verifies HMAC-SHA256, workflow,
   repository ID, branch, success, source repository and event freshness.
5. Configure Caddy's exact `/hooks/bili-reader` route to
   `<host-side bridge gateway>:18791`; app upstream becomes the same gateway at
   port18790 after migration. Preserve all other routes. Do not bind to0.0.0.0,
   expose Docker API, disable TLS checks or modify unrelated services. A Caddy
   container cannot access host127.0.0.1 directly. Restrict bridge ingress with
   host firewall rules where necessary and verify externally that neither high
   port is reachable. Payload size/rate limits at the proxy add DoS protection.
6. Migrate data only after testing rootless SQLite, ffmpeg, all mounts, the
   read-only rootfs/cap-drop settings, network connectivity and the proxy bridge.
   Stop the original app for a consistent data copy; retain its original data,
   Compose and image for rollback. Load its image into rootless Docker or seed a
   reviewed prebuilt version; initialize `/srv/bili-reader-cd/current-image` with
   that actual baseline reference. Start the baseline rootless app using this
   fixed Compose file and env file, verify authenticated local/public checks, then
   switch Caddy. Do not run both apps against the same writable database.
7. Install the service files, validate every hardening directive with systemd,
   then enable worker and receiver. Worker uses only
   `/run/user/<bili-run UID>/docker.sock` and explicitly rejects a rootful daemon.
   Verify UIDs, supplementary groups, directory permissions, and that the receiver
   cannot open that socket or write any worker/configuration file.

## Trigger and release behavior

`server-image.yml` runs tests/lint and app builds inside the Debian image build,
publishes linux/amd64 to GHCR on main, then uploads a deployment.json artifact.
Third-party Actions are pinned to reviewed commits. PR builds publish nothing;
untrusted PRs are not deployment events. The GHCR package must be pullable by
the rootless daemon before enabling CD. No VPS credential is stored in Actions.

The webhook wakes the worker and returns202, which means **accepted**, not
deployed. The worker ignores socket payloads, serializes updates and throttles
wakeups. It independently resolves current main and checks the fixed publishing
workflow's successful run. Only the unique artifact for that run/attempt is read,
with GitHub's artifact SHA256 verified before reading a single bounded JSON file.
Registry tags/URLs from notifications are never trusted. A final head check avoids
deploying a build already superseded before rollout. A deployment receipt skips
duplicates and refuses older run IDs. No public rollback endpoint exists.

The worker reconciles on startup and every15minutes to recover missed pushes,
expired notifications or restarted receivers. Failed checks retry after5minutes.
Logs expose status, not request bodies, headers, secrets or gh stderr. Monitor
`journalctl -u bili-reader-cd -u bili-reader-hook` and the deployed receipt; a
successful image workflow does not by itself mean a successful VPS deployment.

## Rollout, recovery and retention

The deploy script checks rootless mode, free disk and image revision; tests the
image using isolated tmpfs data with no network and the same reduced privileges;
stops only this app for a consistent snapshot; then starts the candidate and
checks authenticated APIs, assets, login and ffmpeg locally and via public TLS.
On rollout failure it restores the previous image and data, preserving candidate
data under `before-rollback-*`. Snapshot creation failure restarts the old app.

After success, only this application's timestamp-named old complete snapshots
are removed, keeping the latest full snapshot. Only recorded historical image
references are eligible for removal, excluding current and previous. Docker's
non-force removal protects container references; no global prune is used. Failed
preflight directories/images are not automatically deleted by this initial kit;
inspect disk alerts and review those separately. Preserved rollback data is never
auto-deleted. This does not reuse rootful Docker's build cache: builds run in CI.

For deliberate rollback, stop automatic reconciliation first. Preserve current
data, restore the latest snapshot, start its previous-image using the fixed local
configuration, and verify authenticated public access before re-enabling CD.
Restoring a snapshot deactivates subsequent changes; keep the preserved data.
Never use a public webhook request to select an old image or arbitrary command.

## Verification

`python3 -m unittest discover -s deploy/server/tests -v`

Tests cover signature/event restrictions, artifact tampering, wrong run/attempt,
repository/image injection, stale runs, duplicates, main advancing, failed rollout
receipts, actual snapshot/restore filesystem behavior against a fake daemon,
and command-argument rejection. These are **not** proof of production rootless
compatibility or a live production rollback. Run the prerequisite and permission
checks plus actual isolated image/public authentication checks before enabling.

References: [webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[rootless Docker](https://docs.docker.com/engine/security/rootless/),
[rootless limitations](https://docs.docker.com/engine/security/rootless/tips/).
