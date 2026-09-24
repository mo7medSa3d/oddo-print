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
        self.check_access("read")
        if not image:
            raise ValidationError(_("The rendered POS receipt image is required."))
        return self.env["print_gateway.print_router"].route_pos_receipt(self, image)

    def has_gateway_kitchen_binding(self, pos_printer_id=None):
        self.ensure_one()
        self.check_access("read")
        destination = self.config_id
        if pos_printer_id:
            destination = self.env["pos.printer"].browse(pos_printer_id).exists()
            if not destination or destination not in self.config_id.printer_ids:
                return False
        route = self.env["print_gateway.print_router"].resolve_binding(
            record=self,
            company=self.config_id.company_id or self.company_id,
            document_type="kitchen",
            explicit_destination=destination,
            raise_if_not_found=False,
        )
        return bool(route.get("binding"))

    def get_gateway_kitchen_routes(self):
        """Return category-aware Gateway routes using Odoo native preparation printers.

        Odoo 19 defines kitchen routing on pos.printer.product_categories_ids.
        Gateway owns the physical printer, while Odoo still owns the business
        destination/category mapping. A POS-level Gateway binding remains a
        backwards-compatible fallback when no native-printer bindings exist.
        """
        self.ensure_one()
        self.check_access("read")
        router = self.env["print_gateway.print_router"]
        company = self.config_id.company_id or self.company_id
        preparation_printers = self.config_id.printer_ids.filtered(lambda p: p.product_categories_ids)
        routes = []
        for pos_printer in preparation_printers:
            route = router.resolve_binding(
                record=self,
                company=company,
                document_type="kitchen",
                explicit_destination=pos_printer,
                raise_if_not_found=False,
            )
            if route.get("binding"):
                routes.append({
                    "pos_printer_id": pos_printer.id,
                    "category_ids": pos_printer.product_categories_ids.ids,
                })
        if routes:
            return {"mode": "preparation_printers", "routes": routes}

        fallback = router.resolve_binding(
            record=self,
            company=company,
            document_type="kitchen",
            explicit_destination=self.config_id,
            raise_if_not_found=False,
        )
        if fallback.get("binding"):
            return {"mode": "pos_fallback", "routes": [{"pos_printer_id": False, "category_ids": []}]}
        return {"mode": "missing", "routes": []}

    def action_print_gateway_kitchen(self, image, reprint=False, operation_id=None, pos_printer_id=None):
        self.ensure_one()
        self.check_access("read")
        if not image:
            raise ValidationError(_("The rendered POS Kitchen / Preparation image is required."))
        pos_printer = False
        if pos_printer_id:
            pos_printer = self.env["pos.printer"].browse(pos_printer_id).exists()
            if not pos_printer or pos_printer not in self.config_id.printer_ids:
                raise ValidationError(_("The selected Odoo Preparation Printer does not belong to this POS."))
        return self.env["print_gateway.print_router"].route_kitchen_print(
            self, image, reprint=bool(reprint), idempotency_key=operation_id,
            pos_printer=pos_printer,
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
                _logger.error("Failed to schedule automated print intents for POS order %s: %s", order.id, exc)


    def _process_saved_order(self, draft):
        res = super()._process_saved_order(draft)
        if not draft:
            self._action_trigger_print_policies()
        return res
