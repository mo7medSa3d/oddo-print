"""S06-006 contract: independent Odoo databases must not share Gateway identities."""
import hashlib
import importlib.util
import json
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/idempotency_namespace.py"


def impl():
    spec = importlib.util.spec_from_file_location("idempotency_namespace", SRC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_old_v1_key_is_exact_historical_digest():
    m = impl()
    expected = hashlib.sha256(b"odoo:7:operation-123").hexdigest()
    assert m.legacy_key(7, "operation-123") == expected
    assert m.wire_key(1, 7, "operation-123") == expected


def test_v2_different_installations_same_local_operation_are_distinct():
    m = impl()
    a = "00000000-0000-4000-8000-000000000001"
    b = "00000000-0000-4000-8000-000000000002"
    ka = m.wire_key(2, 7, "operation-123", a)
    kb = m.wire_key(2, 7, "operation-123", b)
    assert ka != kb and len(ka) == len(kb) == 64
    assert ka != m.legacy_key(7, "operation-123")
    assert ka == hashlib.sha256(json.dumps(["yaseir-odoo-v2",a,"7","operation-123"], separators=(",", ":")).encode()).hexdigest()


def test_v2_company_scope_requires_canonical_gateway_decimal_identity():
    import pytest

    m = impl()
    installation = "00000000-0000-4000-8000-000000000001"
    for company in ("0", 0, "00", "07", "+7", " 7", "7 ", "-1", "7.0",
                    "١", "7" * 19, None, False, True):
        with pytest.raises(ValueError, match="Canonical Odoo source company ID"):
            m.wire_key(2, company, "operation-123", installation)

    # Odoo's persisted res.company integer ID and its canonical string have
    # the same Gateway v2 key; full 18-digit values remain representable.
    for company in (1, 7, 999999999999999999):
        assert m.wire_key(2, company, "operation-123", installation) == (
            m.wire_key(2, str(company), "operation-123", installation)
        )

    # A v1 historical key must remain byte-identical, including a previously
    # stored noncanonical company spelling.
    assert m.wire_key(1, "07", "operation-123") == m.legacy_key("07", "operation-123")


def test_v2_unicode_operation_length_matches_gateway_utf16_units():
    """Gateway JS enforces 200 UTF-16 code units; astral symbols use two.

    Odoo must reject unsupported operation IDs BEFORE enqueuing a durable
    local request. Never change v1 keys; historical operations remain valid.
    """
    import pytest

    m = impl()
    installation = "00000000-0000-4000-8000-000000000001"
    accepted = "🖨" * 100  # 200 UTF-16 units
    rejected = "🖨" * 101  # 202 UTF-16 units
    expected = hashlib.sha256(json.dumps(
        ["yaseir-odoo-v2", installation, "7", accepted],
        ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    assert m.wire_key(2, 7, accepted, installation) == expected
    with pytest.raises(ValueError, match="Durable local operation key"):
        m.wire_key(2, 7, rejected, installation)
    assert m.wire_key(1, 7, rejected) == m.legacy_key(7, rejected)


def test_v2_rejects_ill_formed_unicode_before_durable_request():
    """Odoo v2 cannot encode isolated UTF-16 surrogate values.

    The Gateway admission and operator reconciliation paths must enforce
    identical Unicode validity; existing v1 history is untouched.
    """
    import pytest

    m = impl()
    installation = "00000000-0000-4000-8000-000000000001"
    for malformed in (chr(0xD800), chr(0xDC00), "a" + chr(0xD800) + "b"):
        with pytest.raises(ValueError, match="Durable local operation key"):
            m.wire_key(2, 7, malformed, installation)


def test_v2_is_pinned_to_saved_installation_not_a_rotating_credential():
    m = impl()
    stored = m.wire_key(2, 7, "old-queued", "00000000-0000-4000-8000-000000000001")
    assert stored == m.wire_key(2, 7, "old-queued", "00000000-0000-4000-8000-000000000001")
    # No API key parameter is accepted by the wire-key derivation.
    assert "odoo_" not in stored


def test_fail_closed_without_registered_identity_and_proof():
    m = impl()
    for identity, proof in ((None,"token"),("00000000-0000-4000-8000-000000000001",None)):
        try:
            m.require_v2_identity(identity, proof)
        except ValueError:
            pass
        else:
            raise AssertionError("v2 without both registered identity and out-of-DB proof must fail")


def test_historical_v1_never_rejects_a_preexisting_large_source_identity():
    """An upgrade cannot rewrite or strand a previously admitted legacy key."""
    m = impl()
    old_operation = "legacy-prefix-" + "z" * 220
    assert m.wire_key(1, 7, old_operation) == hashlib.sha256(("odoo:7:" + old_operation).encode()).hexdigest()


def test_cloned_database_without_separate_external_proof_is_not_auto_enrolled(monkeypatch):
    m = impl()
    installation = "00000000-0000-4000-8000-000000000001"
    monkeypatch.delenv("YASEIR_ODOO_INSTALLATION_PROOFS", raising=False)
    monkeypatch.delenv("YASEIR_ODOO_INSTALLATION_PROOF", raising=False)
    import pytest
    with pytest.raises(ValueError):
        m.deployment_proof(installation)


def test_multiple_installations_use_separate_external_proof_map(monkeypatch):
    m = impl()
    a = "00000000-0000-4000-8000-000000000001"
    b = "00000000-0000-4000-8000-000000000002"
    proof_a, proof_b = "a" * 43, "b" * 43
    monkeypatch.setenv("YASEIR_ODOO_INSTALLATION_PROOFS", json.dumps({a: proof_a, b: proof_b}))
    assert m.deployment_proof(a) == proof_a
    assert m.deployment_proof(b) == proof_b
    monkeypatch.setenv("YASEIR_ODOO_INSTALLATION_PROOFS", json.dumps({a: proof_a}))
    import pytest
    with pytest.raises(ValueError):
        m.deployment_proof(b)
