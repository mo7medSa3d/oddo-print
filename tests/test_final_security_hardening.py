import base64
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def load_crypto():
    import importlib.util

    path = ADDON / "models" / "crypto.py"
    spec = importlib.util.spec_from_file_location("print_gateway_crypto_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def key_b64(byte_value: int) -> str:
    return base64.b64encode(bytes([byte_value]) * 32).decode("ascii")


@pytest.fixture(autouse=True)
def _crypto_env(monkeypatch):
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION", "1")
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64", key_b64(7))


def test_gateway_secret_round_trip_and_unique_nonce():
    crypto = load_crypto()
    first = crypto.encrypt_gateway_api_key("secret-value")
    second = crypto.encrypt_gateway_api_key("secret-value")
    assert first != second
    assert crypto.is_encrypted_gateway_api_key(first)
    assert crypto.gateway_api_key_version(first) == "1"
    assert crypto.decrypt_gateway_api_key(first) == "secret-value"
    assert crypto.decrypt_gateway_api_key(second) == "secret-value"


def test_gateway_secret_rejects_plaintext_and_tampering():
    crypto = load_crypto()
    with pytest.raises(crypto.CredentialDecryptError):
        crypto.decrypt_gateway_api_key("plaintext-secret")
    encrypted = crypto.encrypt_gateway_api_key("secret-value")
    head, version, payload = encrypted.split(":", 2)
    packed = bytearray(crypto._decode(payload))
    packed[-1] ^= 0x01
    tampered = crypto._encode(bytes(packed))
    with pytest.raises(crypto.CredentialDecryptError):
        crypto.decrypt_gateway_api_key(f"{head}:{version}:{tampered}")


def test_gateway_secret_fails_closed_without_deployment_key(monkeypatch):
    crypto = load_crypto()
    monkeypatch.delenv("ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64")
    assert not crypto.credential_encryption_configured()
    with pytest.raises(crypto.CredentialKeyUnavailable):
        crypto.encrypt_gateway_api_key("secret-value")


def test_gateway_secret_wrong_key_fails_authentication(monkeypatch):
    crypto = load_crypto()
    encrypted = crypto.encrypt_gateway_api_key("secret-value")
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64", key_b64(8))
    with pytest.raises(crypto.CredentialDecryptError):
        crypto.decrypt_gateway_api_key(encrypted)


def test_gateway_secret_rotation_reencrypts_with_active_key(monkeypatch):
    crypto = load_crypto()
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION", "1")
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64", key_b64(7))
    legacy = crypto.encrypt_gateway_api_key("secret-value")
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION", "2")
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V2_B64", key_b64(9))
    rotated = crypto.encrypt_gateway_api_key(crypto.decrypt_gateway_api_key(legacy))
    assert crypto.gateway_api_key_version(rotated) == "2"
    assert crypto.decrypt_gateway_api_key(rotated) == "secret-value"
    monkeypatch.setenv("ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION", "1")
    assert crypto.decrypt_gateway_api_key(legacy) == "secret-value"


def test_legacy_plaintext_migration_requires_key_and_forbids_passthrough():
    crypto_source = (ADDON / "models" / "crypto.py").read_text(encoding="utf-8")
    migration_source = (ADDON / "migrations" / "19.0.2.4.0" / "post-migrate.py").read_text(encoding="utf-8")
    assert "Plaintext fallback" not in crypto_source
    assert "plaintext fallback is forbidden" in migration_source
    assert "encrypt_gateway_api_key(value)" in migration_source
    assert "is_encrypted_gateway_api_key(value)" in migration_source


def test_gateway_model_protects_values_on_create_and_write():
    source = (ADDON / "models" / "gateway_config.py").read_text(encoding="utf-8")
    write_idx = source.index("def write(self, vals):")
    create_idx = source.index("def create(self, vals_list):")
    assert "_protected_gateway_api_key" in source[write_idx:create_idx]
    assert "_protected_gateway_api_key" in source[create_idx:source.index("def unlink", create_idx)]
    assert "decrypt_gateway_api_key(self.gateway_api_key)" in source


def test_gateway_connection_test_result_uses_independent_cursor():
    source = (ADDON / "models" / "gateway_config.py").read_text(encoding="utf-8")
    start = source.index("def _write_test_result_if_current")
    end = source.index("def action_test_connection", start)
    body = source[start:end]
    assert "self.env.registry.cursor()" in body
    assert "config.with_context(skip_enabled_sync=True).write(values)" in body
    assert "cr.commit()" in body
    assert "FOR UPDATE NOWAIT" in body
    assert "self.env.cr.execute(" not in body
    assert "serialization conflict cannot abort the whole Odoo request" in body


def test_odoo_dynamic_table_identifiers_are_composed_safely():
    sources = list(ADDON.rglob("*.py"))
    assert sources
    for path in sources:
        source = path.read_text(encoding="utf-8")
        assert "% self._table" not in source
        assert "{self._table}" not in source
        assert "f\"SELECT" not in source
        assert "f'SELECT" not in source

    for path in (
        ADDON / "models" / "gateway_config.py",
        ADDON / "migrations" / "19.0.2.3.0" / "post-migrate.py",
    ):
        source = path.read_text(encoding="utf-8")
        assert "psycopg2 import sql" in source
        assert "sql.Identifier(" in source

def test_ci_carries_failing_supply_chain_gates():
    workflow = read(".github/workflows/ci.yml")
    assert "- name: npm supply-chain audit" in workflow
    assert "          npm audit" in workflow
    assert "go install golang.org/x/vuln/cmd/govulncheck@v1.8.0" in workflow
    assert '"$(go env GOPATH)/bin/govulncheck" ./...' in workflow
    assert "- name: Rust supply-chain audit" in workflow
    assert "cargo install cargo-audit --version 0.22.2 --locked" in workflow
    assert "          cargo audit" in workflow
    assert "|| true" not in workflow[workflow.index("- name: npm supply-chain audit"):workflow.index("- name: Typecheck")]
    assert "|| true" not in workflow[workflow.index("- name: Rust supply-chain audit"):workflow.index("- name: Typecheck")]

def test_tauri_renderer_cannot_supply_authorization_headers():
    rust = (ROOT / "src-tauri" / "src" / "commands.rs").read_text(encoding="utf-8")
    assert 'name.eq_ignore_ascii_case("authorization")' in rust
    assert 'name.eq_ignore_ascii_case("cookie")' in rust
    assert 'current_manager_token()' in rust
    assert 'request = request.bearer_auth(token)' in rust


def test_tauri_manager_tokens_never_enter_webview_storage():
    ipc = (ROOT / "src" / "desktop" / "lib" / "ipc.ts").read_text(encoding="utf-8")
    rust = (ROOT / "src-tauri" / "src" / "commands.rs").read_text(encoding="utf-8")
    assert 'invoke("clear_manager_session")' in ipc
    assert "sessionStorage.setItem" not in ipc
    assert "localStorage.setItem" not in ipc
    assert "refreshToken?: string" in ipc
    assert 'object.remove("accessToken")' in rust
    assert 'object.remove("refreshToken")' in rust

def test_nextjs_has_explicit_csp():
    source = (ROOT / "src" / "server" / "content-security-policy.ts").read_text(encoding="utf-8")
    for directive in ("default-src", "script-src", "style-src", "img-src", "connect-src", "font-src", "frame-ancestors", "object-src", "base-uri", "form-action"):
        assert directive in source
    assert "frame-ancestors 'none'" in source
    assert "object-src 'none'" in source
    assert "form-action 'self'" in source
    assert "script-src 'self' 'nonce-" in source
    assert "'strict-dynamic'" in source
    assert "script-src 'self' 'unsafe-inline'" not in source


def test_manifest_declares_crypto_dependency_and_migration_version():
    manifest = (ADDON / "__manifest__.py").read_text(encoding="utf-8")
    assert "'version': '19.0.2.10.0'" in manifest
    assert "'cryptography'" in manifest
    assert (ADDON / "migrations" / "19.0.2.4.0" / "post-migrate.py").exists()
    assert (ADDON / "migrations" / "19.0.2.10.0" / "post-migrate.py").exists()


def test_credential_key_file_provider_and_deployment_template_are_safe():
    crypto = load_crypto()
    with __import__("tempfile").TemporaryDirectory() as d:
        key_path = Path(d) / "credential-key"
        key_path.write_text(key_b64(11), encoding="utf-8")
        import os
        os.environ.pop("ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64", None)
        os.environ["ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64_FILE"] = str(key_path)
        encrypted = crypto.encrypt_gateway_api_key("mounted-secret")
        assert crypto.decrypt_gateway_api_key(encrypted) == "mounted-secret"

    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert "GATEWAY_JWT_SECRET=" in example
    assert "DATABASE_URL=postgresql://user:password@127.0.0.1:5432/print_gateway" in example
    assert "sk_live_" not in example and "sk_test_" not in example


def test_deployment_document_matches_declared_toolchain_contract():
    deployment = (ROOT / "DEPLOYMENT.md").read_text(encoding="utf-8")
    assert "| Go | 1.26 (agent build) |" in deployment
    assert "`GATEWAY_JWT_SECRET`" in deployment
    assert "`APP_BASE_URL`" in deployment
    assert "`SESSION_SECRET`" not in deployment

def test_job_timeline_is_workspace_manager_scoped_not_agent_console_scoped():
    route = read("src/app/api/jobs/[id]/timeline/route.ts")
    assert 'import { validateWorkspaceManager } from "../../../../../lib/manager-auth";' in route
    assert "validateConsoleAuth" not in route
    assert "const tenantId = auth.tenantId;" in route


def test_tauri_manager_login_tokens_stay_inside_rust_boundary():
    rust = read("src-tauri/src/commands.rs")
    ipc = read("src/desktop/lib/ipc.ts")
    assert 'object.remove("accessToken")' in rust
    assert 'object.remove("refreshToken")' in rust
    assert 'path == "/api/auth/manager/login"' in rust
    assert "(isTauri && !data.accessToken)" in ipc
    assert 'X-Refresh-Token' not in ipc


def test_odoo_activation_can_always_disable_but_enable_is_subscription_gated():
    route = read("src/app/api/odoo/configuration/route.ts")
    assert "if (enabled) {" in route
    assert "await requireTenantBillingAccess(tx, apiKey.tenantId);" in route
    assert 'code: error.code' in route
    assert 'status: 403' in route
    assert 'const updated = await db.transaction(async (tx) =>' in route


def test_settings_does_not_duplicate_first_class_operational_pages():
    page = read("src/app/settings/page.tsx")
    assert 'id: "members"' not in page
    assert 'id: "billing"' not in page
    assert 'id: "integrations"' not in page
    assert 'href="/team"' not in page
    assert 'href="/billing"' not in page
    assert 'href="/api-keys"' not in page


def test_agent_http_transport_has_one_yasser_opt_in_and_no_legacy_odoo_alias():
    config = read("agent/internal/config/config.go")
    pairing = read("agent/internal/agent/pairing.go")
    cli = read("agent/cmd/cli/main.go")
    example = read("agent/configs/config.yaml.example")
    assert "func ValidateServerURL(raw string) error" in config
    assert "YASSER_AGENT_ALLOW_INSECURE_HTTP" in config
    assert "ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP" not in config
    assert "func validateServerURL" not in pairing
    assert "func validateServerURL" not in cli
    assert "config.ValidateServerURL(serverURL)" in pairing
    assert "config.ValidateServerURL(*serverURL)" in cli
    assert "ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP" not in pairing + cli + example


def test_public_product_branding_has_no_stale_gateway_name_in_console_shell():
    shell = read("src/components/AppShell.tsx")
    layout = read("src/app/layout.tsx")
    ipc = read("src/desktop/lib/ipc.ts")
    assert 'brandSubtitle="Cloud Printing Platform"' in shell
    assert 'title: "Yasser — Cloud Printing Platform"' in layout
    assert 'yasser-print-manager-auth-changed' in ipc
    assert 'Odoo Print Gateway' not in shell + layout
    assert 'odoo-print-manager-auth-changed' not in ipc


def test_windows_builder_prerequisites_match_repository_toolchain_contract():
    script = read("scripts/build-windows-installer.ps1")
    assert "Node.js >= 24.15.0" in script
    assert "Go 1.26+" in script
    assert "function Assert-MinVersion" in script
    assert '([version]"24.15.0") (& node --version)' in script
    assert '([version]"1.26.0") (& go version)' in script
    assert 'rust-toolchain.toml' in script
    assert 'pinned repository toolchain' in script
    assert '$rustActual -ne $rustToolchain' in script
    assert "Node.js >= 22 LTS" not in script
    assert "Go >= 1.21" not in script



def test_tauri_production_csp_is_strict_and_dev_exceptions_are_isolated():
    import json

    config = json.loads(read("src-tauri/tauri.conf.json"))
    security = config["app"]["security"]
    production = security["csp"]
    development = security["devCsp"]

    assert "script-src 'self';" in production
    assert "style-src 'self';" in production
    assert "'unsafe-inline'" not in production
    assert "localhost:*" not in production
    assert "127.0.0.1:*" not in production
    assert "ipc:" in production
    assert "http://ipc.localhost" in production

    assert "'unsafe-inline'" in development
    assert "http://localhost:*" in development
    assert "http://127.0.0.1:*" in development

    index = read("src/desktop/index.html")
    assert "<script src=\"./theme-init.js\"></script>" in index
    assert '<link rel="stylesheet" href="./theme-init.css"/>' in index
    assert "<script>" not in index
    assert "<style>" not in index

    theme_js = read("src/desktop/public/theme-init.js")
    theme_css = read("src/desktop/public/theme-init.css")
    assert "localStorage.getItem(\"theme\")" in theme_js
    assert 'data-theme' in theme_js
    assert 'html[data-theme="dark"]' in theme_css


def test_agent_server_url_validation_has_one_canonical_implementation():
    config = read("agent/internal/config/config.go")
    cli = read("agent/cmd/cli/main.go")
    pairing = read("agent/internal/agent/pairing.go")
    assert "func ValidateServerURL" in config
    assert "func validateServerURL" not in cli
    assert "func validateServerURL" not in pairing
    assert "config.ValidateServerURL(*serverURL)" in cli
    assert "config.ValidateServerURL(serverURL)" in pairing


def test_custom_server_only_enables_next_development_mode_for_development_env():
    server = read("server.ts")
    assert 'const dev = process.env.NODE_ENV === "development";' in server
    assert 'const dev = process.env.NODE_ENV !== "production";' not in server

def test_job_timeline_and_dashboard_enforce_data_read_permissions():
    timeline = read("src/app/api/jobs/[id]/timeline/route.ts")
    assert 'requireManagerPermission(auth, "jobs.read")' in timeline

    actions = read("src/app/actions.ts")
    dashboard_start = actions.index("export async function getDashboardState()")
    dashboard_end = actions.find("export async function getDashboardJobs", dashboard_start)
    dashboard = actions[dashboard_start:dashboard_end if dashboard_end != -1 else None]
    for permission in ("agents.read", "printers.read", "jobs.read"):
        assert f'requireManagerPermission(manager, "{permission}")' in dashboard

    page = read("src/app/dashboard/page.tsx")
    assert 'hasManagerPermission(claims, "agents.read")' in page
    assert 'hasManagerPermission(claims, "printers.read")' in page
    assert 'hasManagerPermission(claims, "jobs.read")' in page


def test_agent_heartbeat_cannot_extend_tokenless_legacy_claims():
    heartbeat = read("src/app/api/agent/heartbeat/route.ts")
    assert 'const tokened = pairs.filter((p): p is { jobId: string; claimToken: string } => p.claimToken !== null);' in heartbeat
    assert 'const tokenless = pairs.filter' not in heartbeat
    assert 'isNull(printJobs.claimToken)' not in heartbeat


def test_agent_status_updates_require_a_live_claim_token_and_expired_reconciliation_requires_delivery_evidence():
    jobs_route = read("src/app/api/agent/jobs/route.ts")
    maintenance = read("src/lib/job-maintenance.ts")
    assert 'if (requestedStatus !== "expired") {' in jobs_route
    assert '!job.claimToken || !claimToken || claimToken !== job.claimToken' in jobs_route
    assert 'EXPIRED_JOB_ATTEMPT_NOT_RECONCILIABLE' in jobs_route
    assert '!job.deliveredAt || !expiredLateSuccessMarker' in jobs_route
    assert "WHEN status='printing' AND claim_token IS NOT NULL THEN claim_token" in maintenance
    assert "WHEN status='claimed' AND claim_token IS NOT NULL" in maintenance
    assert "AND expires_at <= now() - interval '5 minutes'" in maintenance



def test_operator_reprint_excludes_gateway_success_jobs():
    route = read("src/app/api/jobs/[id]/reprint/route.ts")
    actions = read("src/app/actions.ts")
    dashboard = read("src/app/dashboard/dashboard-client.tsx")

    assert 'if (job.status === "success")' in route
    assert 'code: "JOB_REPRINT_NOT_ALLOWED"' in route
    assert 'if (job.status === "success")' in actions
    assert 'Successful jobs are not eligible for operator reprint' in actions
    assert 'selectedJob.status.toLowerCase() !== "success"' in dashboard


def test_agent_pre_execution_requeue_requires_no_delivery_evidence():
    jobs_route = read("src/app/api/agent/jobs/route.ts")
    anchor = jobs_route.index('if (requestedStatus === "queued" && currentStatus === "claimed")')
    block_end = jobs_route.index('return NextResponse.json({ success: true, status: "queued"', anchor)
    block = jobs_route[anchor:block_end]
    assert 'isNull(printJobs.deliveredAt)' in block
    assert 'isNull(printJobs.ackedAt)' in block


def test_late_success_failure_markers_preserve_the_attempt_fence():
    jobs_route = (ROOT / "src" / "app" / "api" / "agent" / "jobs" / "route.ts").read_text(encoding="utf-8")
    maintenance = (ROOT / "src" / "lib" / "job-maintenance.ts").read_text(encoding="utf-8")
    status = (ROOT / "src" / "lib" / "job-status.ts").read_text(encoding="utf-8")
    assert "export const LATE_SUCCESS_ERROR_MARKERS" in status
    assert "LATE_SUCCESS_ERROR_MARKERS.some((marker) => nextError?.startsWith(marker))" in jobs_route
    assert "!retainsLateSuccessFence" in jobs_route
    assert "claim_token=CASE WHEN expires_at <= now() THEN NULL ELSE claim_token END" in maintenance
    assert "AGENT_EXECUTION_TIMEOUT" in maintenance
    assert "JOB_EXPIRED_DURING_PRINT" in maintenance


def test_odoo_transport_fallback_fails_closed_after_dispatch_ambiguity():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    marker = "except requests.RequestException as exc:"
    start = jobs.index(marker)
    end = jobs.index('except (ValueError, RuntimeError, ValidationError) as exc:', start)
    generic = jobs[start:end]
    assert "_record_ambiguous_submission" in generic
    assert '"status": "queued"' not in generic
    assert "break" in generic


def test_odoo_terminal_reconciliation_accepts_only_explicit_gateway_markers():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    assert "def _needs_gateway_status_reconciliation" in jobs
    assert "LATE_SUCCESS_POST_EXPIRATION:" in jobs
    assert "job.status == \"unknown\"" in jobs
    assert "AGENT_EXECUTION_TIMEOUT" in jobs
    assert "UNKNOWN_SUBMISSION_OUTCOME" in jobs


def test_odoo_runtime_discovery_fails_closed_on_missing_lifecycle():
    source = read("odoo_addons/print_gateway/controllers/runtime_printers.py")
    assert "lifecycle = agent.get('lifecycle') if isinstance(agent.get('lifecycle'), str) else ''" in source
    assert "lifecycle = printer.get('lifecycle') if isinstance(printer.get('lifecycle'), str) else ''" in source
    assert "else 'active'" not in source


def test_odoo_status_and_idempotency_surfaces_exclude_internal_manager_jobs_but_survive_rotation():
    route = read("src/app/api/print/jobs/route.ts")
    assert "isNotNull(printJobs.apiKeyId)" in route
    # The GET endpoint and every idempotency reuse lookup must not require the
    # current API-key ID; old Odoo jobs remain readable after key rotation.
    assert "eq(printJobs.apiKeyId, odoo.id)" not in route
    # The reused-job lookup must retain the Odoo-originated boundary as well.
    reused_start = route.index("if (result.isReused)")
    reused_end = route.index("return NextResponse.json({\n      jobId:", reused_start)
    assert "isNotNull(printJobs.apiKeyId)" in route[reused_start:reused_end]


def test_odoo_force_reprint_includes_failed_unknown_outcomes():
    model = read("odoo_addons/print_gateway/models/print_job.py")
    view = read("odoo_addons/print_gateway/views/print_job_views.xml")
    assert 'row.status in ("partial", "unknown") or (row.status == "failed" and row.physical_outcome == "unknown")' in model
    assert 'invisible="status not in (\'partial\', \'unknown\', \'failed\') or (status == \'failed\' and physical_outcome != \'unknown\')"' in view



def test_odoo_ambiguous_submission_has_idempotency_key_recovery_path():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    route = read("src/app/api/print/jobs/route.ts")
    assert 'params={"idempotencyKey": job._gateway_idempotency_key()}' in jobs
    assert 'job.status == "unknown" and str(job.last_error or "").startswith("UNKNOWN_SUBMISSION_OUTCOME:")' in jobs
    assert 'const idempotencyKey = params.get("idempotencyKey")?.trim();' in route
    assert "isNotNull(printJobs.apiKeyId)" in route


def test_odoo_cron_reconciles_ambiguous_submissions_without_stale_not_found_writes():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    cron_start = jobs.index("def cron_sync_status")
    cron = jobs[cron_start:]
    assert "gateway_job_id IS NULL" in cron
    assert 'last_error LIKE \'UNKNOWN_SUBMISSION_OUTCOME:%%\'' in cron
    assert 'def _lookup_gateway_job_for_ambiguous_submission(self, job):' in jobs
    assert 'params={"idempotencyKey": job._gateway_idempotency_key()}' in jobs
    assert 'self._mark_gateway_job_missing(' in jobs
    assert 'job.write({"gateway_job_id": remote_id.strip(), "next_retry_at": False})' in jobs


def test_odoo_gateway_status_reconciliation_uses_authoritative_row_fences():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    assert 'def _lock_status_row(self, job):' in jobs
    assert 'psycopg2_sql.Identifier(self._table)' in jobs
    assert 'FOR UPDATE' in jobs[jobs.index('def _lock_status_row(self, job):'):jobs.index('def _advance_status(self, job, target, values):')]
    assert 'self._lock_status_row(job)' in jobs[jobs.index('def _advance_status(self, job, target, values):'):jobs.index('    # Payload kinds recognized', jobs.index('def _advance_status(self, job, target, values):'))]
    assert 'def _mark_gateway_job_missing(self, job, message):' in jobs
    assert 'current_status in self._TERMINAL or current_gateway_job_id != job.gateway_job_id' in jobs
    assert 'changed = self._mark_gateway_job_missing(' in jobs


def test_odoo_gateway_status_reconciliation_cannot_downgrade_terminal_state():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    block_start = jobs.index('def _advance_status(self, job, target, values):')
    block_end = jobs.index('    # Payload kinds recognized', block_start)
    block = jobs[block_start:block_end]
    assert 'if job.status in self._TERMINAL and target != job.status:' in block
    assert 'Invalid terminal print job transition' in block
    # The explicit late-success reconciler is the only intended terminal
    # override; generic status sync must remain fenced by the transition matrix.
    assert 'def _apply_gateway_late_success' in jobs


def test_team_invitation_email_ambiguity_does_not_revoke_durable_token():
    route = read("src/app/api/team/invitations/route.ts")
    block_start = route.index('await sendTransactionalEmail({ to: email, subject: "You are invited to Yasser Print Manager"')
    block_end = route.index('return NextResponse.json({ ok: true, id });', block_start)
    block = route[block_start:block_end]
    assert "const revoked = await db.transaction" not in block
    assert "Invitation delivery is temporarily unavailable" in block
    assert "Never revoke the durable invitation" in block


def test_agent_terminal_physical_result_is_fenced_when_sqlite_terminalization_fails():
    agent = read("agent/internal/agent/agent.go")
    tests = read("agent/internal/agent/dispatch_test.go")
    assert "terminalExecution map[string]terminalExecutionResult" in agent
    assert "rememberTerminalExecution(jobID, \"failed\", failureMsg, claimToken)" in agent
    assert "rememberTerminalExecution(jobID, \"success\", \"\", claimToken)" in agent
    assert "already has a process-local terminal physical result; refusing duplicate dispatch" in agent
    assert "TestPhysicalSuccessWithTerminalLedgerWriteFailureCannotReprint" in tests


def test_odoo_submit_lease_cannot_overwrite_concurrent_terminal_state():
    jobs = read("odoo_addons/print_gateway/models/print_job.py")
    persist_start = jobs.index("def _persist_state")
    persist_end = jobs.index("def _advance_status_claimed", persist_start)
    persist = jobs[persist_start:persist_end]
    assert "SELECT status, submit_claim_token" in persist
    assert "if row[0] in self._TERMINAL:" in persist
    assert "A concurrent status reconciler may have terminalized" in persist

    advance_start = jobs.index("def _advance_status_claimed")
    advance_end = jobs.index("def _validate_persisted_payload", advance_start)
    advance = jobs[advance_start:advance_end]
    assert "if current in self._TERMINAL and current != target:" in advance
    assert "submission worker may receive a stale response" in advance


def test_delivery_unknown_path_requires_real_claim_token_contract():
    delivery = read("src/lib/job-delivery.ts")
    fencing = read("src/lib/job-fencing.ts")
    unknown_start = delivery.index("export async function markJobDeliveryUnknown")
    unknown_end = delivery.index("export async function recordJobAck", unknown_start)
    unknown = delivery[unknown_start:unknown_end]
    assert "claimToken: string," in unknown
    assert "claimToken: string | null" not in unknown
    assert "claimToken: string," in fencing[fencing.index("export function fencedDeliveryWrite"):]
