"""F019/O7: actual compute method, controlled ORM records; NOT an installed Odoo19/PG acceptance."""
from types import SimpleNamespace
import pytest
from test_f010_report_binding_identity import production_methods

Compute = production_methods('print_job.py', ['_compute_physical_outcome'])


class Jobs(list):
    _GATEWAY_UNKNOWN_MARKERS = ('UNKNOWN_SUBMISSION_OUTCOME:', 'AGENT_EXECUTION_TIMEOUT:',
                                'AGENT_RESTART_DURING_PRINT:', 'JOB_EXPIRED_DURING_PRINT:')


@pytest.mark.parametrize('status,remote,error,expected', [
    ('queued', False, False, 'not_printed'),
    ('queued', 'gw-already-admitted', False, 'unknown'),
    ('queued', False, 'UNKNOWN_SUBMISSION_OUTCOME: response lost', 'unknown'),
    ('submitted', 'gw', False, 'unknown'),
    ('claimed', 'gw', False, 'unknown'),
    ('printing', 'gw', False, 'unknown'),
    ('success', 'gw', False, 'unknown'),
    ('unknown', False, False, 'unknown'),
    ('partial', 'gw', False, 'unknown'),
    ('failed', False, 'GATEWAY_REJECTED_422: validation', 'not_printed'),
    ('failed', False, 'GATEWAY_REJECTED_503: PRINTER_OFFLINE', 'not_printed'),
    ('failed', False, 'CONNECTION_ERROR: cannot resolve gateway', 'not_printed'),
    ('failed', 'gw-print-attempted', 'PRINTER_ERROR', 'unknown'),
    ('failed', False, 'PRINTER_ERROR', 'unknown'),
    ('failed', 'gw-print-attempted', 'AGENT_EXECUTION_TIMEOUT: clock', 'unknown'),
])
def test_cannot_report_definite_nonprint_without_authoritative_pre_dispatch_evidence(status,remote,error,expected):
    job = SimpleNamespace(status=status, gateway_job_id=remote, last_error=error, physical_outcome=None)
    Compute._compute_physical_outcome(Jobs([job]))
    assert job.physical_outcome == expected
