# -*- coding: utf-8 -*-
"""Behavioral tests: Odoo E2E capture must never create physical jobs."""
import base64
from unittest.mock import MagicMock, patch

from odoo.tests.common import TransactionCase
from odoo.exceptions import ValidationError


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

    def test_diagnostic_capture_uses_registered_router_and_qweb_report(self):
        """The default wizard path must reach the real router, not a stale model alias.

        The QWeb execution is stubbed only to keep the test independent of
        wkhtmltopdf; all registry lookups, wizard validation and payload routing
        are exercised against the installed Odoo addon.
        """
        report_action = self.env.ref("print_gateway.action_diagnostic_report")
        self.assertEqual(report_action.report_name, "print_gateway.diagnostic_report")
        self.assertTrue(self.env.ref("print_gateway.diagnostic_report"))

        wizard = self.new_wizard(document_kind="diagnostic")
        accepted = MagicMock(status_code=202)
        accepted.json.return_value = {"runId": "cap_" + "b" * 32, "status": "queued"}
        pdf = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"
        report_class = type(self.env["ir.actions.report"])

        # "E2E simulation only — no printer" is intentionally non-ASCII,
        # so the router must use its Unicode-safe QWeb rendering branch.
        with patch.object(report_class, "_render_qweb_pdf", return_value=(pdf, "pdf")) as renderer, \
             patch("requests.post", return_value=accepted) as request:
            wizard.action_start_test()

        self.assertEqual(wizard.capture_status, "queued")
        self.assertEqual(wizard.run_id, "cap_" + "b" * 32)
        self.assertTrue(renderer.called)
        self.assertIn("print_gateway.action_diagnostic_report", str(renderer.call_args))
        payload = request.call_args.kwargs["json"]
        self.assertEqual(payload["payload"]["type"], "pdf")
        self.assertEqual(payload["payload"]["encoding"], "base64")
        self.assertEqual(base64.b64decode(payload["payload"]["data"]), pdf)
        self.assertEqual(payload["paperMm"], 0)
        self.assertNotIn("printerId", payload)
        self.assertNotIn("protocol", payload)
        self.assertFalse(self.env["print_gateway.print_job"].search_count([
            ("document_type", "=", "e2e_capture_test"),
        ]))

    def test_diagnostic_ascii_pdf_renderer_is_available_on_real_router(self):
        pdf = self.env["print_gateway.print_router"]._generate_test_pdf(
            company_name="Yaseir", branch_name="Main",
            printer_name="Diagnostic only", now_str="2026-10-13 03:22",
        )
        self.assertTrue(pdf.startswith(b"%PDF-"))
        self.assertIn(b"%%EOF", pdf[-4096:])

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
