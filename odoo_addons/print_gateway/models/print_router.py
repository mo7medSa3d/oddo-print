# -*- coding: utf-8 -*-
"""Single Odoo print-routing authority for direct local Agent printing."""

import base64
import binascii
import hashlib
import json
import logging
import time
import textwrap
import uuid

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError

from .binding import _assert_report_usage_access
from ..printer_geometry import normalize_receipt_paper_width_mm, validated_receipt_geometry

REPORT_DOCUMENT_TYPES = {
    "sale.order": "order",
    "account.move": "invoice",
    "stock.picking": "delivery",
    "purchase.order": "purchase_order",
    "pos.order": "receipt",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_BASE64_CHARS = 4 * ((MAX_IMAGE_BYTES + 2) // 3)
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


def _validated_raw_command_bytes(raw_data):
    """Validate raw command input *before* making encoded outbox copies.

    Agent enforce a 5 MiB decoded payload contract, but encoding an
    unbounded Python object before calling create_operation() unnecessarily
    allocates up to 4/3 more memory and builds a second diagnostic copy.
    Never accept integers (bytes(huge_integer)), arbitrary byte conversion
    methods, or empty printer programs as executable instructions.
    """
    if isinstance(raw_data, str):
        if len(raw_data) > MAX_IMAGE_BYTES:
            raise ValidationError(_("Raw printer command exceeds the 5 MiB safety limit."))
        try:
            encoded = raw_data.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ValidationError(_("Raw printer command contains invalid Unicode.")) from exc
    elif isinstance(raw_data, (bytes, bytearray, memoryview)):
        count = raw_data.nbytes if isinstance(raw_data, memoryview) else len(raw_data)
        if count > MAX_IMAGE_BYTES:
            raise ValidationError(_("Raw printer command exceeds the 5 MiB safety limit."))
        encoded = bytes(raw_data)
    else:
        raise ValidationError(_("Raw printer command must be text or bytes."))
    if not encoded or len(encoded) > MAX_IMAGE_BYTES:
        raise ValidationError(_("Raw printer command is empty or exceeds the 5 MiB safety limit."))
    return encoded


class PrintGatewayRouter(models.AbstractModel):
    _name = "print_gateway.print_router"
    _description = "Direct Odoo Print Router"

    @api.private
    def _submission_message(self, job_id, status):
        """Explain durable delivery status without claiming physical paper output.

        Agent claim, agent execution and actual paper ejection are distinct
        events. Current transports have no independent paper-out sensor.
        """
        if status == "queued":
            return _("Print job %s is queued in Odoo for the paired local Agent. Check its Odoo status before reprinting.") % job_id
        if status == "claimed":
            return _("Print job %s was claimed by the paired local Agent; printer output is not confirmed.") % job_id
        if status == "printing":
            return _("Print job %s is processing on the local Agent; printer output is not confirmed.") % job_id
        if status == "success":
            return _("Print job %s completed by the local Agent; physical paper output is not independently confirmed.") % job_id
        if status == "failed":
            return _("Print job %s failed. Check Odoo and the printer before trying again.") % job_id
        return _("Print job %s has an unknown outcome. Check the printer and Odoo before trying again.") % job_id

    @api.model
    def _binding_scope(self, company=None):
        """Return (Odoo company owning the Print Service configuration, branch context)."""
        company = company or self.env.company
        branch = company if company.parent_id else False
        gateway_company = company
        while gateway_company.parent_id:
            gateway_company = gateway_company.parent_id
        return gateway_company, branch

    @api.model
    def _print_config(self, company):
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
        # Deterministic derivation always wins over RPC context. Previously the
        # context key print_gateway_document_type overrode the model-derived type,
        # which could steer binding selection to a different document type for the
        # same report/destination/scope. The context key is now a
        # last resort, honoured only when no type can be derived at all
        # (no mapped model, no report technical name) and only for string
        # values; resolve_explicit() still validates the selected binding
        # against report, destination, company and branch.
        if explicit:
            normalized = str(explicit).strip().lower()
            if normalized:
                return normalized
        model = record._name if record else report.model if report else ""
        if model in REPORT_DOCUMENT_TYPES:
            return REPORT_DOCUMENT_TYPES[model]
        if report:
            technical = (report.report_name or "").strip().lower()
            if technical:
                return "report:%s" % technical
        value = self.env.context.get("print_gateway_document_type")
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized and len(normalized) <= 128:
                return normalized
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
    def _assert_branch_agent_assignment(self, owner_company, branch, agent_uid):
        """Fail closed unless the Agent is assigned to the current Odoo scope."""
        if not agent_uid:
            return
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        if not assignment_model.is_agent_assigned(owner_company, branch, agent_uid):
            raise ValidationError(
                _("Print Agent '%s' is not assigned to the current Odoo Branch.") % agent_uid
            )

    @api.model
    @api.private
    def resolve_binding(self, *, report=None, record=None, document_type=None, company=None, explicit_destination=None, explicit_binding=None, protocol=None, payload_type=None, raise_if_not_found=True):
        current_company = self.env.company
        requested_company = company or current_company
        self._assert_current_company(requested_company, record=record)
        gateway_company, branch = self._binding_scope(current_company)
        config = self._print_config(current_company)
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
                    "agent_uid": False,
                    "document_type": dtype,
                    "destination": destination,
                    "company": gateway_company,
                    "branch": branch,
                }
            raise ValidationError(
                _("Direct Odoo printing is enabled, but no Print Binding exists for %s (%s) in %s.")
                % (destination.display_name, dtype, branch.display_name if branch else gateway_company.display_name)
            )
        # Persist the identity actually resolved, not merely the first
        # operational candidate used to search for a report binding.
        destination = binding.destination_ref
        self._assert_branch_agent_assignment(gateway_company, binding.branch_id or False, (binding.agent_id.agent_uid if binding.agent_id else False))
        return {
            "gateway_enabled": True,
            "native": False,
            "config": config,
            "binding": binding,
            "binding_id": binding.id if binding else False,
            "printer_id": binding.printer_id if binding else False,
            "agent_uid": (binding.agent_id.agent_uid if binding.agent_id else False) if binding else False,
            "document_type": dtype,
            "destination": destination,
            "company": gateway_company,
            "branch": branch,
        }

    @staticmethod
    def _validate_pdf(pdf_content, report):
        if isinstance(pdf_content, (list, tuple)):
            pdf_content = pdf_content[0] if pdf_content else b""
        # Report renderers return bytes. Refuse oversized or incomplete PDFs
        # BEFORE allocating another bytes object or encoding for the outbox.
        # Match the Agent's ValidatePDF header, size, and 4 KiB EOF window.
        if (
            not isinstance(pdf_content, (bytes, bytearray, memoryview))
            or not 0 < len(pdf_content) <= MAX_IMAGE_BYTES
        ):
            raise ValidationError(_("The rendered report %s is invalid or exceeds the 5 MiB safety limit.") % report.display_name)
        pdf = bytes(pdf_content)
        if not pdf.startswith(b"%PDF-") or b"%%EOF" not in pdf[-4096:]:
            raise ValidationError(_("The rendered report %s is not a complete PDF.") % report.display_name)
        return pdf

    @staticmethod
    def _validate_jpeg_base64(image):
        if not isinstance(image, str) or not image:
            raise ValidationError(_("The POS print image is missing."))
        # Base64 decoding is an allocation. Reject giant RPC values first,
        # even when malformed or attacker-supplied, rather than allocating a
        # second multi-megabyte object merely to discover it exceeds 5 MiB.
        if len(image) > MAX_BASE64_CHARS:
            raise ValidationError(_("The POS print image exceeds the 5 MiB safety limit."))
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
            raise ValidationError(_("Failed to render %s for Direct Odoo printing.") % report.display_name) from exc
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(self._validate_pdf(pdf_content, report)).decode("ascii"),
        }

    @api.model
    def _render_pdf_payload_from_target(self, report_ref, render_target, *, context_values=None):
        # context_values doubles as QWeb template
        # data (passed as data= below, unchanged) and as environment context
        # via with_context. Only the in-tree Sale Details keys may enter the
        # environment: any other key (notably company-steering keys) is
        # dropped from the context overlay while remaining available to the
        # template as data. Future render targets needing a new context key
        # must extend this allowlist deliberately.
        render_context = {
            key: value
            for key, value in (context_values or {}).items()
            if key in ("date_start", "date_stop")
        }
        try:
            renderer = self.env["ir.actions.report"].with_context(**render_context)
            res_ids = render_target.ids if hasattr(render_target, "ids") and render_target.ids else False
            pdf_content, report_format = renderer._render_qweb_pdf(report_ref, res_ids=res_ids, data=context_values)
        except Exception as exc:
            report = self.env.ref(report_ref, raise_if_not_found=False)
            label = report.display_name if report else report_ref
            raise ValidationError(_("Failed to render %s for Direct Odoo printing.") % label) from exc
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
        for key in ("company", "print_config", "report", "binding"):
            record = durable_values.get(key)
            durable_values[key] = record.id if record else False

        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            for key, model_name in (
                ("company", "res.company"),
                ("print_config", "print_gateway.gateway_config"),
                ("report", "ir.actions.report"),
                ("binding", "print_gateway.binding"),
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
                # printing through a root-company Print Service configuration), and the
                # create_operation service boundary performs its own checks.
                record = env[model_name].sudo().browse(record_id).exists()
                if not record:
                    raise ValidationError(_("The durable print operation references a record that is no longer available."))
                durable_values[key] = record
            target_company = durable_values.get("company")
            printer_key = str(durable_values.get("printer_id") or "").strip()
            binding_for_check = durable_values.get("binding")
            binding_agent_id = binding_for_check.agent_id.id if binding_for_check and getattr(binding_for_check, "agent_id", False) else None
            if printer_key and target_company:
                root_co = target_company
                while root_co.parent_id:
                    root_co = root_co.parent_id
                if binding_agent_id:
                    cr.execute(
                        """
                        SELECT pr.available_to_odoo, a.active
                          FROM print_gateway_printer pr
                          JOIN print_gateway_agent a ON a.id = pr.agent_id
                         WHERE pr.printer_key = %s
                           AND pr.company_id IN (%s, %s)
                           AND a.id = %s
                        """,
                        (printer_key, target_company.id, root_co.id, binding_agent_id),
                    )
                else:
                    cr.execute(
                        """
                        SELECT pr.available_to_odoo, a.active
                          FROM print_gateway_printer pr
                          JOIN print_gateway_agent a ON a.id = pr.agent_id
                         WHERE pr.printer_key = %s
                           AND pr.company_id IN (%s, %s)
                        """,
                        (printer_key, target_company.id, root_co.id),
                    )
                printer_rows = cr.fetchall()
                if printer_rows and not any(avail and ag_active for avail, ag_active in printer_rows):
                    if not any(ag_active for _avail, ag_active in printer_rows):
                        raise ValidationError(
                            _("Print agent for printer '%s' is archived or inactive. Reactivate the agent or update the printer binding.")
                            % printer_key
                        )
                    raise ValidationError(
                        _("Printer '%s' is currently not shared with Odoo (available_to_odoo is disabled). Share the printer or choose another binding.")
                        % printer_key
                    )
            # Revalidate the selected binding on this fresh cursor: resolve and
            # persist run in separate transactions, so a binding disabled,
            # repointed, or unassigned in between must fail closed here instead
            # of printing to a stale printer. create_operation must never see
            # the binding itself (it is routing evidence, not a job column).
            selected_binding = durable_values.pop("binding", False)
            if selected_binding:
                if not selected_binding.enabled:
                    raise ValidationError(_("The print binding was disabled before the durable job could be created."))
                if selected_binding.printer_id != durable_values.get("printer_id"):
                    raise ValidationError(_("The print binding was repointed to another printer before the durable job could be created."))
                # Routing was resolved before this independent persistence
                # transaction. Re-read the actual *business destination* and
                # document type, not only the physical printer ID: an operator
                # can reassign the binding to a different POS/report while
                # the first request is rendering. Never print the original
                # source through that changed assignment.
                bound_destination = selected_binding.destination_ref
                bound_destination_key = (
                    "%s,%s" % (bound_destination._name, bound_destination.id)
                    if bound_destination else False
                )
                if bound_destination_key != durable_values.get("destination_key"):
                    raise ValidationError(_("The print binding destination changed before the durable job could be created."))
                if selected_binding.document_type != durable_values.get("document_type"):
                    raise ValidationError(_("The print binding document type changed before the durable job could be created."))
                # A report-specific route was authorized against this exact
                # ir.actions.report action. Two reports can share one document
                # type and operational destination; do not let a later binding
                # change send the earlier report to a now-unauthorized target.
                # Report-less direct diagnostics may legitimately test a
                # report-bound printer, so only constrain captured report work.
                original_report = durable_values.get("report")
                if original_report and selected_binding.report_id != original_report:
                    raise ValidationError(_("The print binding report changed before the durable job could be created."))
                if target_company:
                    router = env["print_gateway.print_router"]
                    gateway_company, branch = router._binding_scope(target_company)
                    if (
                        selected_binding.company_id != gateway_company
                        or (selected_binding.branch_id and selected_binding.branch_id != branch)
                    ):
                        raise ValidationError(_("The print binding moved outside the current Odoo scope before the durable job could be created."))
                selected_agent_uid = selected_binding.agent_id.agent_uid if selected_binding.agent_id else False
                if selected_agent_uid and target_company:
                    assigned = env["print_gateway.runtime_agent_assignment"].is_agent_assigned(
                        gateway_company, selected_binding.branch_id or False, selected_agent_uid
                    )
                    if not assigned:
                        raise ValidationError(
                            _("Print Agent '%s' is no longer assigned to the current Odoo scope.") % selected_agent_uid
                        )
                if target_company:
                    payload = durable_values.get("payload")
                    payload_type = durable_values.get("payload_type") or (
                        payload.get("type") if isinstance(payload, dict) else False
                    )
                    if payload_type == "image":
                        payload_type = "raster_jpeg"
                    protocol = durable_values.get("protocol") or (
                        payload.get("protocol") if isinstance(payload, dict) else False
                    )
                    env["print_gateway.binding"].sudo().resolve_explicit(
                        selected_binding,
                        gateway_company,
                        durable_values.get("document_type"),
                        bound_destination,
                        report=original_report,
                        branch=branch,
                        protocol=protocol,
                        payload_type=payload_type,
                    )
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
            status not in ("queued", "claimed", "printing", "success", "failed")
            # An admitted job can fail after delivering bytes without a
            # recognized marker. Use the same physical evidence as the
            # operator Retry action before allowing a fresh operation.
            or (status == "failed" and job.physical_outcome != "not_printed")
        )
        if uncertain:
            status = "unknown"
            message = _("Print status is unknown. Check the printer before trying again.")
        elif status == "failed":
            message = message or _("Kitchen / Preparation printing failed.")
        elif status == "queued":
            # The committed Odoo outbox is awaiting a direct Agent claim.
            message = message or _("Queued")
        else:
            message = message or self._submission_message(job.id, status)
        return {
            "status": status,
            "outcome": (
                "unknown" if uncertain else "failed" if status == "failed"
                else "queued" if status == "queued" else "accepted"
            ),
            "can_retry": status == "failed" and not uncertain,
            "message": message,
        }

    @api.model
    def _submit_durable_job(self, job_id, *, structured_outcome=False):
        """Expose the committed Odoo outbox row; Agents claim it directly."""
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
                # The row was already committed by the creating transaction.
                # Agent polling is the only delivery mechanism.
                cr.commit()
                job.invalidate_recordset(["status", "last_error", "next_retry_at"])
                return self._durable_submission_outcome(job) if structured_outcome else job.status
            except Exception as error:
                cr.rollback()
                if structured_outcome:
                    # Submission persists refusal/unknown/backoff on its own
                    # cursor before raising. Re-fetch after rollback so the
                    # RPC can distinguish that evidence from a lost response.
                    job = env["print_gateway.print_job"].browse(job_id).exists()
                    if job:
                        job.invalidate_recordset(["status", "last_error", "next_retry_at"])
                        if (
                            job.status in ("failed", "unknown")
                            or (job.status == "queued" and job.last_error and job.next_retry_at)
                        ):
                            return self._durable_submission_outcome(job, message=str(error))
                # Preserve the RPC error; the durable Odoo row remains queued.
                raise
        finally:
            cr.close()

    def _submit_route(
        self, *, route, payload, company, report=None, source_model=None,
        source_record_id=None, idempotency_key=None, structured_outcome=False,
    ):
        self._assert_current_company(company)
        # Only None/False/"" are Odoo's optional-operation sentinels.
        # The previous truthy-or-uuid fallback turned 0, [] or {} into
        # a NEW print identity, so retrying malformed RPC input could send
        # duplicate paper instead of failing closed.
        if not (idempotency_key is None or idempotency_key is False or idempotency_key == ""):
            if not isinstance(idempotency_key, str) or not idempotency_key.strip():
                raise ValidationError(_("The print operation key is invalid."))
        binding = route.get("binding")
        if binding and isinstance(payload, dict):
            ptype = str(payload.get("type") or "").strip().lower()
            proto = str(payload.get("protocol") or "").strip().lower()
            is_escpos = ptype == "escpos" or (ptype == "raw" and proto == "escpos") or (ptype == "image" and getattr(binding, "printer_protocol", "") == "escpos")
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
            "print_config": route["config"],
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
            "binding": route.get("binding") or False,
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
            raise ValidationError(_("Direct Odoo printing requires at least one report record."))

        selected_binding_id = route["binding"].id
        first_dest = self.destination_for(report=report, record=records[0])
        verified_destinations = {(first_dest._name, first_dest.id)}
        for record in records[1:]:
            if hasattr(record, "company_id") and record.company_id and record.company_id != self.env.company:
                raise ValidationError(_("Selected records belong to conflicting routing scopes."))
            rec_dest = self.destination_for(report=report, record=record)
            rec_dest_key = (rec_dest._name, rec_dest.id)
            if rec_dest_key in verified_destinations:
                continue
            candidate = self.resolve_binding(
                report=report,
                record=record,
                company=self.env.company,
                explicit_binding=explicit_binding or None,
                payload_type="pdf",
            )
            if candidate["binding"].id != selected_binding_id:
                raise ValidationError(_("The selected records resolve to different Print Bindings. Print them separately."))
            verified_destinations.add(rec_dest_key)

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
            raise_if_not_found=False,
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
    def _receipt_geometry_for_route(self, route):
        """Read the selected binding's current, identity-bound measurements."""
        binding = route.get("binding") if isinstance(route, dict) else None
        if not binding:
            raise ValidationError(_("A Odoo Receipt or Kitchen binding with validated printer geometry is required."))
        printer = binding._validate_runtime_target(enforce_destination_compatibility=True)
        capabilities = printer.get("capabilities") if isinstance(printer, dict) else None
        geometry = validated_receipt_geometry(
            capabilities.get("geometry") if isinstance(capabilities, dict) else None,
            binding.printer_id,
        )
        connection = str((printer or {}).get("connectionType") or "").lower()
        protocol = str((printer or {}).get("protocol") or "").lower()
        driver_managed = connection in ("spooler", "windows_spooler") or (
            connection == "usb" and protocol in ("spooler", "windows_spooler")
        )
        if geometry and driver_managed and "paper_width_mm" not in geometry:
            geometry = None
        if not geometry:
            raise ValidationError(_(
                "The selected printer has no validated receipt geometry. Sync its driver measurements or configure a validated profile with printable width and horizontal and vertical DPI; driver printing also requires the actual paper width."
            ))
        return geometry

    @api.model
    @api.private
    def _receipt_width_for_route(self, route):
        # Compatibility for callers that display dots only. Never substitute
        # a nominal roll width when the full receipt profile is unavailable.
        return self._receipt_geometry_for_route(route)["printable_width_dots"]

    @api.model
    @api.private
    def _receipt_image_payload(self, route, image_base64, geometry_fingerprint):
        geometry = self._receipt_geometry_for_route(route)
        if not isinstance(geometry_fingerprint, str) or geometry_fingerprint != geometry["config_fingerprint"]:
            raise ValidationError(_(
                "The selected printer geometry changed or the receipt has no geometry reference. Refresh the printer measurements and render a new receipt before printing; do not automatically retry an unresolved print."
            ))
        return {"type": "image", "encoding": "base64", "data": image_base64,
                "geometry_fingerprint": geometry_fingerprint}

    @api.model
    @api.private
    def _replay_receipt_operation(self, route, record, image_base64, geometry_fingerprint, idempotency_key):
        """Return an authorized, exact durable operation without new admission.

        Geometry belongs to new work. An operation already owned by the outbox
        keeps its original payload even if the printer changed meanwhile. This
        read-only path cannot create a job, reset its state, or send more bytes.
        The normal outbox/status worker remains responsible for reconciliation.
        """
        company = self._assert_current_company(record.company_id, record=record)
        if not isinstance(idempotency_key, str) or not idempotency_key.strip():
            return None
        canonical_b64 = image_base64
        if isinstance(image_base64, str):
            try:
                canonical_b64 = base64.b64encode(base64.b64decode("".join(image_base64.split()), validate=True)).decode("ascii")
            except Exception:
                canonical_b64 = image_base64
        payload = {"type": "image", "encoding": "base64", "data": canonical_b64}
        if geometry_fingerprint is not None:
            payload["geometry_fingerprint"] = geometry_fingerprint
        binding = route.get("binding")
        if binding and getattr(binding, "printer_protocol", "") == "escpos" and hasattr(binding, "get_peripheral_payload"):
            periph = binding.get_peripheral_payload()
            if periph:
                payload["peripherals"] = periph
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            # Do not sudo this lookup: ordinary outbox read ACLs and record
            # rules remain an independent boundary, including company scope.
            job = env["print_gateway.print_job"].search([
                ("company_id", "=", company.id),
                # Exact caller operation identity: a padded v2 key must not
                # replay an already-sent physical job under a different key.
                ("idempotency_key", "=", idempotency_key),
            ], limit=1)
            if not job:
                return None
            source = env[record._name].browse(record.id).exists()
            if not source:
                raise ValidationError(_("The durable print operation references a record that is no longer available."))
            source.check_access("read")
            self._assert_current_company(source.company_id, record=source)
            destination = route["destination"]
            try:
                # The caller-UID lookup and source/company checks above must
                # authorize the operation before reading its protected bytes.
                # Elevate only this internal equality comparison; the payload
                # remains administrator-only and is never returned to the caller.
                stored_payload = json.loads(job.sudo().payload)
            except (TypeError, ValueError):
                stored_payload = None
            exact = (
                job.print_config_id.id == route["config"].id
                and job.printer_id == route["binding"].printer_id
                and job.destination == str(destination.display_name).strip()
                and job.destination_key == "%s,%s" % (destination._name, destination.id)
                and job.document_type == str(route["document_type"]).strip().lower()
                and job.source_model == record._name
                and job.source_record_id == record.id
                and stored_payload == payload
            )
            if not exact:
                raise ValidationError(_("The idempotency key is already used for a different print operation."))
            return {"gateway_enabled": True, "native": False, "job_id": job.id,
                    **self._durable_submission_outcome(job)}
        finally:
            cr.close()

    @api.model
    @api.private
    def route_pos_receipt(self, order, image_base64, *, idempotency_key=None, geometry_fingerprint=None):
        order.ensure_one()
        # Preserve the exact caller-owned print identity at the first route
        # boundary. Unlike a missing Odoo field, 0, [], {} or whitespace
        # cannot silently become a different deterministic operation.
        if not (idempotency_key is None or idempotency_key is False or idempotency_key == ""):
            if not isinstance(idempotency_key, str) or not idempotency_key.strip():
                raise ValidationError(_("The print operation key is invalid."))
        self._assert_current_company(order.company_id, record=order)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(record=order, company=self.env.company, document_type="receipt")
        if route.get("native"):
            raise ValidationError(
                _("Direct Odoo printing is enabled for this POS, but no Odoo Receipt binding is configured for the current branch/POS.")
            )
        # Stable idempotency key: a double-tap on the same order cannot produce
        # a second physical print within the Odoo idempotency window.
        # The caller may supply an explicit key (e.g. from the JS in-flight
        # guard); fall back to a deterministic order+binding token so an RPC
        # retry is also safe.
        if not idempotency_key:
            binding_id = route.get("binding") and route["binding"].id or 0
            # write_date mutates after normal POS synchronization and payment
            # metadata updates. It is NOT a second-print authorization.
            # Only a new explicit operation key may request a reprint.
            raw_token = f"receipt:{order.id}:{binding_id}"
            idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        replayed = self._replay_receipt_operation(route, order, image_base64, geometry_fingerprint, idempotency_key)
        if replayed is not None:
            return replayed
        return self._submit_route(
            route=route, payload=self._receipt_image_payload(route, image_base64, geometry_fingerprint),
            company=self.env.company, source_model=order._name, source_record_id=order.id,
            idempotency_key=idempotency_key,
            # Preserve unknown physical-outcome markers from the durable Odoo
            # outbox. A plain failed status can hide possible paper output.
            structured_outcome=True,
        )

    @api.model
    @api.private
    def route_kitchen_print(self, order, image_base64, *, reprint=False, idempotency_key=None, pos_printer=None, geometry_fingerprint=None):
        order.ensure_one()
        if type(reprint) is not bool:
            raise ValidationError(_("The kitchen reprint option must be a boolean."))
        # Preserve the exact caller-owned print identity at the first route
        # boundary. Unlike a missing Odoo field, 0, [], {} or whitespace
        # cannot silently become a different deterministic operation.
        if not (idempotency_key is None or idempotency_key is False or idempotency_key == ""):
            if not isinstance(idempotency_key, str) or not idempotency_key.strip():
                raise ValidationError(_("The print operation key is invalid."))
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
                _("Direct Odoo printing is enabled for this POS, but no Odoo Kitchen binding is configured for the selected preparation printer.")
            )
        # Kitchen identity policy. An explicit key always wins: the POS client
        # mints a fresh operation id for a deliberate reprint so Gateway
        # idempotency cannot collapse it into the original ticket.
        #
        # Without a caller key, a normal kitchen print must still be
        # deterministic. Otherwise any caller that loses the operation id (an
        # addon calling action_print_gateway_kitchen directly, an RPC retry,
        # a non-browser automation) falls back to a random key and a retry
        # produces a SECOND physical kitchen ticket. Receipt and Sale Details
        # already have deterministic fallbacks; kitchen did not.
        #
        # A key-less deliberate reprint keeps a random key on purpose: the
        # caller asked for new paper output, so it must not be deduplicated.
        if not idempotency_key and not reprint:
            binding_id = route.get("binding") and route["binding"].id or 0
            # Odoo can update an order's write_date for sync/payment metadata
            # without creating a new kitchen ticket. Derive the fallback
            # operation from the exact validated image bytes instead: a lost
            # RPC response with identical content cannot mint more paper, while
            # a new preparation delta with different rendered content remains
            # a distinct operation. Deliberate identical reprints require the
            # explicit reprint path/key rather than incidental Odoo writes.
            image_digest = hashlib.sha256(image_base64.encode("ascii")).hexdigest()
            raw_token = "kitchen:%s:%s:%s:%s" % (
                order.id,
                binding_id,
                explicit_destination.id if explicit_destination else 0,
                image_digest,
            )
            idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        replayed = self._replay_receipt_operation(route, order, image_base64, geometry_fingerprint, idempotency_key)
        if replayed is not None:
            return replayed
        return self._submit_route(
            route=route, payload=self._receipt_image_payload(route, image_base64, geometry_fingerprint),
            company=company, source_model=order._name, source_record_id=order.id, idempotency_key=idempotency_key,
            structured_outcome=True,
        )

    @api.model
    @api.private
    def route_pos_sale_details(self, session, image_base64, *, idempotency_key=None, geometry_fingerprint=None):
        # Odoo 19 renders Sale Details inside the POS and submits the rendered
        # element through the same receipt-printer path used for POS receipts.
        # Therefore the in-session Gateway path is a receipt job addressed to
        # the current POS config, not a report-action destination.  The direct
        # /pos/sale_details_report HTTP endpoint remains a separate PDF/report
        # path and intentionally resolves an ir.actions.report binding.
        session.ensure_one()
        # Preserve the exact caller-owned print identity at the first route
        # boundary. Unlike a missing Odoo field, 0, [], {} or whitespace
        # cannot silently become a different deterministic operation.
        if not (idempotency_key is None or idempotency_key is False or idempotency_key == ""):
            if not isinstance(idempotency_key, str) or not idempotency_key.strip():
                raise ValidationError(_("The print operation key is invalid."))
        self._assert_current_company(session.company_id, record=session)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(
            company=self.env.company,
            document_type="receipt",
            explicit_destination=session.config_id,
        )
        if route.get("native"):
            raise ValidationError(
                _("Direct Odoo printing is enabled for this POS, but no Odoo Receipt binding is configured for Sale Details.")
            )
        # Deterministic key so an RPC retry cannot produce a second physical print.
        if not idempotency_key:
            binding_id = route.get("binding") and route["binding"].id or 0
            # A POS session's write_date changes throughout its lifetime.
            # Never mint a fresh paper-output attempt from that mutation.
            # Multiple deliberate sale-detail prints supply explicit keys.
            raw_token = f"sale_details:{session.id}:{binding_id}"
            idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        replayed = self._replay_receipt_operation(route, session, image_base64, geometry_fingerprint, idempotency_key)
        if replayed is not None:
            return replayed
        return self._submit_route(
            route=route, payload=self._receipt_image_payload(route, image_base64, geometry_fingerprint),
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
        config = self._print_config(company)
        if not config:
            return {"status": "skipped", "message": _("Direct Odoo printing is not enabled for company %s") % company.display_name}

        # Legacy report/rule conflicts must be explained before rendering or outbox creation.
        if policy.action_type == "report":
            policy._check_action_configuration()
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
        config = self._print_config(current_company)
        if not config:
            return {"gateway_enabled": False, "native": True}

        # A caller-selected binding remains the routing authority; when absent,
        # resolve_binding() finds the matching route for the record/destination.
        route = self.resolve_binding(
            record=record,
            company=current_company,
            document_type=document_type,
            explicit_destination=destination,
            explicit_binding=binding or None,
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

        # Admission precedes base64 and diagnostics serialization. Do not
        # build multi-megabyte copies of commands that the Agent rejects.
        raw_bytes = _validated_raw_command_bytes(raw_data)

        # Wire type follows the shared contract
        # (contracts/print-payload-contract.json wireTypes: raw/escpos/pdf/image):
        # only ESC/POS has a dedicated wire type; ZPL/TSPL travel as
        # type=raw with an explicit protocol (the Agent payload validator
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
            "print_config": config,
            "printer_id": target_binding.printer_id,
            "destination": target_destination.display_name if hasattr(target_destination, "display_name") else str(target_destination),
            "destination_key": "%s,%s" % (target_destination._name, target_destination.id) if hasattr(target_destination, "_name") and getattr(target_destination, "id", False) else False,
            "document_type": document_type,
            "payload": payload,
            "payload_type": "raw_cmd",
            "protocol": protocol,
            "raw_payload": (raw_data.replace("\x00", "\\x00") if isinstance(raw_data, str) else raw_bytes.decode("latin1", errors="replace").replace("\x00", "\\x00")),
            "binding": target_binding or False,
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
        config = self._print_config(current_company)
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
            ticket_raw = "^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n"
        elif proto == "tspl":
            # Firmware diagnostics use its configured stock without guessing size or gap.
            ticket_raw = "SELFTEST\r\n"
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
    def _diagnostic_paper_width_for_binding(self, binding, *, driver_managed=False):
        runtime_printer = binding._validate_runtime_target()
        runtime_capabilities = runtime_printer.get("capabilities")
        declared_width = runtime_capabilities.get("paper_width_mm") if isinstance(runtime_capabilities, dict) else None
        paper_width_mm = normalize_receipt_paper_width_mm(declared_width)
        device_class = str(
            runtime_printer.get("deviceClass")
            or (runtime_capabilities.get("deviceClass") if isinstance(runtime_capabilities, dict) else None)
            or (runtime_capabilities.get("device_class") if isinstance(runtime_capabilities, dict) else None)
            or ""
        ).strip().lower()
        if (
            paper_width_mm is None
            and not driver_managed
            and getattr(binding, "destination_type", False) in ("pos", "pos_printer")
            and device_class == "thermal"
        ):
            raise ValidationError(_(
                "Set the selected thermal receipt printer's actual roll width (40–120 mm) in the Agent or Gateway and sync it before sending a test page."
            ))
        return paper_width_mm

    @api.model
    @api.private
    def _route_spooler_test_page(self, *, binding, company, company_name, branch_name, printer_name, now_str):
        """PDF test page through the Windows Spooler driver path.

        Exercises the Agent's driver-rendered document path (StartDocW/GDI),
        not RAW WritePrinter. Physical output remains unknown until observed;
        spool acceptance only proves that Windows accepted the document job.
        """
        route = self.resolve_binding(
            record=False, company=company, document_type=binding.document_type,
            explicit_binding=binding, payload_type="pdf",
        )
        if route.get("native"):
            raise ValidationError(
                _("Direct Odoo printing is enabled, but the binding resolved to native print. Check the binding configuration.")
            )
        # The Windows renderer fits to validated driver media before StartDoc.
        paper_width_mm = self._diagnostic_paper_width_for_binding(binding, driver_managed=True)
        pdf_content = self._generate_test_pdf(
            company_name=company_name, branch_name=branch_name,
            printer_name=printer_name, now_str=now_str,
            paper_width_mm=paper_width_mm,
        )
        payload = {"type": "pdf", "encoding": "base64", "data": base64.b64encode(pdf_content).decode("ascii")}
        return self._submit_route(
            route=route, payload=payload, company=company,
            source_model="print_gateway.binding", source_record_id=binding.id,
        )

    @api.model
    @api.private
    def _route_ipp_test_page(self, *, binding, company, company_name, branch_name, printer_name, now_str):
        """PDF test page through the IPP document transport."""
        route = self.resolve_binding(
            record=False, company=company, document_type=binding.document_type,
            explicit_binding=binding, payload_type="pdf",
        )
        if route.get("native"):
            raise ValidationError(
                _("Direct Odoo printing is enabled, but the binding resolved to native print. Check the binding configuration.")
            )
        paper_width_mm = self._diagnostic_paper_width_for_binding(binding)
        pdf_content = self._generate_test_pdf(
            company_name=company_name, branch_name=branch_name,
            printer_name=printer_name, now_str=now_str,
            paper_width_mm=paper_width_mm,
        )
        payload = {"type": "pdf", "encoding": "base64", "data": base64.b64encode(pdf_content).decode("ascii")}
        return self._submit_route(
            route=route, payload=payload, company=company,
            source_model="print_gateway.binding", source_record_id=binding.id,
        )

    @api.model
    @api.private
    def _generate_test_pdf(self, *, company_name, branch_name, printer_name, now_str, paper_width_mm=None):
        """Minimal valid single-page PDF test document.

        Offsets and stream Length are computed from actual content; text is
        PDF-escaped so operator names cannot break document syntax.
        """
        if paper_width_mm is not None:
            normalized_width = normalize_receipt_paper_width_mm(paper_width_mm)
            if normalized_width is None:
                raise ValidationError(_("Diagnostic paper width must be a finite receipt-roll width between 40 and 120 mm."))
            paper_width_mm = normalized_width
        language = self.env.lang or "en_US"
        if not language.startswith("en_") or any(
            not str(value or "").isascii() for value in (company_name, branch_name, printer_name)
        ):
            # Translated labels and Unicode names need QWeb's locale and font
            # shaping even when an Arabic user's printer names are Latin text.
            pdf, report_type = self.env["ir.actions.report"].with_context(
                force_report_rendering=True,
                print_gateway_diagnostic_paper_width_mm=paper_width_mm,
            )._render_qweb_pdf(
                "print_gateway.action_diagnostic_report", res_ids=[],
                data={"company_name": str(company_name or "")[:40] if paper_width_mm else company_name,
                      "branch_name": str(branch_name or "")[:40] if paper_width_mm else branch_name,
                      "printer_name": str(printer_name or "")[:40] if paper_width_mm else printer_name,
                      "now_str": now_str, "paper_width_mm": paper_width_mm},
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
        ]
        office_lines = [
            part for text in (
                "Company: %s" % str(company_name or "")[:80],
                "Location: %s" % str(branch_name or "")[:80],
                "Printer: %s" % str(printer_name or "")[:80],
                "Status: READY", "Time: %s" % str(now_str or "")[:80],
            ) for part in textwrap.wrap(text, width=39)
        ]
        for index, text in enumerate(office_lines):
            if index:
                lines.append("0 -20 Td")
            lines.append("(%s) Tj" % _pdf_text(text))
        lines.append("ET")
        page_width, page_height = 612, 792
        if paper_width_mm:
            page_width, page_height = paper_width_mm * 72 / 25.4, 100 * 72 / 25.4
            lines = ["BT", "/F1 8 Tf", "12 %.3f Td" % (page_height - 14)]
            diagnostic_lines = [
                "YASEIR PRINT GATEWAY", "PRINTER TEST PAGE",
                "Company: %s" % str(company_name or "")[:40],
                "Location: %s" % str(branch_name or "")[:40],
                "Printer: %s" % str(printer_name or "")[:40],
                "Time: %s" % str(now_str or "")[:40],
                "Check the physical printer.",
            ]
            # One-em character budget keeps even wide Helvetica glyphs within the roll.
            character_width = int((page_width - 24) / 8)
            for text in diagnostic_lines:
                for part in textwrap.wrap(text, width=character_width):
                    if len(lines) > 3:
                        lines.append("0 -12 Td")
                    lines.append("(%s) Tj" % _pdf_text(part))
            lines.append("ET")
        content = "\n".join(lines).encode("latin-1", errors="replace")
        objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>" % (page_width, page_height)).encode("ascii"),
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
