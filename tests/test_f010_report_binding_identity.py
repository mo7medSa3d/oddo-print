"""F010: exercise the actual Odoo binding/router method bodies with isolated ORM.

No running Odoo/PostgreSQL is implied. Only model storage, decorators and external
records are emulated. The production decision-making methods are not substituted.
"""
import ast
import datetime
import json
import logging
import time
import uuid
import requests
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/models'

class ValidationError(Exception):
    pass

class AccessError(Exception):
    pass


def production_methods(file, names):
    path = ROOT / file
    tree = ast.parse(path.read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and any(isinstance(m, ast.FunctionDef) and m.name in names for m in n.body))
    selected = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in selected} == set(names)
    for node in selected:
        node.decorator_list = []
    expression = ast.ClassDef(name='Production', bases=[], keywords=[], body=selected, decorator_list=[])
    ns = {'ValidationError': ValidationError, 'AccessError': AccessError, '_': lambda msg: msg,
          '_assert_report_usage_access': lambda env, report: report,
          'REPORT_DOCUMENT_TYPES': {'stock.picking': 'delivery', 'pos.order': 'receipt', 'account.move': 'invoice'},
          'datetime': datetime, 'db_now_utc': lambda cr: datetime.datetime(2026, 10, 9), '_logger': logging.getLogger('test-f010'),
          'time': time, 'uuid': uuid, 'requests': requests, 'json': json}
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'MAX_INVENTORY_RESPONSE_BYTES' for target in node.targets):
            exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), ns)
    policy_path = ROOT.parent / 'runtime_policy.py'
    policy_ns = {}
    exec(compile(policy_path.read_text(), str(policy_path), 'exec'), policy_ns)
    ns['inventory_has_shared_printer'] = policy_ns['inventory_has_shared_printer']
    exec(compile(ast.fix_missing_locations(ast.Module(body=[expression], type_ignores=[])), str(path), 'exec'), ns)
    return ns['Production']


BindingProduction = production_methods('binding.py', ['destination_for', 'resolve_explicit', 'find_for', '_check_fallback_binding_scope'])
RouterProduction = production_methods('print_router.py', ['resolve_binding', 'destination_for', '_binding_scope', '_gateway_config', '_assert_current_company', '_document_type', '_submission_message', '_submit_route', 'route_report'])
JobProduction = production_methods('print_job.py', ['_primary_shared_for_fallback', '_handle_pre_dispatch_failure'])

class Ref(SimpleNamespace):
    def __bool__(self):
        return True
    def __len__(self):
        return 1
    def exists(self):
        return self
    def ensure_one(self):
        return self


def ref(model_name, pk, **kw):
    return Ref(_name=model_name, id=pk, display_name=kw.pop('display_name', f'{model_name} {pk}'), **kw)

ROOT_COMPANY = ref('res.company', 1, parent_id=False)
BRANCH = ref('res.company', 2, parent_id=ROOT_COMPANY)
OTHER_BRANCH = ref('res.company', 3, parent_id=ROOT_COMPANY)
OTHER_COMPANY = ref('res.company', 4, parent_id=False)
PICKING_TYPE = ref('stock.picking.type', 8, company_id=BRANCH)
ROOT_PICKING = ref('stock.picking.type', 9, company_id=ROOT_COMPANY)
PICKING = ref('stock.picking', 19, picking_type_id=PICKING_TYPE, company_id=BRANCH)
ROOT_PICKING_DOC = ref('stock.picking', 20, picking_type_id=ROOT_PICKING, company_id=ROOT_COMPANY)
REPORT_A = ref('ir.actions.report', 101, model='stock.picking', report_name='stock.report_a')
REPORT_B = ref('ir.actions.report', 102, model='stock.picking', report_name='stock.report_b')
POS_CONFIG = ref('pos.config', 24, company_id=BRANCH)
POS_ORDER = ref('pos.order', 25, config_id=POS_CONFIG, company_id=BRANCH)
POS_REPORT = ref('ir.actions.report', 103, model='pos.order', report_name='pos.report')


def binding(pk, report=None, destination=PICKING_TYPE, company=ROOT_COMPANY, branch=BRANCH,
            document_type='delivery', priority=10, enabled=True, printer='printer-1', protocol='spooler', fallback=False):
    b = ref('print_gateway.binding', pk, report_id=report or False, destination_report_id=False,
            destination_ref=destination, destination_type='report' if destination._name == 'ir.actions.report' else 'picking_type',
            company_id=company, branch_id=branch or False, document_type=document_type,
            priority=priority, enabled=enabled, runtime_agent_id='runtime-a', printer_id=printer,
            printer_protocol=protocol, fallback_binding_id=fallback)
    return b


class Bindings(BindingProduction):
    def __init__(self, candidates):
        self.candidates = candidates
        self.domains = []
    def sudo(self):
        return self
    def browse(self):
        return False
    def search(self, domain, order='', limit=None):
        self.domains.append(domain)
        def matches(b):
            d = {'company_id': b.company_id.id, 'branch_id': b.branch_id.id if b.branch_id else False,
                 'document_type': b.document_type, 'destination_ref': f'{b.destination_ref._name},{b.destination_ref.id}',
                 'report_id': b.report_id.id if b.report_id else False, 'enabled': b.enabled}
            for field, op, value in domain:
                if op == '=' and d.get(field) != value: return False
                if op == 'in' and d.get(field) not in value: return False
                if op == '!=' and d.get(field) == value: return False
            return True
        found = [b for b in self.candidates if matches(b)]
        found.sort(key=lambda x: (x.priority, x.id))
        return found[0] if found else False
    def resolve_explicit(self, *args, **kwargs):
        return BindingProduction.resolve_explicit(self, *args, **kwargs)

class ConfigModel:
    def sudo(self): return self
    def search(self, *args, **kwargs): return ref('print_gateway.gateway_config', 1, enabled=True)

class Env:
    context = {}
    def __init__(self, company, bindings): self.company = company; self.bindings = bindings
    def __getitem__(self, name):
        if name == 'print_gateway.binding': return self.bindings
        if name == 'print_gateway.gateway_config': return ConfigModel()
        raise AssertionError(name)

class Router(RouterProduction):
    def __init__(self, company, bindings): self.env = Env(company, bindings)
    def _assert_branch_agent_assignment(self, *args): return True


def test_same_operation_two_reports_never_cross_select():
    a, b = binding(11, REPORT_A), binding(12, REPORT_B)
    model = Bindings([a,b])
    assert model.find_for(ROOT_COMPANY, 'delivery', REPORT_B, PICKING, branch=BRANCH) is b
    assert model.find_for(ROOT_COMPANY, 'delivery', REPORT_A, PICKING, branch=BRANCH) is a
    assert model.find_for(ROOT_COMPANY, 'delivery', ref('ir.actions.report', 444), PICKING, branch=BRANCH) is False


def test_report_action_destination_is_reachable_even_with_document_record():
    b = binding(13, REPORT_B, destination=REPORT_B)
    model = Bindings([b])
    assert model.find_for(ROOT_COMPANY, 'delivery', REPORT_B, PICKING, branch=BRANCH) is b
    route = Router(BRANCH, model).resolve_binding(report=REPORT_B, record=PICKING, payload_type='pdf')
    assert route['binding'] is b
    assert route['destination'] is REPORT_B


def test_report_action_not_confused_with_native_pos_receipt():
    receipt = binding(14, destination=POS_CONFIG, report=None, document_type='receipt')
    report = binding(15, destination=POS_REPORT, report=POS_REPORT, document_type='receipt')
    model = Bindings([receipt, report])
    assert model.find_for(ROOT_COMPANY, 'receipt', report=POS_REPORT, record=POS_ORDER, branch=BRANCH) is report
    assert model.find_for(ROOT_COMPANY, 'receipt', record=POS_ORDER, branch=BRANCH) is receipt
    assert Router(BRANCH, model).resolve_binding(report=POS_REPORT, record=POS_ORDER)['binding'] is report


def test_explicit_selection_rejects_other_report_and_other_destination():
    b = binding(21, REPORT_A, destination=REPORT_A)
    model = Bindings([b]); router = Router(BRANCH, model)
    assert router.resolve_binding(report=REPORT_A, record=PICKING, explicit_binding=b)['binding'] is b
    with pytest.raises(ValidationError, match='report'):
        router.resolve_binding(report=REPORT_B, record=PICKING, explicit_binding=b)
    with pytest.raises(ValidationError):
        router.resolve_binding(report=REPORT_A, record=ref('pos.order', 25, config_id=POS_CONFIG, company_id=BRANCH), explicit_binding=b,
                               document_type='receipt')


def test_branch_first_then_global_report_root_fallback():
    root = binding(30, REPORT_A, destination=REPORT_A, branch=False, priority=1)
    branch = binding(31, REPORT_A, destination=REPORT_A, branch=BRANCH, priority=99)
    model = Bindings([root, branch])
    assert model.find_for(ROOT_COMPANY, 'delivery', REPORT_A, PICKING, branch=BRANCH) is branch
    assert Bindings([root]).find_for(ROOT_COMPANY, 'delivery', REPORT_A, PICKING, branch=BRANCH) is root
    assert Bindings([root]).find_for(ROOT_COMPANY, 'delivery', REPORT_B, PICKING, branch=BRANCH) is False


def test_branch_owned_operational_destination_does_not_fall_back_to_root():
    root = binding(40, REPORT_B, destination=PICKING_TYPE, branch=False)
    model = Bindings([root]); router = Router(BRANCH, model)
    assert model.find_for(ROOT_COMPANY, 'delivery', REPORT_B, PICKING, branch=BRANCH) is False
    with pytest.raises(ValidationError, match='no Print Binding'):
        router.resolve_binding(report=REPORT_B, record=PICKING)


def test_record_outside_active_company_rejected_before_binding_access():
    other = ref('stock.picking', 50, company_id=OTHER_COMPANY, picking_type_id=PICKING_TYPE)
    model = Bindings([binding(50, REPORT_A)])
    with pytest.raises(ValidationError):
        Router(BRANCH, model).resolve_binding(report=REPORT_A, record=other)
    assert not model.domains


def test_missing_report_is_not_routed_via_report_bound_operation_binding():
    b = binding(60, REPORT_A)
    assert Bindings([b]).find_for(ROOT_COMPANY, 'delivery', record=PICKING, branch=BRANCH) is False


def test_fallback_scope_rejects_other_report_even_if_destination_matches():
    backup = binding(70, REPORT_B, printer='backup')
    primary = binding(71, REPORT_A, fallback=backup)
    with pytest.raises(ValidationError, match='report'):
        BindingProduction._check_fallback_binding_scope([primary])


def test_explicit_binding_must_be_enabled_and_correct_scope():
    b = binding(81, REPORT_A, enabled=False)
    with pytest.raises(ValidationError):
        Router(BRANCH, Bindings([b])).resolve_binding(report=REPORT_A, record=PICKING, explicit_binding=b)
    foreign = binding(82, REPORT_A, company=OTHER_COMPANY)
    with pytest.raises(ValidationError):
        Router(BRANCH, Bindings([foreign])).resolve_binding(report=REPORT_A, record=PICKING, explicit_binding=foreign)


class MockOutbox(Ref):
    def write(self, values):
        self.last_written = values
    def _post_source_audit(self, message):
        self.last_audit = message


class InventoryResponse(requests.Response):
    """Observe external response reads/closure with Requests' real context manager."""
    def __init__(self, body, *, status=200, stream_error=None):
        super().__init__()
        self.status_code = status
        self.body = body
        self.stream_error = stream_error
        self.closed = False
        self.iter_calls = 0
        self.read_bytes = 0

    def iter_content(self, chunk_size):
        self.iter_calls += 1
        assert chunk_size == 64 * 1024
        for offset in range(0, len(self.body), chunk_size):
            chunk = self.body[offset:offset + chunk_size]
            self.read_bytes += len(chunk)
            yield chunk
            if self.stream_error:
                raise self.stream_error

    def close(self):
        self.closed = True


def failover_job(*, destination_key, report=REPORT_A, destination_name=None):
    config = SimpleNamespace(_gateway_base=lambda **kw: 'https://gateway.invalid', _gateway_headers=lambda: {'Authorization': 'Bearer fixture'})
    config.sudo = lambda: config
    return MockOutbox(id=500, attempts=0, company_id=BRANCH,
                      destination_key=destination_key, destination=destination_name or PICKING_TYPE.display_name,
                      document_type='delivery', report_id=report, payload_type='pdf', protocol=False,
                      printer_id='primary', idempotency_key='example-operation-key', gateway_config_id=config, env=SimpleNamespace(cr=object()))


@pytest.mark.parametrize('key, report, name, should_switch', [
    ('stock.picking.type,8', REPORT_A, 'renamed destination', True),
    ('stock.picking.type,777', REPORT_A, PICKING_TYPE.display_name, False),
    (False, REPORT_A, PICKING_TYPE.display_name, False),
    ('stock.picking.type,8', REPORT_B, PICKING_TYPE.display_name, False),
])
def test_live_pre_dispatch_fallback_requires_durable_identity(key, report, name, should_switch, monkeypatch):
    monkeypatch.setattr(requests, 'get', lambda *args, **kwargs: InventoryResponse(json.dumps({
        'printers': [{'id': 'primary', 'lifecycle': 'active', 'agent': {'id': 'owner'}}],
    }).encode()))
    job = failover_job(destination_key=key, report=report, destination_name=name)
    candidate = binding(90, REPORT_A, printer='backup')
    service = JobProduction()
    service.env = SimpleNamespace(cr=object())
    result = service._handle_pre_dispatch_failure(job, ConnectionError('no bytes delivered'), candidate, {'primary'}, 0, False)
    assert (result[2] == 'continue') is should_switch
    if should_switch:
        assert job.last_written['printer_id'] == 'backup'
    else:
        assert 'printer_id' not in job.last_written


@pytest.mark.parametrize('permission', ['legacy_shared', 'shared', 'private', 'missing', 'unavailable'])
def test_actual_pre_dispatch_fallback_rechecks_primary_sharing(permission, monkeypatch):
    calls = []
    responses = []
    def inventory(url, **kwargs):
        calls.append((url, kwargs))
        if permission == 'unavailable':
            raise requests.ConnectionError('inventory unavailable')
        rows = [] if permission == 'missing' else [{
            'id': 'primary', 'lifecycle': 'active', 'agent': {'id': 'owner'},
            **({'sharedWithGateway': permission == 'shared'} if permission != 'legacy_shared' else {}),
        }]
        response = InventoryResponse(json.dumps({'printers': rows}).encode())
        responses.append(response)
        return response
    monkeypatch.setattr(requests, 'get', inventory)
    job = failover_job(destination_key='stock.picking.type,8')
    candidate = binding(90, REPORT_A, printer='backup')
    service = JobProduction()
    service.env = SimpleNamespace(cr=object())
    result = service._handle_pre_dispatch_failure(job, ConnectionError('zero bytes'), candidate, {'primary'}, 0, False)
    allowed = permission in ('legacy_shared', 'shared')
    assert (result[2] == 'continue') is allowed
    assert calls == [('https://gateway.invalid/api/odoo/printers', {
        'headers': {'Authorization': 'Bearer fixture'}, 'timeout': 5, 'allow_redirects': False, 'stream': True,
    })]
    assert all(response.closed for response in responses)
    if allowed:
        assert job.last_written['printer_id'] == 'backup'
    else:
        assert job.printer_id == 'primary'
        assert 'printer_id' not in job.last_written
        assert job.last_written['status'] == 'queued'


@pytest.mark.parametrize('response_case', [
    'non_200', 'oversized', 'truncated_json', 'malformed_json', 'invalid_utf8',
    'stream_failure', 'exact_bound_shared',
])
def test_actual_primary_sharing_http_read_is_bounded_and_closed(response_case, monkeypatch):
    limit = JobProduction._primary_shared_for_fallback.__globals__['MAX_INVENTORY_RESPONSE_BYTES']
    valid = json.dumps({'printers': [{
        'id': 'primary', 'lifecycle': 'active', 'sharedWithGateway': True, 'agent': {'id': 'owner'},
    }]}).encode()
    body = valid
    status = 503 if response_case == 'non_200' else 200
    stream_error = None
    if response_case in ('oversized', 'exact_bound_shared'):
        body = valid + b' ' * (limit - len(valid) + (response_case == 'oversized'))
    elif response_case == 'truncated_json':
        body = valid[:-2]
    elif response_case == 'malformed_json':
        body = b'{invalid json}'
    elif response_case == 'invalid_utf8':
        body = b'\xff'
    elif response_case == 'stream_failure':
        stream_error = requests.exceptions.ChunkedEncodingError('truncated stream')
    response = InventoryResponse(body, status=status, stream_error=stream_error)
    calls = []
    def inventory(url, **kwargs):
        calls.append((url, kwargs))
        return response
    monkeypatch.setattr(requests, 'get', inventory)
    job = failover_job(destination_key='stock.picking.type,8')
    service = JobProduction()
    service.env = SimpleNamespace(cr=object())
    result = service._handle_pre_dispatch_failure(job, ConnectionError('zero bytes'), binding(90, REPORT_A, printer='backup'), {'primary'}, 0, False)
    allowed = response_case == 'exact_bound_shared'
    assert (result[2] == 'continue') is allowed
    assert response.closed
    assert response.iter_calls == (0 if response_case == 'non_200' else 1)
    assert response.read_bytes <= limit + 64 * 1024
    assert calls == [('https://gateway.invalid/api/odoo/printers', {
        'headers': {'Authorization': 'Bearer fixture'}, 'timeout': 5, 'allow_redirects': False, 'stream': True,
    })]
    if allowed:
        assert job.last_written['printer_id'] == 'backup'
    else:
        assert job.printer_id == 'primary'
        assert 'printer_id' not in job.last_written
        assert job.last_written['status'] == 'queued'


def test_actual_submit_route_persists_selected_report_destination_identity():
    b = binding(95, REPORT_B, destination=REPORT_B)
    router = Router(BRANCH, Bindings([b]))
    router._assert_current_company = lambda *args, **kw: BRANCH
    captured = []
    router._persist_durable_job = lambda values: captured.append(values) or 501
    router._submit_durable_job = lambda job_id, **kwargs: 'submitted'
    route = router.resolve_binding(report=REPORT_B, record=PICKING)
    result = router._submit_route(route=route, payload={'type': 'pdf', 'data': 'masked', 'encoding': 'base64'},
                                  company=BRANCH, report=REPORT_B, source_model='stock.picking', source_record_id=PICKING.id,
                                  idempotency_key='idempotent-report-b')
    assert result['status'] == 'submitted'
    assert captured[0]['destination'] == REPORT_B.display_name
    assert captured[0]['destination_key'] == 'ir.actions.report,102'
    assert captured[0]['report'] is REPORT_B
    assert captured[0]['idempotency_key'] == 'idempotent-report-b'


class RecordSet(list):
    def exists(self): return self


def test_unbound_report_preserves_native_even_when_record_exists():
    router = Router(BRANCH, Bindings([binding(101, REPORT_A)]))
    assert router.route_report(REPORT_B, RecordSet([PICKING]), data={'ids': [19]})['native'] is True


def test_unbound_empty_report_preserves_native_with_gateway_enabled():
    router = Router(BRANCH, Bindings([]))
    assert router.route_report(REPORT_B, RecordSet(), data={'ids': []})['native'] is True


def test_bound_empty_report_does_not_submit_invalid_job():
    router = Router(BRANCH, Bindings([binding(102, REPORT_B, destination=REPORT_B)]))
    with pytest.raises(ValidationError, match='at least one report record'):
        router.route_report(REPORT_B, RecordSet(), data={'ids': []})
