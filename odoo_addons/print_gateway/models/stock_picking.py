# -*- coding: utf-8 -*-
"""Automated print policy hook for Stock Pickings."""

import logging

from odoo import models

_logger = logging.getLogger(__name__)


class StockPickingPrintGateway(models.Model):
    _inherit = "stock.picking"

    def _action_done(self):
        res = super()._action_done()
        policy_model = self.env["print_gateway.policy"].sudo()

        for picking in self:
            # _action_done can return a backorder/batch wizard without
            # completing the picking; only validated (done) pickings print.
            if picking.state != "done":
                continue
            try:
                result = policy_model.dispatch_for_record(picking, "picking_validated")
                if result.get("failed"):
                    _logger.error(
                        "Automated print scheduling completed with %s policy failure(s) for picking %s",
                        result["failed"],
                        picking.id,
                    )
            except Exception as exc:
                # Scheduling must never break the stock validation itself.
                _logger.error("Failed to schedule automated print intents for picking %s: %s", picking.id, exc)

        return res
