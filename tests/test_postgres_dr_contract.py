import hashlib
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_backup_uses_custom_archive_and_verifies_before_publish():
    src = (ROOT / "scripts/postgres-backup.sh").read_text()
    assert "--format=custom" in src
    assert 'pg_restore --list "$tmp_archive"' in src
    assert 'sha256sum "$(basename "$archive")"' in src
    assert 'mktemp "$BACKUP_DIR/.${safe_db}-${stamp}.XXXXXX.dump.partial"' in src
    assert "PGPASSWORD_FILE" in src
    assert "DATABASE_URL" not in src


def test_restore_is_checksum_verified_explicit_and_transactional():
    src = (ROOT / "scripts/postgres-restore.sh").read_text()
    assert 'RESTORE_CONFIRM' in src
    assert 'actual_checksum=$(sha256sum "$(basename "$archive")")' in src
    assert '[ "$actual_checksum" = "$expected_checksum" ]' in src
    assert 'pg_restore --list "$archive"' in src
    assert "--single-transaction" in src
    assert "RESTORE_ALLOW_NONEMPTY" not in src
    assert "--clean" not in src
    assert "pg_catalog.pg_class" in src  # no tables, but views/sequences still mean nonempty
    assert "to_regclass('public.tenants')" in src
    assert "DATABASE_URL" not in src


def test_deployment_runbook_exposes_backup_and_restore_gate():
    doc = (ROOT / "DEPLOYMENT.md").read_text()
    assert "## Backup and Disaster Recovery" in doc
    assert "scripts/postgres-backup.sh" in doc
    assert "scripts/postgres-restore.sh" in doc
    assert "RESTORE_CONFIRM" in doc
    assert "RPO" in doc and "RTO" in doc
    assert "OnCalendar=*-*-* 02:00:00 UTC" in doc


def test_restore_rejects_a_valid_sidecar_for_a_different_file_before_database_access(tmp_path):
    archive = tmp_path / "selected.dump"
    archive.write_bytes(b"selected unverified archive")
    other = tmp_path / "other.dump"
    other.write_bytes(b"valid other archive")
    (tmp_path / "selected.dump.sha256").write_text(
        hashlib.sha256(other.read_bytes()).hexdigest() + "  other.dump\n"
    )
    marker = tmp_path / "database-accessed"
    for command in ("pg_restore", "psql"):
        stub = tmp_path / command
        stub.write_text('#!/bin/sh\nprintf touched > "$RESTORE_DB_MARKER"\n')
        stub.chmod(0o700)
    env = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ.get("PATH", ""),
           "PGDATABASE": "recovery", "PGUSER": "restore", "RESTORE_CONFIRM": "recovery",
           "RESTORE_DB_MARKER": str(marker)}
    env.pop("PGPASSWORD_FILE", None)
    result = subprocess.run(["sh", str(ROOT / "scripts/postgres-restore.sh"), str(archive)],
                            env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode != 0
    assert "selected backup archive checksum does not match" in result.stderr
    assert not marker.exists()


def test_restore_never_overwrites_nonempty_database_even_with_legacy_override(tmp_path):
    """A typo/legacy env flag must not turn a restore drill into data loss."""
    archive = tmp_path / "selected.dump"
    archive.write_bytes(b"test-custom-format-archive")
    (tmp_path / "selected.dump.sha256").write_text(
        hashlib.sha256(archive.read_bytes()).hexdigest() + "  selected.dump\n"
    )
    touched = tmp_path / "restore-was-applied"
    pg_restore = tmp_path / "pg_restore"
    pg_restore.write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "--list" ]; then exit 0; fi\n'
        'touch "$RESTORE_WRITE_MARKER"\n'
        'exit 0\n'
    )
    pg_restore.chmod(0o700)
    psql = tmp_path / "psql"
    psql.write_text(
        '#!/bin/sh\n'
        'case "$*" in\n'
        '  *to_regclass*) echo ok ;;\n'
        '  *) echo 1 ;;\n'
        'esac\n'
    )
    psql.chmod(0o700)
    env = {**os.environ,
           "PATH": str(tmp_path) + os.pathsep + os.environ.get("PATH", ""),
           "PGDATABASE": "recovery", "PGUSER": "restore",
           "RESTORE_CONFIRM": "recovery", "RESTORE_ALLOW_NONEMPTY": "1",
           "RESTORE_WRITE_MARKER": str(touched)}
    env.pop("PGPASSWORD_FILE", None)
    result = subprocess.run(["sh", str(ROOT / "scripts/postgres-restore.sh"), str(archive)],
                            env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode != 0, result.stdout
    assert "not empty" in result.stderr.lower()
    assert not touched.exists(), "pg_restore must never apply to populated databases"
