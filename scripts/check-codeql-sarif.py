#!/usr/bin/env python3
"""Block High/Critical CodeQL security findings without a Code Scanning license.

CodeQL analysis still runs and its SARIF is uploaded as a CI artifact. This
strict local gate is useful for private repositories where GitHub Code
Security cannot accept SARIF uploads.
"""

import json
import math
import sys
from pathlib import Path


MIN_SECURITY_SCORE = 7.0  # CodeQL/GitHub High and Critical threshold.


def find_sarif_files(location: Path) -> list[Path]:
    if location.is_file():
        return [location] if location.suffix == ".sarif" else []
    if location.is_dir():
        return sorted(location.rglob("*.sarif"))
    return []


def high_security_findings(document: dict) -> list[str]:
    if not isinstance(document, dict) or not isinstance(document.get("runs"), list) or not document["runs"]:
        raise ValueError("SARIF document has no runs")
    findings = []
    for run in document["runs"]:
        if not isinstance(run, dict):
            raise ValueError("Invalid SARIF run")
        driver = run.get("tool", {}).get("driver", {})
        rules = driver.get("rules", [])
        if not isinstance(rules, list):
            raise ValueError("Invalid SARIF rules")
        by_id = {rule.get("id"): rule for rule in rules if isinstance(rule, dict)}
        for result in run.get("results", []):
            if not isinstance(result, dict):
                raise ValueError("Invalid SARIF result")
            rule = by_id.get(result.get("ruleId"), {})
            index = result.get("ruleIndex")
            if not rule and type(index) is int and 0 <= index < len(rules):
                rule = rules[index]
            properties = rule.get("properties", {}) if isinstance(rule, dict) else {}
            raw_score = properties.get("security-severity")
            if raw_score is None:
                raw_score = result.get("properties", {}).get("security-severity")
            if raw_score is None:
                continue  # Nonsecurity/quality-only query: recorded in artifact.
            try:
                score = float(raw_score)
            except (TypeError, ValueError) as exc:
                raise ValueError("Malformed CodeQL security-severity") from exc
            if not math.isfinite(score) or not 0 <= score <= 10:
                raise ValueError("Invalid CodeQL security-severity")
            if score >= MIN_SECURITY_SCORE:
                findings.append(f"{result.get('ruleId', 'unknown')} ({score:g})")
    return findings


def main(args: list[str]) -> int:
    if len(args) != 1:
        print("Usage: check-codeql-sarif.py SARIF_FILE_OR_DIRECTORY", file=sys.stderr)
        return 2
    files = find_sarif_files(Path(args[0]))
    if not files:
        print("CodeQL SARIF missing; analysis results cannot be verified", file=sys.stderr)
        return 2
    count = 0
    try:
        for path in files:
            document = json.loads(path.read_text(encoding="utf-8"))
            findings = high_security_findings(document)
            count += len(findings)
            for finding in findings[:30]:
                print(f"::error file={path}::CodeQL High/Critical finding: {finding}")
            print(f"CodeQL {path.name}: {len(findings)} High/Critical security finding(s)")
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        print(f"Invalid CodeQL SARIF: {exc}", file=sys.stderr)
        return 2
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
