"""Real kitchen route, durable-submit and submit-loop regression; external boundaries are isolated."""
import ast
import datetime
import logging
from pathlib import Path
from types import SimpleNamespace
import time
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models"

class ValidationError(Exception):
    pass

class RequestException(Exception):
    pass

class Timeout(RequestException):
    pass

class ConnectionError(RequestException):
    pass


def methods(filename, names, namespace):
    tree = ast.parse((ROOT / filename).read_text())
    functions = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name in names]
    for node in functions:
        node.decorator_list = []
    exec(compile(ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[])), filename, "exec"), namespace)
    return {name: namespace[name] for name in names if name in namespace}


def fixture(response=None, transport_error=None, unrecorded_error=None, lease_available=True):
    class Cursor:
        closed = False
        rollbacks = 0
        commits = 0
        def execute(self, query, _params=None):
            if "SELECT status, submit_claim_token" in query:
                self.row = (job.status, job.submit_claim_token)
        def fetchone(self): return self.row
        def rollback(self): self.rollbacks += 1
        def commit(self): self.commits += 1
        def close(self): self.closed = True
    cursor = Cursor()
    cursors = []
    def fresh_cursor():
        opened = cursor if not cursors else Cursor()
        cursors.append(opened)
        return opened
    company = SimpleNamespace(id=1)
    config = SimpleNamespace(enabled=True, sudo=lambda: config,
        _gateway_base=lambda **_kwargs: "https://gateway.example",
        _gateway_headers=lambda: {"Authorization": "Bearer TEST_BOUNDARY_KEY"})
    requests = SimpleNamespace(exceptions=SimpleNamespace(Timeout=Timeout,
        ConnectionError=ConnectionError), RequestException=RequestException)
    sent = []
    def post(*args, **kwargs):
        sent.append((args, kwargs))
        if transport_error: raise transport_error
        return response
    requests.post = post
    namespace = {"ValidationError": ValidationError, "_": lambda text: text,
        "requests": requests, "datetime": datetime,
        "db_now_utc": lambda _cr: datetime.datetime(2026, 10, 9),
        "_logger": logging.getLogger(__name__)}
    job_methods = methods("print_job.py", ["_action_submit_trusted", "_record_ambiguous_submission", "_is_deterministic_failure", "_persist_state"], namespace)
    class Job:
        _TERMINAL = {"success", "failed", "unknown", "partial"}
        _GATEWAY_UNKNOWN_MARKERS = ("AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT",
            "JOB_EXPIRED_DURING_PRINT", "UNKNOWN_PARTIAL_DELIVERY", "UNKNOWN_SUBMISSION_OUTCOME")
        id = 7
        status = "queued"
        last_error = False
        next_retry_at = False
        gateway_job_id = False
        submit_claim_token = "owned-lease"
        attempts = 0
        printer_id = "station-2"
        fallback_binding_id = False
        idempotency_key = "company:1:kitchen-operation"
        gateway_config_id = config
        company_id = company
        def __iter__(self): return iter([self])
        def ensure_one(self): pass
        def exists(self): return self
        def sudo(self): return self
        def with_company(self, _company): return self
        def invalidate_recordset(self, _fields): pass
        def _claim_submission_lease(self, _job):
            if unrecorded_error: raise unrecorded_error
            return "owned-lease" if lease_available else False
        def _submission_body(self): return {"printerId": self.printer_id, "idempotencyKey": self.idempotency_key}
        def write(self, values):
            for key, value in values.items(): setattr(self, key, value)
            return True
        def _in_test_mode(self): return False
        def _advance_status_claimed(self, job, target, values, _token):
            return job.write(dict(values, status=target))
        def _post_source_audit(self, _message): pass
        def _is_pre_dispatch_error(self, _error): return False
    for name, method in job_methods.items(): setattr(Job, name, method)
    job = Job()
    class Env:
        uid = 2
        context = {}
        def __getitem__(self, name):
            assert name == "print_gateway.print_job"
            collection = SimpleNamespace(browse=lambda _id: job)
            collection.sudo = lambda: collection
            return collection
    env = Env()
    env.registry = SimpleNamespace(cursor=fresh_cursor)
    env.cr = cursor
    env.company = company
    job.env = env
    namespace.update({"api": SimpleNamespace(Environment=lambda *_args: env), "time": time, "uuid": uuid})
    route_methods = methods("print_router.py", ["_submit_durable_job", "_durable_submission_outcome", "_submission_message", "_submit_route", "route_kitchen_print"], namespace)
    class Router:
        def _assert_current_company(self, _company, **_kwargs): pass
        def _persist_durable_job(self, values):
            self.persisted_values = values
            return job.id
        def resolve_binding(self, **_kwargs):
            return {"binding": SimpleNamespace(printer_id="station-2", fallback_binding_id=False),
                "config": config, "document_type": "kitchen",
                "destination": SimpleNamespace(display_name="Kitchen Station 2", _name="pos.config", id=5)}
        def _validate_jpeg_base64(self, _image): pass
    for name, method in route_methods.items(): setattr(Router, name, method)
    router = Router()
    router.env = env
    order = SimpleNamespace(id=21, company_id=company, config_id=SimpleNamespace(id=5), _name="pos.order",
        ensure_one=lambda: None, check_access=lambda _mode: None)
    return router, job, cursor, sent, order


def reply(status, body):
    return SimpleNamespace(status_code=status, json=lambda: body, headers={}, content=True)


def test_kitchen_definite_gateway_refusal_is_structured_after_real_submit_loop():
    router, job, cursor, sent, order = fixture(reply(503, {"code": "PRINTER_OFFLINE", "error": "offline"}))
    result = router.route_kitchen_print(order, "JPEG_BASE64", idempotency_key="kitchen-operation")
    assert result["status"] == "failed"
    assert result["can_retry"] is True
    assert result["outcome"] == "failed"
    assert "offline or unavailable" in result["message"]
    assert job.status == "failed"
    assert cursor.rollbacks == 1 and cursor.closed
    assert len(sent) == 1
    assert router.persisted_values["idempotency_key"] == "kitchen-operation"


@pytest.mark.parametrize("marker", ["UNKNOWN_PARTIAL_DELIVERY", "AGENT_EXECUTION_TIMEOUT"])
def test_gateway_failed_with_unknown_evidence_never_exposes_safe_station_retry(marker):
    router, _job, cursor, _sent, _order = fixture(reply(200, {"jobId": "gateway-original",
        "status": "failed", "error": marker + ": paper may exist"}))
    result = router._submit_durable_job(7, structured_outcome=True)
    assert result["status"] == "unknown"
    assert result["can_retry"] is False
    assert result["gateway_job_id"] == "gateway-original"
    assert cursor.commits == 1 and cursor.closed


@pytest.mark.parametrize("response,transport", [
    (None, Timeout("read response lost")),
    (reply(200, {}), None),
])
def test_post_dispatch_timeout_or_malformed_reply_keeps_unknown_operation(response, transport):
    router, job, cursor, sent, _order = fixture(response, transport_error=transport)
    result = router._submit_durable_job(7, structured_outcome=True)
    assert result["status"] == "unknown"
    assert result["can_retry"] is False
    assert job.status == "unknown"
    assert len(sent) == 1
    assert cursor.closed


@pytest.mark.parametrize("http_status,body", [(401, {}), (429, {})])
def test_automatic_backoff_is_accepted_as_the_same_durable_operation(http_status, body):
    router, job, cursor, sent, _order = fixture(reply(http_status, body))
    result = router._submit_durable_job(7, structured_outcome=True)
    assert result["status"] == "queued"
    assert result["outcome"] == "queued"
    assert result["can_retry"] is False
    assert "accepted by the Gateway" not in result["message"]
    assert job.next_retry_at
    assert len(sent) == 1 and cursor.closed


def test_unrecorded_exception_is_not_converted_into_false_failed_or_accepted_evidence():
    router, _job, cursor, sent, _order = fixture(unrecorded_error=ValidationError("claim unavailable"))
    with pytest.raises(ValidationError, match="claim unavailable"):
        router._submit_durable_job(7, structured_outcome=True)
    assert sent == []
    assert cursor.closed


def test_other_producers_keep_the_existing_exception_contract_until_their_batch():
    router, job, cursor, sent, _order = fixture(reply(503, {"code": "PRINTER_OFFLINE", "error": "offline"}))
    with pytest.raises(ValidationError, match="offline or unavailable"):
        router._submit_durable_job(7)
    assert job.status == "failed"
    assert len(sent) == 1 and cursor.closed


def test_committed_outbox_waiting_for_another_worker_does_not_claim_gateway_acceptance():
    router, _job, cursor, sent, _order = fixture(lease_available=False)
    result = router._submit_durable_job(7, structured_outcome=True)
    assert result["status"] == "queued"
    assert result["outcome"] == "queued"
    assert result["message"] == "Queued"
    assert result["can_retry"] is False
    assert sent == []
    assert cursor.commits == 1 and cursor.closed
