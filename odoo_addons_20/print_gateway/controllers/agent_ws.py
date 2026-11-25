# -*- coding: utf-8 -*-
"""Persistent WebSocket endpoint (/api/agent/ws) + pure-Python RFC 6455 helpers."""

import base64
import hashlib
import json
import logging
import random
import select
import struct
import threading
import time

try:
    from odoo import http, sql_db
    from odoo.http import request
except ImportError:  # pragma: no cover - pure-Python unit tests without Odoo runtime
    http = None
    sql_db = None
    request = None

_logger = logging.getLogger(__name__)

# RFC 6455 constants
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_WS_FRAME_BYTES = 16 * 1024 * 1024  # 16 MiB
OPCODE_TEXT = 0x1
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA
_KEEPALIVE_INTERVAL_S = 25.0


def compute_ws_accept(sec_websocket_key):
    """Compute RFC 6455 Sec-WebSocket-Accept header value."""
    key = (sec_websocket_key or "").strip()
    if not key:
        raise ValueError("Sec-WebSocket-Key must be non-empty")
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _xor_mask(data, mask_key):
    n = len(data)
    if not n:
        return b""
    full_mask = (mask_key * ((n + 3) // 4))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(full_mask, "big")).to_bytes(n, "big")


def encode_ws_frame(payload, opcode=OPCODE_TEXT, fin=True, mask_key=None):
    """Encode a single RFC 6455 WebSocket frame."""
    if isinstance(payload, str):
        raw = payload.encode("utf-8")
    elif isinstance(payload, (bytes, bytearray, memoryview)):
        raw = bytes(payload)
    else:
        raise TypeError("payload must be bytes or str")

    length = len(raw)
    if length > MAX_WS_FRAME_BYTES:
        raise ValueError("WebSocket frame exceeds 16 MiB limit")
    if opcode >= 0x8 and (length > 125 or not fin):
        raise ValueError("Control frames must be unfragmented and <= 125 bytes")

    first = (0x80 if fin else 0x00) | (opcode & 0x0F)
    mask_bit = 0x80 if mask_key is not None else 0x00
    if mask_key is not None:
        if not isinstance(mask_key, (bytes, bytearray)) or len(mask_key) != 4:
            raise ValueError("mask_key must be 4 bytes")
        mask_key = bytes(mask_key)

    if length < 126:
        header = struct.pack("!BB", first, mask_bit | length)
    elif length <= 0xFFFF:
        header = struct.pack("!BBH", first, mask_bit | 126, length)
    else:
        header = struct.pack("!BBQ", first, mask_bit | 127, length)

    if mask_key is not None:
        return header + mask_key + _xor_mask(raw, mask_key)
    return header + raw


def decode_ws_frame(data, max_bytes=MAX_WS_FRAME_BYTES):
    """Decode one RFC 6455 frame; returns (opcode, payload, fin, consumed)."""
    buf = memoryview(data)
    if len(buf) < 2:
        raise ValueError("Incomplete WebSocket frame header")

    b0 = buf[0]
    b1 = buf[1]
    if b0 & 0x70:
        raise ValueError("Non-zero RSV bits are not supported")

    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    offset = 2

    if length == 126:
        if len(buf) < offset + 2:
            raise ValueError("Incomplete 16-bit WebSocket length")
        length = struct.unpack("!H", buf[offset:offset + 2])[0]
        offset += 2
    elif length == 127:
        if len(buf) < offset + 8:
            raise ValueError("Incomplete 64-bit WebSocket length")
        length = struct.unpack("!Q", buf[offset:offset + 8])[0]
        offset += 8

    limit = min(int(max_bytes), MAX_WS_FRAME_BYTES)
    if length > limit:
        raise ValueError("WebSocket frame exceeds maximum allowed size")
    if opcode >= 0x8 and (length > 125 or not fin):
        raise ValueError("Invalid control frame")

    mask_key = None
    if masked:
        if len(buf) < offset + 4:
            raise ValueError("Incomplete WebSocket mask key")
        mask_key = bytes(buf[offset:offset + 4])
        offset += 4

    end = offset + length
    if len(buf) < end:
        raise ValueError("Incomplete WebSocket frame payload")

    payload = bytes(buf[offset:end])
    if mask_key is not None:
        payload = _xor_mask(payload, mask_key)

    return opcode, payload, fin, end


def _query_pending_jobs(cr, agent_id):
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
        (agent_id,),
    )
    row = cr.fetchone()
    return int(row[0] or 0) if row else 0


class _CursorICP:
    """Minimal ir.config_parameter adapter over a raw psycopg2 cursor."""

    def __init__(self, cr, prefetch_keys=()):
        self._cr = cr
        self._cache = {}
        if prefetch_keys:
            self._cr.execute(
                "SELECT key, value FROM ir_config_parameter WHERE key = ANY(%s)",
                (list(prefetch_keys),),
            )
            found = dict(self._cr.fetchall())
            for k in prefetch_keys:
                self._cache[k] = found.get(k)

    def get_str(self, key, default=""):
        if key in self._cache:
            val = self._cache[key]
            return val if val is not None else default
        self._cr.execute(
            "SELECT value FROM ir_config_parameter WHERE key = %s LIMIT 1",
            (key,),
        )
        row = self._cr.fetchone()
        val = row[0] if row else None
        self._cache[key] = val
        return val if val is not None else default


def _read_db_uuid_and_license(cr):
    from ..models.print_config import verify_stored_license_bundle

    icp = _CursorICP(
        cr,
        prefetch_keys=(
            "database.uuid",
            "print_gateway.signed_license_bundle",
            "print_gateway.license_public_key_b64",
        ),
    )
    db_uuid = (icp.get_str("database.uuid") or "").strip() or None
    lic_ok, lic_reason, license_bundle = verify_stored_license_bundle(icp)
    return db_uuid, lic_ok, lic_reason, license_bundle


def _is_agent_active(cr, agent_id):
    cr.execute(
        """
        SELECT 1
          FROM print_gateway_agent
         WHERE id = %s
           AND active = TRUE
           AND token_hash IS NOT NULL
           AND token_hash <> ''
         LIMIT 1
        """,
        (agent_id,),
    )
    return cr.fetchone() is not None


def _touch_agent_online(cr, agent_id):
    cr.execute(
        """
        UPDATE print_gateway_agent
           SET status = 'online',
               last_seen_at = (clock_timestamp() AT TIME ZONE 'UTC'),
               write_date = (clock_timestamp() AT TIME ZONE 'UTC')
         WHERE id = %s
           AND active = TRUE
           AND token_hash IS NOT NULL
           AND token_hash <> ''
        """,
        (agent_id,),
    )
    return cr.rowcount > 0


def _send_json(ws, payload, send_lock=None):
    encoded = json.dumps(payload, default=str)
    if send_lock is not None:
        with send_lock:
            ws.send(encoded)
    else:
        ws.send(encoded)


def _handle_client_message(raw_msg, ws, dbname, agent_id, send_lock=None):
    if not raw_msg or len(raw_msg) > 65536:
        return
    if isinstance(raw_msg, (bytes, bytearray)):
        raw_msg = raw_msg.decode("utf-8", errors="replace")
    try:
        msg = json.loads(raw_msg)
    except (TypeError, ValueError):
        return
    if not isinstance(msg, dict):
        return
    msg_type = str(msg.get("type") or "").strip().lower()
    if msg_type == "ping":
        _send_json(ws, {"type": "pong"}, send_lock=send_lock)
    elif msg_type == "heartbeat":
        with sql_db.db_connect(dbname).cursor() as cr:
            still_active = _touch_agent_online(cr, agent_id)
        if not still_active:
            _send_json(ws, {"type": "agent_revoked", "reason": "agent_inactive_or_revoked"}, send_lock=send_lock)
            try:
                if send_lock is not None:
                    with send_lock:
                        ws.close()
                else:
                    ws.close()
            except Exception:
                pass
            return
        _send_json(ws, {"type": "heartbeat_ack", "ok": True}, send_lock=send_lock)


def _is_gevent_patched():
    try:
        import gevent.monkey
        return bool(gevent.monkey.is_module_patched("threading"))
    except Exception:
        return False


class _AgentWaiter:
    """Lightweight per-WebSocket wakeup handle for job and license channels."""

    __slots__ = ("company_id", "_event", "_lock", "_job_ready", "_license_updated")

    def __init__(self, company_id):
        self.company_id = str(company_id)
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._job_ready = False
        self._license_updated = False

    def notify_job(self):
        with self._lock:
            self._job_ready = True
            self._event.set()

    def notify_license(self):
        with self._lock:
            self._license_updated = True
            self._event.set()

    def wake(self):
        with self._lock:
            self._event.set()

    def wait(self, timeout):
        return self._event.wait(timeout)

    def consume(self):
        with self._lock:
            job = self._job_ready
            lic = self._license_updated
            self._job_ready = False
            self._license_updated = False
            self._event.clear()
        return job, lic


class _NotificationHub:
    """Process-wide per-database LISTEN dispatcher shared by all WebSocket agents."""

    _POLL_TIMEOUT_S = 5.0
    _BACKOFF_INITIAL_S = 1.0
    _BACKOFF_MAX_S = 30.0
    _MAX_BATCH_COMPANIES = 1024

    def __init__(self, dbname):
        self.dbname = dbname
        self._lock = threading.Lock()
        self._company_waiters = {}
        self._license_waiters = set()
        self._worker = None
        self._worker_token = None
        self._stop_event = threading.Event()

    def register(self, company_id):
        waiter = _AgentWaiter(company_id)
        with self._lock:
            self._company_waiters.setdefault(waiter.company_id, set()).add(waiter)
            self._license_waiters.add(waiter)
            self._stop_event.clear()
            if self._worker is None:
                self._start_worker_locked()
        return waiter

    def unregister(self, waiter):
        with self._lock:
            bucket = self._company_waiters.get(waiter.company_id)
            if bucket is not None:
                bucket.discard(waiter)
                if not bucket:
                    del self._company_waiters[waiter.company_id]
            self._license_waiters.discard(waiter)
            if not self._license_waiters:
                self._stop_event.set()

    def _start_worker_locked(self):
        token = object()
        self._worker_token = token
        if _is_gevent_patched():
            import gevent
            self._worker = gevent.spawn(self._dispatcher_loop, token)
        else:
            worker = threading.Thread(
                target=self._dispatcher_loop,
                args=(token,),
                name=f"print-gateway-notify-{self.dbname}",
                daemon=True,
            )
            self._worker = worker
            worker.start()

    def _dispatch_notifications(self, notifies):
        job_companies = set()
        job_broadcast = False
        license_updated = False
        for note in notifies:
            channel = getattr(note, "channel", None)
            payload = (getattr(note, "payload", None) or "").strip()
            if channel == "print_gateway_job_ready":
                if not job_broadcast:
                    if payload:
                        job_companies.add(payload)
                        if len(job_companies) >= self._MAX_BATCH_COMPANIES:
                            job_broadcast = True
                            job_companies.clear()
                    else:
                        job_broadcast = True
                        job_companies.clear()
            elif channel == "print_gateway_license_updated":
                license_updated = True

        if not (job_companies or job_broadcast or license_updated):
            return

        with self._lock:
            if job_broadcast:
                job_targets = list(self._license_waiters)
            else:
                job_targets = []
                for cid in job_companies:
                    job_targets.extend(self._company_waiters.get(cid, ()))
            license_targets = list(self._license_waiters) if license_updated else []

        for waiter in job_targets:
            waiter.notify_job()
        for waiter in license_targets:
            waiter.notify_license()

    def _wake_all_waiters(self):
        with self._lock:
            targets = list(self._license_waiters)
        for waiter in targets:
            waiter.notify_job()
            waiter.notify_license()

    @staticmethod
    def _drain_notifies_iter(notifies_queue):
        # Pop from the tail in O(1) to drain without copying or O(n^2) pop(0).
        while notifies_queue:
            yield notifies_queue.pop()

    def _dispatcher_loop(self, worker_token):
        backoff = self._BACKOFF_INITIAL_S
        reconnecting = False
        try:
            while True:
                with self._lock:
                    if not self._license_waiters:
                        return
                listen_cr = None
                cnx = None
                try:
                    # One autocommit LISTEN connection per DB serves all connected agents.
                    listen_cr = sql_db.db_connect(self.dbname).cursor()
                    cnx = listen_cr._cnx
                    cnx.rollback()
                    cnx.autocommit = True
                    listen_cr.execute("LISTEN print_gateway_job_ready")
                    listen_cr.execute("LISTEN print_gateway_license_updated")
                    backoff = self._BACKOFF_INITIAL_S
                    with self._lock:
                        waiter_count = len(self._license_waiters)
                    if reconnecting:
                        reconnecting = False
                        _logger.info(
                            "NotificationHub event=reconnected db=%s waiters=%d",
                            self.dbname,
                            waiter_count,
                        )
                        self._wake_all_waiters()
                    else:
                        _logger.info(
                            "NotificationHub event=connected db=%s waiters=%d",
                            self.dbname,
                            waiter_count,
                        )

                    while True:
                        with self._lock:
                            if not self._license_waiters:
                                _logger.info(
                                    "NotificationHub event=disconnected db=%s reason=no_waiters",
                                    self.dbname,
                                )
                                return
                        if not cnx.autocommit:
                            cnx.rollback()
                            cnx.autocommit = True
                        if not cnx.notifies:
                            readable, _, _ = select.select([cnx], [], [], self._POLL_TIMEOUT_S)
                            if readable:
                                cnx.poll()
                                if getattr(cnx, "closed", False):
                                    raise ConnectionError("PostgreSQL LISTEN connection closed")
                        if cnx.notifies:
                            self._dispatch_notifications(self._drain_notifies_iter(cnx.notifies))
                except Exception as exc:
                    reconnecting = True
                    _logger.warning(
                        "NotificationHub event=listen_error db=%s backoff_s=%.1f error=%s",
                        self.dbname,
                        backoff,
                        exc.__class__.__name__,
                        exc_info=True,
                    )
                finally:
                    if listen_cr is not None:
                        if cnx is not None and not getattr(cnx, "closed", True):
                            try:
                                cnx.notifies.clear()
                            except Exception:
                                pass
                            try:
                                listen_cr.execute("UNLISTEN *")
                            except Exception:
                                pass
                            try:
                                cnx.autocommit = False
                            except Exception:
                                pass
                        try:
                            listen_cr.close()
                        except Exception:
                            pass

                with self._lock:
                    if not self._license_waiters:
                        return
                # Jittered interruptible backoff prevents thundering-herd DB reconnects
                # and exits promptly if the last WebSocket agent disconnects.
                sleep_s = min(backoff * random.uniform(0.75, 1.25), self._BACKOFF_MAX_S)
                if self._stop_event.wait(sleep_s):
                    with self._lock:
                        if not self._license_waiters:
                            return
                backoff = min(backoff * 2.0, self._BACKOFF_MAX_S)
        finally:
            with self._lock:
                if self._worker_token is worker_token:
                    self._worker = None
                    self._worker_token = None
                    if self._license_waiters:
                        self._start_worker_locked()


_HUBS_LOCK = threading.Lock()
_HUBS = {}


def _get_notification_hub(dbname):
    with _HUBS_LOCK:
        hub = _HUBS.get(dbname)
        if hub is None:
            hub = _NotificationHub(dbname)
            _HUBS[dbname] = hub
        return hub


def _run_ws_loop(ws, dbname, agent):
    """Stream pg_notify job/license pushes and handle client frames."""
    agent_id = agent["id"]
    hub = _get_notification_hub(dbname)
    waiter = hub.register(agent.get("root_company_id") or agent["company_id"])
    send_lock = threading.Lock()
    reader_greenlet = None
    reader_done = threading.Event()
    started_at = time.monotonic()
    disconnect_reason = "ws_closed"
    try:
        # Initial welcome snapshot
        with sql_db.db_connect(dbname).cursor() as cr:
            still_active = _touch_agent_online(cr, agent_id)
            if still_active:
                db_uuid, lic_ok, lic_reason, license_bundle = _read_db_uuid_and_license(cr)
                pending_jobs = _query_pending_jobs(cr, agent_id) if lic_ok else 0
        if not still_active:
            disconnect_reason = "revoked"
            _send_json(ws, {"type": "agent_revoked", "reason": "agent_inactive_or_revoked"}, send_lock=send_lock)
            return
        _logger.info(
            "AgentWS event=connected db=%s agent_uid=%s company_id=%s",
            dbname,
            agent["agent_uid"],
            agent["company_id"],
        )
        _send_json(ws, {
            "type": "welcome",
            "agentId": agent["agent_uid"],
            "odooDbUuid": db_uuid,
            "licenseValid": lic_ok,
            "licenseReason": lic_reason,
            "licenseBundle": license_bundle,
            "pendingJobs": pending_jobs,
        }, send_lock=send_lock)
        if not lic_ok:
            _send_json(ws, {
                "type": "license_update",
                "valid": False,
                "reason": lic_reason,
                "odooDbUuid": db_uuid,
                "licenseBundle": license_bundle,
            }, send_lock=send_lock)

        # Spawn a cooperative gevent reader for incoming client frames so
        # LISTEN notifications are never blocked waiting on ws.receive().
        try:
            import gevent

            def _reader():
                try:
                    while not getattr(ws, "closed", False):
                        frame = ws.receive()
                        if frame is None:
                            break
                        _handle_client_message(frame, ws, dbname, agent_id, send_lock=send_lock)
                except Exception:
                    _logger.debug("Agent WebSocket reader ended for %s", agent["agent_uid"], exc_info=True)
                finally:
                    reader_done.set()
                    waiter.wake()

            reader_greenlet = gevent.spawn(_reader)
        except Exception:
            reader_greenlet = None

        last_ping = time.monotonic()
        while not getattr(ws, "closed", False):
            if reader_done.is_set() or (reader_greenlet is not None and reader_greenlet.ready()):
                disconnect_reason = "reader_closed"
                break

            wait_s = max(0.5, _KEEPALIVE_INTERVAL_S - (time.monotonic() - last_ping))
            if waiter.wait(wait_s):
                if getattr(ws, "closed", False):
                    disconnect_reason = "ws_closed"
                    break
                if reader_done.is_set() or (reader_greenlet is not None and reader_greenlet.ready()):
                    disconnect_reason = "reader_closed"
                    break
                job_notified, license_notified = waiter.consume()

                if job_notified or license_notified:
                    with sql_db.db_connect(dbname).cursor() as cr:
                        still_active = _is_agent_active(cr, agent_id) if license_notified else True
                        if still_active:
                            db_uuid, lic_ok, lic_reason, license_bundle = _read_db_uuid_and_license(cr)
                            pending_jobs = _query_pending_jobs(cr, agent_id) if (job_notified and lic_ok) else 0
                    if license_notified and not still_active:
                        disconnect_reason = "revoked"
                        _send_json(ws, {"type": "agent_revoked", "reason": "agent_inactive_or_revoked"}, send_lock=send_lock)
                        break
                    if job_notified:
                        if not lic_ok and not license_notified:
                            _send_json(ws, {
                                "type": "license_update",
                                "valid": False,
                                "reason": lic_reason,
                                "odooDbUuid": db_uuid,
                                "licenseBundle": license_bundle,
                            }, send_lock=send_lock)
                        elif lic_ok and pending_jobs > 0:
                            _send_json(ws, {"type": "job_available", "pendingJobs": pending_jobs}, send_lock=send_lock)
                    if license_notified:
                        _send_json(ws, {
                            "type": "license_update",
                            "valid": lic_ok,
                            "reason": lic_reason,
                            "odooDbUuid": db_uuid,
                            "licenseBundle": license_bundle,
                        }, send_lock=send_lock)

            now = time.monotonic()
            if now - last_ping >= _KEEPALIVE_INTERVAL_S:
                _send_json(ws, {"type": "ping"}, send_lock=send_lock)
                last_ping = now
    except Exception as exc:
        disconnect_reason = f"error:{exc.__class__.__name__}"
        _logger.debug("Agent WebSocket loop ended for %s", agent["agent_uid"], exc_info=True)
    finally:
        if reader_greenlet is not None and not reader_greenlet.ready():
            reader_greenlet.kill(block=False)
        if not getattr(ws, "closed", False):
            try:
                with send_lock:
                    ws.close()
            except Exception:
                pass
        hub.unregister(waiter)
        _logger.info(
            "AgentWS event=disconnected db=%s agent_uid=%s reason=%s duration_s=%.1f",
            dbname,
            agent["agent_uid"],
            disconnect_reason,
            time.monotonic() - started_at,
        )


if http is not None and __package__:
    from .agent_api import _authenticate_agent, _json_response

    class AgentWebSocketController(http.Controller):
        """Persistent WebSocket push channel for directly paired Go Agents."""

        @http.route("/api/agent/ws", type="http", auth="none", methods=["GET"], csrf=False)
        def agent_ws(self, **_kwargs):
            dbname = getattr(request, "db", None)
            if not dbname:
                return _json_response({"error": "Unauthorized"}, status=401)
            # Authenticate with a short-lived cursor so no DB connection is held
            # idle-in-transaction for the lifetime of the WebSocket.
            with sql_db.db_connect(dbname).cursor() as cr:
                agent = _authenticate_agent(cr)
                if agent:
                    cr.execute(
                        "SELECT COALESCE(parent_id, id) FROM res_company WHERE id = %s",
                        (agent["company_id"],),
                    )
                    row = cr.fetchone()
                    if row and row[0]:
                        agent["root_company_id"] = row[0]
            if not agent:
                return _json_response({"error": "Unauthorized"}, status=401)

            ws = request.httprequest.environ.get("wsgi.websocket")
            if ws is None:
                return _json_response(
                    {
                        "error": "WebSocket upgrade requires gevent worker; use HTTP polling fallback",
                        "fallback": "http_polling",
                    },
                    status=426,
                )

            _run_ws_loop(ws, dbname, agent)
            return request.make_response("", status=200)
