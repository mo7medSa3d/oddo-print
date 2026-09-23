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


def test_tauri_renderer_cannot_supply_authorization_headers():
    rust = (ROOT / "src-tauri" / "src" / "commands.rs").read_text(encoding="utf-8")
    assert 'name.eq_ignore_ascii_case("authorization")' in rust
    assert 'name.eq_ignore_ascii_case("cookie")' in rust
    assert 'current_manager_token()' in rust
    assert 'request = request.bearer_auth(token)' in rust


def test_tauri_manager_token_is_not_persisted_in_webview_storage():
    ipc = (ROOT / "src" / "desktop" / "lib" / "ipc.ts").read_text(encoding="utf-8")
    assert "function getBrowserManagerToken" in ipc
    assert "if (isTauri || typeof window === \"undefined\") return null;" in ipc
    assert "if (!isTauri && data.accessToken) setBrowserManagerToken(data.accessToken);" in ipc
    assert 'invoke("clear_manager_session")' in ipc
    # Tauri path must not write the access token into sessionStorage.
    assert "if (isTauri || typeof window === \"undefined\") return;\n  try {\n    window.sessionStorage.setItem" in ipc


def test_nextjs_has_explicit_csp():
    source = (ROOT / "next.config.ts").read_text(encoding="utf-8")
    for directive in ("default-src", "script-src", "style-src", "img-src", "connect-src", "font-src", "frame-ancestors", "object-src", "base-uri", "form-action"):
        assert directive in source
    assert 'frame-ancestors \'none\'' in source
    assert 'object-src \'none\'' in source
    assert 'form-action \'self\'' in source


def test_manifest_declares_crypto_dependency_and_migration_version():
    manifest = (ADDON / "__manifest__.py").read_text(encoding="utf-8")
    assert "'version': '19.0.2.7.0'" in manifest
    assert "'cryptography'" in manifest
    assert (ADDON / "migrations" / "19.0.2.4.0" / "post-migrate.py").exists()


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

def test_job_timeline_is_manager_scoped_not_agent_console_scoped():
    route = read("src/app/api/jobs/[id]/timeline/route.ts")
    assert 'import { validateManager } from "../../../../../lib/manager-auth";' in route
    assert "validateConsoleAuth" not in route
    assert "const tenantId = auth.tenantId;" in route


def test_tauri_manager_login_token_stays_inside_rust():
    rust = read("src-tauri/src/commands.rs")
    ipc = read("src/desktop/lib/ipc.ts")
    assert 'object.remove("accessToken")' in rust
    assert 'path == "/api/auth/manager/login"' in rust
    assert "(!isTauri && !data.accessToken)" in ipc


def test_odoo_activation_can_always_disable_but_enable_is_subscription_gated():
    route = read("src/app/api/odoo/configuration/route.ts")
    assert "if (enabled) {" in route
    assert "An active subscription is required to enable Gateway printing" in route
    gate = route[route.index("if (enabled) {"):route.index("const now = new Date();")]
    assert "if (enabled)" in gate
    assert "enabled" in gate


def test_settings_does_not_duplicate_first_class_operational_pages():
    page = read("src/app/settings/page.tsx")
    assert 'id: "members"' not in page
    assert 'id: "billing"' not in page
    assert 'id: "integrations"' not in page
    assert 'href="/team"' not in page
    assert 'href="/billing"' not in page
    assert 'href="/api-keys"' not in page
