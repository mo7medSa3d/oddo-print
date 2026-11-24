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
    '_durable_submission_outcome', '_submission_message', '_receipt_image_payload',
])

class SimulatedRouter(Production):
    def __init__(self, state):
        self.state = state
        self.env = SimpleNamespace(company=BRANCH)
        self.outcome_calls = []
        self.stored_job = None

    def _assert_current_company(self, company, **_kwargs):
        assert company == BRANCH

    def _receipt_geometry_for_route(self, route):
        return {"config_fingerprint": "a" * 64}

    def _replay_receipt_operation(self, *_args):
        return None

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
            physical_outcome='unknown',
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
    result = getattr(router,method)(record, 'JPEG_DATA_FROM_POS', idempotency_key='operation-original', geometry_fingerprint='a' * 64)
    assert router.outcome_calls == [True], 'must decode the durable physical outcome, not just job.status'
    assert result['status'] == 'unknown'
    assert result['outcome'] == 'unknown'
    assert result['can_retry'] is False
    assert result['job_id'] == 332
    assert result['gateway_enabled'] is True

@pytest.mark.parametrize('method', ['route_pos_receipt', 'route_pos_sale_details'])
def test_implicit_pos_receipt_identity_survives_unrelated_record_writes(method):
    """Changing write_date after a sale cannot mint an accidental second ticket.

    The caller must supply a NEW explicit operation ID to deliberately print
    an updated receipt. No-key retries retain the exact original identity
    and the durable outbox rejects changed payload under the same key.
    """
    router = SimulatedRouter(state='queued')
    submitted_keys = []

    def capture_submit(**values):
        submitted_keys.append(values['idempotency_key'])
        return {'status': 'queued'}

    router._submit_route = capture_submit
    record = ref('pos.order' if method == 'route_pos_receipt' else 'pos.session', 221,
                 company_id=BRANCH, config_id=POS_CONFIG, write_date='2026-10-28 00:00:00')
    router_route = getattr(router, method)
    router_route(record, 'JPEG_DATA_FROM_POS', geometry_fingerprint='a' * 64)
    record.write_date = '2026-10-28 00:01:00'
    router_route(record, 'JPEG_DATA_FROM_POS', geometry_fingerprint='a' * 64)

    assert len(submitted_keys) == 2
    assert submitted_keys[0] == submitted_keys[1], 'Record update must not silently create a second physical print operation'
    assert len(submitted_keys[0]) == 64


@pytest.mark.parametrize('method', ['route_pos_receipt', 'route_pos_sale_details'])
def test_pos_route_preserves_definite_failure_without_fabricating_unknown(method):
    router = SimulatedRouter(state='failed')
    result = None
    original = router._persist_durable_job
    def definite(values):
        job_id = original(values)
        router.stored_job.last_error = 'GATEWAY_REJECTED_422: no dispatch occurred'
        router.stored_job.physical_outcome = 'not_printed'
        return job_id
    router._persist_durable_job = definite
    record = ref('pos.order' if method == 'route_pos_receipt' else 'pos.session', 221,
                 company_id=BRANCH, config_id=POS_CONFIG)
    result = getattr(router,method)(record, 'JPEG_DATA_FROM_POS', idempotency_key='operation-original', geometry_fingerprint='a' * 64)
    assert router.outcome_calls == [True]
    assert result['status'] == 'failed'
    assert result['outcome'] == 'failed'
    assert result['can_retry'] is True
