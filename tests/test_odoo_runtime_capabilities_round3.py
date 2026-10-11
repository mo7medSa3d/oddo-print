"""Execute the actual Odoo binding capability methods without importing Odoo.
This checks transport equivalence offline; live Odoo service remains required.
"""
import ast
from pathlib import Path
from types import SimpleNamespace, MethodType
import pytest

SRC = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/models/binding.py'
TREE = ast.parse(SRC.read_text())
CLASS = next(cls for cls in TREE.body if isinstance(cls, ast.ClassDef) and cls.name == 'PrintGatewayBinding') if any(isinstance(cls, ast.ClassDef) and cls.name == 'PrintGatewayBinding' for cls in TREE.body) else None
if CLASS is None:
    CLASS = next(cls for cls in TREE.body if isinstance(cls, ast.ClassDef) and any(isinstance(m, ast.FunctionDef) and m.name == '_canonical_runtime_printer_protocol' for m in cls.body))
NAMES = {'_canonical_runtime_printer_protocol', '_runtime_printer_accepts_image', '_runtime_supported_protocols', '_validate_binding_protocol_against_runtime'}
selected = []
for item in CLASS.body:
    if isinstance(item, ast.FunctionDef) and item.name in NAMES:
        item.decorator_list = []
        selected.append(item)
assert len(selected) == len(NAMES)

class ValidationError(Exception):
    pass

scope = {'ValidationError': ValidationError, '_': lambda text: text}
exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(SRC), 'exec'), scope)

def binding(selected_protocol='spooler'):
    obj = SimpleNamespace(printer_protocol=selected_protocol, printer_id='printer-test')
    obj.ensure_one = lambda: True
    for name in NAMES:
        setattr(obj, name, MethodType(scope[name], obj))
    return obj

@pytest.mark.parametrize('conn,protocol,expected', [
    ('network','spooler','unknown'), ('network','windows_spooler','unknown'),
    ('network','raw','raw'), ('network','escpos','escpos'),
    ('network','ipp','ipp'), ('network','ipps','ipps'),
    ('network','zpl','zpl'), ('network','tspl','tspl'),
    ('usb','spooler','spooler'), ('spooler','raw','spooler'), ('windows_spooler','windows_spooler','spooler'),
    ('ipp','unknown','ipp'), ('ipps','unknown','ipps'),
    ('usb','ipp','unknown'), ('unknown','spooler','unknown'),
])
def test_canonical_physical_transport(conn, protocol, expected):
    b=binding()
    assert b._canonical_runtime_printer_protocol({'connectionType':conn,'protocol':protocol}) == expected

@pytest.mark.parametrize('printer,should_accept', [
    ({'connectionType':'network','protocol':'spooler','capabilities':{'supported_protocols':['pdf','image']}},False),
    ({'connectionType':'spooler','protocol':'spooler'},True),
    ({'connectionType':'usb','protocol':'spooler'},True),
    ({'connectionType':'ipp','protocol':'ipp'},False),
    ({'connectionType':'network','protocol':'ipp'},False),
    ({'connectionType':'network','protocol':'escpos'},True),
    ({'connectionType':'network','protocol':'escpos','capabilities':{'supported_protocols':[]}},False),
    ({'connectionType':'network','protocol':'escpos','capabilities':{'supported_protocols':['jpeg']}},True),
    ({'connectionType':'network','protocol':'escpos','capabilities':{'supported_protocols':'escpos'}},False),
    ({'connectionType':'usb','protocol':'escpos'},False),
])
def test_pos_image_transport_matches_gateway(printer, should_accept):
    assert binding()._runtime_printer_accepts_image(printer) == should_accept

@pytest.mark.parametrize('selected,printer,allow', [
    ('spooler',{'connectionType':'network','protocol':'spooler'},False),
    ('spooler',{'connectionType':'spooler','protocol':'spooler'},True),
    ('spooler',{'connectionType':'usb','protocol':'spooler'},True),
    ('escpos',{'connectionType':'spooler','protocol':'spooler','capabilities':{'supported_protocols':['escpos']}},True),
    ('escpos',{'connectionType':'spooler','protocol':'spooler'},False),
    ('raw',{'connectionType':'network','protocol':'spooler','capabilities':{'supported_protocols':['raw']}},False),
    ('escpos',{'connectionType':'network','protocol':'escpos'},True),
    ('zpl',{'connectionType':'network','protocol':'zpl'},True),
    ('ipp',{'connectionType':'network','protocol':'ipp'},True),
])
def test_test_print_binding_validation(selected,printer,allow):
    b=binding(selected)
    if allow:
        assert b._validate_binding_protocol_against_runtime(printer) is True
    else:
        with pytest.raises(ValidationError):
            b._validate_binding_protocol_against_runtime(printer)
