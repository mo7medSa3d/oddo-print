# -*- coding: utf-8 -*-
import datetime
import uuid
from unittest import TestCase

from psycopg2 import IntegrityError

from odoo import api, fields
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestPrintGatewayIntentRecovery(TransactionCase):
    def test_companyless_intents_are_rejected_before_recovery_can_process_them(self):
        self.assertTrue(self.env["print_gateway.intent"]._fields["company_id"].required)
        stock_model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Required company %s" % uuid.uuid4().hex,
            "company_id": self.env.company.id,
            "model_id": stock_model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_protocol": "zpl",
            "raw_template": "^XA^FD{id}^FS^XZ",
        })
        # Odoo 19 overrides assertRaises and only accepts one exception class.
        # Use the standard unittest implementation to allow either ORM or SQL rejection.
        with TestCase.assertRaises(self, (IntegrityError, ValidationError)), self.env.cr.savepoint():
            self.env["print_gateway.intent"].create({
                "company_id": False,
                "intent_key": "missing-company-%s" % uuid.uuid4().hex,
                "policy_id": policy.id,
                "res_model": "stock.picking", "res_id": 0,
                "event_type": "picking_validated",
            })

    def test_permanently_failed_intents_cannot_starve_retryable_intents(self):
        """Exhausted failures must not consume the cron's bounded recovery batch."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env.company
            stock_model = env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
            self.assertTrue(stock_model)
            policy = env["print_gateway.policy"].create({
                "name": "Recovery Batch Starvation %s" % uuid.uuid4().hex,
                "company_id": company.id,
                "model_id": stock_model.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_protocol": "zpl",
                "raw_template": "^XA^FD{id}^FS^XZ",
            })
            exhausted_vals = [{
                "company_id": company.id,
                "intent_key": "exhausted-%s-%s" % (uuid.uuid4().hex, index),
                "policy_id": policy.id,
                "res_model": "stock.picking",
                "res_id": 0,
                "event_type": "picking_validated",
                "status": "failed",
                "attempts": 3,
                "max_attempts": 3,
                "last_error": "permanently failed",
            } for index in range(50)]
            env["print_gateway.intent"].create(exhausted_vals)
            retryable = env["print_gateway.intent"].create({
                "company_id": company.id,
                "intent_key": "retryable-%s" % uuid.uuid4().hex,
                "policy_id": policy.id,
                "res_model": "stock.picking",
                "res_id": 0,
                "event_type": "picking_validated",
                "status": "pending",
                "attempts": 0,
                "max_attempts": 3,
            })
            retryable_id = retryable.id
            cr.commit()
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
            row = env["print_gateway.intent"].browse(retryable_id).exists()
            self.assertTrue(row)
            self.assertEqual(row.status, "skipped")
            self.assertGreaterEqual(recovered, 1)
        finally:
            verify.rollback()
            verify.close()

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

    def test_setup_failure_finalizes_claim_instead_of_expiring_lease(self):
        """An exception before route_intent must preserve the actual error.

        The source model was removed after the intent was committed. This is a
        deterministic outer-try exception that previously left status=claimed
        until cron replaced the cause with 'Dispatch lease expired'.
        """
        model_name = "print_gateway.absent_source_fixture"
        token = "setup-failure-%s" % uuid.uuid4().hex
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            stock_model = env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
            self.assertTrue(stock_model)
            policy = env["print_gateway.policy"].create({
                "name": "Setup Failure %s" % uuid.uuid4().hex,
                "company_id": env.company.id,
                "model_id": stock_model.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_protocol": "zpl",
                "raw_template": "^XA^FD{id}^FS^XZ",
            })
            intent = env["print_gateway.intent"].create({
                "company_id": env.company.id,
                "intent_key": "setup-failure-%s" % uuid.uuid4().hex,
                "policy_id": policy.id,
                "res_model": model_name,
                "res_id": 42,
                "event_type": "picking_validated",
                "status": "claimed",
                "attempts": 3,
                "max_attempts": 3,
                "claimed_at": fields.Datetime.now(),
                "claim_token": token,
            })
            intent_id = intent.id
            cr.commit()
        finally:
            cr.close()

        intent_cls = type(self.env["print_gateway.intent"])
        intent_cls._execute_dispatched_route(self.env, intent_id, model_name, 42, token)

        verify_cr = self.env.registry.cursor()
        try:
            verify_env = api.Environment(verify_cr, self.env.uid, dict(self.env.context))
            row = verify_env["print_gateway.intent"].browse(intent_id).exists()
            self.assertTrue(row)
            self.assertEqual(row.status, "failed")
            self.assertIn(model_name, row.last_error)
            self.assertFalse(row.claim_token)
            self.assertFalse(row.claimed_at)
            self.assertFalse(row.next_retry_at)
            self.assertEqual(row.attempts, 3)
            self.assertFalse(row.print_job_id)
        finally:
            verify_cr.rollback()
            verify_cr.close()

    def test_final_expired_lease_preserves_prior_failure_diagnostic(self):
        """The recovery cron must not overwrite a known Gateway rejection."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            stock_model = env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
            self.assertTrue(stock_model)
            policy = env["print_gateway.policy"].create({
                "name": "Lease Diagnostic %s" % uuid.uuid4().hex,
                "company_id": env.company.id,
                "model_id": stock_model.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_protocol": "zpl",
                "raw_template": "^XA^FD{id}^FS^XZ",
            })
            intent = env["print_gateway.intent"].create({
                "company_id": env.company.id,
                "intent_key": "lease-diagnostic-%s" % uuid.uuid4().hex,
                "policy_id": policy.id,
                "res_model": "stock.picking",
                "res_id": 0,
                "event_type": "picking_validated",
                "status": "claimed",
                "attempts": 3,
                "max_attempts": 3,
                "claim_token": "expired-%s" % uuid.uuid4().hex,
                "claimed_at": fields.Datetime.now() - datetime.timedelta(minutes=10),
                "last_error": "GATEWAY_REJECTED_404: target printer removed",
            })
            intent_id = intent.id
            cr.commit()
        finally:
            cr.close()

        recovery_cr = self.env.registry.cursor()
        try:
            recovery_env = api.Environment(recovery_cr, self.env.uid, dict(self.env.context))
            recovery_env["print_gateway.intent"].cron_recover_pending_intents()
        finally:
            recovery_cr.close()

        verify_cr = self.env.registry.cursor()
        try:
            verify_env = api.Environment(verify_cr, self.env.uid, dict(self.env.context))
            row = verify_env["print_gateway.intent"].browse(intent_id).exists()
            self.assertTrue(row)
            self.assertEqual(row.status, "failed")
            self.assertIn("GATEWAY_REJECTED_404: target printer removed", row.last_error)
            self.assertIn("Final dispatch lease expired", row.last_error)
            self.assertFalse(row.claim_token)
        finally:
            verify_cr.rollback()
            verify_cr.close()
