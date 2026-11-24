#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Comprehensive verification suite for the Odoo 19 print_gateway lifecycle overhaul.

Tests:
1. Odoo 19 post_init_hook(env) and uninstall_hook(env) registration, signature, and behavior.
2. Auto-computed printer specs (paper_width_mm, dots_per_line, dpi, is_virtual,
   recommended_protocol, capability_summary) in models/printer.py.
3. Virtual printer sync acceptance in controllers/agent_api.py and binding/image
   protocol compatibility in models/binding.py.
4. Job dispatch compatibility for any agent printer (including virtual).
5. POS fault tolerance in controllers/pos.py, pos_print_router.js, and pos_sale_details_router.js.
6. Simplified Odoo 19 XML views and iOS 27 minimal SCSS tokens.
"""

import ast
import contextlib
import importlib.util
import inspect
import json
import sys
import types
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "odoo_addons" / "print_gateway"


def _install_odoo_stubs():
    """Provide minimal Odoo 19 module stubs so addon Python files can be imported standalone."""
    if "odoo" in sys.modules:
        return

    odoo_mod = types.ModuleType("odoo")
    odoo_mod.__path__ = []
    odoo_mod._ = lambda s, *args, **kwargs: s

    api_mod = types.ModuleType("odoo.api")
    api_mod.model = lambda fn: fn
    api_mod.model_create_multi = lambda fn: fn
    api_mod.depends = lambda *args: (lambda fn: fn)
    api_mod.depends_context = lambda *args: (lambda fn: fn)
    api_mod.constrains = lambda *args: (lambda fn: fn)
    api_mod.onchange = lambda *args: (lambda fn: fn)
    api_mod.private = lambda fn: fn
    api_mod.Environment = MagicMock()

    class _Field:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

    fields_mod = types.ModuleType("odoo.fields")
    for fname in (
        "Char", "Text", "Integer", "Float", "Boolean", "Datetime", "Date",
        "Selection", "Many2one", "One2many", "Many2many", "Reference", "Binary",
    ):
        setattr(fields_mod, fname, _Field)

    class _BaseModel:
        def ensure_one(self):
            return self

    models_mod = types.ModuleType("odoo.models")
    models_mod.Model = _BaseModel
    models_mod.AbstractModel = _BaseModel
    models_mod.TransientModel = _BaseModel
    models_mod.Constraint = lambda *args, **kwargs: (args, kwargs)
    models_mod.UniqueIndex = lambda *args, **kwargs: (args, kwargs)

    exc_mod = types.ModuleType("odoo.exceptions")

    class _OdooExc(Exception):
        pass

    exc_mod.AccessError = type("AccessError", (_OdooExc,), {})
    exc_mod.UserError = type("UserError", (_OdooExc,), {})
    exc_mod.ValidationError = type("ValidationError", (_OdooExc,), {})

    http_mod = types.ModuleType("odoo.http")
    http_mod.Controller = object
    http_mod.route = lambda *args, **kwargs: (lambda fn: fn)
    http_mod.request = MagicMock()

    pos_main_mod = types.ModuleType("odoo.addons.point_of_sale.controllers.main")

    class _PosController:
        def print_sale_details(self, date_start=False, date_stop=False, **kw):
            return {"fallback": "native_pdf", "date_start": date_start, "date_stop": date_stop}

    pos_main_mod.PosController = _PosController

    odoo_mod.api = api_mod
    odoo_mod.fields = fields_mod
    odoo_mod.models = models_mod
    odoo_mod.http = http_mod
    odoo_mod.exceptions = exc_mod

    tools_mod = types.ModuleType("odoo.tools")
    tools_mod.__path__ = []
    safe_eval_mod = types.ModuleType("odoo.tools.safe_eval")
    safe_eval_mod.safe_eval = lambda expr, *args, **kwargs: ast.literal_eval(expr)
    tools_mod.safe_eval = safe_eval_mod
    odoo_mod.tools = tools_mod
    sql_db_mod = types.ModuleType("odoo.sql_db")
    sql_db_mod.db_connect = MagicMock()
    odoo_mod.sql_db = sql_db_mod

    sys.modules["odoo"] = odoo_mod
    sys.modules["odoo.tools"] = tools_mod
    sys.modules["odoo.tools.safe_eval"] = safe_eval_mod
    sys.modules["odoo.sql_db"] = sql_db_mod
    sys.modules["odoo.api"] = api_mod
    sys.modules["odoo.fields"] = fields_mod
    sys.modules["odoo.models"] = models_mod
    sys.modules["odoo.exceptions"] = exc_mod
    sys.modules["odoo.http"] = http_mod
    sys.modules["odoo.addons"] = types.ModuleType("odoo.addons")
    sys.modules["odoo.addons.point_of_sale"] = types.ModuleType("odoo.addons.point_of_sale")
    sys.modules["odoo.addons.point_of_sale.controllers"] = types.ModuleType("odoo.addons.point_of_sale.controllers")
    sys.modules["odoo.addons.point_of_sale.controllers.main"] = pos_main_mod

    # Minimal psycopg2 stub if absent
    if "psycopg2" not in sys.modules:
        pg_mod = types.ModuleType("psycopg2")
        pg_mod.IntegrityError = type("IntegrityError", (Exception,), {})
        pg_mod.sql = MagicMock()
        sys.modules["psycopg2"] = pg_mod

    # Minimal werkzeug stub if absent
    if "werkzeug.exceptions" not in sys.modules:
        wz_mod = types.ModuleType("werkzeug")
        wz_exc = types.ModuleType("werkzeug.exceptions")
        wz_exc.Forbidden = type("Forbidden", (Exception,), {})
        sys.modules["werkzeug"] = wz_mod
        sys.modules["werkzeug.exceptions"] = wz_exc


def _load_addon_package():
    """Load odoo_addons/print_gateway as a package with stubbed Odoo dependencies."""
    _install_odoo_stubs()
    parent_dir = str(ADDON.parent)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    import print_gateway  # noqa: PLC0415
    return print_gateway


class _FakeRecordSet(list):
    @property
    def ids(self):
        return [r.id for r in self]

    def mapped(self, attr):
        return _FakeRecordSet([getattr(r, attr) for r in self if getattr(r, attr, None) is not None])

    def unlink(self):
        self._unlinked = True
        self.clear()

    def write(self, vals):
        for r in self:
            for k, v in vals.items():
                setattr(r, k, v)
        return True


class TestOdooLifecycleHooks(unittest.TestCase):
    def test_manifest_declares_odoo19_hooks(self):
        manifest_ast = ast.parse((ADDON / "__manifest__.py").read_text(encoding="utf-8"))
        manifest = ast.literal_eval(manifest_ast.body[0].value)
        self.assertEqual(manifest.get("post_init_hook"), "post_init_hook")
        self.assertEqual(manifest.get("uninstall_hook"), "uninstall_hook")

    def test_hook_signatures_take_sole_env_argument(self):
        pg = _load_addon_package()
        for fn_name in ("post_init_hook", "uninstall_hook"):
            fn = getattr(pg, fn_name)
            params = list(inspect.signature(fn).parameters.keys())
            self.assertEqual(params, ["env"], f"{fn_name} must take (env) per Odoo 19 docs")

    def test_post_init_hook_initializes_defaults_and_configs(self):
        pg = _load_addon_package()
        params_store = {}
        created_configs = []

        class _FakeICP:
            def sudo(self):
                return self

            def get_param(self, key):
                return params_store.get(key, "")

            def set_param(self, key, val):
                params_store[key] = val

        company_1 = types.SimpleNamespace(id=1, parent_id=False)
        company_2 = types.SimpleNamespace(id=2, parent_id=False)
        existing_cfg = types.SimpleNamespace(id=10, company_id=company_1)

        class _FakeCompanyModel:
            def sudo(self):
                return self

            def search(self, domain):
                return _FakeRecordSet([company_1, company_2])

        class _FakeConfigModel:
            def sudo(self):
                return self

            def search(self, domain):
                return _FakeRecordSet([existing_cfg])

            def create(self, vals_list):
                created_configs.extend(vals_list)
                return _FakeRecordSet()

        env = {
            "ir.config_parameter": _FakeICP(),
            "res.company": _FakeCompanyModel(),
            "print_gateway.gateway_config": _FakeConfigModel(),
        }
        pg.post_init_hook(env)

        self.assertEqual(params_store["print_gateway.license_server_url"], "https://print.yaseir.cloud")
        self.assertEqual(created_configs, [{"company_id": 2, "enabled": False}])

    def test_uninstall_hook_cleans_params_agents_cache_and_notifies(self):
        pg = _load_addon_package()
        from print_gateway.models import print_config  # noqa: PLC0415

        with print_config._VERIFIED_SIG_CACHE_LOCK:
            print_config._VERIFIED_SIG_CACHE[("pub", "sig", b"claims")] = True

        param_records = _FakeRecordSet([
            types.SimpleNamespace(id=1, key="print_gateway.license_key"),
            types.SimpleNamespace(id=2, key="print_gateway.signed_license_bundle"),
        ])
        agent_rec = types.SimpleNamespace(
            id=7, token_hash="abc", pairing_code_hash="def", pairing_expires_at="2026-01-01",
            status="online", active=True,
        )
        agent_records = _FakeRecordSet([agent_rec])
        executed_sql = []

        class _FakeICP:
            def sudo(self):
                return self

            def search(self, domain):
                self.last_domain = domain
                return param_records

        class _FakeAgentModel:
            def sudo(self):
                return self

            def with_context(self, **kwargs):
                return self

            def search(self, domain):
                return agent_records

        class _FakeCR:
            @contextlib.contextmanager
            def savepoint(self):
                yield

            def execute(self, sql, params=None):
                executed_sql.append((sql, params))

        class _FakeEnv(dict):
            cr = _FakeCR()

        env = _FakeEnv({
            "ir.config_parameter": _FakeICP(),
            "print_gateway.agent": _FakeAgentModel(),
        })
        pg.uninstall_hook(env)

        self.assertEqual(len(param_records), 0)
        self.assertFalse(agent_rec.token_hash)
        self.assertEqual(agent_rec.status, "offline")
        self.assertFalse(agent_rec.active)
        with print_config._VERIFIED_SIG_CACHE_LOCK:
            self.assertEqual(len(print_config._VERIFIED_SIG_CACHE), 0)
        self.assertTrue(any("pg_notify('print_gateway_license_updated'" in sql for sql, _ in executed_sql))


class TestAutoComputedPrinterSpecsAndVirtualSync(unittest.TestCase):
    def test_physical_thermal_printer_specs_auto_computed(self):
        _load_addon_package()
        from print_gateway.models.printer import derive_printer_specs  # noqa: PLC0415

        specs = derive_printer_specs(
            name="Epson TM-T88V",
            connection_type="network",
            protocol="escpos",
            capabilities=json.dumps({
                "geometry": {
                    "paper_width_mm": 80,
                    "printable_width_dots": 576,
                    "dpi_x": 203,
                }
            }),
        )
        self.assertFalse(specs["is_virtual"])
        self.assertEqual(specs["paper_width_mm"], 80.0)
        self.assertEqual(specs["dots_per_line"], 576)
        self.assertEqual(specs["dpi"], 203)
        self.assertEqual(specs["recommended_protocol"], "escpos")
        self.assertIn("ESC/POS", specs["capability_summary"])
        self.assertIn("80mm", specs["capability_summary"])
        self.assertIn("576 dots", specs["capability_summary"])
        self.assertIn("203 DPI", specs["capability_summary"])

    def test_dots_per_line_derived_from_width_and_dpi(self):
        _load_addon_package()
        from print_gateway.models.printer import derive_printer_specs  # noqa: PLC0415

        specs = derive_printer_specs(
            name="Bixolon 58mm",
            connection_type="usb",
            protocol="escpos",
            capabilities={"paper_width_mm": 58, "dpi": 203},
        )
        self.assertEqual(specs["dots_per_line"], int(round((58 / 25.4) * 203)))
        self.assertFalse(specs["is_virtual"])

    def test_virtual_printer_auto_detected_and_protocol_resolved(self):
        _load_addon_package()
        from print_gateway.models.printer import derive_printer_specs  # noqa: PLC0415
        from print_gateway.models.binding import PrintGatewayBinding  # noqa: PLC0415

        specs_by_name = derive_printer_specs(
            name="Microsoft Print to PDF",
            connection_type="spooler",
            protocol="spooler",
        )
        self.assertTrue(specs_by_name["is_virtual"])
        self.assertEqual(specs_by_name["recommended_protocol"], "spooler")
        self.assertTrue(specs_by_name["capability_summary"].startswith("Virtual"))

        specs_by_flag = derive_printer_specs(
            name="QA Receipt Sink",
            connection_type="virtual",
            protocol="virtual",
            capabilities={"isVirtual": True, "paper_width_mm": 80},
        )
        self.assertTrue(specs_by_flag["is_virtual"])
        self.assertEqual(specs_by_flag["recommended_protocol"], "spooler")

        binding = PrintGatewayBinding()
        virtual_printer = {
            "id": "virt_pdf_1",
            "name": "Microsoft Print to PDF",
            "connectionType": "virtual",
            "protocol": "spooler",
            "capabilities": {"is_virtual": True},
        }
        self.assertEqual(binding._canonical_runtime_printer_protocol(virtual_printer), "spooler")
        self.assertTrue(binding._runtime_printer_accepts_image(virtual_printer))

    def test_heartbeat_accepts_and_syncs_virtual_and_physical_printers(self):
        _load_addon_package()
        import odoo.http as odoo_http  # noqa: PLC0415
        from print_gateway.controllers import agent_api  # noqa: PLC0415

        inserted_batches = []

        class _FakeCR:
            def __init__(self):
                self._queue = [
                    # _authenticate_agent -> row
                    [(5, 1, "agt_test01", agent_api._hash_token("secret-tok"))],
                    # current_active_printers count
                    [(0,)],
                    # existing_keys for agent
                    [],
                    # recount active_printers
                    [(2,)],
                    # disabled_printer_ids
                    [],
                    # pending_count
                    [(1,)],
                ]

            def execute(self, sql, params=None):
                if "INSERT INTO print_gateway_printer" in sql:
                    inserted_batches.append(params)

            def fetchone(self):
                rows = self._queue.pop(0) if self._queue else [(0,)]
                return rows[0] if rows else None

            def fetchall(self):
                return self._queue.pop(0) if self._queue else []

        payload = {
            "printers": [
                {
                    "id": "virt_pdf_01",
                    "name": "Microsoft Print to PDF",
                    "connectionType": "virtual",
                    "protocol": "virtual",
                    "status": "online",
                    "isVirtual": True,
                    "availableToOdoo": True,
                    "geometry": {"paper_width_mm": 210, "dpi_x": 300},
                },
                {
                    "id": "pos_thermal_01",
                    "name": "Front Desk 80mm",
                    "connectionType": "network",
                    "protocol": "escpos",
                    "status": "online",
                    "availableToOdoo": True,
                    "capabilities": {"paper_width_mm": 80, "dpi": 203},
                },
            ]
        }

        fake_req = MagicMock()
        fake_req.db = "test_db"
        fake_req.env.cr = _FakeCR()
        fake_req.httprequest.headers = {"Authorization": "Bearer agt_test01:secret-tok"}
        fake_req.httprequest.content_length = len(json.dumps(payload))
        fake_req.httprequest.stream.read.return_value = json.dumps(payload).encode("utf-8")
        fake_req.make_response.side_effect = lambda body, status=200, headers=None: {
            "status": status,
            "body": json.loads(body),
        }
        fake_icp = MagicMock()
        fake_icp.get_param.return_value = "test-db-uuid"
        fake_req.env.__getitem__.return_value.sudo.return_value = fake_icp

        orig_req = agent_api.request
        orig_verify = agent_api.verify_stored_license_bundle
        try:
            agent_api.request = fake_req
            odoo_http.request = fake_req
            agent_api.verify_stored_license_bundle = lambda _icp: (
                True,
                "ok",
                {"payload": {"max_agents": 5, "max_printers": 10}},
            )
            ctrl = agent_api.DirectAgentController()
            resp = ctrl.agent_heartbeat()
        finally:
            agent_api.request = orig_req
            agent_api.verify_stored_license_bundle = orig_verify

        self.assertEqual(resp["status"], 200)
        self.assertTrue(resp["body"]["ok"])
        self.assertEqual(resp["body"]["pendingJobs"], 1)
        self.assertEqual(len(inserted_batches), 1)
        batch = inserted_batches[0]
        # batch indices: (agent_id, company_id, keys, names, conn_types, protos, statuses, avails, caps_jsons, geom_jsons)
        keys, names, conn_types, protos, statuses, avails, caps_jsons, geom_jsons = batch[2:]
        self.assertEqual(keys, ["virt_pdf_01", "pos_thermal_01"])
        self.assertEqual(protos[0], "spooler")  # normalized from 'virtual'
        self.assertEqual(avails, [True, True])
        virt_caps = json.loads(caps_jsons[0])
        self.assertTrue(virt_caps.get("is_virtual"))
        self.assertEqual(json.loads(geom_jsons[0])["paper_width_mm"], 210)


class TestPosFaultTolerance(unittest.TestCase):
    def test_pos_sale_details_controller_degrades_gracefully_on_license_error(self):
        _load_addon_package()
        from print_gateway.controllers import pos as pos_ctrl  # noqa: PLC0415

        fake_req = MagicMock()
        fake_req.httprequest.method = "POST"
        fake_router = MagicMock()
        fake_router._print_config.return_value = MagicMock(enabled=True)
        fake_router.route_render_target.side_effect = RuntimeError("license_expired")
        fake_req.env.__getitem__.side_effect = lambda name: fake_router if name == "print_gateway.print_router" else MagicMock()

        orig_req = pos_ctrl.request
        try:
            pos_ctrl.request = fake_req
            controller = pos_ctrl.PrintGatewayPosController()
            result = controller.print_sale_details(date_start="2026-11-01", date_stop="2026-11-22")
        finally:
            pos_ctrl.request = orig_req

        self.assertEqual(result["fallback"], "native_pdf")

    def test_pos_js_routers_never_block_on_probe_sync_or_license_errors(self):
        ppr = (ADDON / "static" / "src" / "js" / "pos_print_router.js").read_text(encoding="utf-8")
        psdr = (ADDON / "static" / "src" / "js" / "pos_sale_details_router.js").read_text(encoding="utf-8")

        # pos_print_router.js must degrade to super.* on probe, sync, and pre-dispatch license/verification errors
        self.assertIn("isPreDispatchLicenseOrVerificationError", ppr)
        self.assertGreaterEqual(ppr.count("super.printReceipt({ order: currentOrder, basic, printBillActionTriggered })"), 3)
        self.assertGreaterEqual(ppr.count("super.sendOrderInPreparation(order, opts)"), 3)
        self.assertGreaterEqual(ppr.count("super.printChanges(order, orderChange, reprint, printers)"), 3)
        self.assertGreaterEqual(ppr.count("super.printOrderChanges(data, printer)"), 2)

        # pos_sale_details_router.js must degrade to super.onClick() on probe or pre-dispatch license/verification errors
        self.assertGreaterEqual(psdr.count("return super.onClick()"), 3)


class TestViewsAndDesignTokens(unittest.TestCase):
    def test_all_xml_views_parse_and_keep_required_ids(self):
        xml_files = sorted((ADDON / "views").glob("*.xml")) + [ADDON / "data" / "cron.xml"]
        self.assertTrue(xml_files)
        found_ids = set()
        for path in xml_files:
            tree = ET.parse(path)
            root = tree.getroot()
            for elem in root.iter():
                if elem.attrib.get("id"):
                    found_ids.add(elem.attrib["id"])

        required_ids = {
            "view_print_gateway_agent_list",
            "view_print_gateway_agent_form",
            "action_print_gateway_agents",
            "view_print_gateway_binding_list",
            "view_print_gateway_binding_form",
            "action_print_gateway_binding",
            "view_print_gateway_config_list",
            "view_print_gateway_config_form",
            "action_print_gateway_config",
            "view_print_gateway_job_list",
            "view_print_gateway_job_form",
        }
        self.assertTrue(required_ids.issubset(found_ids), f"Missing XML IDs: {required_ids - found_ids}")

    def test_simplified_views_expose_auto_computed_fields(self):
        agent_xml = (ADDON / "views" / "agent_views.xml").read_text(encoding="utf-8")
        binding_xml = (ADDON / "views" / "binding_views.xml").read_text(encoding="utf-8")

        self.assertIn('name="capability_summary"', agent_xml)
        self.assertIn('name="is_virtual"', agent_xml)
        self.assertIn('name="printer_capability_summary"', binding_xml)
        self.assertIn('name="printer_name" readonly="1"', binding_xml)

    def test_ios27_minimal_scss_tokens_present(self):
        tokens = (ADDON / "static" / "src" / "scss" / "print_gateway_tokens.scss").read_text(encoding="utf-8")
        backend = (ADDON / "static" / "src" / "scss" / "print_gateway_backend.scss").read_text(encoding="utf-8")
        self.assertIn("--pg-r-pill: 9999px;", tokens)
        self.assertIn("--pg-r-xl: 22px;", tokens)
        self.assertIn("padding: 28px 32px;", backend)


if __name__ == "__main__":
    unittest.main()
