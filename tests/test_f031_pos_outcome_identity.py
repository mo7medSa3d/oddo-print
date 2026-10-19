"""F031: POS Odoo route must retain the durable unknown-outcome evidence.

Actual Odoo routing, submit-route and outcome-decoding production methods.
Only ORM/physical Gateway/renderer boundaries are test stand-ins; installed
Odoo 19, PostgreSQL and physical delivery are NOT exercised.
"""
from types import SimpleNamespace
import pytest
from test_f010_report_binding_identity import production_methods, BRANCH, POS_CONFIG, ref

Production = production_methods('print_router.py', [
    'route_pos_receipt', 'route_pos_sale_details', '_submit_route',
    '_durable_submission_outcome', '_submission_message',
])

class SimulatedRouter(Production):
    def __init__(self, state):
        self.state = state
        self.env = SimpleNamespace(company=BRANCH)
        self.outcome_calls = []
        self.stored_job = None

    def _assert_current_company(self, company, **_kwargs):
        assert company == BRANCH

    def _validate_jpeg_base64(self, data):
        assert data == 'JPEG_DATA_FROM_POS'

    def resolve_binding(self, **kwargs):
        assert kwargs.get('document_type') == 'receipt'
        b = ref('print_gateway.binding', 91, printer_id='runtime-p1', fallback_binding_id=False)
        return {'binding': b, 'config': ref('print_gateway.gateway_config', 1),
                'destination': POS_CONFIG, 'document_type': 'receipt', 'native': False}

    def _persist_durable_job(self, values):
        assert values['idempotency_key'] == 'operation-original'
        assert values['payload']['type'] == 'image'
        self.stored_job = SimpleNamespace(
            id=332, status=self.state, gateway_job_id=False,
            last_error='UNKNOWN_PARTIAL_DELIVERY: printer may have accepted the job',
            _GATEWAY_UNKNOWN_MARKERS=('UNKNOWN_PARTIAL_DELIVERY:',),
        )
        return self.stored_job.id

    def _submit_durable_job(self, job_id, *, structured_outcome=False):
        assert job_id == 332
        self.outcome_calls.append(structured_outcome)
        if structured_outcome:
            return self._durable_submission_outcome(self.stored_job)
        return self.state

@pytest.mark.parametrize('method', ['route_pos_receipt', 'route_pos_sale_details'])
def test_pos_route_preserves_uncertain_physical_outcome_in_explicit_status(method):
    router = SimulatedRouter(state='failed')
    if method == 'route_pos_receipt':
        record = ref('pos.order', 221, company_id=BRANCH)
    else:
        record = ref('pos.session', 11, company_id=BRANCH, config_id=POS_CONFIG)
    result = getattr(router,method)(record, 'JPEG_DATA_FROM_POS', idempotency_key='operation-original')
    assert router.outcome_calls == [True], 'must decode the durable physical outcome, not just job.status'
    assert result['status'] == 'unknown'
    assert result['outcome'] == 'unknown'
    assert result['can_retry'] is False
    assert result['job_id'] == 332
    assert result['gateway_enabled'] is True

@pytest.mark.parametrize('method', ['route_pos_receipt', 'route_pos_sale_details'])
def test_pos_route_preserves_definite_failure_without_fabricating_unknown(method):
    router = SimulatedRouter(state='failed')
    result = None
    original = router._persist_durable_job
    def definite(values):
        job_id = original(values)
        router.stored_job.last_error = 'PRINTER_NOT_CONFIGURED: no dispatch occurred'
        return job_id
    router._persist_durable_job = definite
    record = ref('pos.order' if method == 'route_pos_receipt' else 'pos.session', 221,
                 company_id=BRANCH, config_id=POS_CONFIG)
    result = getattr(router,method)(record, 'JPEG_DATA_FROM_POS', idempotency_key='operation-original')
    assert router.outcome_calls == [True]
    assert result['status'] == 'failed'
    assert result['outcome'] == 'failed'
    assert result['can_retry'] is True
