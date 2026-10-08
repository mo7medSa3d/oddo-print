"""Execute production error branches without loading an Odoo server.

The real method AST is compiled with small environment/report doubles. These
checks catch NameError/UnboundLocalError that compileall and source tests miss.
"""
import ast
import base64
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"

class ValidationError(Exception):
    pass

def load_method(file, name, globals_):
    tree = ast.parse((ADDON / file).read_text())
    method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    method.decorator_list = []
    namespace = dict(globals_)
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(file), "exec"), namespace)
    return namespace[name]

@pytest.mark.parametrize("empty", [True, False])
def test_pdf_render_errors_preserve_translator(empty):
    def translate(msg):
        return "translated: " + msg
    render = load_method("models/print_router.py", "_render_pdf_payload", {"ValidationError": ValidationError, "_": translate, "base64": base64})
    class Records:
        ids = [1]
        def exists(self): return self
        def __bool__(self): return not empty
    class Report:
        display_name = "Invoice"
        def ensure_one(self): pass
        def _render_qweb_pdf(self, *args, **kwargs): raise RuntimeError("driver error")
    with pytest.raises(ValidationError, match="translated:"):
        render(SimpleNamespace(), Report(), Records())

@pytest.mark.parametrize("status,body,want", [(503, {}, "HTTP 503"), (200, [], "invalid agent discovery")])
def test_discovery_errors_are_translated_and_not_empty_inventory(status, body, want):
    config = SimpleNamespace(_gateway_base=lambda **kw: "https://gateway.test", _gateway_headers=lambda: {})
    class Requests:
        class RequestException(Exception): pass
        @staticmethod
        def get(*args, **kwargs):
            return SimpleNamespace(status_code=status, json=lambda: body)
    globals_ = {"requests": Requests, "request": SimpleNamespace(env=SimpleNamespace(_=lambda msg: "translated: " + msg)), "ValidationError": ValidationError}
    # The paged inventory helper is intentionally separate from the Odoo
    # controller method; exercise both under the same isolated doubles.
    globals_["_fetch_runtime_inventory"] = load_method("controllers/runtime_printers.py", "_fetch_runtime_inventory", globals_)
    method = load_method("controllers/runtime_printers.py", "runtime_agents", globals_)
    self = SimpleNamespace(_require_runtime_admin=lambda: None, _scope=lambda *args: (1, False), _get_config=lambda c: (config, 1))
    with pytest.raises(ValidationError, match=want) as error:
        method(self)
    assert str(error.value).startswith("translated:")
