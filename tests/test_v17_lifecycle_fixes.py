"""Regression tests for v17 full-lifecycle reliability and v18-v19 hardening fixes."""
import ast
import base64
import datetime
import ipaddress
import importlib.util
import json
import py_compile
import re
import socket
import sys
import types
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def _load_module_from_path(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_print_config_helpers():
    """Import print_config.py pure license helpers without an Odoo runtime."""
    saved = {k: sys.modules.get(k) for k in ("odoo", "odoo.exceptions")}
    odoo_mod = types.ModuleType("odoo")
    class _NoopApi:
        def __getattr__(self, _name):
            def _dec(*a, **kw):
                return a[0] if len(a) == 1 and callable(a[0]) and not kw else (lambda fn: fn)
            return _dec

    noop_field = lambda *a, **kw: None
    class _NoopFields:
        def __getattr__(self, _name):
            return noop_field

    odoo_mod.api = _NoopApi()
    odoo_mod.fields = _NoopFields()
    odoo_mod.models = types.SimpleNamespace(
        Model=type("Model", (), {}),
        TransientModel=type("TransientModel", (), {}),
        AbstractModel=type("AbstractModel", (), {}),
        Constraint=noop_field,
    )
    odoo_mod._ = lambda s: s
    exc_mod = types.ModuleType("odoo.exceptions")
    exc_mod.AccessError = type("AccessError", (Exception,), {})
    exc_mod.ValidationError = type("ValidationError", (Exception,), {})
    sys.modules["odoo"] = odoo_mod
    sys.modules["odoo.exceptions"] = exc_mod
    try:
        return _load_module_from_path(
            "print_gateway_print_config_test",
            ROOT / "odoo_addons19/print_gateway/models/print_config.py",
        )
    finally:
        for k, prev in saved.items():
            if prev is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = prev


class TestV17LifecycleFixes(unittest.TestCase):
    def test_agent_claim_parses_json_payload_and_maps_wire_payload_type(self):
        src = (ROOT / "odoo_addons19/print_gateway/controllers/agent_api.py").read_text(encoding="utf-8")
        py_compile.compile(str(ROOT / "odoo_addons19/print_gateway/controllers/agent_api.py"), doraise=True)
        self.assertIn("raw_payload = json.loads(raw_payload)", src)
        self.assertIn('wire_type = "image"', src)
        self.assertIn('wire_type = "escpos" if proto == "escpos" else "raw"', src)
        self.assertIn('"payload": raw_payload,', src)
        self.assertIn('"payloadType": wire_type,', src)

    def test_agent_ack_preserves_payload_on_failed_and_unknown_for_retry_and_reprint(self):
        src = (ROOT / "odoo_addons19/print_gateway/controllers/agent_api.py").read_text(encoding="utf-8")
        self.assertIn("payload = CASE WHEN %s = 'success' THEN '' ELSE payload END,", src)
        self.assertNotIn("payload = CASE WHEN %s IN ('success', 'failed', 'unknown')", src)

    def test_go_agent_preserves_claim_tokens_in_heartbeat_keepalive(self):
        ag = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        hp = (ROOT / "agent/internal/agent/heartbeat_pagination.go").read_text(encoding="utf-8")
        self.assertIn("keepAliveJobIDs []map[string]string", hp)
        self.assertIn("buildDirectHeartbeatPayloadPages(printerPayload, keepAlivePairs)", ag)

    def test_go_agent_ws_welcome_wakes_poll_loop_when_pending_jobs(self):
        ag = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        self.assertIn('PendingJobs   int             `json:"pendingJobs"`', ag)
        self.assertIn('if evType == "welcome" && ev.PendingJobs > 0 && a.wsWakeCh != nil {', ag)

    def test_desktop_friendly_gateway_error_handles_https_and_invalid_url_with_i18n(self):
        printers_ts = (ROOT / "src/desktop/lib/printers.ts").read_text(encoding="utf-8")
        en_ts = (ROOT / "src/i18n/messages/en.ts").read_text(encoding="utf-8")
        ar_ts = (ROOT / "src/i18n/messages/ar.ts").read_text(encoding="utf-8")
        self.assertIn('tr(locale, "desktop.gateway.httpsRequired")', printers_ts)
        self.assertIn('tr(locale, "desktop.gateway.invalidUrl")', printers_ts)
        for key in ("desktop.gateway.httpsRequired", "desktop.gateway.invalidUrl"):
            self.assertIn(f'"{key}":', en_ts)
            self.assertIn(f'"{key}":', ar_ts)

    def test_odoo_agent_views_buttons_exist_on_model(self):
        agent_py = (ROOT / "odoo_addons19/print_gateway/models/agent.py").read_text(encoding="utf-8")
        tree = ast.parse(agent_py)
        methods = {
            node.name
            for cls in ast.walk(tree)
            if isinstance(cls, ast.ClassDef)
            for node in cls.body
            if isinstance(node, ast.FunctionDef)
        }
        view_tree = ET.parse(str(ROOT / "odoo_addons19/print_gateway/views/agent_views.xml"))
        for btn in view_tree.findall(".//button[@type='object']"):
            name = btn.attrib.get("name", "")
            self.assertIn(name, methods, f"Missing method {name} on print_gateway.agent")

    def test_windows_admin_only_lock_gate_and_backend_guard(self):
        commands = (ROOT / "src-tauri/src/commands.rs").read_text(encoding="utf-8")
        main_rs = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
        build_rs = (ROOT / "src-tauri/build.rs").read_text(encoding="utf-8")
        caps = json.loads((ROOT / "src-tauri/capabilities/default.json").read_text(encoding="utf-8"))
        desktop = (ROOT / "src/desktop/main.tsx").read_text(encoding="utf-8")
        en_ts = (ROOT / "src/i18n/messages/en.ts").read_text(encoding="utf-8")
        ar_ts = (ROOT / "src/i18n/messages/ar.ts").read_text(encoding="utf-8")

        self.assertIn("const TOKEN_ELEVATION: DWORD = 20;", commands)
        self.assertIn("fn require_admin() -> Result<(), String>", commands)
        self.assertIn("pub fn close_app(app: tauri::AppHandle)", commands)
        self.assertIn("pub fn relaunch_as_admin(app: tauri::AppHandle)", commands)
        self.assertIn("app.exit(0);", commands)
        self.assertIn("commands::close_app", main_rs)
        self.assertIn('"close_app"', build_rs)
        self.assertIn("allow-close-app", caps["permissions"])
        self.assertIn("if (isTauri && isAdmin === false)", desktop)
        self.assertIn("await relaunchAsAdmin()", desktop)
        self.assertIn("closeApp()", desktop)
        for key in (
            "desktop.adminGate.badge",
            "desktop.adminGate.title",
            "desktop.adminGate.body",
            "desktop.adminGate.hint",
            "desktop.adminGate.relaunch",
            "desktop.adminGate.close",
            "desktop.adminGate.relaunchFailed",
        ):
            self.assertIn(f'"{key}":', en_ts)
            self.assertIn(f'"{key}":', ar_ts)


class TestV18V19HardeningRegressions(unittest.TestCase):
    def test_rpc_skip_limit_check_requires_superuser(self):
        agent_py = (ROOT / "odoo_addons19/print_gateway/models/agent.py").read_text(encoding="utf-8")
        printer_py = (ROOT / "odoo_addons19/print_gateway/models/printer.py").read_text(encoding="utf-8")
        self.assertIn('self.env.is_superuser() and self.env.context.get("skip_agent_limit_check")', agent_py)
        self.assertEqual(
            printer_py.count('self.env.is_superuser() and self.env.context.get("skip_printer_limit_check")'),
            2,
            "Both create() and write() limit bypass checks must require is_superuser()",
        )
        # Ensure no unguarded context.get("skip_*_limit_check") remains.
        for label, src in (("agent.py", agent_py), ("printer.py", printer_py)):
            for line in src.splitlines():
                if 'context.get("skip_' in line and "_limit_check" in line:
                    self.assertIn("self.env.is_superuser()", line, f"Unguarded limit bypass in {label}: {line}")

    def test_ssrf_effective_ip_blocks_ipv4_mapped_ipv6_literals_and_dns(self):
        gd = _load_module_from_path(
            "print_gateway_destination_test",
            ROOT / "odoo_addons19/print_gateway/models/gateway_destination.py",
        )
        for blocked in ("::ffff:169.254.169.254", "::ffff:100.100.100.200", "::ffff:0.0.0.0", "::ffff:224.0.0.1"):
            with self.subTest(literal=blocked), self.assertRaises(ValueError):
                gd.validate_gateway_host(blocked, allow_private=True)
        for private_mapped in ("::ffff:127.0.0.1", "::ffff:10.0.0.1"):
            with self.subTest(private_literal=private_mapped), self.assertRaises(ValueError):
                gd.validate_gateway_host(private_mapped, allow_private=False)
        resolved = gd.validate_gateway_host("::ffff:93.184.216.34", allow_private=False)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(
            ipaddress.ip_address(resolved[0]),
            ipaddress.ip_address("::ffff:93.184.216.34"),
        )

        fake_meta = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:169.254.169.254", 0, 0, 0))]
        with patch.object(gd.socket, "getaddrinfo", return_value=fake_meta):
            with self.assertRaises(ValueError):
                gd.validate_gateway_host("gw.example.com", resolve=True, allow_private=True)

        fake_priv = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::ffff:10.0.0.5", 0, 0, 0))]
        with patch.object(gd.socket, "getaddrinfo", return_value=fake_priv):
            with self.assertRaises(ValueError):
                gd.validate_gateway_host("gw.example.com", resolve=True, allow_private=False)

    def test_ed25519_validate_license_bundle_rejects_non_active_status(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        pc = _load_print_config_helpers()
        priv = Ed25519PrivateKey.generate()
        pub_b64 = base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
        now = datetime.datetime(2026, 6, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)

        def make_bundle(status):
            claims = {
                "version": 2,
                "rev": 3,
                "status": status,
                "license_id": "lic-test-1",
                "tenant_id": "ten-test-1",
                "odoo_db_uuid": "db-uuid-1",
                "plan": "pro",
                "max_agents": 5,
                "max_printers": 20,
                "issued_at": "2026-05-01T00:00:00Z",
                "expires_at": "2026-07-01T00:00:00Z",
                "grace_until": "2026-07-08T00:00:00Z",
                "key_id": "k1",
            }
            sig = base64.urlsafe_b64encode(priv.sign(pc._canonical_claims_bytes(claims))).decode("ascii").rstrip("=")
            return {"payload": claims, "signature": sig}

        self.assertEqual(pc._validate_license_bundle(make_bundle("active"), "db-uuid-1", pub_b64, now=now), (True, "ok"))
        self.assertEqual(pc._validate_license_bundle(make_bundle("revoked"), "db-uuid-1", pub_b64, now=now), (False, "license_revoked"))
        for bad_status in ("suspended", "expired", "pending"):
            with self.subTest(status=bad_status):
                self.assertEqual(
                    pc._validate_license_bundle(make_bundle(bad_status), "db-uuid-1", pub_b64, now=now),
                    (False, "invalid_status"),
                )

    def test_platform_session_security_bounded_cleanup_in_refresh_token_sweep(self):
        src = (ROOT / "src/lib/session-tokens.ts").read_text(encoding="utf-8")
        m = re.search(r"export async function cleanupExpiredRefreshTokens[\s\S]*?DELETE FROM refresh_tokens", src)
        self.assertIsNotNone(m, "cleanupExpiredRefreshTokens not found")
        body = m.group(0)
        self.assertIn("DELETE FROM platform_session_security WHERE family_id IN (", body)
        self.assertIn("SELECT family_id FROM platform_session_security WHERE expires_at<=clock_timestamp()", body)
        self.assertIn("FOR UPDATE SKIP LOCKED", body)

    def test_go_agent_launch_tracked_serializes_with_shutdown_gate(self):
        ag = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        launch_m = re.search(r"func \(a \*Agent\) launchTracked\(fn func\(\)\) \{[\s\S]*?\n\}", ag)
        shutdown_m = re.search(r"func \(a \*Agent\) beginShutdown\(\) \{[\s\S]*?\n\}", ag)
        self.assertIsNotNone(launch_m)
        self.assertIsNotNone(shutdown_m)
        launch_body = launch_m.group(0)
        shutdown_body = shutdown_m.group(0)
        self.assertIn("a.shutdownGate.RLock()", launch_body)
        self.assertIn("case <-a.shutdownCh:", launch_body)
        self.assertLess(launch_body.index("a.runtimeWG.Add(1)"), launch_body.rindex("a.shutdownGate.RUnlock()"))
        self.assertIn("a.shutdownGate.Lock()", shutdown_body)
        self.assertIn("close(a.shutdownCh)", shutdown_body)

    def test_go_agent_usb_zpl_and_tspl_transport_support(self):
        ag = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        cap = (ROOT / "agent/internal/printer/capability.go").read_text(encoding="utf-8")
        self.assertIn('if connection == "usb" && (protocol == "raw" || protocol == "escpos" || protocol == "zpl" || protocol == "tspl") {', ag)
        self.assertIn('return protocol + "_usb"', ag)
        self.assertIn('if (family == "raw" || family == "escpos" || family == "zpl" || family == "tspl") && conn != "network" && conn != "usb"', cap)


if __name__ == "__main__":
    unittest.main()
