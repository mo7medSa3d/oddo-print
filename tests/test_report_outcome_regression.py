"""Execute the real backend report hook with lightweight Odoo boundaries."""
import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models/ir_actions_report.py"


def report_hook(route):
    # Compile the production class unchanged. Only the Odoo model and routing
    # boundaries are substituted; assertions never inspect source strings.
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef))

    class NativeReport:
        def ensure_one(self):
            pass

        def report_action(self, docids, data=None, config=True):
            return {"native": True}

    namespace = {
        "models": SimpleNamespace(Model=NativeReport),
        "_": lambda message: message,
        "_assert_report_usage_access": lambda *_args: None,
    }
    exec(compile(ast.Module(body=[cls], type_ignores=[]), str(SOURCE), "exec"), namespace)
    report = namespace[cls.name]()
    report.report_type = "qweb-pdf"
    report.model = "account.move"
    records = SimpleNamespace(_name="account.move", check_access=lambda _mode: None)
    records.exists = lambda: records
    router = SimpleNamespace(route_report=lambda *_args, **_kw: route)

    class Env:
        company = SimpleNamespace(external_report_layout_id=True)
        context = {}

        def is_admin(self):
            return False

        def __getitem__(self, name):
            assert name == "print_gateway.print_router"
            return router

    report.env = Env()
    return report, records


@pytest.mark.parametrize("status", ["unknown", "partial", "failed", None, "unexpected"])
def test_backend_report_never_reports_unconfirmed_status_as_success(status):
    report, records = report_hook({"native": False, "status": status, "message": "Accepted"})
    result = report.report_action(records)
    assert result["params"]["type"] != "success"
    assert result["params"]["sticky"] is True
    assert result["params"]["message"] != "Accepted"


@pytest.mark.parametrize("status", ["submitted", "claimed", "printing", "success"])
def test_backend_report_acceptance_uses_allowlisted_status(status):
    report, records = report_hook({"native": False, "status": status, "message": "Accepted"})
    result = report.report_action(records)
    assert result["params"]["type"] == "info"
    assert result["params"]["message"] == "Accepted"


def test_backend_unbound_and_html_reports_remain_native():
    report, records = report_hook({"native": True})
    assert report.report_action(records) == {"native": True}
    report.report_type = "qweb-html"
    assert report.report_action(records) == {"native": True}
