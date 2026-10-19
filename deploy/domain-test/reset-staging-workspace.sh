#!/usr/bin/env bash
# Switch the active HTTPS staging database to a clean, uniquely named volume.
# The original Docker volume and an independently verified dump are retained.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/deploy/domain-test/.env.domain-test"
COMPOSE="$ROOT/deploy/domain-test/docker-compose.yml"
MODE="--dry-run"
if [[ $# -gt 0 ]]; then MODE="$1"; fi
if [[ "$MODE" != "--dry-run" && "$MODE" != "--apply" ]]; then
  echo "Usage: bash deploy/domain-test/reset-staging-workspace.sh [--dry-run|--apply]" >&2
  exit 2
fi
for bin in docker sha256sum mktemp openssl; do
  command -v "$bin" >/dev/null || { echo "Missing $bin" >&2; exit 2; }
done
docker compose version >/dev/null
[[ -f "$ENV_FILE" ]] || { echo "ERROR: Staging environment file not found" >&2; exit 2; }

env_value() {
  grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true
}
OLD_VOLUME="$(env_value HTTP_TEST_VOLUME_NAME)"
DB_NAME="$(env_value POSTGRES_DB)"
DB_USER="$(env_value POSTGRES_USER)"
DOMAIN="$(env_value GATEWAY_DOMAIN)"
BASE_URL="$(env_value APP_BASE_URL)"
STAGING_MODE="$(env_value YASEIR_HTTP_TEST_MODE)"
if [[ "$DB_NAME" != "yasser_http_test" || "$DOMAIN" != "print.yaseir.cloud" ||
      "$BASE_URL" != "https://print.yaseir.cloud" || "$STAGING_MODE" != "1" ]]; then
  echo "ERROR: Refusing to reset any database other than isolated HTTPS staging" >&2
  exit 2
fi
[[ -n "$OLD_VOLUME" && -n "$DB_USER" ]] || { echo "ERROR: Missing staging DB volume/user" >&2; exit 2; }
docker volume inspect "$OLD_VOLUME" >/dev/null

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" "$@"
}
CONNECTED_DB="$(compose exec -T postgres sh -c 'exec psql -X -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT current_database()"' | tr -d '\r\n')"
if [[ "$CONNECTED_DB" != "yasser_http_test" ]]; then
  echo "ERROR: Connected to unexpected PostgreSQL database" >&2
  exit 2
fi
echo "Old isolated staging volume: $OLD_VOLUME"
compose exec -T postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS tenants FROM tenants; SELECT count(*) AS subscriptions FROM tenant_subscriptions;"'
echo "WARNING: Fresh staging loses access to current Agents, printers, API keys, and jobs."
echo "Existing data remains in the old Docker volume and a secure full backup."
if [[ "$MODE" == "--dry-run" ]]; then
  echo "DRY RUN ONLY: to proceed, execute with --apply and confirm interactively."
  exit 0
fi
[[ -t 0 ]] || { echo "ERROR: Interactive confirmation is mandatory" >&2; exit 2; }
read -r -p "Type RESET HTTPS STAGING exactly: " CONFIRMATION
[[ "$CONFIRMATION" == "RESET HTTPS STAGING" ]] || { echo "Cancelled" >&2; exit 2; }

BACKUP_DIR="$HOME/.local/share/yaseir-staging-backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
ARCHIVE="$(mktemp "$BACKUP_DIR/.before-reset-$STAMP.XXXXXX.dump")"
ENV_BACKUP="$(mktemp "$BACKUP_DIR/.before-reset-env-$STAMP.XXXXXX")"
NEW_ENV_FILE="$(mktemp "$ROOT/deploy/domain-test/.reset-env.XXXXXX")"
trap 'rm -f "$NEW_ENV_FILE"' EXIT
cp "$ENV_FILE" "$ENV_BACKUP"
chmod 600 "$ENV_BACKUP"
echo "Backing up staging database (no volumes have been deleted)..."
compose exec -T postgres sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$ARCHIVE"
[[ -s "$ARCHIVE" ]] || { echo "ERROR: Empty database backup" >&2; exit 1; }
compose exec -T postgres sh -c 'exec pg_restore --list' < "$ARCHIVE" >/dev/null
(cd "$BACKUP_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
echo "Verified database archive: $ARCHIVE"
echo "Protected env backup: $ENV_BACKUP"

NEW_VOLUME="yaseir_staging_clean_$(date -u '+%Y%m%d%H%M%S')_$(openssl rand -hex 3)"
if docker volume inspect "$NEW_VOLUME" >/dev/null 2>&1; then
  echo "ERROR: New volume already exists" >&2
  exit 1
fi
docker volume create --label "yaseir.environment=domain-staging" "$NEW_VOLUME" >/dev/null
cp "$ENV_FILE" "$NEW_ENV_FILE"
chmod 600 "$NEW_ENV_FILE"
replace_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$NEW_ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$value|" "$NEW_ENV_FILE"
  else
    printf "%s=%s\n" "$key" "$value" >> "$NEW_ENV_FILE"
  fi
}
replace_env HTTP_TEST_VOLUME_NAME "$NEW_VOLUME"
replace_env MANAGER_TENANT_ID ""
replace_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
replace_env GATEWAY_JWT_SECRET "$(openssl rand -hex 32)"
replace_env TRUST_PROXY_SECRET "$(openssl rand -hex 32)"
replace_env YASEIR_STAGING_SINGLE_WORKSPACE 1

echo "Stopping the old staging stack WITHOUT deleting its volume..."
compose down --remove-orphans
mv "$NEW_ENV_FILE" "$ENV_FILE"
echo "Starting HTTPS staging with the NEW empty volume..."
if ! bash deploy/domain-test/setup-domain-test.sh; then
  echo "ERROR: New stack setup failed; old volume and backups are still available." >&2
  echo "Restore the saved environment file to switch back, then rerun setup-domain-test.sh." >&2
  echo "Environment backup location: $ENV_BACKUP" >&2
  exit 1
fi
NEW_COUNT="$(compose exec -T postgres sh -c 'exec psql -X -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM tenant_subscriptions"' | tr -d '\r\n')"
[[ "$NEW_COUNT" == "0" ]] || { echo "ERROR: Unexpected new subscriptions: $NEW_COUNT" >&2; exit 1; }
echo "READY: 0 subscriptions in active staging. Old database has been archived, not erased."
echo "Old volume: $OLD_VOLUME"
echo "New volume: $NEW_VOLUME"
echo "Create the ONE new account at https://print.yaseir.cloud/signup"
echo "Verify email, set password, and select the 30-day HTTP Test trial."
echo "Then rerun setup-domain-test.sh to bind the domain to that workspace."
