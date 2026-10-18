#!/usr/bin/env bash
# Administrator-installed, not updated from Git. Never invoke via sudo.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
ROOT=/srv/bili-reader
STATE=/srv/bili-reader-cd
CONFIG=/etc/bili-reader-cd
BIN=/opt/bili-reader-cd
[[ $EUID -ne 0 ]] || { echo 'Refusing root execution.' >&2; exit 1; }
[[ $# == 2 && $1 =~ ^ghcr\.io/gregwym/bilinovel-reader@sha256:[a-f0-9]{64}$ && $2 =~ ^[a-f0-9]{40}$ ]] || {
  echo 'Expected approved immutable image and commit.' >&2; exit 2;
}
image=$1 revision=$2
# Do not allow Docker context/config to select the system daemon or a remote API.
export DOCKER_HOST="unix:///run/user/$EUID/docker.sock"
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_FILE COMPOSE_PROJECT_NAME
docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless' || {
  echo 'Rootless Docker required; no rootful fallback.' >&2; exit 1;
}
for path in "$ROOT" "$ROOT/data" "$ROOT/library" "$STATE" "$CONFIG" "$BIN"; do
  [[ -d $path && ! -L $path ]] || { echo 'Missing/unsafe installation directory.' >&2; exit 1; }
done
exec 9>"$STATE/deploy.lock"
flock -n 9 || { echo 'Deployment already running.' >&2; exit 1; }
[[ -s $STATE/current-image ]] || { echo 'Initial migration/baseline required.' >&2; exit 1; }
previous=$(cat "$STATE/current-image")
[[ $previous =~ ^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$ ]] || exit 1
compose() {
  BILI_IMAGE=$1 docker compose --env-file "$CONFIG/runtime.env" -p bili-reader -f "$CONFIG/compose.yml" "${@:2}"
}
check() { timeout 60 docker exec -i "$1" node --input-type=module - "${2:-http://127.0.0.1:8790}" < "$BIN/check.mjs"; }
ready() {
  local i
  for ((i=0; i<30; i++)); do
    if check "$1" > "$STATE/check.log" 2>&1; then return 0; fi
    sleep 2
  done
  echo 'Health check failed (see restricted check.log).' >&2
  return 1
}
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
saved="$STATE/backups/$stamp"
mkdir -p "$saved"
phase=preflight
smoke=bili-reader-cd-check
cleanup() { docker stop "$smoke" >/dev/null 2>&1 || true; }
trap cleanup EXIT
recover() {
  local code=$? preserved
  trap - ERR HUP INT TERM
  if [[ $phase == snapshot ]]; then
    compose "$previous" up -d --no-deps bili-reader || true
  elif [[ $phase == deploy || $phase == verify ]]; then
    echo 'Restoring pre-deployment snapshot.' >&2
    compose "$image" stop bili-reader || true
    preserved="$ROOT/before-rollback-$stamp"
    mkdir "$preserved"
    mv "$ROOT/data" "$ROOT/library" "$preserved/"
    tar -xzf "$saved/data-library.tgz" -C "$ROOT"
    compose "$previous" up -d --no-deps bili-reader
    ready bili-reader
    check bili-reader https://bili.dolast.com
  fi
  echo "Deployment failed: phase=$phase backup=$saved" >&2
  exit "${code:-1}"
}
trap recover ERR
trap 'false' HUP INT TERM
size=$(du -sk "$ROOT/data" "$ROOT/library" | awk '{n+=$1} END {print n}')
free=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
(( free > size * 2 + 1048576 )) || { echo 'Insufficient snapshot/image headroom.' >&2; exit 1; }
docker pull "$image"
actual=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ $actual == "$revision" ]] || { echo 'Image revision mismatch.' >&2; exit 1; }
docker run -d --rm --name "$smoke" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 \
  --tmpfs /data --tmpfs /library --tmpfs /tmp \
  -e APP_PASSWORD=isolated-deployment-check "$image" >/dev/null
ready "$smoke"
docker stop "$smoke" >/dev/null
printf '%s\n' "$previous" > "$saved/previous-image"
cp "$CONFIG/app.env" "$saved/app.env"
cp "$CONFIG/compose.yml" "$saved/compose.yml"
phase=snapshot
compose "$previous" stop bili-reader
tar -czf "$saved/data-library.tgz" -C "$ROOT" data library
tar -tzf "$saved/data-library.tgz" >/dev/null
touch "$saved/snapshot-complete"
phase=deploy
compose "$image" up -d --no-deps bili-reader
phase=verify
ready bili-reader
check bili-reader https://bili.dolast.com
printf '%s\n' "$image" > "$STATE/.current-image.next"
mv "$STATE/.current-image.next" "$STATE/current-image"
printf '%s\n' "$saved" > "$STATE/.last-backup.next"
mv "$STATE/.last-backup.next" "$STATE/last-backup"
phase=done
trap - ERR HUP INT TERM
# Only this service's known, direct, timestamp-named snapshot directories.
# Rollback-preserved live data under ROOT is never touched.
for old in "$STATE"/backups/*; do
  [[ -d $old && ! -L $old && $old != "$saved" && ${old##*/} =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || continue
  if [[ -f $old/snapshot-complete ]]; then
    python3 - "$old" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
  fi
done
# Only known candidate references, never a global image/container/volume prune.
touch "$STATE/image-history"
while IFS= read -r old; do
  [[ $old =~ ^ghcr\.io/gregwym/bilinovel-reader@sha256:[a-f0-9]{64}$ ]] || continue
  [[ $old == "$image" || $old == "$previous" ]] && continue
  docker image rm "$old" >/dev/null 2>&1 || true
done < "$STATE/image-history"
printf '%s\n%s\n' "$previous" "$image" > "$STATE/image-history"
echo "Deployed revision=$revision; rollback snapshot=$saved"
