"""Offline regression for the Odoo RAW/ZPL/TSPL/ESC-POS admission guard.

The executable helper is extracted from the actual addon AST; no Odoo runtime
is needed. This is not a live Odoo end-to-end printing acceptance test.
"""
import ast
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/models/print_router.py'

class ValidationError(Exception):
    pass

module = ast.parse(SOURCE.read_text(encoding='utf-8'))
helper = next(node for node in module.body if isinstance(node, ast.FunctionDef)
              and node.name == '_validated_raw_command_bytes')
code = ast.fix_missing_locations(ast.Module(body=[helper], type_ignores=[]))
globals_ = {'MAX_IMAGE_BYTES': 5 * 1024 * 1024,
            'ValidationError': ValidationError, '_': lambda text: text}
exec(compile(code, str(SOURCE), 'exec'), globals_)
validate = globals_['_validated_raw_command_bytes']

@pytest.mark.parametrize('data,expected', [
    ('^XA^FDName^FS^XZ', b'^XA^FDName^FS^XZ'),
    (b'\x1b@\x1dV', b'\x1b@\x1dV'),
    (bytearray(b'BOX'), b'BOX'),
    (memoryview(b'QR'), b'QR'),
    ('مرحبا', 'مرحبا'.encode('utf-8')),
])
def test_accepts_bounded_raw_commands(data, expected):
    assert validate(data) == expected

@pytest.mark.parametrize('data', [
    '', b'', bytearray(), 100_000_000, 42,
    object(), 'X' * (5 * 1024 * 1024 + 1),
    b'X' * (5 * 1024 * 1024 + 1),
    memoryview(b'X' * (5 * 1024 * 1024 + 1)),
    'أ' * (3 * 1024 * 1024),  # fits characters but not UTF-8 bytes
    '\ud800',  # unpaired surrogate may never reach the printer
])
def test_rejects_invalid_or_oversized_raw_commands(data):
    with pytest.raises(ValidationError):
        validate(data)


def test_route_uses_validation_before_any_base64_or_outbox_persistence():
    klass = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == 'PrintGatewayRouter')
    route = next(n for n in klass.body if isinstance(n, ast.FunctionDef) and n.name == 'route_raw_command')
    guard = next(n for n in ast.walk(route) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                 and n.func.id == '_validated_raw_command_bytes')
    calls = {n.func.attr: n for n in ast.walk(route) if isinstance(n, ast.Call)
             and isinstance(n.func, ast.Attribute)}
    assert guard.lineno < calls['b64encode'].lineno < calls['_persist_durable_job'].lineno
