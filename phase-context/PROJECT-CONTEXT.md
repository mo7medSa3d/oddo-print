# Engineering context — 2026-10-08

Repo: mo7medSa3d/oddo-print; baseline main fa2c5ab021e6bea6ce0af8383d5f22b5207b7b3b.
Working branch: engineering/poll-claim-budget-20261008; PR #127.
End-to-end: Odoo19 print intent → Gateway PostgreSQL durable jobs → authenticated Go Agent → Windows/physical printer → fenced status reconciliation.

Confirmed source fixes:
1. HTTP polling selected 20 rows then truncated 64MiB response. SQL now limits cumulative payload BEFORE claiming, so no withheld claim gets false evidence pending.
2. Queue 128MiB logical limit now sums octet_length(payload::text), not TOAST-compressed pg_column_size.
3. Maintenance and retention batch env overrides now reject values below 1 and clamp to 5000.

Evidence: GitHub run 37828492290 Go race/vet PASS, Gateway Typecheck/lint/build PASS, PostgreSQL integration 392 PASS, unit 929 PASS (6 skipped), Python 235 PASS, real Odoo19 addon 209 PASS; security and Docker PASS. Windows installer run 37828492253 is not yet certified completed in this checkpoint. See FINAL_VERIFICATION_REPORT.md.

Blockers: no physical Windows Agent/printer, full bidirectional Gateway↔Odoo hardware lab, realistic p99 1k/10k tenants, live DR restore/failover; these cannot be called passing or production-ready.
Do not read preexisting AUDIT_FINDINGS.md or previous logs as sources. Consult verified source and fresh tests; re-check GitHub CI against latest HEAD.