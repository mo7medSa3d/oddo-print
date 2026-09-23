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

        for move in self:
            if not move.is_invoice(include_receipts=True) or move.state != "posted":
                continue
            try:
                policy_model.dispatch_for_record(move, "invoice_posted")
            except Exception as exc:
                _logger.error("Failed to schedule print policies for invoice %s: %s", move.id, exc)

        return res
