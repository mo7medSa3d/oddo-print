"""Execute the actual reconciliation/claim methods with controlled boundary objects."""
import ast
import datetime
import logging
from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models"

class ValidationError(Exception):
    pass


def load_method(filename, name, namespace):
    tree = ast.parse((ROOT / filename).read_text())
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), filename, "exec"), namespace)
    return namespace[name]


class Base:
    def write(self, values):
        for name, value in values.items():
            setattr(self, name, value)
        return True

class Job(Base):
    _TERMINAL = {"success", "failed", "unknown", "partial"}
    def ensure_one(self):
        pass


def job(status="unknown", error="UNKNOWN_SUBMISSION_OUTCOME: lost response", remote="job_original", physical="unknown"):
    result = Job()
    result.status, result.last_error, result.gateway_job_id, result.physical_outcome = status, error, remote, physical
    ns = {"ValidationError": ValidationError, "_": lambda text: text, "PrintGatewayJob": Job}
    Job._needs_gateway_status_reconciliation = load_method("print_job.py", "_needs_gateway_status_reconciliation", ns)
    Job._apply_gateway_late_success = load_method("print_job.py", "_apply_gateway_late_success", ns)
    return result

@pytest.mark.parametrize("marker", ["UNKNOWN_SUBMISSION_OUTCOME", "AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT", "JOB_EXPIRED_DURING_PRINT"])
def test_authoritative_original_success_resolves_reconcilable_unknown(marker):
    original = job(error=marker + ": interrupted")
    original._apply_gateway_late_success(original, {"last_error": False})
    assert original.status == "success"
    assert original.gateway_job_id == "job_original"

@pytest.mark.parametrize("original", [job(remote=False), job(error="GATEWAY_JOB_NOT_FOUND"), job(status="failed", physical="not_printed")])
def test_unknown_without_proven_identity_or_deterministic_failure_cannot_be_resurrected(original):
    before = original.status
    with pytest.raises(ValidationError):
        original._apply_gateway_late_success(original, {"last_error": "LATE_SUCCESS: stale observation"})
    assert original.status == before


def test_intent_claim_closes_dedicated_cursor_when_database_clock_fails():
    cursor = SimpleNamespace(closed=False)
    cursor.close = lambda: setattr(cursor, "closed", True)
    def clock_failure(cr):
        raise RuntimeError("database clock unavailable")
    env = SimpleNamespace(registry=SimpleNamespace(cursor=lambda: cursor))
    method = load_method("print_intent.py", "_claim_intent", {"uuid": uuid, "datetime": datetime, "db_now_utc": clock_failure, "_logger": logging.getLogger(__name__)})
    assert method(None, env, 7) is None
    assert cursor.closed
