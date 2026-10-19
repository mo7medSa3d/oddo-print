"""Run actual POS activation RPC bodies with only ORM boundaries replaced."""
from types import SimpleNamespace

import pytest

from test_f010_report_binding_identity import AccessError, ValidationError, production_methods


@pytest.mark.parametrize("model", ["pos_order.py", "pos_session.py"])
@pytest.mark.parametrize("enabled", [False, True])
def test_activation_query_preserves_readable_current_company_result(model, enabled):
    production = production_methods(model, ["is_gateway_printing_enabled"])
    company = object()
    calls = []

    class Env:
        def __getitem__(self, name):
            assert name == "print_gateway.print_router"
            return SimpleNamespace(_gateway_config=lambda selected: calls.append(("config", selected)) or enabled)

    env = Env()
    env.company = company
    record = SimpleNamespace(
        ensure_one=lambda: calls.append("one"),
        check_access=lambda operation: calls.append(("access", operation)),
        config_id=SimpleNamespace(company_id=company), company_id=company, env=env,
    )
    assert production.is_gateway_printing_enabled(record) is enabled
    assert calls == ["one", ("access", "read"), ("config", company)]


@pytest.mark.parametrize("model", ["pos_order.py", "pos_session.py"])
def test_activation_query_denied_record_never_reads_gateway_configuration(model):
    production = production_methods(model, ["is_gateway_printing_enabled"])

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
    production = production_methods(model, ["is_gateway_printing_enabled"])

    class Env:
        company = object()

        def __getitem__(self, name):
            raise AssertionError("foreign-company record must not reach privileged configuration lookup")

    foreign = object()
    record = SimpleNamespace(ensure_one=lambda: None, check_access=lambda _: None,
                             config_id=SimpleNamespace(company_id=foreign), company_id=foreign, env=Env())
    with pytest.raises(ValidationError, match="active Odoo company"):
        production.is_gateway_printing_enabled(record)
