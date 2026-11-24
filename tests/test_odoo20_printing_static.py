import ast
import csv
import py_compile
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ADDON = Path(__file__).resolve().parents[1] / "odoo_addons_20" / "print_gateway"


class TestOdoo20PrintingStatic(unittest.TestCase):
    def test_manifest_odoo20_invariants(self):
        manifest = ast.literal_eval((ADDON / "__manifest__.py").read_text(encoding="utf-8"))
        self.assertTrue(str(manifest.get("version", "")).startswith("20.0."))
        data = manifest.get("data", [])
        self.assertIn("security/ir.access.csv", data)
        self.assertNotIn("security/ir.model.access.csv", data)
        self.assertNotIn("security/security.xml", data)
        self.assertFalse((ADDON / "security" / "ir.model.access.csv").exists())
        self.assertFalse((ADDON / "security" / "security.xml").exists())

    def test_security_ir_access_csv(self):
        csv_path = ADDON / "security" / "ir.access.csv"
        self.assertTrue(csv_path.exists())
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, ["id", "name", "model_id", "group_id/id", "operation", "domain"])
            rows = list(reader)

        self.assertEqual(len(rows), 28)
        acls = [r for r in rows if not (r.get("domain") or "").strip()]
        rules = [r for r in rows if (r.get("domain") or "").strip()]
        self.assertEqual(len(acls), 16)
        self.assertEqual(len(rules), 12)

        for row in rows:
            self.assertNotIn(None, row)
            self.assertTrue(all(v is not None for v in row.values()))
            op = row["operation"].strip()
            self.assertTrue(op and set(op) <= {"c", "r", "u", "d"})
            model_id = row["model_id"].strip()
            self.assertTrue(model_id and "." in model_id and not model_id.startswith("model_"))

    def test_python_odoo20_invariants_and_compile(self):
        py_files = sorted(ADDON.rglob("*.py"))
        self.assertTrue(py_files)
        forbidden = (
            (re.compile(r"\.(?:get_param|set_param)\("), "icp get_param/set_param"),
            (re.compile(r"\b_sql_constraints\b"), "_sql_constraints"),
            (re.compile(r"\bosv\.expression\b"), "osv.expression"),
            (re.compile(r"\bclear_cache\b"), "clear_cache"),
            (re.compile(r"\b_table_query\b"), "_table_query"),
            (re.compile(r"""type\s*=\s*['"]json['"]"""), "type='json'"),
        )
        for py_file in py_files:
            src = py_file.read_text(encoding="utf-8")
            for pattern, label in forbidden:
                self.assertIsNone(pattern.search(src), f"{py_file.relative_to(ADDON)} contains {label}")
            py_compile.compile(str(py_file), doraise=True)

    def test_owl3_and_xml_invariants_and_parse(self):
        scan_roots = [ADDON / "static" / "src", ADDON / "views"]
        forbidden = ("useState", "static props", "defaultProps", "t-esc", "<tree")
        for root in scan_roots:
            for path in sorted(root.rglob("*")):
                if path.is_file() and path.suffix in {".js", ".xml", ".ts", ".mjs"}:
                    src = path.read_text(encoding="utf-8")
                    for token in forbidden:
                        self.assertNotIn(token, src, f"{path.relative_to(ADDON)} contains {token}")

        xml_files = sorted(ADDON.rglob("*.xml"))
        self.assertTrue(xml_files)
        for xml_file in xml_files:
            ET.parse(str(xml_file))


if __name__ == "__main__":
    unittest.main()
