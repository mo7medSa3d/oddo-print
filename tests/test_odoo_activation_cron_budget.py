"""Execute the production activation cron; ORM/HTTP/commits are deterministic fakes.

No live Odoo, PostgreSQL, Gateway or printer is represented by this harness.
"""
import pytest

from test_odoo_config_key_rotation_f015 import ValidationError, config


class Progress:
    def __init__(self, budgets, records):
        self.budgets = list(budgets)
        self.seconds = self.budgets[-1] if self.budgets else 30
        self.calls = []
        self.records = records

    def _commit_progress(self, processed=0, *, remaining=None):
        self.calls.append((processed, remaining))
        for record in self.records:
            record.dirty = False
        if self.budgets:
            self.seconds = self.budgets.pop(0)
        return self.seconds


def setup(records=None, budgets=(30,)):
    records = records or [config()]
    owner = records[0]
    progress = Progress(budgets, records)
    searches = []
    owner.env.cron = progress
    owner.search = lambda domain, **kwargs: searches.append((domain, kwargs)) or records
    for record in records:
        record.dirty = False
        record._probe_gateway_connection = lambda r=record: r.history.append(('probe', None)) or True
    return owner, progress, searches


def pending(record, *, key='enc:OLD-FIXTURE'):
    record.gateway_url = 'https://new.fixture.invalid'
    record.gateway_api_key = 'enc:NEW-FIXTURE'
    record.pending_disable_gateway_url = 'https://old.fixture.invalid'
    record.pending_disable_gateway_api_key = key
    record.pending_disable_revision = 5
    record.last_enabled_sync_revision = 4


def evaluate_domain(domain, values):
    tokens = iter(domain)

    def expression():
        token = next(tokens)
        if token in ('|', '&'):
            left, right = expression(), expression()
            return left or right if token == '|' else left and right
        field, operator, expected = token
        actual = values.get(field, -1 if field == 'pending_disable_revision' else False)
        return actual != expected if operator == '!=' else actual >= expected

    result = expression()
    assert next(tokens, None) is None
    return result


def test_initial_budget_zero_performs_no_remote_work_and_bounds_fair_search():
    record, progress, searches = setup(budgets=(0,))
    assert record.cron_sync_enabled_state() is True
    assert record.history == []
    assert progress.calls == [(0, 1)]
    domain, options = searches[0]
    assert options == {'limit': 50, 'order': 'write_date asc, id asc'}
    assert evaluate_domain(domain, {'gateway_url': 'https://example.invalid', 'gateway_api_key': 'enc:key'})
    assert not evaluate_domain(domain, {'gateway_url': 'https://example.invalid'})
    assert not evaluate_domain(domain, {'gateway_api_key': 'enc:key'})
    for metadata in (
        {'pending_disable_gateway_url': 'https://old.invalid'},
        {'pending_disable_gateway_api_key': 'enc:old'},
        {'pending_disable_revision': 0},
    ):
        assert evaluate_domain(domain, metadata), metadata


@pytest.mark.parametrize('budgets,expected', [
    ((30, 0), []),
    ((30, 30, 0), ['disable']),
    ((30, 30, 30, 0), ['disable', 'probe']),
])
def test_budget_fences_each_remote_phase_and_leaves_unfinished_record(budgets, expected):
    record, progress, _ = setup(budgets=budgets)
    pending(record)
    assert record.cron_sync_enabled_state() is True
    assert [event[0] for event in record.history] == expected
    assert progress.calls[-1] == (0, 1)
    assert record.pending_disable_gateway_api_key == 'enc:OLD-FIXTURE'


def test_failed_probe_counts_attempt_and_exhausted_budget_skips_next_config():
    first, second = config(), config()
    owner, progress, _ = setup([first, second], budgets=(30, 30, 0))
    first._probe_gateway_connection = lambda: first.history.append(('probe_failed', None)) or False
    assert owner.cron_sync_enabled_state() is True
    assert first.history == [('probe_failed', None)]
    assert second.history == []
    assert progress.calls[-1] == (1, 1)


def test_completed_healthy_records_report_each_progress_without_activation():
    first, second = config(), config()
    owner, progress, _ = setup([first, second])
    assert owner.cron_sync_enabled_state() is True
    assert first.history == second.history == [('probe', None)]
    assert [call for call in progress.calls if call[0]] == [(1, 1), (1, 0)]


def test_removed_key_persists_confirmed_disable_before_clearing_migration():
    record, progress, _ = setup()
    pending(record)
    record.gateway_api_key = False
    record.enabled = False
    assert record.cron_sync_enabled_state() is True
    assert [event[0] for event in record.history] == ['disable', 'sync_result', 'complete']
    assert record.history[1][1] == {
        'success': True, 'revision': 5, 'error': False, 'expected_revision': 5,
    }
    assert progress.calls[-1] == (1, 0)


@pytest.mark.parametrize('metadata', [
    {'pending_disable_gateway_url': 'https://old.invalid'},
    {'pending_disable_gateway_api_key': 'enc:old'},
    {'pending_disable_revision': 0},
])
def test_incomplete_pending_fence_cannot_probe_or_activate_current_endpoint(metadata):
    record, progress, _ = setup()
    record.last_enabled_sync_revision = 4
    vars(record).update(metadata)
    assert record.cron_sync_enabled_state() is True
    assert [event[0] for event in record.history] == ['migration_result']
    assert 'state is incomplete' in record.history[0][1]['error']
    assert record.history[0][1]['success'] is False
    assert progress.calls[-1] == (1, 0)


def test_legacy_pending_credential_healing_is_committed_before_remote_acknowledgment():
    record, _, _ = setup()
    pending(record, key='LEGACY-FIXTURE')

    def write(values):
        vars(record).update(values)
        record.dirty = True
        return True

    def disable(kwargs):
        assert record.dirty is False, 'fresh acknowledgment must not wait on the owning cursor'
        record.history.append(('disable', kwargs))
        return True

    record.write = write
    record.record_disable = disable
    assert record.cron_sync_enabled_state() is True
    assert record.pending_disable_gateway_api_key == 'enc:LEGACY-FIXTURE'
    assert [event[0] for event in record.history] == ['disable', 'probe', 'enable', 'complete']


def test_failed_legacy_decode_releases_healing_write_before_error_persistence():
    record, progress, _ = setup()
    pending(record, key='LEGACY-FIXTURE')

    def write(values):
        vars(record).update(values)
        record.dirty = True
        return True

    def persist(**kwargs):
        assert record.dirty is False
        record.history.append(('migration_result', kwargs))

    record.write = write
    record._gateway_api_key_plaintext_from_value = lambda _value: (_ for _ in ()).throw(ValidationError('decode failed'))
    record._persist_gateway_migration_result = persist
    assert record.cron_sync_enabled_state() is True
    assert record.history == [('migration_result', {'success': False, 'error': 'decode failed'})]
    assert progress.calls[-1] == (1, 0)


def test_activation_validation_error_keeps_exact_revision_and_advances_progress():
    record, progress, _ = setup()
    record.last_enabled_sync_revision = 4
    record._gateway_base = lambda **_kwargs: (_ for _ in ()).throw(ValidationError('invalid URL'))
    assert record.cron_sync_enabled_state() is True
    assert [event[0] for event in record.history] == ['probe', 'sync_result']
    assert record.history[1][1] == {
        'success': False, 'revision': None, 'error': 'invalid URL', 'expected_revision': 5,
    }
    assert progress.calls[-1] == (1, 0)
