# -*- coding: utf-8 -*-
"""Behavioral tests: Odoo E2E capture must never create physical jobs."""
import base64
from unittest.mock import MagicMock, patch

from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError, ValidationError


class TestE2ECaptureWizard(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env.company.parent_id or self.env.company
        self.agent_id = "agt_test1234"
        self.env["print_gateway.runtime_agent_assignment"].create({
            "company_id": self.company.id,
            "runtime_agent_id": self.agent_id,
            "enabled": True,
        })
        conf = self.env["print_gateway.gateway_config"].search(
            [("company_id", "=", self.company.id)], limit=1,
        )
        values = {
            "gateway_url": "https://example.invalid",
            "gateway_api_key": "odoo_test_capture_key",
            "enabled": True,
        }
        if conf:
            conf.write(values)
        else:
            conf = self.env["print_gateway.gateway_config"].create({
                "company_id": self.company.id,
                **values,
            })
        self.conf = conf

    def new_wizard(self, **vals):
        return self.env["print_gateway.e2e_capture_wizard"].create({
            "config_id": self.conf.id,
            "runtime_agent_id": self.agent_id,
            "document_kind": "receipt",
            "paper_mm": "80",
            "receipt_jpeg": base64.b64encode(bytes.fromhex("ffd8ffd9")),
            **vals,
        })

    def test_requires_assigned_agent(self):
        wizard = self.new_wizard(runtime_agent_id="agt_notassigned")
        with self.assertRaises(ValidationError):
            wizard.action_start_test()

    def test_submission_is_simulation_not_a_print_job(self):
        wizard = self.new_wizard()
        accepted = MagicMock(status_code=202)
        accepted.json.return_value = {"runId": "cap_" + "a" * 32, "status": "queued"}
        with patch("requests.post", return_value=accepted) as request:
            wizard.action_start_test()
        self.assertEqual(wizard.capture_status, "queued")
        self.assertTrue(wizard.run_id.startswith("cap_"))
        kwargs = request.call_args.kwargs
        self.assertEqual(kwargs["json"]["agentId"], self.agent_id)
        self.assertEqual(kwargs["json"]["paperMm"], 80)
        self.assertEqual(kwargs["json"]["payload"]["type"], "image")
        self.assertNotIn("printerId", kwargs["json"])
        self.assertNotIn("protocol", kwargs["json"]["payload"])
        self.assertFalse(self.env["print_gateway.print_job"].search_count([
            ("document_type", "=", "e2e_capture_test")
        ]))

        status = MagicMock(status_code=200)
        status.json.return_value = {
            "runId": wizard.run_id,
            "status": "rendered_locally",
            "physicalPrinted": False,
            "pageCount": 1,
            "pdfSha256": "f" * 64,
            "pdfBytes": 220,
            "previewDataUri": None,
        }
        with patch("requests.get", return_value=status):
            wizard.action_refresh_test()
        self.assertEqual(wizard.capture_status, "rendered_locally")
        self.assertEqual(wizard.page_count, 1)
        self.assertEqual(wizard.pdf_sha256, "f" * 64)

    def test_refuses_printed_status_from_remote(self):
        wizard = self.new_wizard()
        wizard.write({"run_id": "cap_" + "a" * 32, "capture_status": "queued"})
        spoofed = MagicMock(status_code=200)
        spoofed.json.return_value = {
            "runId": wizard.run_id,
            "status": "success",
            "physicalPrinted": True,
        }
        with patch("requests.get", return_value=spoofed):
            with self.assertRaises(ValidationError):
                wizard.action_refresh_test()
