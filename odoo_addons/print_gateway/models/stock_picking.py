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
                policy_model.dispatch_for_record(picking, "picking_validated")
            except Exception as exc:
                _logger.error("Failed to schedule print policies for picking %s: %s", picking.id, exc)

        return res
