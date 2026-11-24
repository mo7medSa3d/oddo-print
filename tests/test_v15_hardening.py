"""Regression & contract tests for Odoo Print System v15 security, hardware, and CI/Docker invariants."""
import ast
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


class TestV15Hardening(unittest.TestCase):
    def test_license_api_key_field_restricted_to_base_group_system(self):
        path = ROOT / "odoo_addons19/print_gateway/models/print_config.py"
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        found_groups = None
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if any(isinstance(t, ast.Name) and t.id == "license_api_key" for t in node.targets):
                if isinstance(node.value, ast.Call):
                    for kw in node.value.keywords:
                        if kw.arg == "groups" and isinstance(kw.value, ast.Constant):
                            found_groups = kw.value.value
        self.assertEqual(
            found_groups,
            "base.group_system",
            "license_api_key must declare groups='base.group_system' to prevent non-admin disclosure",
        )

    def test_agent_ws_revoked_sends_event_and_closes_socket(self):
        ws_src = (ROOT / "odoo_addons19/print_gateway/controllers/agent_ws.py").read_text(encoding="utf-8")
        # Heartbeat revocation path must notify and actively close the WebSocket
        self.assertRegex(
            ws_src,
            r'if not still_active:\s*'
            r'_send_json\(ws,\s*\{"type":\s*"agent_revoked",\s*"reason":\s*"agent_inactive_or_revoked"\},\s*send_lock=send_lock\)\s*'
            r'try:\s*(?:if send_lock is not None:\s*with send_lock:\s*)?ws\.close\(\)',
        )
        # All 3 lifecycle checkpoints (heartbeat, welcome, license_update listener) must emit agent_revoked
        revoked_hits = re.findall(r'"type":\s*"agent_revoked"', ws_src)
        self.assertGreaterEqual(len(revoked_hits), 3)

    def test_license_verify_route_rejects_unbound_odoo_db(self):
        src = (ROOT / "src/app/api/license/verify/route.ts").read_text(encoding="utf-8")
        self.assertIn('const bindingId = "db_" + crypto.createHash("sha256")', src)
        self.assertIn("if (binding && !binding.enabled)", src)
        self.assertRegex(
            src,
            r'valid:\s*false,\s*revoked:\s*true,\s*inGrace:\s*false,\s*reason:\s*"odoo_db_unbound"',
        )

    def test_buzzer_epson_bytes_and_wiring_distinct_from_drawer_kick(self):
        per_src = (ROOT / "agent/internal/printer/peripherals.go").read_text(encoding="utf-8")
        self.assertIn("BuzzerEpson = []byte{0x1B, 0x42, 0x02, 0x02}", per_src)
        self.assertIn("DrawerKickPin2 = []byte{0x1B, 0x70, 0x00, 0x19, 0xFA}", per_src)
        self.assertRegex(per_src, r'case\s+"epson_pulse":\s*buf\.Write\(BuzzerEpson\)')

        bind_src = (ROOT / "odoo_addons19/print_gateway/models/binding.py").read_text(encoding="utf-8")
        self.assertIn("0x1B 0x42 0x02 0x02", bind_src)

    def test_kind_image_peripheral_wiring_in_odoo_and_go_agent(self):
        # Odoo side: allow peripherals on ESC/POS image jobs
        router_src = (ROOT / "odoo_addons19/print_gateway/models/print_router.py").read_text(encoding="utf-8")
        self.assertIn('(ptype == "image" and getattr(binding, "printer_protocol", "") == "escpos")', router_src)
        self.assertIn('payload["peripherals"] = periph', router_src)

        # Go Agent side: do not corrupt raw JPEG before decode; defer cutter/buzzer to raster stage
        ag_src = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        self.assertRegex(
            ag_src,
            r'if kind != printer\.KindImage \{\s*printData = printer\.WrapPeripheralCommands\(printData, pl\.Protocol, profile\)',
        )
        self.assertIn('if hasActivePeripherals && kind == printer.KindImage && effectiveProtocol == "escpos"', ag_src)
        self.assertRegex(
            ag_src,
            r'DrawerKickMode:\s*"none",\s*CutterMode:\s*pl\.Peripherals\.Cutter,\s*BuzzerMode:\s*pl\.Peripherals\.Buzzer',
        )
        self.assertIn("document.Peripherals = &imgPeriph", ag_src)

        ras_src = (ROOT / "agent/internal/printer/raster_document.go").read_text(encoding="utf-8")
        self.assertIn("if doc.Peripherals != nil {", ras_src)
        self.assertIn("WrapPeripheralCommands(raster, protocol, *doc.Peripherals)", ras_src)

    def test_pdf_receipt_paginate_uses_2mm_width_tolerance(self):
        pdf_src = (ROOT / "agent/internal/printer/pdf_receipt.go").read_text(encoding="utf-8")
        self.assertIn("tolDots := math.Max(2.0, float64(dpiX)*2.0/25.4)", pdf_src)
        self.assertIn("if p.crop.Width*float64(dpiX)/72*scale > float64(printableW)+tolDots {", pdf_src)

    def test_ci_workflows_and_docker_compose_supply_chain_hardening(self):
        workflows = sorted((ROOT / ".github/workflows").glob("*.yml"))
        self.assertGreaterEqual(len(workflows), 6)
        sha_pin = re.compile(r"@[0-9a-f]{40}\b")
        for wf in workflows:
            data = yaml.safe_load(wf.read_text(encoding="utf-8"))
            self.assertIsInstance(
                data.get("permissions"),
                dict,
                f"{wf.name} must define top-level minimal permissions",
            )
            for job_name, job in (data.get("jobs") or {}).items():
                if not isinstance(job, dict) or "uses" in job:
                    continue
                self.assertIn(
                    "timeout-minutes",
                    job,
                    f"{wf.name}:{job_name} missing timeout-minutes",
                )
                for step in job.get("steps") or []:
                    uses = step.get("uses")
                    if uses and not uses.startswith(("./", "docker://")):
                        self.assertRegex(
                            uses,
                            sha_pin,
                            f"{wf.name}:{job_name} uses unpinned action {uses}",
                        )

        compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
        for svc in ("database_roles", "migrate", "database_verify", "gateway", "caddy"):
            cfg = compose["services"][svc]
            self.assertIn("ALL", cfg.get("cap_drop", []), f"docker-compose.yml:{svc} missing cap_drop: ALL")
            self.assertIn(
                "no-new-privileges:true",
                cfg.get("security_opt", []),
                f"docker-compose.yml:{svc} missing no-new-privileges:true",
            )


if __name__ == "__main__":
    unittest.main()
