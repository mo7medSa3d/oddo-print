#!/usr/bin/env python3
"""Bounded, proxy-independent HTTP liveness check; never prints response data."""
import http.client
import json
import os


def main():
    connection = None
    try:
        port = int(os.environ.get("ODOO_HTTP_PORT", "8069"))
        if not 1 <= port <= 65535:
            return 1
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        connection.request("GET", "/web/health", headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096:
            return 1
        document = json.loads(body)
        return 0 if isinstance(document, dict) and document.get("status") == "pass" else 1
    except (OSError, ValueError, http.client.HTTPException):
        return 1
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
