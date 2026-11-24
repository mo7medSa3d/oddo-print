#!/bin/sh
set -eu

# Restore a Yaseir Gateway PostgreSQL custom-format archive.
# The explicitly acknowledged target MUST be empty. Replacing production data,
# including via a legacy override flag, is intentionally not supported.

umask 077

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command '$1' is not installed" >&2
    exit 127
  }
}

require_cmd pg_restore
require_cmd psql
require_cmd sha256sum

[ "$#" -eq 1 ] || {
  echo "Usage: $0 /path/to/backup.dump" >&2
  exit 2
}
archive=$1
[ -r "$archive" ] || {
  echo "ERROR: backup archive is not readable" >&2
  exit 2
}

: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${RESTORE_CONFIRM:?Set RESTORE_CONFIRM to the exact PGDATABASE name}"
[ "$RESTORE_CONFIRM" = "$PGDATABASE" ] || {
  echo "ERROR: RESTORE_CONFIRM must exactly match PGDATABASE" >&2
  exit 2
}

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
export PGHOST PGPORT PGDATABASE PGUSER

cleanup_password() {
  if [ -n "${_YASEIR_PGPASSWORD_FROM_FILE:-}" ]; then
    unset PGPASSWORD
  fi
}
trap cleanup_password EXIT HUP INT TERM

if [ -n "${PGPASSWORD_FILE:-}" ]; then
  [ -r "$PGPASSWORD_FILE" ] || {
    echo "ERROR: PGPASSWORD_FILE is not readable" >&2
    exit 2
  }
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
  _YASEIR_PGPASSWORD_FROM_FILE=1
fi

checksum="$archive.sha256"
[ -r "$checksum" ] || {
  echo "ERROR: matching checksum file is required: $checksum" >&2
  exit 2
}
(
  cd "$(dirname "$archive")"
  # Bind the sidecar to the selected archive, never another listed filename.
  actual_checksum=$(sha256sum "$(basename "$archive")")
  expected_checksum=$(cat "$(basename "$checksum")")
  [ "$actual_checksum" = "$expected_checksum" ] || {
    echo "ERROR: selected backup archive checksum does not match its sidecar" >&2
    exit 2
  }
)

# Force a full archive parse before touching the target database.
pg_restore --list "$archive" >/dev/null

# Check all ordinary user relations, not only tables: a database with only a
# view or sequence is still populated. Refuse rather than ever attempting a
# destructive replacement. The query itself needs no write privileges.
user_relations=$(psql --no-password -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' AND c.relkind IN ('r','p','v','m','S','f');")
case "$user_relations" in
  ''|*[!0-9]*) echo "ERROR: could not determine whether target database is empty" >&2; exit 2 ;;
esac
if [ "$user_relations" -ne 0 ]; then
  echo "ERROR: target database is not empty; restore only to a new empty recovery database" >&2
  exit 2
fi

# --single-transaction implies exit-on-error; no existing objects are dropped.
pg_restore --no-password --single-transaction --dbname="$PGDATABASE" "$archive"

# Minimal post-restore structural proof. Application migrations/health checks
# must still run before traffic is re-enabled.
psql --no-password -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN to_regclass('public.tenants') IS NOT NULL AND to_regclass('public.users') IS NOT NULL AND to_regclass('public.api_keys') IS NOT NULL AND to_regclass('public.tenant_subscriptions') IS NOT NULL THEN 'ok' ELSE 'missing-core-table' END;" \
  | grep -qx 'ok' || {
    echo "ERROR: restore completed but core Gateway tables are missing" >&2
    exit 3
  }

printf 'Restore complete for database: %s\n' "$PGDATABASE"
