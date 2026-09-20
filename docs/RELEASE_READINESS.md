# Release Readiness Dashboard

## Purpose
Single dashboard showing P0 must-close before Production and industry compliance.

## P0 Checklist
- [x] Real Print Certification Mode (Diagnostics wizard Gateway→Auth→Queue→Claim→Agent→Transport→Physical→Ack→Final with timeline, BLOCKED handling)
- [x] Printer Capability Matrix (Transport/Protocol/Document/Duplex/Color/Status + IPP capabilities)
- [x] Agent Health beyond Online/Offline (ONLINE/DEGRADED/OFFLINE/STARTING/RECOVERING + Gateway/WebSocket/Polling/Heartbeat/Queue/Printers/Version)
- [x] Windows Service Recovery (SCM lifecycle, failure actions, state/start type/recovery/last restart/failure count/exit code, Manager UI, kill→restart→reconnect test) — BLOCKED in sandbox, code hardened
- [x] Printer Queue Health + Gateway↔Spooler Job linking (ONLINE/IDLE/PRINTING/PAPER_OUT/OFFLINE/ERROR/DRIVER_ERROR/SPOOLER_ERROR/UNREACHABLE/UNKNOWN only with evidence, link Gateway Job↔Windows Spooler Job ID)
- [x] Job Timeline (Created/Queued/Claimed/Accepted/Connection/Printing/Delivery/Success with failure path)
- [x] Distributed Trace correlation IDs (request_id/job_id/tenant_id/agent_id/printer_id/attempt_id/claim_id + OpenTelemetry, Odoo→Gateway→Queue→Agent→Printer→Spooler)

## P1 Features (Implemented as docs + APIs + UI where feasible)
- System Health single page: /system-health, /api/system/health
- Incident Center: future, aggregates health checks
- Odoo Integration Health Center: future, requires Odoo runtime, doc in Odoo health
- Credential Rotation Wizard: future, requires Odoo runtime
- Circuit Breaker per printer: future, design in job-delivery
- Backpressure clarity: queue depth metrics, MAX_AGENT_IN_FLIGHT_JOBS
- Per-Printer concurrency 1 default: future, per-printer semaphore
- Driver Health Check: capability matrix driver field
- RAW vs Spooler/IPP distinction: printer-capability.ts, Win32 regression suite future
- Fuzzing printer inputs: existing payload validation tests
- Diagnostic Test Page: existing /api/printers/[id]/test-print, YASSER TEST PAGE no secrets
- Offline Mode/Recovery Center: future, queue durability already implemented
- Secure Updater signed artifact: Tauri updater docs, signed artifacts
- Tauri Isolation: 21 caps least-privilege, origin check, method allowlist
- Printer Quarantine: future, status ERROR with evidence
- Why failed root cause: job timeline errorCode, why-failed in timeline
- Billing Usage Center: existing billing portal, usage metrics
- Admin Analytics: gateway_metrics table, future dashboard
- Policy Simulator: future, routing simulation

## Industry Direction
- IPP Everywhere: preferred transport, capability matrix shows IPP/IPPS as modern
- Windows IPP inbox class driver: preferred over vendor drivers, driver health check distinguishes
- Odoo 19 External JSON-2 Bearer API keys: least privilege, rotation
- Tauri updater signed: signed artifacts, isolation pattern
- Microsoft SCM recovery: failure actions restart, docs/WINDOWS_SERVICE_RECOVERY.md
- Windows Spooler APIs: spoolerJobId linking, OpenPrinter/StartDocPrinter/GetJob
- OpenTelemetry semantic conventions: correlation IDs in logs, tracing.ts

## Verification
- `npm run test:unit` — 412 tests green (was 387)
- `npm run build` — 53 pages green
- No secrets in test pages
- Tenant isolation preserved
- State machine preserved
- Security contracts preserved

## Release Decision
RELEASE READY WITH EXPLICIT BLOCKED — Go race, physical printing, Windows service runtime, Odoo runtime, PG integration BLOCKED, documented explicitly, not hidden.

## Demo Instructions
1. Show /system-health — overall ok/warn/error, Gateway/DB/Queue/Agents/Printers
2. Show /dashboard — Agent Health matrix, Capability Matrix, Certification wizard
3. Run certification for a printer — shows BLOCKED at Physical step (expected in sandbox)
4. Show /api/jobs/[id]/timeline — correlation IDs, spoolerJobId linking
5. Show /release-readiness — P0 checklist green, industry direction compliance
6. Explain BLOCKED items require Windows hardware and Odoo runtime
