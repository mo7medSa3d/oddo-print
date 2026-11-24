"""Zero-touch S06 V2: independent and durable Odoo installation identities."""
import concurrent.futures
import stat

import pytest

from test_s06_versioned_keys import impl


def test_independent_databases_do_not_share_gateway_print_operation_keys(tmp_path):
    m = impl()
    a = m.local_identity("odoo_riyadh", "https://gw.example.com", tmp_path)
    b = m.local_identity("odoo_jeddah", "https://gw.example.com", tmp_path)
    assert a["installationId"] != b["installationId"]
    assert a["installationProof"] != b["installationProof"]
    assert m.local_identity("odoo_riyadh", "https://gw.example.com", tmp_path) == a
    assert m.wire_key(2, 1, "receipt-100", a["installationId"]) != m.wire_key(
        2, 1, "receipt-100", b["installationId"])
    assert m.deployment_proof(a["installationId"], "odoo_riyadh",
                              "https://gw.example.com", tmp_path) == a["installationProof"]


def test_automatic_identity_is_created_once_under_concurrent_workers(tmp_path):
    m = impl()
    def enroll(_):
        return m.local_identity("same-db", "https://gw.example.com", tmp_path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        identities = list(pool.map(enroll, range(40)))
    assert all(value == identities[0] for value in identities)
    assert len(list((tmp_path / "yaseir-print-installations").glob("*.json"))) == 1


def test_cloned_database_does_not_reprint_old_jobs_under_new_identity(tmp_path):
    m = impl()
    original = m.local_identity("original", "https://gw.example.com", tmp_path)
    cloned = m.local_identity("restored-copy", "https://gw.example.com", tmp_path)
    assert original["installationId"] != cloned["installationId"]
    with pytest.raises(ValueError, match="another Odoo installation"):
        m.deployment_proof(original["installationId"], "restored-copy",
                           "https://gw.example.com", tmp_path)


def test_corrupted_file_never_regenerates_and_masked_perms_are_private(tmp_path):
    m = impl()
    m.local_identity("db", "https://gw.example.com", tmp_path)
    file = next((tmp_path / "yaseir-print-installations").glob("*.json"))
    assert stat.S_IMODE(file.stat().st_mode) == 0o600
    assert stat.S_IMODE(file.parent.stat().st_mode) == 0o700
    file.write_text("{}")
    with pytest.raises(ValueError):
        m.local_identity("db", "https://gw.example.com", tmp_path)


def test_existing_gateway_with_different_origin_has_different_identity(tmp_path):
    m = impl()
    a = m.local_identity("odoo", "https://gw-a.example.com", tmp_path)
    b = m.local_identity("odoo", "https://gw-b.example.com", tmp_path)
    assert a["installationId"] != b["installationId"]


def test_bad_scope_fails_closed_without_credential_generation(tmp_path):
    m = impl()
    for database, origin in (("", "https://gw.example.com"),
                             ("db", "http://untrusted.example.com")):
        with pytest.raises(ValueError):
            m.local_identity(database, origin, tmp_path)


def test_same_database_multiple_root_companies_keep_distinct_enrollments(tmp_path):
    m = impl()
    a = m.local_identity("one-odoo-db", "https://gw.example.com", tmp_path,
                         company_id=1)
    b = m.local_identity("one-odoo-db", "https://gw.example.com", tmp_path,
                         company_id=2)
    assert a["installationId"] != b["installationId"]
    assert m.deployment_proof(a["installationId"], "one-odoo-db",
                              "https://gw.example.com", tmp_path,
                              company_id=1) == a["installationProof"]
    with pytest.raises(ValueError, match="another Odoo installation"):
        m.deployment_proof(a["installationId"], "one-odoo-db",
                           "https://gw.example.com", tmp_path,
                           company_id=2)
