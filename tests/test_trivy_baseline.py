"""The scanner baseline must fail on new, altered, or expired findings."""

import importlib.util
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check-trivy-baseline.py'
SPEC = importlib.util.spec_from_file_location('check_trivy_baseline', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def report(cve='CVE-A', package='stdlib', severity='HIGH'):
    return {'runs': [{'results': [{'ruleId': cve,
        'message': {'text': f'Package: {package}\nInstalled Version: 1\nSeverity: {severity}\nFixed Version: 2'}}]}]}


def baseline(expires='2026-10-26'):
    return {'images': {'image@sha256:fixed': {'expires': expires, 'findings': [['CVE-A', 'stdlib', 'HIGH']]}}}


def test_only_reviewed_finding_for_exact_image_and_severity_passes():
    bad, allowed = MODULE.check(report(), 'image@sha256:fixed', baseline(), date(2026, 10, 19))
    assert not bad and len(allowed) == 1


def test_new_cve_package_and_severity_all_block():
    for finding in (report(cve='CVE-B'), report(package='other'), report(severity='CRITICAL')):
        bad, _ = MODULE.check(finding, 'image@sha256:fixed', baseline(), date(2026, 10, 19))
        assert len(bad) == 1


def test_expiry_blocks_existing_inherited_vulnerabilities():
    bad, allowed = MODULE.check(report(), 'image@sha256:fixed', baseline(), date(2026, 10, 27))
    assert len(bad) == 1 and not allowed


def test_unknown_digest_and_missing_sarif_fail_closed():
    import pytest
    with pytest.raises(ValueError):
        MODULE.check(report(), 'image@sha256:changed', baseline(), date(2026, 10, 19))
    with pytest.raises(ValueError):
        MODULE.check({}, 'image@sha256:fixed', baseline(), date(2026, 10, 19))


def test_malformed_findings_fail_even_with_a_reviewed_image():
    bad, _ = MODULE.check({'runs': [{'results': [{'ruleId': 'CVE-A', 'message': {'text': ''}}]}]},
                          'image@sha256:fixed', baseline(), date(2026, 10, 19))
    assert len(bad) == 1
