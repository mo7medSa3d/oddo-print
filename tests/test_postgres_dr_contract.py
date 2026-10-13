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
    assert "RESTORE_ALLOW_NONEMPTY" in src
    assert "--clean --if-exists" in src
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
