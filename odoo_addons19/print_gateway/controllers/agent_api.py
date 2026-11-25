# -*- coding: utf-8 -*-
import hashlib
import hmac
import json
import secrets

from odoo import http
from odoo.http import request

from ..models.crypto import CredentialError, hash_agent_pairing_code
from ..models.print_config import verify_stored_license_bundle


def _json_response(payload, status=200):
    return request.make_response(
        json.dumps(payload, default=str),
        status=status,
        headers=[
            ("Content-Type", "application/json; charset=utf-8"),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
    )


def _read_json_body(max_bytes=512 * 1024):
    content_length = getattr(request.httprequest, "content_length", None)
    if content_length is not None and content_length > max_bytes:
        return None, _json_response({"error": "Payload too large"}, status=413)
    stream = getattr(request.httprequest, "stream", None)
    if stream is not None and hasattr(stream, "read"):
        raw = stream.read(max_bytes + 1) or b""
    else:
        raw = request.httprequest.get_data(cache=False) or b""
    if len(raw) > max_bytes:
        return None, _json_response({"error": "Payload too large"}, status=413)
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, ValueError):
        return None, _json_response({"error": "Invalid JSON"}, status=400)
    if not isinstance(data, dict):
        return None, _json_response({"error": "JSON object required"}, status=400)
    return data, None


def _hash_token(raw):
    return hashlib.sha256((raw or "").strip().encode("utf-8")).hexdigest()


def _authenticate_agent(cr):
    auth = request.httprequest.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return None
    raw_cred = auth[7:].strip()
    if not raw_cred:
        return None
    agent_uid_part, sep, token = raw_cred.partition(":")
    if not sep:
        token = raw_cred
        agent_uid_part = ""
    token = token.strip()
    if not token:
        return None
    token_hash = _hash_token(token)
    cr.execute(
        """
        SELECT id, company_id, agent_uid, token_hash
          FROM print_gateway_agent
         WHERE active = TRUE AND token_hash = %s
         LIMIT 1
        """,
        (token_hash,),
    )
    row = cr.fetchone()
    if not row or not hmac.compare_digest(row[3] or "", token_hash):
        return None
    if agent_uid_part and not hmac.compare_digest(row[2] or "", agent_uid_part.strip()):
        return None
    return {"id": row[0], "company_id": row[1], "agent_uid": row[2]}


class DirectAgentController(http.Controller):
    """Direct Odoo <-> Go Agent API. Odoo owns the print queue and outcomes."""

    @http.route("/api/agent/probe", type="http", auth="none", methods=["GET"], csrf=False)
    def agent_probe(self, **_kwargs):
        return _json_response({"ok": True, "service": "odoo-direct-print-agent"})

    @http.route(["/print_gateway/agent/register", "/api/agent/register"], type="http", auth="none", methods=["POST"], csrf=False)
    def agent_register(self, **_kwargs):
        data, err = _read_json_body()
        if err:
            return err
        pairing_code = str(data.get("pairingCode") or "").strip()
        if not pairing_code:
            return _json_response({"error": "pairingCode is required"}, status=400)
        try:
            pairing_hash = hash_agent_pairing_code(pairing_code)
        except CredentialError:
            # Fail closed. A raw SHA-256 fallback would make the 30-bit code
            # enumerable offline from a database-only compromise.
            return _json_response({"error": "Agent pairing is temporarily unavailable; contact the administrator"}, status=503)
        if not getattr(request, "db", None):
            return _json_response({"error": "Unauthorized"}, status=401)
        cr = request.env.cr
        cr.execute(
            """
            SELECT id, company_id, agent_uid
              FROM print_gateway_agent
             WHERE active = TRUE
               AND pairing_code_hash = %s
               AND pairing_expires_at >= (clock_timestamp() AT TIME ZONE 'UTC')
             LIMIT 1
             FOR UPDATE
            """,
            (pairing_hash,),
        )
        row = cr.fetchone()
        if not row:
            return _json_response({"error": "Invalid or expired pairing code"}, status=401)
        agent_id, company_id, agent_uid = row
        icp = request.env["ir.config_parameter"].sudo()
        lic_ok, lic_reason, lic_bundle = verify_stored_license_bundle(icp)
        if not lic_ok:
            return _json_response({"error": "License invalid", "reason": lic_reason}, status=403)
        cr.execute("SELECT pg_advisory_xact_lock(hashtext('print_gateway_agent_limit'))")
        cr.execute(
            """
            SELECT count(*)
              FROM print_gateway_agent
             WHERE active = TRUE
               AND token_hash IS NOT NULL
               AND token_hash <> ''
               AND id <> %s
            """,
            (agent_id,),
        )
        active_agents = int(cr.fetchone()[0] or 0) + 1
        max_agents = int(((lic_bundle or {}).get("payload") or {}).get("max_agents") or 0)
        if max_agents > 0 and active_agents > max_agents:
            return _json_response({"error": "Agent limit exceeded", "reason": "max_agents_exceeded"}, status=403)
        raw_token = secrets.token_urlsafe(32)
        cr.execute(
            """
            UPDATE print_gateway_agent
               SET token_hash = %s,
                   pairing_code_hash = NULL,
                   pairing_expires_at = NULL,
                   status = 'online',
                   agent_version = %s,
                   last_seen_at = (clock_timestamp() AT TIME ZONE 'UTC'),
                   write_date = (clock_timestamp() AT TIME ZONE 'UTC')
             WHERE id = %s
            """,
            (_hash_token(raw_token), str(data.get("agentVersion") or "")[:64], agent_id),
        )
        odoo_db_uuid = (icp.get_param("database.uuid") or "").strip() or None
        return _json_response({
            "ok": True,
            "agentId": agent_uid,
            "companyId": company_id,
            "token": raw_token,
            "secret": raw_token,
            "odooDbUuid": odoo_db_uuid,
            "licenseBundle": lic_bundle,
        })

    @http.route(["/print_gateway/agent/heartbeat", "/api/agent/heartbeat"], type="http", auth="none", methods=["POST"], csrf=False)
    def agent_heartbeat(self, **_kwargs):
        if not getattr(request, "db", None):
            return _json_response({"error": "Unauthorized"}, status=401)
        cr = request.env.cr
        agent = _authenticate_agent(cr)
        if not agent:
            return _json_response({"error": "Unauthorized"}, status=401)
        data, err = _read_json_body()
        if err:
            return err

        cr.execute(
            """
            UPDATE print_gateway_agent
               SET status = 'online',
                   last_seen_at = (clock_timestamp() AT TIME ZONE 'UTC'),
                   write_date = (clock_timestamp() AT TIME ZONE 'UTC')
             WHERE id = %s
            """,
            (agent["id"],),
        )

        # Extend lease on active in-flight jobs owned by this agent's printers in one batch
        keep_alive = data.get("keepAliveJobIds")
        if isinstance(keep_alive, list) and keep_alive:
            tokens_by_id = {}
            for item in keep_alive[:64]:
                if not isinstance(item, dict) or not item.get("jobId") or not item.get("claimToken"):
                    continue
                try:
                    jid = int(str(item.get("jobId")).strip())
                except (TypeError, ValueError):
                    continue
                if jid > 0:
                    tokens_by_id[jid] = str(item.get("claimToken"))
            if tokens_by_id:
                sorted_ids = sorted(tokens_by_id)
                sorted_tokens = [tokens_by_id[jid] for jid in sorted_ids]
                cr.execute(
                    """
                    UPDATE print_gateway_print_job j
                       SET write_date = (clock_timestamp() AT TIME ZONE 'UTC'),
                           claimed_at = CASE
                               WHEN j.status = 'claimed' THEN (clock_timestamp() AT TIME ZONE 'UTC')
                               ELSE j.claimed_at
                           END
                      FROM unnest(%s::bigint[], %s::text[]) AS t(job_id, claim_token)
                     WHERE j.id = t.job_id
                       AND (j.company_id = %s OR j.company_id IN (SELECT id FROM res_company WHERE parent_id = %s))
                       AND j.status IN ('claimed', 'printing')
                       AND j.claim_token = t.claim_token
                    """,
                    (sorted_ids, sorted_tokens, agent["company_id"], agent["company_id"]),
                )

        icp = request.env["ir.config_parameter"].sudo()
        lic_ok, lic_reason, license_bundle = verify_stored_license_bundle(icp)
        max_printers = int(((license_bundle or {}).get("payload") or {}).get("max_printers") or 0)

        raw_hidden = data.get("privatePrinterIds")
        hidden_ids = (
            sorted({str(value)[:120] for value in raw_hidden[:500] if isinstance(value, str) and value.strip()})
            if isinstance(raw_hidden, list)
            else []
        )
        hidden_set = set(hidden_ids)

        printers = data.get("printers")
        has_printers = isinstance(printers, list) and bool(printers)
        if has_printers or hidden_ids:
            # Serialize printer inventory mutations under advisory lock so concurrent
            # heartbeats cannot overshoot max_printers or overwrite Odoo-side
            # unshare choices back to TRUE.
            cr.execute("SELECT pg_advisory_xact_lock(hashtext('print_gateway_printer_limit'))")

        if has_printers:
            cr.execute(
                """
                SELECT count(*)
                  FROM print_gateway_printer pr
                  JOIN print_gateway_agent a ON a.id = pr.agent_id
                 WHERE a.active = TRUE
                   AND pr.available_to_odoo = TRUE
                """
            )
            current_active_printers = int(cr.fetchone()[0] or 0)
            cr.execute(
                "SELECT printer_key FROM print_gateway_printer WHERE agent_id = %s",
                (agent["id"],),
            )
            existing_keys = {r[0] for r in cr.fetchall()}
            # Deduplicate by printer_key (last wins) so batch ON CONFLICT cannot collide.
            batch_by_key = {}
            for p in printers[:500]:
                if not isinstance(p, dict) or not p.get("id") or not p.get("name"):
                    continue
                printer_key = str(p["id"])[:120]
                status = str(p.get("status") or "unknown").lower()
                if status not in ("online", "busy", "offline", "error", "unknown"):
                    status = "unknown"
                raw_avail = p.get("availableToOdoo")
                if raw_avail is None:
                    raw_avail = p.get("sharedWithGateway")
                agent_wants_shared = (printer_key not in hidden_set) and (True if raw_avail is None else bool(raw_avail))
                if printer_key in existing_keys:
                    insert_available = agent_wants_shared
                elif printer_key in batch_by_key:
                    prev_avail = batch_by_key[printer_key][4]
                    insert_available = agent_wants_shared if prev_avail else False
                    if prev_avail and not insert_available:
                        current_active_printers = max(0, current_active_printers - 1)
                else:
                    # Cap newly discovered printers to unshared rather than
                    # randomly disabling existing POS printers.
                    if agent_wants_shared and (max_printers <= 0 or current_active_printers < max_printers):
                        insert_available = True
                        current_active_printers += 1
                    else:
                        insert_available = False
                raw_caps = p.get("capabilities")
                caps = dict(raw_caps) if isinstance(raw_caps, dict) else {}
                conn_type = str(p.get("connectionType") or p.get("connection_type") or "spooler").strip()[:32] or "spooler"
                proto = str(p.get("protocol") or "spooler").strip()[:32] or "spooler"
                printer_type = str(p.get("printerType") or p.get("printer_type") or "").strip().lower()
                if (
                    p.get("isVirtual") is True
                    or p.get("is_virtual") is True
                    or printer_type == "virtual"
                    or conn_type.lower() == "virtual"
                    or proto.lower() == "virtual"
                ):
                    caps["is_virtual"] = True
                    if proto.lower() == "virtual":
                        proto = "spooler"
                if p.get("deviceClass") and "deviceClass" not in caps and "device_class" not in caps:
                    caps["deviceClass"] = str(p.get("deviceClass"))[:32]
                raw_geom = caps.get("geometry") or p.get("geometry")
                if isinstance(raw_geom, dict) and "geometry" not in caps:
                    caps["geometry"] = raw_geom
                caps_json = json.dumps(caps) if caps else (json.dumps(raw_caps) if raw_caps is not None else None)
                geom_json = json.dumps(raw_geom) if raw_geom else None
                batch_by_key[printer_key] = (
                    str(p["name"])[:100],
                    conn_type,
                    proto,
                    status,
                    insert_available,
                    caps_json,
                    geom_json,
                )
            if batch_by_key:
                keys = list(batch_by_key.keys())
                rows = [batch_by_key[k] for k in keys]
                cr.execute(
                    """
                    INSERT INTO print_gateway_printer
                        (agent_id, company_id, printer_key, name, connection_type, protocol,
                         status, available_to_odoo, capabilities_json, geometry_json, last_seen_at,
                         create_date, write_date)
                    SELECT %s, %s, t.printer_key, t.name, t.connection_type, t.protocol,
                           t.status, t.available_to_odoo, t.capabilities_json, t.geometry_json,
                           (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC')
                      FROM unnest(
                               %s::text[], %s::text[], %s::text[], %s::text[],
                               %s::text[], %s::boolean[], %s::text[], %s::text[]
                           ) AS t(printer_key, name, connection_type, protocol,
                                  status, available_to_odoo, capabilities_json, geometry_json)
                    ON CONFLICT (agent_id, printer_key) DO UPDATE SET
                        name = EXCLUDED.name,
                        connection_type = EXCLUDED.connection_type,
                        protocol = EXCLUDED.protocol,
                        status = EXCLUDED.status,
                        available_to_odoo = CASE
                            WHEN EXCLUDED.available_to_odoo = FALSE THEN FALSE
                            ELSE print_gateway_printer.available_to_odoo
                        END,
                        capabilities_json = EXCLUDED.capabilities_json,
                        geometry_json = EXCLUDED.geometry_json,
                        last_seen_at = (clock_timestamp() AT TIME ZONE 'UTC'),
                        write_date = (clock_timestamp() AT TIME ZONE 'UTC')
                    """,
                    (
                        agent["id"],
                        agent["company_id"],
                        keys,
                        [r[0] for r in rows],
                        [r[1] for r in rows],
                        [r[2] for r in rows],
                        [r[3] for r in rows],
                        [r[4] for r in rows],
                        [r[5] for r in rows],
                        [r[6] for r in rows],
                    ),
                )

        if hidden_ids:
            cr.execute(
                """
                UPDATE print_gateway_printer
                   SET available_to_odoo = FALSE,
                       write_date = (clock_timestamp() AT TIME ZONE 'UTC')
                 WHERE agent_id = %s
                   AND printer_key = ANY(%s)
                """,
                (agent["id"], hidden_ids),
            )

        # Recount active shared printers after inventory updates and evaluate limit
        cr.execute(
            """
            SELECT count(*)
              FROM print_gateway_printer pr
              JOIN print_gateway_agent a ON a.id = pr.agent_id
             WHERE a.active = TRUE
               AND pr.available_to_odoo = TRUE
            """
        )
        active_printers = int(cr.fetchone()[0] or 0)
        if lic_ok and max_printers > 0 and active_printers > max_printers:
            lic_ok = False
            lic_reason = "max_printers_exceeded"

        cr.execute(
            """
            SELECT printer_key
              FROM print_gateway_printer
             WHERE agent_id = %s
               AND available_to_odoo = FALSE
             ORDER BY printer_key ASC
            """,
            (agent["id"],),
        )
        disabled_printer_ids = [r[0] for r in cr.fetchall()]

        # Compute pending jobs AFTER printer availability is finalized (skip if license invalid)
        pending_count = 0
        if lic_ok:
            cr.execute(
                """
                SELECT count(*)
                  FROM print_gateway_print_job j
                  JOIN res_company c ON c.id = j.company_id
                  JOIN print_gateway_printer pr
                    ON (pr.company_id = j.company_id OR pr.company_id = c.parent_id)
                   AND pr.printer_key = j.printer_id
                 WHERE pr.agent_id = %s
                   AND pr.available_to_odoo = TRUE
                   AND j.status = 'queued'
                """,
                (agent["id"],),
            )
            pending_count = int(cr.fetchone()[0] or 0)

        odoo_db_uuid = (icp.get_param("database.uuid") or "").strip() or None
        return _json_response({
            "ok": True,
            "pendingJobs": pending_count,
            "odooDbUuid": odoo_db_uuid,
            "licenseValid": lic_ok,
            "licenseReason": lic_reason,
            "licenseBundle": license_bundle,
            "activePrinters": active_printers,
            "maxPrinters": max_printers,
            "disabledPrinterIds": disabled_printer_ids,
        })

    @http.route(["/print_gateway/agent/claim", "/api/agent/jobs", "/api/agent/claim"], type="http", auth="none", methods=["GET", "POST", "PATCH"], csrf=False)
    def agent_claim(self, **_kwargs):
        if request.httprequest.method == "PATCH":
            return self.agent_ack(**_kwargs)
        if not getattr(request, "db", None):
            return _json_response({"error": "Unauthorized"}, status=401)
        cr = request.env.cr
        agent = _authenticate_agent(cr)
        if not agent:
            return _json_response({"error": "Unauthorized"}, status=401)
        lic_ok, lic_reason, lic_bundle = verify_stored_license_bundle(
            request.env["ir.config_parameter"].sudo()
        )
        if not lic_ok:
            return _json_response(
                {
                    "error": "License invalid, expired, or revoked",
                    "code": lic_reason,
                    "reason": lic_reason,
                    "licenseBundle": lic_bundle,
                },
                status=403,
            )
        data, err = _read_json_body()
        if err:
            return err
        raw_limit = data.get("limit", 5)
        if raw_limit is None or raw_limit == "":
            raw_limit = 5
        if isinstance(raw_limit, bool):
            return _json_response({"error": "Invalid limit"}, status=400)
        try:
            limit = max(1, min(int(raw_limit), 10))
        except (TypeError, ValueError):
            return _json_response({"error": "Invalid limit"}, status=400)
        claim_token = secrets.token_hex(24)
        # A claim is safe to recover only while the row is still `claimed`:
        # the Agent must acknowledge `printing` before touching the device.
        # Once `printing` is recorded, a stale outcome is ambiguous and is
        # never silently re-queued.
        cr.execute(
            """
            WITH stale AS (
                SELECT id
                  FROM print_gateway_print_job
                 WHERE (company_id = %s OR company_id IN (SELECT id FROM res_company WHERE parent_id = %s))
                   AND status = 'claimed'
                   AND COALESCE(claimed_at, write_date) < (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '90 seconds'
                   AND COALESCE(attempts, 0) >= 5
                 ORDER BY id ASC
                 LIMIT 100
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE print_gateway_print_job j
               SET status = 'failed',
                   last_error = 'AGENT_CLAIM_EXHAUSTED: Agent did not acknowledge printing before the claim lease expired; inspect the printer and explicitly reprint if needed.',
                   claim_token = NULL,
                   claimed_at = NULL,
                   completed_at = (clock_timestamp() AT TIME ZONE 'UTC'),
                   write_date = (clock_timestamp() AT TIME ZONE 'UTC')
              FROM stale
             WHERE j.id = stale.id
            """,
            (agent["company_id"], agent["company_id"]),
        )
        cr.execute(
            """
            WITH candidates AS (
                SELECT j.id
                  FROM print_gateway_print_job j
                  JOIN res_company c ON c.id = j.company_id
                  JOIN print_gateway_printer pr
                    ON (pr.company_id = j.company_id OR pr.company_id = c.parent_id)
                   AND pr.printer_key = j.printer_id
                 WHERE pr.agent_id = %s
                   AND pr.available_to_odoo = TRUE
                   AND (
                       j.status = 'queued'
                       OR (j.status = 'claimed'
                           AND COALESCE(j.claimed_at, j.write_date) < (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '90 seconds'
                           AND COALESCE(j.attempts, 0) < 5)
                   )
                 ORDER BY j.id ASC
                 LIMIT %s
                 FOR UPDATE OF j SKIP LOCKED
            )
            UPDATE print_gateway_print_job j
               SET status = 'claimed',
                   claim_token = %s,
                   claimed_at = (clock_timestamp() AT TIME ZONE 'UTC'),
                   attempts = COALESCE(j.attempts, 0) + 1,
                   last_error = NULL,
                   write_date = (clock_timestamp() AT TIME ZONE 'UTC')
              FROM candidates
             WHERE j.id = candidates.id
            RETURNING j.id, j.printer_id, j.document_type, j.payload, j.payload_type, j.protocol, j.destination
            """,
            (agent["id"], limit, claim_token),
        )
        rows = cr.fetchall()
        jobs = []
        for r in rows:
            raw_payload = r[3]
            if isinstance(raw_payload, str) and raw_payload.strip().startswith("{"):
                try:
                    raw_payload = json.loads(raw_payload)
                except ValueError:
                    pass
            stored_type, proto = r[4], r[5]
            if stored_type == "raster_jpeg":
                wire_type = "image"
            elif stored_type == "raw_cmd":
                wire_type = "escpos" if proto == "escpos" else "raw"
            else:
                wire_type = stored_type
            jobs.append({
                "id": str(r[0]),
                "printerId": r[1],
                "agentId": agent["agent_uid"],
                "status": "claimed",
                "documentType": r[2],
                "payload": raw_payload,
                "payloadType": wire_type,
                "protocol": proto,
                "destination": r[6],
                "claimToken": claim_token,
            })
        if request.httprequest.method == "GET" and request.httprequest.path.endswith("/api/agent/jobs"):
            return _json_response(jobs)
        return _json_response({"ok": True, "jobs": jobs})

    @http.route(["/print_gateway/agent/ack", "/api/agent/ack"], type="http", auth="none", methods=["POST", "PATCH"], csrf=False)
    def agent_ack(self, **_kwargs):
        if not getattr(request, "db", None):
            return _json_response({"error": "Unauthorized"}, status=401)
        cr = request.env.cr
        agent = _authenticate_agent(cr)
        if not agent:
            return _json_response({"error": "Unauthorized"}, status=401)
        data, err = _read_json_body()
        if err:
            return err
        job_id = str(data.get("jobId") or "").strip()
        claim_token = str(data.get("claimToken") or "").strip()
        status = str(data.get("status") or "").strip().lower()
        if status == "completed":
            status = "success"
        error_msg = str(data.get("error") or "")[:1000] or None
        if not job_id or not claim_token or status not in ("queued", "printing", "success", "failed", "unknown"):
            return _json_response({"error": "Invalid ack parameters"}, status=400)
        try:
            job_id_int = int(job_id)
        except ValueError:
            return _json_response({"error": "Stale claim or terminal job"}, status=409)
        if job_id_int <= 0:
            return _json_response({"error": "Stale claim or terminal job"}, status=409)

        if status == "queued":
            # Saturation / local-admission rejection happens before physical
            # execution. Only a still-claimed row can be released; a row that
            # reached `printing` is never handed back for automatic replay.
            cr.execute(
                """
                UPDATE print_gateway_print_job
                   SET status = 'queued',
                       attempts = GREATEST(COALESCE(attempts, 0) - 1, 0),
                       last_error = COALESCE(%s, last_error),
                       claim_token = NULL,
                       claimed_at = NULL,
                       write_date = (clock_timestamp() AT TIME ZONE 'UTC')
                 WHERE id = %s
                   AND (company_id = %s OR company_id IN (SELECT id FROM res_company WHERE parent_id = %s))
                   AND claim_token = %s
                   AND status = 'claimed'
                RETURNING id
                """,
                (error_msg, job_id_int, agent["company_id"], agent["company_id"], claim_token),
            )
            updated = cr.fetchone()
            if not updated:
                return _json_response({"error": "Stale claim or job already entered printing"}, status=409)
            return _json_response({"ok": True, "jobId": str(updated[0]), "status": "queued"})

        # Clear bulky payload on terminal settlement (empty string respects NOT NULL)
        # to prevent PostgreSQL TOAST bloat inside Odoo's database.
        cr.execute(
            """
            UPDATE print_gateway_print_job
               SET status = %s,
                   last_error = CASE WHEN %s = 'success' THEN NULL ELSE COALESCE(%s, last_error) END,
                   payload = CASE WHEN %s = 'success' THEN '' ELSE payload END,
                   claim_token = CASE WHEN %s IN ('success', 'failed', 'unknown') THEN NULL ELSE claim_token END,
                   completed_at = CASE WHEN %s IN ('success', 'failed', 'unknown') THEN (clock_timestamp() AT TIME ZONE 'UTC') ELSE completed_at END,
                   write_date = (clock_timestamp() AT TIME ZONE 'UTC')
             WHERE id = %s
               AND (company_id = %s OR company_id IN (SELECT id FROM res_company WHERE parent_id = %s))
               AND claim_token = %s
               AND status IN ('claimed', 'printing')
            RETURNING id
            """,
            (status, status, error_msg, status, status, status, job_id_int, agent["company_id"], agent["company_id"], claim_token),
        )
        updated = cr.fetchone()
        if not updated:
            return _json_response({"error": "Stale claim or terminal job"}, status=409)
        return _json_response({"ok": True, "jobId": str(updated[0]), "status": status})
