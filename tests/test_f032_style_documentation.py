"""Guard Odoo styling and deployment guidance against recurring inaccuracies."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_print_gateway_table_separator_uses_defined_design_token():
    tokens = (ROOT / 'odoo_addons/print_gateway/static/src/scss/print_gateway_tokens.scss').read_text()
    styles = (ROOT / 'odoo_addons/print_gateway/static/src/scss/print_gateway_backend.scss').read_text()
    assert '--pg-border:' in tokens
    assert 'tbody tr.o_data_row + tr.o_data_row { border-top: 1px solid var(--pg-border); }' in styles
    assert '--pg-border-subtle' not in styles


def test_proxy_mode_troubleshooting_does_not_promise_cookie_samesite_change():
    text = (ROOT / 'TROUBLESHOOTING.md').read_text()
    section = text.split('### Odoo login fails with "Session expired (invalid CSRF token)"', 1)[1].split('\n### ', 1)[0]
    assert '`proxy_mode = True`' in section
    assert 'does **not** by itself guarantee a `SameSite=None` session cookie' in section
    assert 'Do not disable Odoo\'s CSRF' in section
