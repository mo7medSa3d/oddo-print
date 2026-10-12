"""A-8/A-9/A-11: bounded billing parking, explicit TTL, canonical base64."""
from pathlib import Path

MODEL = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway" / "models" / "print_job.py"


def test_billing_park_helper_caps_attempts():
    src = MODEL.read_text(encoding="utf-8")
    assert "MAX_BILLING_PARK_ATTEMPTS = 25" in src
    assert "BILLING_PARK_RETRY_SECONDS = 24 * 3600" in src
    assert "def _billing_retry_values" in src
    assert "GATEWAY_BILLING_PARKED" in src
    for marker in (
        "GATEWAY_BILLING_LIMIT_REACHED",
        "GATEWAY_BILLING_BLOCKED",
        "GATEWAY_AUTH_RECOVERABLE_401",
        "GATEWAY_KEY_ROTATION_GRACE",
    ):
        assert src.count(marker) >= 1, marker
    assert "_billing_retry_values" in src
    # All five operator-recoverable paths funnel through the cap helper.
    assert src.count("self._billing_retry_values(") >= 5


def test_submission_body_sends_explicit_ttl():
    src = MODEL.read_text(encoding="utf-8")
    body = src[src.index("def _submission_body"):]
    body = body[: body.index("def _post_source_audit")]
    assert '"expiresAt"' in body, "Odoo must send an explicit TTL, not the 1h default"
    assert "timedelta(hours=4)" in body


def test_create_operation_canonicalizes_base64():
    src = MODEL.read_text(encoding="utf-8")
    create = src[src.index("def create_operation"):]
    create = create[: create.index("def _gateway_idempotency_key")]
    assert "b64encode(base64.b64decode" in create.replace(" ", ""), "persist canonical base64 once"
