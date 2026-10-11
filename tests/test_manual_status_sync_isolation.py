"""Manual status synchronization must not discard earlier successful updates.

The production `action_sync_status` loop is executed directly (AST-extracted,
as in the existing F-series tests). Only HTTP/ORM boundaries are stubs.

Root cause: the per-job loop caught only (requests.RequestException, ValueError),
but `_apply_synced_status` -> `_apply_gateway_late_success` raises ValidationError
when a Gateway late-success reconciliation is not authorized for that row. That
exception escaped, aborting the whole RPC transaction and silently rolling back
the statuses already applied for every earlier job in the same manual batch.
`cron_sync_status` already isolates each job in a savepoint; the manual path now
does too.
"""
import ast
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

MODELS = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/models'


class ValidationError(Exception):
    pass


class FakeResponse:
    status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return {'jobId': 'gw-1', 'status': 'success'}


class FakeRequests:
    RequestException = Exception

    @staticmethod
    def get(*args, **kwargs):
        return FakeResponse()


class Savepoint:
    """A savepoint that contains a per-job failure instead of propagating it."""

    def __init__(self, log):
        self.log = log

    def __enter__(self):
        self.log.append('enter')
        return self

    def __exit__(self, *exc):
        self.log.append('rollback' if any(exc) else 'commit')
        return False


class FakeCursor:
    def __init__(self):
        self.log = []

    def savepoint(self):
        return Savepoint(self.log)


class FakeJob:
    def __init__(self, key):
        self.idempotency_key = key
        self.gateway_job_id = 'gw-1'
        self.gateway_config_id = SimpleNamespace(sudo=lambda: SimpleNamespace(
            _gateway_base=lambda for_request: 'https://gateway.invalid',
            _gateway_headers=lambda: {},
        ))
        self.applied = []

    def _post_source_audit(self, message):
        self.applied.append(message)


def load_production():
    path = MODELS / 'print_job.py'
    tree = ast.parse(path.read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                and any(isinstance(m, ast.FunctionDef) and m.name == 'action_sync_status' for m in n.body))
    method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'action_sync_status')
    method.decorator_list = []
    ns = {
        'ValidationError': ValidationError,
        '_': lambda msg: msg,
        '_logger': logging.getLogger('test-manual-status-sync'),
        'requests': FakeRequests,
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(path), 'exec'), ns)
    return ns['action_sync_status']


class FakeRouterSelf:
    """Stands in for the PrintGatewayJob recordset."""

    def __init__(self, candidates, apply):
        self._candidates = candidates
        self._apply = apply
        self.cursor = FakeCursor()
        self.env = SimpleNamespace(cr=self.cursor)

    def _require_outbox_write(self):
        return None

    def filtered(self, predicate):
        return self._candidates

    def _needs_gateway_status_reconciliation(self, job):
        return True

    # Boundaries the real loop reaches.
    def _lookup_gateway_job_for_ambiguous_submission(self, job):
        return None

    def _mark_gateway_job_missing(self, job, message):
        return False

    def _apply_synced_status(self, job, body):
        return self._apply(job, body)


def run_sync(applies):
    """Execute the production loop. `applies` maps key -> callable(job, body)."""
    candidates = [FakeJob(key) for key in ('good-one', 'bad', 'good-two')]
    router = FakeRouterSelf(candidates, applies)
    action_sync_status = load_production()
    result = action_sync_status(router)
    return router, candidates, result


def test_rejected_job_does_not_discard_the_others():
    """The regression: one invalid reconciliation must not roll back the batch."""

    def apply(job, body):
        if job.idempotency_key == 'bad':
            raise ValidationError('Gateway late success is not valid for this terminal state.')
        job.applied.append(body['status'])
        return True

    router, candidates, result = run_sync(apply)

    applied = {job.idempotency_key: list(job.applied) for job in candidates}
    assert applied['good-one'] == ['success'], 'the first job must survive a later failure'
    assert applied['good-two'] == ['success'], 'jobs after the failure must still be applied'
    assert applied['bad'] == []
    # Each job is isolated, so the batch reports partial success, not a rollback.
    assert 'rollback' in router.cursor.log
    assert 'commit' in router.cursor.log


def test_manual_sync_reports_per_job_failures_without_raising():
    def apply(job, body):
        if job.idempotency_key == 'bad':
            raise ValidationError('rejected reconciliation')
        job.applied.append(body['status'])
        return True

    router, candidates, result = run_sync(apply)
    # The action returns a user notification rather than propagating.
    assert result['tag'] == 'display_notification'
    assert result['params']['type'] == 'warning'
    assert '2' in result['params']['message']
    assert '1' in result['params']['message']


def test_network_failure_is_still_contained():
    def apply(job, body):
        if job.idempotency_key == 'bad':
            raise ConnectionError('gateway unreachable')
        job.applied.append(body['status'])
        return True

    router, candidates, result = run_sync(apply)
    assert [job.applied for job in candidates if job.idempotency_key != 'bad'] == [['success'], ['success']]


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
