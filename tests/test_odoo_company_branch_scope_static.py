"""Retained branch/security invariants for the native Odoo Agent/printer pickers."""
from pathlib import Path

ADDON = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway"


def test_nested_branch_rejected_before_any_runtime_agent_or_printer_lookup():
    controller = (ADDON / "controllers/runtime_printers.py").read_text(encoding="utf-8")
    assert "if company.parent_id and company.parent_id.parent_id:" in controller
    assert "Nested Odoo branches are not supported for printer assignments." in controller
    assert "self._scope(company_id, branch_id)" in controller
    assert "raise Forbidden" in controller
    # Both RPCs feeding the native binding pickers still enforce scope.
    assert "/print_gateway/runtime-agents" in controller
    assert "/print_gateway/runtime-printers" in controller
    assert "agent_id not in allowed_agent_ids" in controller


def test_native_binding_filters_company_branch_and_clears_stale_printer_on_agent_switch():
    form = (ADDON / "views/binding_views.xml").read_text(encoding="utf-8")
    agent = (ADDON / "static/src/components/runtime_agent_field.js").read_text(encoding="utf-8")
    printer = (ADDON / "static/src/components/runtime_printer_field.js").read_text(encoding="utf-8")
    assert "domain=\"[('parent_id', '=', False)]\"" in form
    assert "domain=\"[('parent_id', '=', company_id)]\"" in form
    assert 'name="agent_id"' in form
    assert 'widget="gateway_runtime_printer"' in form
    assert '() => [this.companyId, this.branchId, this.assignmentOnly]' in agent
    assert 'updateData.printer_id = false' in agent
    assert '() => [this.companyId, this.branchId, this.agentId, this.destinationType, this.reportId, this.documentType]' in printer
