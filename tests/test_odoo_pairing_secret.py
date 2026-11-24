"""Runtime-independent regression tests for Odoo's direct Agent pairing hash."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
CRYPTO_PATH = ROOT / "odoo_addons19" / "print_gateway" / "models" / "crypto.py"
SPEC = spec_from_file_location("yaseir_odoo_crypto_under_test", CRYPTO_PATH)
assert SPEC is not None and SPEC.loader is not None
crypto = module_from_spec(SPEC)
SPEC.loader.exec_module(crypto)


def _hash(code: str, *, key: bytes = b"k" * 32, version: str = "1") -> str:
    with patch.object(crypto, "_active_version", return_value=version), patch.object(
        crypto, "_load_key", return_value=key
    ):
        return crypto.hash_agent_pairing_code(code)


def test_direct_odoo_pairing_uses_keyed_hmac_not_plain_sha256():
    value = _hash(" abcdef ")
    assert value == _hash("ABCDEF")
    assert len(value) == 64
    assert value != crypto.hashlib.sha256(b"ABCDEF").hexdigest()


def test_direct_odoo_pairing_digest_changes_when_external_key_rotates():
    original = _hash("ABCDEF", key=b"a" * 32)
    rotated = _hash("ABCDEF", key=b"b" * 32)
    assert original != rotated


def test_direct_odoo_pairing_digest_is_bound_to_active_key_version():
    version_one = _hash("ABCDEF", version="1")
    version_two = _hash("ABCDEF", version="2")
    assert version_one != version_two


def test_direct_odoo_pairing_fails_closed_when_external_key_is_missing():
    with patch.object(crypto, "_active_version", return_value="1"), patch.object(
        crypto, "_load_key", side_effect=crypto.CredentialKeyUnavailable("missing")
    ):
        try:
            crypto.hash_agent_pairing_code("ABCDEF")
        except crypto.CredentialKeyUnavailable:
            pass
        else:
            raise AssertionError("pairing digest silently fell back without its deployment key")


def test_direct_odoo_pairing_model_and_public_registration_use_same_keyed_hash():
    model_source = (ROOT / "odoo_addons19/print_gateway/models/agent.py").read_text(encoding="utf-8")
    controller_source = (ROOT / "odoo_addons19/print_gateway/controllers/agent_api.py").read_text(encoding="utf-8")
    assert "return hash_agent_pairing_code(raw_value)" in model_source
    assert "pairing_hash = hash_agent_pairing_code(pairing_code)" in controller_source
    assert "pairing_hash = _hash_token(pairing_code.upper())" not in controller_source
