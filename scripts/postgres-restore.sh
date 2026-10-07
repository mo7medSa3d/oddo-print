#!/bin/sh
set -eu

# Restore a Yaseir Gateway PostgreSQL custom-format archive.
# The target database must be explicitly acknowledged. By default it must be
# empty; destructive replacement requires RESTORE_ALLOW_NONEMPTY=1.

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
  sha256sum -c "$(basename "$checksum")"
)

# Force a full archive parse before touching the target database.
pg_restore --list "$archive" >/dev/null

user_tables=$(psql --no-password -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');")
case "$user_tables" in
  ''|*[!0-9]*) echo "ERROR: could not determine target database table count" >&2; exit 2 ;;
esac

clean_args=""
if [ "$user_tables" -ne 0 ]; then
  [ "${RESTORE_ALLOW_NONEMPTY:-0}" = "1" ] || {
    echo "ERROR: target database is not empty; set RESTORE_ALLOW_NONEMPTY=1 only for an intentional destructive replacement" >&2
    exit 2
  }
  clean_args="--clean --if-exists"
fi

# --single-transaction implies exit-on-error: either the archive is applied in
# full or the restore transaction rolls back. shellcheck disable=SC2086
pg_restore --no-password --single-transaction $clean_args --dbname="$PGDATABASE" "$archive"

# Minimal post-restore structural proof. Application migrations/health checks
# must still run before traffic is re-enabled.
psql --no-password -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN to_regclass('public.tenants') IS NOT NULL AND to_regclass('public.print_jobs') IS NOT NULL AND to_regclass('public.agents') IS NOT NULL THEN 'ok' ELSE 'missing-core-table' END;" \
  | grep -qx 'ok' || {
    echo "ERROR: restore completed but core Gateway tables are missing" >&2
    exit 3
  }

printf 'Restore complete for database: %s\n' "$PGDATABASE"
