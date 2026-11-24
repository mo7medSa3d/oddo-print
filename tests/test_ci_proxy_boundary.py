"""Execute the deployed-proxy CI probe against controlled HTTP boundaries."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading

import pytest


ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def gateway_boundary(responder):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            headers = {name.lower(): value for name, value in self.headers.items()}
            requests.append((self.path, headers))
            status, body = responder(headers)
            payload = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def run_workflow_probe(tmp_path, origin):
    # Execute the actual run-block tail. The only replaced external dependency
    # is Docker's synthetic-secret lookup in the inherited broken probe.
    workflow = (ROOT / ".github/workflows/docker.yml").read_text()
    block = workflow.split('          echo "CADDY_PROXY_TOKEN_RESPONSE:"\n', 1)[1]
    block = block.split("\n      - name:", 1)[0]
    shell = "\n".join(line.removeprefix("          ") for line in block.splitlines())
    shell = shell.replace("http://127.0.0.1", origin)
    docker = tmp_path / "docker"
    docker.write_text("#!/bin/sh\nprintf '%s\\n' 'synthetic-proxy-secret'\n")
    docker.chmod(0o700)
    environment = {**os.environ, "BASH_ENV": "", "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    return subprocess.run(["bash", "-euo", "pipefail", "-c", shell], cwd=ROOT,
                          env=environment, capture_output=True, text=True, timeout=15)


@pytest.mark.parametrize("status,body", [
    (502, b"upstream unavailable"),
    (404, {"error": "Not Found"}),
    (200, {"error": "Unauthorized"}),
    (401, b"not JSON"),
    (401, {"error": "TRUSTED_PROXY_REQUIRED"}),
])
def test_proxy_probe_rejects_upstream_failure_and_non_gateway_responses(tmp_path, status, body):
    with gateway_boundary(lambda _headers: (status, body)) as (origin, _requests):
        result = run_workflow_probe(tmp_path, origin)
    assert result.returncode != 0, "An unexpected HTTP response must not prove proxy trust"


def test_proxy_probe_does_not_supply_the_secret_that_it_claims_the_proxy_injects(tmp_path):
    # Model a misconfigured reverse proxy that merely forwards client headers.
    # The Gateway accepts the known secret but rejects absent/forged tokens.
    def passthrough(headers):
        if headers.get("x-gateway-proxy-token") == "synthetic-proxy-secret":
            return 401, {"error": "Unauthorized"}
        return 403, {"error": "TRUSTED_PROXY_REQUIRED"}

    with gateway_boundary(passthrough) as (origin, _requests):
        result = run_workflow_probe(tmp_path, origin)
    assert result.returncode != 0, "Client-supplied trust must not conceal missing proxy injection"


def test_proxy_probe_checks_anonymous_and_forged_token_requests(tmp_path):
    with gateway_boundary(lambda _headers: (401, {"error": "Unauthorized"})) as (origin, requests):
        result = run_workflow_probe(tmp_path, origin)
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(requests) == 2, "Verify both injection and overwriting an untrusted client token"
    assert all(path == "/api/billing/status" for path, _headers in requests)
    assert requests[0][1].get("x-gateway-proxy-token") is None
    assert requests[1][1].get("x-gateway-proxy-token") == "yaseir-invalid-proxy-token"
    assert all(headers.get("host") == "print.example.com" for _path, headers in requests)
