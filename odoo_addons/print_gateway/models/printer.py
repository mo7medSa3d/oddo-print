# -*- coding: utf-8 -*-
import json
import math

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .print_config import check_license_limits

_VIRTUAL_NAME_MARKERS = (
    "microsoft print to pdf",
    "microsoft xps document writer",
    "cups-pdf",
    "print to file",
    "pdfcreator",
    "save as pdf",
    "foxit pdf",
    "adobe pdf",
    "cutepdf",
    "bullzip",
    "nitro pdf",
    "pdf24",
    "dopdf",
    "virtual",
)

_PROTOCOL_LABELS = {
    "escpos": "ESC/POS",
    "zpl": "ZPL",
    "tspl": "TSPL",
    "raw": "RAW",
    "spooler": "Spooler",
    "ipp": "IPP",
    "ipps": "IPPS",
}


def _parse_json_dict(raw):
    if isinstance(raw, dict):
        return raw
    if not raw or not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _positive_float(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    val = float(value)
    if not math.isfinite(val) or val <= 0:
        return 0.0
    return round(val, 1)


def _positive_int(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    val = float(value)
    if not math.isfinite(val) or val <= 0:
        return 0
    return int(round(val))


def derive_printer_specs(name="", connection_type="", protocol="", capabilities=None, geometry=None):
    """Auto-compute normalized hardware/virtual printer specs from synced metadata."""
    caps = _parse_json_dict(capabilities)
    geom = _parse_json_dict(geometry) or _parse_json_dict(caps.get("geometry"))

    conn = str(connection_type or "").strip().lower()
    proto = str(protocol or "").strip().lower()
    name_lower = str(name or "").strip().lower()

    printer_type = str(caps.get("printer_type") or caps.get("printerType") or "").strip().lower()
    is_virtual = bool(
        caps.get("is_virtual")
        or caps.get("isVirtual")
        or printer_type == "virtual"
        or conn == "virtual"
        or proto == "virtual"
        or any(marker in name_lower for marker in _VIRTUAL_NAME_MARKERS)
    )

    paper_width_mm = (
        _positive_float(geom.get("paper_width_mm"))
        or _positive_float(caps.get("paper_width_mm"))
        or _positive_float(caps.get("paperWidthMm"))
    )
    dpi = (
        _positive_int(geom.get("dpi_x"))
        or _positive_int(geom.get("dpi"))
        or _positive_int(caps.get("dpi"))
        or _positive_int(caps.get("dpi_x"))
    )
    dots_per_line = (
        _positive_int(geom.get("printable_width_dots"))
        or _positive_int(geom.get("dots_per_line"))
        or _positive_int(caps.get("dots_per_line"))
        or _positive_int(caps.get("dotsPerLine"))
    )
    if not dots_per_line and paper_width_mm > 0 and dpi > 0:
        dots_per_line = int(round((paper_width_mm / 25.4) * dpi))

    norm_conn = "spooler" if conn == "windows_spooler" else conn
    norm_proto = "spooler" if proto == "windows_spooler" and norm_conn == "spooler" else proto
    if norm_conn == "virtual":
        recommended_protocol = norm_proto if norm_proto in ("escpos", "zpl", "tspl", "raw", "ipp", "ipps") else "spooler"
    elif norm_conn == "spooler":
        recommended_protocol = "spooler"
    elif norm_conn in ("ipp", "ipps"):
        recommended_protocol = norm_conn
    elif norm_conn in ("network", "usb"):
        if norm_proto in ("escpos", "zpl", "tspl", "raw"):
            recommended_protocol = norm_proto
        elif norm_conn == "network" and norm_proto in ("ipp", "ipps"):
            recommended_protocol = norm_proto
        elif norm_conn == "usb" and norm_proto in ("spooler", "windows_spooler"):
            recommended_protocol = "spooler"
        else:
            recommended_protocol = "unknown"
    elif is_virtual:
        recommended_protocol = "spooler"
    else:
        recommended_protocol = "unknown"

    parts = []
    if is_virtual:
        parts.append("Virtual")
    proto_label = _PROTOCOL_LABELS.get(recommended_protocol)
    if proto_label:
        parts.append(proto_label)
    if paper_width_mm > 0:
        width_str = f"{int(paper_width_mm)}" if paper_width_mm == int(paper_width_mm) else f"{paper_width_mm:.1f}"
        parts.append(f"{width_str}mm")
    if dots_per_line > 0:
        parts.append(f"{dots_per_line} dots")
    if dpi > 0:
        parts.append(f"{dpi} DPI")
    capability_summary = " · ".join(parts) if parts else "Auto"

    return {
        "is_virtual": is_virtual,
        "paper_width_mm": paper_width_mm,
        "dots_per_line": dots_per_line,
        "dpi": dpi,
        "recommended_protocol": recommended_protocol,
        "capability_summary": capability_summary,
    }


class PrintGatewayPrinter(models.Model):
    _name = "print_gateway.printer"
    _description = "Direct Odoo Agent Printer Inventory"
    _order = "name asc, id asc"

    agent_id = fields.Many2one("print_gateway.agent", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="agent_id.company_id", store=True, index=True, readonly=True)
    printer_key = fields.Char(required=True, index=True)
    name = fields.Char(required=True)
    connection_type = fields.Char(default="spooler")
    protocol = fields.Char(default="spooler")
    status = fields.Selection(
        [
            ("online", "Online"),
            ("busy", "Busy"),
            ("offline", "Offline"),
            ("error", "Error"),
            ("unknown", "Unknown"),
        ],
        default="unknown",
        required=True,
    )
    available_to_odoo = fields.Boolean(default=True, index=True)
    capabilities_json = fields.Text()
    geometry_json = fields.Text()
    last_seen_at = fields.Datetime(index=True)

    # Auto-computed technical specifications derived from synced agent metadata
    is_virtual = fields.Boolean(string="Virtual Printer", compute="_compute_printer_specs", readonly=True)
    paper_width_mm = fields.Float(string="Paper Width (mm)", compute="_compute_printer_specs", readonly=True)
    dots_per_line = fields.Integer(string="Dots per Line", compute="_compute_printer_specs", readonly=True)
    dpi = fields.Integer(string="DPI", compute="_compute_printer_specs", readonly=True)
    recommended_protocol = fields.Char(string="Default Protocol", compute="_compute_printer_specs", readonly=True)
    capability_summary = fields.Char(string="Capabilities", compute="_compute_printer_specs", readonly=True)

    _printer_agent_key_uniq = models.Constraint(
        "unique(agent_id, printer_key)",
        "Printer key must be unique per agent.",
    )

    @api.depends("name", "connection_type", "protocol", "capabilities_json", "geometry_json")
    def _compute_printer_specs(self):
        for record in self:
            specs = derive_printer_specs(
                name=record.name,
                connection_type=record.connection_type,
                protocol=record.protocol,
                capabilities=record.capabilities_json,
                geometry=record.geometry_json,
            )
            record.is_virtual = specs["is_virtual"]
            record.paper_width_mm = specs["paper_width_mm"]
            record.dots_per_line = specs["dots_per_line"]
            record.dpi = specs["dpi"]
            record.recommended_protocol = specs["recommended_protocol"]
            record.capability_summary = specs["capability_summary"]

    def init(self):
        super().init()
        # Composite indexes for hot agent heartbeat/claim joins and router printer checks.
        self.env.cr.execute(
            """
            CREATE INDEX IF NOT EXISTS print_gateway_printer_agent_avail_idx
            ON print_gateway_printer (agent_id, available_to_odoo, printer_key)
            """
        )
        self.env.cr.execute(
            """
            CREATE INDEX IF NOT EXISTS print_gateway_printer_company_key_idx
            ON print_gateway_printer (company_id, printer_key)
            """
        )

    def _enforce_printer_limit(self, additional_count):
        if additional_count <= 0:
            return
        self.env.cr.execute("SELECT pg_advisory_xact_lock(hashtext('print_gateway_printer_limit'))")
        self.env.cr.execute(
            """
            SELECT count(*)
              FROM print_gateway_printer pr
              JOIN print_gateway_agent a ON a.id = pr.agent_id
             WHERE a.active = TRUE
               AND pr.available_to_odoo = TRUE
            """
        )
        current_active = int(self.env.cr.fetchone()[0] or 0)
        projected = current_active + additional_count
        icp = self.env["ir.config_parameter"].sudo()
        ok, reason, bundle = check_license_limits(icp, active_printers=projected)
        if not ok:
            max_p = int(((bundle or {}).get("payload") or {}).get("max_printers") or 0)
            if reason == "max_printers_exceeded" and max_p > 0:
                raise ValidationError(
                    _("Printer limit reached (%(current)s / %(max)s). Unshare or disable another printer before enabling this one.")
                    % {"current": current_active, "max": max_p}
                )
            raise ValidationError(_("Cannot enable printer because license check failed (%s).") % reason)

    @api.model_create_multi
    def create(self, vals_list):
        if not (self.env.is_superuser() and self.env.context.get("skip_printer_limit_check")):
            agent_ids = {
                v["agent_id"] for v in vals_list
                if v.get("available_to_odoo", True) and v.get("agent_id")
            }
            if agent_ids:
                active_ids = set(
                    self.env["print_gateway.agent"].sudo().browse(list(agent_ids)).filtered("active").ids
                )
                adding = sum(
                    1 for v in vals_list
                    if v.get("available_to_odoo", True) and v.get("agent_id") in active_ids
                )
                self._enforce_printer_limit(adding)
        return super().create(vals_list)

    def write(self, vals):
        if vals.get("available_to_odoo") is True and not (self.env.is_superuser() and self.env.context.get("skip_printer_limit_check")):
            to_enable = self.filtered(lambda r: not r.available_to_odoo and r.agent_id.active)
            self._enforce_printer_limit(len(to_enable))
        return super().write(vals)
