"""Regression contracts for GitHub Actions change-scoped billing gates.

No network, Odoo, Node, or Docker dependency: test the real Bash classifier.
"""
import os
import subprocess
import tempfile
import textwrap
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci-change-scopes.sh"
SCOPES = {
    "app", "agent", "odoo", "docker", "docker_scan",
    "supply", "postgres", "codeql_js", "codeql_py", "codeql_go",
}


def classify(*paths, event=None, before=None, head=None, cwd=None, ref=None):
    with tempfile.NamedTemporaryFile() as output:
        env = dict(os.environ, BASH_ENV="", GITHUB_OUTPUT=output.name)
        if event:
            env["GITHUB_EVENT_NAME"] = event
            env["BEFORE_SHA"] = before or ""
            env["GITHUB_SHA"] = head or ""
            env["GITHUB_REF"] = ref or ""
        command = ["bash", str(SCRIPT)]
        if not event:
            command += ["--paths", *paths]
        subprocess.run(command, env=env, cwd=cwd, check=True, capture_output=True, text=True)
        result = {}
        for entry in Path(output.name).read_text().splitlines():
            key, value = entry.split("=", 1)
            result[key] = value == "true"
        assert set(result) == SCOPES
        return result


def test_docs_only_has_no_expensive_jobs():
    flags = classify("README.md", "docs/setup.md", "OPERATIONS.md")
    assert not any(flags.values())


def test_docs_only_main_push_revalidates_real_app_agent_and_odoo_jobs(tmp_path):
    """A docs-only main HEAD must not be green solely due to skipped jobs."""
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path,
                              capture_output=True, text=True, check=True).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "CI Test")
    (tmp_path / "README.md").write_text("baseline\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "baseline")
    before = git("rev-parse", "HEAD")
    (tmp_path / "README.md").write_text("documentation change\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "docs only")
    head = git("rev-parse", "HEAD")
    flags = classify(event="push", before=before, head=head, ref="refs/heads/main", cwd=tmp_path)
    assert flags["app"] and flags["agent"] and flags["odoo"], flags
    # Container scans remain selected by actual runtime/image changes or weekly schedule.
    assert not flags["docker_scan"] and not flags["supply"], flags


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


def test_hardened_odoo_build_inputs_always_run_the_native_image_gate():
    for path in (
        "Dockerfile.odoo-hardened",
        "scripts/odoo-hardened-entrypoint.py",
        "scripts/odoo-healthcheck.py",
        "scripts/verify-odoo-test-results.py",
        "docs/runtime-hardening/requirements-python312-linux-x86_64.lock",
        "docs/runtime-hardening/build-tools.lock",
        "docs/runtime-hardening/apply-odoo19-pdf-bounds.py",
        "docs/runtime-hardening/container-bases.json",
    ):
        flags = classify(path)
        assert flags["app"] and flags["odoo"] and flags["docker_scan"] and flags["supply"], path
        assert flags["codeql_py"], path


def test_locked_native_container_inputs_run_build_compose_and_image_gates():
    for path in (
        "docs/runtime-hardening/gosu/go.mod",
        "docs/runtime-hardening/gosu/go.sum",
        "docs/runtime-hardening/gosu/dependency_security_test.go",
        "docs/runtime-hardening/caddy/go.mod",
        "docs/runtime-hardening/caddy/go.sum",
        "docs/runtime-hardening/caddy/dependency_security_test.go",
        "docs/runtime-hardening/alpine-security-artifacts.json",
    ):
        flags = classify(path)
        assert flags["docker"] and flags["docker_scan"] and flags["supply"], path
        assert flags["app"] and flags["odoo"] and flags["codeql_py"], path
        assert flags["codeql_go"] and not flags["agent"], path


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


def test_windows_workflow_edit_keeps_release_contract_and_supply_gates_only():
    flags = classify(".github/workflows/build-windows.yml")
    assert flags["app"] and flags["supply"]
    assert not any(flags[name] for name in (
        "agent", "odoo", "docker", "docker_scan", "postgres",
        "codeql_js", "codeql_py", "codeql_go",
    ))


def test_docker_workflow_edit_verifies_runtime_and_image_security():
    flags = classify(".github/workflows/docker.yml")
    assert flags["app"] and flags["docker"] and flags["docker_scan"] and flags["supply"]
    assert not flags["agent"] and not flags["odoo"] and not flags["postgres"]


def test_proxy_acceptance_changes_rerun_the_docker_boundary():
    for path in ("scripts/check-proxy-boundary.py", "tests/test_ci_proxy_boundary.py"):
        flags = classify(path)
        assert flags["app"] and flags["docker"] and flags["codeql_py"], path


def test_release_orchestration_changes_rerun_the_docker_runtime_gate():
    for path in ("scripts/deploy-compose.sh", "tests/test_compose_release_orchestration.py",
                 "scripts/check-compose-build-contexts.py", "tests/test_compose_build_contexts.py"):
        flags = classify(path)
        assert flags["app"] and flags["docker"] and flags["supply"], path


def test_audit_fixture_changes_rerun_the_supply_chain_gate():
    for path in ("scripts/verify-npm-audit-fixture.mjs", "tests/test_ci_audit_fixture.py"):
        flags = classify(path)
        assert flags["app"] and flags["supply"], path


def test_moving_runtime_source_into_docs_still_checks_the_deleted_source(tmp_path):
    def git(*arguments):
        return subprocess.run(["git", *arguments], cwd=tmp_path, check=True,
                              capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "CI Test")
    (tmp_path / "src/lib").mkdir(parents=True)
    (tmp_path / "src/lib/security.ts").write_text("export const enabled = true;\n")
    git("add", ".")
    git("commit", "-q", "-m", "runtime source")
    before = git("rev-parse", "HEAD")
    (tmp_path / "docs").mkdir()
    git("mv", "src/lib/security.ts", "docs/retired.md")
    git("commit", "-q", "-m", "move runtime source to documentation")
    flags = classify(event="push", before=before, head=git("rev-parse", "HEAD"), cwd=tmp_path)
    assert flags["app"] and flags["docker"] and flags["codeql_js"], flags


def test_static_security_workflow_edit_rechecks_all_codeql_languages():
    flags = classify(".github/workflows/static-security.yml")
    assert flags["app"] and flags["supply"]
    assert flags["codeql_js"] and flags["codeql_py"] and flags["codeql_go"]
    assert not flags["docker"] and not flags["postgres"]


def test_supply_chain_workflow_edit_rechecks_failure_injection_and_supply():
    flags = classify(".github/workflows/security-supply-chain.yml")
    assert flags["app"] and flags["supply"] and flags["postgres"]
    assert not flags["docker"] and not flags["agent"]


def test_unknown_workflow_must_still_fail_open():
    assert all(classify(".github/workflows/unknown-new-gate.yml").values())


def test_unknown_paths_fail_open():
    assert all(classify("new-language/main.rs").values())


def test_unavailable_push_diff_fails_open():
    # Never skip required security gates when GitHub sends all-zero before SHA.
    flags = classify(event="push", before="0" * 40, head="1" * 40)
    assert all(flags.values())


def test_force_amended_main_runs_all_checks_even_if_only_docs_differ(tmp_path):
    """A rewritten release must validate its full new commit, not only two superseded heads."""
    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=tmp_path, check=True,
            capture_output=True, text=True,
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "CI Test")
    (tmp_path / "README.md").write_text("base\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "base")
    base = git("rev-parse", "HEAD")

    (tmp_path / "Dockerfile").write_text("FROM scratch\n")
    git("add", "Dockerfile")
    git("commit", "-q", "-m", "release")
    superseded_head = git("rev-parse", "HEAD")

    git("reset", "--soft", base)
    (tmp_path / "README.md").write_text("docs edited during amend\n")
    git("add", "README.md", "Dockerfile")
    git("commit", "-q", "-m", "revised release")
    amended_head = git("rev-parse", "HEAD")

    # git diff superseded_head..amended_head contains README only; the new
    # commit still introduces Dockerfile relative to its actual parent.
    assert all(classify(event="push", before=superseded_head, head=amended_head, cwd=tmp_path).values())

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


def test_native_odoo_security_contract_change_must_rerun_the_image_gate():
    flags = classify("tests/ci-image-mirror-current-run.node.test.mjs")
    assert flags["app"] and flags["odoo"] and flags["docker_scan"] and flags["supply"]
    assert flags["codeql_js"] and flags["codeql_py"]
    assert not flags["agent"] and not flags["postgres"]


def test_caddyfile_and_baseline_and_lint_config_scopes():
    caddy_flags = classify("Caddyfile")
    assert caddy_flags["docker"] and caddy_flags["docker_scan"] and caddy_flags["supply"]
    assert not caddy_flags["agent"] and not caddy_flags["odoo"]

    baseline_flags = classify("security/image-vulnerability-baseline.json")
    assert baseline_flags["docker_scan"] and baseline_flags["supply"]
    assert baseline_flags["odoo"]
    assert not baseline_flags["agent"] and not baseline_flags["postgres"]

    lint_flags = classify("eslint.config.mjs", "vitest.config.mts", ".npmrc", "typography/tokens.json")
    assert lint_flags["app"] and lint_flags["codeql_js"]
    assert not lint_flags["agent"] and not lint_flags["odoo"] and not lint_flags["docker_scan"]


def classify_windows(before, head, cwd):
    """Execute the workflow's actual filter, without mirroring its path rules."""
    workflow = (SCRIPT.parents[1] / ".github/workflows/build-windows.yml").read_text()
    step = workflow.split("      - name: Detect Windows-relevant changes\n", 1)[1]
    body = step.split("        run: |\n", 1)[1].split("\n  windows-pr-smoke:", 1)[0]
    with tempfile.NamedTemporaryFile() as output:
        env = dict(os.environ, BASH_ENV="", EVENT_NAME="push", BEFORE_SHA=before,
                   PR_BASE_SHA="", GITHUB_SHA=head, GITHUB_OUTPUT=output.name)
        subprocess.run(["bash", "-c", textwrap.dedent(body)], env=env, cwd=cwd,
                       check=True, capture_output=True, text=True)
        return dict(line.split("=", 1) for line in Path(output.name).read_text().splitlines())


def windows_git_fixture(tmp_path):
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True,
                              capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "ci@example.com")
    git("config", "user.name", "CI Test")
    (tmp_path / "README.md").write_text("base\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "base")
    return git, git("rev-parse", "HEAD")


def test_windows_rewritten_push_cannot_hide_native_changes_behind_docs_only_diff(tmp_path):
    git, base = windows_git_fixture(tmp_path)
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent/main.go").write_text("package main\n")
    git("add", "agent/main.go")
    git("commit", "-q", "-m", "native change whose CI may still be running")
    superseded_head = git("rev-parse", "HEAD")

    git("checkout", "-q", "-b", "replacement", base)
    (tmp_path / "agent").mkdir(exist_ok=True)
    (tmp_path / "agent/main.go").write_text("package main\n")
    (tmp_path / "README.md").write_text("docs edited while replacing the native commit\n")
    git("add", "README.md", "agent/main.go")
    git("commit", "-q", "-m", "replacement native change")
    replacement_head = git("rev-parse", "HEAD")

    assert git("diff", "--name-only", superseded_head, replacement_head) == "README.md"
    assert classify_windows(superseded_head, replacement_head, tmp_path) == {
        "windows": "true", "agent": "true", "rust": "true",
    }


def test_windows_single_parent_docs_push_still_skips_native_jobs(tmp_path):
    git, base = windows_git_fixture(tmp_path)
    (tmp_path / "README.md").write_text("ordinary docs update\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "docs")
    assert classify_windows(base, git("rev-parse", "HEAD"), tmp_path) == {
        "windows": "false", "agent": "false", "rust": "false",
    }

