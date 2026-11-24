from pathlib import Path

from odoo.tests import tagged
from odoo.tests.common import TransactionCase


@tagged("post_install", "-at_install")
class TestDirectAgentContract(TransactionCase):
    """Static contract checks; no printer or Cloud service is contacted."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.addon_root = Path(__file__).resolve().parents[1]

    def test_agent_api_is_direct_and_complete(self):
        source = (self.addon_root / "controllers" / "agent_api.py").read_text()
        for route in ("/api/agent/register", "/api/agent/heartbeat", "/api/agent/jobs", "/api/agent/ack"):
            self.assertIn(route, source)

    def test_job_creation_has_no_cloud_print_submission(self):
        source = (self.addon_root / "models" / "print_job.py").read_text()
        for legacy in ("gateway_job_id", "gateway_wire_idempotency_key", "_cloud_base", "requests.post"):
            self.assertNotIn(legacy, source)

    def test_cloud_configuration_only_refreshes_licence(self):
        source = (self.addon_root / "models" / "print_config.py").read_text()
        self.assertIn("/api/license/refresh", source)
        for path in ("/api/agents", "/api/printers", "/api/jobs", "/api/print-jobs"):
            self.assertNotIn(path, source)

    def test_unknown_physical_outcome_is_not_a_retryable_success(self):
        source = (self.addon_root / "models" / "print_job.py").read_text()
        self.assertIn('"unknown"', source)
        self.assertIn("UNKNOWN_PARTIAL_DELIVERY", source)

    def test_legacy_cloud_jobs_are_quarantined_during_upgrade(self):
        source = (self.addon_root / "migrations" / "19.0.2.37.0" / "pre-migrate.py").read_text()
        self.assertIn("LEGACY_CLOUD_JOB_REQUIRES_MANUAL_REVIEW", source)
        self.assertIn("SET status = 'unknown'", source)
