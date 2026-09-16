# -*- coding: utf-8 -*-
"""Authenticated encryption for the Odoo -> Gateway installation credential.

The encryption root is deployment-managed and injected through environment
variables; it is intentionally never stored in PostgreSQL or source control.
Odoo 19 itself depends on ``cryptography``.
"""

import base64
import os
import re
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


_PREFIX = "opg1"
_NONCE_BYTES = 12
_KEY_BYTES = 32
_VERSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")


class CredentialError(Exception):
    """Base class for credential protection failures."""


class CredentialKeyUnavailable(CredentialError):
    """The deployment-managed encryption key is unavailable or invalid."""


class CredentialDecryptError(CredentialError):
    """Stored ciphertext is malformed, unsupported, or failed authentication."""


class CredentialVersionError(CredentialError):
    """The ciphertext uses an unsupported/invalid key version."""


def _runtime_secret(name: str) -> str:
    """Resolve a deployment secret from an injected file first, then env.

    File injection keeps long-lived key material out of process environment
    snapshots when the deployment platform supports mounted secrets.
    """
    file_path = os.environ.get(f"{name}_FILE", "").strip()
    if file_path:
        try:
            value = Path(file_path).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise CredentialKeyUnavailable(
                "credential deployment secret file is unavailable"
            ) from exc
        if value:
            return value
    return os.environ.get(name, "").strip()


def _active_version():
    value = _runtime_secret("ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION") or "1"
    value = value.strip()
    if not _VERSION_RE.fullmatch(value):
        raise CredentialVersionError("invalid active credential key version")
    return value


def active_gateway_api_key_version():
    return _active_version()


def _aad(version: str) -> bytes:
    return ("odoo-print-gateway:gateway-api-key:%s" % version).encode("ascii")


def _load_key(version: str) -> bytes:
    if not _VERSION_RE.fullmatch(version):
        raise CredentialVersionError("invalid credential key version")
    env_name = "ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V%s_B64" % version
    encoded = _runtime_secret(env_name)
    if not encoded:
        raise CredentialKeyUnavailable(
            "credential encryption key %s is not configured" % env_name
        )
    try:
        key = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise CredentialKeyUnavailable("credential encryption key is not valid base64") from exc
    if len(key) != _KEY_BYTES:
        raise CredentialKeyUnavailable("credential encryption key must decode to 32 bytes")
    return key


def credential_encryption_configured() -> bool:
    try:
        _load_key(_active_version())
        return True
    except CredentialError:
        return False


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode((value + padding).encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise CredentialDecryptError("invalid credential ciphertext encoding") from exc


def encrypt_gateway_secret(secret_text: str) -> str:
    """Encrypt a secret with AES-256-GCM using the deployment key for the active version."""
    if not secret_text:
        return ""
    version = _active_version()
    key = _load_key(version)
    nonce = secrets.token_bytes(_NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(nonce, secret_text.encode("utf-8"), _aad(version))
    return "%s:%s:%s" % (_PREFIX, version, _encode(nonce + ciphertext))


def decrypt_gateway_secret(encrypted_text: str) -> str:
    """Decrypt only authenticated OPG1 ciphertext; plaintext fallback is forbidden."""
    if not encrypted_text:
        return ""
    parts = encrypted_text.split(":", 2)
    if len(parts) != 3 or parts[0] != _PREFIX:
        raise CredentialDecryptError("gateway credential is not authenticated ciphertext")
    _, version, encoded = parts
    if not _VERSION_RE.fullmatch(version):
        raise CredentialVersionError("invalid credential key version")
    packed = _decode(encoded)
    if len(packed) <= _NONCE_BYTES + 16:
        raise CredentialDecryptError("gateway credential ciphertext is too short")
    nonce, ciphertext = packed[:_NONCE_BYTES], packed[_NONCE_BYTES:]
    key = _load_key(version)
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, _aad(version))
    except Exception as exc:
        raise CredentialDecryptError("gateway credential authentication failed") from exc
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CredentialDecryptError("gateway credential is not valid UTF-8") from exc


def gateway_api_key_version(value: str) -> str | None:
    if not value:
        return None
    parts = value.split(":", 2)
    if len(parts) != 3 or parts[0] != _PREFIX:
        return None
    return parts[1]


def is_encrypted_gateway_api_key(value: str) -> bool:
    return bool(value) and gateway_api_key_version(value) is not None


# Backward-compatible aliases. They now provide real authenticated encryption.
encrypt_gateway_api_key = encrypt_gateway_secret
decrypt_gateway_api_key = decrypt_gateway_secret
