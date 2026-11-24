# -*- coding: utf-8 -*-
"""Server-side POS integration for Gateway printing."""

import logging

from odoo import models, _
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


def _exact_pos_printer_id(value):
    """Optional preparation printer: only an exact positive Odoo record ID.

    None/False are Odoo's explicit no-selection sentinels. Never coerce
    booleans, floats or numeric-looking strings to another printer, and never
    interpret any invalid explicit value as permission for POS fallback.
    """
    if value is None or value is False:
        return None
    if type(value) is not int or not 0 < value <= 2**63 - 1:
        raise ValidationError(_("A valid Odoo Preparation Printer ID is required."))
    return value


class PosOrderGatewayPrinting(models.Model):
    _inherit = "pos.order"

    def _gateway_active_company(self):
        """Keep POS receipt, kitchen selection and activation in one company."""
        self.ensure_one()
        company = self.config_id.company_id or self.company_id
        if company != self.env.company:
            raise ValidationError(_("Gateway printing must use the active Odoo company."))
        return company

    def _preparation_printers(self):
        printers = getattr(self.config_id, "preparation_printer_ids", None)
        return self.config_id.printer_ids if printers is None else printers

    def action_print_gateway_receipt(self, image, operation_id=None, geometry_fingerprint=None):
        self.ensure_one()
        self.check_access("read")
        if not image:
            raise ValidationError(_("The rendered POS receipt image is required."))
        return self.env["print_gateway.print_router"].route_pos_receipt(
            self, image, idempotency_key=operation_id, geometry_fingerprint=geometry_fingerprint,
        )

    def get_gateway_receipt_geometry(self):
        """Resolve the real receipt binding before choosing physical layout.

        A separate, bounded runtime lookup is used only for receipt images.
        No data is written; normal routing/authentication is still enforced
        later when the actual print job is submitted.
        """
        self.ensure_one()
        self.check_access("read")
        company = self._gateway_active_company()
        router = self.env["print_gateway.print_router"]
        route = router.resolve_binding(
            record=self, company=company, document_type="receipt",
            raise_if_not_found=False,
        )
        return router._receipt_geometry_for_route(route)

    def has_gateway_kitchen_binding(self, pos_printer_id=None):
        self.ensure_one()
        self.check_access("read")
        company = self._gateway_active_company()
        selected_printer_id = _exact_pos_printer_id(pos_printer_id)
        destination = self.config_id
        if selected_printer_id is not None:
            destination = self.env["pos.printer"].browse(selected_printer_id).exists()
            if not destination:
                return False
            if destination not in self._preparation_printers():
                return False
        route = self.env["print_gateway.print_router"].resolve_binding(
            record=self,
            company=company,
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
        Missing bindings are returned explicitly so the frontend can fail closed
        instead of silently dropping a kitchen station.
        """
        self.ensure_one()
        self.check_access("read")
        company = self._gateway_active_company()
        router = self.env["print_gateway.print_router"]
        preparation_printers = self._preparation_printers().filtered(lambda p: p.product_categories_ids)
        routes = []
        missing = []
        for pos_printer in preparation_printers:
            route = router.resolve_binding(
                record=self,
                company=company,
                document_type="kitchen",
                explicit_destination=pos_printer,
                raise_if_not_found=False,
            )
            route_info = {
                "pos_printer_id": pos_printer.id,
                "category_ids": pos_printer.product_categories_ids.ids,
            }
            if route.get("binding"):
                route_info["geometry"] = router._receipt_geometry_for_route(route)
                routes.append(route_info)
            else:
                missing.append(route_info)
        if routes or missing:
            return {
                "mode": "preparation_printers",
                "routes": routes,
                "missing_routes": missing,
            }

        fallback = router.resolve_binding(
            record=self,
            company=company,
            document_type="kitchen",
            explicit_destination=self.config_id,
            raise_if_not_found=False,
        )
        if fallback.get("binding"):
            return {
                "mode": "pos_fallback",
                "routes": [{"pos_printer_id": False, "category_ids": [],
                            "geometry": router._receipt_geometry_for_route(fallback)}],
                "missing_routes": [],
            }
        return {"mode": "missing", "routes": [], "missing_routes": []}

    def action_print_gateway_kitchen(self, image, reprint=False, operation_id=None, pos_printer_id=None, geometry_fingerprint=None):
        self.ensure_one()
        self.check_access("read")
        self._gateway_active_company()
        if type(reprint) is not bool:
            raise ValidationError(_("The kitchen reprint option must be a boolean."))
        if not image:
            raise ValidationError(_("The rendered POS Kitchen / Preparation image is required."))
        selected_printer_id = _exact_pos_printer_id(pos_printer_id)
        pos_printer = False
        if selected_printer_id is not None:
            pos_printer = self.env["pos.printer"].browse(selected_printer_id).exists()
            if not pos_printer:
                raise ValidationError(_("The selected Odoo Preparation Printer does not belong to this POS."))
            if pos_printer not in self._preparation_printers():
                raise ValidationError(_("The selected Odoo Preparation Printer does not belong to this POS."))
        return self.env["print_gateway.print_router"].route_kitchen_print(
            self, image, reprint=reprint, idempotency_key=operation_id,
            pos_printer=pos_printer,
            geometry_fingerprint=geometry_fingerprint,
        )

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        self.check_access("read")
        target_company = self._gateway_active_company()
        return bool(self.env["print_gateway.print_router"]._print_config(target_company))

    def _action_trigger_print_policies(self):
        policy_model = self.env["print_gateway.policy"].sudo()

        for order in self:
            if order.state not in ("paid", "done", "invoiced"):
                continue
            try:
                # Isolate the optional policy query/write; catching a PostgreSQL
                # exception without a savepoint leaves the business transaction
                # aborted even when posting/validation should succeed.
                with self.env.cr.savepoint():
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
