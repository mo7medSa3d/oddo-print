from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    Model = env["print_gateway.gateway_config"].sudo()
    configs = Model.search([("gateway_api_key", "!=", False)])
    if not configs:
        return

    from odoo.addons.print_gateway.models.crypto import (
        CredentialDecryptError,
        CredentialKeyUnavailable,
        active_gateway_api_key_version,
        decrypt_gateway_api_key,
        encrypt_gateway_api_key,
        gateway_api_key_version,
        is_encrypted_gateway_api_key,
    )

    try:
        active = active_gateway_api_key_version()
        for config in configs:  # credentials never leave this migration as plaintext
            value = config.gateway_api_key
            if is_encrypted_gateway_api_key(value):
                if gateway_api_key_version(value) != active:
                    value = encrypt_gateway_api_key(decrypt_gateway_api_key(value))
            else:
                value = encrypt_gateway_api_key(value)
            if value != config.gateway_api_key:
                cr.execute(
                    "UPDATE print_gateway_gateway_config SET gateway_api_key = %s WHERE id = %s",
                    (value, config.id),
                )
    except (CredentialKeyUnavailable, CredentialDecryptError, ValueError) as exc:
        raise RuntimeError(
            "Yasser Print Manager credential migration requires a valid deployment-managed encryption key; plaintext fallback is forbidden."
        ) from exc
