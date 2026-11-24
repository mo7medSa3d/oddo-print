"""Run actual POS activation RPC bodies with only ORM boundaries replaced."""
from types import MethodType, SimpleNamespace

import pytest

from test_f010_report_binding_identity import AccessError, ValidationError, production_methods


def activation_methods(model):
    names = ["is_gateway_printing_enabled"]
    if model == "pos_order.py":
        names.append("_gateway_active_company")
    return production_methods(model, names)


def attach_company_guard(record, production, model):
    if model == "pos_order.py":
        record._gateway_active_company = MethodType(production._gateway_active_company, record)



@pytest.mark.parametrize("model", ["pos_order.py", "pos_session.py"])
@pytest.mark.parametrize("enabled", [False, True])
def test_activation_query_preserves_readable_current_company_result(model, enabled):
    production = activation_methods(model)
    company = object()
    calls = []

    class Env:
        def __getitem__(self, name):
            assert name == "print_gateway.print_router"
            return SimpleNamespace(
                _print_config=lambda selected: calls.append(("config", selected)) or enabled,
                _gateway_config=lambda selected: calls.append(("config", selected)) or enabled,
            )

    env = Env()
    env.company = company
    record = SimpleNamespace(
        ensure_one=lambda: calls.append("one"),
        check_access=lambda operation: calls.append(("access", operation)),
        config_id=SimpleNamespace(company_id=company), company_id=company, env=env,
    )
    attach_company_guard(record, production, model)
    assert production.is_gateway_printing_enabled(record) is enabled
    assert calls == (["one", ("access", "read"), "one", ("config", company)]
                     if model == "pos_order.py" else ["one", ("access", "read"), ("config", company)])


@pytest.mark.parametrize("model", ["pos_order.py", "pos_session.py"])
def test_activation_query_denied_record_never_reads_gateway_configuration(model):
    production = activation_methods(model)

    class Env:
        def __getitem__(self, name):
            raise AssertionError("denied record must not reach privileged configuration lookup")

    def denied(operation):
        assert operation == "read"
        raise AccessError("not readable")

    record = SimpleNamespace(ensure_one=lambda: None, check_access=denied, env=Env())
    with pytest.raises(AccessError, match="not readable"):
        production.is_gateway_printing_enabled(record)


@pytest.mark.parametrize("model", ["pos_order.py", "pos_session.py"])
def test_activation_query_foreign_company_never_reads_gateway_configuration(model):
    production = activation_methods(model)

    class Env:
        company = object()

        def __getitem__(self, name):
            raise AssertionError("foreign-company record must not reach privileged configuration lookup")

    foreign = object()
    record = SimpleNamespace(ensure_one=lambda: None, check_access=lambda _: None,
                             config_id=SimpleNamespace(company_id=foreign), company_id=foreign, env=Env())
    attach_company_guard(record, production, model)
    with pytest.raises(ValidationError, match="active Odoo company"):
        production.is_gateway_printing_enabled(record)
