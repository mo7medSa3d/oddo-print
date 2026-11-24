"""Customer wording never mistakes transport success for physical output.

The pure production presenter is shared by Odoo's computed fields and can be
checked without importing an Odoo server. The Arabic catalog is exercised too.
"""
from pathlib import Path
import importlib.util

import pytest

ROOT = Path(__file__).resolve().parents[1]


def presenter():
    path = ROOT / "odoo_addons/print_gateway/customer_presentation.py"
    assert path.exists(), "Odoo needs a locale-safe customer presenter"
    spec = importlib.util.spec_from_file_location("v4_customer_presentation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("status,physical,expected", [
    ("queued", "not_printed", "waiting"),
    ("submitted", "unknown", "needs_review"),
    ("claimed", "unknown", "processing"),
    ("printing", "unknown", "processing"),
    ("success", "unknown", "sent_to_printer"),
    ("failed", "not_printed", "failed_before_output"),
    ("failed", "unknown", "needs_review"),
    ("unknown", "unknown", "needs_review"),
    ("partial", "unknown", "needs_review"),
    ("unexpected", "unknown", "needs_review"),
])
def test_job_customer_state_matches_physical_presentation(status, physical, expected):
    assert presenter().job_customer_state(status, physical) == expected


@pytest.mark.parametrize("raw,category", [
    ("PRINT_QUOTA_EXCEEDED", "quota"),
    ("PRINT_REJECTED_STALE_POS_OPERATION", "stale_pos"),
    ("PRINT_REJECTED_BILLING_HOLD: no print admitted", "billing_receipt"),
    ("TENANT_SUBSCRIPTION_REQUIRED", "subscription"),
    ("TENANT_SUSPENDED", "subscription"),
    ("API_KEY_REVOKED", "credential"),
    ("PRINTER_OPERATIONAL_VERIFICATION_REQUIRED", "verification"),
    ("UNKNOWN_SUBMISSION_OUTCOME: timeout with secret payload", "uncertain"),
    ("CONNECTION_ERROR: postgres://admin:secret@127.0.0.1", "connection"),
    ("SQL failure password=secret", "operation"),
])
def test_error_categories_do_not_echo_untrusted_diagnostics(raw, category):
    module = presenter()
    assert module.customer_error_category(raw) == category
    text = module.customer_error_message(lambda value: value, raw)
    assert raw not in text
    assert "secret" not in text and "postgres" not in text and "SQL" not in text
    assert text


def test_error_translation_resolved_for_each_reader_not_stored_locale():
    module = presenter()
    english = module.customer_error_message(lambda value: value, "PRINT_QUOTA_EXCEEDED")
    arabic = module.customer_error_message(lambda value: "عربي: " + value, "PRINT_QUOTA_EXCEEDED")
    assert arabic == "عربي: " + english
    assert module.customer_error_message(lambda value: value, None) == ""


@pytest.mark.parametrize("diagnostic", [
    "PRINT_RULE_CHANGED: the admin disabled this automatic print rule",
    "PRINT_RULE_NOT_MATCHED: this automation no longer selects the document",
    "PRINT_SOURCE_COMPANY_CHANGED: source company changed after capture",
])
def test_changed_automation_rule_is_actionable_in_arabic_and_english(diagnostic):
    module = presenter()
    assert module.customer_error_category(diagnostic) == "routing_changed"
    english = module.customer_error_message(lambda value: value, diagnostic)
    assert "No print was sent." in english
    assert diagnostic not in english
    assert "company changed after capture" not in english
    arabic = module.customer_error_message(lambda value: "عربي: " + value, diagnostic)
    assert arabic == "عربي: " + english
    catalog = (ROOT / "odoo_addons/print_gateway/i18n/ar.po").read_text(encoding="utf-8")
    # Gettext entries use a real newline, not a literal backslash+n string.
    # Require a nonempty Arabic translation of the exact safe operator copy.
    import re
    entry = re.search(r'^msgid "' + re.escape(english) + r'"\nmsgstr "([^"\n]+)"',
                      catalog, flags=re.MULTILINE)
    assert entry is not None and re.search(r'[\u0600-\u06FF]', entry.group(1))


def test_http_error_codes_take_priority_over_arbitrary_response_text():
    module = presenter()
    assert module.customer_error_category("malicious private English text", code="PRINT_QUOTA_EXCEEDED", status=403) == "quota"
    # Machine codes describe a rejected, never-admitted job. An unrelated
    # remote diagnostic string must not change the rejection category to a
    # physically ambiguous outcome and hide the accurate local remedy.
    assert module.customer_error_category(
        "UNKNOWN_PARTIAL_DELIVERY: untrusted downstream text", code="PRINT_QUOTA_EXCEEDED", status=429
    ) == "quota"
    assert module.customer_error_category(
        "UNKNOWN_SUBMISSION_OUTCOME: untrusted downstream text", code="TENANT_SUBSCRIPTION_REQUIRED", status=403
    ) == "subscription"
    assert module.customer_error_category("secret", status=401) == "credential"
    assert module.customer_error_category("secret", status=429) == "busy"
    assert module.customer_error_category("secret", status=503) == "connection"
