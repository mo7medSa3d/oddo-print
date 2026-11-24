"""Offline executable Odoo policy safety regressions without an Odoo installation.

Compile the actual implementation's restricted methods from the addon AST;
exercise them with small record fixtures and inspect the transaction boundary.
"""
import ast
import copy
import datetime
import logging
import tracemalloc
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import pytest

BASE = Path(__file__).resolve().parents[1] / 'odoo_addons19' / 'print_gateway' / 'models'


class ValidationError(Exception):
    pass


def _class_methods(file, cls_name, method_names, extra=None):
    source = ast.parse((BASE / file).read_text(encoding='utf-8'))
    klass = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == cls_name)
    methods = []
    for method in klass.body:
        if isinstance(method, ast.FunctionDef) and method.name in method_names:
            method = copy.deepcopy(method)
            method.decorator_list = []
            methods.append(method)
    assert len(methods) == len(method_names), method_names
    extracted = ast.Module(body=[ast.ClassDef(name='Target', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(extracted)
    namespace = {'ValidationError': ValidationError, '_': lambda v: v, '_logger': logging.getLogger(__name__)}
    if file in ("runtime_assignment.py", "binding.py"):
        # The production constraint delegates to the actual shared exact-ID
        # policy. Keep this AST test coupled to that real dependency.
        path = BASE.parent / "runtime_policy.py"
        policy = {}
        exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), policy)
        namespace["is_exact_gateway_printer_id"] = policy.get("is_exact_printer_key", policy.get("is_exact_gateway_printer_id"))
        namespace["is_exact_gateway_agent_id"] = policy.get("is_exact_agent_uid", policy.get("is_exact_gateway_agent_id"))
        namespace["is_exact_printer_key"] = policy.get("is_exact_printer_key")
        namespace["is_exact_agent_uid"] = policy.get("is_exact_agent_uid")
    namespace.update(extra or {})
    exec(compile(extracted, str(BASE/file), 'exec'), namespace)
    return namespace['Target']


class _PolicyRecords(list):
    VALID_MODEL_EVENTS = {'account.move': {'invoice_posted'}}


def _report_policy(binding_report_id):
    policy_type = _class_methods(
        'print_policy.py', 'PrintGatewayPolicy', {'_check_action_configuration'},
    )
    expected = SimpleNamespace(id=31, model='account.move', display_name='Invoice PDF')
    actual = SimpleNamespace(id=binding_report_id, model='account.move', display_name='Other PDF')
    return policy_type, SimpleNamespace(
        model_name='account.move', event_type='invoice_posted', action_type='report',
        report_id=expected, raw_template=False, domain_filter=False,
        binding_id=SimpleNamespace(report_id=expected if binding_report_id == 31 else actual,
                                   display_name='Invoice printer rule'),
    )


def test_failed_intent_retry_backoff_never_builds_unbounded_exponent():
    """Untrusted legacy attempt counters must not force 2**huge integer work.

    The exponential delay has a strict 300s ceiling. Clamp the exponent
    *before* computing it, not merely the final delay.
    """
    source = (BASE / "print_intent.py").read_text(encoding="utf-8")
    assert "2 ** min(max(0, attempts - 1), 5)" in source
    now = datetime.datetime(2026, 10, 28)
    model = _class_methods(
        "print_intent.py", "PrintGatewayIntent", {"_finalize_route_failure"},
        {"datetime": datetime, "db_now_utc": lambda _cr: now},
    )
    for attempts, expected_seconds in [
        (1, 15), (2, 30), (5, 240), (6, 300), (1_000_000, 300),
    ]:
        recorded = []
        class Cursor:
            closed = False
            committed = False
            def execute(self, _statement, _params):
                pass
            def fetchone(self):
                return (attempts, attempts + 1)
            def commit(self):
                self.committed = True
            def close(self):
                self.closed = True
        cursor = Cursor()
        env = SimpleNamespace(registry=SimpleNamespace(cursor=lambda: cursor))
        def finalize(_cls, _env, intent_id, token, **values):
            assert intent_id == 71 and token == "original-lease"
            recorded.append(values)
            return True
        model._finalize_intent_state = classmethod(finalize)
        assert model._finalize_route_failure(
            model, env, 71, "original-lease", RuntimeError("routing unavailable")
        )
        assert len(recorded) == 1
        assert recorded[0]["status"] == "pending"
        assert (recorded[0]["next_retry_at"] - now).total_seconds() == expected_seconds
        assert cursor.committed and cursor.closed


def test_report_policy_rejects_another_report_on_the_same_model_before_dispatch():
    policy_type, policy = _report_policy(32)
    with pytest.raises(ValidationError) as error:
        policy_type._check_action_configuration(_PolicyRecords([policy]))
    assert 'Invoice printer rule' in str(error.value)
    assert 'Invoice PDF' in str(error.value)


def test_report_policy_keeps_matching_explicit_and_automatic_targets():
    policy_type, policy = _report_policy(31)
    policy_type._check_action_configuration(_PolicyRecords([policy]))
    policy.binding_id = False
    policy_type._check_action_configuration(_PolicyRecords([policy]))


def test_automation_form_filters_report_rules_without_widening_company_scope():
    view = ET.parse(BASE.parent / 'views/print_policy_views.xml')
    expression = view.find(".//field[@name='binding_id'][@domain]").attrib['domain']
    scope = {'company_id': 1, 'branch_id': 2, 'report_id': 31, 'action_type': 'report'}
    domain = eval(expression, {'__builtins__': {}}, scope)
    assert ('report_id', '=', 31) in domain
    assert ('company_id', '=', 1) in domain
    assert ('branch_id', '=', 2) in domain
    assert ('branch_id', '=', False) in domain
    scope['action_type'] = 'raw_template'
    assert ('report_id', '=', 31) not in eval(expression, {'__builtins__': {}}, scope)


def test_pending_retry_does_not_claim_to_be_waiting_for_business_commit():
    view = ET.parse(BASE.parent / 'views/print_intent_views.xml')
    commit, retry = [node for node in view.iter('div') if 'attempts' in node.attrib.get('invisible', '')]
    for attempts, visible in [(0, commit), (2, retry)]:
        context = {'status': 'pending', 'attempts': attempts}
        for node in (commit, retry):
            assert (not eval(node.attrib['invisible'], {'__builtins__': {}}, context)) == (node is visible)


def test_branch_only_context_can_validate_its_binding_without_activating_parent():
    binding_type = _class_methods('binding.py', 'PrintGatewayBinding', {'_check_runtime_scope'})
    root = SimpleNamespace(id=1)
    branch = SimpleNamespace(id=2, parent_id=root)
    assignment = SimpleNamespace(is_agent_assigned=lambda *args: True)
    class ScopeEnv(dict):
        companies = [branch]
    agent = SimpleNamespace(id=10, active=True, company_id=root, agent_uid='agt_branch01', display_name='Branch Agent')
    records = _PolicyRecords([SimpleNamespace(company_id=root, branch_id=branch, agent_id=agent,
                                              runtime_agent_id='agt_branch01')])
    records.env = ScopeEnv({'print_gateway.runtime_agent_assignment': assignment})
    binding_type._check_runtime_scope(records)


def test_branch_only_administrator_can_validate_its_runtime_assignment():
    assignment_type = _class_methods('runtime_assignment.py', 'PrintGatewayRuntimeAgentAssignment', {'_check_assignment'})
    root = SimpleNamespace(id=1, parent_id=False)
    branch = SimpleNamespace(id=2, parent_id=root)
    agent = SimpleNamespace(id=10, active=True, company_id=root, agent_uid='agt_branch01', display_name='Branch Agent')
    records = _PolicyRecords([SimpleNamespace(company_id=root, branch_id=branch, agent_id=agent,
                                              runtime_agent_id='agt_branch01')])
    records.env = SimpleNamespace(user=SimpleNamespace(company_ids=[branch]))
    assignment_type._check_assignment(records)


def _harness(template):
    functions = ast.parse((BASE / 'print_policy.py').read_text(encoding='utf-8'))
    sanitizer = next(n for n in functions.body if isinstance(n, ast.FunctionDef) and n.name == 'sanitize_raw_value')
    exported = ast.Module(body=[sanitizer], type_ignores=[])
    ast.fix_missing_locations(exported)
    globals_ = {}
    exec(compile(exported, 'print_policy.py', 'exec'), globals_)
    policy_class = _class_methods('print_policy.py', 'PrintGatewayPolicy',
                                  {'_sanitize_template_field', 'render_raw_template'}, globals_)
    policy = policy_class()
    policy.ensure_one = lambda: None
    policy.raw_template = template
    policy.raw_protocol = 'zpl'
    policy.name = 'Test labels'
    return policy


class Record:
    _fields = {
        'name': SimpleNamespace(type='char'),
        'expensive': SimpleNamespace(type='char'),
        'partner_id': SimpleNamespace(type='many2one'),
        'balance': SimpleNamespace(type='float'),
    }

    def __init__(self):
        self.reads = []

    def __getattr__(self, key):
        self.reads.append(key)
        if key == 'expensive':
            raise AssertionError('unreferenced expensive computed field read')
        values = {'name': 'test^~NAME', 'partner_id': SimpleNamespace(display_name='Alice', id=71), 'balance': 123.45}
        return values[key]


def test_template_reads_only_requested_fields_and_sanitizes_value():
    record = Record()
    assert _harness('^XA^FD{name}^FS^XZ').render_raw_template(record) == '^XA^FDtestNAME^FS^XZ'
    assert record.reads == ['name']


def test_many2one_display_and_id_access_do_not_touch_other_fields():
    record = Record()
    assert _harness('{partner_id}|{partner_id_id}').render_raw_template(record) == 'Alice|71'
    assert record.reads == ['partner_id', 'partner_id']


@pytest.mark.parametrize('template', [
    '{name:>9999999999}',
    '{name:.500000000}',
    '{name:{expensive}}',
    '{name.__class__}',
    '{name!r}',
    '{expensive[0]}',
    '{0}',
    '{}',
])
def test_template_rejects_unsafe_formatting_before_reading_record(template):
    record = Record()
    with pytest.raises(ValidationError):
        _harness(template).render_raw_template(record)
    assert not record.reads


def test_unknown_field_returns_operator_diagnostic():
    with pytest.raises(ValidationError, match='missing_field'):
        _harness('{missing_field}').render_raw_template(Record())


def test_raw_template_length_is_bounded_before_record_access():
    record = Record()
    with pytest.raises(ValidationError, match='2 MiB'):
        _harness('X' * (2*1024*1024 + 1)).render_raw_template(record)
    assert not record.reads


def test_repeated_legal_widths_cannot_allocate_the_whole_oversized_raw_document():
    # Every placeholder is independently legal, but their combined expansion
    # is 8 MiB. The renderer must reject while accumulating at its 2 MiB bound,
    # before allocating the full result and another full UTF-8 encoding.
    policy = _harness('{name:4096}' * 2048)
    record = Record()
    tracemalloc.start()
    try:
        with pytest.raises(ValidationError, match='Rendered raw printer template exceeds the 2 MiB'):
            policy.render_raw_template(record)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 6 * 1024 * 1024, f'oversized expansion allocated {peak} bytes before rejection'


def test_raw_template_segment_rendering_preserves_escaped_braces_and_unicode_bound():
    record = Record()
    assert _harness('{{label}}:{name:>12}:{{end}}').render_raw_template(record) == '{label}:    testNAME:{end}'
    at_limit = 'ص' * (1024 * 1024)
    assert _harness(at_limit).render_raw_template(record) == at_limit
    with pytest.raises(ValidationError, match='2 MiB'):
        _harness(at_limit + '{name}').render_raw_template(record)


def test_each_business_policy_hook_catches_only_after_savepoint():
    for file, cls_name, method in (
        ('account_move.py', 'AccountMovePrintGateway', 'action_post'),
        ('stock_picking.py', 'StockPickingPrintGateway', '_action_done'),
        ('pos_order.py', 'PosOrderGatewayPrinting', '_action_trigger_print_policies'),
    ):
        module = ast.parse((BASE / file).read_text(encoding='utf-8'))
        cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == cls_name)
        handler = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == method)
        calls = [n for n in ast.walk(handler) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and n.func.attr == 'dispatch_for_record']
        assert len(calls) == 1
        savepoints = [n for n in ast.walk(handler) if isinstance(n, ast.With) and
                      any(isinstance(v.context_expr, ast.Call) and isinstance(v.context_expr.func, ast.Attribute)
                          and v.context_expr.func.attr == 'savepoint' for v in n.items)]
        assert len(savepoints) == 1
        assert any(call in list(ast.walk(savepoints[0])) for call in calls)
        assert any(isinstance(n, ast.Try) and savepoints[0] in list(ast.walk(n))
                   for n in ast.walk(handler))



@pytest.mark.parametrize("source_reassigned,policy_drift", [
    (False, "valid"),
    (True, "valid"),
    (False, "disabled"),
    (False, "event_changed"),
    (False, "model_changed"),
    (False, "filter_miss"),
    (False, "rule_edited_after_capture"),
    (False, "binding_edited_after_capture"),
])
def test_recovery_scopes_to_captured_intent_company_before_reading_the_source(source_reassigned, policy_drift):
    # Model record rules can hide a valid branch source until the Environment
    # has allowed_company_ids for the ORIGINAL committed intent company.
    # The old method read .exists() under the cron user's root company and
    # incorrectly finalized a valid branch operation as 'source disappeared'.
    from contextlib import nullcontext

    root = SimpleNamespace(id=801)
    branch = SimpleNamespace(id=802)
    moved = SimpleNamespace(id=803)
    reads, routes, finalizations, failures = [], [], [], []

    class Cursor:
        def savepoint(self):
            return nullcontext()
        def close(self):
            pass

    cursor = Cursor()
    captured_at = datetime.datetime(2026, 10, 28, 12, 0, 0)
    edited_at = captured_at + datetime.timedelta(minutes=1)
    old_revision = captured_at - datetime.timedelta(minutes=1)
    policy = SimpleNamespace(
        active=policy_drift != 'disabled',
        model_name='other.model' if policy_drift == 'model_changed' else 'stock.picking',
        event_type='other_event' if policy_drift == 'event_changed' else 'picking_validated',
        matches_record=lambda _record: policy_drift != 'filter_miss',
        write_date=edited_at if policy_drift == 'rule_edited_after_capture' else old_revision,
        binding_id=SimpleNamespace(write_date=edited_at if policy_drift == 'binding_edited_after_capture' else old_revision),
    )
    intent = SimpleNamespace(
        claim_token='held-lease', company_id=branch, intent_key='outbox-lease',
        event_type='picking_validated', policy_id=policy,
        create_date=captured_at,
        with_env=lambda scoped_env: intent,
    )
    record = SimpleNamespace(
        company_id=moved if source_reassigned else branch,
        with_env=lambda scoped_env: record,
    )

    class Source:
        def __init__(self, scope):
            self.scope = scope
        def browse(self, _id):
            return self
        def exists(self):
            reads.append(self.scope.company.id)
            return record if self.scope.company.id == branch.id else False

    class FakeEnvironment:
        def __init__(self, cr, uid, context):
            self.cr, self.uid, self.context = cr, uid, context
            self.company = branch if context.get('allowed_company_ids') == [branch.id] else root
        def __call__(self, *, context):
            return FakeEnvironment(self.cr, self.uid, context)
        def __getitem__(self, model):
            if model == 'print_gateway.intent':
                return SimpleNamespace(browse=lambda _id: SimpleNamespace(exists=lambda: intent))
            if model == 'stock.picking':
                return Source(self)
            if model == 'print_gateway.print_router':
                return SimpleNamespace(route_intent=lambda _intent, _record: routes.append(self.company.id) or {'job_id': 29})
            raise AssertionError('Unexpected model: ' + model)

    addon = _class_methods('print_intent.py', 'PrintGatewayIntent',
                           {'_execute_dispatched_route'},
                           {'api': SimpleNamespace(Environment=FakeEnvironment)})
    addon._finalize_intent_state = classmethod(lambda cls, *args, **kwargs: finalizations.append(kwargs))
    addon._finalize_route_failure = classmethod(lambda cls, *args: failures.append(args))
    calling_env = SimpleNamespace(uid=1, context={}, registry=SimpleNamespace(cursor=lambda: cursor))
    addon._execute_dispatched_route(addon, calling_env, 41, 'stock.picking', 15, 'held-lease')
    assert not failures, failures
    assert reads == [branch.id], 'Source must be checked under captured company before .exists()'
    assert len(finalizations) == 1
    if source_reassigned or policy_drift != 'valid':
        assert routes == [], 'Reassigned sources or drifted/disabled policies cannot send paper'
        assert finalizations[0]['status'] == 'skipped'
        expected = 'company changed' if source_reassigned else 'rule'
        assert expected in finalizations[0]['last_error'].lower()
    else:
        assert routes == [branch.id], 'A valid branch intent must not be silently skipped'
        assert finalizations[0]['status'] == 'dispatched'
        assert finalizations[0]['print_job_id'] == 29


def test_intent_route_requires_durable_job_or_explicit_skip_and_savepoint():
    tree = ast.parse((BASE / 'print_intent.py').read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'PrintGatewayIntent')
    route = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '_execute_dispatched_route')
    savepoints = [n for n in ast.walk(route) if isinstance(n, ast.With) and
                  any(isinstance(i.context_expr, ast.Call) and isinstance(i.context_expr.func, ast.Attribute)
                      and i.context_expr.func.attr == 'savepoint' for i in n.items)]
    # One savepoint protects the business-rule match read and another the
    # durable route. New isolation is stronger, not a regression: verify
    # both guards rather than requiring an obsolete exact savepoint count.
    matching = [sp for sp in savepoints if any(
        isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        and n.func.attr == 'matches_record' for n in ast.walk(sp))]
    dispatch = [sp for sp in savepoints if any(
        isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        and n.func.attr == 'route_intent' for n in ast.walk(sp))]
    assert len(matching) == len(dispatch) == 1 and matching[0] is not dispatch[0]
    assert any(isinstance(n, ast.Raise) and isinstance(n.exc, ast.Call)
               and isinstance(n.exc.func, ast.Name) and n.exc.func.id == 'ValueError'
               for n in ast.walk(dispatch[0]))
