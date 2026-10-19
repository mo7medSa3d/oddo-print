#!/bin/sh
set -eu

# PostgreSQL logical backup for Yaseir Gateway.
# Connection settings use libpq PG* variables so credentials never appear in
# command-line arguments. PGPASSWORD_FILE is supported for Docker/secret mounts.

umask 077

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command '$1' is not installed" >&2
    exit 127
  }
}

require_cmd pg_dump
require_cmd pg_restore
require_cmd sha256sum
require_cmd mktemp

: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required and must point to durable backup storage}"

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

mkdir -p "$BACKUP_DIR"
[ -d "$BACKUP_DIR" ] || {
  echo "ERROR: BACKUP_DIR is not a directory" >&2
  exit 2
}

stamp=$(date -u '+%Y%m%dT%H%M%SZ')
safe_db=$(printf '%s' "$PGDATABASE" | tr -c 'A-Za-z0-9._-' '_')
# Reserve a unique 0600 path up front so concurrent/same-second backups cannot
# overwrite each other. The random token remains in the published filename.
tmp_archive=$(mktemp "$BACKUP_DIR/.${safe_db}-${stamp}.XXXXXX.dump.partial")
tmp_name=$(basename "$tmp_archive")
archive="$BACKUP_DIR/${tmp_name#.}"
archive=${archive%.partial}
tmp_checksum="$archive.sha256.tmp.$$"

cleanup_files() {
  rm -f "$tmp_archive" "$tmp_checksum"
  cleanup_password
}
trap cleanup_files EXIT HUP INT TERM

# Custom format is portable and can be inspected/verified with pg_restore.
pg_dump --no-password --format=custom --file="$tmp_archive"

# A successful pg_dump is not enough: force pg_restore to parse the archive
# table of contents before publishing it as a completed backup artifact.
pg_restore --list "$tmp_archive" >/dev/null

mv "$tmp_archive" "$archive"
(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$archive")" >"$(basename "$tmp_checksum")"
)
mv "$tmp_checksum" "$archive.sha256"

# Never print credentials or a connection string.
printf 'Backup complete: %s\nChecksum: %s\n' "$archive" "$archive.sha256"
