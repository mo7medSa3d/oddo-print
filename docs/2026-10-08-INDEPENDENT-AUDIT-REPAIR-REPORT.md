# Independent audit repair report — 2026-10-08

Baseline: GitHub `main` at `f57f0657a695384df68374de6e8dd23f201b6935`; local source from `oddo-print-main (2).zip` compared to baseline. Changes are prepared for application/review; this document is not evidence of a published GitHub commit or a production deployment.

| Finding | Repair / mitigation | Validation still required |
|---|---|---|
| F-01 P1 | Operation Type Print Rule can be reportless for ZPL/TSPL/ESC-POS/RAW label; stock PDF remains a separate reportful delivery route; exact protocol filtered before priority | Odoo 19 addon upgrade and label on real printer |
| F-02 P1 | Pre-routing failures now persist a `failed` Intent with diagnostic and retry schedule under the business transaction; independent postcommit worker remains responsible for dispatch | Commit/restart/crash recovery live Odoo 19 |
| F-03 P2 | Reconciliation uses persisted last-attempt timestamp, bounded batches and `FOR UPDATE SKIP LOCKED`, no permanent old-ID starvation | PostgreSQL concurrency and workload fairness |
| F-04 P2 | Stock validation and invoice posting propagate a deterministic transition identity for distinct business transitions; duplicate same-transition calls retain one key | Repost and backorder real workflows |
| F-05 P2 | Removed `printed` filter as `success` alias; `success` is transport success; physical outcome remains `unknown` without independent proof | Confirm downstream dashboard wording |
| F-06 P2 | Reject unsupported ESC/POS peripheral options on image-based POS Print Rules; raw command peripherals retained | Hardware-specific behavior and user migration |
| F-07 P2 | IPP probes `document-format-supported`; no PDF submission without positive format evidence, advertises observed PDF in Odoo discovery | Multiple IPP devices incl. unsupported PDF |
| F-08 P2 | Distinguish IPP DNS/TLS/auth/timeout/protocol probe failures with bounded reasons, without falsely asserting physical offline | Gateway/UI renders status_detail on real fleet |
| F-09 P2 | Raw templates only access referenced fields (including m2o name/id), not every ORM field | High-volume/large record workload |
| F-10 P2 | Reject format specs, conversions and dangerous attribute references; strict template/output byte caps | Template compatibility with existing customer rules |
| F-11 P2 | Stable bounded pagination for Odoo control-plane APIs, exact-ID printer/agent lookups, picker pagination | Large-fleet performance/load testing |
| F-12 P3 | IPP local Test prints a valid small PDF through normal guarded document dispatch | Physical printer test required |
| F-13 P3 | Extract bounded inventory/lookup helper and isolate business rules incrementally; **large-file refactor remains architectural debt** rather than risky rewrite | Separate low-risk refactor phases |
| F-14 P3 | Require explicit POS paid automation opt-in when adding a second normal POS receipt/kitchen ticket; show warning | POS 19 end-to-end duplicate ticket scenario |

### Test truth

Static/portable Python tests can verify source shape and bounded render logic. They cannot establish live Odoo transactions, native Win32 spooler installation, TCP/IPPS device behavior or physical paper completion. Node >=24.15, Go >=1.26 (go toolchain 1.26.8), Rust/Tauri/NSIS, PostgreSQL and Odoo 19 integration must be executed in the official CI/hardware staging. Preserve all existing tests, do not declare blocked checks passed, and do not roll out without backing up the database and upgrading the addon.
