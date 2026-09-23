# -*- coding: utf-8 -*-
"""Server-side POS integration for Gateway printing."""

import logging

from odoo import models, _
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class PosOrderGatewayPrinting(models.Model):
    _inherit = "pos.order"

    def action_print_gateway_receipt(self, image):
        self.ensure_one()
        # The rendered receipt leaves the database perimeter (Gateway +
        # paper), so the caller must be allowed to read the order itself,
        # mirroring the report path's read check.
        self.check_access("read")
        if not image:
            raise ValidationError(_("The rendered POS receipt image is required."))
        return self.env["print_gateway.print_router"].route_pos_receipt(self, image)

    def action_print_gateway_kitchen(self, printer_id, image, reprint=False, operation_id=None):
        self.ensure_one()
        self.check_access("read")
        if not printer_id:
            raise ValidationError(_("The Odoo Kitchen / Preparation printer is required."))
        try:
            printer = self.env["pos.printer"].browse(int(printer_id)).exists()
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("The selected Kitchen / Preparation printer is invalid.")) from exc
        if not printer:
            raise ValidationError(_("The selected Kitchen / Preparation printer no longer exists."))
        target_company = self.config_id.company_id or self.company_id
        if printer.company_id != target_company:
            raise ValidationError(_("The selected Kitchen / Preparation printer belongs to another Odoo company."))
        return self.env["print_gateway.print_router"].route_kitchen_print(
            self, printer, image, reprint=bool(reprint), idempotency_key=operation_id,
        )

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        target_company = self.config_id.company_id or self.company_id
        return bool(self.env["print_gateway.print_router"]._gateway_config(target_company))

    def _action_trigger_print_policies(self):
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        for order in self:
            if order.state not in ("paid", "done", "invoiced"):
                continue
            try:
                policies = policy_model.resolve_for_record(order, "pos_order_paid")
            except Exception as exc:
                _logger.error("Failed to resolve print policies for POS order %s: %s", order.id, exc)
                continue

            # One broken policy must not prevent a separate valid policy from printing.
            executed_targets = set()
            for policy in policies:
                try:
                    if not policy.matches_record(order):
                        continue
                    target_key = policy.effective_target_key(order)
                    if target_key in executed_targets:
                        continue
                    executed_targets.add(target_key)
                    intent_model.create_and_route(policy, order, "pos_order_paid")
                except Exception as exc:
                    _logger.error(
                        "Failed to schedule print intent for POS order %s policy %s: %s",
                        order.id, policy.id, exc,
                    )

    def _process_saved_order(self, draft):
        res = super()._process_saved_order(draft)
        if not draft:
            self._action_trigger_print_policies()
        return res

