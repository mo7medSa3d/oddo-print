"""Report access denials use the explicitly supplied caller's translator."""
from types import SimpleNamespace

import pytest

from test_complete_audit_permissions import AccessError, ValidationError, source_function


@pytest.mark.parametrize("case,error,source", [
    ("missing", ValidationError, "The requested report is unavailable."),
    ("non-pdf", ValidationError, "Only QWeb PDF reports can be sent to the Print Gateway."),
    ("group-denied", AccessError, "You are not allowed to view or use this report."),
])
def test_report_denial_uses_caller_language_without_request_context(case, error, source):
    translated = []

    def translate(message):
        translated.append(message)
        return "رسالة مترجمة: " + message

    caller = SimpleNamespace(
        _=translate, lang="ar_001", is_superuser=lambda: False,
        user=SimpleNamespace(all_group_ids=SimpleNamespace(ids=[1])),
    )
    report = SimpleNamespace(
        report_type="qweb-html" if case == "non-pdf" else "qweb-pdf",
        group_ids=SimpleNamespace(ids=[2]),
    )
    report.sudo = lambda: report
    report.exists = lambda: False if case == "missing" else report
    with pytest.raises(error, match="رسالة مترجمة") as caught:
        source_function("binding.py", "_assert_report_usage_access")(caller, report)
    assert str(caught.value) == "رسالة مترجمة: " + source
    assert translated == [source]
