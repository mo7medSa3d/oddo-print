"""Regression contracts for GitHub Actions change-scoped billing gates.

No network, Odoo, Node, or Docker dependency: test the real Bash classifier.
"""
import os
import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci-change-scopes.sh"
SCOPES = {
    "app", "agent", "odoo", "docker", "docker_scan",
    "supply", "postgres", "codeql_js", "codeql_py", "codeql_go",
}


def classify(*paths, event=None, before=None, head=None):
    with tempfile.NamedTemporaryFile() as output:
        env = dict(os.environ, GITHUB_OUTPUT=output.name)
        if event:
            env["GITHUB_EVENT_NAME"] = event
            env["BEFORE_SHA"] = before or ""
            env["GITHUB_SHA"] = head or ""
        command = ["bash", str(SCRIPT)]
        if not event:
            command += ["--paths", *paths]
        subprocess.run(command, env=env, check=True, capture_output=True, text=True)
        result = {}
        for entry in Path(output.name).read_text().splitlines():
            key, value = entry.split("=", 1)
            result[key] = value == "true"
        assert set(result) == SCOPES
        return result


def test_docs_only_has_no_expensive_jobs():
    flags = classify("README.md", "docs/setup.md", "OPERATIONS.md")
    assert not any(flags.values())


def test_odoo_model_runs_odoo_and_cross_layer_contracts_but_not_go_or_docker():
    flags = classify("odoo_addons/print_gateway/models/print_intent.py")
    assert flags["odoo"] and flags["app"] and flags["codeql_py"]
    assert not flags["agent"] and not flags["docker"] and not flags["codeql_go"]
    assert not flags["codeql_js"]


def test_gateway_typescript_runs_only_relevant_languages():
    flags = classify("src/lib/print-job-service.ts")
    assert flags["app"] and flags["docker"] and flags["codeql_js"]
    assert not flags["codeql_go"] and not flags["codeql_py"]
    assert not flags["odoo"] and not flags["agent"]


def test_agent_change_runs_agent_and_dependency_safety():
    flags = classify("agent/internal/agent/agent.go")
    assert flags["app"] and flags["agent"] and flags["codeql_go"] and flags["supply"]
    assert not flags["odoo"] and not flags["docker_scan"]


def test_docker_base_change_requires_image_rescan():
    flags = classify("Dockerfile", "docker-compose.yml")
    assert flags["docker"] and flags["docker_scan"] and flags["supply"]
    assert not flags["agent"] and not flags["odoo"]


def test_postgres_change_keeps_database_failure_injection():
    flags = classify("drizzle/0081_add_constraint.sql")
    assert flags["app"] and flags["postgres"] and flags["docker"]
    assert not flags["agent"]


def test_combined_changes_union_the_relevant_scopes():
    flags = classify("agent/go.mod", "odoo_addons/print_gateway/models/print_intent.py")
    assert flags["agent"] and flags["odoo"] and flags["app"]
    assert flags["codeql_go"] and flags["codeql_py"]


def test_workflow_and_classifier_modifications_run_all_gates():
    for name in (".github/workflows/ci.yml", "scripts/ci-change-scopes.sh"):
        assert all(classify(name).values())


def test_unknown_paths_fail_open():
    assert all(classify("new-language/main.rs").values())


def test_unavailable_push_diff_fails_open():
    # Never skip required security gates when GitHub sends all-zero before SHA.
    flags = classify(event="push", before="0" * 40, head="1" * 40)
    assert all(flags.values())


def test_manual_or_merge_queue_runs_all_gates():
    for event in ("workflow_dispatch", "merge_group"):
        flags = classify(event=event)
        assert all(flags.values())


def test_weekly_security_scans_skip_unchanged_builds():
    flags = classify(event="schedule")
    assert flags["supply"] and flags["docker_scan"]
    assert flags["codeql_js"] and flags["codeql_py"] and flags["codeql_go"]
    assert not flags["docker"] and not flags["postgres"]
    assert not flags["app"] and not flags["agent"] and not flags["odoo"]
