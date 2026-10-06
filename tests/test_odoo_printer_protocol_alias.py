from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
BINDING = ROOT / "odoo_addons" / "print_gateway" / "models" / "binding.py"


class TestOdooPrinterProtocolAliasContract(unittest.TestCase):
    def test_windows_spooler_runtime_alias_is_transport_scoped(self):
        source = BINDING.read_text(encoding="utf-8")
        self.assertIn('if connection_type == "windows_spooler":', source)
        self.assertIn('connection_type = "spooler"', source)
        self.assertIn('if protocol == "windows_spooler" and connection_type == "spooler":', source)
        self.assertIn('protocol = "spooler"', source)


if __name__ == "__main__":
    unittest.main()
