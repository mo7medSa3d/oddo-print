from pathlib import Path

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
    assert 'sha256sum -c' in src
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
