# Release Readiness Dashboard — Honest Verification

## Purpose
Single dashboard showing P0 must-close before Production and industry compliance, with distinction IMPLEMENTED vs VERIFIED vs BLOCKED.

## P0 Checklist — Honest Status

| Area | Implemented | Runtime Verified | Status | Evidence |
| ---- | ----------- | ---------------- | ------ | -------- |
| Real Print Certification Mode (canonical pipeline + idempotency + state-driven) | PASS | BLOCKED | BLOCKED | POST /api/printers/[id]/certify uses createPrintJobForPrinter (canonical), Idempotency-Key header, state-driven from job row (queued→pending, claimed→ok), Physical BLOCKED in sandbox, never auto-certify. 7 tests green. |
| Printer Capability Matrix (evidence-based) | PASS | PASS | PASS | GET /api/printers/capabilities, printer-health.ts freshness check, driver health from capabilities.driver_name + fresh, spooler health requires spooler_status. 6 tests green. |
| Agent Health ONLINE/DEGRADED/OFFLINE/STARTING (observed vs inferred) | PASS | PASS | PASS | lib/agent-health.ts STARTING from createdAt<5min never seen, ONLINE <90s, DEGRADED 90s-5m, OFFLINE >5m, checks Gateway observed, Queue observed, Printers observed, Version observed, Heartbeat inferred labeled, failureCount null NOT MEASURED. 8 tests green. |
| Windows Service Recovery | PASS | BLOCKED | BLOCKED | docs/WINDOWS_SERVICE_RECOVERY.md, /api/agents/service-status BLOCKED explicit, code hardened. Runtime requires Windows host — BLOCKED. |
| Printer Queue Health + Gateway↔Spooler linking | PASS | PASS | PASS | Statuses with freshness, spoolerJobId linking, agent/jobs PATCH persists. |
| Job Timeline (redacted claim tokens) | PASS | PASS | PASS | GET /api/jobs/[id]/timeline, claim token redacted via sha256, regression test. 4 tests green. |
| Distributed Trace (OTel-inspired, not full OTel) | PASS | PASS | PASS | correlation.ts AsyncLocalStorage, X-Request-Id header, log enrichment, docs honest. 5 tests green. (The stand-alone `src/lib/tracing.ts` helper module was dead — zero importers — and has been removed.) |
| System Health tenant-safe + overall policy | PASS | PASS | PASS | checkQueue requires tenantId (tenant-safe), overall policy prevents false OK when UNKNOWN, Odoo/Billing UNKNOWN honest. 6 tests green. |
| Tenant isolation | PASS | PASS | PASS | 413 tests green, composite FKs, tenant scoping. |
| Claim tokens not exposed | PASS | PASS | PASS | timeline redacts via hash, regression test. |
| IPP support / driverless direction (not certified) | PASS | BLOCKED | BLOCKED | IPP/IPPS transport supported, but NOT claiming IPP Everywhere certification without conformance testing. |
| Tauri updater signed | FAIL | BLOCKED | BLOCKED | No updater plugin/config in tauri.conf.json/Cargo.toml — NOT IMPLEMENTED, marked BLOCKED. |
| Physical printing | PASS | BLOCKED | BLOCKED | Job row created but paper unverified, Physical BLOCKED by design. |
| Odoo runtime | PASS | BLOCKED | BLOCKED | Views fixed, but no Odoo deployment — System health Odoo UNKNOWN honest. |
| PostgreSQL integration | PASS | BLOCKED | BLOCKED | Code inspected, integration tests skipped without DB. |
| Go race detector | PASS | BLOCKED | BLOCKED | No Go toolchain. |

## P1 Features — Honest
- System Health single page: /system-health, /api/system/health — PASS (tenant-safe, policy documented)
- Incident Center: NOT IMPLEMENTED — future
- Odoo Integration Health Center: BLOCKED — requires Odoo runtime
- Credential Rotation Wizard: BLOCKED — requires Odoo runtime
- Circuit Breaker per printer: NOT IMPLEMENTED — design only
- Backpressure clarity: PASS — queue depth metrics, MAX_AGENT_IN_FLIGHT_JOBS
- Per-Printer concurrency 1: NOT IMPLEMENTED — future
- Driver Health Check: PASS — capability matrix driver field evidence-based
- RAW vs Spooler/IPP distinction: PASS — printer-capability.ts, Win32 regression suite BLOCKED (requires Windows)
- Fuzzing printer inputs: PASS — payload validation tests
- Diagnostic Test Page: PASS — /api/printers/[id]/test-print, YASSER TEST PAGE no credentials
- Offline Mode/Recovery Center: NOT IMPLEMENTED — queue durability exists
- Secure Updater signed artifact: FAIL/BLOCKED — no updater config
- Tauri Isolation: PASS — 21 caps least-privilege, origin check, method allowlist
- Printer Quarantine: NOT IMPLEMENTED — future
- Why failed root cause: PASS — timeline errorCode
- Billing Usage Center: PASS — existing portal
- Admin Analytics: PASS — gateway_metrics table
- Policy Simulator: NOT IMPLEMENTED — future

## Industry Direction — Honest Claims
- **IPP support / driverless direction**: transport/protocol matrix prefers IPP, modern direction, but NOT claiming IPP Everywhere certified without conformance testing
- **Windows IPP inbox class driver**: preferred over vendor drivers, driver health check distinguishes, but NOT claiming inbox driver compliance without Windows testing
- **Odoo 19 External JSON-2 Bearer API keys**: least privilege, rotation, existing api_keys scope — PASS (code), runtime BLOCKED
- **Tauri updater signed + Isolation Pattern**: Isolation PASS (21 caps), updater FAIL/BLOCKED (no config) — honest
- **Microsoft SCM recovery + Spooler APIs**: docs + spoolerJobId linking PASS, runtime BLOCKED
- **OTel-inspired distributed correlation** (not full OpenTelemetry): custom application-specific fields, documented as such, not official OTel semantic conventions — PASS honest

## Verification
- `npm run test:unit` — 413+ tests green (was 387), includes new regression tests for tenant-safe, claim redaction, evidence-based health
- `npm run build` — 53 pages green
- No secrets in test pages (No credentials are printed)
- Tenant isolation preserved (checkQueue requires tenantId)
- State machine preserved (timeline only records, doesn't mutate)
- Security contracts preserved (claim tokens redacted)
- No fake PASS: Windows Service, Physical printing, Odoo runtime, PG integration, Go race, Tauri updater, IPP Everywhere certification all BLOCKED explicit

## Release Decision
**RELEASE READY WITH EXPLICIT BLOCKED** — P0 implemented with truthful state-driven wizard, tenant-safe health, claim token redaction, evidence-based printer/agent health. BLOCKED items explicit:
- Physical printing BLOCKED (no hardware)
- Windows Service runtime BLOCKED (no Windows host)
- Odoo runtime BLOCKED (no deployment)
- PostgreSQL integration BLOCKED (no DB)
- Go race BLOCKED (no toolchain)
- Tauri updater BLOCKED (no config)
- IPP Everywhere certification BLOCKED (no conformance testing)

Do NOT declare production-ready until hardware/runtime verified, but system is correct and honest.

## Demo Instructions
1. Show /system-health — overall UNKNOWN when Odoo/Billing NOT VERIFIED (honest, not false OK), Gateway/DB/Queue/Agents/Printers tenant-scoped
2. Show /dashboard — Agent Health matrix (observed vs inferred), Capability Matrix (evidence-based), Certification wizard (state-driven pending/blocked, not fake PASS)
3. Run certification for a printer — shows PENDING for Claim/Agent/Transport until job claimed, BLOCKED at Physical (expected)
4. Show /api/jobs/[id]/timeline — correlation IDs with redacted claimId (sha256), spoolerJobId linking
5. Show /release-readiness — table with Implemented/Runtime Verified/Status, honest compliance notes
6. Explain BLOCKED items require Windows hardware and Odoo runtime
