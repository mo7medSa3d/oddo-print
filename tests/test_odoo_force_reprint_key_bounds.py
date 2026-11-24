"""Exercise the real operator reprint action against the v2 wire-key contract.

The ORM transaction boundary is represented by records; no Odoo runtime or
printer is claimed by these offline tests.
"""
import ast
import importlib.util
import json
import logging
from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest


ADDON = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway"
spec = importlib.util.spec_from_file_location("reprint_identity_contract", ADDON / "idempotency_namespace.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class ResultJobs(list):
    def __ior__(self, job):
        self.append(job)
        return self


def reprint_action(original_key, attempt=0):
    source = ADDON / "models/print_job.py"
    tree = ast.parse(source.read_text())
    method = next(node for node in ast.walk(tree)
                  if isinstance(node, ast.FunctionDef) and node.name == "action_force_reprint")
    namespace = {"json": json, "uuid": uuid, "_": lambda text: text,
                 "_logger": logging.getLogger(__name__)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(source), "exec"), namespace)
    original = SimpleNamespace(
        id=31, status="unknown", physical_outcome="unknown", reprint_attempt_count=attempt,
        idempotency_key=original_key, company_id=SimpleNamespace(id=7), print_config_id=SimpleNamespace(id=9), gateway_config_id=SimpleNamespace(id=9),
        printer_id="printer-1", destination="receipt", destination_key="pos.config,3", document_type="receipt",
        payload='{"type":"pdf"}', payload_type="pdf", protocol=False, raw_payload=False,
        printer_profile=False, fallback_binding_id=False, source_model="pos.order", source_record_id=12,
        report_id=False, invalidate_recordset=lambda names: None, _assert_valid_license=lambda: None,
    )
    created, scheduled, updates = [], [], []
    class Env:
        cr = SimpleNamespace(execute=lambda sql, values: updates.append(values))
        def __getitem__(self, name):
            assert name == "print_gateway.print_job"
            return ResultJobs()
    def create_operation(**values):
        # This is the actual immutable v2 identity validator used by the
        # producer; an oversized derived key must fail before persistence.
        identity.wire_key(2, 7, values["idempotency_key"], "d1c7982e-4968-44c1-8585-1880398df174")
        created.append(values)
        return SimpleNamespace(id=41)
    company_scoped = SimpleNamespace(create_operation=create_operation)
    records = SimpleNamespace(
        env=Env(), _require_outbox_write=lambda: None, _assert_valid_license=lambda: None,
        filtered=lambda predicate: [original] if predicate(original) else [],
        with_company=lambda company: company_scoped if company is original.company_id else None,
        _schedule_postcommit_submission=scheduled.append,
    )
    result = namespace["action_force_reprint"](records)
    assert result["params"]["type"] == "warning"
    assert updates == [(attempt + 1, 31)]
    assert len(created) == 1
    assert created[0]["printer_id"] == original.printer_id
    assert created[0]["destination_key"] == original.destination_key
    return created[0]["idempotency_key"]


@pytest.mark.parametrize("length", [191, 192, 200])
def test_operator_can_reprint_every_valid_maximum_length_operation_key(length):
    key = reprint_action("a" * length)
    assert 0 < len(key) <= 200


def test_short_reprint_keys_preserve_existing_persisted_identity():
    assert reprint_action("receipt-origin", attempt=2) == "receipt-origin-reprint-3"


def test_long_reprint_keys_are_deterministic_and_do_not_collapse_sources_or_attempts():
    first = "a" * 200
    second = "a" * 199 + "b"
    assert reprint_action(first) == reprint_action(first)
    assert len({reprint_action(first), reprint_action(second), reprint_action(first, attempt=1)}) == 3
