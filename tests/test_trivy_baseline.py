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


def test_lower_and_unknown_severities_remain_named_blocking_findings():
    for severity in ('UNKNOWN', 'LOW', 'MEDIUM'):
        bad, allowed = MODULE.check(report(severity=severity), 'image@sha256:fixed', baseline(), date(2026, 10, 19))
        assert bad == [f'CVE-A / stdlib / {severity}']
        assert allowed == []


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

def test_odoo_cannot_whitelist_high_critical_or_unknown_severity():
    for severity in ('HIGH', 'CRITICAL', 'UNKNOWN'):
        image = 'yaseir-odoo-hardened:review-20261105'
        policy = {'images': {image: {'expires': '2026-11-08',
                  'findings': [['CVE-A', 'stdlib', severity]]}}}
        bad, allowed = MODULE.check(report(severity=severity), image, policy, date(2026, 10, 26))
        assert bad == [f'forbidden Odoo severity CVE-A / stdlib / {severity}']
        assert allowed == []


def test_odoo_runtime_review_has_no_build_only_packages_and_no_extended_expiry():
    import json
    data = json.loads((Path(__file__).resolve().parents[1] /
                       'security/image-vulnerability-baseline.json').read_text())
    entry = data['images']['yaseir-odoo-hardened:review-20261105']
    assert entry['expires'] == '2026-12-20'
    # The 2026-11-24 reviewed rescan added seven MEDIUM inherited findings.
    assert len(entry['findings']) == 117
    assert {r[2] for r in entry['findings']} <= {'LOW', 'MEDIUM'}
    assert {
        tuple(row) for row in entry['findings']
        if row[0] == 'CVE-2026-82560'
    } == {
        ('CVE-2026-82560', 'libperl5.38t64', 'MEDIUM'),
        ('CVE-2026-82560', 'perl', 'MEDIUM'),
        ('CVE-2026-82560', 'perl-base', 'MEDIUM'),
        ('CVE-2026-82560', 'perl-modules-5.38', 'MEDIUM'),
    }
    assert not ({'python3-pip', 'python3-wheel', 'python3-pdfminer'} &
                {r[1] for r in entry['findings']})


def test_caddy_go_jose_review_is_exact_and_short_lived():
    import json
    data = json.loads((Path(__file__).resolve().parents[1] /
                       'security/image-vulnerability-baseline.json').read_text())
    image = 'yaseir-caddy:ci-go1.26.11'
    entry = data['images'][image]
    assert entry['expires'] == '2026-12-20'
    assert {tuple(row) for row in entry['findings']} == {
        ('GO-2026-5932', 'golang.org/x/crypto', 'UNKNOWN'),
        ('CVE-2026-116585', 'github.com/go-jose/go-jose/v3', 'MEDIUM'),
        ('CVE-2026-116586', 'github.com/go-jose/go-jose/v3', 'MEDIUM'),
        ('CVE-2026-116587', 'github.com/go-jose/go-jose/v3', 'HIGH'),
        ('CVE-2026-128085', 'go.opentelemetry.io/otel/sdk', 'MEDIUM'),
        ('CVE-2026-128085', 'go.opentelemetry.io/otel/sdk/log', 'MEDIUM'),
        ('CVE-2026-128085', 'go.opentelemetry.io/otel/trace', 'MEDIUM'),
    }
    note = data['reviewNotes'][image]
    assert 'does not enable TLS internal' in note
    assert 'Caddy 2.11.9' in note
    assert 'complete Caddy module lock refreshed' in note
