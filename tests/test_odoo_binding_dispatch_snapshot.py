"""Run the actual Odoo durable-persistence method against a second, changed ORM snapshot.

Binding validation at route selection does not authorize a changed destination
or document type at a later independent transaction. Only external/Odoo ORM
and cursor objects are replaced; the production decision method runs as-is.
"""
from types import SimpleNamespace

import pytest

from test_f010_report_binding_identity import production_methods, ValidationError

Binding = production_methods('binding.py', ['resolve_explicit'])


class Ref(SimpleNamespace):
    # Companies in this fixture are root companies; the fail-fast routing
    # guard walks parent_id to find the root scope.
    parent_id = False

    def exists(self):
        return self

    def __len__(self):
        return 1


class Cursor:
    def __init__(self):
        self.commits = 0
        self.closed = False
        self.queries = []

    def execute(self, query, params=None):
        self.queries.append((query, params))

    def fetchall(self):
        # The fail-fast routing guard checks printer sharing/agent state before
        # persisting; this fixture keeps that check satisfied so binding-change
        # denials are exercised instead.
        return [(True, True)]

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = True


class Lookup:
    def __init__(self, value):
        self.value = value

    def sudo(self):
        return self

    def browse(self, record_id):
        assert self.value.id == record_id
        return self.value

    def resolve_explicit(self, *args, **kwargs):
        return Binding.resolve_explicit(self, *args, **kwargs)


class Jobs:
    def __init__(self):
        self.created = []

    def with_company(self, company):
        assert company.id == 21
        return self

    def create_operation(self, **kwargs):
        self.created.append(kwargs)
        return Ref(id=501)


class Environment:
    def __init__(self, root, config, binding, jobs, report):
        self.models = {
            'res.company': Lookup(root),
            'print_gateway.gateway_config': Lookup(config),
            'print_gateway.binding': Lookup(binding),
            'ir.actions.report': Lookup(report),
            'print_gateway.print_router': SimpleNamespace(
                _binding_scope=lambda company: (company, False)),
            'print_gateway.runtime_agent_assignment': SimpleNamespace(
                is_agent_assigned=lambda *_args: True),
            'print_gateway.print_job': jobs,
        }

    def __getitem__(self, model):
        return self.models[model]


def attempt_persist(*, destination_id=31, document_type='receipt',
                    route_report_id=None, binding_report_id=None):
    root = Ref(id=21)
    config = Ref(id=22)
    fresh_binding = Ref(
        id=23, company_id=root, branch_id=False, agent_id=Ref(id=1, agent_uid='agt_12345678'), runtime_agent_id='runtime-agent-1',
        enabled=True, printer_id='exact-printer-1',
        printer_protocol='spooler',
        destination_ref=Ref(id=destination_id, _name='pos.config'),
        document_type=document_type,
        report_id=Ref(id=binding_report_id) if binding_report_id else False,
    )
    jobs = Jobs()
    cursor = Cursor()
    env = Environment(root, config, fresh_binding, jobs,
                      Ref(id=route_report_id) if route_report_id else Ref(id=-1))
    Router = production_methods('print_router.py', ['_persist_durable_job'])
    Router._persist_durable_job.__globals__['api'] = SimpleNamespace(
        Environment=lambda *_args: env
    )
    router = Router()
    router.env = SimpleNamespace(
        uid=7, context={},
        registry=SimpleNamespace(cursor=lambda: cursor),
    )
    values = {
        'company': root,
        'gateway_config': config,
        'binding': Ref(id=23),
        'fallback_binding': False,
        'report': Ref(id=route_report_id) if route_report_id else False,
        'printer_id': 'exact-printer-1',
        'destination': 'POS Shop',
        'destination_key': 'pos.config,30',
        'document_type': 'receipt',
        'payload': {'type': 'image', 'encoding': 'base64', 'data': 'Zg=='},
        'source_model': 'pos.order',
        'source_record_id': 7,
        'idempotency_key': 'durable-kitchen-key',
    }
    return router, values, cursor, jobs


@pytest.mark.parametrize('changes,expected', [
    ({'destination_id': 32}, 'destination'),
    ({'destination_id': 30, 'document_type': 'kitchen'}, 'document type'),
])
def test_changed_binding_cannot_create_outbox_job_at_persistence_boundary(changes, expected):
    router, values, cursor, jobs = attempt_persist(**changes)
    with pytest.raises(ValidationError, match=expected):
        router._persist_durable_job(values)
    assert not jobs.created, 'A changed binding must never be submitted as the earlier route'
    assert cursor.commits == 0
    assert cursor.closed


def test_report_binding_changed_to_another_report_is_denied_before_outbox_create():
    """Two reports on the same document model and destination cannot share authorization."""
    router, values, cursor, jobs = attempt_persist(
        destination_id=30, route_report_id=61, binding_report_id=62,
    )
    with pytest.raises(ValidationError, match='report'):
        router._persist_durable_job(values)
    assert jobs.created == []
    assert cursor.commits == 0
    assert cursor.closed


def test_original_report_binding_remains_routable_without_drift():
    router, values, cursor, jobs = attempt_persist(
        destination_id=30, route_report_id=61, binding_report_id=61,
    )
    assert router._persist_durable_job(values) == 501
    assert cursor.commits == 1
    assert len(jobs.created) == 1
    assert jobs.created[0]['report'].id == 61


def test_matching_binding_snapshot_preserves_durable_outbox_creation():
    router, values, cursor, jobs = attempt_persist(destination_id=30)
    result = router._persist_durable_job(values)
    assert result == 501
    assert cursor.commits == 1
    assert cursor.closed
    assert len(jobs.created) == 1
    assert jobs.created[0]['destination_key'] == 'pos.config,30'
    assert jobs.created[0]['document_type'] == 'receipt'
    assert 'binding' not in jobs.created[0]
