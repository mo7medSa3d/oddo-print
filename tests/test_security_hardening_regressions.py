"""Regression tests for Pass 1 & Pass 2 security and reliability hardening."""

import ast
import re
import unittest
from pathlib import Path
from xml.etree import ElementTree

REPO = Path(__file__).resolve().parent.parent


class Pass1Pass2SecurityHardeningTests(unittest.TestCase):
    def test_pg_ssl_rejects_no_verify_and_enforces_reject_unauthorized(self):
        src = (REPO / "src/db/index.ts").read_text(encoding="utf-8")
        match = re.search(
            r"function\s+parsePgSsl\(\)\s*:\s*PoolConfig\[\"ssl\"\]\s*\{(?P<body>.*?)\n\}",
            src,
            re.S,
        )
        self.assertIsNotNone(match, "parsePgSsl() must exist in src/db/index.ts")
        body = match.group("body")

        # Must never disable certificate verification or allow no-verify.
        self.assertNotIn("no-verify", body)
        self.assertNotRegex(body, r"rejectUnauthorized\s*:\s*false")

        # Must allow only disable (undefined) and require/verify-ca/verify-full
        # with rejectUnauthorized: true, and throw on all other values.
        self.assertRegex(body, r'mode\s*===\s*"disable"')
        for mode in ("require", "verify-ca", "verify-full"):
            self.assertIn(f'"{mode}"', body)
        self.assertRegex(body, r"rejectUnauthorized\s*:\s*true")
        self.assertIn("throw new Error(", body)

    def test_odoo_agent_pairing_authorization_and_stale_claim_retry_cap(self):
        agent_path = REPO / "odoo_addons/print_gateway/models/agent.py"
        src = agent_path.read_text(encoding="utf-8")
        tree = ast.parse(src, filename=str(agent_path))

        methods = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                methods[node.name] = node

        self.assertIn("action_generate_pairing_code", methods)
        pairing_src = ast.get_source_segment(src, methods["action_generate_pairing_code"]) or ""
        self.assertIn('has_group("base.group_system")', pairing_src)
        self.assertIn('check_access("write")', pairing_src)
        self.assertIn("raise AccessError", pairing_src)
        # Authorization checks must execute before sudo().write(...)
        sudo_pos = pairing_src.find("self.sudo().write")
        self.assertGreater(sudo_pos, 0)
        self.assertLess(pairing_src.find('has_group("base.group_system")'), sudo_pos)
        self.assertLess(pairing_src.find('check_access("write")'), sudo_pos)

        self.assertIn("_cron_sweep_stale_agents", methods)
        sweep_src = ast.get_source_segment(src, methods["_cron_sweep_stale_agents"]) or ""
        self.assertRegex(sweep_src, r"SET\s+status\s*=\s*'failed'")
        self.assertIn("AGENT_CLAIM_EXHAUSTED", sweep_src)
        self.assertRegex(sweep_src, r"COALESCE\(attempts,\s*0\)\s*>=\s*5")
        self.assertRegex(sweep_src, r"COALESCE\(attempts,\s*0\)\s*<\s*5")
        self.assertRegex(sweep_src, r"SET\s+status\s*=\s*'queued'")

    def test_odoo_security_xml_separates_read_hierarchy_from_root_only_writes(self):
        xml_path = REPO / "odoo_addons/print_gateway/security/security.xml"
        root = ElementTree.parse(xml_path).getroot()
        records = {}
        for rec in root.findall(".//record"):
            rec_id = rec.attrib.get("id")
            if not rec_id:
                continue
            fields = {}
            for field in rec.findall("field"):
                name = field.attrib.get("name")
                fields[name] = field.attrib.get("ref") or field.attrib.get("eval") or (field.text or "").strip()
            records[rec_id] = fields

        for prefix, model_ref in (
            ("rule_agent_company", "model_print_gateway_agent"),
            ("rule_printer_company", "model_print_gateway_printer"),
        ):
            read_rule = records.get(prefix)
            write_rule = records.get(f"{prefix}_write")
            self.assertIsNotNone(read_rule, f"Missing read rule {prefix}")
            self.assertIsNotNone(write_rule, f"Missing write rule {prefix}_write")

            self.assertEqual(read_rule["model_id"], model_ref)
            self.assertEqual(read_rule["groups"], "[(5, 0, 0)]")
            self.assertEqual(read_rule["perm_read"], "True")
            for perm in ("perm_write", "perm_create", "perm_unlink"):
                self.assertEqual(read_rule[perm], "False", f"{prefix} must not grant {perm}")
            self.assertIn("company_id.child_ids", read_rule["domain_force"])

            self.assertEqual(write_rule["model_id"], model_ref)
            self.assertEqual(write_rule["groups"], "[(5, 0, 0)]")
            self.assertEqual(write_rule["perm_read"], "False")
            for perm in ("perm_write", "perm_create", "perm_unlink"):
                self.assertEqual(write_rule[perm], "True", f"{prefix}_write must grant {perm}")
            self.assertEqual(write_rule["domain_force"], "[('company_id', 'in', company_ids)]")

    def test_tauri_logging_sanitizes_control_chars_and_redacts_secrets(self):
        src = (REPO / "src-tauri/src/logging.rs").read_text(encoding="utf-8")
        match = re.search(r"fn\s+sanitize_log_message\(msg:\s*&str\)\s*->\s*String\s*\{(?P<body>.*?)\n\}", src, re.S)
        self.assertIsNotNone(match, "sanitize_log_message must exist in src-tauri/src/logging.rs")
        body = match.group("body")

        self.assertIn("c.is_control()", body)
        self.assertIn('"[REDACTED]"', body)
        for marker in (
            '"authorization: bearer "',
            '"bearer "',
            '"pairing_code="',
            '"secret="',
            '"token="',
            '"password="',
            '"api_key="',
        ):
            self.assertIn(marker, body, f"sanitize_log_message must redact {marker}")

        write_match = re.search(r"fn\s+write_line\([^)]*\)\s*\{(?P<body>.*?)\n\}", src, re.S)
        self.assertIsNotNone(write_match, "write_line must exist in src-tauri/src/logging.rs")
        self.assertIn("sanitize_log_message(msg)", write_match.group("body"))

    def test_license_refresh_route_hardening(self):
        src = (REPO / "src/app/api/license/refresh/route.ts").read_text(encoding="utf-8")

        # SHA-256 constant-time matching (shared helper in license-signer.ts or local helper)
        signer_src = (REPO / "src/lib/license-signer.ts").read_text(encoding="utf-8")
        if "constantTimeSecretMatch" in src:
            self.assertRegex(
                src,
                r'import\s*\{[^}]*\bconstantTimeSecretMatch\b[^}]*\}\s*from\s*["\'][^"\']*license-signer["\']',
            )
            ct_match = re.search(
                r"export\s+function\s+constantTimeSecretMatch\([^)]*\)\s*:\s*boolean\s*\{(?P<body>.*?)\n\}",
                signer_src,
                re.S,
            )
            self.assertIsNotNone(ct_match, "constantTimeSecretMatch() must be exported from src/lib/license-signer.ts")
        else:
            ct_match = re.search(r"function\s+constantTimeMatch\([^)]*\)\s*:\s*boolean\s*\{(?P<body>.*?)\n\}", src, re.S)
            self.assertIsNotNone(ct_match, "constantTimeMatch() or constantTimeSecretMatch() must exist")
        ct_body = ct_match.group("body")
        self.assertIn('createHash("sha256")', ct_body)
        self.assertIn("timingSafeEqual", ct_body)

        # runtimeSecret usage for signing key & refresh secret
        self.assertIn('runtimeSecret("LICENSE_SIGNING_PRIVATE_KEY_PEM")', src)
        self.assertIn('runtimeSecret("LICENSE_REFRESH_SECRET")', src)
        self.assertNotIn("process.env.LICENSE_SIGNING_PRIVATE_KEY_PEM", src)
        self.assertNotIn("process.env.LICENSE_REFRESH_SECRET", src)

        # 16 KB body limit returning 413
        self.assertRegex(src, r"hasBodyOverLimit\(\s*req\s*,\s*16\s*\*\s*1024\s*\)")
        self.assertIn("status: 413", src)

        # Transactional execution
        self.assertIn("db.transaction(", src)


if __name__ == "__main__":
    unittest.main()
