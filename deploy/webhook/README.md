# Shared CD webhook receiver

A reusable **notification-only** GitHub `workflow_run` receiver. It runs under
the existing rootful Docker engine, but its application UID is non-root and it
has no Docker access. No unprivileged user namespace enablement is required.

One reviewed image serves multiple applications as **separate instances**:

| Instance | Local configuration | Allowed effect |
| --- | --- | --- |
| Reader | `reader.json`, own HMAC secret | Send `check` to reader worker |
| Future RSSHub | Separately verified policy and secret | Send `check` to RSSHub worker |

Do not infer that RSSHub is configured or deployed: only the reader policy is
provided. Each worker needs its own release verification and rollout adapter.

## Instance configuration

Use one Compose project (`-p cd-hook-reader`, etc.), dedicated non-login host
UID/GID, signal group and Docker proxy network for each target. Caddy is the
only shared application container and joins each dedicated proxy network.
No receiver publishes a host port or shares another target's mounts/network.

An administrator-owned env file supplies these **non-secret** values:

```dotenv
CD_HOOK_UID=1001
CD_HOOK_GID=1001
CD_SIGNAL_GID=1002
CD_HOOK_CONFIG_DIR=/etc/bili-reader-hook
CD_HOOK_SIGNAL_DIR=/run/bili-reader-cd
CD_HOOK_NETWORK=bili_hook_net
CD_HOOK_DNS=cd-hook-reader
```

UID/GID numbers above are examples: use the actual dedicated account/group IDs.
The config directory holds `policy.json` and `secret`, both read-only to the
receiver. A policy fixes repository name and numeric ID, publishing workflow,
branch, exact public route and **container-side** local signal socket. For the
provided Compose mapping the socket is `/run/cd-hook/wake.sock`. Only local
administrator configuration can change any of these; requests cannot select a
target, image, command or mount. The independent worker owns the host socket
directory (0710 with signal group) and socket (0620 with signal group).

Build from the reviewed repository root, then validate Compose and start:

```sh
docker build -f deploy/webhook/Dockerfile -t cd-hook:reviewed .
docker compose --env-file /etc/bili-reader-hook/compose.env \
  -p cd-hook-reader -f deploy/webhook/compose.yml config --quiet
docker compose --env-file /etc/bili-reader-hook/compose.env \
  -p cd-hook-reader -f deploy/webhook/compose.yml up -d --no-build
```

Provision mounts and the dedicated network first; otherwise Docker may create
missing host paths with incorrect types/ownership. Configure Caddy to forward
only the policy's exact route to the unique alias (`cd-hook-reader:18791` here)
on that instance's dedicated network. Never use the common `cd-hook` service
alias from Caddy: it joins multiple networks and that alias would be ambiguous.
Preserve other Caddy routes. Rootless worker migration is **not** a
prerequisite to building/testing this receiver, but a running authorized worker
is required before notifications can cause real deployment.

Full reader installation/security boundaries: [reader kit](../server/README.md).
Do not start the legacy host receiver and container receiver simultaneously.

## Verification

```sh
docker run --rm -i --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 64m --pids-limit 16 \
  --tmpfs /tmp:rw,noexec,nosuid,size=4m,mode=1777 \
  --entrypoint python3 cd-hook:reviewed - < deploy/webhook/smoke.py
```

The smoke test checks two synthetic policies, signatures, wrong route/repository,
constant wake datagrams, replay suppression and effective process restrictions.
It does **not** verify Caddy, GitHub webhook delivery, host signal-mount permissions,
SELinux cross-process IPC or a live deployment. Verify those separately before
claiming production CD. Keep default seccomp and SELinux protections enabled.

Only a local fixed executor may manage deployment. Rootful Docker control is
host-administrator authority; this receiver is never granted that authority.
