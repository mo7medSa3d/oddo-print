# -*- coding: utf-8 -*-
"""Cross-layer contract & seam cohesion verification tests.

Verifies wire-level invariants across:
  1. Gateway (src/lib/license-signer.ts) <-> Odoo (models/print_config.py) <-> Go Agent (internal/license/*.go)
  2. Agent heartbeat (agent.go) <-> Odoo (agent_api.py, printer.py, runtime_printers.py) <-> Desktop (types.ts, ipc.ts, printers.ts, printer-virtual.ts)
  3. Odoo <-> Agent HTTP & WebSocket job dispatch endpoints, auth headers, and job status enums
  4. All 8 JSON contract/fixture files in contracts/
"""

import base64
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LICENSE_SIGNER_TS = ROOT / "src" / "lib" / "license-signer.ts"
PRINT_CONFIG_PY = ROOT / "odoo_addons" / "print_gateway" / "models" / "print_config.py"
AGENT_LICENSE_GO = ROOT / "agent" / "internal" / "license" / "license.go"
AGENT_GUARD_GO = ROOT / "agent" / "internal" / "license" / "guard.go"

AGENT_GO = ROOT / "agent" / "internal" / "agent" / "agent.go"
PAIRING_GO = ROOT / "agent" / "internal" / "agent" / "pairing.go"
WS_CLIENT_GO = ROOT / "agent" / "internal" / "agent" / "ws_client.go"

AGENT_API_PY = ROOT / "odoo_addons" / "print_gateway" / "controllers" / "agent_api.py"
AGENT_WS_PY = ROOT / "odoo_addons" / "print_gateway" / "controllers" / "agent_ws.py"
RUNTIME_PRINTERS_PY = ROOT / "odoo_addons" / "print_gateway" / "controllers" / "runtime_printers.py"
PRINTER_MODEL_PY = ROOT / "odoo_addons" / "print_gateway" / "models" / "printer.py"
PRINT_JOB_PY = ROOT / "odoo_addons" / "print_gateway" / "models" / "print_job.py"

DESKTOP_TYPES_TS = ROOT / "src" / "desktop" / "types.ts"
DESKTOP_IPC_TS = ROOT / "src" / "desktop" / "lib" / "ipc.ts"
DESKTOP_PRINTERS_TS = ROOT / "src" / "desktop" / "lib" / "printers.ts"
PRINTER_VIRTUAL_TS = ROOT / "src" / "lib" / "printer-virtual.ts"

CONTRACTS_DIR = ROOT / "contracts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _extract_ts_ordered_keys(source: str, var_name: str) -> list[str]:
    match = re.search(rf"const\s+{var_name}\s*=\s*\{{(.*?)\}};", source, re.S)
    assert match is not None, f"Could not find {var_name} in license-signer.ts"
    return re.findall(r"^\s*([a-z0-9_]+)\s*:", match.group(1), re.M)


def _extract_go_struct_json_tags(source: str, struct_name: str) -> list[str]:
    match = re.search(rf"type\s+{struct_name}\s+struct\s*\{{(.*?)\}}", source, re.S)
    assert match is not None, f"Could not find struct {struct_name} in license.go"
    return re.findall(r'`json:"([a-z0-9_]+)(?:,omitempty)?"`', match.group(1))


class TestLicenseWireContract(unittest.TestCase):
    """Boundary 1: Gateway <-> Odoo <-> Go Agent Ed25519 license wire contract."""

    EXPECTED_V1_KEYS = [
        "expires_at",
        "grace_until",
        "issued_at",
        "license_id",
        "max_agents",
        "max_printers",
        "odoo_db_uuid",
        "plan",
        "tenant_id",
        "version",
    ]

    EXPECTED_V2_KEYS = [
        "expires_at",
        "features",
        "grace_until",
        "issued_at",
        "key_id",
        "license_id",
        "max_agents",
        "max_printers",
        "odoo_db_uuid",
        "plan",
        "rev",
        "status",
        "tenant_id",
        "version",
    ]

    def test_canonical_json_key_ordering_matches_across_node_go_python(self):
        ts_src = _read(LICENSE_SIGNER_TS)
        go_src = _read(AGENT_LICENSE_GO)
        py_src = _read(PRINT_CONFIG_PY)

        ts_v1 = _extract_ts_ordered_keys(ts_src, "orderedV1")
        ts_v2 = _extract_ts_ordered_keys(ts_src, "orderedV2")
        go_v1 = _extract_go_struct_json_tags(go_src, "canonicalClaims")
        go_v2 = _extract_go_struct_json_tags(go_src, "canonicalClaimsV2")

        self.assertEqual(ts_v1, self.EXPECTED_V1_KEYS)
        self.assertEqual(go_v1, self.EXPECTED_V1_KEYS)
        self.assertEqual(ts_v1, sorted(ts_v1), "Node v1 keys must be strictly alphabetical")
        self.assertEqual(go_v1, sorted(go_v1), "Go v1 keys must be strictly alphabetical")

        self.assertEqual(ts_v2, self.EXPECTED_V2_KEYS)
        self.assertEqual(go_v2, self.EXPECTED_V2_KEYS)
        self.assertEqual(ts_v2, sorted(ts_v2), "Node v2 keys must be strictly alphabetical")
        self.assertEqual(go_v2, sorted(go_v2), "Go v2 keys must be strictly alphabetical")

        # Python uses sort_keys=True, compact separators, ensure_ascii=False
        self.assertIn(
            'json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")',
            py_src,
        )
        # Go disables HTML escaping so serialized bytes match Node JSON.stringify & Python json.dumps
        self.assertIn("enc.SetEscapeHTML(false)", go_src)

    def test_signature_encoding_and_ed25519_parity(self):
        ts_src = _read(LICENSE_SIGNER_TS)
        py_src = _read(PRINT_CONFIG_PY)
        go_src = _read(AGENT_LICENSE_GO)

        # Node signs to unpadded base64url (64 bytes -> 86 chars)
        self.assertIn('.toString("base64url")', ts_src)
        self.assertIn("ED25519_SIGNATURE_B64URL_LEN = 86", ts_src)
        # Python pads and decodes via urlsafe_b64decode
        self.assertIn("base64.urlsafe_b64decode(padded_sig)", py_src)
        # Go decodes via RawURLEncoding after trimming optional '='
        self.assertIn('base64.RawURLEncoding.DecodeString(strings.TrimRight(b.Signature, "="))', go_src)

        # Live Ed25519 canonical signing + base64url round-trip verification
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        except ImportError:
            self.skipTest("cryptography package not installed")

        priv = Ed25519PrivateKey.generate()
        pub = priv.public_key()
        claims_v2 = {
            "version": 2,
            "license_id": "lic_tenant_1",
            "tenant_id": "tenant_1",
            "odoo_db_uuid": "11111111-2222-3333-4444-555555555555",
            "plan": "pro",
            "status": "active",
            "rev": 1763800000,
            "key_id": "k1",
            "max_agents": 5,
            "max_printers": 15,
            "features": ["direct_print", "ws_push"],
            "issued_at": "2026-11-22T00:00:00.000Z",
            "expires_at": "2026-12-22T00:00:00.000Z",
            "grace_until": "2026-12-29T00:00:00.000Z",
        }
        canonical = json.dumps(claims_v2, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        # Verify exact key order matches Node/Go structs
        parsed_keys = list(json.loads(canonical.decode("utf-8")).keys())
        self.assertEqual(parsed_keys, self.EXPECTED_V2_KEYS)

        sig_bytes = priv.sign(canonical)
        self.assertEqual(len(sig_bytes), 64)
        sig_b64url = base64.urlsafe_b64encode(sig_bytes).rstrip(b"=").decode("ascii")
        self.assertEqual(len(sig_b64url), 86)

        # Verify Python-style padding + urlsafe_b64decode succeeds
        padded = sig_b64url + "=" * (-len(sig_b64url) % 4)
        pub.verify(base64.urlsafe_b64decode(padded), canonical)

    def test_revocation_tombstone_semantics_across_layers(self):
        ts_src = _read(LICENSE_SIGNER_TS)
        py_src = _read(PRINT_CONFIG_PY)
        go_lic_src = _read(AGENT_LICENSE_GO)
        go_guard_src = _read(AGENT_GUARD_GO)

        # Gateway revokeLicenseBundle produces status="revoked", zero limits, empty features
        self.assertIn('status: "revoked"', ts_src)
        self.assertIn("max_agents: 0", ts_src)
        self.assertIn("max_printers: 0", ts_src)
        self.assertIn("features: []", ts_src)

        # Odoo accepts HTTP 403 revocation tombstones and stores them + fires pg_notify
        self.assertIn('reason == "license_revoked"', py_src)
        self.assertIn("if response.status_code not in (200, 403):", py_src)
        self.assertIn("pg_notify('print_gateway_license_updated'", py_src)

        # Go returns ErrLicenseRevoked with non-nil claims so guard records tombstone rev
        self.assertIn('strings.EqualFold(strings.TrimSpace(b.Payload.Status), "revoked")', go_lic_src)
        self.assertIn("return &b.Payload, false, ErrLicenseRevoked", go_lic_src)
        self.assertIn("if errors.Is(err, ErrLicenseRevoked) && claims != nil", go_guard_src)
        self.assertIn("if g.revoked && claims.Rev <= g.revokedRev", go_guard_src)


class TestVirtualPrinterAndCapabilityContract(unittest.TestCase):
    """Boundary 2: Agent heartbeat <-> Odoo <-> Desktop virtual printer & capability fields."""

    def test_agent_heartbeat_emits_required_virtual_and_capability_fields(self):
        agent_src = _read(AGENT_GO)
        for field in (
            '"sharedWithGateway":',
            '"id":',
            '"name":',
            '"printerType":',
            '"deviceClass":',
            '"connectionType":',
            '"protocol":',
            '"status":',
            '"isVirtual":',
            '"is_virtual":',
            '"capabilities"',
            'caps["geometry"]',
            'caps["is_virtual"] = true',
            '"privatePrinterIds":',
        ):
            self.assertIn(field, agent_src, f"Agent heartbeat missing {field}")

    def test_odoo_agent_api_parses_virtual_and_capability_fields(self):
        api_src = _read(AGENT_API_PY)
        for expr in (
            'p.get("isVirtual") is True',
            'p.get("is_virtual") is True',
            'p.get("connectionType")',
            'p.get("protocol")',
            'p.get("capabilities")',
            'caps.get("geometry") or p.get("geometry")',
            'caps["is_virtual"] = True',
            'p.get("deviceClass")',
            'data.get("privatePrinterIds")',
        ):
            self.assertIn(expr, api_src, f"Odoo agent_api.py missing {expr}")

    def test_odoo_printer_model_and_runtime_printers_expose_specs(self):
        printer_src = _read(PRINTER_MODEL_PY)
        runtime_src = _read(RUNTIME_PRINTERS_PY)

        for field in ("is_virtual", "paper_width_mm", "dots_per_line", "dpi", "recommended_protocol", "capability_summary"):
            self.assertIn(f'"{field}"', printer_src)

        for field in (
            "'id':",
            "'name':",
            "'status':",
            "'protocol':",
            "'connectionType':",
            "'deviceClass':",
            "'isVirtual':",
            "'paperWidthMm':",
            "'dotsPerLine':",
            "'dpi':",
            "'recommendedProtocol':",
            "'capabilitySummary':",
            "'availableToOdoo':",
            "'capabilities':",
        ):
            self.assertIn(field, runtime_src, f"runtime_printers.py missing {field}")

    def test_desktop_types_and_printers_consume_virtual_and_capability_fields(self):
        ipc_src = _read(DESKTOP_IPC_TS)
        printers_src = _read(DESKTOP_PRINTERS_TS)
        virtual_src = _read(PRINTER_VIRTUAL_TS)

        for field in ("isVirtual?: boolean;", "is_virtual?: boolean;", "connectionType?: string;", "protocol?: string;", "capabilities?: Record<string, unknown> | null;"):
            self.assertIn(field, ipc_src, f"PrinterInfo in ipc.ts missing {field}")

        self.assertIn("isVirtual: anyP.isVirtual === true", printers_src)
        self.assertIn("is_virtual: anyP.is_virtual === true", printers_src)
        self.assertIn("isVirtualPrinterMetadata", printers_src)
        self.assertIn("isUnusableVirtualPrinterRecord", printers_src)
        self.assertIn("printer.isVirtual === true || printer.is_virtual === true", virtual_src)


class TestOdooAgentDispatchContract(unittest.TestCase):
    """Boundary 3: Odoo <-> Agent HTTP & WebSocket job dispatch contract."""

    def test_http_and_ws_endpoints_match(self):
        api_src = _read(AGENT_API_PY)
        ws_py_src = _read(AGENT_WS_PY)
        agent_src = _read(AGENT_GO)
        pairing_src = _read(PAIRING_GO)
        ws_go_src = _read(WS_CLIENT_GO)

        # Register
        self.assertIn('"/api/agent/register"', pairing_src)
        self.assertIn('"/api/agent/register"', api_src)

        # Heartbeat
        self.assertIn('reqURL := "/api/agent/heartbeat"', agent_src)
        self.assertIn('"/api/agent/heartbeat"', api_src)

        # Jobs / Claim (Agent uses /api/agent/jobs; Odoo routes /print_gateway/agent/claim and /api/agent/jobs)
        self.assertIn('reqURL := "/api/agent/jobs"', agent_src)
        self.assertIn('"/api/agent/jobs"', api_src)
        self.assertIn('"/print_gateway/agent/claim"', api_src)

        # Ack
        self.assertIn('reqURL := "/api/agent/ack"', agent_src)
        self.assertIn('"/api/agent/ack"', api_src)

        # WebSocket
        self.assertIn('u.Path = "/api/agent/ws"', ws_go_src)
        self.assertIn('@http.route("/api/agent/ws"', ws_py_src)

    def test_authorization_header_format_matches(self):
        api_src = _read(AGENT_API_PY)
        agent_src = _read(AGENT_GO)
        ws_go_src = _read(WS_CLIENT_GO)

        self.assertIn('req.Header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))', agent_src)
        self.assertIn('token := fmt.Sprintf("%s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret)', agent_src)
        self.assertIn('reqBuf.WriteString("Authorization: Bearer " + token + "\\r\\n")', ws_go_src)
        self.assertIn('auth.startswith("Bearer ")', api_src)
        self.assertIn('agent_uid_part, sep, token = raw_cred.partition(":")', api_src)

    def test_ws_event_types_match_between_odoo_and_agent(self):
        ws_py_src = _read(AGENT_WS_PY)
        agent_src = _read(AGENT_GO)

        for ev in ("welcome", "license_update", "agent_revoked", "job_available"):
            self.assertIn(f'"type": "{ev}"', ws_py_src, f"Odoo WS missing event {ev}")
            self.assertIn(f'"{ev}"', agent_src, f"Go Agent WS handler missing event {ev}")

    def test_job_status_values_consistent_across_agent_and_odoo(self):
        api_src = _read(AGENT_API_PY)
        job_src = _read(PRINT_JOB_PY)
        agent_src = _read(AGENT_GO)

        # Odoo print_job.py status Selection
        for st in ("queued", "claimed", "printing", "success", "failed", "unknown", "canceled"):
            self.assertIn(f'("{st}",', job_src, f"print_job.py missing status {st}")

        # Odoo agent_api.py accepted ack statuses
        self.assertIn('status not in ("queued", "printing", "success", "failed", "unknown")', api_src)

        # Every status emitted by Agent updateJobStatus* calls must be accepted by Odoo agent_ack
        emitted = set(re.findall(r'updateJobStatus[^(]*\([^,]+,[^,]+,\s*"([a-z_]+)"', agent_src))
        # rejectJobExact emits "queued"
        emitted.add("queued")
        accepted_by_odoo = {"queued", "printing", "success", "failed", "unknown"}
        self.assertTrue(
            emitted.issubset(accepted_by_odoo),
            f"Agent emits statuses not accepted by Odoo agent_ack: {emitted - accepted_by_odoo}",
        )


class TestContractsDirectory(unittest.TestCase):
    """Boundary 4: All 8 JSON files in contracts/ parse cleanly and match core code invariants."""

    EXPECTED_FILES = [
        "gateway-console-contract.json",
        "print-payload-contract.json",
        "printer-geometry-contract.json",
        "printer-geometry-fixtures.json",
        "printer-operational-verification-contract.json",
        "printer-operational-verification-fixtures.json",
        "printer-presentation-contract.json",
        "printer-sharing-contract.json",
    ]

    def test_all_eight_contract_json_files_parse_cleanly(self):
        found = sorted(p.name for p in CONTRACTS_DIR.glob("*.json"))
        self.assertEqual(found, self.EXPECTED_FILES)
        for name in self.EXPECTED_FILES:
            data = json.loads(_read(CONTRACTS_DIR / name))
            self.assertIsInstance(data, dict, f"{name} root must be a JSON object")
            self.assertEqual(data.get("version"), 1, f"{name} must declare version=1")

    def test_print_payload_contract_matches_odoo_and_agent(self):
        contract = json.loads(_read(CONTRACTS_DIR / "print-payload-contract.json"))
        job_src = _read(PRINT_JOB_PY)
        api_src = _read(AGENT_API_PY)

        self.assertEqual(contract["maxPayloadBytes"], 5 * 1024 * 1024)
        self.assertIn("MAX_PRINT_CONTENT_BYTES = 5 * 1024 * 1024", job_src)
        self.assertEqual(contract["wireTypes"], ["raw", "escpos", "pdf", "image"])
        self.assertEqual(contract["rawProtocols"], ["raw", "escpos", "zpl", "tspl"])
        # Verify agent_api.py wire_type translation matches wireTypes
        self.assertIn('wire_type = "image"', api_src)
        self.assertIn('wire_type = "escpos" if proto == "escpos" else "raw"', api_src)

    def test_printer_geometry_contract_matches_code(self):
        contract = json.loads(_read(CONTRACTS_DIR / "printer-geometry-contract.json"))
        self.assertEqual(contract["location"], "capabilities.geometry")
        self.assertEqual(contract["desiredProfileLocation"], "config.geometry_profile")
        self.assertEqual(contract["imageFingerprintField"], "geometry_fingerprint")
        for field in ("printable_width_dots", "dpi_x", "paper_width_mm"):
            self.assertIn(field, contract["profileFields"])
            self.assertIn(field, _read(PRINTER_MODEL_PY))

    def test_printer_sharing_and_console_contracts_reference_existing_files(self):
        console = json.loads(_read(CONTRACTS_DIR / "gateway-console-contract.json"))
        for key in ("producer", "bridge", "consumer"):
            self.assertTrue((ROOT / console[key]).is_file(), f"Missing contract file: {console[key]}")

        presentation = json.loads(_read(CONTRACTS_DIR / "printer-presentation-contract.json"))
        self.assertTrue((ROOT / presentation["sharedConsumer"]).is_file())
        desktop_types_src = _read(DESKTOP_TYPES_TS)
        for flt in presentation["dashboardFilters"]:
            self.assertIn(f'"{flt}"', desktop_types_src)

        sharing = json.loads(_read(CONTRACTS_DIR / "printer-sharing-contract.json"))
        self.assertEqual(sharing["nativeMutation"]["command"], "set_printer_sharing")
        self.assertIn("privatePrinterIds", sharing["heartbeat"])


if __name__ == "__main__":
    unittest.main()
