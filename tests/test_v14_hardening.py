"""Regression & contract tests for Odoo Print System v14 hardening and hardware fixes."""
import py_compile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestV14Hardening(unittest.TestCase):
    def test_all_odoo_python_files_compile_cleanly(self):
        py_files = list((ROOT / "odoo_addons" / "print_gateway").rglob("*.py"))
        self.assertGreater(len(py_files), 15)
        for path in py_files:
            py_compile.compile(str(path), doraise=True)

    def test_all_odoo_xml_files_parse_cleanly(self):
        xml_files = list((ROOT / "odoo_addons" / "print_gateway").rglob("*.xml"))
        self.assertGreater(len(xml_files), 3)
        for path in xml_files:
            ET.parse(str(path))

    def test_phase1_go_agent_counts_only_shared_printers(self):
        src = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        self.assertIn("func (a *Agent) sharedPrinterCount() int", src)
        self.assertIn("a.isPrinterAvailableToOdoo(id)", src)
        self.assertIn("if activePrinters := a.sharedPrinterCount(); activePrinters > 0 {", src)
        self.assertNotIn("if activePrinters := a.printerCount(); activePrinters > 0 {", src)

    def test_phase1_odoo_heartbeat_preserves_unshared_and_removes_random_disable(self):
        src = (ROOT / "odoo_addons/print_gateway/controllers/agent_api.py").read_text(encoding="utf-8")
        self.assertIn("pg_advisory_xact_lock(hashtext('print_gateway_printer_limit'))", src)
        self.assertIn("WHEN EXCLUDED.available_to_odoo = FALSE THEN FALSE", src)
        self.assertIn("ELSE print_gateway_printer.available_to_odoo", src)
        self.assertNotIn("ORDER BY id DESC", src)
        self.assertIn('"disabledPrinterIds": disabled_printer_ids', src)

    def test_phase1_odoo_printer_model_enforces_max_printers_on_write(self):
        src = (ROOT / "odoo_addons/print_gateway/models/printer.py").read_text(encoding="utf-8")
        self.assertIn("def write(self, vals):", src)
        self.assertIn("pg_advisory_xact_lock(hashtext('print_gateway_printer_limit'))", src)
        self.assertIn("check_license_limits(icp, active_printers=projected)", src)

    def test_phase2_agent_lifecycle_locks_and_ws_revoke(self):
        api_src = (ROOT / "odoo_addons/print_gateway/controllers/agent_api.py").read_text(encoding="utf-8")
        self.assertIn("pg_advisory_xact_lock(hashtext('print_gateway_agent_limit'))", api_src)

        agent_src = (ROOT / "odoo_addons/print_gateway/models/agent.py").read_text(encoding="utf-8")
        self.assertIn("def write(self, vals):", agent_src)
        self.assertIn("def action_revoke_disconnect(self):", agent_src)
        self.assertIn("NOTIFY print_gateway_license_updated", agent_src)

        view_src = (ROOT / "odoo_addons/print_gateway/views/agent_views.xml").read_text(encoding="utf-8")
        self.assertIn('name="action_revoke_disconnect"', view_src)

        ws_src = (ROOT / "odoo_addons/print_gateway/controllers/agent_ws.py").read_text(encoding="utf-8")
        self.assertIn("def _is_agent_active(cr, agent_id):", ws_src)
        self.assertIn('"type": "agent_revoked"', ws_src)
        self.assertIn("AND active = TRUE", ws_src)

    def test_phase2_print_router_fail_fast_on_unshared_or_inactive(self):
        src = (ROOT / "odoo_addons/print_gateway/models/print_router.py").read_text(encoding="utf-8")
        self.assertIn("SELECT pr.available_to_odoo, a.active", src)
        self.assertIn("is archived or inactive", src)
        self.assertIn("is currently not shared with Odoo", src)

    def test_phase3_gateway_isolated_db_binding_lock_and_plan_limits(self):
        ref_src = (ROOT / "src/app/api/license/refresh/route.ts").read_text(encoding="utf-8")
        self.assertIn("ODOO_DB_ALREADY_BOUND", ref_src)
        self.assertIn("left(${odooInstallations.id}, 3) = 'db_'", ref_src)
        self.assertIn("buildRevocationTombstone", ref_src)

        mp_src = (ROOT / "src/lib/manual-plans.ts").read_text(encoding="utf-8")
        self.assertIn("maxAgents", mp_src)
        self.assertIn("maxPrinters", mp_src)

        plans_api = (ROOT / "src/app/api/platform/plans/[id]/route.ts").read_text(encoding="utf-8")
        self.assertIn("maxAgentsProvided", plans_api)
        self.assertIn("maxPrintersProvided", plans_api)

        plans_ui = (ROOT / "src/app/platform/plans/page.tsx").read_text(encoding="utf-8")
        self.assertIn("maxAgents", plans_ui)
        self.assertIn("maxPrinters", plans_ui)

        desktop_printers = (ROOT / "src/desktop/pages/Printers.tsx").read_text(encoding="utf-8")
        self.assertIn("desktop.printers.sharedWithOdooCount", desktop_printers)

    def test_phase4_hardware_buzzer_and_jpeg_peripheral_order_and_tolerance(self):
        per_src = (ROOT / "agent/internal/printer/peripherals.go").read_text(encoding="utf-8")
        self.assertIn("BuzzerEpson = []byte{0x1B, 0x42, 0x02, 0x02}", per_src)
        self.assertNotIn("BuzzerEpson = []byte{0x1B, 0x70, 0x00, 0x19, 0xFA}", per_src)

        doc_src = (ROOT / "agent/internal/printer/document.go").read_text(encoding="utf-8")
        self.assertIn("Peripherals *PeripheralProfile", doc_src)

        ras_src = (ROOT / "agent/internal/printer/raster_document.go").read_text(encoding="utf-8")
        self.assertIn("if doc.Peripherals != nil {", ras_src)
        self.assertIn("WrapPeripheralCommands(raster, protocol, *doc.Peripherals)", ras_src)

        ag_src = (ROOT / "agent/internal/agent/agent.go").read_text(encoding="utf-8")
        self.assertIn("if kind != printer.KindImage {", ag_src)
        self.assertIn("document.Peripherals = &imgPeriph", ag_src)

        pdf_src = (ROOT / "agent/internal/printer/pdf_receipt.go").read_text(encoding="utf-8")
        self.assertIn("tolDots := math.Max(2.0, float64(dpiX)*2.0/25.4)", pdf_src)

        bind_src = (ROOT / "odoo_addons/print_gateway/models/binding.py").read_text(encoding="utf-8")
        self.assertIn("0x1B 0x42 0x02 0x02", bind_src)
        self.assertIn("has_width_fallback", bind_src)


if __name__ == "__main__":
    unittest.main()
