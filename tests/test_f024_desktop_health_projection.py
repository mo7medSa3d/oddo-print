"""F024/D06 shared freshness-aware Desktop printer counts/status contract.

Source wiring regressions; React rendering and native Tauri runtime NOT_RUN.
"""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'src' / 'desktop'


def read(path): return (DESKTOP / path).read_text(encoding='utf-8')


def test_shared_projection_requires_advancing_clock_for_all_counts():
    h = read('lib/printers.ts')
    assert 'export function printerHealthCounts(' in h
    assert 'export function printerDisplayStatus(p: PrinterInfo, nowMs = Date.now())' in h
    assert 'effectivePrinterStatus(p, undefined, nowMs)' in h
    for page in ('pages/Overview.tsx', 'pages/Agents.tsx', 'main.tsx'):
        content = read(page)
        assert 'printerHealthCounts(' in content, page
        assert 's.nowMs' in content if page != 'main.tsx' else 'printerHealthCounts(physicalPrinters, nowMs)' in content


def test_no_raw_online_comparison_in_consumer_pages():
    for name in ('pages/Overview.tsx', 'pages/Agents.tsx', 'pages/Printers.tsx', 'pages/Settings.tsx'):
        content = read(name)
        assert 'p.status === "online"' not in content, name
        assert 'p.status === "offline"' not in content, name
    source = read('main.tsx')
    assert 'printerDisplayStatus(p, nowMs) === statusFilter' in source
    assert 'printerDisplayStatus(selectedPrinter, nowMs)' in source


def test_status_badges_and_exports_honor_snapshot_expiry():
    for name in ('pages/Overview.tsx','pages/Printers.tsx','pages/Settings.tsx'):
        source = read(name)
        assert 'printerDisplayStatus(p, ' in source, name
    assert 'printerDisplayStatus(p, s.nowMs)' in read('pages/Settings.tsx')
    assert 'printerHealthCounts(s.printers.filter(isProductionPrinter), nowMs)' in read('pages/Printers.tsx')
