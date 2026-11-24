"""Run the real npm vulnerability-fixture CI step with controlled registry results."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
ADVISORY = "https://github.com/advisories/GHSA-35jh-r3h4-6jhm"


def vulnerable_report(package="lodash", advisory=ADVISORY):
    return {
        "auditReportVersion": 2,
        "vulnerabilities": {
            package: {
                "name": package, "severity": "high", "isDirect": True,
                "via": [{"name": package, "url": advisory, "severity": "high"}],
                "nodes": [f"node_modules/{package}"],
            },
        },
        "metadata": {"vulnerabilities": {"high": 1, "critical": 0}},
    }


def run_fixture_step(tmp_path, status, report):
    workflow = (ROOT / ".github/workflows/security-supply-chain.yml").read_text()
    step = workflow.split("      - name: Verify npm high-severity audit gate with known vulnerable fixture\n", 1)[1]
    block = step.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0]
    shell = "\n".join(line.removeprefix("          ") for line in block.splitlines())
    npm = tmp_path / "npm"
    npm.write_text(f"#!{sys.executable}\n" + """
import json, os, pathlib, sys
if sys.argv[1] == "install":
    pathlib.Path("package-lock.json").write_text(json.dumps({
        "lockfileVersion": 3,
        "packages": {"node_modules/lodash": {"version": "4.17.19"}},
    }))
    sys.exit(0)
if sys.argv[1] == "audit":
    print(os.environ["TEST_AUDIT_REPORT"])
    sys.exit(int(os.environ["TEST_AUDIT_STATUS"]))
sys.exit(99)
""")
    npm.chmod(0o700)
    env = {**os.environ, "BASH_ENV": "", "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
           "TEST_AUDIT_STATUS": str(status),
           "TEST_AUDIT_REPORT": report if isinstance(report, str) else json.dumps(report)}
    return subprocess.run(["bash", "-euo", "pipefail", "-c", shell], cwd=ROOT,
                          env=env, text=True, capture_output=True, timeout=15)


@pytest.mark.parametrize("status,report", [
    (1, "npm error network unavailable"),
    (1, {"error": {"code": "ECONNRESET"}}),
    (137, ""),
    (2, vulnerable_report()),
    (0, vulnerable_report()),
    (1, vulnerable_report(package="unrelated-package")),
    (1, vulnerable_report(advisory="https://github.com/advisories/GHSA-unrelated")),
    (1, {"vulnerabilities": {}, "metadata": {"vulnerabilities": {"high": 0, "critical": 0}}}),
])
def test_known_vulnerable_fixture_requires_the_expected_high_advisory(tmp_path, status, report):
    result = run_fixture_step(tmp_path, status, report)
    assert result.returncode != 0, "A process failure without the expected advisory is not vulnerability evidence"


def test_workflow_rejects_network_failures_and_requires_json_advisory_proof():
    workflow = (ROOT / ".github/workflows/security-supply-chain.yml").read_text()
    assert "npm audit --json --audit-level=high" in workflow
    assert 'node scripts/verify-npm-audit-fixture.mjs "$fixture" "$audit_status"' in workflow
    assert "npm audit --audit-level=high 2>&1" not in workflow


def test_known_vulnerable_fixture_accepts_a_real_high_severity_rejection(tmp_path):
    result = run_fixture_step(tmp_path, 1, vulnerable_report())
    assert result.returncode == 0, result.stdout + result.stderr
