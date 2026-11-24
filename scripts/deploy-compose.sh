#!/usr/bin/env bash
# Build and release the actual repository Compose topology without deleting data.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-compose.sh [--resume] [--repair-caddy-storage] [-- COMPOSE_OPTIONS...]

Require YASEIR_DEPLOYMENT_ID set to the reviewed source/release identity.
Back up PostgreSQL and review forward-migration rollback boundaries first.
Default: build services sequentially, then stop public ingress and drain the
old Gateway before the ordered database gates; finally start Gateway/Caddy.
Build failures leave existing running services untouched. Migration failures
leave ingress offline rather than restart incompatible old admissions.
--resume: start Gateway/Caddy without builds or replaying successful migrations.
Requires healthy PostgreSQL and successful database gate containers labeled
with the same YASEIR_DEPLOYMENT_ID. Use identical Compose options and images.
No databases, certificates, containers or volumes are deleted.
--repair-caddy-storage: explicitly repair legacy TLS volume ownership/modes in
a disposable root maintenance job. Back up TLS storage first. Runtime Caddy
remains UID 10001 with no capabilities. Existing certificates are retained.
Example: scripts/deploy-compose.sh --resume -- --env-file reviewed.env
EOF
}

resume=false
repair_caddy_storage=false
while (($#)); do
  case "$1" in
    --resume) resume=true; shift ;;
    --repair-caddy-storage) repair_caddy_storage=true; shift ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    *) usage >&2; exit 2 ;;
  esac
done
compose_options=("$@")
: "${YASEIR_DEPLOYMENT_ID:?Set YASEIR_DEPLOYMENT_ID to the reviewed immutable release identity}"
command -v docker >/dev/null || { echo 'ERROR: Docker is required' >&2; exit 127; }
# Do not let optional Bake delegation override explicitly serial service builds.
export COMPOSE_PARALLEL_LIMIT=1 COMPOSE_BAKE=false
compose() { docker compose "${compose_options[@]}" "$@"; }
compose config --quiet

if "$resume"; then
  for service in database_roles migrate database_verify; do
    container="$(compose ps --all --quiet "$service")"
    if [[ -z "$container" || "$container" == *$'\n'* ]]; then
      echo "ERROR: --resume requires one completed $service container" >&2
      exit 1
    fi
    state="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container")"
    if [[ "$state" != 'exited 0' ]]; then
      echo "ERROR: --resume requires a successful $service gate" >&2
      exit 1
    fi
    release="$(docker inspect --format '{{index .Config.Labels "com.yaseir.release"}}' "$container")"
    if [[ "$release" != "$YASEIR_DEPLOYMENT_ID" ]]; then
      echo "ERROR: --resume refuses a $service gate from a different release" >&2
      exit 1
    fi
  done
  container="$(compose ps --all --quiet postgres)"
  if [[ -z "$container" || "$container" == *$'\n'* ]]; then
    echo 'ERROR: --resume requires one healthy PostgreSQL container' >&2
    exit 1
  fi
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  [[ "$health" == healthy ]] || { echo 'ERROR: PostgreSQL is not healthy' >&2; exit 1; }
else
  # Build everything before any runtime cutover; one service per invocation.
  for service in postgres database_roles migrate database_verify gateway caddy; do
    printf 'Building %s\n' "$service"
    compose build "$service"
  done
  compose up -d --no-build --wait --wait-timeout 120 postgres
  # Migration 0102 changes quota attribution. Any pre-cutover admission writer
  # still running while gates execute can consume the wrong period. Stop new
  # ingress first, then permit up to 60 seconds for the old Gateway to drain
  # in-flight HTTP/WebSocket work before touching the database schema.
  # Never silently roll back to old binaries after a successful migration.
  printf 'Draining old ingress and Gateway before database migration\n'
  compose stop -t 60 caddy gateway
  for service in database_roles migrate database_verify; do
    printf 'Running release gate: %s\n' "$service"
    compose up --no-build --no-deps --exit-code-from "$service" "$service"
  done
fi

if "$repair_caddy_storage"; then
  # Legacy volumes can contain root-owned certificates. CHOWN alone cannot
  # chmod those files after changing owner; FOWNER and DAC_OVERRIDE are needed
  # only by this disposable job. Never follow certificate symlinks or expose
  # private material in logs. The default find traversal does not follow links.
  compose run --rm --no-deps --user 0:0 --cap-drop ALL \
    --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --entrypoint sh caddy -eu -c \
    'chown -hR 10001:10001 /data /config && find /data /config -type d -exec chmod 0700 {} + && find /data /config -type f -exec chmod 0600 {} +'
fi

# The ordered gates were verified explicitly; dependency startup must not
# replay a completed forward-only migration during application recovery.
compose up -d --no-build --no-deps --wait --wait-timeout 180 gateway caddy
