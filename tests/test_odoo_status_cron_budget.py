"""Execute production cron/manual/ambiguous lookup methods with bounded fake I/O.

Only ORM/storage, the scheduler clock and remote responses are simulated. This
does not prove a live Odoo/PostgreSQL cron transaction or physical print outcome.
"""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from test_f010_report_binding_identity import production_methods


Production = production_methods('print_job.py', [
    'cron_sync_status', 'action_sync_status',
    '_lookup_gateway_job_for_ambiguous_submission',
])


class Response:
    def __init__(self, status, body):
        self.status_code = status
        self.body = body

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError('remote HTTP %s' % self.status_code)


class StatusCron(Production):
    def __init__(self, monkeypatch, *, count=4, seconds=1000,
                 bulk_status=503, bulk_raises=False, ambiguous=False):
        self.seconds = seconds
        self.bulk_status = bulk_status
        self.bulk_raises = bulk_raises
        self.bulk_cost = 15
        self.get_cost = 10
        self.get_status = 200
        self.savepoint_depth = 0
        self.pending_write = False
        self.calls = []
        self.commits = []
        self.rollbacks = 0
        self.apply_failure = None
        self.returned_ids = None
        self.poll_stamp = 0
        owner = self

        class Cursor:
            def execute(self, query):
                assert 'ORDER BY last_status_polled_at ASC NULLS FIRST, id ASC' in query
                assert 'LIMIT 100' in query

            def fetchall(self):
                return [(pk,) for pk in owner.jobs]

            @contextmanager
            def savepoint(self):
                owner.savepoint_depth += 1
                try:
                    yield
                except Exception:
                    owner.rollbacks += 1
                    raise
                finally:
                    owner.savepoint_depth -= 1

        class Cron:
            def _commit_progress(self, processed=0, *, remaining=None):
                assert owner.savepoint_depth == 0, 'Never commit an open savepoint'
                owner.commits.append((processed, remaining))
                owner.pending_write = False
                return max(0, owner.seconds)

        class JobSet:
            def __init__(self, jobs=()):
                self.jobs = list(jobs)

            def __iter__(self):
                return iter(self.jobs)

            def __ior__(self, job):
                self.jobs.append(job)
                return self

            def sudo(self):
                return self

            def browse(self, ids):
                return JobSet(owner.jobs[pk] for pk in ids)

            def write(self, values):
                assert list(values) == ['last_status_polled_at']
                for job in self.jobs:
                    job.write(values)

        config = SimpleNamespace(id=7,
            _gateway_base=lambda **_kwargs: 'https://gateway.invalid',
            _gateway_headers=lambda: {'Authorization': 'Bearer scoped-fixture'})
        config.sudo = lambda: config
        # Odoo records are hashable; SimpleNamespace is not.
        config_type = type('Config', (), {})
        self.config = config_type()
        self.config.__dict__.update(config.__dict__)
        self.config.sudo = lambda: self.config
        self.job_set_type = JobSet
        self.env = SimpleNamespace(cr=Cursor())
        cron = Cron()

        class Environment:
            cr = owner.env.cr

            def __getitem__(self, name):
                if name == 'ir.cron':
                    return cron
                assert name == 'print_gateway.print_job'
                return JobSet()

        self.env = Environment()

        class Job(Production):
            def __init__(self, pk):
                self.id = pk
                self.gateway_job_id = False if ambiguous else 'gw-%s' % pk
                self.gateway_config_id = owner.config
                self.idempotency_key = 'durable-intent-%s' % pk
                self.status = 'unknown' if ambiguous else 'claimed'
                self.last_error = 'UNKNOWN_SUBMISSION_OUTCOME: response lost' if ambiguous else ''
                self.last_status_polled_at = None
                self.env = owner.env

            def _require_outbox_write(self):
                return True

            def ensure_one(self):
                return self

            def filtered(self, predicate):
                return [self] if predicate(self) else []

            def _needs_gateway_status_reconciliation(self, job):
                return True

            def _gateway_idempotency_key(self):
                return 'odoo:%s' % self.idempotency_key

            def write(self, values):
                owner.pending_write = True
                self.__dict__.update(values)

            def _post_source_audit(self, message):
                pass

            _apply_synced_status = lambda _self, job, body: owner._apply_synced_status(job, body)
            _mark_gateway_job_missing = lambda _self, job, message: owner._mark_gateway_job_missing(job, message)
            _lock_status_row = lambda _self, job: owner._lock_status_row(job)

        self.jobs = {pk: Job(pk) for pk in range(1, count + 1)}
        globals_ = Production.cron_sync_status.__globals__
        monkeypatch.setitem(globals_, 'requests', SimpleNamespace(post=self.post, get=self.get))
        monkeypatch.setitem(globals_, 'db_now_utc', self.now)

    def now(self, _cr):
        self.poll_stamp += 1
        return self.poll_stamp

    def _require_cron_runner(self):
        return True

    def browse(self, ids):
        return self.job_set_type(self.jobs[pk] for pk in ids)

    def sudo(self):
        return self.job_set_type()

    def _lock_status_row(self, _job):
        self.pending_write = True

    def _apply_synced_status(self, job, body):
        assert body['jobId'] == job.gateway_job_id
        if self.apply_failure == job.id:
            self.apply_failure = None
            raise ValueError('One result failed its isolated application')
        job.write({'status': body['status']})
        return True

    def _mark_gateway_job_missing(self, job, message):
        job.write({'status': 'unknown', 'last_error': message})
        return True

    def before_http(self, method, url, kwargs, cost):
        assert self.seconds > 0, 'No HTTP after scheduler budget exhaustion'
        assert not self.pending_write, 'No status/fairness lock may span remote I/O'
        assert kwargs['allow_redirects'] is False
        assert kwargs['headers'] == {'Authorization': 'Bearer scoped-fixture'}
        self.calls.append((method, url, kwargs))
        self.seconds -= cost

    def post(self, url, **kwargs):
        assert url == 'https://gateway.invalid/api/print/jobs/batch-status'
        assert kwargs['timeout'] == 15
        self.before_http('POST', url, kwargs, self.bulk_cost)
        if self.bulk_raises:
            raise ConnectionError('Gateway batch-status unavailable')
        ids = kwargs['json']['jobIds'] if self.returned_ids is None else self.returned_ids
        return Response(self.bulk_status, {'jobs': [
            {'jobId': remote_id, 'status': 'unknown'} for remote_id in ids
        ]})

    def get(self, url, **kwargs):
        assert url == 'https://gateway.invalid/api/print/jobs'
        assert kwargs['timeout'] == 10
        self.before_http('GET', url, kwargs, self.get_cost)
        params = kwargs['params']
        if 'idempotencyKey' in params:
            assert params['idempotencyKey'].startswith('odoo:durable-intent-')
            return Response(404, {})
        return Response(self.get_status, {'jobId': params['id'], 'status': 'unknown'})


@pytest.mark.parametrize('bulk_raises', [False, True])
def test_failed_bulk_preserves_multiple_fallbacks_but_yields_before_next_http(monkeypatch, bulk_raises):
    cron = StatusCron(monkeypatch, seconds=35, bulk_raises=bulk_raises)
    assert cron.cron_sync_status() == 2
    assert [method for method, _url, _kwargs in cron.calls] == ['POST', 'GET', 'GET']
    assert [kwargs['params']['id'] for method, _url, kwargs in cron.calls if method == 'GET'] == ['gw-1', 'gw-2']
    assert [job.status for job in cron.jobs.values()] == ['unknown', 'unknown', 'claimed', 'claimed']
    assert all(job.last_status_polled_at is not None for job in cron.jobs.values())
    assert cron.commits[0] == (0, 4)
    assert sum(processed for processed, _remaining in cron.commits) == 2
    assert not cron.pending_write


def test_slow_failed_bulk_commits_fairness_before_zero_budget_blocks_all_fallbacks(monkeypatch):
    cron = StatusCron(monkeypatch, seconds=15)
    assert cron.cron_sync_status() == 0
    assert [method for method, _url, _kwargs in cron.calls] == ['POST']
    assert all(job.last_status_polled_at is not None for job in cron.jobs.values())
    assert not cron.pending_write


def test_no_initial_scheduler_budget_performs_no_remote_poll_or_status_write(monkeypatch):
    cron = StatusCron(monkeypatch, seconds=0)
    assert cron.cron_sync_status() == 0
    assert cron.calls == []
    assert all(job.last_status_polled_at is None for job in cron.jobs.values())


def test_budget_expiring_during_grouping_is_checked_before_the_first_bulk(monkeypatch):
    cron = StatusCron(monkeypatch, count=1, seconds=10)

    def config_after_grouping():
        cron.seconds = 0
        return cron.config

    cron.config.sudo = config_after_grouping
    assert cron.cron_sync_status() == 0
    assert cron.calls == []
    assert cron.jobs[1].last_status_polled_at is None


def test_ambiguous_submission_yields_after_read_only_lookup_preserving_unknown(monkeypatch):
    cron = StatusCron(monkeypatch, count=2, seconds=10, ambiguous=True)
    assert cron.cron_sync_status() == 0
    assert len(cron.calls) == 1 and cron.calls[0][0] == 'GET'
    assert cron.jobs[1].status == 'unknown' and not cron.jobs[1].gateway_job_id
    assert cron.jobs[1].last_status_polled_at is not None
    assert cron.jobs[2].last_status_polled_at is None
    assert not cron.pending_write


def test_one_failed_batch_result_falls_back_only_that_job_and_keeps_other_updates(monkeypatch):
    cron = StatusCron(monkeypatch, count=3, bulk_status=200)
    cron.apply_failure = 2
    assert cron.cron_sync_status() == 3
    assert [kwargs['params']['id'] for method, _url, kwargs in cron.calls if method == 'GET'] == ['gw-2']
    assert [job.status for job in cron.jobs.values()] == ['unknown'] * 3
    assert cron.rollbacks == 1
    assert not cron.pending_write


def test_failed_individual_poll_rotates_fairness_and_does_not_block_later_jobs(monkeypatch):
    cron = StatusCron(monkeypatch, count=3)
    cron.get_status = 503
    assert cron.cron_sync_status() == 3
    assert [method for method, _url, _kwargs in cron.calls] == ['POST', 'GET', 'GET', 'GET']
    assert [job.status for job in cron.jobs.values()] == ['claimed'] * 3
    assert all(job.last_status_polled_at is not None for job in cron.jobs.values())
    assert cron.rollbacks == 3


def test_missing_bulk_results_stay_unknown_without_reprint_or_fallback_submission(monkeypatch):
    cron = StatusCron(monkeypatch, count=3, bulk_status=200)
    cron.returned_ids = []
    assert cron.cron_sync_status() == 3
    assert [method for method, _url, _kwargs in cron.calls] == ['POST']
    assert [job.status for job in cron.jobs.values()] == ['unknown'] * 3
    assert all(job.last_error.startswith('GATEWAY_JOB_NOT_FOUND:') for job in cron.jobs.values())
