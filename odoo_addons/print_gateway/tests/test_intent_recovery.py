# -*- coding: utf-8 -*-
import uuid

from odoo import api
from odoo.tests.common import TransactionCase


class TestPrintGatewayIntentRecovery(TransactionCase):
    def test_stale_final_claim_is_terminalized_instead_of_staying_claimed(self):
        """A crashed final dispatch attempt must become terminally failed."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env.company
            stock_model = env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
            self.assertTrue(stock_model)

            policy = env["print_gateway.policy"].create({
                "name": "Final Attempt Recovery Test %s" % uuid.uuid4().hex,
                "company_id": company.id,
                "model_id": stock_model.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_protocol": "zpl",
                "raw_template": "^XA^FD{id}^FS^XZ",
            })
            intent = env["print_gateway.intent"].create({
                "company_id": company.id,
                "intent_key": "final-attempt-recovery-%s" % uuid.uuid4().hex,
                "policy_id": policy.id,
                "res_model": "stock.picking",
                "res_id": 0,
                "event_type": "picking_validated",
                "status": "pending",
                "attempts": 1,
                "max_attempts": 1,
            })
            cr.execute(
                "UPDATE print_gateway_intent SET status = 'claimed', claimed_at = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes', claim_token = %s WHERE id = %s",
                ("stale-final-attempt-token", intent.id),
            )
            cr.commit()
            intent_id = intent.id
        finally:
            cr.close()

        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            recovered = env["print_gateway.intent"].cron_recover_pending_intents()
        finally:
            cr.close()

        verify = self.env.registry.cursor()
        try:
            env = api.Environment(verify, self.env.uid, dict(self.env.context))
            row = env["print_gateway.intent"].browse(intent_id).exists()
            self.assertTrue(row)
            self.assertEqual(row.status, "failed")
            self.assertEqual(row.attempts, 1)
            self.assertFalse(row.claim_token)
            self.assertFalse(row.claimed_at)
            self.assertFalse(row.next_retry_at)
            self.assertIn("final attempt", row.last_error)
            self.assertGreaterEqual(recovered, 1)
        finally:
            verify.rollback()
            verify.close()
