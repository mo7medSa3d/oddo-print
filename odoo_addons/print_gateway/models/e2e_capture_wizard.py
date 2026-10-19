# -*- coding: utf-8 -*-
"""Explicit Odoo 19 end-to-end PDFium capture test; never a physical print."""
import base64
import binascii
import logging
import uuid

import requests
from odoo import fields, models, _
from odoo.exceptions import AccessError, ValidationError

_logger = logging.getLogger(__name__)

MAX_CAPTURE_BYTES = 4 * 1024 * 1024


class PrintGatewayE2ECaptureWizard(models.TransientModel):
    _name = "print_gateway.e2e_capture_wizard"
    _description = "End-to-End Document Capture Test"

    config_id = fields.Many2one("print_gateway.gateway_config", required=True)
    company_id = fields.Many2one("res.company", related="config_id.company_id", readonly=True)
    branch_id = fields.Many2one("res.company", domain="[('parent_id', '=', company_id)]")
    runtime_agent_id = fields.Char(required=True, string="Windows Agent")
    document_kind = fields.Selection([
        ("diagnostic", "Odoo PDF test page"),
        ("invoice", "Odoo customer invoice PDF"),
        ("receipt", "Odoo POS / Kitchen / Bar JPEG"),
    ], required=True, default="diagnostic", string="Test document")
    invoice_id = fields.Many2one("account.move", string="Customer invoice")
    receipt_jpeg = fields.Binary(string="Exported receipt JPEG", attachment=False)
    paper_mm = fields.Selection([
        ("58", "58 mm"),
        ("80", "80 mm"),
    ], default="80", required=True)
    run_id = fields.Char(readonly=True)
    capture_status = fields.Selection([
        ("draft", "Ready to test"),
        ("queued", "Waiting for Windows Agent"),
        ("claimed", "Rendering on Windows Agent"),
        ("rendered_locally", "Rendered locally — not printed"),
        ("failed", "Test failed"),
        ("expired", "Test expired"),
    ], readonly=True, default="draft")
    page_count = fields.Integer(readonly=True)
    pdf_sha256 = fields.Char(readonly=True)
    pdf_bytes = fields.Integer(readonly=True)
    preview_image = fields.Image(attachment=False, readonly=True)
    error_code = fields.Char(readonly=True)

    def _assert_allowed(self):
        self.ensure_one()
        if not (self.env.is_superuser() or self.env.user.has_group("base.group_system")):
            raise AccessError(_("Only Odoo administrators can run E2E capture tests."))
        company = self.config_id.company_id
        if not self.config_id.enabled or not company or company not in self.env.user.company_ids:
            raise AccessError(_("The selected Odoo company is not enabled or accessible."))
        if self.branch_id and (
            self.branch_id.parent_id != company or
            self.branch_id not in self.env.user.company_ids
        ):
            raise AccessError(_("The selected branch does not belong to this company."))
        assigned = self.env["print_gateway.runtime_agent_assignment"].assigned_agent_ids(company, self.branch_id)
        if not self.runtime_agent_id or self.runtime_agent_id.strip() not in assigned:
            raise ValidationError(_("Select an enabled Windows Agent assigned to this company or branch."))
        if not self.config_id.gateway_url:
            raise ValidationError(_("Configure the Gateway URL first."))
        return company

    def _source_pdf(self, company):
        if self.document_kind == "receipt":
            if not self.receipt_jpeg:
                raise ValidationError(_("Upload an Odoo-exported receipt JPEG first."))
            encoded = self.receipt_jpeg
            if isinstance(encoded, str):
                encoded = encoded.encode("ascii")
            if len(encoded) > MAX_CAPTURE_BYTES * 4 // 3 + 8:
                raise ValidationError(_("The receipt exceeds the 4 MiB test limit."))
            try:
                decoded = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValidationError(_("Invalid JPEG upload.")) from exc
            if not decoded.startswith(b"\xff\xd8\xff") or len(decoded) > MAX_CAPTURE_BYTES:
                raise ValidationError(_("A valid JPEG smaller than 4 MiB is required."))
            return "image", base64.b64encode(decoded).decode("ascii"), int(self.paper_mm)

        if self.document_kind == "invoice":
            invoice = self.invoice_id
            if not invoice or invoice.move_type not in ("out_invoice", "out_refund"):
                raise ValidationError(_("Select a customer invoice."))
            expected_company = self.branch_id or company
            if invoice.company_id != expected_company or expected_company not in self.env.user.company_ids:
                raise AccessError(_("The invoice must belong to the selected company or branch."))
            invoice.check_access("read")
            pdf, content_type = self.env["ir.actions.report"].with_context(
                force_report_rendering=True,
            )._render_qweb_pdf("account.account_invoices", res_ids=[invoice.id])
            if content_type != "pdf":
                raise ValidationError(_("Odoo did not return a PDF invoice."))
        else:
            pdf = self.env["print_gateway.print_router"]._generate_test_pdf(
                company_name=company.name,
                branch_name=self.branch_id.name if self.branch_id else _("Main company"),
                printer_name=_("E2E simulation only — no printer"),
                now_str=fields.Datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )

        if not isinstance(pdf, bytes) or not pdf.startswith(b"%PDF-") or len(pdf) > MAX_CAPTURE_BYTES:
            raise ValidationError(_("Odoo generated an invalid or oversized PDF (maximum 4 MiB)."))
        if b"%%EOF" not in pdf[-4096:]:
            raise ValidationError(_("The Odoo PDF is missing its completion marker."))
        return "pdf", base64.b64encode(pdf).decode("ascii"), 0

    def _form_action(self):
        return {"type": "ir.actions.act_window", "name": _("E2E Capture Test"),
                "res_model": self._name, "res_id": self.id,
                "view_mode": "form", "target": "new"}

    def action_start_test(self):
        self.ensure_one()
        company = self._assert_allowed()
        document_type, encoded, paper_mm = self._source_pdf(company)
        payload = {
            "agentId": self.runtime_agent_id.strip(),
            "idempotencyKey": "odoo-capture-" + uuid.uuid4().hex,
            "paperMm": paper_mm,
            "payload": {"type": document_type, "encoding": "base64", "data": encoded},
        }
        config = self.config_id
        try:
            response = requests.post(
                "%s/api/odoo/test-captures" % config._gateway_base(for_request=True),
                headers=config._gateway_headers(),
                json=payload, timeout=18, allow_redirects=False,
            )
        except requests.RequestException as exc:
            _logger.warning("E2E capture start could not reach Gateway: %s", exc.__class__.__name__)
            raise ValidationError(_("The Gateway is unavailable. Verify HTTPS connectivity.")) from exc
        if response.status_code not in (200, 202):
            _logger.warning("E2E capture request was rejected by Gateway (HTTP %s)", response.status_code)
            raise ValidationError(_("Gateway refused the capture test (HTTP %s). Check the feature flag and Agent assignment.") % response.status_code)
        try:
            data = response.json()
            run_id = data.get("runId") if isinstance(data, dict) else None
            if not isinstance(run_id, str) or not run_id.startswith("cap_"):
                raise ValueError("missing run id")
        except (ValueError, TypeError) as exc:
            raise ValidationError(_("Gateway returned an invalid capture acceptance.")) from exc
        self.write({
            "run_id": run_id, "capture_status": "queued", "page_count": 0,
            "pdf_sha256": False, "pdf_bytes": 0, "preview_image": False, "error_code": False,
        })
        return self._form_action()

    def action_refresh_test(self):
        self.ensure_one()
        self._assert_allowed()
        if not self.run_id:
            raise ValidationError(_("Start a capture test first."))
        try:
            response = requests.get(
                "%s/api/odoo/test-captures" % self.config_id._gateway_base(for_request=True),
                headers=self.config_id._gateway_headers(),
                params={"id": self.run_id}, timeout=15, allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise ValidationError(_("Could not read the capture result from Gateway.")) from exc
        if response.status_code != 200:
            raise ValidationError(_("Gateway capture status is unavailable (HTTP %s).") % response.status_code)
        try:
            data = response.json()
        except ValueError as exc:
            raise ValidationError(_("Invalid Gateway capture result.")) from exc
        if not isinstance(data, dict) or data.get("runId") != self.run_id or data.get("physicalPrinted") is not False:
            raise ValidationError(_("Unexpected capture result. No print result was assumed."))
        status = data.get("status")
        if status not in ("queued", "claimed", "rendered_locally", "failed", "expired"):
            raise ValidationError(_("Unknown Gateway capture status."))
        image_uri = data.get("previewDataUri") or ""
        if image_uri and (
            not isinstance(image_uri, str) or
            not image_uri.startswith("data:image/jpeg;base64,") or
            len(image_uri) > 400000
        ):
            raise ValidationError(_("Gateway capture preview was rejected."))
        self.write({
            "capture_status": status,
            "page_count": int(data.get("pageCount") or 0),
            "pdf_sha256": data.get("pdfSha256") or False,
            "pdf_bytes": int(data.get("pdfBytes") or 0),
            "preview_image": image_uri.split(",", 1)[1] if image_uri else False,
            "error_code": data.get("errorCode") or False,
        })
        return self._form_action()
