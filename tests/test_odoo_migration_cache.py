"""The real encryption migration must invalidate its pre-encryption ORM read."""
import runpy
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace


def test_encryption_migration_refreshes_cached_credential(monkeypatch):
    class Config:
        id = 11
        stored = "fixture-key"
        cached = "fixture-key"

        @property
        def gateway_api_key(self):
            if self.cached is None:
                self.cached = self.stored
            return self.cached

        def invalidate_recordset(self, fields):
            assert fields == ["gateway_api_key"]
            self.cached = None

    config = Config()
    model = SimpleNamespace(sudo=lambda: model, search=lambda _domain: [config])
    odoo = ModuleType("odoo")
    odoo.api = SimpleNamespace(Environment=lambda *_args: {"print_gateway.gateway_config": model})
    odoo.SUPERUSER_ID = 1
    crypto_name = "odoo.addons.print_gateway.models.crypto"
    crypto = ModuleType(crypto_name)
    crypto.CredentialDecryptError = type("CredentialDecryptError", (Exception,), {})
    crypto.CredentialKeyUnavailable = type("CredentialKeyUnavailable", (Exception,), {})
    crypto.active_gateway_api_key_version = lambda: "v1"
    crypto.gateway_api_key_version = lambda _value: "v1"
    crypto.is_encrypted_gateway_api_key = lambda value: value.startswith("enc:")
    crypto.encrypt_gateway_api_key = lambda value: "enc:" + value
    crypto.decrypt_gateway_api_key = lambda value: value.removeprefix("enc:")
    monkeypatch.setitem(sys.modules, "odoo", odoo)
    monkeypatch.setitem(sys.modules, crypto_name, crypto)

    def update(query, params):
        assert query.startswith("UPDATE print_gateway_gateway_config")
        assert params[1] == config.id
        config.stored = params[0]

    migration = Path(__file__).resolve().parents[1] / (
        "odoo_addons/print_gateway/migrations/19.0.2.4.0/post-migrate.py"
    )
    runpy.run_path(str(migration))["migrate"](SimpleNamespace(execute=update), "19.0.2.3.0")
    assert config.gateway_api_key == "enc:fixture-key"
