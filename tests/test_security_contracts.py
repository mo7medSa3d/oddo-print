import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_generated_odoo_api_key_responses_are_not_cacheable():
    for rel in (
        "src/app/api/odoo/keys/route.ts",
        "src/app/api/odoo/keys/[id]/rotate/route.ts",
    ):
        source = read(rel)
        assert '"Cache-Control": "no-store"' in source
        assert "apiKey:" in source


def test_go_service_recovery_does_not_resolve_sc_from_path():
    source = read("agent/cmd/agent/main.go")
    assert 'exec.LookPath("sc.exe")' not in source
    assert 'os.Getenv("SystemRoot")' in source
    assert '"System32", "sc.exe"' in source
    assert 'exec.Command(sc, "failure", serviceName' in source


def test_windows_system_utilities_are_not_path_resolved():
    source = read("src-tauri/src/agent.rs")

    def function_body(name: str) -> str:
        marker = f"fn {name}"
        start = source.index(marker)
        end = source.find("\n}", start)
        return source[start : end if end != -1 else len(source)]

    for fn_name, tool in (
        ("sc_query", "sc"),
        ("is_process_running", "tasklist"),
        ("run_net", "net"),
        ("taskkill_pid", "taskkill"),
    ):
        body = function_body(fn_name)
        assert f'Command::new("{tool}")' not in body

    assert 'system32_exe("sc.exe")' in source
    assert 'system32_exe("net.exe")' in source
    assert 'system32_exe("tasklist.exe")' in source
    assert 'system32_exe("taskkill.exe")' in source


def test_password_reset_flow_does_not_clear_auth_rate_limit():
    source = read("src/app/api/auth/forgot-password/route.ts")
    assert "recordAuthSuccess" not in source
    assert "reserveAuthAttempt" in source


def test_registration_flow_does_not_clear_auth_rate_limit():
    source = read("src/app/api/auth/register/route.ts")
    assert "recordAuthSuccess" not in source
    assert "reserveAuthAttempt" in source
    assert "disposable account creations" in source


def test_manager_login_does_not_mask_identity_lookup_failures_as_invalid_credentials():
    source = read("src/app/api/auth/manager/login/route.ts")
    start = source.index('if (!identity && username.includes("@"))')
    end = source.index("const legacyEnabled", start)
    block = source[start:end]
    assert 'logError("auth.login.user_lookup_failed"' in block
    assert 'NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 })' in block
    # The catch must terminate this branch instead of falling through to the
    # generic INVALID credentials response.
    catch_start = block.index("catch")
    catch_end = block.index("}\n", catch_start) + 2
    assert "NextResponse.json" in block[catch_start:catch_end]
    assert "setRateLimitHeaders" in block[catch_start:catch_end]







def test_platform_owner_routes_distinguish_invalid_auth_from_platform_dependency_failure():
    routes = [p for p in Path(ROOT / "src/app/api/platform").rglob("route.ts") if "requirePlatformOwner(" in p.read_text(encoding="utf-8")]
    assert routes
    for route in routes:
        source = route.read_text(encoding="utf-8")
        assert "PlatformUnauthorizedError" in source, route
        assert "Platform authentication temporarily unavailable" in source, route
        assert "status: 503" in source, route

def test_billing_page_surfaces_print_usage_lookup_failures():
    source = read("src/app/billing/page.tsx")
    assert "billing.print_usage_unavailable" in source
    assert "printUsageUnavailable = true" in source
    assert "Print usage temporarily unavailable" in source

def test_health_metrics_do_not_turn_database_lookup_failures_into_zero_values():
    source = read("src/lib/agent-health.ts")
    assert "queueDataAvailable = false" in source
    assert "printerDataAvailable = false" in source
    assert 'status: "unknown"' in source
    assert 'agent.health.queue_lookup_failed' in source
    assert 'agent.health.printer_lookup_failed' in source


def test_customer_login_rate_limit_clear_failure_is_observable():
    source = read("src/app/api/auth/login/route.ts")
    assert 'auth.login.rate_limit_clear_failed' in source
    assert 'recordAuthSuccess(ip, email).catch((error)' in source

def test_logout_does_not_report_success_when_session_revocation_fails():
    for rel in (
        "src/app/api/auth/logout/route.ts",
        "src/app/api/auth/manager/logout/route.ts",
    ):
        source = read(rel)
        assert "session_revoke_failed" in source
        assert 'revokeFailed ? { ok: false, error: "Logout temporarily unavailable" } : { ok: true }' in source
        assert "status: revokeFailed ? 503 : 200" in source
        assert 'action: "session.revoked"' in source


def test_discovery_rejects_malformed_json_instead_of_defaulting_to_empty_request():
    source = read("src/app/api/agents/[id]/discovery/route.ts")
    assert 'return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });' in source
    assert 'let body: unknown = {}' not in source


def test_certification_does_not_convert_database_errors_into_missing_or_pending_state():
    source = read("src/app/api/printers/[id]/certify/route.ts")
    assert "jobStateLookupFailed = true" in source
    assert 'if (jobStateLookupFailed)' in source
    assert 'print.certification.job_state_lookup_failed' in source
    assert 'print.certification.agent_lookup_failed' in source
    assert 'print.certification.capability_lookup_failed' in source

def test_terminal_claim_credentials_are_cleared_without_breaking_crash_recovery():
    gateway_maintenance = read("src/lib/job-maintenance.ts")
    gateway_delivery = read("src/lib/job-delivery.ts")
    go_queue = read("agent/internal/queue/queue.go")

    for marker in (
        "UNKNOWN_PARTIAL_DELIVERY: claim lease expired",
        "AGENT_EXECUTION_TIMEOUT",
        "exceeded max retries after a stale claim",
    ):
        start = gateway_maintenance.index(marker)
        block = gateway_maintenance[max(0, start - 220): start + 220]
        assert "claim_token=NULL" in block
        assert "claimed_at=NULL" in block

    failed_release = gateway_delivery[gateway_delivery.index("SET status = 'failed'"):gateway_delivery.index("RETURNING id", gateway_delivery.index("SET status = 'failed'"))]
    assert "claim_token = NULL" in failed_release
    assert "claimed_at = NULL" in failed_release

    assert "status == \"success\" || status == \"failed\"" in go_queue
    assert "claim_token = NULL" in go_queue
    mark_start = go_queue.index("func (q *Queue) MarkInterrupted()")
    mark_block = go_queue[mark_start:mark_start + 1800]
    assert "SELECT id, printer_id, COALESCE(claim_token, '')" in mark_block

def test_ui_dependency_failures_are_visible_instead_of_silently_disappearing():
    dashboard = read("src/app/dashboard/dashboard-client.tsx")
    ui = read("src/components/ui.tsx")
    assert "billingUsageError" in dashboard
    assert 'Print usage is temporarily unavailable' in dashboard
    assert "setBillingUsageError(true)" in dashboard
    assert 'setCopyFailed(true)' in ui
    assert "Copy failed" in ui

def test_registration_email_failure_is_observable_not_swallowed():
    """Regression: the verification-email send used to end in a bare ``catch {}``.

    A delivery outage silently produced accounts whose verification link never
    arrives (user stuck pre-verification, no operator trace). Registration
    must still answer the generic 202 (no enumeration, no signup failure on
    email outage), but the failure has to be logged for operators; the
    user-facing recovery path is /api/auth/resend-verification.
    """
    source = read("src/app/api/auth/register/route.ts")
    assert 'logError("auth.register.verification_email_failed"' in source
    # The response contract is unchanged: generic body, 202, and the limiter
    # note must survive (no recordAuthSuccess on the registration path).
    assert source.index('logError("auth.register.verification_email_failed"') < source.rindex("GENERIC, { status: 202 })")


def test_agent_pairing_success_does_not_clear_rate_limit():
    source = read("src/app/api/agent/register/route.ts")
    assert "recordPairingSuccess" not in source
    assert "reservePairingAttempt" in source
    assert "reset the brute-force budget" in source


def test_tauri_gateway_http_transport_contract_matches_branch_mode():
    source = read("src-tauri/src/commands.rs")
    test_branch_mode = "This isolated test branch intentionally accepts remote HTTP" in source

    if test_branch_mode:
        assert 'let remote_http = scheme == "http";' in source
        assert 'if remote_http {' in source
        assert "gateway URL cannot include embedded credentials" in source
        assert "gateway URL cannot include query strings or fragments" in source
    else:
        assert 'if scheme == "http" {' in source
        assert 'let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");' in source
        assert 'if !local {' in source
        assert "Gateway URL must use HTTPS for remote Gateways" in source


def test_production_startup_fails_closed_on_secrets_and_proxy_boundary():
    source = read("server.ts")
    assert "!value || value.length < minLength" in source
    assert 'assertRealSecret("GATEWAY_JWT_SECRET"' in source
    assert "TRUST_PROXY=1 is required when the Gateway binds a non-loopback interface." in source
    assert 'if (!trustProxyEnabled() && !isLoopbackBinding(hostname))' in source
    assert 'assertRealSecret("TRUST_PROXY_SECRET"' in source
    assert "Refusing production startup: APP_BASE_URL must be configured." in source
    assert "APP_BASE_URL must be a clean HTTPS origin." in source
    assert "assertRealSecret(" in source


def test_billing_webhook_binds_identity_before_metadata_tenant_mutation():
    source = read("src/app/api/billing/webhook/route.ts")
    assert "billingIdentityConflict" in source
    assert "stripeSubscriptionId" in source
    assert "stripeCustomerId" in source
    assert 'return NextResponse.json({ received: true, ignored: true })' in source
    assert "if (billingIdentityConflict)" in source
    assert "processedAt: sql`clock_timestamp()`" in source


def test_tenant_entitlements_fail_closed_without_active_subscription():
    source = read("src/lib/entitlements.ts")
    assert "TenantSubscriptionRequiredError" in source
    assert "TENANT_SUBSCRIPTION_REQUIRED" in source
    assert "if (!result.rows[0]) throw new TenantSubscriptionRequiredError()" in source
    assert 'value === "unlimited"' in source
    assert "TenantEntitlementConfigError" in source


def test_plan_catalog_uses_shared_canonical_entitlement_normalizer():
    source = read("scripts/provision-plans.ts")
    assert 'normalizePlanEntitlements(plan.entitlements)' in source
    helper = read("src/lib/entitlements.ts")
    assert '"max_agents"' in helper
    assert '"max_printers"' in helper
    assert '"max_jobs_per_minute"' in helper
    assert '"max_concurrent_jobs"' in helper
    assert 'value === "unlimited"' in helper
    assert 'must be a positive integer or "unlimited"' in helper



def test_failover_binding_is_same_route_scope_and_execution_rechecks_it():
    binding = read("odoo_addons/print_gateway/models/binding.py")
    assert "('branch_id', '=', branch_id)" in binding
    assert "def _check_fallback_binding_scope" in binding
    assert "fallback.company_id != record.company_id or fallback.branch_id != record.branch_id" in binding
    assert "fallback.destination_type != record.destination_type" in binding
    assert "fallback.destination_ref != record.destination_ref" in binding
    assert "fallback.document_type != record.document_type" in binding

    job = read("odoo_addons/print_gateway/models/print_job.py")
    assert "route_compatible = bool(" in job
    assert "current_binding.destination_ref.display_name == job.destination" in job
    assert "current_binding.document_type == job.document_type" in job
    assert "and route_compatible" in job


def test_odoo_sql_identifiers_never_use_raw_table_name_formatting():
    """Model table names must be composed as SQL identifiers, never interpolated as values."""
    violations = []

    def contains_table_attr(node):
        return any(
            isinstance(child, ast.Attribute) and child.attr == "_table"
            for child in ast.walk(node)
        )

    for path in (ROOT / "odoo_addons").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod) and contains_table_attr(node.right):
                violations.append(f"{path}:{node.lineno}: SQL % formatting uses _table")
            if isinstance(node, ast.JoinedStr) and any(
                contains_table_attr(value.value) for value in node.values if isinstance(value, ast.FormattedValue)
            ):
                violations.append(f"{path}:{node.lineno}: f-string interpolates _table")
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format":
                if any(contains_table_attr(arg) for arg in node.args) or any(
                    contains_table_attr(kw.value) for kw in node.keywords
                ):
                    violations.append(f"{path}:{node.lineno}: .format() interpolates _table")

    assert not violations, "Raw SQL table-name formatting found:\\n" + "\\n".join(violations)


def test_shared_session_tokens_use_short_access_and_long_refresh_lifetimes():
    source = read("src/lib/session-tokens.ts")
    assert "ACCESS_TOKEN_TTL_SECONDS = 15 * 60" in source
    assert "REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000" in source
    assert 'createHash("sha256").update(token' in source
    assert 'tokenHash: hashRefreshToken(refreshToken)' in source
    assert "REFRESH_ROTATION_GRACE_MS = 5_000" in source
    assert 'revoked_reason = \'refresh_reuse_detected\'' in source
    assert 'auth.refresh.reuse_detected' in source


def test_auth_cookie_contract_separates_access_and_refresh_cookies():
    session = read("src/lib/session-tokens.ts")
    assert 'accessCookieName: "mgr_session"' in session
    assert 'refreshCookieName: "mgr_refresh"' in session
    assert 'accessCookieName: "cust_session"' in session
    assert 'refreshCookieName: "cust_refresh"' in session
    assert 'accessCookieName: "plt_session"' in session
    assert 'refreshCookieName: "plt_refresh"' in session
    assert "HttpOnly; SameSite=Lax" in session
    assert "HttpOnly; SameSite=Strict" in session


def test_browser_manager_transport_uses_http_only_cookies_and_one_refresh_retry():
    source = read("src/desktop/lib/ipc.ts")
    assert 'credentials: "include"' in source
    assert 'path !== "/api/auth/manager/refresh"' in source
    assert 'return gatewayRequest(base, path, method, headers, body, false);' in source
    assert 'X-Refresh-Token' not in source


def test_desktop_refresh_secret_stays_inside_rust_memory_boundary():
    source = read("src-tauri/src/commands.rs")
    assert "refresh_token: String" in source
    assert "current_manager_refresh_token" in source
    assert 'request.header("X-Refresh-Token", refresh_token)' in source
    assert 'object.remove("accessToken");' in source
    assert 'object.remove("refreshToken");' in source
    assert "is_manager_refresh_path(path) && (status == 401 || status == 403)" in source
    assert "if status == 401 || status == 403" not in source

    assert 'Origin", "tauri://localhost' in source


def test_new_logout_paths_revoke_refresh_family_and_clear_matching_cookie():
    for rel in (
        "src/app/api/auth/manager/logout/route.ts",
        "src/app/api/auth/logout/route.ts",
        "src/app/api/platform/auth/logout/route.ts",
    ):
        source = read(rel)
        assert "revokeSessionFamily" in source
    assert "clearManagerRefreshCookieHeader" in read("src/app/api/auth/manager/logout/route.ts")
    assert "clearCustomerRefreshCookie" in read("src/app/api/auth/logout/route.ts")
    assert "clearPlatformRefreshCookieHeader" in read("src/app/api/platform/auth/logout/route.ts")


def test_refresh_endpoints_are_no_store_and_use_shared_rotation():
    routes = (
        "src/app/api/auth/refresh/route.ts",
        "src/app/api/auth/manager/refresh/route.ts",
        "src/app/api/platform/auth/refresh/route.ts",
    )
    for rel in routes:
        source = read(rel)
        assert "rotateRefreshToken" in source
        assert 'Cache-Control", "no-store"' in source
        assert "Refresh token is invalid or expired" in source


def test_auth_login_paths_do_not_send_refresh_tokens_to_browser_renderers():
    manager = read("src/app/api/auth/manager/login/route.ts")
    assert 'if (desktopClient)' in manager
    assert 'x-odoo-print-desktop' in manager
    assert 'tauri://localhost' in manager
    assert 'http://tauri.localhost' in manager
    assert "bodyOut.refreshToken = sess.refreshToken;" in manager
    assert '"Cache-Control", "no-store"' in manager
    assert 'if (!desktopClient)' in manager
    platform = read("src/app/api/platform/auth/login/route.ts")
    assert "platformRefreshCookieHeader" in platform
    assert '"Cache-Control", "no-store"' in platform
    customer = read("src/app/api/auth/login/route.ts")
    assert "customerRefreshCookie(session)" in customer
    assert '"Cache-Control", "no-store"' in customer


def test_password_reset_revokes_shared_refresh_families():
    source = read("src/app/api/auth/reset-password/route.ts")
    assert "refreshTokens" in source
    assert 'revokedReason: "password_reset"' in source
    assert 'clock_timestamp()' in source
    assert "eq(refreshTokens.userId, row.userId)" in source


def test_manager_and_customer_v2_session_kinds_are_explicitly_separated():
    manager = read("src/lib/manager-auth.ts")
    customer = read("src/lib/customer-auth.ts")
    assert 'verifyAccessTokenSignature(token, "manager")' in manager
    assert 'verifyAccessTokenSignature(token, "customer")' in customer
    assert 'kind: "customer"' in customer


def test_tenant_selection_issues_customer_kind_session():
    source = read("src/app/api/auth/select-tenant/route.ts")
    assert 'kind: "customer"' in source
    assert "issueSessionPairInTransaction" in source
    assert "customerRefreshCookie" in source
    assert 'revokedReason: "tenant_selection"' in source
    assert "isNull(refreshTokens.revokedAt)" in source


def test_ownership_transfer_revokes_old_owner_refresh_sessions():
    source = read("src/app/api/team/ownership/route.ts")
    assert "refreshTokens" in source
    assert "ownership_transferred" in source
    assert "eq(refreshTokens.userId, currentUserId)" in source
    assert "eq(refreshTokens.tenantId, claims.tenantId)" in source


def test_legacy_session_storage_is_restricted_to_compatibility_paths():
    manager = read("src/lib/manager-auth.ts")
    platform = read("src/lib/platform-auth.ts")
    assert "verifySignature(token)" in manager
    assert "verifyLegacyPlatformTokenSignature(token)" in platform
    assert "createManagerSession" in manager and "issueSessionPair" in manager
    assert "createPlatformSession" in platform and "issueSessionPair" in platform
