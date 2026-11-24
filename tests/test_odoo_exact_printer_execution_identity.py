"""Exercise exact printer identities in the real Odoo binding/outbox methods.

Load only source method ASTs so this regression runs in the Python CI
environment without requiring a live Odoo database. Physical printing and
ORM/transaction integration remain separate release gates.
"""
import ast
import base64
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


ADDON = Path(__file__).resolve().parents[1] / "odoo_addons" / "print_gateway"


class ValidationError(Exception):
    pass


def _runtime_policy():
    spec = importlib.util.spec_from_file_location(
        "print_gateway_exact_printer_policy", ADDON / "runtime_policy.py"
    )
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    if hasattr(policy, "is_exact_printer_key") and not hasattr(policy, "is_exact_gateway_printer_id"):
        policy.is_exact_gateway_printer_id = policy.is_exact_printer_key
    return policy


def _actual_method(filename, class_name, method_name):
    path = ADDON / "models" / filename
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    klass = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == class_name
    )
    method = next(
        node for node in klass.body
        if isinstance(node, ast.FunctionDef) and node.name == method_name
    )
    method = copy.deepcopy(method)
    method.decorator_list = []
    out = ast.Module(body=[method], type_ignores=[])
    ast.fix_missing_locations(out)
    namespace = {
        "_": lambda text: text,
        "ValidationError": ValidationError,
        "is_exact_gateway_printer_id": _runtime_policy().is_exact_gateway_printer_id,
        "is_exact_printer_key": _runtime_policy().is_exact_printer_key,
        "json": json,
        "base64": base64,
        "MAX_PRINT_CONTENT_BYTES": 5 * 1024 * 1024,
        "MAX_PRINT_BASE64_CHARS": 4 * ((5 * 1024 * 1024 + 2) // 3),
    }
    exec(compile(out, str(path), "exec"), namespace)
    return namespace[method_name]


INVALID_IDS = [
    "", " printer", "printer ", "\u00a0printer", "-not-an-issue ",
    "printer\x00another", "printer\u0085another", "\ufeffprinter", "printer\ufeff", "\ud800",
    "\udc00", "é" * 61, "😀" * 31,
]


@pytest.mark.parametrize("printer_id", INVALID_IDS)
def test_shared_runtime_policy_refuses_printer_ids_that_change_on_gateway_wire(printer_id):
    assert _runtime_policy().is_exact_gateway_printer_id(printer_id) is False


@pytest.mark.parametrize("printer_id", [
    "printer-1", "طابعة-حرارية", "printer receipt 1", "printer\ufeffID", "é" * 60, "😀" * 30,
])
def test_shared_runtime_policy_preserves_canonical_utf8_printer_ids(printer_id):
    assert _runtime_policy().is_exact_gateway_printer_id(printer_id) is True


@pytest.mark.parametrize("printer_id", INVALID_IDS + [5, True, None])
def test_outbox_rejects_nonexact_printer_before_payload_or_installation_side_effect(printer_id):
    create_operation = _actual_method("print_job.py", "PrintAgentJob", "create_operation")
    company = SimpleNamespace(parent_id=False, id=42)
    config = SimpleNamespace(company_id=company)
    touched = []

    class IsolatedModel:
        env = SimpleNamespace(company=company, is_superuser=lambda: True)
        def sudo(self):
            return self
        def _resolve_payload_kind(self, _json_text):
            touched.append("payload")
            raise AssertionError("invalid printer reached the payload parser")

    with pytest.raises(ValidationError, match="(?i)printer"):
        create_operation(
            IsolatedModel(), company=company, print_config=config,
            printer_id=printer_id, destination="receipt", document_type="receipt",
            payload={"type": "raw", "protocol": "raw", "encoding": "base64", "data": "YQ=="},
        )
    assert touched == []


@pytest.mark.parametrize("printer_id", INVALID_IDS + [5, True, None])
def test_binding_refuses_nonexact_printer_before_destination_resolution(printer_id):
    check_binding = _actual_method("binding.py", "PrintGatewayBinding", "_check_binding")
    # A malformed target must fail before dereferencing any other field.
    with pytest.raises(ValidationError, match="(?i)printer"):
        check_binding([SimpleNamespace(printer_id=printer_id)])
