"""F026 DOC01-05: operational documentation agrees with shipping code contracts.
Source-only checks; no migration, printer, Windows or gateway command is executed.
"""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]

def read(rel): return (ROOT/rel).read_text(encoding='utf-8')

def test_migration_inventory_matches_current_journal():
    journal=json.loads(read('drizzle/meta/_journal.json'))['entries']
    sql=sorted((ROOT/'drizzle').glob('*.sql'))
    assert len(journal)==len(sql)==81
    assert journal[-1]['tag']=='0080_inventory_snapshot_version'
    assert '0080 | 1 |' in read('MIGRATION.md')
    assert '**Total**: 81 forward-only SQL migrations (0000–0080)' in read('MIGRATION.md')

def test_adr_targets_are_not_presented_as_measured_guarantees():
    content=read('ADR.md')
    assert '100% reliable job delivery' not in content
    assert 'easily handles 1,000+ print jobs per second' not in content
    assert 'Sub-100ms real-time delivery during normal operation.' not in content
    assert '15MB RAM footprint' not in content
    assert 'not a production benchmark' in content

def test_recovery_script_never_targets_processes_by_image_name_or_unauthenticated_api():
    content=read('docs/WINDOWS_SERVICE_RECOVERY.md')
    assert 'Get-Process YaseirAgent' not in content
    assert 'Get-CimInstance Win32_Service' in content
    assert 'Get-CimInstance Win32_Process' in content
    assert 'ExecutablePath' in content and 'CreationDate' in content
    assert 'Invoke-RestMethod "http://localhost:3000/api/agents/health' not in content
    assert 'agents.read' in content

def test_first_run_auth_cookie_and_unknown_heartbeat_are_truthful():
    source=read('SERVER_FIRST_RUN.md')
    assert '`cust_session` HttpOnly cookie' in source
    assert '`cust_refresh`' in source
    assert 'A stale heartbeat is treated as offline.' not in source
    assert 'unknown' in source

def test_document_diagnostic_pdf_supported_for_spooler_and_ipp():
    source=read('TROUBLESHOOTING.md')
    assert 'Spooler and IPP printers are document transports that require driver-rendered content.' not in source
    assert 'generated PDF test ticket' in source
    assert 'Real document/report' in source
