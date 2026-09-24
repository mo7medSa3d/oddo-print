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

    def has_gateway_kitchen_binding(self):
        self.ensure_one()
        self.check_access("read")
        route = self.env["print_gateway.print_router"].resolve_binding(
            record=self,
            company=self.config_id.company_id or self.company_id,
            document_type="kitchen",
            explicit_destination=self.config_id,
            raise_if_not_found=False,
        )
        return bool(route.get("binding"))

    def action_print_gateway_kitchen(self, image, reprint=False, operation_id=None):
        self.ensure_one()
        self.check_access("read")
        if not image:
            raise ValidationError(_("The rendered POS Kitchen / Preparation image is required."))
        return self.env["print_gateway.print_router"].route_kitchen_print(
            self, image, reprint=bool(reprint), idempotency_key=operation_id,
        )

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        target_company = self.config_id.company_id or self.company_id
        return bool(self.env["print_gateway.print_router"]._gateway_config(target_company))

    def _action_trigger_print_policies(self):
        policy_model = self.env["print_gateway.policy"].sudo()

        for order in self:
            if order.state not in ("paid", "done", "invoiced"):
                continue
            try:
                result = policy_model.dispatch_for_record(order, "pos_order_paid")
                if result.get("failed"):
                    _logger.error(
                        "Automated print scheduling completed with %s policy failure(s) for POS order %s",
                        result["failed"],
                        order.id,
                    )
            except Exception as exc:
                # Scheduling must never break order finalization.
                _logger.error("Failed to schedule automated print intents for POS order %s: %s", order.id, exc)


    def _process_saved_order(self, draft):
        res = super()._process_saved_order(draft)
        if not draft:
            self._action_trigger_print_policies()
        return res

