# -*- coding: utf-8 -*-
"""Native Odoo print bindings: Odoo context -> Odoo Agent runtime printer."""

import json
import logging


from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError
from .printer import _parse_json_dict, derive_printer_specs
from ..printer_geometry import validated_printer_geometry
from ..runtime_policy import is_exact_printer_key

_logger = logging.getLogger(__name__)


def _sanitize_dispatch_context(context):
    """Keep only the allowlisted dispatch RPC context keys.

    Dropped silently (never honoured, never an error, so old callers keep
    working): every company-steering key, skip_enabled_sync,
    allow_lease_recovery, diagnostic keys (print_gateway_diagnostic_*,
    discard_logo_check) and any non-string or overlong value.
    """
    if not isinstance(context, dict):
        return {}
    allowed = {
        "print_gateway_document_type": 128,
        "lang": 32,
        "tz": 64,
    }
    sanitized = {}
    for key, value in context.items():
        limit = allowed.get(key)
        if limit is None or not isinstance(value, str):
            continue
        value = value.strip()
        if not value or len(value) > limit:
            continue
        if key == "lang" and not all(ch.isalnum() or ch in "_-@" for ch in value):
            continue
        if key == "tz" and not all(ch.isalnum() or ch in "_/+-" for ch in value):
            continue
        sanitized[key] = value
    return sanitized


def _assert_report_usage_access(env, report):
    """Apply Odoo report-use restrictions before Direct Odoo print routing.

    ``ir.actions.report.group_ids`` defines which user groups may view/use a
    report. Custom Direct Odoo print routes bypass Odoo's native report controller,
    so this permission must be enforced explicitly before rendering or creating
    a physical print job.
    """
    report = report.sudo().exists()
    if not report:
        raise ValidationError(env._("The requested report is unavailable."))
    if str(report.report_type or "").strip() != "qweb-pdf":
        raise ValidationError(env._("Only QWeb PDF reports can be sent to the Print Gateway."))
    if env.is_superuser():
        return report
    allowed_group_ids = set(report.group_ids.ids)
    if allowed_group_ids and not allowed_group_ids.intersection(env.user.all_group_ids.ids):
        raise AccessError(env._("You are not allowed to view or use this report."))
    return report


DESTINATION_MODELS = [
    ("pos", "POS Receipt"),
    ("pos_printer", "POS Kitchen / Preparation"),
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
        default=lambda self: self.env.company if self.env.company.parent_id else False,
        domain="[('parent_id', '=', company_id)]",
    )
    effective_company_id = fields.Many2one(
        "res.company",
        string="Effective Company",
        compute="_compute_effective_company_id",
        store=True,
        index=True,
    )
    agent_id = fields.Many2one(
        "print_gateway.agent",
        string="Print Agent",
        index=True,
        ondelete="restrict",
        domain="[('company_id', '=', company_id), ('active', '=', True)]",
    )
    runtime_agent_id = fields.Char(
        string="Print Agent UID",
        related="agent_id.agent_uid",
        readonly=True,
        store=False,
    )
    destination_type = fields.Selection(
        DESTINATION_MODELS, string="Destination Type", required=True, default="pos",
    )
    # NOTE: no check_company=True here by design. The binding's company_id is
    # always the ROOT company, but a branch-scoped binding must accept a
    # branch-owned destination (effective_company_id). Odoo's automatic
    # check_company would compare against the root company_id and make branch
    # bindings unsatisfiable. _check_binding() enforces the effective-company
    # rule instead (and still admits company-less global destinations).
    destination_pos_config_id = fields.Many2one(
        "pos.config", string="POS Shop", ondelete="restrict",
        domain="['&', '|', ('company_id', '=', False), ('company_id', '=', effective_company_id), ('active', '=', True)]",
        help="Logical POS destination. The physical printer is selected from the Print Agent printer below.",
    )
    destination_pos_printer_id = fields.Many2one(
        "pos.printer", string="Odoo Preparation Printer", ondelete="restrict",
        help="Native Odoo preparation-printer identity. Its product categories determine which kitchen lines this Direct Odoo binding receives.",
    )
    destination_picking_type_id = fields.Many2one(
        "stock.picking.type", string="Operation Type", ondelete="restrict",
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
        string="Print Agent printer", required=True, index=True, copy=False,
    )
    printer_name = fields.Char(
        string="Gateway Printer Name", index=True,
        help="Human-readable printer name from the Odoo Agent, set automatically "
             "when a printer is picked. The technical identity stays in the "
             "Print Agent printer field and remains the routing key.",
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
            "document (PDF/image) jobs additionally require the Odoo Agent "
            "printer itself to be a document transport. Byte protocols never "
            "wildcard: a 'raw' printer does not accept zpl/tspl/escpos jobs.")
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
        ("epson_pulse", "Epson / ESC-POS Buzzer (0x1B 0x42 0x02 0x02)"),
        ("star_bel", "Star Bell (0x07)"),
    ], string="Kitchen Buzzer", default="none", help="Hardware audio chime.")
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is preferred when multiple bindings are valid.")
    name = fields.Char(compute="_compute_name", store=True)
    printer_is_virtual = fields.Boolean(
        string="Virtual Printer",
        compute="_compute_printer_specs",
        readonly=True,
    )
    printer_capability_summary = fields.Char(
        string="Detected Capabilities",
        compute="_compute_printer_specs",
        readonly=True,
    )

    @api.private
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
    # Regular PostgreSQL UNIQUE constraints allow repeated NULL branch_id.
    # Enforce company-wide print-route priority uniqueness independently.
    _company_wide_priority_unique = models.UniqueIndex(
        "(company_id, destination_ref, document_type, priority) WHERE branch_id IS NULL",
        "Company-wide print routes need distinct priorities for each source and document type.",
    )

    @api.depends("company_id", "branch_id")
    def _compute_effective_company_id(self):
        for record in self:
            record.effective_company_id = record.branch_id or record.company_id


    @api.depends("destination_type", "destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id", "destination_report_id", "report_id")
    def _compute_destination_ref(self):
        for record in self:
            destination = False
            if record.destination_type == "pos":
                destination = record.destination_pos_config_id
            elif record.destination_type == "pos_printer":
                # Native Odoo preparation-printer routing is the authoritative
                # category-aware destination. Keep the POS Shop form as a
                # compatibility fallback for existing legacy bindings.
                destination = record.destination_pos_printer_id or record.destination_pos_config_id
            elif record.destination_type == "picking_type":
                destination = record.destination_picking_type_id
            elif record.destination_type == "report":
                # report_id is the single operator-facing report selector. Keep
                # destination_report_id as a legacy compatibility field only.
                destination = record.report_id or record.destination_report_id
            destination_id = getattr(destination, "id", False) if destination else False
            # Odoo 19 form/onchange records can carry a NewId pseudo-identifier.
            # fields.Reference cannot convert that placeholder to an integer, so
            # keep the computed reference empty until the destination is saved.
            if destination and isinstance(destination_id, int) and destination_id > 0:
                record.destination_ref = "%s,%s" % (destination._name, destination_id)
            else:
                record.destination_ref = False

    @api.depends(
        "report_id", "report_id.model", "report_id.report_name",
        "destination_report_id", "destination_report_id.model",
        "destination_report_id.report_name", "destination_type",
    )
    def _compute_document_type(self):
        for record in self:
            if record.destination_type == "pos":
                record.document_type = "receipt"
            elif record.destination_type == "pos_printer":
                record.document_type = "kitchen"
            elif record.report_id or record.destination_report_id:
                # Legacy rows may still carry only destination_report_id until
                # the 2.10 migration completes. New rows use report_id.
                # Coerce the id fallback to str: an empty report_name would
                # otherwise call .strip() on an int and crash this compute.
                report = record.report_id or record.destination_report_id
                record.document_type = DOCUMENT_TYPE_BY_MODEL.get(report.model, "report:%s" % ((report.report_name or str(report.id)) or "").strip().lower())
            elif record.destination_type == "picking_type":
                # Direct inventory/warehouse operations address label
                # hardware with byte-stream protocols (route_raw_command
                # defaults to document_type="label", and runtime-printer
                # assignment already requires a label/thermal printer here
                # when no report is bound). Without this mode no normal
                # binding can ever match the raw-label automation path.
                record.document_type = "label"
            else:
                record.document_type = False

    @api.depends("company_id", "branch_id", "destination_ref", "document_type", "printer_id", "printer_name")
    def _compute_name(self):
        for record in self:
            record.name = record._formatted_binding_name()

    @api.depends("name", "company_id", "branch_id", "destination_ref", "document_type", "printer_id", "printer_name")
    @api.depends_context("lang")
    def _compute_display_name(self):
        for record in self:
            record.display_name = record._formatted_binding_name(localized=True)

    def _printer_display_label(self):
        """Human-readable printer label for display names.

        Prefers the cached Direct Odoo printer name. When no name was ever
        picked, falls back to a readable label plus only the last 4
        characters of the identity — never the full opaque identity and
        never a leading truncated hash. The full identity stays visible
        in the Printer Identity column/field for support.
        """
        name = (self.printer_name or "").strip()
        if name:
            return name
        raw = (self.printer_id or "").strip()
        if raw:
            suffix = raw[-4:] if len(raw) > 4 else raw
            return "%s …%s" % (_("Unnamed printer"), suffix)
        return _("Printer")

    def _formatted_binding_name(self, *, localized=False):
        self.ensure_one()
        destination = self.destination_ref.display_name if self.destination_ref else _("Destination")
        scope = self.branch_id.display_name if self.branch_id else self.company_id.display_name
        document = self.document_type or _("document")
        if localized:
            document = {
                "order": _("Order"), "invoice": _("Invoice"), "delivery": _("Delivery"),
                "purchase_order": _("Purchase Order"), "receipt": _("Receipt"), "label": _("Label"),
            }.get(self.document_type, document)
        # Human-first order: scope / document / destination -> printer name.
        # The runtime agent id is deliberately NOT part of the display name:
        # it is as opaque as the printer identity, and it stays visible in
        # the list column and the form field.
        return "%s / %s / %s → %s" % (
            scope or _("Odoo Context"), document, destination,
            self._printer_display_label(),
        )

    @api.onchange("destination_type")
    def _onchange_destination_type(self):
        for record in self:
            if record.destination_type not in ("pos", "pos_printer"):
                record.destination_pos_config_id = False
            if record.destination_type != "pos_printer":
                record.destination_pos_printer_id = False
            if record.destination_type != "picking_type":
                record.destination_picking_type_id = False
            if record.destination_type != "report":
                record.destination_report_id = False
            if record.destination_type in ("pos", "pos_printer"):
                record.report_id = False
            elif record.destination_type == "report":
                record.destination_report_id = record.report_id or record.destination_report_id

    @api.onchange("report_id")
    def _onchange_report_id(self):
        for record in self:
            if record.destination_type == "report":
                record.destination_report_id = record.report_id

    @api.onchange("company_id")
    def _onchange_company_id(self):
        for record in self:
            record.branch_id = self.env.company if self.env.company.parent_id == record.company_id else False
            record.agent_id = False
            record.printer_id = False
            record.destination_pos_config_id = False
            record.destination_pos_printer_id = False
            record.destination_picking_type_id = False
            record.destination_report_id = False
            record.report_id = False

    @api.onchange("branch_id")
    def _onchange_branch_id(self):
        for record in self:
            record.agent_id = False
            record.printer_id = False
            record.destination_pos_config_id = False
            record.destination_pos_printer_id = False
            record.destination_picking_type_id = False
            record.destination_report_id = False
            record.report_id = False

    @api.depends("agent_id", "printer_id")
    def _compute_printer_specs(self):
        agent_ids = {r.agent_id.id for r in self if r.agent_id and r.printer_id}
        printer_keys = {r.printer_id for r in self if r.agent_id and r.printer_id}
        by_pair = {}
        if agent_ids and printer_keys:
            printers = self.env["print_gateway.printer"].sudo().search([
                ("agent_id", "in", list(agent_ids)),
                ("printer_key", "in", list(printer_keys)),
            ])
            by_pair = {(p.agent_id.id, p.printer_key): p for p in printers}
        for record in self:
            printer = by_pair.get((record.agent_id.id, record.printer_id)) if (record.agent_id and record.printer_id) else None
            if not printer:
                record.printer_is_virtual = False
                record.printer_capability_summary = False
                continue
            specs = derive_printer_specs(
                name=printer.name,
                connection_type=printer.connection_type,
                protocol=printer.protocol,
                capabilities=printer.capabilities_json,
                geometry=printer.geometry_json,
            )
            record.printer_is_virtual = specs["is_virtual"]
            record.printer_capability_summary = specs["capability_summary"]

    @api.onchange("agent_id")
    def _onchange_agent_id(self):
        for record in self:
            record.runtime_agent_id = record.agent_id.agent_uid if record.agent_id else False
            record.printer_id = False
            record.printer_name = False

    @api.onchange("agent_id", "printer_id")
    def _onchange_printer_id(self):
        printer_model = self.env["print_gateway.printer"].sudo()
        for record in self:
            if not record.agent_id or not record.printer_id:
                continue
            printer = printer_model.search([
                ("agent_id", "=", record.agent_id.id),
                ("printer_key", "=", record.printer_id),
            ], limit=1)
            if not printer:
                continue
            if printer.name:
                record.printer_name = printer.name
            specs = derive_printer_specs(
                name=printer.name,
                connection_type=printer.connection_type,
                protocol=printer.protocol,
                capabilities=printer.capabilities_json,
                geometry=printer.geometry_json,
            )
            if specs["recommended_protocol"] and specs["recommended_protocol"] != "unknown":
                record.printer_protocol = specs["recommended_protocol"]

    def _get_print_config(self):
        self.ensure_one()
        # When a branch is set, the company_id is the branch's company which may
        # not have its own gateway config. Fall back to the root company.
        if self.branch_id and self.company_id.parent_id:
            root_company = self.company_id.parent_id
        else:
            root_company = self.company_id
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", root_company.id)], limit=1)
        if not config:
            raise ValidationError(_("A Print Service configuration is required for this Odoo Company."))
        return config

    @api.model
    def _canonical_runtime_printer_protocol(self, printer):
        """Resolve a protocol only when its physical backend can execute it.

        A network/9100 byte stream mislabelled as ``spooler`` is not a
        Windows driver and must not pass Odoo binding validation. A legacy
        USB-backed Windows queue is explicitly supported for compatibility.
        """
        if not isinstance(printer, dict):
            return "unknown"
        connection_type = str(printer.get("connectionType") or "").strip().lower()
        protocol = str(printer.get("protocol") or "").strip().lower()
        # Normalize legacy Windows aliases ONLY for a real installed spooler
        # transport. A TCP byte stream claiming this protocol never becomes a
        # Windows document renderer as a side effect.
        if connection_type == "windows_spooler":
            connection_type = "spooler"
        if protocol == "windows_spooler" and connection_type == "spooler":
            protocol = "spooler"
        if connection_type == "virtual":
            if protocol in ("escpos", "zpl", "tspl", "raw", "ipp", "ipps"):
                return protocol
            return "spooler"
        if connection_type == "spooler":
            # A Windows queue is still the transport for supported RAW/ESC-POS
            # pass-through modes; binding capability validation decides which
            # protocols are allowed for the selected queue.
            return "spooler"
        if connection_type in ("ipp", "ipps"):
            return connection_type
        if connection_type not in ("network", "usb"):
            caps = printer.get("capabilities")
            if isinstance(caps, dict) and (caps.get("is_virtual") or caps.get("isVirtual")):
                return "spooler"
            return "unknown"
        if protocol in ("escpos", "zpl", "tspl", "raw"):
            return protocol
        if connection_type == "network" and protocol in ("ipp", "ipps"):
            return protocol
        if connection_type == "usb" and protocol in ("spooler", "windows_spooler"):
            return "spooler"
        return "unknown"

    @api.model
    def _runtime_printer_accepts_image(self, printer):
        if not isinstance(printer, dict):
            return False
        conn = str(printer.get("connectionType") or "").strip().lower()
        proto = self._canonical_runtime_printer_protocol(printer)
        if proto == "spooler":
            # Native PDFs may use this same business binding and let the
            # Windows driver choose document media. The client-rendered JPEG
            # route separately requires a full physical geometry snapshot.
            return conn in ("spooler", "windows_spooler", "usb", "virtual")
        caps = printer.get("capabilities")
        geometry = validated_printer_geometry(
            caps.get("geometry") if isinstance(caps, dict) else None, printer.get("id"),
        )
        has_width_fallback = isinstance(caps, dict) and isinstance(caps.get("paper_width_mm"), (int, float)) and 40 <= caps.get("paper_width_mm") <= 120
        if conn not in ("network", "usb") or proto != "escpos":
            return False
        if not ((geometry and geometry.get("raster_command") == "gs_v_0") or has_width_fallback):
            return False
        raw = caps.get("supported_protocols") if isinstance(caps, dict) else None
        # The measured profile explicitly declares the supported raster
        # command. An optional format list may further restrict this path.
        if raw is None and (not isinstance(caps, dict) or "supported_protocols" not in caps):
            return True
        if not isinstance(raw, list):
            return False
        return bool({"image", "jpeg", "escpos"} & {
            value.strip().lower() for value in raw if isinstance(value, str)
        })

    @api.model
    def _runtime_supported_protocols(self, printer):
        if not isinstance(printer, dict):
            return set()
        capabilities = printer.get("capabilities") if isinstance(printer.get("capabilities"), dict) else {}
        values = capabilities.get("supported_protocols")
        if not isinstance(values, list):
            return set()
        allowed = {"pdf", "image", "raw", "escpos", "zpl", "tspl", "spooler", "ipp", "ipps"}
        return {str(value).strip().lower() for value in values if isinstance(value, str) and str(value).strip().lower() in allowed}

    def _validate_binding_protocol_against_runtime(self, printer):
        """Validate selected binding protocol against physical transport facts.

        The runtime printer's primary protocol describes its transport/backend.
        A Windows spooler may additionally permit RAW or ESC/POS passthrough,
        but only when that byte language is explicitly declared in capabilities.
        This method never rewrites the binding as a side effect.
        """
        self.ensure_one()
        selected = str(self.printer_protocol or "").strip().lower()
        runtime_protocol = self._canonical_runtime_printer_protocol(printer)
        supported = self._runtime_supported_protocols(printer)

        if not selected:
            raise ValidationError(_("A print protocol must be selected on the binding."))
        if runtime_protocol == "unknown":
            raise ValidationError(_(
                "The selected printer does not declare a printable protocol. Windows-installed printers should use the spooler connection; direct USB/network printers must declare their real printer language before a test can be sent."
            ))
        if selected == runtime_protocol:
            return True
        if runtime_protocol == "spooler" and selected in ("raw", "escpos"):
            if selected in supported:
                return True
            if selected == "escpos":
                raise ValidationError(_(
                    "This printer is configured for Windows document spooling and has not been declared as ESC/POS-capable. Enable ESC/POS passthrough explicitly on the Direct Odoo printer only if the Windows queue/driver is configured to accept ESC/POS bytes."
                ))
            raise ValidationError(_(
                "This printer is configured for Windows document spooling and has not been declared as RAW-capable. Enable RAW passthrough explicitly on the Direct Odoo printer only if the Windows queue/driver is configured to accept raw bytes."
            ))
        raise ValidationError(_(
            "The selected binding protocol '%s' is not compatible with runtime printer '%s' (transport protocol '%s'). Update the binding or the printer's explicit capability configuration."
        ) % (selected, self.printer_id, runtime_protocol))

    def _validate_runtime_target(self, *, enforce_destination_compatibility=True):
        """Resolve the selected Agent and printer from Odoo's local inventory.

        There is no Cloud inventory lookup or printer-certification gate in
        Direct Odoo mode. A binding needs an assigned active Agent, a printer
        reported by that Agent, and a declared transport protocol.
        """
        self.ensure_one()
        if not self.agent_id:
            raise ValidationError(_('Select a Print Agent for this binding.'))
        config = self._get_print_config()
        assignment_model = self.env['print_gateway.runtime_agent_assignment']
        if not assignment_model.is_agent_assigned(config.company_id, self.branch_id, self.agent_id.agent_uid):
            raise ValidationError(_('The selected Agent is not assigned to the current Odoo scope.'))

        agent = self.agent_id.exists()
        if not agent or not agent.active or agent.company_id != config.company_id:
            raise ValidationError(_('The selected Print Agent is not active in this Odoo Company.'))

        printer = self.env['print_gateway.printer'].sudo().search([
            ('agent_id', '=', agent.id),
            ('printer_key', '=', self.printer_id),
            ('available_to_odoo', '=', True),
        ], limit=1)
        if not printer:
            raise ValidationError(_('The selected printer is not available from this Print Agent. Refresh the Agent inventory and try again.'))

        capabilities = _parse_json_dict(printer.capabilities_json)
        selected_printer = {
            'id': printer.printer_key,
            'name': printer.name,
            'status': printer.status or 'unknown',
            'protocol': printer.protocol or 'unknown',
            'connectionType': printer.connection_type or 'unknown',
            'availableToOdoo': bool(printer.available_to_odoo),
            'capabilities': capabilities,
        }
        self._validate_binding_protocol_against_runtime(selected_printer)
        if enforce_destination_compatibility:
            if self.destination_type in ('pos', 'pos_printer') and not self._runtime_printer_accepts_image(selected_printer):
                raise ValidationError(_(
                    'POS receipt and kitchen printing require a compatible image transport. Use a Windows spooler or a printer configured for a supported raster protocol.'
                ))
            device_class = str(capabilities.get('deviceClass') or capabilities.get('device_class') or '').strip().lower()
            if self.destination_type == 'picking_type' and device_class in ('laser', 'inkjet') and not self.report_id:
                raise ValidationError(_('Direct warehouse operations require a label or thermal printer.'))
        return selected_printer


    @api.constrains("report_id")
    def _check_automation_reports(self):
        # A rule edit must not invalidate an automation owned by another allowed branch.
        self.env["print_gateway.policy"].sudo().with_context(active_test=False).search([
            ("binding_id", "in", self.ids), ("action_type", "=", "report"),
        ])._check_action_configuration()

    @api.constrains("company_id", "branch_id")
    def _check_company_hierarchy(self):
        for record in self:
            if record.branch_id and record.branch_id == record.company_id:
                raise ValidationError(_("Odoo Branch must be a child Branch, not the selected root Company."))
            if record.company_id.parent_id:
                raise ValidationError(_("Odoo Company must be a root Company, not a Branch."))
            if record.branch_id and record.branch_id.parent_id != record.company_id:
                raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))

    @api.constrains("company_id", "branch_id", "agent_id", "printer_id")
    def _check_runtime_scope(self):
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        is_su = getattr(self.env, "is_superuser", lambda: False)()
        user_companies = getattr(getattr(self.env, "user", None), "company_ids", None)
        for record in self:
            if not record.branch_id and (
                record.company_id not in self.env.companies
                or (not is_su and user_companies is not None and record.company_id not in user_companies)
            ):
                raise ValidationError(_("The selected Odoo Company is not available to the current user."))
            if not record.agent_id or not record.agent_id.active or record.agent_id.company_id != record.company_id:
                raise ValidationError(_("Select an active Print Agent belonging to this Odoo Company."))
            if record.branch_id:
                if record.branch_id not in self.env.companies or (
                    not is_su and user_companies is not None and record.branch_id not in user_companies
                ):
                    raise ValidationError(_("Odoo Branch is not available to the current user."))

            if record.agent_id and not assignment_model.is_agent_assigned(
                record.company_id, record.branch_id, record.agent_id.agent_uid
            ):
                scope_label = record.branch_id.display_name if record.branch_id else record.company_id.display_name
                raise ValidationError(
                    _("Print Agent '%s' is not explicitly assigned to '%s'. "
                      "Assign the Agent to this exact Odoo scope before creating the binding.")
                    % (record.agent_id.agent_uid, scope_label)
                )

    @api.constrains("destination_type", "destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id", "destination_report_id", "report_id", "printer_id", "printer_protocol", "company_id", "branch_id", "effective_company_id")
    def _check_binding(self):
        for record in self:
            # Binding IDs are opaque physical targets, never labels to strip.
            # Reject wrong-typed, padded and non-UTF-8 IDs at ORM write time.
            if not is_exact_printer_key(record.printer_id):
                raise ValidationError(_("A valid Print Agent printer must be selected."))
            destination = record.destination_ref
            if not destination:
                raise ValidationError(_("A valid Odoo Destination is required."))
            expected_company = record.effective_company_id
            destination_company = getattr(destination, "company_id", False)
            if destination_company and destination_company != expected_company:
                raise ValidationError(_("Odoo Destination belongs to another company/branch context."))
            if record.report_id and getattr(record.report_id, "company_id", False) and record.report_id.company_id != expected_company:
                raise ValidationError(_("Document / Report belongs to another company/branch context."))
            if record.destination_type == "pos":
                if not record.destination_pos_config_id:
                    raise ValidationError(_("A POS Shop is required for a POS Receipt binding."))
                if record.destination_pos_printer_id:
                    raise ValidationError(_("POS Receipt bindings must not select an Odoo Kitchen Printer."))
                if record.report_id:
                    raise ValidationError(_("POS Receipt bindings must not select an Odoo Report; the receipt is rendered by the POS client."))
            elif record.destination_type == "pos_printer":
                if not record.destination_pos_config_id and not record.destination_pos_printer_id:
                    raise ValidationError(_("An Odoo Preparation Printer or POS Shop is required for a POS Kitchen / Preparation binding."))
                if record.destination_pos_printer_id:
                    printer = record.destination_pos_printer_id
                    printer_configs = printer.pos_config_ids
                    preparation_configs = printer_configs.filtered(
                        lambda config: printer in (
                            getattr(config, "preparation_printer_ids", None)
                            if getattr(config, "preparation_printer_ids", None) is not None
                            else config.printer_ids
                        )
                    )
                    if not preparation_configs:
                        raise ValidationError(_("Odoo Preparation Printer must belong to an Odoo POS Preparation Printer configuration."))
                    if printer_configs and expected_company not in printer_configs.mapped("company_id"):
                        raise ValidationError(_("Odoo Preparation Printer is not available to the selected Odoo Branch."))
                if record.report_id:
                    raise ValidationError(_("POS Kitchen / Preparation bindings must not select an Odoo Report."))
            elif record.destination_type == "report":
                if not record.report_id:
                    raise ValidationError(_("A Report must be selected for this Destination Type."))
                if record.destination_report_id and record.destination_report_id != record.report_id:
                    raise ValidationError(_("Report destination and report document must be the same record."))
            elif record.destination_type == "picking_type":
                # A picking operation has two distinct modes. With a report,
                # the binding retains its QWeb document identity. Without one,
                # it is the raw-label destination selected by route_raw_command
                # (document_type='label'). A document transport/unknown
                # protocol must never be saved as a byte-stream label target.
                if not record.report_id:
                    if record.destination_report_id:
                        raise ValidationError(_("A raw label binding must not reference an Odoo Report."))
                    if record.printer_protocol not in ("zpl", "tspl", "escpos", "raw"):
                        raise ValidationError(_(
                            "A raw label binding requires an explicitly declared ZPL, TSPL, ESC/POS, or raw printer protocol."
                        ))
            elif not record.report_id:
                raise ValidationError(_("A real Odoo report must be selected for this Destination Type."))
            if record.report_id and record.report_id.model == "pos.order" and record.destination_type not in ("pos", "report"):
                raise ValidationError(_("POS receipts must use a POS or report destination."))
            if record.report_id and record.report_id.model == "stock.picking" and record.destination_type not in ("picking_type", "report"):
                raise ValidationError(_("Stock reports must use an operation type or report destination."))
            # Exact printer identity is checked at the start of this constraint.

    def action_send_test_print(self):
        """Construct a standardized diagnostic test page and submit via the Outbox pipeline."""
        self.ensure_one()
        # A test page causes a PHYSICAL print side effect; the ordinary view has no
        # customer test-page button, but this RPC still needs an authoritative guard
        # (the method is RPC-callable and binding ACLs are read-only for
        # internal users, which would otherwise never fire here).
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can dispatch test pages."))
        self._validate_runtime_target(enforce_destination_compatibility=False)
        router = self.env["print_gateway.print_router"]
        res = router.route_test_page(self)
        status = res.get("status")
        # A committed Odoo outbox is not proof of Odoo Agent claim or of
        # paper output. Unknown/lost responses must not suggest safe reprint.
        notice_type = (
            "danger" if status == "failed"
            else "warning" if status not in ("claimed", "printing", "success")
            else "info"
        )
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Test Print Failed") if notice_type == "danger" else (
                    _("Test Print Pending / Uncertain") if notice_type == "warning" else _("Test Print In Progress")
                ),
                "message": res.get("message") or (
                    _("Diagnostic test job queued; check Print Activity before retrying.")
                    if status == "queued" else
                    _("Diagnostic test print status unknown; check the printer and Print Activity before retrying.")
                    if notice_type == "warning" else
                    _("Diagnostic test job failed; check Print Activity.")
                    if notice_type == "danger" else
                    _("Diagnostic test job admitted for printer '%s'; paper output is not confirmed.") % self.printer_id
                ),
                "type": notice_type,
                "sticky": notice_type in ("warning", "danger"),
            },
        }


    # create/write/unlink are inherited from base; no overrides needed.
    @api.model
    @api.private
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
    @api.private
    def resolve_explicit(self, binding, company, document_type, destination, *, report=None, branch=None, protocol=None, payload_type=None):
        """Validate and return the exact caller-selected binding; never reprioritize it."""
        binding = binding.exists()
        if not binding or len(binding) != 1:
            raise ValidationError(_("The explicitly selected print binding no longer exists."))
        normalized = (document_type or "").strip().lower()
        if not binding.enabled:
            raise ValidationError(_("The explicitly selected print binding is disabled."))
        # An unset Many2one is an empty recordset, not the Python False
        # sentinel used by root-company callers. Company-wide rules also
        # remain valid fallbacks for a branch; sibling-specific rules do not.
        branch_matches = not binding.branch_id or binding.branch_id == branch
        if binding.company_id != company or not branch_matches:
            raise ValidationError(_("The explicitly selected print binding is not scoped to the current company and branch."))
        if report and binding.report_id != report:
            raise ValidationError(_("The explicitly selected print binding does not match this report action."))
        if binding.destination_ref != destination or binding.document_type != normalized:
            raise ValidationError(_("The explicitly selected print binding does not match this destination and document type."))
        if not (binding.agent_id.agent_uid if binding.agent_id else False) or not binding.printer_id:
            raise ValidationError(_("The explicitly selected print binding has no routable runtime and printer."))
        if protocol and binding.printer_protocol != protocol:
            raise ValidationError(_("The explicitly selected print binding does not support protocol '%s'.") % protocol)
        # PDF requires a spooler or IPP/IPPS queue capable of document
        # rasterization/rendering. JPEG raster banding additionally accepts
        # ESC/POS (the agent raster-converts for ESC/POS-capable devices) -
        # mirroring the Odoo Agent physicalImage rule in src/lib/routing.ts and
        # the pre-dispatch failover parity in print_job (raster_jpeg allows
        # spooler/escpos). Direct stream protocols (raw) remain excluded.
        if payload_type == "pdf" and binding.printer_protocol not in ("spooler", "ipp", "ipps"):
            raise ValidationError(_("The explicitly selected print binding is not capable of document printing."))
        if payload_type == "raster_jpeg" and binding.printer_protocol not in ("spooler", "escpos"):
            raise ValidationError(_("The explicitly selected print binding is not capable of document printing."))
        return binding

    @api.model
    @api.private
    def find_for(self, company, document_type, report=None, record=None, explicit_destination=None, branch=None):
        normalized = (document_type or "").strip().lower()
        if not normalized:
            raise ValidationError(_("Print document type is required."))
        # One report must never select a binding intended for another report,
        # even when both reports render the same record/operation/document type.
        # A report-specific action may be bound to either its operational
        # destination (e.g. stock.picking.type) OR to ir.actions.report itself.
        # Search the exact report identity in both cases, in explicit order.
        if record and getattr(record, "company_id", False):
            expected_company = branch or company
            if record.company_id != expected_company:
                raise ValidationError(_("Printable record belongs to another Odoo company/branch context."))
        destinations = []
        if explicit_destination:
            destinations.append(explicit_destination)
        else:
            if record:
                # Preserve the destination produced by legacy stock/POS
                # routing, but never let that override report identity.
                try:
                    destinations.append(self.destination_for(record=record))
                except ValidationError:
                    if not report:
                        raise
            if report and report not in destinations:
                destinations.append(report)
        if not destinations:
            destinations.append(self.destination_for(record=record, report=report))
        report_id = report.id if report else False
        for selected_branch in (branch, False) if branch else (False,):
            for destination in destinations:
                destination_company = getattr(destination, "company_id", False)
                # An operational destination owned by a branch cannot be
                # silently re-routed via a root-scoped binding.
                if destination_company and destination_company != (branch or company):
                    raise ValidationError(_("Print destination belongs to another Odoo company/branch context."))
                if selected_branch is False and branch and destination_company == branch:
                    continue
                domain = [
                    ("company_id", "=", company.id), ("enabled", "=", True),
                    ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
                    ("document_type", "=", normalized),
                    ("report_id", "=", report_id),
                    ("branch_id", "=", selected_branch.id if selected_branch else False),
                ]
                selected = self.search(domain, order="priority asc, id asc", limit=1)
                if selected:
                    return selected
        return self.browse()

    @api.model
    def dispatch_report_action(self, report_name=None, report_id=None, res_ids=None, context=None, data=None, operation_id=None):
        # Server-side allowlist for caller-supplied
        # RPC context. The web client passes action.context through here
        # (report_interceptor.js), so a wholesale merge would let an RPC
        # caller steer company scope (allowed_company_ids), smuggle the
        # print service skip key (skip_enabled_sync) or the intent
        # lease-recovery key (allow_lease_recovery) into this environment.
        # Both skip/lease escapes stay superuser-gated at their own write()
        # sites (print configuration, print_intent.py) and are never honoured
        # from dispatch context. Only rendering-locale keys (lang, tz) and
        # the document-type override survive; company scope always comes
        # from the ambient session company via _binding_scope().
        context = _sanitize_dispatch_context(context)
        binding_model = self.with_context(**context)
        report = False
        if report_id is not None and report_id is not False:
            if type(report_id) is int:
                exact_report_id = report_id
            elif (isinstance(report_id, str) and report_id.isascii()
                  and report_id.isdecimal() and len(report_id) <= 19):
                exact_report_id = int(report_id)
            else:
                raise ValidationError(_("Invalid report identity."))
            if not 0 < exact_report_id <= 2**63 - 1:
                raise ValidationError(_("Invalid report identity."))
            report = binding_model.env["ir.actions.report"].browse(exact_report_id).exists()
            if not report:
                raise ValidationError(_("The requested report is unavailable."))
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
        config = router._print_config(binding_model.env.company)
        if not config:
            return {"dispatched": False, "has_binding": False}

        try:
            gateway_company, branch = router._binding_scope(binding_model.env.company)
            dtype = router._document_type(report=report, record=records[0] if records else None)
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
            route = router.route_report(report, records, data=data, explicit_binding=binding, idempotency_key=operation_id)
            if route.get("native"):
                return {"dispatched": False, "has_binding": False, "success": False}

            status = route.get("status") or "unknown"
            # ``dispatched`` here means the durable Odoo print operation was
            # committed. It is NOT a physical printing-success indicator.
            return {
                "dispatched": True,
                "success": status in ("claimed", "printing", "success"),
                "has_binding": True,
                "status": status,
                "job_id": route.get("job_id"),
                "printer_name": route.get("printer_id") or binding.printer_id,
                "message": route.get("message") or _("Print result is pending or uncertain; check Print Activity."),
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
                        "error": billing_limit.get("message") or _("This print operation is blocked by the current subscription plan limit."),
                        "billing_limit": billing_limit,
                        "fail_closed": True,
                    }

            # Keep the original failure detail in the server log (with the
            # traceback) so an operator can diagnose a routing/dispatch
            # failure. The client-facing message stays generic: it is a
            # user-facing statement about an uncertain outcome, and the
            # exception text can contain internals that must not reach the
            # browser.
            _logger.warning("Failed to execute silent print route: %s", exc, exc_info=True)
            return {
                "dispatched": False,
                "success": False,
                "has_binding": True,
                "status": "unknown",
                "error": _("Print dispatch outcome is uncertain. The document may have reached the Odoo Agent; check Print Activity and the printer before retrying."),
                "fail_closed": True,
            }
