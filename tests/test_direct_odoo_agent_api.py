import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "odoo_addons19" / "print_gateway"


class TestDirectOdooAgentAPI(unittest.TestCase):
    def test_models_and_controller_compile_and_expose_direct_routes(self):
        for rel in ("models/agent.py", "models/printer.py", "controllers/agent_api.py"):
            src = (ROOT / rel).read_text(encoding="utf-8")
            ast.parse(src, filename=rel)

        api_src = (ROOT / "controllers" / "agent_api.py").read_text(encoding="utf-8")
        for route in (
            "/print_gateway/agent/register",
            "/print_gateway/agent/heartbeat",
            "/print_gateway/agent/claim",
            "/print_gateway/agent/ack",
        ):
            self.assertIn(route, api_src)
        self.assertIn("FOR UPDATE OF j SKIP LOCKED", api_src)
        self.assertIn("hmac.compare_digest", api_src)
        self.assertIn("payload = CASE WHEN %s = 'success' THEN '' ELSE payload END", api_src)
        self.assertNotIn('type="json"', api_src)

    def test_access_csv_covers_new_models(self):
        csv_text = (ROOT / "security" / "ir.model.access.csv").read_text(encoding="utf-8")
        self.assertIn("model_print_gateway_agent", csv_text)
        self.assertIn("model_print_gateway_printer", csv_text)


if __name__ == "__main__":
    unittest.main()

