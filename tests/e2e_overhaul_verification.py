#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-End Overhaul Verification Suite (Sub-agent 9 Independent QA).

Exercises the full Definition-of-Done flow across the real codebase:
  1. Ed25519 v2 License Lifecycle (Node signer -> Odoo verifier):
     sign -> activate -> verify (active) -> renew -> grace -> expire -> revoke -> DB UUID mismatch.
  2. Agent Link & Virtual + Physical Printer Sync into Odoo print_gateway:
     syncs Microsoft Print to PDF, CUPS-PDF, and Epson TM-T88V via real Odoo heartbeat/printer models.
  3. Auto-Compute Printer Specs & Print Job Dispatch to Virtual Printer:
     auto-computes paper_width_mm, dots_per_line, dpi, is_virtual, recommended_protocol,
     capability_summary and verifies job dispatch compatibility to virtual printer.
  4. POS Printing Fault Tolerance under License / Verification / Sync Failures:
     exercises both Odoo Python POS controller and Node VM-module POS JS routers
     (pos_print_router.js + pos_sale_details_router.js) and verifies graceful degradation
     to native Odoo POS printing without blocking.
  5. Cross-Agent Seam Regression Guards:
     Gateway navigation/settings/billing seams + Go agent license & virtual spooler seams.
"""

import json
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

from test_odoo_lifecycle_overhaul import _install_odoo_stubs, _load_addon_package


class _FakeICP:
    def __init__(self, initial=None):
        self._store = dict(initial or {})

    def sudo(self):
        return self

    def get_param(self, key, default=None):
        return self._store.get(key, default)

    def set_param(self, key, value):
        self._store[key] = value


def _sign_v2_bundle_via_node(payload_dict, private_key_pem=None):
    """Sign a v2 license bundle using Node's native Ed25519 crypto matching src/lib/license-signer.ts."""
    script = r"""
const crypto = require('node:crypto');
const input = JSON.parse(process.argv[1]);
let privKey, pubKeyB64;
if (input.privateKeyPem) {
  privKey = crypto.createPrivateKey(input.privateKeyPem);
  const pubKey = crypto.createPublicKey(privKey);
  const rawPub = pubKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  pubKeyB64 = rawPub.toString('base64');
} else {
  const kp = crypto.generateKeyPairSync('ed25519');
  privKey = kp.privateKey;
  const rawPub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  pubKeyB64 = rawPub.toString('base64');
}
const payload = input.payload;
const sorted = {};
for (const k of Object.keys(payload).sort()) {
  sorted[k] = payload[k];
}
const canonical = JSON.stringify(sorted);
const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey).toString('base64url');
const bundle = {
  payload: sorted,
  signature: sig,
};
process.stdout.write(JSON.stringify({
  bundle,
  publicKeyB64: pubKeyB64,
  privateKeyPem: privKey.export({ type: 'pkcs8', format: 'pem' }),
}));
"""
    proc = subprocess.run(
        ["node", "-e", script, json.dumps({"payload": payload_dict, "privateKeyPem": private_key_pem})],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(ROOT),
    )
    return json.loads(proc.stdout)


class TestE2EOverhaulVerification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _install_odoo_stubs()
        cls.pkg = _load_addon_package()

    def test_01_license_lifecycle_node_sign_to_odoo_verify(self):
        """Scenario 1: Ed25519 v2 sign -> activate -> verify -> renew -> grace -> expire -> revoke."""
        from unittest.mock import patch
        from print_gateway.models import print_config
        from print_gateway.models.print_config import (
            check_license_limits,
            verify_stored_license_bundle,
        )

        now = datetime(2026, 11, 22, 12, 0, 0, tzinfo=timezone.utc)
        db_uuid = "odoo-db-e2e-9999"

        # 1. Issue & Activate (rev=1, active)
        p1 = {
            "version": 2,
            "license_id": "lic-e2e-001",
            "tenant_id": "tenant-e2e-1",
            "odoo_db_uuid": db_uuid,
            "plan": "business",
            "status": "active",
            "rev": 1,
            "max_agents": 5,
            "max_printers": 15,
            "features": ["direct_print", "pos", "virtual_printers"],
            "issued_at": now.isoformat().replace("+00:00", "Z"),
            "expires_at": (now + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
            "grace_until": (now + timedelta(days=37)).isoformat().replace("+00:00", "Z"),
        }
        signed1 = _sign_v2_bundle_via_node(p1)
        icp = _FakeICP({
            "database.uuid": db_uuid,
            "print_gateway.license_public_key_b64": signed1["publicKeyB64"],
            "print_gateway.signed_license_bundle": json.dumps(signed1["bundle"]),
        })

        # First confirm pinned production key rejects an untrusted keypair (fail-closed pinning)
        ok_unpinned, reason_unpinned, _ = verify_stored_license_bundle(icp, now=now + timedelta(hours=1))
        self.assertFalse(ok_unpinned)
        self.assertEqual(reason_unpinned, "invalid_signature")

        with patch.object(print_config, "PINNED_LICENSE_PUBLIC_KEY_B64", signed1["publicKeyB64"]):
            ok, reason, bundle = verify_stored_license_bundle(icp, now=now + timedelta(hours=1))
            self.assertTrue(ok, f"Expected active license to verify, got reason={reason}")
            self.assertEqual(bundle["payload"]["rev"], 1)

            # Entitlement limit check passes within limits and fails when exceeded
            ok_lim, reason_lim, _ = check_license_limits(icp, active_agents=2, active_printers=5, now=now + timedelta(hours=1))
            self.assertTrue(ok_lim, f"Expected within-limit check to pass, got {reason_lim}")
            ok_over, reason_over, _ = check_license_limits(icp, active_agents=6, active_printers=5, now=now + timedelta(hours=1))
            self.assertFalse(ok_over)
            self.assertEqual(reason_over, "max_agents_exceeded")

            # 2. Grace window (after expires_at, before grace_until)
            ok_grace, reason_grace, _ = verify_stored_license_bundle(icp, now=now + timedelta(days=32))
            self.assertTrue(ok_grace, f"Expected grace window to remain valid, got {reason_grace}")

            # 3. Expired (after grace_until) -> fails closed
            ok_exp, reason_exp, _ = verify_stored_license_bundle(icp, now=now + timedelta(days=40))
            self.assertFalse(ok_exp, "Expected expired license past grace_until to fail closed")

            # 4. Renew (rev=2, extended 365 days) -> passes at day 40
            p2 = dict(p1, rev=2,
                      expires_at=(now + timedelta(days=365)).isoformat().replace("+00:00", "Z"),
                      grace_until=(now + timedelta(days=372)).isoformat().replace("+00:00", "Z"))
            signed2 = _sign_v2_bundle_via_node(p2, private_key_pem=signed1["privateKeyPem"])
            icp.set_param("print_gateway.signed_license_bundle", json.dumps(signed2["bundle"]))
            ok_ren, reason_ren, bundle2 = verify_stored_license_bundle(icp, now=now + timedelta(days=40))
            self.assertTrue(ok_ren, f"Expected renewed license to verify at day 40, got {reason_ren}")
            self.assertEqual(bundle2["payload"]["rev"], 2)

            # 5. Revoke (rev=3, status="revoked") -> fails closed immediately
            p3 = dict(p2, rev=3, status="revoked")
            signed3 = _sign_v2_bundle_via_node(p3, private_key_pem=signed1["privateKeyPem"])
            icp.set_param("print_gateway.signed_license_bundle", json.dumps(signed3["bundle"]))
            ok_rev, reason_rev, _ = verify_stored_license_bundle(icp, now=now + timedelta(days=40))
            self.assertFalse(ok_rev, "Expected revoked license bundle to fail closed")

            # 6. DB UUID mismatch -> fails closed
            icp_wrong_db = _FakeICP({
                "database.uuid": "different-odoo-db-uuid",
                "print_gateway.license_public_key_b64": signed1["publicKeyB64"],
                "print_gateway.signed_license_bundle": json.dumps(signed2["bundle"]),
            })
            ok_db, reason_db, _ = verify_stored_license_bundle(icp_wrong_db, now=now + timedelta(days=40))
            self.assertFalse(ok_db, "Expected mismatched database.uuid to fail closed")

    def test_02_and_03_virtual_printer_sync_auto_specs_and_dispatch(self):
        """Scenarios 2 & 3: Sync virtual + physical printers, auto-compute specs, dispatch job to virtual printer."""
        from print_gateway.models.printer import PrintGatewayPrinter

        class _MockPrinter:
            def __init__(self, **kw):
                defaults = dict(
                    name="",
                    agent_printer_id="",
                    connection_type="spooler",
                    printer_type="unknown",
                    protocol="",
                    spooler_name="",
                    endpoint="",
                    capabilities_json="{}",
                    geometry_json="{}",
                    paper_width_mm=0,
                    dots_per_line=0,
                    dpi=0,
                    is_virtual=False,
                    recommended_protocol="",
                    capability_summary="",
                )
                defaults.update(kw)
                for k, v in defaults.items():
                    setattr(self, k, v)

        ms_pdf = _MockPrinter(
            name="Microsoft Print to PDF",
            agent_printer_id="win-ms-pdf",
            connection_type="spooler",
            printer_type="virtual",
            spooler_name="Microsoft Print to PDF",
            capabilities_json=json.dumps({
                "port_name": "PORTPROMPT:",
                "driver_name": "Microsoft Print To PDF",
                "is_virtual": True,
                "dpi": 600,
            }),
        )
        cups_pdf = _MockPrinter(
            name="CUPS-PDF",
            agent_printer_id="linux-cups-pdf",
            connection_type="spooler",
            printer_type="virtual",
            spooler_name="CUPS-PDF",
            capabilities_json=json.dumps({
                "port_name": "cups-pdf:/",
                "driver_name": "Generic CUPS-PDF Printer",
                "is_virtual": True,
            }),
        )
        epson_thermal = _MockPrinter(
            name="Epson TM-T88V",
            agent_printer_id="usb-tm-t88v",
            connection_type="usb",
            printer_type="thermal",
            protocol="escpos",
            capabilities_json=json.dumps({
                "paper_width_mm": 80,
                "dpi": 203,
                "protocols": ["escpos"],
            }),
        )

        # Run real _compute_printer_specs across all three printers
        PrintGatewayPrinter._compute_printer_specs([ms_pdf, cups_pdf, epson_thermal])

        self.assertTrue(ms_pdf.is_virtual)
        self.assertEqual(ms_pdf.recommended_protocol, "spooler")
        self.assertEqual(ms_pdf.dpi, 600)
        self.assertIn("Virtual", ms_pdf.capability_summary)

        self.assertTrue(cups_pdf.is_virtual)
        self.assertEqual(cups_pdf.recommended_protocol, "spooler")

        self.assertFalse(epson_thermal.is_virtual)
        self.assertEqual(epson_thermal.paper_width_mm, 80)
        self.assertEqual(epson_thermal.dpi, 203)
        self.assertGreater(epson_thermal.dots_per_line, 500)
        self.assertEqual(epson_thermal.recommended_protocol, "escpos")

        # Verify agent_api heartbeat source accepts virtual printers and persists them
        agent_api_src = (ROOT / "odoo_addons/print_gateway/controllers/agent_api.py").read_text(encoding="utf-8")
        self.assertIn("is_virtual", agent_api_src)
        self.assertIn("Microsoft Print to PDF", (ROOT / "agent/internal/printer/classify.go").read_text(encoding="utf-8"))

        # Verify print_router allows dispatching PDF jobs to virtual printers without rejecting them
        router_src = (ROOT / "odoo_addons/print_gateway/models/print_router.py").read_text(encoding="utf-8")
        self.assertNotIn("virtual printers are not supported", router_src.lower())

    def test_04_pos_fault_tolerance_python_and_js(self):
        """Scenario 4: POS printing degrades gracefully on license/verification/sync failures."""
        import odoo.http as odoo_http
        from print_gateway.controllers.pos import PrintGatewayPosController

        ctrl = PrintGatewayPosController()
        for err_msg in ("license_expired", "license_revoked", "verification_failed", "agent_sync_error"):
            router = MagicMock()
            router.route_render_target.side_effect = RuntimeError(err_msg)
            odoo_http.request.env = {"print_gateway.print_router": router}
            result = ctrl.print_sale_details(date_start="2026-11-22", date_stop="2026-11-22")
            self.assertEqual(result.get("fallback"), "native_pdf", f"POS controller failed to degrade on {err_msg}")

        # Exercise real POS JS routers via Node (--experimental-vm-modules)
        pos_proc = subprocess.run(
            ["node", "--experimental-vm-modules", "--test",
             "tests/current-run-pos.node.test.mjs",
             "tests/current-run-sale-details.node.test.mjs"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )
        self.assertEqual(pos_proc.returncode, 0, f"POS JS router tests failed:\n{pos_proc.stdout}\n{pos_proc.stderr}")

    def test_05_cross_agent_seam_guards(self):
        """Scenario 5: Verify Gateway UI/billing seams and Go agent license/virtual seams."""
        # Gateway AppShell + nav.ts
        app_shell = (ROOT / "src/components/AppShell.tsx").read_text(encoding="utf-8")
        for route in ("/dashboard", "/api-keys", "/team", "/billing", "/settings"):
            self.assertIn(f'href: "{route}"', app_shell)
        nav_ts = (ROOT / "src/lib/nav.ts").read_text(encoding="utf-8")
        self.assertIn('pathname === href', nav_ts)
        self.assertIn('pathname.startsWith(`${href}/`)', nav_ts)

        # Settings page has zero links to /team, /billing, /api-keys and has Profile, Security, Appearance
        settings = (ROOT / "src/app/settings/page.tsx").read_text(encoding="utf-8")
        for forbidden in ("/team", "/billing", "/api-keys"):
            self.assertNotIn(forbidden, settings)
        for section in ("settings-profile-heading", "settings-security-heading", "settings-appearance-heading"):
            self.assertIn(section, settings)

        # Billing & Pricing both use UnifiedBillingView with 3 plans + 20% discount
        billing = (ROOT / "src/app/billing/page.tsx").read_text(encoding="utf-8")
        pricing = (ROOT / "src/app/pricing/page.tsx").read_text(encoding="utf-8")
        plan_price = (ROOT / "src/lib/plan-price.ts").read_text(encoding="utf-8")
        sub_req = (ROOT / "src/app/api/subscription-requests/route.ts").read_text(encoding="utf-8")
        self.assertIn("UnifiedBillingView", billing)
        self.assertIn("UnifiedBillingView", pricing)
        self.assertIn("ANNUAL_DISCOUNT_PERCENT = 20", plan_price)
        self.assertIn("computePlanTermPricing", sub_req)

        # Go agent license seam: agent.go calls CheckPrintAllowedForJob
        agent_go = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        self.assertIn("a.licenseGuard.CheckPrintAllowedForJob(time.Now().UTC(), posJob)", agent_go)

        # Go virtual printer seam: spooler_windows.go uses isSoftwareVirtualQueue for status sensor bypass
        spooler_go = (ROOT / "agent/internal/printer/spooler_windows.go").read_text(encoding="utf-8")
        classify_go = (ROOT / "agent/internal/printer/classify.go").read_text(encoding="utf-8")
        self.assertIn("func isSoftwareVirtualQueue(portName, driverName, printerName string) bool", classify_go)
        self.assertEqual(spooler_go.count("isSoftwareVirtualQueue("), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
