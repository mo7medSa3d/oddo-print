# -*- coding: utf-8 -*-
"""Automated print policy hook for Account Moves (Invoices / Bills)."""

import logging
from odoo import models

_logger = logging.getLogger(__name__)


class AccountMovePrintGateway(models.Model):
    _inherit = "account.move"

    def action_post(self):
        res = super().action_post()
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        for move in self:
            if not move.is_invoice(include_receipts=True) or move.state != "posted":
                continue
            try:
                policies = policy_model.resolve_for_record(move, "invoice_posted")
            except Exception as exc:
                _logger.error("Failed to resolve print policies for invoice %s: %s", move.id, exc)
                continue

            # One broken policy must not prevent a separate valid policy from printing.
            executed_targets = set()
            for policy in policies:
                try:
                    if not policy.matches_record(move):
                        continue
                    target_key = policy.effective_target_key(move)
                    if target_key in executed_targets:
                        continue
                    executed_targets.add(target_key)
                    intent_model.create_and_route(policy, move, "invoice_posted")
                except Exception as exc:
                    _logger.error(
                        "Failed to schedule print intent for invoice %s policy %s: %s",
                        move.id, policy.id, exc,
                    )

        return res
