"""Validate authenticated Gateway operational evidence without using it as an availability gate.

Operational proof remains useful for presentation and diagnostics. Transport,
output-medium, inventory, lifecycle and positive destination-integrity conflicts
are enforced independently at the routing boundary.
"""
from datetime import datetime, timezone
import re


def utc_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z", value):
        return None
    try:
        # Gateway/JavaScript projects timestamps at millisecond precision.
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, OverflowError):
        return None


def validated_operational_verification(value, printer, now=None):
    required = {"version", "verified_at", "printer_id", "binding_digest", "logical_queue_key", "method", "identity_strength", "output_medium"}
    if not isinstance(value, dict) or not isinstance(printer, dict) or set(value) - (required | {"physical_device_key"}) or not required <= set(value):
        return None
    if type(value["version"]) is not int or value["version"] != 1:
        return None
    identity = value["printer_id"]
    if (not isinstance(identity, str) or not identity or identity != identity.strip()
            or identity.startswith("\ufeff") or identity.endswith("\ufeff")
            or re.search(r"[\x00-\x1f\x7f-\x9f]", identity)
            or identity != printer.get("id")):
        return None
    # A proof's identity must be the exact executable Agent target:
    # UTF-8 bytes (<=120), not Python characters; no surrogate substitution.
    try:
        if len(identity.encode("utf-8", "strict")) > 120:
            return None
    except UnicodeEncodeError:
        return None
    digest = value["binding_digest"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or value["logical_queue_key"] != digest:
        return None
    if value["identity_strength"] not in ("queue", "service", "device"):
        return None
    if "physical_device_key" in value and (value["identity_strength"] != "device" or not isinstance(value["physical_device_key"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["physical_device_key"])):
        return None
    connection = str(printer.get("connectionType") or "").strip().lower()
    protocol = str(printer.get("protocol") or "").strip().lower()
    method = None
    if connection == "spooler" and protocol in ("spooler", "windows_spooler"):
        method = "windows_queue"
    elif connection in ("ipp", "ipps") or (connection == "network" and protocol in ("ipp", "ipps")):
        method = "ipp_attributes"
    elif connection in ("network", "usb") and protocol in ("raw", "escpos", "zpl", "tspl"):
        method = "usb_interface" if connection == "usb" else "snmp_printer"
    # An IPP service or Windows spooler queue is not physical chassis proof.
    # Mirror the native Go Agent's exact method-to-identity-strength contract;
    # a caller may not promote a service/queue to a device by forging metadata.
    method_strength = {
        "windows_queue": "queue",
        "ipp_attributes": "service",
        "usb_interface": "device",
        "snmp_printer": "device",
    }
    if (not method or value["method"] != method
            or value["identity_strength"] != method_strength[method]
            or ("physical_device_key" in value and method_strength[method] != "device")
            or value["output_medium"] != "physical"):
        return None
    current = now or datetime.now(timezone.utc)
    current_ms = int(current.timestamp() * 1000)
    verified = utc_timestamp(value["verified_at"])
    if verified is None or not -60000 <= current_ms - verified <= 300000:
        return None
    return dict(value)


def is_verified_runtime_printer(printer, now=None):
    if not isinstance(printer, dict) or printer.get("verificationState") != "verified":
        return False
    current = now or datetime.now(timezone.utc)
    capabilities = printer.get("capabilities")
    proof = validated_operational_verification(capabilities.get("operational_verification") if isinstance(capabilities, dict) else None, printer, current)
    if not proof or printer.get("outputMedium") != proof["output_medium"]:
        return False
    verified = utc_timestamp(printer.get("verificationVerifiedAt"))
    received = utc_timestamp(printer.get("verificationReceivedAt"))
    return (verified == utc_timestamp(proof["verified_at"]) and received is not None
            and 0 <= int(current.timestamp() * 1000) - received <= 300000)
