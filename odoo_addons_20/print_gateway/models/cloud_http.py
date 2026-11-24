"""Request-local, DNS-pinned HTTP for credential-bearing Gateway operations.

Each request owns one pool and one validated numeric destination. TLS retains
the original hostname for SNI/certificate checks and the HTTP Host header. No
global resolver, Requests, or urllib3 state is changed. Transport retries and
redirects are disabled: durable print retries remain the outbox's decision.
"""
import ipaddress
import math
import os
from urllib.parse import urlparse

import requests as _requests
from requests.adapters import HTTPAdapter
from urllib3 import HTTPConnectionPool, HTTPSConnectionPool

from .gateway_destination import (
    GatewayResolutionError, canonical_origin, is_loopback_host, origin_is_allowlisted, validate_gateway_host,
)


# Keep existing sanitized error handling and request mocks at the HTTP boundary.
RequestException = _requests.RequestException
exceptions = _requests.exceptions
utils = _requests.utils

# Control-plane replies contain metadata, never printable document bodies.
# Match the existing inventory limit and bound decoded bytes as well as the
# advertised length so chunking or compressed responses cannot exhaust an
# Odoo worker before any caller reaches response.json().
MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024


def _read_control_response(response):
    try:
        try:
            declared_size = int(response.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            declared_size = 0  # The streamed decoded-byte limit still applies.
        if declared_size > MAX_CONTROL_RESPONSE_BYTES:
            raise RequestException("Gateway response exceeds the 2 MiB control-plane limit")
        content = bytearray()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if len(chunk) > MAX_CONTROL_RESPONSE_BYTES - len(content):
                # This is deliberately a generic RequestException, not a
                # connection failure. A POST may already have been accepted;
                # the outbox must retain its ambiguous/unknown outcome.
                raise RequestException("Gateway response exceeds the 2 MiB control-plane limit")
            content.extend(chunk)
        response._content = bytes(content)
        response._content_consumed = True
        return response
    finally:
        response.close()


def _origin(url):
    try:
        parsed = urlparse(url)
        if parsed.username or parsed.password or parsed.fragment:
            raise ValueError("Gateway request URL contains forbidden components")
        return canonical_origin("%s://%s" % (parsed.scheme, parsed.netloc))
    except (ValueError, TypeError, UnicodeError) as exc:
        raise exceptions.InvalidURL("Gateway request URL is invalid") from exc


class _PinnedAdapter(HTTPAdapter):
    """A pool is private to one request, including its CA configuration."""

    def __init__(self, origin, address):
        super().__init__(max_retries=0)
        self.origin = origin
        scheme, host, port = origin
        hostname = host
        # urllib3 2.8 requires RFC 6874 brackets/escaped zone separators.
        # Escaping also prevents scope 257 from being mistaken for scope 7.
        pool_address = "[%s]" % address.replace("%", "%25") if ":" in address else address
        if scheme == "https":
            self.pinned_pool = HTTPSConnectionPool(
                pool_address, port=port, maxsize=1, block=True,
                server_hostname=hostname, assert_hostname=hostname,
            )
        else:
            self.pinned_pool = HTTPConnectionPool(pool_address, port=port, maxsize=1, block=True)

    def _connection(self, url, proxies):
        if proxies or _origin(url) != self.origin:
            raise exceptions.InvalidURL("Gateway transport refused a proxy or changed origin")
        return self.pinned_pool

    def get_connection(self, url, proxies=None):
        # Requests 2.31, still used by the pinned upstream Odoo requirements.
        return self._connection(url, proxies)

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        # Requests >= 2.32.2. HTTPAdapter.send subsequently calls cert_verify
        # on this private pool, preserving both stock and explicit CA bundles.
        return self._connection(request.url, proxies)

    def send(self, request, **kwargs):
        if kwargs.get("verify") is False:
            raise exceptions.SSLError("Gateway TLS certificate verification is required")
        self._connection(request.url, kwargs.get("proxies"))
        scheme, host, port = self.origin
        authority = "[%s]" % host if ":" in host else host
        if port != (443 if scheme == "https" else 80):
            authority += ":%s" % port
        request.headers["Host"] = authority
        return super().send(request, **kwargs)

    def close(self):
        self.pinned_pool.close()
        super().close()


def request(method, url, **kwargs):
    origin = _origin(url)
    scheme, host, _port = origin
    if kwargs.pop("allow_redirects", False) is not False or kwargs.pop("proxies", None):
        raise exceptions.InvalidURL("Gateway redirects and proxies are not allowed")
    if scheme != "https" and not (
        os.environ.get("YASEIR_GATEWAY_ALLOW_INSECURE_HTTP") == "1"
        and is_loopback_host(host)
    ):
        raise exceptions.InvalidURL("Gateway transport requires HTTPS")
    verify = kwargs.pop("verify", None)
    if verify is None:
        verify = os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("CURL_CA_BUNDLE") or True
    if verify is not True and not (isinstance(verify, str) and verify):
        raise exceptions.SSLError("Gateway TLS certificate verification is required")
    timeout = kwargs.setdefault("timeout", 10)
    timeouts = timeout if isinstance(timeout, tuple) and len(timeout) == 2 else (timeout,)
    if not all(type(value) in (int, float) and math.isfinite(value) and 0 < value <= 60 for value in timeouts):
        raise exceptions.InvalidURL("Gateway connect/read timeouts must be between zero and 60 seconds")
    try:
        parsed = urlparse(url)
        allow_private = origin_is_allowlisted(
            "%s://%s" % (parsed.scheme, parsed.netloc),
            os.environ.get("YASEIR_GATEWAY_ALLOWED_ORIGINS", ""),
        )
        addresses = validate_gateway_host(host, resolve=True, allow_private=allow_private)
    except GatewayResolutionError as exc:
        raise exceptions.ConnectionError("Gateway DNS lookup failed before connection") from exc
    except ValueError as exc:
        raise exceptions.InvalidURL("Gateway destination was refused: %s" % exc) from exc
    # The HTTP permission above is name-based
    # (opt-in + is_loopback_host(host)), but allow_private=True lets the
    # resolver return a non-loopback address for that name. A poisoned
    # resolver must never redirect this credential-bearing cleartext
    # request off-host: for HTTP, every resolved address — not just the
    # pinned first one — must itself be loopback (zone suffix stripped
    # before classification; IPv4-mapped IPv6 is NOT loopback and refuses).
    # HTTPS is unaffected: its name-based allowlist + TLS checks stand.
    if scheme == "http":
        for address in addresses:
            bare = address.split("%", 1)[0]
            try:
                is_loopback = ipaddress.ip_address(bare).is_loopback
            except ValueError:
                is_loopback = False
            if not is_loopback:
                raise exceptions.InvalidURL(
                    "Gateway HTTP origin resolved to a non-loopback address"
                )
    # Do not retry a request against another address. A safe connection failure
    # is handled by the existing bounded outbox/control-plane retry policy.
    session = _requests.Session()
    transferred = False
    try:
        session.trust_env = False  # no implicit proxy or .netrc credentials
        adapter = _PinnedAdapter(origin, addresses[0])
        session.mount(scheme + "://", adapter)
        streamed = kwargs.pop("stream", False)
        response = session.request(
            method, url, allow_redirects=False, verify=verify, stream=True, **kwargs
        )
        if streamed:
            # The inventory reader owns this bounded response. Session.__exit__
            # here would close the pinned pool BEFORE the caller reads it.
            # Transfer pool ownership to response.close() instead; the
            # response context manager calls close on success and errors.
            original_close = response.close
            released = False

            def close_pinned_response():
                nonlocal released
                if released:
                    return
                released = True
                try:
                    original_close()
                finally:
                    session.close()

            response.close = close_pinned_response
            transferred = True
            return response
        return _read_control_response(response)
    finally:
        # Preserve eager response semantics and close on every exception,
        # including failure before HTTP dispatch or ambiguous POST replies.
        if not transferred:
            session.close()


def get(url, **kwargs):
    return request("GET", url, **kwargs)


def post(url, **kwargs):
    return request("POST", url, **kwargs)


def patch(url, **kwargs):
    return request("PATCH", url, **kwargs)
