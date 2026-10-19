"""Execute the Agent's actual unknown-outcome purge SQL against SQLite.

This verifies SQL semantics independently of the Go 1.26 build (unavailable
here). It is *not* a substitute for the Go queue/CLI package regression tests.
"""
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]


def _canonical_sql():
    src = (ROOT / "agent/internal/queue/cleanup.go").read_text()
    fn = src.split("func (q *Queue) PurgeOutcomeUnknown()", 1)[1].split("\n}", 1)[0]
    parts = re.search(r"q\.db\.Exec\(`([^`]+)`\s*\+\s*unknownMarkerSQL\(\"last_error\"\)\s*\+\s*`([^`]+)`", fn)
    assert parts, "PurgeOutcomeUnknown query structure changed; review test extraction"
    go = (ROOT / "agent/internal/queue/queue.go").read_text()
    block = go.split("var UnknownOutcomeMarkers = []string{", 1)[1].split("}", 1)[0]
    markers = re.findall(r'"([A-Z_]+)"', block)
    assert len(markers) == 5, "review changed physical-outcome vocabulary"
    condition = " OR ".join(f"last_error LIKE '{marker}%'" for marker in markers)
    return parts.group(1) + condition + parts.group(2)


def test_purge_retains_pending_gateway_report_but_removes_acknowledged_ones():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE print_jobs(id TEXT PRIMARY KEY, status TEXT, claim_token TEXT, last_error TEXT)")
    data = [
        ("pending-unknown", "failed", "live-token", "UNKNOWN_SUBMISSION_OUTCOME: ambiguous"),
        ("acked-unknown", "failed", None, "UNKNOWN_PARTIAL_DELIVERY: reconciled"),
        ("acked-clean", "failed", None, "before any output"),
        ("pending-clean", "failed", "live-token", "paper jam"),
        ("successful", "success", None, None),
    ]
    db.executemany("INSERT INTO print_jobs VALUES(?,?,?,?)", data)
    db.execute(_canonical_sql())
    retained = {row[0] for row in db.execute("SELECT id FROM print_jobs")}
    assert retained == {"pending-unknown", "acked-clean", "pending-clean", "successful"}
