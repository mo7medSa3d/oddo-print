# -*- coding: utf-8 -*-
"""Print Policy engine for event-driven automated print dispatch."""

import logging
import string

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError
from odoo.tools.safe_eval import safe_eval

_logger = logging.getLogger(__name__)


EVENT_TYPES = [
    ("picking_validated", "Stock Picking Validated"),
    ("invoice_posted", "Customer Invoice / Bill Posted"),
    ("pos_order_paid", "Point of Sale Order Paid"),
]


def is_in_test_mode(env):
    """Return True when Odoo's test harness is active."""
    try:
        from odoo import tools
        return bool(
            tools.config.get("test_enable")
            or getattr(env.registry, "in_test", False)
            or (hasattr(env.registry, "in_test_mode") and env.registry.in_test_mode())
        )
    except Exception:
        return False


def sanitize_raw_value(value, protocol):
    """Keep Odoo field values inert inside protocol command templates."""
    text = "" if value is False or value is None else str(value)
    protocol = str(protocol or "").strip().lower()
    if protocol == "zpl":
        return "".join(ch for ch in text if ch not in "^~" and (ch >= " " or ch in "\n\t")).strip()[:200]
    if protocol == "tspl":
        return "".join(ch for ch in text if ch not in '"\r\n' and (ch >= " " or ch == "\t")).strip()[:200]
    # ESC/POS values are text inside a command stream; remove C0 controls
    # and DEL so an embedded ESC/control byte cannot create a new command.
    return "".join(ch for ch in text if ch != "\x7f" and ch >= " ").strip()[:200]


class PrintGatewayPolicy(models.Model):
    _name = "print_gateway.policy"
    _description = "Print Gateway Dispatch Policy"
    _order = "priority asc, id asc"

    name = fields.Char(string="Policy Name", required=True)
    active = fields.Boolean(default=True)
    company_id = fields.Many2one(
        "res.company", string="Odoo Company", required=True,
        default=lambda self: self.env.company.parent_id or self.env.company, ondelete="restrict",
        domain="[('parent_id', '=', False)]",
    )
    branch_id = fields.Many2one(
        "res.company", string="Odoo Branch", ondelete="restrict", index=True,
        domain="[('parent_id', '=', company_id)]",
    )
    effective_company_id = fields.Many2one(
        "res.company", string="Effective Company",
        compute="_compute_effective_company_id", store=True, index=True,
    )
    model_id = fields.Many2one(
        "ir.model", string="Target Model", required=True, ondelete="cascade",
    )
    model_name = fields.Char(related="model_id.model", string="Model Name", readonly=True)
    event_type = fields.Selection(
        EVENT_TYPES, string="Trigger Event", required=True, index=True,
    )
    domain_filter = fields.Char(
        string="Domain Filter",
        help="Optional domain filter expression evaluated against the triggering record, e.g. [('picking_type_code', '=', 'outgoing')]",
    )
    action_type = fields.Selection([
        ("report", "QWeb PDF Report"),
        ("raw_template", "Raw Command / Label Template"),
    ], string="Action Type", default="report", required=True)
    report_id = fields.Many2one(
        "ir.actions.report", string="Report Action", ondelete="restrict",
        domain="[('model', '=', model_name)]",
        help="Standard QWeb report to render into PDF.",
    )
    raw_protocol = fields.Selection([
        ("zpl", "Zebra ZPL-II"),
        ("tspl", "TSC TSPL"),
        ("escpos", "ESC/POS"),
        # "raw" = opaque byte passthrough (no language framing). It is the
        # router's fallback for pre-encoded streams; the Gateway accepts it
        # (route_raw_command allows zpl/tspl/escpos/raw) so the policy
        # selection must offer it too.
        ("raw", "Raw passthrough"),
    ], string="Raw Protocol", default="zpl")
    raw_template = fields.Text(
        string="Raw Command Template",
        help="Raw printer command string with optional {<field>} placeholders (bare field names only, e.g. {name}). Dotted paths like {record.name} are not allowed.",
    )
    binding_id = fields.Many2one(
        "print_gateway.binding", string="Target Binding", ondelete="restrict",
        domain="[('company_id', '=', company_id), ('branch_id', '=', branch_id)]",
        help="Optional explicit Print Rule for this exact Odoo Company and Branch scope.",
    )
    warehouse_id = fields.Many2one(
        "stock.warehouse", string="Warehouse Filter", ondelete="restrict",
        domain="['|', ('company_id', '=', False), ('company_id', '=', effective_company_id)]",
    )
    picking_type_id = fields.Many2one(
        "stock.picking.type", string="Operation Type Filter", ondelete="restrict",
        domain="['|', ('company_id', '=', False), ('company_id', '=', effective_company_id)]",
    )
    priority = fields.Integer(default=10, help="Lower numbers execute first.")
    allow_additional_pos_output = fields.Boolean(
        default=False, string="Allow additional POS ticket",
        help="Explicitly allow a second print to the normal POS receipt/preparation destination. This may print an additional physical ticket.",
    )

    @api.model
    def _sanitize_template_field(self, field_name, conversion=None):
        if field_name is None:
            return
        # Only bare allow-listed scalar names may appear: no attribute
        # chains, no subscripts, no dunders (record.env, record._fields,
        # __class__ traversal are all impossible by construction).
        if not field_name.isidentifier() or "__" in field_name:
            raise ValueError("Attribute and index access are strictly forbidden in raw print templates.")
        # Conversions (!r/!s/!a) run AFTER value sanitization during
        # str.format, so {name!r} would re-add quotes that sanitize_raw_value
        # deliberately stripped for TSPL (and reshape values for ZPL/ESC-POS).
        # Templates must use plain {} placeholders only.
        if conversion:
            raise ValueError("Format conversions (!r/!s/!a) are forbidden in raw print templates.")

    # Native labels are small command streams, not a generic Python formatting
    # engine. Limits apply BEFORE formatting and after UTF-8 expansion.
    MAX_RAW_TEMPLATE_BYTES = 64 * 1024
    MAX_RENDERED_LABEL_BYTES = 512 * 1024

    def render_raw_template(self, record, protocol=None):
        """Read only referenced fields; never evaluate attributes or format specs."""
        self.ensure_one()
        template = self.raw_template or ""
        if not template:
            raise ValidationError(_("Raw template is empty for policy %s.") % self.name)
        if len(template.encode("utf-8")) > self.MAX_RAW_TEMPLATE_BYTES:
            raise ValidationError(_("Raw template exceeds the 64 KiB size limit."))

        protocol = (protocol or self.raw_protocol or "").strip().lower()
        fields_needed = set()
        try:
            for _literal, field_name, format_spec, conversion in string.Formatter().parse(template):
                if field_name is None:
                    continue
                self._sanitize_template_field(field_name, conversion)
                # Width/precision can expand 1 character to millions of bytes,
                # and nested replacement fields can escape a field-only parser.
                # Printer languages provide their own formatting commands.
                if format_spec:
                    raise ValueError("Format specifications are forbidden in raw print templates.")
                fields_needed.add(field_name)
        except ValueError as exc:
            raise ValidationError(_("The raw template for rule '%s' uses a forbidden construct: %s") % (self.name, exc)) from exc

        values = {}
        for requested in fields_needed:
            # A many2one's ID is a deliberately separate, allow-listed suffix.
            id_reference = requested.endswith("_id") and requested[:-3] in record._fields and record._fields[requested[:-3]].type == "many2one"
            field_name = requested[:-3] if id_reference else requested
            field = record._fields.get(field_name)
            if not field or field.type not in ("char", "text", "integer", "float", "date", "datetime", "boolean", "selection", "many2one"):
                raise ValidationError(_("The raw template for rule '%s' uses the placeholder {%s}, but this document does not provide it. Remove the placeholder or replace it with a field this record has.") % (self.name, requested))
            value = getattr(record, field_name)
            if field.type == "many2one":
                value = (value.id if value else "") if id_reference else (value.display_name if value else "")
            values[requested] = sanitize_raw_value(value, protocol)

        try:
            rendered = template.format_map(values)
        except (KeyError, ValueError, TypeError) as exc:
            raise ValidationError(_("Could not build raw template for rule '%s': %s") % (self.name, exc)) from exc
        if len(rendered.encode("utf-8")) > self.MAX_RENDERED_LABEL_BYTES:
            raise ValidationError(_("Rendered raw label exceeds the 512 KiB size limit."))
        return rendered

    @api.depends("company_id", "branch_id")
    def _compute_effective_company_id(self):
        for policy in self:
            policy.effective_company_id = policy.branch_id or policy.company_id

    @api.constrains("company_id", "branch_id", "binding_id")
    def _check_hierarchy(self):
        for policy in self:
            if policy.company_id.parent_id:
                raise ValidationError(_("Odoo Company must be a root company, not a branch."))
            if policy.branch_id and policy.branch_id.parent_id != policy.company_id:
                raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))
            if policy.binding_id:
                binding = policy.binding_id
                if binding.company_id != policy.company_id:
                    raise ValidationError(_("Target Binding must belong to the same Odoo Company as this Automation Rule."))
                if policy.branch_id:
                    if binding.branch_id and binding.branch_id != policy.branch_id:
                        raise ValidationError(_("Target Binding must belong to this Odoo Branch or be a company-wide fallback."))
                elif binding.branch_id:
                    raise ValidationError(_("A root-company Automation Rule cannot target a branch-specific Binding."))

    VALID_MODEL_EVENTS = {
        "stock.picking": {"picking_validated"},
        "account.move": {"invoice_posted"},
        "pos.order": {"pos_order_paid"},
    }
    
    @api.onchange("company_id", "branch_id")
    def _onchange_scope(self):
        for policy in self:
            if policy.binding_id:
                binding = policy.binding_id
                valid = binding.company_id == policy.company_id
                if policy.branch_id:
                    valid = valid and (not binding.branch_id or binding.branch_id == policy.branch_id)
                else:
                    valid = valid and not binding.branch_id
                if not valid:
                    policy.binding_id = False

    @api.onchange("action_type")
    def _onchange_action_type(self):
        """Clear mutually exclusive fields when switching action type to prevent validation lock."""
        for policy in self:
            if policy.action_type == "report":
                policy.raw_template = False
                policy.raw_protocol = False
            elif policy.action_type == "raw_template":
                policy.report_id = False



    @api.constrains("company_id", "branch_id", "binding_id")
    def _check_binding_scope(self):
        # The hierarchy validator is owned by the policy because it validates
        # the policy's company/branch scope and its optional target binding.
        # Keep this compatibility constraint as a single delegation point.
        self._check_hierarchy()

    @api.constrains("action_type", "report_id", "raw_template", "raw_protocol", "domain_filter", "model_id", "event_type", "binding_id", "allow_additional_pos_output")
    def _check_action_configuration(self):
        for policy in self:
            # 1. Model and event validation
            allowed_events = self.VALID_MODEL_EVENTS.get(policy.model_name)
            if not allowed_events or policy.event_type not in allowed_events:
                raise ValidationError(
                    _("Invalid trigger event '%s' for model '%s'. Allowed: %s")
                    % (policy.event_type, policy.model_name, ", ".join(sorted(allowed_events or [])))
                )

            # Prevent accidental double receipts from a standard POS path
            # plus a second POS Paid automation targeting the same output.
            # An extra ticket is permitted only by an explicit operator choice.
            if (policy.model_name == "pos.order" and policy.event_type == "pos_order_paid"
                    and policy.binding_id and policy.binding_id.destination_type in ("pos", "pos_printer")
                    and not policy.allow_additional_pos_output):
                raise ValidationError(_(
                    "POS Paid automation to the normal POS receipt/preparation printer may produce a second physical ticket. "
                    "Select a separate destination, or explicitly enable 'Allow additional POS ticket'."
                ))

            # 2. Action type constraints and mutual exclusivity
            if policy.action_type == "report":
                if not policy.report_id:
                    raise ValidationError(_("A report must be selected when action type is 'QWeb PDF Report'."))
                if policy.report_id.model != policy.model_name:
                    raise ValidationError(_("Selected report model '%s' does not match policy target model '%s'.") % (policy.report_id.model, policy.model_name))
                if policy.raw_template:
                    raise ValidationError(_("Raw template must not be configured when action type is 'QWeb PDF Report'."))
            elif policy.action_type == "raw_template":
                if not policy.raw_template or not policy.raw_template.strip():
                    raise ValidationError(_("Raw command template cannot be empty when action type is 'Raw Command / Label Template'."))
                if policy.report_id:
                    raise ValidationError(_("Report action must not be configured when action type is 'Raw Command / Label Template'."))
                if not policy.raw_protocol or policy.raw_protocol not in ("zpl", "tspl", "escpos", "raw"):
                    raise ValidationError(_("A valid raw protocol (ZPL, TSPL, ESC/POS, or raw passthrough) must be specified."))

                # 3. Binding protocol compatibility: EXACT match only. A raw
                # binding is not a wildcard for label or receipt languages.
                if policy.binding_id and getattr(policy.binding_id, "printer_protocol", False):
                    bproto = policy.binding_id.printer_protocol
                    if bproto != policy.raw_protocol:
                        raise ValidationError(
                            _("Target binding '%s' protocol '%s' is incompatible with policy raw protocol '%s' (protocols must match exactly).")
                            % (policy.binding_id.display_name, bproto, policy.raw_protocol)
                        )

            # 4. Domain filter syntax and field existence
            if policy.domain_filter and policy.domain_filter.strip():
                try:
                    domain = safe_eval(policy.domain_filter)
                    if not isinstance(domain, list):
                        raise ValidationError(_("Domain filter must evaluate to a list of criteria."))
                    for item in domain:
                        if isinstance(item, (str, bytes)):
                            if item not in ("&", "|", "!"):
                                raise ValidationError(_("Invalid domain operator '%s'.") % item)
                        elif isinstance(item, (list, tuple)):
                            if len(item) != 3:
                                raise ValidationError(_("Domain leaves must have exactly 3 elements: %s") % str(item))
                            field_name = str(item[0]).split(".")[0]
                            if field_name not in self.env[policy.model_name]._fields:
                                raise ValidationError(_("Field '%s' in domain filter does not exist on model '%s'.") % (field_name, policy.model_name))
                        else:
                            raise ValidationError(_("Invalid element in domain filter: %s") % str(item))
                except ValidationError:
                    # Specific operator/arity/field errors above already carry
                    # the actionable message; do not re-wrap them into the
                    # generic syntax error below.
                    raise
                except Exception as exc:
                    raise ValidationError(_("Invalid domain filter expression for policy '%s': %s") % (policy.name, exc)) from exc

    @api.model
    def resolve_for_record(self, record, event_type):
        """Return branch policies plus root fallback, never sibling policies."""
        record_company = getattr(record, "company_id", False)
        if not record_company:
            return self.browse()
        root_company = record_company.parent_id or record_company
        branch = record_company if record_company.parent_id else False
        return self.search([
            ("model_id.model", "=", record._name),
            ("event_type", "=", event_type),
            ("company_id", "=", root_company.id),
            ("branch_id", "in", [False, branch.id] if branch else [False]),
            ("active", "=", True),
        ], order="priority asc, id asc")

    @api.model
    @api.private
    def dispatch_for_record(self, record, event_type):
        """Schedule every applicable automated print policy independently.

        Policy selection is Odoo-owned control-plane data. Each policy is
        evaluated and scheduled independently so one invalid target cannot
        prevent other valid policies from printing. Idempotency is enforced
        by the Intent layer, not by the hooks themselves.
        """
        policies = self.resolve_for_record(record, event_type)
        intent_model = self.env["print_gateway.intent"].sudo()
        executed_targets = set()
        scheduled = 0
        failures = 0
        for policy in policies:
            matched = False
            target_key = None
            try:
                with self.env.cr.savepoint():
                    if not policy.matches_record(record):
                        continue
                    matched = True
                    target_key = policy.effective_target_key(record)
                    # An omitted explicit Binding is not a bypass of the
                    # second-ticket guard. Validate the *resolved* target too:
                    # the normal POS receipt/preparation route can be chosen
                    # implicitly by the router's priority lookup.
                    if (event_type == "pos_order_paid" and record._name == "pos.order"
                            and not policy.allow_additional_pos_output
                            and target_key and target_key[0]):
                        selected = self.env["print_gateway.binding"].browse(target_key[0]).exists()
                        if selected and selected.destination_type in ("pos", "pos_printer"):
                            raise ValidationError(_(
                                "POS Paid automation resolved to the normal POS receipt/preparation printer. "
                                "Choose a separate output destination or explicitly enable 'Allow additional POS ticket'."
                            ))
                    if target_key in executed_targets:
                        continue
                    event_identity = self.env.context.get("print_gateway_event_identity")
                    if event_identity is None:
                        intent_model.create_and_route(policy, record, event_type)
                    else:
                        intent_model.create_and_route(policy, record, event_type, event_identity=event_identity)
                executed_targets.add(target_key)
                scheduled += 1
            except Exception as exc:
                failures += 1
                # Resolution happens before intent creation. Preserve a durable,
                # retryable attempt even when a printer/rule is misconfigured.
                # The original savepoint has rolled back; this one can commit
                # atomically with the business event, not as an orphan log.
                if matched:
                    try:
                        with self.env.cr.savepoint():
                            intent_model.record_preflight_failure(
                                policy, record, event_type, exc,
                                event_identity=self.env.context.get("print_gateway_event_identity"),
                            )
                    except Exception:
                        _logger.exception("Could not persist failed automatic print intent")
                _logger.error(
                    "Failed to schedule automated print policy '%s' for %s(%s): %s",
                    policy.name,
                    record._name,
                    record.id,
                    exc,
                )
        return {"scheduled": scheduled, "failed": failures}

    def effective_target_key(self, record):
        """Return the validated effective target used for policy fan-out dedup."""
        self.ensure_one()
        if self.action_type == "report":
            route = self.env["print_gateway.print_router"].resolve_binding(
                report=self.report_id,
                record=record,
                company=record.company_id,
                explicit_destination=self.binding_id.destination_ref if self.binding_id else None,
                explicit_binding=self.binding_id or None,
                payload_type="pdf",
            )
            binding_id = route.get("binding_id") or False
        else:
            # Resolve implicit raw targets too. Using False for every policy
            # without an explicit binding caused unrelated branch/filter
            # policies to collapse into one dedup key before routing.
            route = self.env["print_gateway.print_router"].resolve_binding(
                record=record,
                company=record.company_id,
                document_type="label",
                explicit_binding=self.binding_id or None,
                explicit_destination=self.binding_id.destination_ref if self.binding_id else None,
                protocol=self.raw_protocol,
                payload_type="raw",
            )
            binding_id = route.get("binding_id") or False
        return (
            binding_id,
            self.action_type,
            self.report_id.id if self.report_id else False,
            self.raw_protocol or False,
            self.raw_template or False,
        )

    def matches_record(self, record):
        """Evaluate whether a given record satisfies the policy filters."""
        self.ensure_one()
        if not self.active:
            return False
        if record._name != self.model_name:
            return False

        # Multi-tenant scope check
        record_company = getattr(record, "company_id", False)
        if record_company:
            if self.branch_id and record_company != self.branch_id:
                return False
            if not self.branch_id and record_company.parent_id and record_company.parent_id != self.company_id:
                return False
            if not self.branch_id and not record_company.parent_id and record_company != self.company_id:
                return False

        # Specific warehouse / picking type filters (fail-closed if record cannot resolve attribute)
        if self.warehouse_id:
            record_warehouse = getattr(record, "warehouse_id", False) or (getattr(record, "picking_type_id", False) and record.picking_type_id.warehouse_id)
            if not record_warehouse or record_warehouse != self.warehouse_id:
                return False

        if self.picking_type_id:
            record_ptype = getattr(record, "picking_type_id", False)
            if not record_ptype or record_ptype != self.picking_type_id:
                return False

        # Domain filter check
        if self.domain_filter and self.domain_filter.strip():
            try:
                domain = safe_eval(self.domain_filter)
                if isinstance(domain, list):
                    matched = self.env[self.model_name].search([("id", "=", record.id)] + domain, limit=1)
                    if not matched:
                        return False
            except Exception:
                return False

        return True
