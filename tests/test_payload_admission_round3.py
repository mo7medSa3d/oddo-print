"""Execute actual Odoo addon validators without running an Odoo database.

These tests load only selected methods from the current source AST. This is
not a replacement for Odoo integration testing, but catches allocation guards
and source-contract regressions before Gateway/Agent submission.
"""
import ast
import base64
import binascii
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

MODELS = Path(__file__).resolve().parents[1] / "odoo_addons" / "print_gateway" / "models"
MAX = 5 * 1024 * 1024


class ValidationError(Exception):
    pass


def _model_methods(filename, classname, methods, **overrides):
    tree = ast.parse((MODELS / filename).read_text(encoding="utf-8"))
    klass = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == classname)
    selected = []
    for func in klass.body:
        if isinstance(func, ast.FunctionDef) and func.name in methods:
            func = copy.deepcopy(func)
            func.decorator_list.clear()
            selected.append(func)
    assert len(selected) == len(methods)
    module = ast.Module(body=[ast.ClassDef(name="Extracted", bases=[], keywords=[], body=selected, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = dict(
        _=lambda v: v, ValidationError=ValidationError, base64=base64,
        binascii=binascii, json=json,
        MAX_IMAGE_BYTES=MAX, MAX_BASE64_CHARS=4 * ((MAX + 2) // 3),
        MAX_PRINT_CONTENT_BYTES=MAX, MAX_PRINT_BASE64_CHARS=4 * ((MAX + 2) // 3),
    )
    namespace.update(overrides)
    exec(compile(module, filename, "exec"), namespace)
    return namespace["Extracted"]


def _router(**kwargs):
    return _model_methods("print_router.py", "PrintGatewayRouter", {"_validate_pdf", "_validate_jpeg_base64"}, **kwargs)


def _job(**kwargs):
    return _model_methods("print_job.py", "PrintGatewayJob", {"_validate_persisted_payload", "create_operation"}, **kwargs)


@pytest.mark.parametrize("value", [b"%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n", [b"%PDF-1.4\n%%EOF\n"],
                                   (b"%PDF-1.4\n%%EOF\n",)])
def test_pdf_renderer_accepts_complete_small_pdf(value):
    assert _router()._validate_pdf(value, SimpleNamespace(display_name="report")).startswith(b"%PDF-")


@pytest.mark.parametrize("value", [b"%PDF-1.7\nbody", b"NOT_PDF\n%%EOF\n", b"", "not bytes",
                                   b"%PDF-1.7\n%%EOF\n" + b"x" * 4097,
                                   b"%PDF-1.7\n" + b"x" * MAX + b"\n%%EOF"])
def test_pdf_renderer_rejects_invalid_truncated_or_oversized_payload(value):
    with pytest.raises(ValidationError):
        _router()._validate_pdf(value, SimpleNamespace(display_name="report"))


def test_jpeg_validator_accepts_normal_image_and_rejects_invalid():
    jpeg = base64.b64encode(b"\xff\xd8\xff\xe0JPEGDATA").decode("ascii")
    assert _router()._validate_jpeg_base64(jpeg) == jpeg
    with pytest.raises(ValidationError):
        _router()._validate_jpeg_base64(base64.b64encode(b"NOTJPEG").decode("ascii"))
    with pytest.raises(ValidationError):
        _router()._validate_jpeg_base64("not-base64$$")


def test_jpeg_rejects_oversized_encoded_data_before_decoding():
    class NoDecode:
        def b64decode(self, *_a, **_kw):
            raise AssertionError("decoder invoked on rejected payload")
    bounded = _router(base64=NoDecode(), MAX_BASE64_CHARS=12)
    with pytest.raises(ValidationError, match="5 MiB"):
        bounded._validate_jpeg_base64("A" * 13)


def test_persisted_payload_rejects_large_input_before_base64_decoding():
    class NoDecode:
        binascii = binascii

        def b64decode(self, *_a, **_kw):
            raise AssertionError("decoder invoked on rejected payload")
    model = _job(base64=NoDecode(), MAX_PRINT_BASE64_CHARS=12)()
    model.payload_type = "pdf"
    model.ensure_one = lambda: None
    with pytest.raises(ValidationError, match="5 MiB"):
        model._validate_persisted_payload({"type": "pdf", "encoding": "base64", "data": "A" * 13})


def test_persisted_payload_rejects_empty_decoded_pdf_and_malformed_base64():
    model = _job()()
    model.payload_type = "pdf"
    model.ensure_one = lambda: None
    for data, error in (("====", "valid base64"), ("%%%%", "valid base64"), ("", "non-empty")):
        with pytest.raises(ValidationError, match=error):
            model._validate_persisted_payload({"type": "pdf", "encoding": "base64", "data": data})


def test_create_operation_rejects_giant_data_before_serialization():
    class NoJSON:
        def dumps(self, *_a, **_kw):
            raise AssertionError("JSON allocation occurred before size guard")
    company = SimpleNamespace(parent_id=None, id=21)
    config = SimpleNamespace(company_id=company)
    model = _job(json=NoJSON(), MAX_PRINT_BASE64_CHARS=12)()
    model.env = SimpleNamespace(company=company)
    model.sudo = lambda: model
    with pytest.raises(ValidationError, match="5 MiB"):
        model.create_operation(company=company, gateway_config=config, printer_id="printer-id",
                               destination="receipt", document_type="receipt",
                               payload={"type": "image", "encoding": "base64", "data": "A" * 13})


def test_current_source_guards_large_encoding_before_allocations():
    for filename, classname, methodname, guarded_name, allocation_name in (
        ("print_job.py", "PrintGatewayJob", "create_operation", "MAX_PRINT_BASE64_CHARS", "dumps"),
        ("print_job.py", "PrintGatewayJob", "_validate_persisted_payload", "MAX_PRINT_BASE64_CHARS", "b64decode"),
        ("print_router.py", "PrintGatewayRouter", "_validate_jpeg_base64", "MAX_BASE64_CHARS", "b64decode"),
    ):
        module = ast.parse((MODELS / filename).read_text(encoding="utf-8"))
        cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == classname)
        func = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == methodname)
        guard_lines = [n.lineno for n in ast.walk(func) if isinstance(n, ast.Name) and n.id == guarded_name]
        allocation_lines = [n.lineno for n in ast.walk(func) if isinstance(n, ast.Call)
                            and isinstance(n.func, ast.Attribute) and n.func.attr == allocation_name]
        assert guard_lines and allocation_lines and min(guard_lines) < min(allocation_lines)


def test_optional_chatter_failures_rollback_to_savepoint_before_swallowing():
    import logging

    class Cursor:
        def __init__(self):
            self.aborted = False
            self.rollbacks = 0

        def savepoint(self):
            cursor = self

            class Context:
                def __enter__(self):
                    return None

                def __exit__(self, _type, _value, _tb):
                    if _type is not None:
                        cursor.rollbacks += 1
                        cursor.aborted = False
                    return False
            return Context()

    class FailingModel:
        def __init__(self, cursor):
            self.cursor = cursor

        def browse(self, _id):
            return self

        def exists(self):
            return self

        def message_post(self, **_kw):
            self.cursor.aborted = True
            raise RuntimeError("simulated PostgreSQL statement failure")

    class Environment:
        def __init__(self):
            self.cr = Cursor()

        def __getitem__(self, _key):
            return FailingModel(self.cr)

    class Job:
        source_model = "account.move"
        source_record_id = 7

        def __init__(self):
            self.env = Environment()

        def __iter__(self):
            yield self

    cls = _model_methods("print_job.py", "PrintGatewayJob", {"_post_source_audit"},
                         _logger=logging.getLogger(__name__))
    job = Job()
    cls._post_source_audit(job, "Print job queued")
    assert job.env.cr.rollbacks == 1
    assert not job.env.cr.aborted


def test_policy_invalid_legacy_domain_never_bypasses_filter():
    import ast as ast_module

    class Env:
        company = None
        cr = None

        def __getitem__(self, key):
            raise AssertionError(f"unexpected search of {key}")

    policy = _model_methods("print_policy.py", "PrintGatewayPolicy", {"matches_record"},
                            safe_eval=ast_module.literal_eval)()
    policy.ensure_one = lambda: None
    policy.active = True
    policy.model_name = "pos.order"
    policy.domain_filter = "'NOT A DOMAIN'"
    policy.branch_id = False
    policy.warehouse_id = False
    policy.picking_type_id = False
    policy.env = Env()
    record = SimpleNamespace(_name="pos.order", id=2, company_id=None)
    assert policy.matches_record(record) is False


def test_policy_domain_query_failure_uses_savepoint_without_aborting_business_write():
    import ast as ast_module

    class Cursor:
        aborted = False
        rollbacks = 0

        def savepoint(self):
            cursor = self
            class Savepoint:
                def __enter__(self):
                    return None

                def __exit__(self, exc_type, exc, tb):
                    if exc_type is not None:
                        cursor.aborted = False
                        cursor.rollbacks += 1
                    return False
            return Savepoint()

    class Env:
        cr = Cursor()

        def __getitem__(self, key):
            env = self
            class Model:
                def search(self, *_args, **_kwargs):
                    env.cr.aborted = True
                    raise RuntimeError("invalid field in database query")
            return Model()

    policy = _model_methods("print_policy.py", "PrintGatewayPolicy", {"matches_record"},
                            safe_eval=ast_module.literal_eval)()
    policy.ensure_one = lambda: None
    policy.active = True
    policy.model_name = "pos.order"
    policy.domain_filter = "[('state', '=', 'paid')]"
    policy.branch_id = False
    policy.warehouse_id = False
    policy.picking_type_id = False
    policy.env = Env()
    record = SimpleNamespace(_name="pos.order", id=2, company_id=None)
    assert policy.matches_record(record) is False
    assert policy.env.cr.rollbacks == 1
    assert policy.env.cr.aborted is False


def test_persisted_pdf_refuses_truncated_content_even_with_correct_signature():
    model = _job()()
    model.payload_type = "pdf"
    model.ensure_one = lambda: None
    truncated = base64.b64encode(b"%PDF-1.7\nbody with missing trailer").decode("ascii")
    with pytest.raises(ValidationError, match="%%EOF"):
        model._validate_persisted_payload({"type": "pdf", "encoding": "base64", "data": truncated})
    complete = base64.b64encode(b"%PDF-1.7\n%%EOF\n").decode("ascii")
    model._validate_persisted_payload({"type": "pdf", "encoding": "base64", "data": complete})
