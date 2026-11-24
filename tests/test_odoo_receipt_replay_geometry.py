"""Exercise production receipt route ordering at the existing-operation boundary.

The native Odoo tests cover the real durable lookup and ACLs separately.
"""
import ast
import hashlib
from pathlib import Path
from types import MethodType, SimpleNamespace
from unittest.mock import Mock

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models/print_router.py"


class ValidationError(Exception):
    pass


def routing_method(name):
    tree = ast.parse(SOURCE.read_text())
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "PrintGatewayRouter")
    methods = [node for node in owner.body if isinstance(node, ast.FunctionDef)
               and node.name in (name, "_assert_current_company")]
    for node in methods:
        node.decorator_list = []
    scope = {"ValidationError": ValidationError, "_": lambda value: value, "hashlib": hashlib}
    exec(compile(ast.fix_missing_locations(ast.Module(body=methods, type_ignores=[])), str(SOURCE), "exec"), scope)
    company = SimpleNamespace(id=7, display_name="Current company")
    record = SimpleNamespace(id=31, _name="pos.session" if name == "route_pos_sale_details" else "pos.order",
                             company_id=company, config_id=SimpleNamespace(id=3), ensure_one=lambda: None)
    route = {"binding": SimpleNamespace(id=11), "native": False}
    router = SimpleNamespace(env=SimpleNamespace(company=company), resolve_binding=Mock(return_value=route),
                             _validate_jpeg_base64=Mock(), _submit_route=Mock(),
                             _receipt_image_payload=Mock(side_effect=ValidationError("geometry changed")),
                             _replay_receipt_operation=Mock())
    for node in methods:
        setattr(router, node.name, MethodType(scope[node.name], router))
    return router, record, route


@pytest.mark.parametrize("name", ["route_pos_receipt", "route_kitchen_print", "route_pos_sale_details"])
@pytest.mark.parametrize("status", ["submitted", "unknown"])
def test_exact_persisted_operation_replays_before_changed_live_geometry(name, status):
    router, record, route = routing_method(name)
    original = {"job_id": 42, "status": status, "outcome": "unknown" if status == "unknown" else "accepted",
                "can_retry": False, "gateway_enabled": True, "native": False}
    router._replay_receipt_operation.return_value = original
    result = getattr(router, name)(record, "ORIGINAL_JPEG", idempotency_key="same-operation", geometry_fingerprint="a" * 64)
    assert result is original
    router.resolve_binding.assert_called_once()
    router._replay_receipt_operation.assert_called_once_with(route, record, "ORIGINAL_JPEG", "a" * 64, "same-operation")
    router._receipt_image_payload.assert_not_called()
    router._submit_route.assert_not_called()


@pytest.mark.parametrize("name", ["route_pos_receipt", "route_kitchen_print", "route_pos_sale_details"])
def test_new_operation_still_requires_live_geometry_before_enqueue(name):
    router, record, _route = routing_method(name)
    router._replay_receipt_operation.return_value = None
    with pytest.raises(ValidationError, match="geometry changed"):
        getattr(router, name)(record, "ORIGINAL_JPEG", idempotency_key="new-operation", geometry_fingerprint="a" * 64)
    router._submit_route.assert_not_called()


@pytest.mark.parametrize("name", ["route_pos_receipt", "route_kitchen_print", "route_pos_sale_details"])
def test_company_and_current_route_authorization_precede_replay_lookup(name):
    router, record, _route = routing_method(name)
    record.company_id = SimpleNamespace(id=8, display_name="Other company")
    with pytest.raises(ValidationError, match="active Odoo company"):
        getattr(router, name)(record, "ORIGINAL_JPEG", idempotency_key="same-operation", geometry_fingerprint="a" * 64)
    router._replay_receipt_operation.assert_not_called()
    record.company_id = router.env.company
    router.resolve_binding.side_effect = ValidationError("current binding not authorized")
    with pytest.raises(ValidationError, match="not authorized"):
        getattr(router, name)(record, "ORIGINAL_JPEG", idempotency_key="same-operation", geometry_fingerprint="a" * 64)
    router._replay_receipt_operation.assert_not_called()
