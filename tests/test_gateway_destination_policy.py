"""Regression tests for the Odoo Gateway destination policy (no Odoo server needed)."""

import importlib.util
from pathlib import Path
from unittest.mock import patch

import pytest

MODEL_DIR = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway" / "models"
spec = importlib.util.spec_from_file_location("gateway_destination_policy_tested", MODEL_DIR / "gateway_destination.py")
destination = importlib.util.module_from_spec(spec)
spec.loader.exec_module(destination)


@pytest.mark.parametrize("host", [
    "127.0.0.1", "::1", "169.254.169.254", "10.0.0.2",
    "192.168.1.100", "172.16.1.1", "localhost", "metadata.google.internal",
    "printer.local", "0.0.0.0", "ff02::1",
])
def test_sensitive_addresses_rejected_without_operator_allowlist(host):
    with pytest.raises(ValueError):
        destination.validate_gateway_host(host)


def test_public_ip_literal_and_public_hostname_are_allowed_without_dns():
    destination.validate_gateway_host("8.8.8.8")
    destination.validate_gateway_host("print.example.com")


def test_request_time_resolution_rejects_mixed_public_private_dns_answers():
    responses = [
        (2, 1, 6, "", ("8.8.8.8", 0)),
        (2, 1, 6, "", ("169.254.169.254", 0)),
    ]
    with patch.object(destination.socket, "getaddrinfo", return_value=responses):
        with pytest.raises(ValueError, match="metadata"):
            destination.validate_gateway_host("public.example.com", resolve=True)


@pytest.mark.parametrize("metadata", ["169.254.169.254", "100.100.100.200", "::ffff:169.254.169.254"])
def test_explicit_allowlist_cannot_override_cloud_metadata_endpoints(metadata):
    with pytest.raises(ValueError, match="metadata"):
        destination.validate_gateway_host(metadata, allow_private=True)


def test_dns_rebinding_to_metadata_is_forbidden_even_for_allowlisted_host():
    response = [(2, 1, 6, "", ("169.254.169.254", 0))]
    with patch.object(destination.socket, "getaddrinfo", return_value=response):
        with pytest.raises(ValueError, match="metadata"):
            destination.validate_gateway_host("trusted.gateway.internal", resolve=True, allow_private=True)


def test_request_time_unresolvable_hostname_fails_closed():
    with patch.object(destination.socket, "getaddrinfo", side_effect=OSError("unavailable")):
        with pytest.raises(ValueError, match="could not be resolved"):
            destination.validate_gateway_host("offline.example.com", resolve=True)


def test_exact_allowlist_prevents_prefix_confusion_and_allows_approved_private():
    allowlist = "https://print.example.com, https://127.0.0.1:8443"
    assert destination.origin_is_allowlisted("https://PRINT.example.com:443/", allowlist) is True
    assert destination.origin_is_allowlisted("https://127.0.0.1:8443", allowlist) is True
    destination.validate_gateway_host("127.0.0.1", allow_private=True)
    with pytest.raises(ValueError, match="not in"):
        destination.origin_is_allowlisted("https://print.example.com.attacker.invalid", allowlist)
    with pytest.raises(ValueError, match="not in"):
        destination.origin_is_allowlisted("http://print.example.com", allowlist)
    with pytest.raises(ValueError, match="not in"):
        destination.origin_is_allowlisted("https://127.0.0.1:9443", allowlist)


@pytest.mark.parametrize("unsafe", [
    "https://admin:secret@print.example.com",
    "https://print.example.com/unsafe/path",
    "https://print.example.com?secret=1",
    "https://print.example.com:invalid",
])
def test_invalid_allowlist_entries_fail_closed(unsafe):
    with pytest.raises(ValueError):
        destination.origin_is_allowlisted("https://print.example.com", unsafe)


@pytest.mark.parametrize("unsafe", [
    "https://@print.example.com",
    "https://print.example.com?",
    "https://print.example.com#",
])
def test_empty_authority_query_and_fragment_markers_are_not_clean_origins(unsafe):
    with pytest.raises(ValueError):
        destination.canonical_origin(unsafe)


def test_cloud_http_enforces_policy_at_credential_boundaries():
    source = (MODEL_DIR / "cloud_http.py").read_text(encoding="utf8")
    assert "origin_is_allowlisted(" in source
    assert "validate_gateway_host(host, resolve=True, allow_private=allow_private)" in source

