#!/usr/bin/env python3
"""Require real Gateway authentication refusals through the configured proxy."""

import http.client
import json
import sys
from urllib.parse import urlsplit


def check_proxy(origin, host):
    parsed = urlsplit(origin)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment):
        raise ValueError("Supply a clean HTTP(S) proxy origin")
    if not host or any(character.isspace() for character in host):
        raise ValueError("Supply the configured Gateway Host header")
    connection_type = (http.client.HTTPSConnection if parsed.scheme == "https"
                       else http.client.HTTPConnection)
    for token in (None, "yaseir-invalid-proxy-token"):
        connection = connection_type(parsed.hostname, parsed.port, timeout=5)
        try:
            headers = {"Host": host, "Accept": "application/json"}
            if token is not None:
                headers["X-Gateway-Proxy-Token"] = token
            connection.request("GET", "/api/billing/status", headers=headers)
            response = connection.getresponse()
            body = response.read(4097)
            if response.status != 401 or len(body) > 4096:
                raise ValueError("Expected Gateway HTTP 401 through the proxy")
            document = json.loads(body)
            if not isinstance(document, dict) or document.get("error") != "Unauthorized":
                raise ValueError("Expected the Gateway authentication refusal")
        finally:
            connection.close()


def main(arguments):
    if len(arguments) != 2:
        print("Usage: check-proxy-boundary.py PROXY_ORIGIN GATEWAY_HOST", file=sys.stderr)
        return 2
    try:
        check_proxy(*arguments)
    except (OSError, ValueError, http.client.HTTPException) as error:
        print(f"Proxy boundary verification failed: {error}", file=sys.stderr)
        return 1
    print("PASS: proxy injects trust and overwrites a forged client token; Gateway requires authentication")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
