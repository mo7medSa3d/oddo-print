import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "odoo_addons19" / "print_gateway"


class TestDirectAgentContract(unittest.TestCase):
    """Static contract checks; no printer or Cloud service is contacted."""

    def test_agent_api_is_direct_and_complete(self):
        source = (ROOT / "controllers" / "agent_api.py").read_text(encoding="utf-8")
        for route in ("/api/agent/register", "/api/agent/heartbeat", "/api/agent/jobs", "/api/agent/ack"):
            self.assertIn(route, source)

    def test_job_creation_has_no_cloud_print_submission(self):
        source = (ROOT / "models" / "print_job.py").read_text(encoding="utf-8")
        for legacy in ("gateway_job_id", "gateway_wire_idempotency_key", "_cloud_base", "requests.post"):
            self.assertNotIn(legacy, source)

    def test_cloud_configuration_only_refreshes_licence(self):
        source = (ROOT / "models" / "print_config.py").read_text(encoding="utf-8")
        self.assertIn("/api/license/refresh", source)
        for path in ("/api/agents", "/api/printers", "/api/jobs", "/api/print-jobs"):
            self.assertNotIn(path, source)

    def test_unknown_physical_outcome_is_not_a_retryable_success(self):
        source = (ROOT / "models" / "print_job.py").read_text(encoding="utf-8")
        self.assertIn('"unknown"', source)
        self.assertIn("UNKNOWN_PARTIAL_DELIVERY", source)

    def test_legacy_cloud_jobs_are_quarantined_during_upgrade(self):
        source = (ROOT / "migrations" / "19.0.2.37.0" / "pre-migrate.py").read_text(encoding="utf-8")
        self.assertIn("LEGACY_CLOUD_JOB_REQUIRES_MANUAL_REVIEW", source)
        self.assertIn("SET status = 'unknown'", source)


if __name__ == "__main__":
    unittest.main()
