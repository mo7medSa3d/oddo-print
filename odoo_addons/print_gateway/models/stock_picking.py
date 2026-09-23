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
        intent_model = self.env["print_gateway.intent"].sudo()

        for picking in self:
            # _action_done can return a backorder/batch wizard without
            # completing the picking; only validated (done) pickings print.
            if picking.state != "done":
                continue
            try:
                policies = policy_model.resolve_for_record(picking, "picking_validated")
            except Exception as exc:
                _logger.error("Failed to resolve print policies for picking %s: %s", picking.id, exc)
                continue

            # Multi-destination fan-out with same-target dedup. One broken
            # policy must not prevent a separate valid policy from printing.
            executed_targets = set()
            for policy in policies:
                try:
                    if not policy.matches_record(picking):
                        continue
                    target_key = policy.effective_target_key(picking)
                    if target_key in executed_targets:
                        continue
                    executed_targets.add(target_key)
                    intent_model.create_and_route(policy, picking, "picking_validated")
                except Exception as exc:
                    _logger.error(
                        "Failed to schedule print intent for picking %s policy %s: %s",
                        picking.id, policy.id, exc,
                    )

        return res
