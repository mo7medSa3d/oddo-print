# -*- coding: utf-8 -*-
"""Immutable v1/v2 Gateway identity contract; pure Python for preflight testing.

v1 bytes are a historical wire contract. v2 is issued only after operator
registration/cutover, never inferred from a copied Odoo database UUID. This
module does not provision or activate an installation.
"""
import hashlib
import json
import re
import uuid



class InstallationProofMismatch(ValueError):
    """Out-of-database proof belongs to a different print namespace."""


def legacy_key(company_id, operation_id):
    return hashlib.sha256(("odoo:%s:%s" % (company_id, operation_id)).encode("utf-8")).hexdigest()


def require_v2_identity(installation_id, secret):
    try:
        parsed = uuid.UUID(str(installation_id))
        if parsed.version != 4 or str(parsed) != installation_id:
            raise ValueError("Installation identity must be a canonical UUID v4")
    except (TypeError, AttributeError, ValueError) as exc:
        raise ValueError("Operator-enrolled installation identity is required") from exc
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", secret):
        raise ValueError("An independently provisioned installation proof is required")
    return str(parsed)


def wire_key(version, company_id, operation_id, installation_id=None):
    if version == 1:
        # Never add a new restriction to a previously persisted v1 business
        # key. Historical rows must keep byte-identical Gateway identities.
        return legacy_key(company_id, operation_id)
    if version != 2:
        raise ValueError("Unsupported print idempotency namespace version")
    # Gateway parseOdooIdentity uses JavaScript string.length (UTF-16 units).
    # Python len() counts Unicode code points, so 101 astral symbols previously
    # passed this check but were rejected by Gateway after the outbox was saved.
    # Preserve the historical v1 path above verbatim.
    if not isinstance(operation_id, str) or not operation_id:
        raise ValueError("Durable local operation key is required")
    try:
        length_bytes = len(operation_id.encode("utf-16-le"))
    except UnicodeEncodeError:
        raise ValueError("Durable local operation key is required") from None
    if length_bytes > 400:
        raise ValueError("Durable local operation key is required")
    # Gateway parseOdooIdentity requires canonical positive decimal Odoo
    # company IDs with at most 18 ASCII digits. Reject noncanonical local
    # namespace values BEFORE saving an outbox intent that Gateway cannot
    # ever admit. Keep historical v1 digests untouched.
    company = str(company_id)
    if not re.fullmatch(r"[1-9][0-9]{0,17}", company):
        raise ValueError("Canonical Odoo source company ID is required")
    try:
        parsed = uuid.UUID(str(installation_id))
        if parsed.version != 4 or str(parsed) != installation_id:
            raise ValueError("Invalid installation identity")
    except (TypeError, AttributeError, ValueError) as exc:
        raise ValueError("Registered installation identity is required") from exc
    parts = ["yaseir-odoo-v2", str(parsed), str(company_id), operation_id]
    raw = json.dumps(parts, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _identity_path(database_name, gateway_origin, data_dir=None, company_id=None):
    """Private per-database, per-Gateway identity OUTSIDE the Odoo database."""
    import os
    import stat
    from pathlib import Path

    if not isinstance(database_name, str) or not database_name:
        raise ValueError("Odoo database name is required")
    # B4 fix: the transport policy (print_config._validate_cloud_url +
    # cloud_http.request) explicitly permits plain HTTP on loopback under
    # the YASEIR_GATEWAY_ALLOW_INSECURE_HTTP opt-in, and INSTALLATION.md
    # documents that loopback deployment — yet this gate demanded HTTPS
    # unconditionally, so _ensure_auto_installation() (and therefore Test
    # Connection and v2 enrollment) could never succeed on a documented
    # loopback-HTTP Gateway: local_identity raised ValueError, converted to
    # GATEWAY_INSTALLATION_PROOF_MISSING. Accept HTTP only for a loopback
    # origin; every non-loopback origin still requires HTTPS. The check is
    # deliberately local (stdlib only): importing models.gateway_destination
    # here would be circular (models/__init__ -> print_config -> this
    # module), and the origin has already passed the full transport gate
    # before any in-tree caller reaches this function.
    if not isinstance(gateway_origin, str):
        raise ValueError("HTTPS Gateway origin is required")
    # Scheme comparison is case-insensitive (transport validation accepts
    # any scheme case); the original spelling is kept for identity keying.
    lowered_origin = gateway_origin.lower()
    if lowered_origin.startswith("https://"):
        pass
    elif lowered_origin.startswith("http://"):
        import ipaddress
        from urllib.parse import urlparse

        try:
            host = (urlparse(gateway_origin).hostname or "").lower().rstrip(".")
        except ValueError:
            raise ValueError("HTTPS Gateway origin is required") from None
        # WP4-OBS-3 (STATIC REVIEW ONLY): match the transport's
        # is_loopback_host semantics (gateway_destination.py) exactly:
        # exact "localhost" or an IP literal that is loopback. The old
        # ".localhost" suffix branch passed this gate but was always
        # refused later by the HTTP transport, so it was dead for HTTP
        # and only produced a confusing enrollment failure. Fail-closed
        # either way; the error text is unchanged for caller compatibility.
        try:
            is_loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            is_loopback = host == "localhost"
        if not is_loopback:
            raise ValueError("HTTPS Gateway origin is required")
    else:
        raise ValueError("HTTPS Gateway origin is required")
    if data_dir is None:
        from odoo.tools import config as odoo_config
        data_dir = odoo_config["data_dir"]
    if not data_dir:
        raise ValueError("A persistent Odoo data_dir is required for automatic enrollment")
    root = Path(data_dir) / "yaseir-print-installations"
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Unsafe installation identity directory")
    if os.name == "posix" and (stat.S_IMODE(root.stat().st_mode) & 0o077):
        root.chmod(0o700)
    scope = json.dumps([database_name, gateway_origin.rstrip("/"), company_id],
                       separators=(",", ":"), ensure_ascii=False)
    return root / (hashlib.sha256(scope.encode("utf-8")).hexdigest() + ".json")


def _read_local_identity(path):
    import os
    import stat

    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        mode = os.fstat(descriptor).st_mode
        if not stat.S_ISREG(mode) or (os.name == "posix" and stat.S_IMODE(mode) & 0o077):
            raise ValueError("Installation proof file is not private")
        with os.fdopen(descriptor, "r", encoding="utf-8") as reader:
            descriptor = -1
            data = json.load(reader)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(data, dict):
        raise ValueError("Invalid installation identity file")
    identity = data.get("installationId")
    proof = data.get("installationProof")
    require_v2_identity(identity, proof)
    return {"installationId": identity, "installationProof": proof}


def local_identity(database_name, gateway_origin, data_dir=None, company_id=None, expected_installation_id=None):
    """Atomically generate stable credentials, but never mint a restored ID over history."""
    import base64
    import os
    import tempfile

    path = _identity_path(database_name, gateway_origin, data_dir, company_id)
    try:
        current = _read_local_identity(path)
    except FileNotFoundError:
        if expected_installation_id:
            # An externally provisioned proof may restore the same namespace;
            # never generate a replacement identity over saved print history.
            proof = deployment_proof(expected_installation_id, database_name,
                                     gateway_origin, data_dir, company_id)
            return {"installationId": expected_installation_id, "installationProof": proof}
    else:
        if expected_installation_id and current["installationId"] != expected_installation_id:
            raise InstallationProofMismatch("Saved installation proof does not match Odoo history")
        return current
    identity = {
        "installationId": str(uuid.uuid4()),
        "installationProof": base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("="),
    }
    descriptor, temp_path = tempfile.mkstemp(prefix=".enrollment-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as writer:
            os.chmod(temp_path, 0o600)
            json.dump(identity, writer, separators=(",", ":"))
            writer.flush()
            os.fsync(writer.fileno())
        try:
            os.link(temp_path, path)  # Atomic winner; never replace another worker.
        except FileExistsError:
            pass
    finally:
        os.unlink(temp_path)
    current = _read_local_identity(path)
    if expected_installation_id and current["installationId"] != expected_installation_id:
        raise InstallationProofMismatch("Saved installation proof does not match Odoo history")
    return current


def deployment_proof(installation_id, database_name=None, gateway_origin=None, data_dir=None, company_id=None):
    """Read enrollment proof from the Odoo PROCESS environment, never database.

    Supports several Odoo DBs in one service via an out-of-DB UUID->proof map.
    A restored/cloned database with no external proof must not self-enroll.
    """
    import os

    if database_name is not None and gateway_origin is not None:
        path = _identity_path(database_name, gateway_origin, data_dir, company_id)
        try:
            current = _read_local_identity(path)
        except FileNotFoundError:
            current = None
        if current:
            if current["installationId"] != installation_id:
                # A clone's old outbox must never be reprinted with new credentials.
                raise ValueError("Saved print job belongs to another Odoo installation")
            return current["installationProof"]
    # Backward compatibility for explicitly provisioned external proof maps.
    raw = os.environ.get("YASEIR_ODOO_INSTALLATION_PROOFS", "")
    if raw:
        try:
            mapping = json.loads(raw)
        except (TypeError, ValueError):
            raise ValueError("Invalid external Odoo installation enrollment configuration") from None
        if not isinstance(mapping, dict):
            raise ValueError("External Odoo installation enrollment must be a mapping")
        proof = mapping.get(installation_id)
    else:
        proof = os.environ.get("YASEIR_ODOO_INSTALLATION_PROOF")
    require_v2_identity(installation_id, proof)
    return proof
