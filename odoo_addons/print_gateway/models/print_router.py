# -*- coding: utf-8 -*-
"""Single Odoo print-routing authority for Gateway-enabled printing."""

import base64
import binascii
import hashlib
import logging
import time
import uuid

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError

from .binding import _assert_report_usage_access

REPORT_DOCUMENT_TYPES = {
    "sale.order": "order",
    "account.move": "invoice",
    "stock.picking": "delivery",
    "purchase.order": "purchase_order",
    "pos.order": "receipt",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024
_logger = logging.getLogger(__name__)


def _zpl_text(value):
    """Sanitize free text for a ZPL ^FD field: strip command introducers
    (^, ~) and C0 controls so company/printer names cannot inject additional
    ZPL commands into the diagnostic stream."""
    text = str(value or "")
    return "".join(ch for ch in text if ch not in "^~" and (ch >= " " or ch in "\n\t")).strip()[:80]


def _tspl_text(value):
    """Sanitize free text for a TSPL quoted TEXT argument: strip quotes and
    C0 controls so names cannot terminate the argument early."""
    text = str(value or "")
    return "".join(ch for ch in text if ch != '"' and " " <= ch != "\x7f").strip()[:80]


def _escpos_text(value):
    """Sanitize free text for ESC/POS diagnostic tickets: the ticket builder
    injects its own control bytes, so user content must carry none."""
    text = str(value or "")
    return "".join(ch for ch in text if ch >= " ").strip()[:80]


class PrintGatewayRouter(models.AbstractModel):
    _name = "print_gateway.print_router"
    _description = "Print Gateway Central Router"

    @api.private
    def _submission_message(self, job_id, status):
        """Explain durable delivery status without claiming physical paper output.

        Gateway admission, agent execution and actual paper ejection are distinct
        events. Current transports have no independent paper-out sensor.
        """
        if status == "queued":
            return _("Print job %s is queued for Gateway submission. Check Print Activity before reprinting.") % job_id
        if status == "submitted":
            return _("Print job %s submitted to the Gateway; printer output is not confirmed.") % job_id
        if status == "claimed":
            return _("Print job %s claimed by an agent; printer output is not confirmed.") % job_id
        if status == "printing":
            return _("Print job %s is processing on an agent; printer output is not confirmed.") % job_id
        if status == "success":
            return _("Print job %s completed by the agent; physical paper output is not independently confirmed.") % job_id
        if status == "failed":
            return _("Print job %s failed. Check Print Activity and the printer before trying again.") % job_id
        return _("Print job %s has an unknown outcome. Check the printer and Print Activity before trying again.") % job_id

    @api.model
    def _binding_scope(self, company=None):
        """Return (Odoo company owning the Gateway config, branch context)."""
        company = company or self.env.company
        branch = company if company.parent_id else False
        gateway_company = company
        while gateway_company.parent_id:
            gateway_company = gateway_company.parent_id
        return gateway_company, branch

    @api.model
    def _gateway_config(self, company):
        company = company or self.env.company
        root_company = company
        while root_company.parent_id:
            root_company = root_company.parent_id
        config = self.env["print_gateway.gateway_config"].sudo().search(
            [("company_id", "=", root_company.id)], limit=1,
        )
        return config if config and config.enabled else False

    @api.model
    def _assert_current_company(self, company, record=None):
        current = self.env.company
        if not company or company != current:
            raise ValidationError(
                _("Print routing must use the active Odoo company/branch (%s).") % current.display_name
            )
        if record and getattr(record, "company_id", False) and record.company_id != current:
            raise ValidationError(
                _("The printable document belongs to %s, but the active Odoo company/branch is %s.")
                % (record.company_id.display_name, current.display_name)
            )
        return current

    @api.model
    def _document_type(self, report=None, record=None, explicit=None):
        value = explicit or self.env.context.get("print_gateway_document_type")
        if value:
            normalized = str(value).strip().lower()
            if normalized:
                return normalized
        model = record._name if record else report.model if report else ""
        if model in REPORT_DOCUMENT_TYPES:
            return REPORT_DOCUMENT_TYPES[model]
        if report:
            technical = (report.report_name or "").strip().lower()
            if technical:
                return "report:%s" % technical
        raise ValidationError(_("Print document type cannot be determined for this print action."))

    @api.model
    @api.private
    def destination_for(self, *, report=None, record=None, explicit_destination=None):
        return self.env["print_gateway.binding"].destination_for(
            record=record,
            report=report,
            explicit_destination=explicit_destination,
        )

    @api.model
    def _assert_branch_agent_assignment(self, gateway_company, branch, runtime_agent_id):
        """Fail closed unless the Agent is assigned to the current Odoo scope."""
        if not runtime_agent_id:
            return
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        if not assignment_model.is_agent_assigned(gateway_company, branch, runtime_agent_id):
            raise ValidationError(
                _("Gateway Runtime Agent '%s' is not assigned to the current Odoo Branch.") % runtime_agent_id
            )

    @api.model
    @api.private
    def resolve_binding(self, *, report=None, record=None, document_type=None, company=None, explicit_destination=None, explicit_binding=None, protocol=None, payload_type=None, raise_if_not_found=True):
        current_company = self.env.company
        requested_company = company or current_company
        self._assert_current_company(requested_company, record=record)
        gateway_company, branch = self._binding_scope(current_company)
        config = self._gateway_config(current_company)
        if not config:
            return {"gateway_enabled": False, "native": True}
        dtype = self._document_type(report=report, record=record, explicit=document_type)
        # destination_for() raises when there is no Odoo record, no report and
        # no explicit destination. That is correct for implicit routing, but the
        # operator diagnostic (binding.action_send_test_print ->
        # _route_spooler_test_page / _route_ipp_test_page) is deliberately
        # invoked with explicit_binding and no document at all: the binding IS
        # the routing decision, and the ticket only needs its own declared
        # protocol. Derive the destination from that binding instead of
        # raising, so resolve_explicit() still performs its full identity,
        # company/branch, protocol and payload_type validation below.
        destination = False
        if report or record or explicit_destination:
            destination = self.destination_for(
                report=report,
                record=record,
                explicit_destination=explicit_destination,
            )
        elif explicit_binding and getattr(explicit_binding, "destination_ref", False):
            destination = explicit_binding.destination_ref
        binding_model = self.env["print_gateway.binding"].sudo()
        if explicit_binding and report and not explicit_destination:
            # An explicitly selected report-action destination is valid even
            # when a record also has an operational destination. Only the
            # actual report (or a matching operational destination) is allowed.
            selected_destination = explicit_binding.destination_ref
            if selected_destination == report:
                destination = report
        if explicit_binding:
            binding = binding_model.resolve_explicit(
                explicit_binding,
                gateway_company,
                dtype,
                destination,
                report=report,
                branch=branch,
                protocol=protocol,
                payload_type=payload_type,
            )
        else:
            binding = binding_model.find_for(
                gateway_company,
                dtype,
                report=report,
                record=record,
                explicit_destination=explicit_destination,
                branch=branch,
            )
        if not binding:
            if not raise_if_not_found:
                return {
                    "gateway_enabled": True,
                    "native": True,
                    "binding": False,
                    "binding_id": False,
                    "printer_id": False,
                    "runtime_agent_id": False,
                    "document_type": dtype,
                    "destination": destination,
                    "company": gateway_company,
                    "branch": branch,
                }
            raise ValidationError(
                _("Gateway printing is enabled, but no Print Binding exists for %s (%s) in %s.")
                % (destination.display_name, dtype, branch.display_name if branch else gateway_company.display_name)
            )
        # Persist the identity actually resolved, not merely the first
        # operational candidate used to search for a report binding.
        destination = binding.destination_ref
        self._assert_branch_agent_assignment(gateway_company, binding.branch_id or False, binding.runtime_agent_id)
        return {
            "gateway_enabled": True,
            "native": False,
            "config": config,
            "binding": binding,
            "binding_id": binding.id if binding else False,
            "printer_id": binding.printer_id if binding else False,
            "runtime_agent_id": binding.runtime_agent_id if binding else False,
            "document_type": dtype,
            "destination": destination,
            "company": gateway_company,
            "branch": branch,
        }

    @staticmethod
    def _validate_pdf(pdf_content, report):
        if isinstance(pdf_content, (list, tuple)):
            pdf_content = pdf_content[0] if pdf_content else b""
        if not pdf_content or not bytes(pdf_content).startswith(b"%PDF-"):
            raise ValidationError(_("The rendered report %s is not a valid PDF.") % report.display_name)
        return bytes(pdf_content)

    @staticmethod
    def _validate_jpeg_base64(image):
        if not isinstance(image, str) or not image:
            raise ValidationError(_("The POS print image is missing."))
        try:
            data = base64.b64decode(image, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValidationError(_("The POS print image is not valid base64.")) from exc
        if not data or len(data) > MAX_IMAGE_BYTES or not data.startswith(b"\xff\xd8\xff"):
            raise ValidationError(_("The POS print image is not a valid JPEG or exceeds the 5 MiB safety limit."))
        return image

    @api.model
    def _render_pdf_payload(self, report, records, data=None):
        report.ensure_one()
        records = records.exists()
        if not records:
            raise ValidationError(_("Cannot print an empty report."))
        try:
            pdf_content, report_format = report._render_qweb_pdf(report, res_ids=records.ids, data=data)
        except Exception as exc:
            raise ValidationError(_("Failed to render %s for Gateway printing.") % report.display_name) from exc
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(self._validate_pdf(pdf_content, report)).decode("ascii"),
        }

    @api.model
    def _render_pdf_payload_from_target(self, report_ref, render_target, *, context_values=None):
        try:
            renderer = self.env["ir.actions.report"].with_context(**(context_values or {}))
            res_ids = render_target.ids if hasattr(render_target, "ids") and render_target.ids else False
            pdf_content, report_format = renderer._render_qweb_pdf(report_ref, res_ids=res_ids, data=context_values)
        except Exception as exc:
            report = self.env.ref(report_ref, raise_if_not_found=False)
            label = report.display_name if report else report_ref
            raise ValidationError(_("Failed to render %s for Gateway printing.") % label) from exc
        report = self.env.ref(report_ref, raise_if_not_found=False)
        if not report:
            raise ValidationError(_("The requested report is unavailable."))
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(self._validate_pdf(pdf_content, report)).decode("ascii"),
        }

    @api.model
    def _persist_durable_job(self, values):
        """Create the durable Odoo outbox row in an independent transaction.

        TRANSACTION CONTRACT (do not weaken): every production caller
        invokes this from a standalone print request (report download,
        POS receipt/kitchen/sale-details, test page) or from post-commit
        intent dispatch - i.e. there is deliberately NO enclosing business
        mutation that could roll back afterwards and orphan a submitted
        print. Business-event flows must go through print_gateway.intent
        (created atomically inside the business transaction, dispatched
        via cr.postcommit), never by nesting this call inside business
        writes. If a future caller needs business-atomicity, it must create
        the row in the caller's own transaction and defer submission to
        postcommit instead of using this helper."""
        durable_values = dict(values)
        for key in ("company", "gateway_config", "report", "fallback_binding"):
            record = durable_values.get(key)
            durable_values[key] = record.id if record else False

        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            for key, model_name in (
                ("company", "res.company"),
                ("gateway_config", "print_gateway.gateway_config"),
                ("report", "ir.actions.report"),
                ("fallback_binding", "print_gateway.binding"),
            ):
                record_id = durable_values.get(key)
                if not record_id:
                    durable_values[key] = False
                    continue
                # Elevated re-fetch: authorization for company/config/binding/
                # report was already established by resolve_binding in the
                # caller's context; this only proves the rows still exist.
                # Requiring the operator's raw rights here as well would
                # spuriously fail legitimate prints (e.g. a branch operator
                # printing through a root-company Gateway config), and the
                # create_operation service boundary performs its own checks.
                record = env[model_name].sudo().browse(record_id).exists()
                if not record:
                    raise ValidationError(_("The durable print operation references a record that is no longer available."))
                durable_values[key] = record
            target_company = durable_values.get("company")
            model = env["print_gateway.print_job"]
            if target_company:
                model = model.with_company(target_company)
            job = model.create_operation(**durable_values)
            job_id = job.id
            cr.commit()
        finally:
            cr.close()
        return job_id

    def _durable_submission_outcome(self, job, message=None):
        """Expose persisted evidence, never infer safe retry from an RPC error."""
        status = job.status
        uncertain = (
            status not in ("queued", "submitted", "claimed", "printing", "success", "failed")
            or (status == "failed" and str(job.last_error or "").startswith(job._GATEWAY_UNKNOWN_MARKERS))
        )
        if uncertain:
            status = "unknown"
            message = _("Print status is unknown. Check the printer before trying again.")
        elif status == "failed":
            message = message or _("Kitchen / Preparation printing failed.")
        elif status == "queued" and not job.gateway_job_id:
            # The committed Odoo outbox owns delivery, but Gateway admission
            # has not happened yet (backoff or another submission worker).
            message = message or _("Queued")
        else:
            message = message or self._submission_message(job.id, status)
        return {
            "status": status,
            "outcome": (
                "unknown" if uncertain else "failed" if status == "failed"
                else "queued" if status == "queued" and not job.gateway_job_id else "accepted"
            ),
            "can_retry": status == "failed" and not uncertain,
            "gateway_job_id": job.gateway_job_id or False,
            "message": message,
        }

    @api.model
    def _submit_durable_job(self, job_id, *, structured_outcome=False):
        """Submit on a fresh transaction; opt-in clients retain durable outcome evidence."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            job = env["print_gateway.print_job"].browse(job_id).exists()
            if not job:
                raise ValidationError(_("The durable print job is no longer available."))
            try:
                job = job.with_company(job.company_id)
                # Trusted internal submission: the outbox stays read-only
                # for the print operator (see _action_submit_trusted); the
                # guarded public action_submit() would AccessError here.
                job._action_submit_trusted(raise_on_failure=True)
                result = self._durable_submission_outcome(job) if structured_outcome else job.status
                cr.commit()
                return result
            except Exception as error:
                cr.rollback()
                if structured_outcome:
                    # Submission persists refusal/unknown/backoff on its own
                    # cursor before raising. Re-fetch after rollback so the
                    # RPC can distinguish that evidence from a lost response.
                    job = env["print_gateway.print_job"].browse(job_id).exists()
                    if job:
                        job.invalidate_recordset(["status", "last_error", "next_retry_at", "gateway_job_id"])
                        if (
                            job.status in ("failed", "unknown", "partial")
                            or job.gateway_job_id
                            or (job.status == "queued" and job.last_error and job.next_retry_at)
                        ):
                            return self._durable_submission_outcome(job, message=str(error))
                # No authoritative outcome was recorded. Preserve the RPC
                # exception; the client must treat submission as uncertain.
                raise
        finally:
            cr.close()

    def _submit_route(
        self, *, route, payload, company, report=None, source_model=None,
        source_record_id=None, idempotency_key=None, structured_outcome=False,
    ):
        self._assert_current_company(company)
        binding = route.get("binding")
        if binding and isinstance(payload, dict):
            ptype = str(payload.get("type") or "").strip().lower()
            proto = str(payload.get("protocol") or "").strip().lower()
            is_escpos = ptype == "escpos" or (ptype == "raw" and proto == "escpos")
            if is_escpos:
                periph = binding.get_peripheral_payload()
                if periph:
                    payload["peripherals"] = periph
                else:
                    payload.pop("peripherals", None)
            else:
                payload.pop("peripherals", None)
        route_start = time.monotonic()
        persist_start = time.monotonic()
        job_id = self._persist_durable_job({
            "company": company,

            "gateway_config": route["config"],
            "printer_id": route["binding"].printer_id,
            "destination": route["destination"].display_name,
            "destination_key": "%s,%s" % (route["destination"]._name, route["destination"].id),
            # Persist the semantic document type that was actually validated
            # against the selected binding. Diagnostic provenance lives in
            # source_model/source_record_id rather than a synthetic document type.
            "document_type": route["document_type"],
            "payload": payload,
            "source_model": source_model,
            "source_record_id": source_record_id,
            "report": report,
            "fallback_binding": route["binding"].fallback_binding_id if route.get("binding") else None,
            "idempotency_key": idempotency_key or uuid.uuid4().hex,
        })
        persist_ms = int((time.monotonic() - persist_start) * 1000)
        submit_start = time.monotonic()
        outcome = self._submit_durable_job(job_id, structured_outcome=True) if structured_outcome else None
        status = outcome["status"] if structured_outcome else self._submit_durable_job(job_id)
        submit_ms = int((time.monotonic() - submit_start) * 1000)
        _logger.info(
            "print.trace odoo_route job_id=%s printer_id=%s persist_ms=%d gateway_submit_ms=%d total_ms=%d",
            job_id,
            route["binding"].printer_id,
            persist_ms,
            submit_ms,
            int((time.monotonic() - route_start) * 1000),
        )
        return {
            "gateway_enabled": True,
            "native": False,
            "status": status,
            "job_id": job_id,
            "message": self._submission_message(job_id, status),
            **(outcome or {}),
        }

    @api.model
    @api.private
    def route_report(self, report, records, data=None, explicit_binding=None, idempotency_key=None):
        report.ensure_one()
        report = _assert_report_usage_access(self.env, report)
        records = records.exists()
        # Optional report interception must not break native Odoo when there
        # is no matching exact report binding. An explicit operator-selected
        # binding remains strict and never silently falls back to native.
        route = self.resolve_binding(
            report=report,
            record=records[0] if records else None,
            company=self.env.company,
            explicit_binding=explicit_binding or None,
            payload_type="pdf",
            raise_if_not_found=bool(explicit_binding),
        )
        if route.get("native"):
            return route
        if not records:
            raise ValidationError(_("Gateway printing requires at least one report record."))

        selected_binding_id = route["binding"].id
        for record in records[1:]:
            if hasattr(record, "company_id") and record.company_id and record.company_id != self.env.company:
                raise ValidationError(_("Selected records belong to conflicting routing scopes."))
            candidate = self.resolve_binding(
                report=report,
                record=record,
                company=self.env.company,
                explicit_binding=explicit_binding or None,
                payload_type="pdf",
            )
            if candidate["binding"].id != selected_binding_id:
                raise ValidationError(_("The selected records resolve to different Print Bindings. Print them separately."))

        # Caller-supplied operation identity (one per user click) makes
        # lost-response retries safe: same key + same payload reuses the
        # existing job, same key + different payload fails loudly instead of
        # printing twice. Without a caller key each RPC mints randomness, so
        # deliberate reprints (new clicks) never collide while retries must
        # carry the original operation id.
        return self._submit_route(
            route=route,
            payload=self._render_pdf_payload(report, records, data=data),
            company=self.env.company,
            report=report,
            source_model=records[0]._name,
            source_record_id=records[0].id,
            idempotency_key=idempotency_key,
        )

    @api.model
    @api.private
    def route_render_target(
        self, report_ref, render_target, *, company=None, document_type=None,
        explicit_destination=None, context_values=None,
    ):
        report = self.env.ref(report_ref, raise_if_not_found=False) if isinstance(report_ref, str) else report_ref
        if not report:
            raise ValidationError(_("The requested report is unavailable."))
        report.ensure_one()
        report = _assert_report_usage_access(self.env, report)
        company = company or self.env.company
        self._assert_current_company(company)
        route = self.resolve_binding(
            report=report, document_type=document_type, company=company,
            explicit_destination=explicit_destination,
        )
        if route.get("native"):
            return route
        payload = self._render_pdf_payload_from_target(
            report.get_external_id().get(report.id, report.report_name),
            render_target,
            context_values=context_values,
        )
        return self._submit_route(route=route, payload=payload, company=company, report=report, source_model=report.model)

    @api.model
    @api.private
    def _receipt_width_for_route(self, route):
        """Return a hardware-informed canvas width, not an arbitrary 96-DPI size.

        The target is the very same company/branch/agent/printer binding used
        by dispatch. The Gateway exposes only a bounded numeric printable
        width to authorized Odoo integrations. No guessing from printer
        names or from CSS screen pixels.
        """
        binding = route.get("binding") if isinstance(route, dict) else None
        if not binding:
            return 512  # Odoo 19's default 80mm / 180dpi snapshot width
        printer = binding._validate_runtime_target(enforce_destination_compatibility=True)
        width = (printer or {}).get("printableWidthDots")
        if type(width) is int and 288 <= width <= 576:
            return width
        return 512

    @api.model
    @api.private
    def route_pos_receipt(self, order, image_base64, *, idempotency_key=None):
        order.ensure_one()
        self._assert_current_company(order.company_id, record=order)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(record=order, company=self.env.company, document_type="receipt")
        if route.get("native"):
            raise ValidationError(
                _("Gateway printing is enabled for this POS, but no Gateway Receipt binding is configured for the current branch/POS.")
            )
        # Stable idempotency key: a double-tap on the same order cannot produce
        # a second physical print within the Gateway deduplication window.
        # The caller may supply an explicit key (e.g. from the JS in-flight
        # guard); fall back to a deterministic order+binding token so an RPC
        # retry is also safe.
        if not idempotency_key:
            binding_id = route.get("binding") and route["binding"].id or 0
            raw_token = f"receipt:{order.id}:{binding_id}:{getattr(order, 'write_date', '')}"
            idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        return self._submit_route(
            route=route, payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=self.env.company, source_model=order._name, source_record_id=order.id,
            idempotency_key=idempotency_key,
            # Preserve unknown physical-outcome markers from the durable Odoo
            # outbox. A plain failed status can hide possible paper output.
            structured_outcome=True,
        )

    @api.model
    @api.private
    def route_kitchen_print(self, order, image_base64, *, reprint=False, idempotency_key=None, pos_printer=None):
        order.ensure_one()
        self._assert_current_company(order.company_id, record=order)
        company = self.env.company
        self._validate_jpeg_base64(image_base64)
        explicit_destination = order.config_id
        if pos_printer:
            pos_printer.ensure_one()
            preparation_printers = getattr(order.config_id, "preparation_printer_ids", None)
            if preparation_printers is None:
                preparation_printers = order.config_id.printer_ids
            if pos_printer not in preparation_printers:
                raise ValidationError(_("The selected Odoo Preparation Printer does not belong to this POS."))
            explicit_destination = pos_printer
        route = self.resolve_binding(
            record=order,
            company=company,
            document_type="kitchen",
            explicit_destination=explicit_destination,
        )
        if route.get("native"):
            raise ValidationError(
                _("Gateway printing is enabled for this POS, but no Gateway Kitchen binding is configured for the selected preparation printer.")
            )
        return self._submit_route(
            route=route, payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=company, source_model=order._name, source_record_id=order.id, idempotency_key=idempotency_key,
            structured_outcome=True,
        )

    @api.model
    @api.private
    def route_pos_sale_details(self, session, image_base64, *, idempotency_key=None):
        # Odoo 19 renders Sale Details inside the POS and submits the rendered
        # element through the same receipt-printer path used for POS receipts.
        # Therefore the in-session Gateway path is a receipt job addressed to
        # the current POS config, not a report-action destination.  The direct
        # /pos/sale_details_report HTTP endpoint remains a separate PDF/report
        # path and intentionally resolves an ir.actions.report binding.
        session.ensure_one()
        self._assert_current_company(session.company_id, record=session)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(
            company=self.env.company,
            document_type="receipt",
            explicit_destination=session.config_id,
        )
        if route.get("native"):
            raise ValidationError(
                _("Gateway printing is enabled for this POS, but no Gateway Receipt binding is configured for Sale Details.")
            )
        # Deterministic key so an RPC retry cannot produce a second physical print.
        if not idempotency_key:
            binding_id = route.get("binding") and route["binding"].id or 0
            raw_token = f"sale_details:{session.id}:{binding_id}:{getattr(session, 'write_date', '')}"
            idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        return self._submit_route(
            route=route, payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=self.env.company, source_model=session._name, source_record_id=session.id,
            idempotency_key=idempotency_key,
            # Preserve unknown physical-outcome markers from the durable Odoo
            # outbox. A plain failed status can hide possible paper output.
            structured_outcome=True,
        )

    @api.model
    @api.private
    def route_intent(self, intent, record=None):
        """Route an automated print policy intent to the Outbox."""
        policy = intent.policy_id
        target_record = record or self.env[intent.res_model].browse(intent.res_id).exists()
        if not target_record:
            return {"status": "skipped", "message": _("Source record no longer exists.")}

        company = target_record.company_id if hasattr(target_record, "company_id") and target_record.company_id else self.env.company
        config = self._gateway_config(company)
        if not config:
            return {"status": "skipped", "message": _("Gateway printing is not enabled for company %s") % company.display_name}

        # Action type authority: check action_type explicitly
        if policy.action_type == "report":
            if not policy.report_id:
                raise ValidationError(_("Policy '%s' is configured for report action but has no report selected.") % policy.name)
            route = self.resolve_binding(
                report=policy.report_id,
                record=target_record,
                company=company,
                explicit_destination=policy.binding_id.destination_ref if policy.binding_id else None,
                explicit_binding=policy.binding_id or None,
                payload_type="pdf",
            )
            if route.get("native"):
                return {"status": "skipped", "message": _("Policy resolved to native print.")}
            res = self._submit_route(
                route=route,
                payload=self._render_pdf_payload(policy.report_id, target_record),
                company=company,
                report=policy.report_id,
                source_model=target_record._name,
                source_record_id=target_record.id,
                idempotency_key=intent.intent_key,
            )
            return {
                "status": "dispatched",
                "job_id": res.get("job_id"),
                "message": res.get("message"),
            }

        elif policy.action_type == "raw_template":
            if not policy.raw_protocol:
                raise ValidationError(_("Policy '%s' raw protocol is required.") % policy.name)
            raw_data = policy.render_raw_template(target_record, protocol=policy.raw_protocol)
            res = self.route_raw_command(
                raw_data,
                protocol=policy.raw_protocol,
                binding=policy.binding_id or False,
                record=target_record,
                company=company,
                document_type="label",
                idempotency_key=intent.intent_key,
            )
            if res.get("native"):
                return {"status": "skipped", "message": _("Policy resolved to native print.")}
            return {
                "status": "dispatched",
                "job_id": res.get("job_id"),
                "message": res.get("message"),
            }

        raise ValidationError(_("No valid action configured for policy %s (action_type: %s)") % (policy.name, policy.action_type))

    @api.model
    @api.private
    def route_raw_command(
        self, raw_data, *, protocol, binding=None, destination=None,
        record=None, company=None, document_type="label", idempotency_key=None,
    ):
        """Directly route raw printer commands (ZPL/TSPL/ESC-POS) without QWeb rendering.

        `protocol` is REQUIRED (no default): a byte stream without an
        explicitly declared language is malformed input, and guessing "zpl"
        for it would misroute it to label hardware.
        """
        if protocol not in ("zpl", "tspl", "escpos", "raw"):
            raise ValidationError(_("Unsupported raw protocol '%s'. Expected zpl, tspl, escpos, or raw.") % protocol)
        current_company = company or (record.company_id if record and hasattr(record, "company_id") else self.env.company)
        config = self._gateway_config(current_company)
        if not config:
            return {"gateway_enabled": False, "native": True}

        if binding:
            # A caller-selected binding remains the routing authority. Validate
            # that exact record against the real job context; never resolve a
            # second generic binding and compare identities afterwards.
            route = self.resolve_binding(
                record=record,
                company=current_company,
                document_type=document_type,
                # Use the caller/record destination when one exists. If this is
                # a binding-owned diagnostic with no document/destination,
                # resolve_binding() derives destination_ref from explicit_binding.
                explicit_destination=destination,
                explicit_binding=binding,
                protocol=protocol,
                payload_type="raw_cmd",
            )
        else:
            route = self.resolve_binding(
                record=record,
                company=current_company,
                document_type=document_type,
                explicit_destination=destination,
                protocol=protocol,
                payload_type="raw_cmd",
            )
        if route.get("native"):
            return route
        target_binding = route["binding"]
        target_destination = route["destination"]

        # Binding Protocol Authorization: EXACT match. A 'raw' binding is a
        # generic byte sink; it does not thereby accept zpl/tspl/escpos. An
        # 'unknown' binding is never routable.
        if target_binding and getattr(target_binding, "printer_protocol", False):
            binding_proto = target_binding.printer_protocol
            if binding_proto != protocol:
                raise ValidationError(
                    _("Protocol mismatch: Binding '%s' is declared %s but this job is %s; protocols must match exactly (there is no wildcard).")
                    % (target_binding.display_name, binding_proto, protocol)
                )

        if isinstance(raw_data, str):
            raw_bytes = raw_data.encode("utf-8")
        else:
            raw_bytes = bytes(raw_data)

        # Wire type follows the shared contract
        # (contracts/print-payload-contract.json wireTypes: raw/escpos/pdf/image):
        # only ESC/POS has a dedicated wire type; ZPL/TSPL travel as
        # type=raw with an explicit protocol (the Gateway zod validator
        # rejects type=zpl/tspl, and the Odoo persisted-payload validator
        # only admits raw/escpos). Anything unrecognized stays "raw".
        wire_type = "escpos" if protocol == "escpos" else "raw"
        payload = {
            "type": wire_type,
            "encoding": "base64",
            "data": base64.b64encode(raw_bytes).decode("ascii"),
            "protocol": protocol,
        }
        # Peripherals are ESC/POS hardware commands: they are attached ONLY
        # for escpos jobs, and ONLY the ACTIVE settings (inactive ones are
        # omitted entirely rather than serialized as "none" actions).
        if target_binding and protocol == "escpos":
            periph = target_binding.get_peripheral_payload()
            if periph:
                payload["peripherals"] = periph

        # P0.3 Deterministic raw idempotency key
        if not idempotency_key:
            if record:
                raw_token = f"{record._name}:{record.id}:{document_type}:{target_binding.id}:{getattr(record, 'write_date', '')}"
                idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
            else:
                idempotency_key = uuid.uuid4().hex

        job_id = self._persist_durable_job({
            "company": current_company,
            "gateway_config": config,
            "printer_id": target_binding.printer_id,
            "destination": target_destination.display_name if hasattr(target_destination, "display_name") else str(target_destination),
            "destination_key": "%s,%s" % (target_destination._name, target_destination.id) if hasattr(target_destination, "_name") and getattr(target_destination, "id", False) else False,
            "document_type": document_type,
            "payload": payload,
            "payload_type": "raw_cmd",
            "protocol": protocol,
            "raw_payload": (raw_data.replace("\x00", "\\x00") if isinstance(raw_data, str) else raw_bytes.decode("latin1", errors="replace").replace("\x00", "\\x00")),
            "fallback_binding": target_binding.fallback_binding_id,
            "source_model": record._name if record else ("print_gateway.binding" if binding else False),
            "source_record_id": record.id if record else (binding.id if binding else False),
            "idempotency_key": idempotency_key,
        })
        status = self._submit_durable_job(job_id)
        return {
            "gateway_enabled": True,
            "native": False,
            "status": status,
            "job_id": job_id,
            "message": self._submission_message(job_id, status),
        }

    @api.model
    @api.private
    def route_test_page(self, binding):
        """Send a standardized diagnostic test ticket to the target printer.

        Transport-aware: document printers (spooler/ipp) receive a real valid
        PDF rendered through the driver/IPP transport; byte-stream printers
        receive a protocol-valid ticket. A document printer is never asked to
        consume raw printer-language bytes.
        """
        binding.ensure_one()
        current_company = binding.branch_id or binding.company_id
        # P1-4: If the user's active company does not match the binding's
        # company/branch, resolve_binding() will raise a generic ValidationError.
        # Intercept it here and re-raise with a human-readable switch hint so the
        # operator knows exactly what to do (switch active company in the top
        # nav bar) rather than seeing "Print routing must use the active
        # Odoo company/branch".
        if current_company and current_company != self.env.company:
            raise ValidationError(
                _("The selected binding belongs to company/branch '%(binding_co)s', but your active company is '%(active_co)s'. "
                  "Switch your active company to '%(binding_co)s' in the top navigation bar before sending a test print.")
                % {"binding_co": current_company.display_name, "active_co": self.env.company.display_name}
            )
        config = self._gateway_config(current_company)
        if not config:
            raise ValidationError(_("Print Gateway is disabled for company %s.") % current_company.display_name)

        proto = getattr(binding, "printer_protocol", False)
        if not proto:
            raise ValidationError(_("Printer protocol is required on binding '%s' to send a diagnostic test ticket.") % binding.display_name)

        now_str = fields.Datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        company_name = binding.company_id.name
        branch_name = binding.branch_id.name if binding.branch_id else _("Default / Root")
        printer_name = binding.printer_id

        # SPOOLER: real PDF through the Windows driver path.
        if proto == "spooler":
            return self._route_spooler_test_page(
                binding=binding, company=current_company,
                company_name=company_name, branch_name=branch_name,
                printer_name=printer_name, now_str=now_str,
            )

        # IPP/IPPS: real PDF through the IPP document transport.
        if proto in ("ipp", "ipps"):
            return self._route_ipp_test_page(
                binding=binding, company=current_company,
                company_name=company_name, branch_name=branch_name,
                printer_name=printer_name, now_str=now_str,
            )

        if proto not in ("zpl", "tspl", "raw", "escpos"):
            raise ValidationError(
                _("No canned diagnostic ticket exists for protocol '%s'. Declare an escpos/zpl/tspl/raw/spooler/ipp protocol on the printer, or print a real report through the Gateway.")
                % (proto or "unknown")
            )
        # User-controlled metadata is sanitized per printer language before it
        # is embedded into the command stream: a company named e.g.
        # 'A^XZ\n^XA...' must not inject ZPL commands, and a '"' must not
        # escape a TSPL argument. Plain-text "raw" tickets get control
        # characters stripped as well.
        sanitize = {"zpl": _zpl_text, "tspl": _tspl_text}.get(proto, _escpos_text)
        company_name = sanitize(binding.company_id.name)
        branch_name = sanitize(binding.branch_id.name) if binding.branch_id else _("Default / Root")
        printer_name = sanitize(binding.printer_id)

        if proto == "zpl":
            ticket_raw = (
                "^XA\n"
                "^FO50,40^A0N,36,36^FDYASEIR PRINT GATEWAY^FS\n"
                "^FO50,85^A0N,30,30^FDPRINTER TEST^FS\n"
                "^FO50,125^GB700,2,2^FS\n"
                f"^FO50,145^A0N,26,26^FDCompany : {company_name}^FS\n"
                f"^FO50,180^A0N,26,26^FDLocation: {branch_name}^FS\n"
                f"^FO50,215^A0N,26,26^FDPrinter : {printer_name}^FS\n"
                "^FO50,250^A0N,26,26^FDStatus  : READY^FS\n"
                f"^FO50,285^A0N,22,22^FDTime    : {now_str}^FS\n"
                "^XZ\n"
            )
        elif proto == "tspl":
            ticket_raw = (
                "SIZE 75 mm, 50 mm\n"
                "GAP 2 mm, 0 mm\n"
                "DIRECTION 1\n"
                "CLS\n"
                'TEXT 50,35,"3",0,1,1,"YASEIR PRINT GATEWAY"\n'
                'TEXT 50,70,"2",0,1,1,"PRINTER TEST"\n'
                f'TEXT 50,105,"2",0,1,1,"Company : {company_name}"\n'
                f'TEXT 50,135,"2",0,1,1,"Location: {branch_name}"\n'
                f'TEXT 50,165,"2",0,1,1,"Printer : {printer_name}"\n'
                'TEXT 50,195,"2",0,1,1,"Status  : READY"\n'
                f'TEXT 50,220,"1",0,1,1,"Time    : {now_str}"\n'
                "PRINT 1,1\n"
            )
        elif proto == "raw":
            ticket_raw = (
                "================================\n"
                "     YASEIR PRINT GATEWAY\n"
                "          PRINTER TEST\n"
                "================================\n"
                f"Company : {company_name}\n"
                f"Location: {branch_name}\n"
                f"Printer : {printer_name}\n"
                "Status  : READY\n"
                f"Time    : {now_str}\n"
                "================================\n\n\n"
            )
        elif proto == "escpos":
            ticket_lines = [
                "\x1b\x40",  # Initialize printer
                "\x1b\x61\x01",  # Centered
                "================================\n",
                "     YASEIR PRINT GATEWAY\n",
                "          PRINTER TEST\n",
                "================================\n",
                "\x1b\x61\x00",  # Left align
                f"Company : {company_name}\n",
                f"Location: {branch_name}\n",
                f"Printer : {printer_name}\n",
                "Status  : READY\n",
                f"Time    : {now_str}\n",
                "================================\n\n\n",
            ]
            ticket_raw = "".join(ticket_lines)

        return self.route_raw_command(
            ticket_raw,
            protocol=proto,
            binding=binding,
            company=current_company,
            document_type=binding.document_type,
        )

    @api.model
    @api.private
    def _route_spooler_test_page(self, *, binding, company, company_name, branch_name, printer_name, now_str):
        """PDF test page through the Windows Spooler driver path.

        Exercises the Agent's driver-rendered document path (StartDocW/GDI),
        not RAW WritePrinter. Physical output remains unknown until observed;
        spool acceptance only proves that Windows accepted the document job.
        """
        pdf_content = self._generate_test_pdf(
            company_name=company_name, branch_name=branch_name,
            printer_name=printer_name, now_str=now_str,
        )
        payload = {"type": "pdf", "encoding": "base64", "data": base64.b64encode(pdf_content).decode("ascii")}
        route = self.resolve_binding(
            record=False, company=company, document_type=binding.document_type,
            explicit_binding=binding, payload_type="pdf",
        )
        if route.get("native"):
            raise ValidationError(
                _("Gateway printing is enabled, but the binding resolved to native print. Check the binding configuration.")
            )
        return self._submit_route(
            route=route, payload=payload, company=company,
            source_model="print_gateway.binding", source_record_id=binding.id,
        )

    @api.model
    @api.private
    def _route_ipp_test_page(self, *, binding, company, company_name, branch_name, printer_name, now_str):
        """PDF test page through the IPP document transport."""
        pdf_content = self._generate_test_pdf(
            company_name=company_name, branch_name=branch_name,
            printer_name=printer_name, now_str=now_str,
        )
        payload = {"type": "pdf", "encoding": "base64", "data": base64.b64encode(pdf_content).decode("ascii")}
        route = self.resolve_binding(
            record=False, company=company, document_type=binding.document_type,
            explicit_binding=binding, payload_type="pdf",
        )
        if route.get("native"):
            raise ValidationError(
                _("Gateway printing is enabled, but the binding resolved to native print. Check the binding configuration.")
            )
        return self._submit_route(
            route=route, payload=payload, company=company,
            source_model="print_gateway.binding", source_record_id=binding.id,
        )

    @api.model
    @api.private
    def _generate_test_pdf(self, *, company_name, branch_name, printer_name, now_str):
        """Minimal valid single-page PDF test document.

        Offsets and stream Length are computed from actual content; text is
        PDF-escaped so operator names cannot break document syntax.
        """
        if any(not str(value or "").isascii() for value in (company_name, branch_name, printer_name)):
            # Unicode names require font shaping; the ASCII diagnostic writer
            # cannot represent Arabic using its built-in Type1 font.
            pdf, report_type = self.env["ir.actions.report"].with_context(force_report_rendering=True)._render_qweb_pdf(
                "print_gateway.action_diagnostic_report", res_ids=[],
                data={"company_name": company_name, "branch_name": branch_name,
                      "printer_name": printer_name, "now_str": now_str},
            )
            if report_type != "pdf" or not pdf.startswith(b"%PDF-"):
                raise ValidationError(_("The diagnostic PDF renderer did not return a valid PDF document."))
            return pdf

        def _pdf_text(value):
            text = str(value or "")
            text = "".join(ch for ch in text if ch >= " " or ch in "\n\t").strip()[:80]
            return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

        lines = [
            "BT", "/F1 24 Tf", "72 720 Td",
            "(YASEIR PRINT GATEWAY) Tj",
            "/F1 18 Tf", "0 -40 Td", "(PRINTER TEST PAGE) Tj",
            "/F1 12 Tf", "0 -30 Td",
            f"(Company: {_pdf_text(company_name)}) Tj",
            "0 -20 Td",
            f"(Location: {_pdf_text(branch_name)}) Tj",
            "0 -20 Td",
            f"(Printer: {_pdf_text(printer_name)}) Tj",
            "0 -20 Td", "(Status: READY) Tj",
            "0 -20 Td",
            f"(Time: {_pdf_text(now_str)}) Tj",
            "ET",
        ]
        content = "\n".join(lines).encode("latin-1", errors="replace")
        objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]
        pdf = bytearray(b"%PDF-1.4\n")
        offsets = [0]
        for number, body in enumerate(objects, start=1):
            offsets.append(len(pdf))
            pdf += ("%d 0 obj\n" % number).encode("ascii") + body + b"\nendobj\n"
        xref_pos = len(pdf)
        pdf += ("xref\n0 %d\n" % (len(objects) + 1)).encode("ascii")
        pdf += b"0000000000 65535 f \n"
        for offset in offsets[1:]:
            pdf += ("%010d 00000 n \n" % offset).encode("ascii")
        pdf += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objects) + 1, xref_pos)).encode("ascii")
        return bytes(pdf)

