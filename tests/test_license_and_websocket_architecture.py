"""Comprehensive zero-dependency regression tests for License-Only Gateway & Direct WebSocket."""
import ast
import importlib.util
import os
from pathlib import Path
import re
import struct
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
ODOO_WS_PATH = ROOT / "odoo_addons19" / "print_gateway" / "controllers" / "agent_ws.py"


def _load_agent_ws_module():
    spec = importlib.util.spec_from_file_location("print_gateway_agent_ws", ODOO_WS_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestLicenseOnlyGatewayBoundaries(unittest.TestCase):
    def test_legacy_printer_routes_and_operations_page_removed(self):
        self.assertFalse((ROOT / "src" / "app" / "api" / "printers").exists())
        self.assertFalse((ROOT / "src" / "app" / "platform" / "operations" / "page.tsx").exists())

    def test_license_refresh_and_verify_routes_exist_with_v2_signer(self):
        refresh_route = ROOT / "src" / "app" / "api" / "license" / "refresh" / "route.ts"
        verify_route = ROOT / "src" / "app" / "api" / "license" / "verify" / "route.ts"
        signer = (ROOT / "src" / "lib" / "license-signer.ts").read_text(encoding="utf-8")

        self.assertTrue(refresh_route.exists(), "Missing /api/license/refresh route")
        self.assertTrue(verify_route.exists(), "Missing /api/license/verify route")
        for token in ("LicenseClaimsV2", "status", "rev", "minRev", "license_revoked", "license_rollback"):
            self.assertIn(token, signer)

    def test_desktop_ipc_makes_zero_http_calls_to_deleted_gateway_printers(self):
        ipc_src = (ROOT / "src" / "desktop" / "lib" / "ipc.ts").read_text(encoding="utf-8")
        # Strip JS/TS block and line comments so explanatory comments don't trigger false positives.
        no_comments = re.sub(r"/\*[\s\S]*?\*/", "", ipc_src)
        no_comments = re.sub(r"//[^\n]*", "", no_comments)
        self.assertNotIn(
            "/api/printers",
            no_comments,
            "src/desktop/lib/ipc.ts must not make HTTP calls to deleted Gateway /api/printers",
        )


class TestNodeLicenseSignerExecution(unittest.TestCase):
    def test_node_executes_real_license_signer_v1_and_v2_suite(self):
        proc = subprocess.run(
            ["node", "--test", str(ROOT / "tests" / "license-signer.node.test.mjs")],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            proc.returncode,
            0,
            msg=f"Node license-signer tests failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )


class TestOdooWebSocketRFC6455(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = _load_agent_ws_module()

    def test_rfc6455_section_4_2_2_accept_vector(self):
        self.assertEqual(
            self.ws.compute_ws_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        )
        with self.assertRaises(ValueError):
            self.ws.compute_ws_accept("   ")

    def test_masked_and_unmasked_text_ping_pong_close_round_trips(self):
        mask = b"\x37\xfa\x21\x3d"
        cases = [
            (self.ws.OPCODE_TEXT, b'{"type":"job_available","pendingJobs":3}', None),
            (self.ws.OPCODE_TEXT, b'{"type":"heartbeat"}', mask),
            (self.ws.OPCODE_TEXT, b"A" * 500, mask),  # 16-bit extended length (126)
            (self.ws.OPCODE_TEXT, b"B" * 70000, None),  # 64-bit extended length (127)
            (self.ws.OPCODE_PING, b"ping-1", mask),
            (self.ws.OPCODE_PING, b"ping-2", None),
            (self.ws.OPCODE_PONG, b"pong-1", mask),
            (self.ws.OPCODE_PONG, b"pong-2", None),
            (self.ws.OPCODE_CLOSE, struct.pack("!H", 1000) + b"normal", mask),
            (self.ws.OPCODE_CLOSE, struct.pack("!H", 1001), None),
        ]
        for opcode, payload, mask_key in cases:
            frame = self.ws.encode_ws_frame(payload, opcode=opcode, fin=True, mask_key=mask_key)
            dec_opcode, dec_payload, dec_fin, consumed = self.ws.decode_ws_frame(frame)
            self.assertEqual(dec_opcode, opcode)
            self.assertEqual(dec_payload, payload)
            self.assertTrue(dec_fin)
            self.assertEqual(consumed, len(frame))

    def test_oversized_and_malformed_frames_are_rejected(self):
        # Frame exceeding custom max_bytes cap
        frame = self.ws.encode_ws_frame(b"x" * 256, opcode=self.ws.OPCODE_TEXT)
        with self.assertRaises(ValueError):
            self.ws.decode_ws_frame(frame, max_bytes=128)

        # Frame header declaring > 16 MiB payload must be rejected before reading payload
        oversized_len = self.ws.MAX_WS_FRAME_BYTES + 1
        oversized_header = struct.pack("!BBQ", 0x80 | self.ws.OPCODE_TEXT, 127, oversized_len)
        with self.assertRaises(ValueError):
            self.ws.decode_ws_frame(oversized_header)

        # Control frame > 125 bytes or fragmented must be rejected
        with self.assertRaises(ValueError):
            self.ws.encode_ws_frame(b"z" * 126, opcode=self.ws.OPCODE_PING)
        with self.assertRaises(ValueError):
            self.ws.encode_ws_frame(b"z", opcode=self.ws.OPCODE_PING, fin=False)

        # Non-zero RSV bit must be rejected
        bad_rsv = struct.pack("!BB", 0xC1, 0x00)
        with self.assertRaises(ValueError):
            self.ws.decode_ws_frame(bad_rsv)


class TestGoAgentAndOdooContracts(unittest.TestCase):
    def test_go_agent_runtime_license_guard_contract(self):
        license_go = (ROOT / "agent" / "internal" / "license" / "license.go").read_text(encoding="utf-8")
        guard_go = (ROOT / "agent" / "internal" / "license" / "guard.go").read_text(encoding="utf-8")

        self.assertIn("PinnedPublicKeyB64", license_go)
        self.assertIn("ErrLicenseRevoked", license_go)
        self.assertIn("ErrLicenseRollback", license_go)
        self.assertIn("ErrClockRollback", license_go)
        self.assertIn("type RuntimeGuard struct", guard_go)
        self.assertIn("func (g *RuntimeGuard) CheckPrintAllowed(", guard_go)
        self.assertIn("func (g *RuntimeGuard) ApplyBundle(", guard_go)

    def test_go_agent_rfc6455_websocket_client_contract(self):
        go_mod = (ROOT / "agent" / "go.mod").read_text(encoding="utf-8")
        self.assertNotIn("gorilla/websocket", go_mod)

        ws_client_path = ROOT / "agent" / "internal" / "agent" / "ws_client.go"
        self.assertTrue(ws_client_path.exists(), "Missing agent/internal/agent/ws_client.go")
        ws_client = ws_client_path.read_text(encoding="utf-8")
        for token in (
            "/api/agent/ws",
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
            "Sec-WebSocket-Key",
            "Sec-WebSocket-Accept",
        ):
            self.assertIn(token, ws_client)

    def test_odoo_ws_route_and_pg_notify_contract(self):
        ws_src = ODOO_WS_PATH.read_text(encoding="utf-8")
        self.assertIn("/api/agent/ws", ws_src)
        self.assertIn("LISTEN print_gateway_job_ready", ws_src)

        models_src = "\n".join(
            p.read_text(encoding="utf-8")
            for p in (ROOT / "odoo_addons19" / "print_gateway" / "models").glob("*.py")
        )
        self.assertTrue(
            "pg_notify('print_gateway_job_ready'" in models_src
            or 'pg_notify("print_gateway_job_ready"' in models_src,
            "Odoo models must emit pg_notify('print_gateway_job_ready', ...)",
        )

    def test_agent_ws_uses_shared_notification_hub_not_per_agent_listen(self):
        ws_src = ODOO_WS_PATH.read_text(encoding="utf-8")
        tree = ast.parse(ws_src, filename=str(ODOO_WS_PATH))

        classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
        functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}

        self.assertIn("_NotificationHub", classes, "agent_ws.py must define a shared _NotificationHub class")
        self.assertIn("_run_ws_loop", functions, "agent_ws.py must define _run_ws_loop")

        hub_src = ast.get_source_segment(ws_src, classes["_NotificationHub"]) or ""
        loop_node = functions["_run_ws_loop"]
        loop_src = ast.get_source_segment(ws_src, loop_node) or ""

        self.assertIn("LISTEN print_gateway_job_ready", hub_src)
        self.assertIn("LISTEN print_gateway_license_updated", hub_src)
        self.assertIn("_get_notification_hub", loop_src, "_run_ws_loop must subscribe via the shared hub")

        loop_strings = [
            node.value
            for node in ast.walk(loop_node)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        ]
        self.assertFalse(
            any("LISTEN " in s for s in loop_strings),
            "_run_ws_loop must not execute per-agent LISTEN statements",
        )

    def test_agent_makefile_fails_fast_without_license_public_key(self):
        clean_env = {k: v for k, v in os.environ.items() if k != "YASEIR_LICENSE_PUBLIC_KEY_B64"}

        for target in ("release", "linux"):
            proc = subprocess.run(
                ["make", "-C", str(ROOT / "agent"), target],
                cwd=str(ROOT),
                env=clean_env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(
                proc.returncode,
                0,
                msg=f"make {target} must fail when YASEIR_LICENSE_PUBLIC_KEY_B64 is unset",
            )
            self.assertIn(
                "YASEIR_LICENSE_PUBLIC_KEY_B64",
                proc.stderr + proc.stdout,
                msg=f"make {target} must emit a clear YASEIR_LICENSE_PUBLIC_KEY_B64 error message",
            )

        # Dev build-agent remains optional when the key is unset.
        dev_proc = subprocess.run(
            ["make", "-n", "-C", str(ROOT / "agent"), "build-agent"],
            cwd=str(ROOT),
            env=clean_env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            dev_proc.returncode,
            0,
            msg=f"Dev build-agent target should remain optional:\n{dev_proc.stdout}\n{dev_proc.stderr}",
        )



class TestStrictFailClosedLicenseEnforcement(unittest.TestCase):
    @staticmethod
    def _load_odoo_print_config_module():
        import sys
        import types

        module_path = ROOT / "odoo_addons19" / "print_gateway" / "models" / "print_config.py"
        fake_odoo = types.ModuleType("odoo")
        fake_api = types.ModuleType("odoo.api")
        fake_api.model = lambda fn: fn
        fake_api.model_create_multi = lambda fn: fn
        fake_api.private = lambda fn: fn
        fake_api.constrains = lambda *args, **kwargs: (lambda fn: fn)

        class _FieldStub:
            def __init__(self, *args, **kwargs):
                pass

        fake_fields = types.ModuleType("odoo.fields")
        fake_fields.Many2one = _FieldStub
        fake_fields.Boolean = _FieldStub
        fake_fields.Char = _FieldStub
        fake_fields.Text = _FieldStub
        fake_fields.Integer = _FieldStub
        fake_fields.Datetime = _FieldStub

        fake_models = types.ModuleType("odoo.models")
        fake_models.Model = object
        fake_models.TransientModel = object
        fake_models.Constraint = lambda *args, **kwargs: None

        fake_exceptions = types.ModuleType("odoo.exceptions")
        fake_exceptions.AccessError = type("AccessError", (Exception,), {})
        fake_exceptions.ValidationError = type("ValidationError", (Exception,), {})
        fake_exceptions.UserError = type("UserError", (Exception,), {})

        fake_odoo.api = fake_api
        fake_odoo.fields = fake_fields
        fake_odoo.models = fake_models
        fake_odoo._ = lambda s: s

        injected = {
            "odoo": fake_odoo,
            "odoo.api": fake_api,
            "odoo.fields": fake_fields,
            "odoo.models": fake_models,
            "odoo.exceptions": fake_exceptions,
        }
        saved = {k: sys.modules.get(k) for k in injected}
        sys.modules.update(injected)
        try:
            spec = importlib.util.spec_from_file_location("print_gateway_print_config_test", module_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
        finally:
            for k, orig in saved.items():
                if orig is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = orig

    def test_odoo_verify_stored_license_bundle_fails_closed(self):
        import builtins
        import json
        from unittest import mock

        mod = self._load_odoo_print_config_module()

        class _FakeICP:
            def __init__(self, values):
                self._values = dict(values)

            def get_param(self, key, default=False):
                return self._values.get(key, default)

        # 1. Missing stored bundle -> fail closed
        ok, reason, bundle = mod.verify_stored_license_bundle(_FakeICP({"database.uuid": "db-1"}))
        self.assertFalse(ok)
        self.assertEqual(reason, "license_required")
        self.assertIsNone(bundle)

        sample_bundle = json.dumps({
            "payload": {
                "version": 2,
                "license_id": "lic_1",
                "tenant_id": "ten_1",
                "odoo_db_uuid": "db-1",
                "plan": "pro",
                "status": "active",
                "rev": 1,
                "key_id": "k1",
                "max_agents": 5,
                "max_printers": 15,
                "features": ["direct_print"],
                "issued_at": "2026-11-01T00:00:00Z",
                "expires_at": "2026-12-01T00:00:00Z",
                "grace_until": "2026-12-08T00:00:00Z",
            },
            "signature": "AAAA",
        })

        # 2. Missing public key -> fail closed. A build-time pinned key is
        # always configured, so the forged signature is rejected instead.
        with mock.patch.dict(os.environ, {"YASEIR_LICENSE_PUBLIC_KEY_B64": ""}, clear=False):
            ok, reason, _ = mod.verify_stored_license_bundle(
                _FakeICP({
                    "database.uuid": "db-1",
                    "print_gateway.signed_license_bundle": sample_bundle,
                    "print_gateway.license_public_key_b64": "",
                })
            )
        self.assertFalse(ok)
        expected_reason = (
            "invalid_signature"
            if getattr(mod, "PINNED_LICENSE_PUBLIC_KEY_B64", "").strip()
            else "public_key_not_configured"
        )
        self.assertEqual(reason, expected_reason)

        # 3. Missing cryptography library -> fail closed
        real_import = builtins.__import__

        def _block_cryptography(name, *args, **kwargs):
            if name == "cryptography" or name.startswith("cryptography."):
                raise ImportError("simulated missing cryptography")
            return real_import(name, *args, **kwargs)

        with mock.patch.object(builtins, "__import__", side_effect=_block_cryptography):
            ok, reason, _ = mod.verify_stored_license_bundle(
                _FakeICP({
                    "database.uuid": "db-1",
                    "print_gateway.signed_license_bundle": sample_bundle,
                    "print_gateway.license_public_key_b64": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                })
            )
        self.assertFalse(ok)
        self.assertEqual(reason, "cryptography_required")

    def test_go_agent_check_print_allowed_fails_closed_when_nil_or_unconfigured(self):
        guard_go = (ROOT / "agent" / "internal" / "license" / "guard.go").read_text(encoding="utf-8")
        match = re.search(
            r"func \(g \*RuntimeGuard\) CheckPrintAllowed\([^)]*\)\s*error\s*\{(?P<body>.*?)\n\}",
            guard_go,
            re.S,
        )
        self.assertIsNotNone(match, "CheckPrintAllowed must exist in agent/internal/license/guard.go")
        body = match.group("body")

        nil_match = re.search(r"if g == nil \{(?P<blk>.*?)\n\t\}", body, re.S)
        self.assertIsNotNone(nil_match, "CheckPrintAllowed must handle g == nil")
        self.assertIn("return ErrLicenseRequired", nil_match.group("blk"))

        key_match = re.search(r"if len\(g\.pubKey\) != ed25519\.PublicKeySize \{(?P<blk>.*?)\n\t\}", body, re.S)
        self.assertIsNotNone(key_match, "CheckPrintAllowed must handle unconfigured public key")
        self.assertIn("return ErrPublicKeyMissing", key_match.group("blk"))

    def test_gateway_refresh_and_verify_routes_fail_closed(self):
        refresh_src = (ROOT / "src" / "app" / "api" / "license" / "refresh" / "route.ts").read_text(encoding="utf-8")
        verify_src = (ROOT / "src" / "app" / "api" / "license" / "verify" / "route.ts").read_text(encoding="utf-8")

        # /api/license/refresh fail-closed checks
        self.assertIn('runtimeSecret("LICENSE_SIGNING_PRIVATE_KEY_PEM")', refresh_src)
        self.assertIn("createPrivateKey(privateKeyPem)", refresh_src)
        self.assertIn('asymmetricKeyType !== "ed25519"', refresh_src)
        self.assertIn("status: 503", refresh_src)
        self.assertIn("refreshSecret.length >= 32", refresh_src)
        self.assertIn("odooDbUuid is required", refresh_src)
        self.assertIn('status: "revoked"', refresh_src)
        self.assertIn("buildRevocationTombstone", refresh_src)
        self.assertIn("Subscription expired", refresh_src)

        # /api/license/verify fail-closed checks
        self.assertIn('runtimeSecret("LICENSE_SIGNING_PUBLIC_KEY_PEM")', verify_src)
        self.assertIn("createPublicKey(explicitPub)", verify_src)
        self.assertIn('asymmetricKeyType !== "ed25519"', verify_src)
        self.assertIn("status: 503", verify_src)
        self.assertIn("refreshSecret.length >= 32", verify_src)
        self.assertIn("tenant_mismatch", verify_src)
        self.assertIn("verifyLicenseBundle", verify_src)
        self.assertIn("minRev", verify_src)
        self.assertIn("expectedDbUuid", verify_src)

if __name__ == "__main__":
    unittest.main()
