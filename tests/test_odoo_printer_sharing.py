"""Execute the actual pure addon sharing gate; this is not live Odoo acceptance."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("print_gateway_runtime_policy_audit", ROOT / "odoo_addons/print_gateway/runtime_policy.py")
policy = module_from_spec(spec)
spec.loader.exec_module(policy)


@pytest.mark.parametrize("printer, expected", [
    ({"id": "legacy"}, True),
    ({"id": "shared", "sharedWithGateway": True}, True),
    ({"id": "private", "status": "online", "sharedWithGateway": False}, False),
    ({"sharedWithGateway": "false"}, False),
    ({"sharedWithGateway": "true"}, False),
    ({"sharedWithGateway": 1}, False),
    ({"sharedWithGateway": 0}, False),
    ({"sharedWithGateway": None}, False),
    (None, False),
    ([], False),
])
def test_actual_inventory_permission_is_separate_from_health(printer, expected):
    assert policy.is_gateway_shared_printer(printer) is expected


def test_controller_and_exact_binding_use_the_same_permission_gate():
    for file in ["controllers/runtime_printers.py", "models/binding.py"]:
        source = (ROOT / "odoo_addons/print_gateway" / file).read_text()
        assert "from ..runtime_policy import is_gateway_shared_printer" in source
        assert "is_gateway_shared_printer(printer" in source
    source = (ROOT / "odoo_addons/print_gateway/models/print_job.py").read_text()
    assert 'reject_code == "PRINTER_NOT_SHARED"' in source
    assert '"GATEWAY_REJECTED_%s: %s"' in source


@pytest.mark.parametrize("rows, expected", [
    ([{"id": "primary", "lifecycle": "active", "agent": {"id": "owner"}}], True),
    ([{"id": "primary", "lifecycle": "active", "sharedWithGateway": True, "agent": {"id": "owner"}, "status": "offline"}], True),
    ([{"id": "primary", "lifecycle": "active", "sharedWithGateway": False, "agent": {"id": "owner"}}], False),
    ([{"id": "backup", "lifecycle": "active", "sharedWithGateway": True, "agent": {"id": "owner"}}], False),
    ([{"id": "primary", "lifecycle": "disabled", "agent": {"id": "owner"}}], False),
    ([{"id": "primary", "lifecycle": "active", "agent": {"id": ""}}], False),
    ([{"id": "primary", "lifecycle": "active"}], False),
    ([], False),
    (None, False),
])
def test_fallback_proof_requires_exact_owned_primary_without_inventing_health(rows, expected):
    assert policy.inventory_has_shared_printer({"printers": rows}, "primary") is expected
    assert policy.inventory_has_shared_printer(None, "primary") is False
