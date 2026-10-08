from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def function_slice(source: str, marker: str, next_marker: str) -> str:
    start = source.index(marker)
    end = source.index(next_marker, start)
    return source[start:end]


def test_candidate_probe_is_non_mutating_and_public_only():
    rust = text("src-tauri/src/commands.rs")
    body = function_slice(rust, "pub async fn probe_gateway_health", "fn configured_gateway_origin")
    assert "normalize_gateway_url(&url)" in body
    assert '.join("api/agent/probe")' in body
    assert "redirect(reqwest::redirect::Policy::none())" in body
    assert "bearer_auth" not in body
    assert "manager_session" not in body
    assert "set_gateway_config" not in body
    assert "commands::probe_gateway_health" in text("src-tauri/src/main.rs")


def test_settings_probe_precedes_persistence_and_reconciles_ambiguous_save():
    main = text("src/desktop/main.tsx")
    body = function_slice(main, "const checkHealth = useCallback", "const handleDiscover = useCallback")
    assert body.index("await probeGatewayHealth(target)") < body.index("await setGatewayUrl(target)")
    assert "durable = await getGatewayUrl()" in body
    assert "gatewayReconcileFailed" in body
    assert "savedOriginRef.current = durable" in body
    assert "candidateObserved" in body


def test_operational_state_uses_saved_origin_while_settings_uses_draft():
    main = text("src/desktop/main.tsx")
    settings = text("src/desktop/pages/Settings.tsx")
    types = text("src/desktop/types.ts")
    assert "gatewayUrl: savedGatewayUrl" in main
    assert "gatewayDraftUrl: gatewayUrl" in main
    assert "gatewayDraftMatchesSaved" in main
    assert "gatewayDraftUrl: string;" in types
    assert 'value={s.gatewayDraftUrl}' in settings
    assert 's.setGatewayDraftUrl(e.target.value)' in settings
    assert 't("desktop.settings.savedGateway"' in settings
    assert 't("desktop.settings.lastObservedGateway"' in settings
    assert "gatewayDraftPending" in settings


def test_candidate_probe_never_sends_browser_credentials():
    ipc = text("src/desktop/lib/ipc.ts")
    body = function_slice(ipc, "export async function probeGatewayHealth", "export async function fetchGatewayHealth")
    assert 'invoke<GatewayResponse>("probe_gateway_health"' in body
    assert 'credentials: "omit"' in body
    assert 'credentials: "include"' not in body


def test_gateway_draft_copy_exists_in_both_catalogs():
    en = text("src/i18n/messages/en.ts")
    ar = text("src/i18n/messages/ar.ts")
    for key in (
        "desktop.settings.draftNotVerified",
        "desktop.settings.savedGateway",
        "desktop.settings.lastObservedGateway",
        "desktop.settings.draftNotSavedBody",
        "desktop.app.gatewayHealthNotReady",
        "desktop.app.gatewayReconcileFailed",
        "desktop.app.gatewaySavedAfterReconcile",
    ):
        assert f'"{key}"' in en
        assert f'"{key}"' in ar


def test_saved_gateway_auto_refresh_is_canonical_periodic_and_uses_identity_probe():
    main = text("src/desktop/main.tsx")
    probe = function_slice(main, "const probeGateway = useCallback", "const checkHealth = useCallback")
    assert "await probeGatewayHealth(targetUrl)" in probe
    assert "fetchGatewayHealth" not in probe
    assert "normalizeGatewayUrl(savedOriginRef.current) === targetUrl" in probe
    assert "observeGatewayFailure" in probe
    assert "noteGatewayConnectivityFailure" in main
    assert "noteGatewayConnectivitySuccess" in main
    assert "window.setInterval(runProbe, GATEWAY_AUTO_PROBE_INTERVAL_MS)" in main
    assert 'window.addEventListener("online", runProbe)' in main
    assert 'window.addEventListener("focus", runProbe)' in main
    assert 'document.addEventListener("visibilitychange", onVisible)' in main
    assert "target !== savedGatewayUrl" not in main


def test_gateway_connection_does_not_expire_from_clock_freshness_alone():
    main = text("src/desktop/main.tsx")
    assert "healthFresh" not in main
    assert "GATEWAY_CONNECTIVITY_FRESH_MS" not in main
    assert "observeGatewaySuccess(savedGatewayUrl)" in main
    assert "observeGatewayFailure(target, presented)" in main
