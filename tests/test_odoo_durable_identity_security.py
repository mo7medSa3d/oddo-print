"""Execute durable model admission methods without an Odoo/PostgreSQL runtime.

Only the ORM persistence boundary is replaced. These tests prove that the
production overrides reject untrusted creation/repointing before persistence;
the native addon suite separately verifies the real ACL/RPC integration.
"""
import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


MODELS = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models"


class AccessError(Exception):
    pass


class ValidationError(Exception):
    pass


class PersistenceBoundary:
    def __init__(self, *, trusted=False):
        self.env = SimpleNamespace(is_superuser=lambda: trusted)
        self.persisted = []

    def create(self, values):
        self.persisted.extend(copy.deepcopy(values))
        return values

    def write(self, values):
        self.persisted.append(copy.deepcopy(values))
        return True

    def __iter__(self):
        return iter([self])


def production_model(filename, class_name):
    source = ast.parse((MODELS / filename).read_text())
    original = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name in (class_name, "PrintAgentJob"))
    body = []
    for node in original.body:
        if isinstance(node, ast.FunctionDef) and node.name in {"create", "write", "_resolve_payload_kind"}:
            node = copy.deepcopy(node)
            node.decorator_list = []
            body.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in {
            "_PAYLOAD_TYPE_MAP", "_VALID_TRANSITIONS", "_VALID_INTENT_TRANSITIONS",
        } for target in node.targets):
            body.append(copy.deepcopy(node))
    generated = ast.ClassDef(name=class_name, bases=[ast.Name(id="PersistenceBoundary", ctx=ast.Load())],
                             keywords=[], body=body, decorator_list=[])
    namespace = {"PersistenceBoundary": PersistenceBoundary, "AccessError": AccessError,
                 "ValidationError": ValidationError, "_": lambda text: text, "json": json}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[generated], type_ignores=[])),
                 str(MODELS / filename), "exec"), namespace)
    return namespace[class_name]


def job(trusted=False):
    record = production_model("print_job.py", "PrintAgentJob")(trusted=trusted)
    record.payload_type = "pdf"
    record.protocol = False
    record._assert_valid_license = lambda: None
    return record


def intent(trusted=False):
    return production_model("print_intent.py", "PrintGatewayIntent")(trusted=trusted)


@pytest.mark.parametrize("factory, values", [
    (job, {"company_id": 2, "print_config_id": 900, "printer_id": "foreign-printer",
           "payload_type": "pdf", "payload": '{"type":"pdf"}'}),
    (intent, {"company_id": 2, "policy_id": 900, "res_model": "account.move",
              "res_id": 901, "event_type": "invoice_posted", "intent_key": "forged"}),
])
def test_interactive_admin_cannot_forge_durable_work(factory, values):
    record = factory()
    with pytest.raises(AccessError):
        record.create([values])
    assert record.persisted == []


@pytest.mark.parametrize("field, value", [
    ("company_id", 900), ("print_config_id", 900), ("printer_id", "foreign-printer"),
    ("payload", '{"type":"pdf"}'), ("source_model", "account.move"), ("source_record_id", 900),
    ("report_id", 900), ("destination_key", "ir.actions.report,900"),
    ("idempotency_key", "forged"),
])
def test_interactive_admin_cannot_repoint_outbox_work(field, value):
    record = job()
    with pytest.raises(AccessError):
        record.write({field: value})
    assert record.persisted == []


@pytest.mark.parametrize("field, value", [
    ("company_id", 900), ("policy_id", 900), ("res_model", "account.move"),
    ("res_id", 900), ("event_type", "invoice_posted"), ("intent_key", "forged"),
])
def test_interactive_admin_cannot_repoint_automation_work(field, value):
    record = intent()
    with pytest.raises(AccessError):
        record.write({field: value})
    assert record.persisted == []


@pytest.mark.parametrize("factory, values", [
    (job, {"payload_type": "pdf", "payload": '{"type":"pdf"}'}),
    (intent, {"res_model": "account.move", "res_id": 7}),
])
def test_trusted_router_and_policy_can_persist_work(factory, values):
    record = factory(trusted=True)
    record.create([values])
    assert record.persisted == [values]


@pytest.mark.parametrize("factory", [job, intent])
def test_operator_recovery_bookkeeping_stays_available(factory):
    record = factory()
    record.write({"last_error": False, "attempts": 0})
    assert record.persisted == [{"last_error": False, "attempts": 0}]
