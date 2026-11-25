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
                # Isolate the optional policy query/write; catching a PostgreSQL
                # exception without a savepoint leaves the business transaction
                # aborted even when posting/validation should succeed.
                with self.env.cr.savepoint():
                    result = policy_model.dispatch_for_record(move, "invoice_posted")
                if result.get("failed"):
                    _logger.error(
                        "Automated print scheduling completed with %s policy failure(s) for invoice %s",
                        result["failed"],
                        move.id,
                    )
            except Exception as exc:
                _logger.error("Failed to schedule automated print intents for invoice %s: %s", move.id, exc)

        return res

    def _gateway_bound_invoice_report(self):
        moves = self.filtered(lambda m: m.is_invoice(include_receipts=True))
        if len(moves) != 1:
            return None
        try:
            invoice_template = self.env["account.move.send"]._get_default_pdf_report_id(moves)
        except Exception:
            return None
        if not invoice_template or invoice_template.report_type != "qweb-pdf":
            return None
        router = self.env["print_gateway.print_router"]
        if not router._print_config(self.env.company):
            return None
        gateway_company, branch = router._binding_scope(self.env.company)
        dtype = router._document_type(report=invoice_template, record=moves)
        binding = self.env["print_gateway.binding"].find_for(
            gateway_company,
            dtype,
            report=invoice_template,
            record=moves,
            branch=branch,
        )
        return invoice_template if binding else None

    def action_invoice_download_pdf(self, target="download"):
        invoice_template = self._gateway_bound_invoice_report()
        if invoice_template:
            return invoice_template.with_context(print_gateway_client_dispatch=True).report_action(
                self.ids, config=False
            )
        return super().action_invoice_download_pdf(target=target)

    def action_print_pdf(self):
        if (
            not self.env.context.get("print_gateway_force_server_report")
            and self._gateway_bound_invoice_report()
        ):
            return super(
                AccountMovePrintGateway,
                self.with_context(print_gateway_client_dispatch=True),
            ).action_print_pdf()
        return super().action_print_pdf()
