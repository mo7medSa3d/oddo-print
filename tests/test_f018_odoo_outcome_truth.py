"""F018/O5: run actual Odoo production methods; replace only ORM/network/UI edges.

Not an installed Odoo 19/PostgreSQL/browser/physical printer test.
"""
from types import SimpleNamespace
import pytest

from test_f010_report_binding_identity import (
    production_methods, Router, Bindings, binding, ref, BRANCH, ROOT_COMPANY,
    PICKING_TYPE,
)
from test_f016_raw_label_binding import RoutedPrinter
from test_report_outcome_regression import report_hook


@pytest.mark.parametrize('status, required', [
    ('queued', 'queued'), ('submitted', 'gateway'), ('claimed', 'agent'),
    ('printing', 'processing'), ('success', 'completed'), ('failed', 'failed'),
    ('unknown', 'unknown'), ('partial', 'unknown'), ('unexpected', 'unknown'),
])
def test_actual_route_producer_does_not_mislabel_job_outcome(status, required):
    selected = binding(704)
    router = Router(BRANCH, Bindings([selected]))
    router._persist_durable_job = lambda _: 842
    router._submit_durable_job = lambda _job, **_kwargs: status
    route = {'binding': selected, 'config': ref('print_gateway.gateway_config', 1),
             'destination': PICKING_TYPE, 'document_type': 'delivery'}
    result = router._submit_route(route=route, payload={'type': 'pdf'}, company=BRANCH)
    assert result['status'] == status
    assert required in result['message'].lower()
    if status in ('queued', 'unknown', 'failed', 'partial', 'unexpected'):
        assert 'accepted by the gateway' not in result['message'].lower()


@pytest.mark.parametrize('status, expected', [
    ('queued', 'queued'), ('failed', 'failed'), ('unknown', 'unknown'),
    ('partial', 'unknown'), ('success', 'completed'),
])
def test_actual_raw_command_producer_reports_real_status(status, expected):
    target = binding(710, destination=PICKING_TYPE, report=None,
                     document_type='label', protocol='zpl')
    router = RoutedPrinter(BRANCH, Bindings([target]))
    router._persist_durable_job = lambda _: 843
    router._submit_durable_job = lambda _id, **_kw: status
    result = router.route_raw_command('^XA^XZ', protocol='zpl', binding=target,
                                      company=BRANCH, document_type='label')
    assert result['status'] == status
    assert expected in result['message'].lower()


@pytest.mark.parametrize('status, type_expected', [
    ('queued', 'warning'), ('submitted', 'info'), ('claimed', 'info'),
    ('printing', 'info'), ('success', 'info'), ('failed', 'danger'),
    ('unknown', 'warning'), ('partial', 'warning'), (None, 'warning'),
])
def test_actual_test_page_button_never_fabricates_success(status, type_expected):
    production = production_methods('binding.py', ['action_send_test_print'])
    router = SimpleNamespace(route_test_page=lambda _: {'status': status, 'message': 'test outcome'})
    class Environment:
        user = SimpleNamespace(has_group=lambda _: True)
        def __getitem__(self, name):
            assert name == 'print_gateway.print_router'
            return router
    record = SimpleNamespace(
        env=Environment(), printer_id='printer-1', ensure_one=lambda: None,
        _validate_runtime_target=lambda **_kw: {'protocol': 'spooler'},
        _validate_binding_protocol_against_runtime=lambda _printer: None,
    )
    result = production.action_send_test_print(record)['params']
    assert result['type'] == type_expected
    assert result['sticky'] is (type_expected in ('warning', 'danger'))


@pytest.mark.parametrize('status, expected_success', [
    ('queued', False), ('submitted', True), ('claimed', True),
    ('printing', True), ('success', True), ('failed', False),
    ('unknown', False), ('partial', False), (None, False),
])
def test_actual_rpc_report_dispatch_preserves_binding_and_status(status, expected_success):
    production = production_methods('binding.py', ['dispatch_report_action'])
    record = ref('account.move', 38)
    class Records(list):
        def exists(self): return self
        def check_access(self, access): assert access == 'read'
    report = ref('ir.actions.report', 207, model='account.move')
    target = binding(64)
    result = {'native': False, 'status': status, 'job_id': 990,
              'message': 'fixture message'}
    router = SimpleNamespace(
        _gateway_config=lambda _company: True,
        _binding_scope=lambda _company: (ROOT_COMPANY, BRANCH),
        _document_type=lambda **_kwargs: 'invoice',
        route_report=lambda *_args, **_kw: result,
    )
    class Reports:
        def browse(self, pk): assert pk == report.id; return report
    class RecordModel:
        def browse(self, ids): assert ids == [38]; return Records([record])
    class Environment:
        context = {}
        company = BRANCH
        def __getitem__(self, name):
            return {'ir.actions.report': Reports(), 'account.move': RecordModel(),
                    'print_gateway.print_router': router}[name]
    context = Environment()
    binding_model = SimpleNamespace(
        env=context,
        with_context=lambda **_context: binding_model,
        find_for=lambda *_args, **_kw: target,
    )
    got = production.dispatch_report_action(binding_model, report_id=207, res_ids=[38])
    assert got['has_binding'] is True
    assert got['dispatched'] is True, 'Durable outbox exists even when Gateway result is uncertain'
    assert got['status'] == (status or 'unknown')
    assert got['success'] is expected_success


@pytest.mark.parametrize('status, expected_type', [
    ('queued', 'warning'), ('submitted', 'info'), ('claimed', 'info'),
    ('printing', 'info'), ('success', 'info'), ('failed', 'danger'),
    ('unknown', 'warning'), ('partial', 'warning'), (None, 'warning'),
])
def test_actual_odoo_backend_report_action_truthful(status, expected_type):
    report, records = report_hook({'native': False, 'status': status, 'message': 'fixture message'})
    notification = report.report_action(records)['params']
    assert notification['type'] == expected_type
    assert notification['sticky'] is (expected_type in ('danger', 'warning'))
