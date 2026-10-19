"""Regression checks for the local CodeQL artifact-based security gate."""

import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-codeql-sarif.py"
SPEC = importlib.util.spec_from_file_location("check_codeql_sarif", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def report(score=None, rule_id="py/sql-injection"):
    rule = {"id": rule_id, "properties": {}}
    if score is not None:
        rule["properties"]["security-severity"] = str(score)
    return {"version": "2.1.0", "runs": [{"tool": {"driver": {"rules": [rule]}},
            "results": [{"ruleId": rule_id, "ruleIndex": 0}]}]}


def test_high_and_critical_are_blocked(tmp_path):
    filename = tmp_path / "codeql.sarif"
    for score in (7, 8.5, 9.99, 10):
        filename.write_text(json.dumps(report(score)), encoding="utf-8")
        assert MODULE.main([str(filename)]) == 1


def test_medium_and_quality_only_are_reported_but_do_not_block(tmp_path):
    filename = tmp_path / "codeql.sarif"
    for score in (None, 0, 5, 6.99):
        filename.write_text(json.dumps(report(score)), encoding="utf-8")
        assert MODULE.main([str(filename)]) == 0


def test_missing_and_invalid_reports_fail_closed(tmp_path):
    assert MODULE.main([str(tmp_path)]) == 2
    filename = tmp_path / "broken.sarif"
    filename.write_text("not JSON", encoding="utf-8")
    assert MODULE.main([str(filename)]) == 2
    filename.write_text(json.dumps({"runs": []}), encoding="utf-8")
    assert MODULE.main([str(filename)]) == 2
    filename.write_text(json.dumps(report("NaN")), encoding="utf-8")
    assert MODULE.main([str(filename)]) == 2


def test_directory_with_multiple_sarif_runs_is_aggregated(tmp_path):
    (tmp_path / "one.sarif").write_text(json.dumps(report(4)), encoding="utf-8")
    (tmp_path / "two.sarif").write_text(json.dumps(report(9)), encoding="utf-8")
    assert MODULE.main([str(tmp_path)]) == 1
