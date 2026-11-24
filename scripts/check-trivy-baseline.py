#!/usr/bin/env python3
"""Fail on new/untriaged container findings; temporarily track pinned upstream CVEs.

Never skip Trivy itself. The reviewed baseline applies only to the exact
image digest and CVE/package/severity combination and expires automatically.
Every finding remains visible in an uploaded SARIF artifact.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

BASELINE_PATH = Path(__file__).resolve().parents[1] / 'security' / 'image-vulnerability-baseline.json'
PACKAGE = re.compile(r'^Package: ([^\n]+)', re.MULTILINE)


def check(report: dict, image: str, baseline: dict, today: date) -> tuple[list[str], list[str]]:
    if not isinstance(report, dict) or not isinstance(report.get('runs'), list) or not report['runs']:
        raise ValueError('Invalid or empty Trivy SARIF report')
    entry = baseline.get('images', {}).get(image)
    if not isinstance(entry, dict):
        raise ValueError('Image digest is not in the reviewed Trivy baseline: ' + image)
    rows = entry.get('findings')
    if not isinstance(rows, list):
        raise ValueError('Invalid baseline finding list')
    permitted = {(r[0], r[1], r[2]) for r in rows if isinstance(r, list) and len(r) == 3}
    if len(permitted) != len(rows):
        raise ValueError('Invalid or repeated baseline finding')
    expiry = date.fromisoformat(entry['expires'])
    unreviewed = []
    reviewed = []
    for run in report['runs']:
        if not isinstance(run, dict) or not isinstance(run.get('results'), list):
            raise ValueError('Trivy SARIF run is missing results')
        for result in run['results']:
            if not isinstance(result, dict):
                raise ValueError('Malformed Trivy finding')
            rule = result.get('ruleId')
            msg = result.get('message', {}).get('text', '')
            pkg_match = PACKAGE.search(msg)
            severity_match = re.search(r'^Severity: (UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL)\s*$', msg, re.MULTILINE)
            if not isinstance(rule, str) or not pkg_match or not severity_match:
                unreviewed.append(f'unrecognized SARIF result: {rule}')
                continue
            finding = (rule, pkg_match.group(1), severity_match.group(1))
            # Odoo's public baseline must never authorize an unknown or
            # high-impact finding, even if a future edit adds it to JSON.
            if image.startswith('yaseir-odoo-hardened:') and finding[2] in ('UNKNOWN', 'HIGH', 'CRITICAL'):
                unreviewed.append('forbidden Odoo severity ' + ' / '.join(finding))
            elif finding not in permitted:
                unreviewed.append(' / '.join(finding))
            elif today > expiry:
                unreviewed.append('expired ' + ' / '.join(finding))
            else:
                reviewed.append(' / '.join(finding))
    return unreviewed, reviewed


def main(args: list[str]) -> int:
    if len(args) != 2:
        print('Usage: check-trivy-baseline.py REPORT.sarif PINNED_IMAGE_REF', file=sys.stderr)
        return 2
    try:
        report = json.loads(Path(args[0]).read_text(encoding='utf-8'))
        baseline = json.loads(BASELINE_PATH.read_text(encoding='utf-8'))
        unreviewed, reviewed = check(report, args[1], baseline, date.today())
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f'Invalid Trivy security baseline or scan report: {exc}', file=sys.stderr)
        return 2
    for row in unreviewed:
        print('::error::New, unreviewed or expired image vulnerability: ' + row)
    if reviewed:
        print(f'::warning::{len(reviewed)} inherited vulnerabilities remain in pinned upstream image; review the SARIF artifact and update the image before the baseline expires')
    print(f'Trivy: {len(reviewed)} time-bound reviewed upstream findings, {len(unreviewed)} blocking findings')
    return 1 if unreviewed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
