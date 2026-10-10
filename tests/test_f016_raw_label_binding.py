"""F016/O4: actual Odoo binding constraint + raw policy routing decisions.

These are isolated method-body checks, NOT tests in an installed Odoo 19 ORM,
PostgreSQL, browser form, Gateway, Windows or physical-printer environment.
Production method ASTs are executed unchanged; only ORM/external edges are stubs.
"""
import base64
import ast
import hashlib
import uuid
from types import SimpleNamespace
from xml.etree import ElementTree as ET
from pathlib import Path

import pytest

from test_f010_report_binding_identity import (
    production_methods, ValidationError, binding, Bindings, Router,
    ROOT_COMPANY, BRANCH, OTHER_BRANCH, PICKING_TYPE, PICKING, REPORT_A, ROOT,
)

BindingModel = production_methods('binding.py', [
    '_compute_document_type', '_compute_destination_ref', '_check_binding',
    '_check_company_hierarchy', '_check_fallback_binding_scope',
])
BindingModel._compute_document_type.__globals__['DOCUMENT_TYPE_BY_MODEL'] = {
    'stock.picking': 'delivery', 'account.move': 'invoice', 'pos.order': 'receipt',
}
# production_methods extracts individual methods from the actual class. Load
# the module-level admission helper from its production AST as well, rather
# than substituting a permissive test implementation for that safety guard.
router_path = ROOT / 'print_router.py'
router_tree = ast.parse(router_path.read_text(encoding='utf-8'))
raw_helper_node = next(node for node in router_tree.body
                       if isinstance(node, ast.FunctionDef) and node.name == '_validated_raw_command_bytes')
raw_helper_namespace = {'ValidationError': ValidationError, '_': lambda value: value,
                        'MAX_IMAGE_BYTES': 5 * 1024 * 1024}
exec(compile(ast.fix_missing_locations(ast.Module(body=[raw_helper_node], type_ignores=[])),
             str(router_path), 'exec'), raw_helper_namespace)
validated_raw_command_bytes = raw_helper_namespace['_validated_raw_command_bytes']
RouterRaw = production_methods('print_router.py', ['route_raw_command', 'route_intent'])
for method_name in ('route_raw_command', 'route_intent'):
    getattr(RouterRaw, method_name).__globals__.update({
        'base64': base64, 'hashlib': hashlib, 'uuid': uuid,
        'ValidationError': ValidationError, '_': lambda value: value,
        '_validated_raw_command_bytes': validated_raw_command_bytes,
    })


class RoutedPrinter(RouterRaw, Router):
    pass


def model_record(*, dtype='picking_type', report=False, protocol='zpl',
                 destination=PICKING_TYPE, branch=BRANCH, company=ROOT_COMPANY):
    return SimpleNamespace(
        destination_type=dtype,
        destination_ref=destination,
        destination_pos_config_id=False,
        destination_pos_printer_id=False,
        destination_picking_type_id=destination if dtype == 'picking_type' else False,
        destination_report_id=False,
        report_id=report,
        document_type=False,
        company_id=company,
        branch_id=branch,
        effective_company_id=branch or company,
        printer_id='printer-a',
        printer_protocol=protocol,
    )


@pytest.mark.parametrize('language', ('zpl', 'tspl', 'escpos', 'raw'))
def test_picking_type_without_report_is_a_valid_language_declared_label(language):
    record = model_record(protocol=language)
    BindingModel._compute_document_type([record])
    assert record.document_type == 'label'
    BindingModel._check_company_hierarchy([record])
    BindingModel._check_binding([record])


def test_picking_type_report_route_stays_a_pdf_report_with_same_identity():
    record = model_record(report=REPORT_A, protocol='spooler')
    BindingModel._compute_document_type([record])
    assert record.document_type == 'delivery'
    BindingModel._check_binding([record])


def test_legacy_report_destination_cannot_accidentally_form_raw_label_without_report():
    record = model_record()
    record.destination_report_id = REPORT_A
    with pytest.raises(ValidationError, match='raw label.*Report'):
        BindingModel._check_binding([record])


def test_report_destination_still_requires_a_real_report():
    record = model_record(dtype='report', destination=REPORT_A, report=False, protocol='spooler')
    with pytest.raises(ValidationError, match='Report'):
        BindingModel._check_binding([record])


@pytest.mark.parametrize('protocol', ('spooler', 'ipp', 'ipps', 'unknown'))
def test_no_report_label_cannot_target_pdf_transport_or_unknown_language(protocol):
    record = model_record(protocol=protocol)
    with pytest.raises(ValidationError, match='protocol|raw|label|language|printer'):
        BindingModel._check_binding([record])


def test_raw_label_respects_exact_branch_company_and_document_type():
    label = binding(701, destination=PICKING_TYPE, report=None,
                    document_type='label', protocol='zpl')
    report = binding(702, REPORT_A, destination=PICKING_TYPE,
                     document_type='delivery', protocol='spooler')
    labels = Bindings([label, report])
    assert labels.find_for(ROOT_COMPANY, 'label', record=PICKING, branch=BRANCH) is label
    assert labels.find_for(ROOT_COMPANY, 'delivery', report=REPORT_A, record=PICKING, branch=BRANCH) is report
    with pytest.raises(ValidationError, match='another Odoo company'):
        labels.find_for(ROOT_COMPANY, 'label', record=PICKING, branch=OTHER_BRANCH)
    assert labels.find_for(ROOT_COMPANY, 'label', report=REPORT_A, record=PICKING, branch=BRANCH) is False


def test_actual_raw_policy_reaches_durable_job_with_exact_binding_and_identity():
    label = binding(710, destination=PICKING_TYPE, report=None,
                    document_type='label', protocol='zpl')
    router = RoutedPrinter(BRANCH, Bindings([label]))
    jobs = []
    router._persist_durable_job = lambda values: jobs.append(values) or 911
    router._submit_durable_job = lambda pk: 'queued'
    policy = SimpleNamespace(
        action_type='raw_template', raw_protocol='zpl', binding_id=False,
        name='Shipping label', render_raw_template=lambda record, protocol: '^XA^FO10,10^FDTEST^FS^XZ',
    )
    result = router.route_intent(SimpleNamespace(policy_id=policy, intent_key='raw-intent-1'), PICKING)
    assert result['job_id'] == 911 and result['status'] == 'dispatched'
    assert len(jobs) == 1
    persisted = jobs[0]
    assert persisted['destination_key'] == f'{PICKING_TYPE._name},{PICKING_TYPE.id}'
    assert persisted['printer_id'] == 'printer-1'
    assert persisted['document_type'] == 'label'
    assert persisted['protocol'] == 'zpl'
    assert persisted['idempotency_key'] == 'raw-intent-1'
    assert persisted['payload']['type'] == 'raw'
    assert base64.b64decode(persisted['payload']['data']) == b'^XA^FO10,10^FDTEST^FS^XZ'


def test_form_only_requires_report_for_report_destination_and_reveals_label_help():
    path = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/views/binding_views.xml'
    xml = ET.parse(path).getroot()
    fields = xml.findall('.//record[@id="view_print_gateway_binding_form"]//field[@name="report_id"]')
    assert len(fields) == 1
    required = fields[0].attrib['required']
    invisible = fields[0].attrib['invisible']
    for dtype in ('pos', 'pos_printer', 'picking_type', 'report'):
        actual_required = bool(eval(required, {'__builtins__': {}}, {'destination_type': dtype}))
        assert actual_required is (dtype == 'report'), dtype
        actual_invisible = bool(eval(invisible, {'__builtins__': {}}, {'destination_type': dtype}))
        assert actual_invisible is (dtype in ('pos', 'pos_printer')), dtype
    assert 'ZPL' in ET.tostring(xml, encoding='unicode')
