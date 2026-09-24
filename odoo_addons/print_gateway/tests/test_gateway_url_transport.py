from unittest.mock import patch

# Hard imports: this module only runs under the Odoo test runner; a fallback
# previously degraded the whole file into silent skips with a green exit.
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase
from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig, _friendly_gateway_request_error
import requests


class TestPrintGatewayURLTransport(TransactionCase):
    def _config(self, url):
        return self.env['print_gateway.gateway_config'].create({
            'company_id': self.env.company.id,
            'gateway_url': url,
            'gateway_api_key': 'test-key',
        })

    def test_https_gateway_url_is_accepted(self):
        config = self._config('https://gateway.example.com')
        self.assertEqual(config.gateway_url, 'https://gateway.example.com')

    def test_http_gateway_url_is_rejected_by_default(self):
        with self.assertRaises(ValidationError):
            PrintGatewayConfig._validate_gateway_url("http://gateway.example.com")

    def test_http_gateway_url_requires_explicit_development_opt_in(self):
        with patch.dict("os.environ", {"ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP": "1"}, clear=False):
            for url in (
                "http://gateway.example.com",
                "http://192.168.1.50:3000",
                "http://10.0.0.5:3000",
            ):
                with self.subTest(url=url):
                    self.assertEqual(
                        PrintGatewayConfig._validate_gateway_url(url), url.rstrip("/")
                    )

    def test_unsupported_gateway_url_scheme_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._config('ftp://gateway.example.com')

    def test_gateway_url_without_host_is_rejected(self):
        with self.assertRaises(ValidationError):
            self._config('http://')

    def test_gateway_url_rejects_embedded_credentials_and_api_paths(self):
        with self.assertRaises(ValidationError):
            self._config('https://user:pass@gateway.example.com')
        with self.assertRaises(ValidationError):
            self._config('https://gateway.example.com/api')

    def test_friendly_gateway_request_error_formats_requests_exceptions(self):
        url = "https://gateway.example.com"
        connection = _friendly_gateway_request_error(
            requests.exceptions.ConnectionError("Connection refused"),
            url,
        )
        timeout = _friendly_gateway_request_error(
            requests.exceptions.Timeout("Read timeout"),
            url,
        )
        generic = _friendly_gateway_request_error(
            requests.exceptions.RequestException("unexpected transport failure"),
            url,
        )
        self.assertIn(url, connection)
        self.assertIn(url, timeout)
        self.assertIn(url, generic)
        self.assertIn("unexpected transport failure", generic)

    def test_gateway_redirect_message_redacts_sensitive_location(self):
        from odoo.addons.print_gateway.models.gateway_config import _gateway_redirect_message
        response = type("Response", (), {
            "status_code": 307,
            "headers": {
                "Location": "https://user:pass@gateway.example.com/login?token=SUPER_SECRET&sig=PRIVATE#fragment"
            },
        })()
        message = _gateway_redirect_message(response, "https://gateway.example.com")
        self.assertIn("gateway.example.com", message)
        self.assertNotIn("SUPER_SECRET", message)
        self.assertNotIn("PRIVATE", message)
        self.assertNotIn("user:pass", message)
        self.assertNotIn("/login", message)
