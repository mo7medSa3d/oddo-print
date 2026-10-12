"""O-7: Gateway URL validation honors the documented LAN-dev HTTP opt-in."""
from pathlib import Path

MODEL = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway" / "models" / "gateway_config.py"


def test_http_opt_in_honored():
    src = MODEL.read_text(encoding="utf-8")
    assert "YASEIR_GATEWAY_ALLOW_INSECURE_HTTP" in src, "code must honor the INSTALLATION.md opt-in env"
    assert 'raise ValidationError(_("Gateway URL must use HTTPS."))' in src, "HTTPS remains the default"


def test_installation_documents_opt_in():
    doc = (Path(__file__).resolve().parent.parent / "INSTALLATION.md").read_text(encoding="utf-8")
    assert "YASEIR_GATEWAY_ALLOW_INSECURE_HTTP=1" in doc
