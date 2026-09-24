# -*- coding: utf-8 -*-
"""Native Odoo print bindings: Odoo context -> Gateway runtime printer."""

import json
import logging

import requests

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError

_logger = logging.getLogger(__name__)


def _assert_report_usage_access(env, report):
    """Apply Odoo report-use restrictions before Gateway physical dispatch.

    ``ir.actions.report.group_ids`` defines which user groups may view/use a
    report. Custom Gateway entry points bypass Odoo's native report controller,
    so this permission must be enforced explicitly before rendering or creating
    a physical print job.
    """
    report = report.sudo().exists()
    if not report:
        raise ValidationError(_("The requested report is unavailable."))
    if str(report.report_type or "").strip() != "qweb-pdf":
        raise ValidationError(_("Only QWeb PDF reports can be sent to the Print Gateway."))
    if env.is_superuser:
        return report
    allowed_group_ids = set(report.group_ids.ids)
    if allowed_group_ids and not allowed_group_ids.intersection(env.user.groups_id.ids):
        raise AccessError(_("You are not allowed to view or use this report."))
    return report


DESTINATION_MODELS = [
    ("pos", "POS Configuration"),
    ("pos_printer", "POS / Kitchen Printer"),
    ("picking_type", "Operation Type"),
    ("report", "Report"),
]

DOCUMENT_TYPE_BY_MODEL = {
    "sale.order": "order",
    "account.move": "invoice",
    "stock.picking": "delivery",
    "purchase.order": "purchase_order",
    "pos.order": "receipt",
}


class PrintGatewayBinding(models.Model):
    _name = "print_gateway.binding"
    _description = "Print Gateway Print Binding"
    _order = "priority, id"

    company_id = fields.Many2one(
        "res.company", required=True, default=lambda self: self.env.company.parent_id or self.env.company,
        ondelete="restrict", index=True, string="Odoo Company",
        domain="[('parent_id', '=', False)]",
    )
    branch_id = fields.Many2one(
        "res.company", string="Odoo Branch", ondelete="restrict", index=True,
        domain="[('parent_id', '=', company_id)]",
    )
    effective_company_id = fields.Many2one(
        "res.company",
        string="Effective Company",
        compute="_compute_effective_company_id",
        store=True,
        index=True,
    )
    runtime_agent_id = fields.Char(
        string="Gateway Runtime Agent", copy=False, index=True,
        help="Opaque Gateway runtime-agent ID. Runtime ownership remains in the Gateway.",
    )
    destination_type = fields.Selection(
        DESTINATION_MODELS, string="Destination Type", required=True, default="pos",
    )
    destination_pos_config_id = fields.Many2one(
        "pos.config", string="POS Configuration", ondelete="restrict", check_company=True,
        domain="['&', '|', ('company_id', '=', False), ('company_id', '=', effective_company_id), ('active', '=', True)]",
    )
    destination_pos_printer_id = fields.Many2one(
        "pos.printer", string="POS / Kitchen Printer", ondelete="restrict", check_company=True,
        domain="['|', ('company_id', '=', False), ('company_id', '=', effective_company_id)]",
    )
    destination_picking_type_id = fields.Many2one(
        "stock.picking.type", string="Operation Type", ondelete="restrict", check_company=True,
        domain="['&', '|', ('company_id', '=', False), ('company_id', '=', effective_company_id), ('active', '=', True)]",
    )
    destination_report_id = fields.Many2one(
        "ir.actions.report", string="Report Destination", ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    destination_ref = fields.Reference(
        selection=[
            ("pos.config", "POS Configuration"),
            ("pos.printer", "POS / Kitchen Printer"),
            ("stock.picking.type", "Operation Type"),
            ("ir.actions.report", "Report"),
        ],
        string="Odoo Destination", compute="_compute_destination_ref", store=True, readonly=True,
    )
    report_id = fields.Many2one(
        "ir.actions.report", string="Document / Report", ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    document_type = fields.Char(
        string="Document Type", compute="_compute_document_type", store=True, readonly=True,
    )
    printer_id = fields.Char(
        string="Gateway Runtime Printer", required=True, index=True, copy=False,
    )
    printer_protocol = fields.Selection([
        ("escpos", "ESC/POS"),
        ("zpl", "Zebra ZPL-II"),
        ("tspl", "TSC TSPL"),
        ("raw", "Raw Text/Binary"),
        ("spooler", "Windows/macOS Document Spool (driver-rendered)"),
        ("ipp", "IPP"),
        ("ipps", "IPP over TLS"),
        ("unknown", "Not declared (not routable)"),
    ], string="Printer Protocol", required=True,
       help="Hardware control language the printer ACTUALLY understands. "
            "There is deliberately no default: declaring the protocol is an "
            "explicit operator statement. 'unknown' keeps byte-stream jobs "
            "unroutable (raw/zpl/tspl/escpos all require an exact match); "
            "document (PDF/image) jobs additionally require the Gateway "
            "printer itself to be a document transport. Byte protocols never "
            "wildcard: a 'raw' printer does not accept zpl/tspl/escpos jobs.")
    fallback_binding_id = fields.Many2one(
        "print_gateway.binding", string="Failover Backup Binding", ondelete="set null",
        check_company=True,
        domain="['&', '&', ('id', '!=', id), ('company_id', '=', company_id), ('branch_id', '=', branch_id)]",
        help="Pre-dispatch failover target if the primary printer is confirmed offline before bytes are sent.",
    )
    drawer_kick_mode = fields.Selection([
        ("none", "Disabled"),
        ("pin2", "Pin 2 (0x1B 0x70 0x00)"),
        ("pin5", "Pin 5 (0x1B 0x70 0x01)"),
    ], string="Cash Drawer Kick", default="none", help="Hardware cash drawer pulse mode.")
    cutter_mode = fields.Selection([
        ("none", "No Cut"),
        ("partial", "Partial Cut (0x1D 0x56 0x42)"),
        ("full", "Full Cut (0x1D 0x56 0x41)"),
    ], string="Paper Cutter", default="none", help="Hardware paper cutter command mode.")
    buzzer_mode = fields.Selection([
        ("none", "Disabled"),
        ("epson_pulse", "Epson Pulse (0x1B 0x63 0x30 0x02)"),
        ("star_bel", "Star Bell (0x07)"),
    ], string="Kitchen Buzzer", default="none", help="Hardware audio chime.")
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is preferred when multiple bindings are valid.")
    name = fields.Char(compute="_compute_name", store=True)

    def get_peripheral_payload(self):
        self.ensure_one()
        payload = {}
        if self.drawer_kick_mode and self.drawer_kick_mode != "none":
            payload["drawer"] = self.drawer_kick_mode
        if self.cutter_mode and self.cutter_mode != "none":
            payload["cutter"] = self.cutter_mode
        if self.buzzer_mode and self.buzzer_mode != "none":
            payload["buzzer"] = self.buzzer_mode
        return payload

    _priority_unique = models.Constraint(
        "UNIQUE(company_id, branch_id, destination_ref, document_type, priority)",
        "Priority must be unique for the same Odoo company, branch, destination and document type.",
    )

    @api.depends("company_id", "branch_id")
    def _compute_effective_company_id(self):
        for record in self:
            record.effective_company_id = record.branch_id or record.company_id

    @api.constrains("fallback_binding_id", "company_id", "branch_id", "destination_type", "destination_ref", "document_type")
    def _check_fallback_binding_scope(self):
        for record in self:
            fallback = record.fallback_binding_id
            if not fallback:
                continue
            if fallback == record:
                raise ValidationError(_("A Print Binding cannot use itself as its failover target."))
            if fallback.company_id != record.company_id or fallback.branch_id != record.branch_id:
                raise ValidationError(_(
                    "The failover binding must use the same Odoo Company and Branch as the primary binding."
                ))
            if fallback.destination_type != record.destination_type or fallback.destination_ref != record.destination_ref:
                raise ValidationError(_(
                    "The failover binding must target the same destination as the primary binding."
                ))
            if fallback.document_type != record.document_type:
                raise ValidationError(_(
                    "The failover binding must use the same document type as the primary binding."
                ))

    @api.depends("destination_type", "destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id", "destination_report_id")
    def _compute_destination_ref(self):
        for record in self:
            destination = False
            if record.destination_type == "pos":
                destination = record.destination_pos_config_id
            elif record.destination_type == "pos_printer":
                destination = record.destination_pos_printer_id
            elif record.destination_type == "picking_type":
                destination = record.destination_picking_type_id
            elif record.destination_type == "report":
                destination = record.destination_report_id
            record.destination_ref = "%s,%s" % (destination._name, destination.id) if destination else False

    @api.depends("report_id", "report_id.model", "report_id.report_name", "destination_type", "destination_pos_printer_id")
    def _compute_document_type(self):
        for record in self:
            if record.destination_type == "pos_printer":
                record.document_type = "kitchen"
            elif record.report_id:
                report = record.report_id
                record.document_type = DOCUMENT_TYPE_BY_MODEL.get(report.model, "report:%s" % (report.report_name or report.id).strip().lower())
            else:
                record.document_type = False

    @api.depends("company_id", "branch_id", "destination_ref", "document_type", "runtime_agent_id", "printer_id")
    def _compute_name(self):
        for record in self:
            destination = record.destination_ref.display_name if record.destination_ref else "Destination"
            scope = record.branch_id.display_name if record.branch_id else record.company_id.display_name
            agent = record.runtime_agent_id or "Agent"
            printer = record.printer_id or "Printer"
            record.name = "%s / %s / %s → %s / %s" % (scope or "Odoo Context", destination, record.document_type or "document", agent, printer)

    @api.onchange("destination_type")
    def _onchange_destination_type(self):
        for record in self:
            if record.destination_type != "pos":
                record.destination_pos_config_id = False
            if record.destination_type != "pos_printer":
                record.destination_pos_printer_id = False
            if record.destination_type != "picking_type":
                record.destination_picking_type_id = False
            if record.destination_type != "report":
                record.destination_report_id = False
            if record.destination_type == "pos_printer":
                record.report_id = False

    @api.onchange("company_id")
    def _onchange_company_id(self):
        for record in self:
            record.branch_id = False
            record.runtime_agent_id = False
            record.printer_id = False
            record.destination_pos_config_id = False
            record.destination_pos_printer_id = False
            record.destination_picking_type_id = False
            record.destination_report_id = False
            record.report_id = False

    @api.onchange("branch_id")
    def _onchange_branch_id(self):
        for record in self:
            record.runtime_agent_id = False
            record.printer_id = False
            record.destination_pos_config_id = False
            record.destination_pos_printer_id = False
            record.destination_picking_type_id = False
            record.destination_report_id = False
            record.report_id = False

    @api.onchange("runtime_agent_id")
    def _onchange_runtime_agent_id(self):
        for record in self:
            record.printer_id = False

    def _get_gateway_config(self):
        self.ensure_one()
        root_company = self.company_id.parent_id if self.branch_id and self.company_id.parent_id else self.company_id
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", root_company.id)], limit=1)
        if not config or not config.enabled:
            raise ValidationError(_("An enabled Print Gateway configuration is required for this Odoo Company."))
        return config

    def _validate_runtime_target(self):
        self.ensure_one()
        if not self.runtime_agent_id:
            return
        config = self._get_gateway_config()
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        if not assignment_model.is_agent_assigned(
            config.company_id, self.branch_id, self.runtime_agent_id
        ):
            raise ValidationError(
                _("The selected Gateway Runtime Agent is not assigned to the current Odoo Branch.")
            )
        try:
            response = requests.get("%s/api/odoo/agents" % config._gateway_base(for_request=True), headers=config._gateway_headers(), timeout=10, allow_redirects=False)
            if response.status_code != 200:
                raise ValidationError(_("Gateway agent discovery failed (HTTP %s).") % response.status_code)
            body = response.json()
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(_("Gateway runtime agent discovery is unavailable.")) from exc
        agents = body.get("agents") if isinstance(body, dict) else None
        agent_match = next((agent for agent in agents or [] if isinstance(agent, dict) and agent.get("id") == self.runtime_agent_id), None)
        if not isinstance(agents, list) or not agent_match:
            raise ValidationError(_("The selected Gateway Runtime Agent is not found."))
        if agent_match.get("lifecycle") != "active":
            raise ValidationError(
                _("Agent '%s' cannot be assigned because its lifecycle is '%s'. Only agents with lifecycle 'active' may receive print jobs.")
                % (agent_match.get("name") or self.runtime_agent_id, agent_match.get("lifecycle"))
            )
        try:
            response = requests.get("%s/api/odoo/printers" % config._gateway_base(for_request=True), headers=config._gateway_headers(), timeout=10, allow_redirects=False)
            if response.status_code != 200:
                raise ValidationError(_("Gateway printer discovery failed (HTTP %s).") % response.status_code)
            body = response.json()
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(_("Gateway runtime printer discovery is unavailable.")) from exc
        printers = body.get("printers") if isinstance(body, dict) else None
        printer_match = next((printer for printer in printers or [] if isinstance(printer, dict) and printer.get("id") == self.printer_id), None)
        if not isinstance(printers, list) or not printer_match:
            raise ValidationError(_("The selected Gateway Runtime Printer is not found."))
        if printer_match.get("lifecycle") != "active":
            raise ValidationError(
                _("Printer '%s' cannot be assigned because its lifecycle is '%s'. Only printers with lifecycle 'active' may receive print jobs.")
                % (printer_match.get("name") or self.printer_id, printer_match.get("lifecycle"))
            )
        selected_printer = printer_match
        agent = selected_printer.get("agent") if isinstance(selected_printer.get("agent"), dict) else {}
        if agent.get("id") != self.runtime_agent_id:
            raise ValidationError(_("Gateway Runtime Printer does not belong to the selected Runtime Agent."))
        device_class = str(selected_printer.get("deviceClass") or "").strip().lower()
        if self.destination_type in ("pos", "pos_printer") and device_class in ("laser", "inkjet"):
            raise ValidationError(_("Point of Sale receipts require a thermal receipt printer, not a document/laser printer."))
        if self.destination_type == "picking_type" and device_class in ("laser", "inkjet") and not self.report_id:
            raise ValidationError(_("Direct inventory/warehouse operations require a label or thermal printer."))


    @api.constrains("company_id", "branch_id")
    def _check_company_hierarchy(self):
        for record in self:
            if record.branch_id and record.branch_id == record.company_id:
                raise ValidationError(_("Odoo Branch must be a child Branch, not the selected root Company."))
            if record.company_id.parent_id:
                raise ValidationError(_("Odoo Company must be a root Company, not a Branch."))
            if record.branch_id and record.branch_id.parent_id != record.company_id:
                raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))

    @api.constrains("company_id", "branch_id", "runtime_agent_id", "printer_id")
    def _check_runtime_scope(self):
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        for record in self:
            if record.company_id not in self.env.companies:
                raise ValidationError(_("The selected Odoo Company is not available to the current user."))
            if record.branch_id:
                if record.branch_id not in self.env.companies:
                    raise ValidationError(_("Odoo Branch is not available to the current user."))
                if not isinstance(record.runtime_agent_id, str) or not record.runtime_agent_id.strip():
                    raise ValidationError(_("A Gateway Runtime Agent is required for a branch binding."))

            if record.runtime_agent_id and not assignment_model.is_agent_assigned(
                record.company_id, record.branch_id, record.runtime_agent_id
            ):
                scope_label = record.branch_id.display_name if record.branch_id else record.company_id.display_name
                raise ValidationError(
                    _("Gateway Runtime Agent '%s' is not explicitly assigned to '%s'. "
                      "Assign the Agent to this exact Odoo scope before creating the binding.")
                    % (record.runtime_agent_id.strip(), scope_label)
                )

    @api.constrains("destination_type", "destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id", "destination_report_id", "report_id", "printer_id", "company_id", "branch_id", "effective_company_id")
    def _check_binding(self):
        for record in self:
            destination = record.destination_ref
            if not destination:
                raise ValidationError(_("A valid Odoo Destination is required."))
            expected_company = record.effective_company_id
            destination_company = getattr(destination, "company_id", False)
            if destination_company and destination_company != expected_company:
                raise ValidationError(_("Odoo Destination belongs to another company/branch context."))
            if record.report_id and getattr(record.report_id, "company_id", False) and record.report_id.company_id != expected_company:
                raise ValidationError(_("Document / Report belongs to another company/branch context."))
            if record.destination_type == "pos_printer":
                printer_configs = record.destination_pos_printer_id.pos_config_ids
                if printer_configs and expected_company not in printer_configs.mapped("company_id"):
                    raise ValidationError(_("POS / Kitchen Printer is not available to the selected Odoo Branch."))
                if record.report_id:
                    raise ValidationError(_("Kitchen bindings use the built-in Kitchen / Preparation document type."))
            elif not record.report_id:
                raise ValidationError(_("A real Odoo report must be selected for this Destination Type."))
            if record.report_id and record.report_id.model == "pos.order" and record.destination_type not in ("pos", "report"):
                raise ValidationError(_("POS receipts must use a POS or report destination."))
            if record.report_id and record.report_id.model == "stock.picking" and record.destination_type not in ("picking_type", "report"):
                raise ValidationError(_("Stock reports must use an operation type or report destination."))
            if not isinstance(record.printer_id, str) or not record.printer_id.strip():
                raise ValidationError(_("A Gateway Runtime Printer must be selected."))

    def action_send_test_print(self):
        """Construct a standardized diagnostic test page and submit via the Outbox pipeline."""
        self.ensure_one()
        # A test page causes a PHYSICAL print side effect; the view hides the
        # button from non-admins but the model is the authoritative boundary
        # (the method is RPC-callable and binding ACLs are read-only for
        # internal users, which would otherwise never fire here).
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can dispatch test pages."))
        self._validate_runtime_target()
        router = self.env["print_gateway.print_router"]
        res = router.route_test_page(self)
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Test Print Dispatched"),
                "message": res.get("message") or _("Diagnostic test page sent to printer '%s'.") % self.printer_id,
                "type": "success",
                "sticky": False,
            },
        }

    def action_verify_remote_hardware(self):
        """Validate the CONTROL-PLANE registration, not hardware reachability.

        This checks that the agent and printer exist on the Gateway with
        lifecycle 'active' and belong together. It deliberately does not
        claim anything about the device being powered on or answering -
        that is what Send Test Page is for.
        """
        self.ensure_one()
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can validate hardware registration."))
        self._validate_runtime_target()
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Registration Validated"),
                "message": _("Gateway registration is consistent: agent '%s' and printer '%s' are registered and active. This is a control-plane check, not a live hardware test - use Send Test Page to validate the physical path.") % (self.runtime_agent_id, self.printer_id),
                "type": "success",
                "sticky": False,
            },
        }

    @api.model_create_multi
    def create(self, vals_list):
        return super().create(vals_list)

    def write(self, vals):
        return super().write(vals)

    def unlink(self):
        return super().unlink()
    @api.model
    def destination_for(self, *, record=None, report=None, explicit_destination=None):
        if explicit_destination:
            return explicit_destination
        if record and record._name == "pos.order":
            config = getattr(record, "config_id", False)
            if config:
                return config
            raise ValidationError(_("POS order has no POS configuration for print routing."))
        if record and record._name == "stock.picking":
            picking_type = getattr(record, "picking_type_id", False)
            if picking_type:
                return picking_type
            raise ValidationError(_("Delivery has no operation type for print routing."))
        if report:
            return report
        raise ValidationError(_("A deterministic Odoo print destination is required."))

    @api.model
    def resolve_explicit(self, binding, company, document_type, destination, *, report=None, branch=None, protocol=None, payload_type=None):
        """Validate and return the exact caller-selected binding; never reprioritize it."""
        binding = binding.exists()
        if not binding or len(binding) != 1:
            raise ValidationError(_("The explicitly selected print binding no longer exists."))
        normalized = (document_type or "").strip().lower()
        if not binding.enabled:
            raise ValidationError(_("The explicitly selected print binding is disabled."))
        if binding.company_id != company or binding.branch_id != branch:
            raise ValidationError(_("The explicitly selected print binding is not scoped to the current company and branch."))
        if binding.destination_ref != destination or binding.document_type != normalized:
            raise ValidationError(_("The explicitly selected print binding does not match this destination and document type."))
        if report and binding.report_id != report:
            raise ValidationError(_("The explicitly selected print binding does not match this report action."))
        if not binding.runtime_agent_id or not binding.printer_id:
            raise ValidationError(_("The explicitly selected print binding has no routable runtime and printer."))
        if protocol and binding.printer_protocol != protocol:
            raise ValidationError(_("The explicitly selected print binding does not support protocol '%s'.") % protocol)
        # Document and raster payloads (PDF, JPEG raster banding) require a spooler
        # or IPP/IPPS print queue capable of document rasterization/rendering.
        # Direct stream protocols (escpos, raw) are excluded because they
        # do not have arbitrary page raster rendering pipelines on the gateway/agent.
        if payload_type in ("pdf", "raster_jpeg") and binding.printer_protocol not in ("spooler", "ipp", "ipps"):
            raise ValidationError(_("The explicitly selected print binding is not capable of document printing."))
        return binding

    @api.model
    def find_for(self, company, document_type, report=None, record=None, explicit_destination=None, branch=None):
        normalized = (document_type or "").strip().lower()
        if not normalized:
            raise ValidationError(_("Print document type is required."))
        destination = self.destination_for(record=record, report=report, explicit_destination=explicit_destination)
        expected_company = branch or company
        destination_company = getattr(destination, "company_id", False)
        if destination_company and destination_company != expected_company:
            raise ValidationError(_("Print destination belongs to another Odoo company/branch context."))
        domain = [
            ("company_id", "=", company.id), ("enabled", "=", True),
            ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
            ("document_type", "=", normalized), ("branch_id", "=", branch.id if branch else False),
        ]
        binding = self.search(domain, order="priority asc, id asc", limit=1)
        if binding or not branch:
            return binding
        # POS configurations and stock operation types are branch-owned.
        # Their root binding cannot carry the same destination_ref, so require
        # an explicit branch binding rather than pretending a root fallback is
        # structurally available. Root fallback remains valid for global/root
        # report destinations.
        if destination_company == branch:
            return self.browse()
        return self.search([
            ("company_id", "=", company.id), ("branch_id", "=", False), ("enabled", "=", True),
            ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
            ("document_type", "=", normalized),
        ], order="priority asc, id asc", limit=1)

    @api.model
    def dispatch_report_action(self, report_name=None, report_id=None, res_ids=None, context=None, data=None):
        context = dict(context or self.env.context)
        binding_model = self.with_context(**context)
        report = False
        if report_id:
            try:
                report = binding_model.env["ir.actions.report"].browse(int(report_id)).exists()
            except (TypeError, ValueError):
                report = False
        if not report and report_name:
            report = binding_model.env["ir.actions.report"].search([("report_name", "=", report_name)], limit=1)
            if not report:
                report = binding_model.env["ir.actions.report"].search([("report_file", "=", report_name)], limit=1)
        if not report:
            return {"dispatched": False, "has_binding": False}

        report = _assert_report_usage_access(binding_model.env, report)

        records = binding_model.env[report.model].browse(res_ids or []).exists()
        # The rendered PDF leaves the Odoo perimeter (gateway + physical
        # print), so the caller must hold READ access on every record it
        # asked to render - exactly like the /report/download controller.
        # Without this, an internal user could exfiltrate same-company
        # documents they are not allowed to open via RPC dispatch.
        if records:
            records.check_access("read")
        router = binding_model.env["print_gateway.print_router"]
        config = router._gateway_config(binding_model.env.company)
        if not config:
            return {"dispatched": False, "has_binding": False}

        try:
            gateway_company, branch = router._binding_scope(binding_model.env.company)
            dtype = router._document_type(report=report, record=records[0] if records else None)
            destination = router.destination_for(report=report, record=records[0] if records else None)
            binding = binding_model.find_for(
                gateway_company,
                dtype,
                report=report,
                record=records[0] if records else None,
                branch=branch,
            )
        except Exception as exc:
            _logger.warning("Failed to locate silent binding: %s", exc)
            return {
                "has_binding": True,
                "success": False,
                "dispatched": False,
                "error": "Failed to evaluate print routing.",
                "fail_closed": True,
            }

        if not binding:
            return {"dispatched": False, "has_binding": False, "success": False}

        try:
            route = router.route_report(report, records, data=data)
            if route.get("native"):
                return {"dispatched": False, "has_binding": False, "success": False}

            return {
                "dispatched": True,
                "success": True,
                "has_binding": True,
                "status": route.get("status") or "unknown",
                "printer_name": route.get("printer_id") or binding.printer_id,
                "message": route.get("message") or _("Sent silently to printer."),
            }
        except Exception as exc:
            raw_error = str(exc)
            prefix = "GATEWAY_BILLING_LIMIT:"
            if raw_error.startswith(prefix):
                try:
                    billing_limit = json.loads(raw_error[len(prefix):])
                except (TypeError, ValueError, json.JSONDecodeError):
                    billing_limit = None
                if isinstance(billing_limit, dict) and billing_limit.get("entitlement"):
                    return {
                        "dispatched": False,
                        "success": False,
                        "has_binding": True,
                        "error": billing_limit.get("message") or _("This print operation is blocked by the current Gateway plan limit."),
                        "billing_limit": billing_limit,
                        "fail_closed": True,
                    }

            _logger.warning("Failed to execute silent print route: %s", exc)
            return {
                "dispatched": False,
                "success": False,
                "has_binding": True,
                "error": "Print dispatch failed. Open Print Jobs for the reason; the document was not sent.",
                "fail_closed": True,
            }

