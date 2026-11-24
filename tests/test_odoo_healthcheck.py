import contextlib
import http.server
import importlib.util
import os
import pathlib
import socket
import threading
import time
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("odoo_healthcheck", ROOT / "scripts/odoo-healthcheck.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@contextlib.contextmanager
def peer(body=b'{"status":"pass"}', status=200, delay=0):
    seen = []
    stop = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            if delay and stop.wait(delay):
                return
            try:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    # Short poll_interval avoids paying 0.5s shutdown latency per HTTPServer instance.
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        with patch.dict(os.environ, {"ODOO_HTTP_PORT": str(server.server_port), "http_proxy": "http://127.0.0.1:1"}, clear=True):
            yield seen
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class OdooHealthcheckTest(unittest.TestCase):
    def test_actual_http_success_uses_health_route_without_environment_proxy(self):
        with peer() as seen:
            self.assertEqual(MODULE.main(), 0)
            self.assertEqual(seen, ["/web/health"])

    def test_http_failure_is_not_healthy_even_with_pass_body(self):
        with peer(status=500):
            self.assertEqual(MODULE.main(), 1)

    def test_malformed_wrong_shape_failed_or_oversized_body_is_rejected(self):
        for body in (b"invalid", b"[]", b'{"status":"fail"}', b'{"status":"pass","padding":"' + b"x" * 4096 + b'"}'):
            with self.subTest(body_size=len(body)), peer(body):
                self.assertEqual(MODULE.main(), 1)

    def test_slow_local_service_has_bounded_timeout(self):
        with peer(delay=3.4):
            start = time.monotonic()
            self.assertEqual(MODULE.main(), 1)
            self.assertLess(time.monotonic() - start, 3.3)

    def test_refused_connection_is_unhealthy(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            with patch.dict(os.environ, {"ODOO_HTTP_PORT": str(reservation.getsockname()[1])}, clear=True):
                self.assertEqual(MODULE.main(), 1)

    def test_invalid_port_fails_closed(self):
        for port in ("0", "65536", "bad", "-1"):
            with self.subTest(port=port), patch.dict(os.environ, {"ODOO_HTTP_PORT": port}, clear=True):
                self.assertEqual(MODULE.main(), 1)


if __name__ == "__main__":
    unittest.main()
