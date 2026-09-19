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


def test_windows_system_utilities_are_not_path_resolved():
    source = read("src-tauri/src/agent.rs")
    def function_body(name: str) -> str:
        marker = f"fn {name}"
        start = source.index(marker)
        end = source.find("\n}", start)
        return source[start : end if end != -1 else len(source)]

    for fn_name, tool in ((
        ("sc_query", "sc"),
        ("is_process_running", "tasklist"),
        ("run_net", "net"),
        ("taskkill_pid", "taskkill"),
    )):
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


def test_agent_pairing_success_does_not_clear_rate_limit():
    source = read("src/app/api/agent/register/route.ts")
    assert "recordPairingSuccess" not in source
    assert "reservePairingAttempt" in source
    assert "reset the brute-force budget" in source


def test_tauri_gateway_http_is_loopback_only():
    source = read("src-tauri/src/commands.rs")
    assert 'let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");' in source
    assert 'Gateway URL must use HTTPS unless the Gateway is local to this machine' in source


def test_billing_webhook_binds_identity_before_metadata_tenant_mutation():
    source = read("src/app/api/billing/webhook/route.ts")
    assert "billingIdentityConflict" in source
    assert "stripeSubscriptionId" in source
    assert "stripeCustomerId" in source
    assert 'return NextResponse.json({ received: true, ignored: true })' in source
    assert "if (billingIdentityConflict)" in source
    assert "processedAt: new Date()" in source


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
