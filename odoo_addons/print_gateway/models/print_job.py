# -*- coding: utf-8 -*-
"""Durable Odoo-side print outbox and retry state."""

import base64
import datetime
import json
import logging
import uuid

from psycopg2 import IntegrityError, sql as psycopg2_sql

from odoo import api, fields, models, _

from odoo.exceptions import AccessError, UserError, ValidationError

from .print_config import verify_stored_license_bundle
from ..runtime_clock import db_now_utc
from ..runtime_policy import is_exact_printer_key


_logger = logging.getLogger(__name__)
MAX_PRINT_CONTENT_BYTES = 5 * 1024 * 1024
MAX_PRINT_BASE64_CHARS = 4 * ((MAX_PRINT_CONTENT_BYTES + 2) // 3)
# Operator-recoverable Agent refusals (billing limits, suspended tenant,
# rotation grace, revoked key) requeue instead of terminalizing. Attempts are
# capped so a permanently blocked configuration parks with a 24h backoff
# instead of inflating `attempts` and cron load forever; parked jobs stay
# recoverable and resume automatically once the operator fixes billing/auth.


class PrintAgentJob(models.Model):
    _name = "print_gateway.print_job"
    _description = "Print Agent Job"
    _rec_name = "destination"
    _order = "create_date desc"

    company_id = fields.Many2one("res.company", required=True, ondelete="restrict", index=True)
    print_config_id = fields.Many2one("print_gateway.gateway_config", required=True, ondelete="restrict", index=True)
    claim_token = fields.Char(string="Claim Token", index=True, copy=False, readonly=True)
    claimed_at = fields.Datetime(string="Claimed At", index=True, copy=False, readonly=True)

    printer_id = fields.Char(string="Printer", required=True, index=True, readonly=True)
    destination = fields.Char(required=True, readonly=True)
    # Immutable routing identity: unlike a display name, this survives renames
    # and prevents ambiguity at failover. Old jobs without it cannot fail over.
    destination_key = fields.Char(index=True, readonly=True, copy=False)
    document_type = fields.Char(required=True, readonly=True)
    # Direct Odoo lifecycle: queued -> claimed -> printing -> terminal.
    # `unknown` is terminal and requires an explicit operator reprint.
    status = fields.Selection([
        ("queued", "Queued"), ("claimed", "Claimed"),
        ("printing", "Printing"), ("success", "Sent to printer"), ("failed", "Failed"),
        ("unknown", "Unknown Outcome"),
        # v4: Agent 'canceled' (migration 0109). Terminal. Never
        # auto-retried (action_retry requires failed + not_printed);
        # explicit force-reprint remains the operator's deliberate path.
        ("canceled", "Canceled"),
    ], default="queued", required=True, index=True)
    physical_outcome = fields.Selection([
        ("not_printed", "Not printed"),
        ("printed", "Physically verified printed"),
        ("unknown", "Physical output not verified"),
    ], compute="_compute_physical_outcome")
    output_medium = fields.Selection([("physical", "Physical printer"), ("virtual", "Virtual printer")], readonly=True, copy=False)
    # Full document bytes (rendered PDF/JPEG, native command streams).
    # Restricted to system administrators: the job list/form never displays
    # payload content, and every server-side reader (submit/sync/retry runs
    # elevated or as cron). Same-company internal users keep status/history
    # visibility without access to other documents' byte content.
    payload = fields.Text(required=True, copy=False, readonly=True, groups="base.group_system")
    payload_type = fields.Selection([
        ("pdf", "PDF Vector"),
        ("raster_jpeg", "JPEG Raster Banding"),
        ("raw_cmd", "Native Printer Command"),
        # NOTE — naming deliberately differs from the shared wire contract
        # (contracts/print-payload-contract.json: raw/escpos/pdf/image).
        # These are Odoo STORED column values (renaming them needs a data
        # migration on deployed DBs); the wire translation lives in
        # _PAYLOAD_TYPE_MAP below, which is pinned to the contract.
    ], default="pdf", required=True, readonly=True)
    protocol = fields.Selection([
        ("raw", "Raw Text/Binary"),
        ("escpos", "ESC/POS"),
        ("zpl", "Zebra ZPL-II"),
        ("tspl", "TSC TSPL"),
    ], required=False, readonly=True)
    raw_payload = fields.Text(string="Native Command Payload", readonly=True, groups="base.group_system")
    printer_profile = fields.Text(string="Printer Hardware Profile", readonly=True)
    idempotency_key = fields.Char(required=True, index=True, copy=False, readonly=True)
    attempts = fields.Integer(default=0, readonly=True)
    reprint_attempt_count = fields.Integer(string="Reprint Attempts", default=0, readonly=True)
    next_retry_at = fields.Datetime(index=True, readonly=True)
    # Round-robin status polling fence. NULL first guarantees fresh/legacy
    # eligible rows a turn before already-inspected unresolved rows.
    last_error = fields.Text(readonly=True)
    customer_issue = fields.Text(string="What to do next", compute="_compute_customer_presentation", compute_sudo=False)
    customer_status = fields.Selection([
        ("waiting", "Waiting"), ("processing", "Processing"),
        ("sent_to_printer", "Sent for printing"), ("needs_review", "Needs review"),
        ("failed_before_output", "Failed before output"),
    ], string="Print status", compute="_compute_customer_presentation", compute_sudo=False)
    source_model = fields.Char(readonly=True)
    source_record_id = fields.Integer(readonly=True)
    report_id = fields.Many2one("ir.actions.report", readonly=True, ondelete="set null")
    create_date = fields.Datetime(readonly=True)
    write_date = fields.Datetime(readonly=True)
    completed_at = fields.Datetime(readonly=True)

    @api.depends("status", "physical_outcome", "last_error")
    @api.depends_context("lang")
    def _compute_customer_presentation(self):
        from ..customer_presentation import customer_error_message, job_customer_state
        for job in self:
            job.customer_status = job_customer_state(
                job.status, job.physical_outcome,
            )
            job.customer_issue = customer_error_message(
                job.env._,
                "UNKNOWN_PRINT_OUTCOME" if job.customer_status == "needs_review" else job.last_error,
            )

    _idempotency_unique = models.Constraint(
        "UNIQUE(company_id, idempotency_key)",
        "The same logical print operation may only be created once.",
    )

    def init(self):
        super().init()
        # Partial index keeps hot Agent poll/claim and stale-lease queries off 48h terminal history.
        self.env.cr.execute(
            """
            CREATE INDEX IF NOT EXISTS print_gateway_print_job_active_queue_idx
            ON print_gateway_print_job (company_id, printer_id, id)
            WHERE status IN ('queued', 'claimed', 'printing')
            """
        )
        self.env.cr.execute(
            """
            CREATE INDEX IF NOT EXISTS print_gateway_print_job_inflight_lease_idx
            ON print_gateway_print_job (status, write_date, id)
            WHERE status IN ('claimed', 'printing')
            """
        )
        # Terminal states: no further transitions are accepted once a job reaches one
    # of these. "unknown" is terminal because it represents a reconcilable but
    # ambiguous physical outcome that must be resolved by an operator, not by
    # automated transitions.
    _TERMINAL = frozenset(("success", "failed", "unknown", "canceled"))
    _TERMINAL_RETENTION_HOURS = 48
    
    # Valid status transitions for the print job state machine.
    # Forward progress follows the direct Agent lifecycle. Failure and
    # unknown are terminal exits; terminal jobs never transition back.
    _VALID_TRANSITIONS = {
        "queued": {"claimed", "failed", "unknown", "canceled"},
        "claimed": {"printing", "failed", "unknown", "canceled"},
        "printing": {"success", "failed", "unknown"},
        "success": {"success"},
        "failed": {"failed"},
        "unknown": {"unknown"},
        "canceled": {"canceled"},
    }
    
    # Forward-progress chain for _advance_status. Failure/unknown are NOT
    # chain hops: they are written directly (they are valid exits from any
    # non-terminal state per the matrix above).
    _FORWARD_CHAIN = ("queued", "claimed", "printing", "success")

    def _lock_status_row(self, job):
        """Refresh the authoritative status under a row lock before mutation.

        Remote status reconciliation happens after an HTTP round trip. The ORM
        record can therefore contain an older status than a concurrent submit,
        agent report, or recovery transaction. Lock and re-read the row before
        consulting the transition matrix so a stale remote response cannot
        downgrade or resurrect a newer state.
        """
        self.env.cr.execute(
            psycopg2_sql.SQL("SELECT status FROM {} WHERE id = %s FOR UPDATE").format(
                psycopg2_sql.Identifier(self._table)
            ),
            [job.id],
        )
        if not self.env.cr.fetchone():
            raise ValidationError(_("Print job no longer exists."))
        job.invalidate_recordset(["status", "last_error", "completed_at", "output_medium"])


    def _stable_terminal_values(self, job, target, values):
        """Preserve the FIRST terminal timestamp as the 48-hour retention clock.

        Reconciliation may refresh errors or convert an ambiguous terminal
        outcome to late success, but those writes must never restart retention.
        Legacy terminal rows without completed_at inherit their existing
        write_date once, then keep that timestamp permanently.
        """
        stable = dict(values)
        if target not in self._TERMINAL:
            return stable
        if job.completed_at:
            stable.pop("completed_at", None)
        elif job.status in self._TERMINAL and job.write_date:
            stable["completed_at"] = job.write_date
        else:
            stable.setdefault("completed_at", db_now_utc(job.env.cr))
        return stable

    def _advance_status(self, job, target, values):
        """Write a status advance honoring the canonical chain.

        `values` carries the final row content (attempts, last_error,
        completed_at...); its "status" key is ignored in favor
        of `target`. Forward hops (e.g. queued -> claimed on an idempotent
        replay) are written stage-by-stage so the transition matrix never
        needs a shortcut; failure/unknown targets are written directly.
        Raises ValidationError for any regression or unknown target.
        """
        job.ensure_one()
        self._lock_status_row(job)
        values = self._stable_terminal_values(job, target, values)
        if target not in self._FORWARD_CHAIN and target not in ("failed", "unknown", "canceled"):
            raise ValidationError(
                _("Invalid print job state transition from '%s' to '%s'.")
                % (job.status, target)
            )
        # Terminal states are immutable. An operator uses the explicit
        # reprint action to create a new logical operation.
        if job.status in self._TERMINAL and target != job.status:
            raise ValidationError(
                _("Invalid terminal print job transition from '%s' to '%s'.")
                % (job.status, target)
            )
        if target == job.status:
            # Refresh-only write (e.g. a sync updating last_error while the
            # state is unchanged): write() skips the matrix on no-op
            # transitions, so this is always legal.
            refresh_values = dict(values)
            refresh_values["status"] = target
            job.write(refresh_values)
            return
        if target in ("failed", "unknown", "canceled"):
            terminal_values = dict(values)
            terminal_values["status"] = target
            job.write(terminal_values)
            return
        try:
            position = self._FORWARD_CHAIN.index(job.status)
            destination = self._FORWARD_CHAIN.index(target)
        except ValueError:
            raise ValidationError(
                _("Invalid print job state transition from '%s' to '%s'.")
                % (job.status, target)
            )
        if destination < position:
            raise ValidationError(
                _("Invalid print job state transition from '%s' to '%s'.")
                % (job.status, target)
            )
        for hop in self._FORWARD_CHAIN[position + 1:destination + 1]:
            hop_values = {"status": hop}
            if hop == target:
                hop_values.update({key: value for key, value in values.items() if key != "status"})
            job.write(hop_values)

    # Payload kinds recognized in the canonical contract. A payload whose
    # type is not one of these is malformed input and must fail - it is
    # never "repaired" into a PDF job.
    # Canonical wire types, EXACTLY mirroring the Agent
    # (src/lib/payload.ts) and the Go agent
    # (agent/internal/payload/payload.go): raw, escpos, image, pdf.
    # "jpeg"/"raster_jpeg" are INTERNAL column names, never payload types -
    # the drift that accepted them here but failed at the Agent 422 is
    # removed on purpose: a persisted job must always be submittable.
    _PAYLOAD_TYPE_MAP = {
        "raw": "raw_cmd",
        "escpos": "raw_cmd",
        "image": "raster_jpeg",
        "pdf": "pdf",
    }

    @api.model
    def _resolve_payload_kind(self, payload_json):
        """Parse a persisted payload string and resolve its declared kind.

        Strict by contract: unparseable JSON, a non-object, or an unknown
        ``type`` all raise. There is no silent default.
        """
        try:
            parsed = json.loads(payload_json) if isinstance(payload_json, str) else payload_json
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Print payload is not valid JSON: %s") % exc) from exc
        if not isinstance(parsed, dict):
            raise ValidationError(_("Print payload must be a JSON object."))
        ptype = str(parsed.get("type") or "").strip().lower()
        if ptype not in self._PAYLOAD_TYPE_MAP:
            raise ValidationError(
                _("Unsupported payload type '%s'. Expected one of: %s.")
                % (ptype or "(missing)", ", ".join(sorted(self._PAYLOAD_TYPE_MAP)))
            )
        return parsed, self._PAYLOAD_TYPE_MAP[ptype]

    def _assert_valid_license(self):
        lic_ok, lic_reason, _lic_bundle = verify_stored_license_bundle(
            self.env["ir.config_parameter"].sudo()
        )
        if not lic_ok:
            raise UserError(
                _("Printing is blocked because the print license is missing, invalid, expired, or revoked (%s).")
                % lic_reason
            )

    @api.model_create_multi
    def create(self, vals_list):
        # Only the private router service may mint executable outbox work.
        # Administrator model ACLs are also granted to branch-limited users;
        # an RPC create must not bypass create_operation's routing checks and
        # borrow an unrelated configuration's credential during sudo dispatch.
        if not self.env.is_superuser():
            raise AccessError(_("Print jobs must be created through the authorized print router."))
        self._assert_valid_license()
        for vals in vals_list:
            payload_json = vals.get("payload")
            if "payload_type" not in vals:
                if not payload_json:
                    raise ValidationError(_("A print job requires a payload."))
                parsed, resolved_type = self._resolve_payload_kind(payload_json)
                vals["payload_type"] = resolved_type
                if resolved_type == "raw_cmd":
                    # Protocol must be stated explicitly - by the payload,
                    # by the caller's vals, or not at all (which fails the
                    # constraint below). It is never inferred from the type.
                    if "protocol" not in vals or not vals.get("protocol"):
                        proto = parsed.get("protocol")
                        if not proto:
                            raise ValidationError(_(
                                "Native command payloads require an explicit protocol "
                                "(raw, escpos, zpl, or tspl); none was declared."
                            ))
                        vals["protocol"] = proto
                    payload_proto = parsed.get("protocol")
                    if payload_proto and payload_proto != vals["protocol"]:
                        raise ValidationError(_(
                            "Payload protocol '%s' contradicts job protocol '%s'."
                        ) % (payload_proto, vals["protocol"]))
                else:
                    vals["protocol"] = False
            elif vals.get("payload_type") in ("pdf", "raster_jpeg"):
                if payload_json:
                    _parsed, resolved_type = self._resolve_payload_kind(payload_json)
                    if resolved_type != vals["payload_type"]:
                        raise ValidationError(_(
                            "Payload content (type '%s') contradicts the declared "
                            "payload_type '%s'."
                        ) % (resolved_type, vals["payload_type"]))
                # Absent/False protocol is legal; an actual protocol on a
                # pdf/raster job is a contradiction and must fail, not be
                # silently stripped.
                if vals.get("protocol"):
                    raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
                vals["protocol"] = False
            elif vals.get("payload_type") == "raw_cmd":
                if payload_json:
                    parsed, resolved_type = self._resolve_payload_kind(payload_json)
                    if resolved_type != "raw_cmd":
                        raise ValidationError(_(
                            "Payload content (type '%s') contradicts the declared "
                            "payload_type 'raw_cmd'."
                        ) % resolved_type)
                    if not vals.get("protocol"):
                        raise ValidationError(_("Native command payloads require a valid printer protocol."))
                    payload_proto = parsed.get("protocol")
                    if payload_proto and payload_proto != vals["protocol"]:
                        raise ValidationError(_(
                            "Payload protocol '%s' contradicts job protocol '%s'."
                        ) % (payload_proto, vals["protocol"]))
        jobs = super().create(vals_list)
        queued_roots = set()
        for record in jobs:
            status = record.get("status") if isinstance(record, dict) else getattr(record, "status", None)
            if status != "queued":
                continue
            company = record.get("company_id") if isinstance(record, dict) else getattr(record, "company_id", None)
            if not company:
                continue
            root = getattr(company, "parent_id", None) or company
            root_id = getattr(root, "id", root if isinstance(root, int) and not isinstance(root, bool) else None)
            if root_id:
                queued_roots.add(root_id)
        if queued_roots and hasattr(self, "_notify_job_ready"):
            self._notify_job_ready(queued_roots)
        return jobs

    def _notify_job_ready(self, root_company_ids):
        """Best-effort pg_notify wakeup for WebSocket-connected Go Agents."""
        for cid in sorted({int(c) for c in root_company_ids if c}):
            try:
                with self.env.cr.savepoint():
                    self.env.cr.execute(
                        "SELECT pg_notify('print_gateway_job_ready', %s)",
                        (str(cid),),
                    )
            except Exception as exc:
                _logger.debug("pg_notify print_gateway_job_ready skipped: %s", exc)

    def write(self, vals):
        routing_fields = {
            "company_id", "print_config_id", "printer_id", "destination",
            "destination_key", "document_type", "payload", "payload_type",
            "protocol", "raw_payload", "printer_profile",
            "idempotency_key",
            "source_model", "source_record_id", "report_id",
            "output_medium",
        }
        if routing_fields.intersection(vals) and not self.env.is_superuser():
            raise AccessError(_("Print job routing and content may only be changed by the trusted print service."))
        for job in self:
            if "output_medium" in vals and job.output_medium and vals["output_medium"] != job.output_medium:
                raise ValidationError(_("A print operation's output medium cannot change."))
        # Even sudo cannot silently remap an already accepted business intent
        # into a fresh namespace; clone/restore requires operator reconciliation.
        if "status" in vals:
            target_status = vals["status"]
            for job in self:
                if job.status and target_status != job.status:
                    allowed = self._VALID_TRANSITIONS.get(job.status, set())
                    if target_status not in allowed:
                        raise ValidationError(
                            _("Invalid print job state transition from '%s' to '%s'.")
                            % (job.status, target_status)
                        )
        if "payload_type" in vals and vals["payload_type"] in ("pdf", "raster_jpeg") and vals.get("protocol"):
            raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
        if "payload" in vals and not vals.get("payload_type"):
            # A re-written payload must still resolve to a valid kind and,
            # for this row's payload_type, stay consistent with it.
            parsed, resolved_type = self._resolve_payload_kind(vals["payload"])
            for job in self:
                if job.payload_type and resolved_type != job.payload_type:
                    raise ValidationError(_(
                        "New payload content (type '%s') contradicts this job's "
                        "payload_type '%s'."
                    ) % (resolved_type, job.payload_type))
                if job.payload_type == "raw_cmd":
                    payload_proto = parsed.get("protocol")
                    if not payload_proto:
                        raise ValidationError(_("Native command payloads require an explicit protocol in the payload."))
                    if job.protocol and payload_proto != job.protocol:
                        raise ValidationError(_(
                            "Payload protocol '%s' contradicts job protocol '%s'."
                        ) % (payload_proto, job.protocol))
        # protocol is not applicable for pdf/raster_jpeg payloads; the write
        # method's constrains check already enforces this, so no additional
        # mutation is needed here.
        return super().write(vals)

    @api.constrains("payload_type", "protocol")
    def _check_payload_type_and_protocol(self):
        for job in self:
            if job.payload_type in ("pdf", "raster_jpeg"):
                if job.protocol:
                    raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
            elif job.payload_type == "raw_cmd":
                if not job.protocol:
                    raise ValidationError(_("Native command payloads require a valid printer protocol."))

    # Marker prefixes the Agent uses to say "execution reached an
    # ambiguous physical boundary". These MUST stay in lockstep with
    # PHYSICAL_OUTCOME_UNKNOWN_MARKERS in src/lib/job-status.ts; the
    # contract test test_gateway_marker_parity asserts both lists match.
    _UNKNOWN_OUTCOME_MARKERS = (
        "AGENT_EXECUTION_TIMEOUT",
        "AGENT_RESTART_DURING_PRINT",
        "UNKNOWN_PARTIAL_DELIVERY",
        "UNKNOWN_PRINT_OUTCOME",
    )

    @api.depends("status", "last_error")
    def _compute_physical_outcome(self):
        for job in self:
            error = str(job.last_error or "")
            if any(error.startswith(marker) for marker in self._UNKNOWN_OUTCOME_MARKERS):
                job.physical_outcome = "unknown"
            elif job.status in ("queued", "failed", "canceled"):
                # Agent reports `unknown` once any physical output may have
                # started. A definite failure is therefore safe to retry.
                job.physical_outcome = "not_printed"
            else:
                # Agent success means the transport accepted the job, not
                # that paper was physically observed leaving the printer.
                job.physical_outcome = "unknown"

    @api.private
    @api.model
    def create_operation(self, *, company, print_config, printer_id, destination, document_type,
                         payload, source_model=None, source_record_id=None, report=None,
                         idempotency_key=None, payload_type=None, protocol=None,
                         raw_payload=None, printer_profile=None,                          destination_key=None):
        # TRUSTED SERVICE BOUNDARY (not reachable via RPC):
        # print_gateway.print_job is intentionally read-only for normal users
        # (ACL: group_user has read only), yet the print flows run as those
        # users. Creation therefore runs with sudo INSIDE this method only,
        # AFTER the server-side scope/company/protocol validation above and
        # below. The ONLY legal producers are server-side router code paths
        # (report/POS/kitchen/intent/raw/test-page) and retry actions - all of
        # which validated the caller's authorization before delegating here.
        # Granting blanket create rights on the model instead would let any
        # user forge arbitrary outbox rows (printer/protocol/data of choice).
        self_su = self.sudo()
        if not company or not print_config:
            raise ValidationError(_("Print service configuration is missing."))
        if company != self.env.company and not (
            (company in self.env.companies or self.env.is_superuser())
            and (company.parent_id == self.env.company or self.env.company in company.parent_ids)
        ):
            raise ValidationError(_("Print operations must be created in the active Odoo company."))
        expected_config_owner = company.parent_id or company
        if print_config.company_id != expected_config_owner:
            raise ValidationError(_("Print service configuration does not belong to the company hierarchy of the active Odoo company."))
        if not is_exact_printer_key(printer_id):
            raise ValidationError(_("Printer identity is invalid. Select an exact Odoo Agent printer."))
        if not destination or not str(destination).strip():
            raise ValidationError(_("Destination is required."))
        if not document_type or not str(document_type).strip():
            raise ValidationError(_("Document type is required."))
        # Phase 13 canonical peripheral representation: INACTIVE peripherals
        # are omitted entirely rather than serialized as "none" actions.
        if isinstance(payload, dict) and isinstance(payload.get("peripherals"), dict):
            active = {k: v for k, v in payload["peripherals"].items() if v and v != "none"}
            if active:
                payload = dict(payload, peripherals=active)
            else:
                payload = {k: v for k, v in payload.items() if k != "peripherals"}
        # Bound encoded content before JSON serialization or base64 decoding.
        # Large POS RPC data must not make the worker allocate multiple copies
        # of a document that the Agent's 5 MiB wire contract will reject.
        data_field = payload.get("data") if isinstance(payload, dict) else None
        decoded_size = None
        if isinstance(data_field, str) and data_field:
            if len(data_field) > MAX_PRINT_BASE64_CHARS:
                raise ValidationError(_("Print payload exceeds the 5 MiB Agent safety limit."))
            # Canonicalize base64 once and reuse decoded length to avoid a second 5 MiB decode.
            try:
                decoded_bytes = base64.b64decode(data_field.encode("ascii"), validate=True)
                decoded_size = len(decoded_bytes)
                if decoded_size > MAX_PRINT_CONTENT_BYTES:
                    raise ValidationError(_("Print payload exceeds the 5 MiB Agent safety limit."))
                data_field = base64.b64encode(decoded_bytes).decode("ascii")
                payload = dict(payload, data=data_field)
            except (TypeError, ValueError, base64.binascii.Error, UnicodeEncodeError):
                pass  # creation validators below reject undecodable content
        try:
            payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Print payload is not JSON serializable.")) from exc
        # Single wire contract (contracts/print-payload-contract.json
        # maxPayloadBytes = 5 MiB, Odoo Agent payload contract, agent payload.go, and
        # the submit validator below all enforce decoded content bytes): a
        # job that cannot be executed must not be created. Measure the same
        # decoded bytes the Agent enforces; without a data field fall back to
        # the serialized size against the same 5 MiB number (such rows are
        # invalid regardless — the data check below rejects them).
        if isinstance(data_field, str) and data_field:
            if decoded_size is not None and decoded_size > MAX_PRINT_CONTENT_BYTES:
                raise ValidationError(_("Print payload exceeds the 5 MiB Agent safety limit."))
        elif len(payload_json.encode("utf-8")) > MAX_PRINT_CONTENT_BYTES:
            raise ValidationError(_("Print payload exceeds the 5 MiB Agent safety limit."))

        # Strict kind resolution with NO defaults: a malformed payload fails
        # HERE, at creation, exactly as it would before submission. Persisted
        # content is validated to the same standard as external API input.
        parsed_payload, derived_type = self._resolve_payload_kind(payload_json)

        if payload_type:
            if payload_type != derived_type:
                raise ValidationError(_(
                    "Payload content (type '%s') contradicts the declared payload_type '%s'."
                ) % (derived_type, payload_type))
        else:
            payload_type = derived_type

        if payload_type in ("pdf", "raster_jpeg"):
            if protocol:
                raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
            effective_protocol = False
        else:
            payload_protocol = parsed_payload.get("protocol")
            if protocol and payload_protocol and protocol != payload_protocol:
                raise ValidationError(_(
                    "Protocol argument '%s' contradicts the payload's own protocol '%s'."
                ) % (protocol, payload_protocol))
            effective_protocol = protocol or payload_protocol
            if not effective_protocol:
                raise ValidationError(_(
                    "Native command payloads require an explicit printer protocol; "
                    "none was declared (protocol is never inferred from the payload type)."
                ))

        # Business operation IDs are opaque v2 identities. Never trim a
        # caller key into a different durable operation (and a different
        # previously created logical operation). Only absent keys are made.
        # Preserve Odoo's historical False/empty optional-field sentinels.
        key = (
            uuid.uuid4().hex
            if idempotency_key is None or idempotency_key is False or idempotency_key == ""
            else idempotency_key
        )
        if not isinstance(key, str) or not key.strip():
            raise ValidationError(_("The print operation key is invalid."))
        def same_operation(existing):
            return (
                existing.printer_id == printer_id
                and existing.destination == str(destination).strip()
                and (existing.destination_key or False) == (destination_key or False)
                and existing.document_type == str(document_type).strip().lower()
                and existing.payload == payload_json
            )

        existing = self_su.search([("company_id", "=", company.id), ("idempotency_key", "=", key)], limit=1)
        if existing:
            if not same_operation(existing):
                raise ValidationError(_("The idempotency key is already used for a different print operation."))
            return existing

        values = {
            "company_id": company.id,
            "print_config_id": print_config.id,
            "printer_id": printer_id,
            "destination": str(destination).strip(),
            "destination_key": destination_key or False,
            "document_type": str(document_type).strip().lower(),
            "status": "queued",
            "payload": payload_json,
            "payload_type": payload_type,
            "protocol": effective_protocol,
            "raw_payload": (raw_payload.replace("\x00", "\\x00") if isinstance(raw_payload, str) else False),
            "printer_profile": printer_profile or False,
            "idempotency_key": key,
            "next_retry_at": db_now_utc(self.env.cr),
            "source_model": source_model or False,
            "source_record_id": source_record_id or False,
            "report_id": report.id if report else False,
        }
        try:
            with self.env.cr.savepoint():
                job = self_su.create(values)
                # Creation performs the SAME strict persisted-payload
                # validation as submission: malformed content can never be
                # stored and dispatched later.
                job._validate_persisted_payload(json.loads(payload_json))
                return job
        except IntegrityError:
            existing = self_su.search([("company_id", "=", company.id), ("idempotency_key", "=", key)], limit=1)
            if existing:
                if not same_operation(existing):
                    raise ValidationError(_("The idempotency key is already used for a different print operation."))
                return existing
            raise






    def _validate_persisted_payload(self, payload):
        self.ensure_one()
        if not isinstance(payload, dict):
            raise ValidationError(_("Stored print payload must be a dictionary."))
        ptype = payload.get("type")
        if not ptype:
            raise ValidationError(_("Stored print payload is missing 'type'."))
        encoding = payload.get("encoding")
        if encoding != "base64":
            raise ValidationError(_("Stored print payload must declare encoding 'base64', got '%s'.") % encoding)

        if self.payload_type == "pdf":
            if ptype != "pdf":
                raise ValidationError(_("Payload type mismatch: expected 'pdf', got '%s'.") % ptype)
            if payload.get("protocol"):
                raise ValidationError(_("PDF payloads cannot specify a printer protocol."))
        elif self.payload_type == "raster_jpeg":
            if ptype != "image":
                raise ValidationError(_("Payload type mismatch: expected 'image', got '%s'.") % ptype)
            if payload.get("protocol"):
                raise ValidationError(_("Raster payloads cannot specify a printer protocol."))
        elif self.payload_type == "raw_cmd":
            if ptype not in ("raw", "escpos"):
                raise ValidationError(_("Payload type mismatch: expected raw/escpos, got '%s'.") % ptype)
            payload_proto = payload.get("protocol")
            if not payload_proto:
                # The WIRE contract requires the protocol inside the payload
                # too; the column alone is not enough (the agent validates
                # the submitted JSON, not this row).
                raise ValidationError(_("Raw/escpos payloads must declare their protocol inside the payload."))
            if ptype == "escpos" and payload_proto != "escpos":
                raise ValidationError(_("ESC/POS payloads require protocol 'escpos', got '%s'.") % payload_proto)
            if payload_proto not in ("raw", "escpos", "zpl", "tspl"):
                raise ValidationError(_("Unsupported payload protocol '%s'.") % payload_proto)
            if self.protocol and payload_proto != self.protocol:
                raise ValidationError(
                    _("Payload protocol mismatch: expected '%s', got '%s'.")
                    % (self.protocol, payload_proto)
                )
        else:
            raise ValidationError(_("Unknown payload type column '%s'.") % self.payload_type)

        # The wire contract names this field "data" only. The old
        # "base64" alias is removed: a job submitting {"base64": ...} would
        # pass here and then 422 at the Agent.
        raw_data = payload.get("data")
        if not raw_data or not isinstance(raw_data, str):
            raise ValidationError(_("Stored print payload data must be a non-empty string."))
        if len(raw_data) > MAX_PRINT_BASE64_CHARS:
            raise ValidationError(_("Stored print payload exceeds the 5 MiB Agent safety limit."))
        try:
            decoded = base64.b64decode(raw_data.encode("ascii"), validate=True)
        except (UnicodeEncodeError, ValueError, base64.binascii.Error) as exc:
            raise ValidationError(_("Stored print payload data is not valid base64.")) from exc
        if not decoded:
            raise ValidationError(_("Stored print payload decoded to empty content."))
        if len(decoded) > MAX_PRINT_CONTENT_BYTES:
            raise ValidationError(_("Stored print payload exceeds the 5 MiB Agent safety limit."))
        # Content/signature parity with the Odoo and Agent validators:
        # what claims to be a PDF must start with %PDF-, a raster must be a
        # JPEG, and byte streams must not smuggle PDF headers.
        looks_like_pdf = decoded[:5] == b"%PDF-"
        looks_like_jpeg = len(decoded) >= 3 and decoded[0] == 0xFF and decoded[1] == 0xD8 and decoded[2] == 0xFF
        if self.payload_type == "pdf" and not looks_like_pdf:
            raise ValidationError(_("PDF payload must start with the %%PDF- signature."))
        if self.payload_type == "pdf" and b"%%EOF" not in decoded[-4096:]:
            raise ValidationError(_("Stored PDF is incomplete (missing the %%EOF trailer)."))
        if self.payload_type == "raster_jpeg" and not looks_like_jpeg:
            raise ValidationError(_("Raster payload must be a JPEG."))
        if self.payload_type == "raw_cmd" and looks_like_pdf:
            raise ValidationError(_("PDF bytes cannot be labeled as raw/escpos; the Agent would reject this job."))

        peripherals = payload.get("peripherals")
        if peripherals is not None:
            if not isinstance(peripherals, dict):
                raise ValidationError(_("Payload peripherals must be a dictionary."))
            active_periph = {
                k: v for k, v in peripherals.items()
                if v and v != "none"
            }
            if not active_periph:
                payload.pop("peripherals", None)
            else:
                if ptype == "image":
                    # Raster JPEG jobs carry no job-level protocol column; verify against
                    # local printer inventory when present instead of nonexistent binding_id.
                    is_escpos = True
                    if self.printer_id and self.company_id:
                        root_co = self.company_id.parent_id or self.company_id
                        printers = self.env["print_gateway.printer"].sudo().search([
                            ("printer_key", "=", self.printer_id),
                            ("company_id", "in", [self.company_id.id, root_co.id]),
                        ])
                        if printers and not any(
                            (p.protocol or "").lower() == "escpos"
                            or "escpos" in (p.capabilities_json or "").lower()
                            for p in printers
                        ):
                            is_escpos = False
                else:
                    is_escpos = ptype == "escpos" or (
                        ptype == "raw" and (payload.get("protocol") == "escpos" or self.protocol == "escpos")
                    )
                if not is_escpos:
                    raise ValidationError(_("Peripherals are only supported for ESC/POS protocol."))
                payload["peripherals"] = active_periph




    def _post_source_audit(self, message):
        """Post optional chatter without poisoning the print-job transaction.

        An ORM write can raise a PostgreSQL error, which aborts the current
        transaction until rolled back. Chatter is best-effort: isolate every
        message in a savepoint before catching a failure so print delivery,
        retry bookkeeping and claim finalization remain valid.
        """
        for job in self:
            if not job.source_model or not job.source_record_id:
                continue
            try:
                with job.env.cr.savepoint():
                    record = job.env[job.source_model].browse(job.source_record_id).exists()
                    if record and hasattr(record, "message_post"):
                        record.message_post(body=message, subtype_xmlid="mail.mt_note")
            except Exception as exc:
                _logger.debug("Chatter audit logging skipped: %s", exc)






    def _require_outbox_write(self):
        # The durable outbox is read-only for normal users; status-changing
        # operator actions are privileged. Server-side flows (router submit,
        # intent dispatch, cron) already run elevated and pass transparently.
        # This guard keeps RPC access fail-closed for interactive users.
        # NOTE: check_access() is the single Odoo 19 API covering both model
        # rights and record rules (check_access_rights/check_access_rule are
        # deprecated since 18.0).
        self.check_access("write")




    def action_submit(self, raise_on_failure=False):
        self._require_outbox_write()
        return self._action_submit_trusted(raise_on_failure=raise_on_failure)


    @api.private
    def _action_submit_trusted(self, raise_on_failure=False):
        """Leave durable jobs in Odoo for the directly paired local Agent.

        Odoo is the only print data plane: it owns the outbox, claim state and
        final execution result. This method intentionally performs no HTTP
        request to Yaseir Cloud. The Agent polls Odoo's authenticated
        ``/api/agent/jobs`` endpoint and acknowledges each execution directly.
        """
        self = self.sudo()
        for job in self:
            if not job.print_config_id.sudo().enabled:
                if raise_on_failure:
                    raise ValidationError(_(
                        "Printing is disabled for this company. Re-enable the printing service to submit queued jobs."
                    ))
                continue
            if job.status in self._TERMINAL:
                continue
            # Keep `queued` unchanged. The DirectAgentController claims it
            # after this transaction commits; no intermediary queue exists.
        return True







    def action_retry(self):
        self._require_outbox_write()
        self._assert_valid_license()
        """Create a new logical print operation only from a definitely failed job.

        Unknown physical outcomes are never retried from the UI. A failed job that
        is definitely not printed gets a fresh idempotency key so the new operation
        is not collapsed into the old Agent job.
        """
        failed_jobs = self.filtered(lambda row: row.status == "failed" and row.physical_outcome == "not_printed")
        if not failed_jobs:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("No Eligible Jobs"),
                    "message": _("No eligible failed print jobs (with confirmed non-printed outcome) found to retry."),
                    "type": "warning",
                    "sticky": False,
                },
            }
        retried_jobs = self.env["print_gateway.print_job"]
        for job in failed_jobs:
            if not job.payload:
                raise ValidationError(_("A print job requires a payload."))
            try:
                retry_payload = json.loads(job.payload)
            except (TypeError, ValueError) as exc:
                raise ValidationError(_("Print payload is not valid JSON: %s") % exc) from exc
            retry = self.with_company(job.company_id).create_operation(
                company=job.company_id,
                print_config=job.print_config_id,
                printer_id=job.printer_id,
                destination=job.destination,
                destination_key=job.destination_key,
                document_type=job.document_type,
                payload=retry_payload,
                payload_type=job.payload_type,
                protocol=job.protocol,
                raw_payload=job.raw_payload,
                printer_profile=job.printer_profile,
                    source_model=job.source_model,
                source_record_id=job.source_record_id,
                report=job.report_id,
                idempotency_key=uuid.uuid4().hex,
            )
            retried_jobs |= retry
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Print Job Retried"),
                "message": _("Retried %d print job(s) with new operation ID(s): %s")
                % (len(retried_jobs), ", ".join(str(j.id) for j in retried_jobs)),
                "type": "success",
                "sticky": False,
            },
        }

    def action_force_reprint(self):
        self._require_outbox_write()
        self._assert_valid_license()
        """Explicitly re-issue a job whose physical outcome is unknown.

        This requires conscious operator action, preventing automated double printing of receipts/invoices.
        Generates a deterministic derived idempotency key: ${original_key}-reprint-${reprint_attempt_count}.
        """
        reprint_candidates = self.filtered(lambda row: row.status == "unknown" or (row.status in ("failed", "canceled") and row.physical_outcome == "unknown"))
        if not reprint_candidates:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("No Eligible Jobs"),
                    "message": _("No eligible unknown-outcome print jobs found for force reprint."),
                    "type": "info",
                    "sticky": False,
                },
            }
        reprinted_jobs = self.env["print_gateway.print_job"]
        for job in reprint_candidates:
            new_count = (job.reprint_attempt_count or 0) + 1
            derived_key = "%s-reprint-%d" % (job.idempotency_key, new_count)
            if len(derived_key) > 200:
                # A valid original v2 key can already occupy all 200
                # characters. Preserve existing short derived identities,
                # and compact only keys which the wire contract cannot admit.
                # Hash the full source and sequence so concurrent requests
                # still collapse and distinct long prefixes never truncate.
                derived_key = "reprint-" + uuid.uuid5(uuid.NAMESPACE_URL, derived_key).hex
            _logger.info(
                "Force reprint requested for print job %s (attempt %d, derived key: %s)",
                job.id, new_count, derived_key,
            )
            if not job.payload:
                raise ValidationError(_("A print job requires a payload."))
            try:
                reprint_payload = json.loads(job.payload)
            except (TypeError, ValueError) as exc:
                raise ValidationError(_("Print payload is not valid JSON: %s") % exc) from exc
            retry = self.with_company(job.company_id).create_operation(
                company=job.company_id,
                print_config=job.print_config_id,
                printer_id=job.printer_id,
                destination=job.destination,
                destination_key=job.destination_key,
                document_type=job.document_type,
                payload=reprint_payload,
                payload_type=job.payload_type,
                protocol=job.protocol,
                raw_payload=job.raw_payload,
                printer_profile=job.printer_profile,
                    source_model=job.source_model,
                source_record_id=job.source_record_id,
                report=job.report_id,
                idempotency_key=derived_key,
            )
            # The sequence number is consumed ONLY once the new operation
            # exists: a failed creation (validation/conflict) must not burn
            # a number, or the next attempt would skip a key and gap the
            # audit trail. Concurrent operators computing the same number
            # collapse onto the unique idempotency key instead of printing
            # twice.
            # Preserve monotonic reprint numbering under concurrent operators.
            # The derived idempotency key is computed optimistically; duplicate
            # creators collapse onto the same key. GREATEST prevents a slower
            # request from writing an older counter value after a faster request
            # has already advanced it.
            self.env.cr.execute(
                """
                UPDATE print_gateway_print_job
                SET reprint_attempt_count = GREATEST(reprint_attempt_count, %s)
                WHERE id = %s
                """,
                (new_count, job.id),
            )
            job.invalidate_recordset(["reprint_attempt_count"])
            reprinted_jobs |= retry
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Force Reprint Dispatched"),
                "message": _("Operator force reprint dispatched for %d job(s).") % len(reprinted_jobs),
                "type": "warning",
                "sticky": False,
            },
        }

    def _require_cron_runner(self):
        # Keep the legacy maintenance guard. Direct Agent polling and ACKs
        # are authenticated HTTP calls initiated by the Agent, not cron jobs.
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only scheduled actions (administrator) may run this maintenance method."))



    @api.model
    @api.private
    def cron_cleanup_terminal_jobs(self):
        """Delete terminal print payload/history after the shared 48-hour TTL.

        Active jobs are never selected. SKIP LOCKED avoids racing submit/status
        workers, and bounded batches keep the scheduled action predictable.
        """
        self._require_cron_runner()
        cutoff = db_now_utc(self.env.cr) - datetime.timedelta(hours=self._TERMINAL_RETENTION_HOURS)
        self.env.cr.execute("""
            SELECT id
              FROM print_gateway_print_job
             WHERE status IN ('success', 'failed', 'unknown', 'canceled')
               AND COALESCE(completed_at, write_date, create_date) <= %s
             ORDER BY COALESCE(completed_at, write_date, create_date) ASC, id ASC
             LIMIT 500
             FOR UPDATE SKIP LOCKED
        """, (cutoff,))
        job_ids = [row[0] for row in self.env.cr.fetchall()]
        if not job_ids:
            return 0
        jobs = self.sudo().browse(job_ids).exists()
        deleted = len(jobs)
        jobs.unlink()
        return deleted

