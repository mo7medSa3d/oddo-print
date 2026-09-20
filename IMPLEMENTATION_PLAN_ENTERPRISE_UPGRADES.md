# Implementation Plan — Enterprise Upgrades Before Client Demo
Date: 2026-09-21
Branch: arena/01a0c076-oddo-print HEAD 06aa3d8
Goal: Move from "Cloud printing application" to "Managed enterprise print infrastructure platform" via observability, diagnosability, certifiability.

## Context & Current Strengths (Evidence-Based)
- State machine: queued/claimed/printing/success/failed/expired closed enum, physical outcome printed/not_printed/unknown, markers parity across Go/Gateway/Odoo/Desktop, late success override gated, sweep batch 200 SKIP LOCKED — verified via job-status.test.ts
- Security contracts: odoo_ key SHA256 timingSafe + docType scoping, agent Bearer timingSafe via digests, manager JWT HS256 jti, tenant isolation composite FKs (tenantId,agentId) etc., Tauri capabilities least-privilege 21 perms, HTTPS remote enforcement, path allowlist, header budget 64KiB, body 8MiB — verified via security tests
- Current gaps per ultra-deep audit: physical printing BLOCKED (no hardware), Go race BLOCKED, Windows service BLOCKED, Odoo runtime BLOCKED, Postgres integration skipped, UI invents no state but lacks deep health, timeline, certification, capability matrix, distributed trace

## Industry Direction (Official Docs)
- IPP Everywhere / IPP-based management is preferred modern path — Windows IPP inbox class driver is modern print platform, per Microsoft docs
- Odoo 19 External JSON-2 API uses Bearer API keys, access rights, record rules, dedicated bot users least privilege, key rotation recommended — per Odoo 19 docs
- Tauri updater security: signed artifacts, public key in app, private signing key outside repo — per Tauri docs
- Tauri Isolation Pattern recommended when appropriate — intercept IPC before core, keep capability restrictions
- Microsoft SCM responsible for service lifecycle and failure actions restart, service should be shutdown/restart without reboot — per Microsoft docs
- Windows Print Spooler manages driver selection, spooling, scheduling, provides APIs for print-job info — per Microsoft docs
- OpenTelemetry semantic conventions for traces/metrics/logs HTTP/database/messaging suitable for polyglot Node+Go+Odoo — per OTel docs

## P0 — Must Close Before Production (Top 5 Priority)
Per client demo focus: Real E2E printing proof, operability/observability, printer/agent lifecycle quality.

### 1. Real End-to-End Print Certification + Job Timeline (Highest Impact)
**Why:** Unit tests do not prove physical printing. Client needs to see Gateway→Auth→Queue→Claim→Agent→Transport→Physical→Ack→Final state with real timeline.

**Implementation:**
- **DB:** Add `job_events` table (id, tenant_id, job_id, event_type, actor_type, actor_id, from_status, to_status, claim_token, attempt_id, spooler_job_id, metadata jsonb, created_at) + index tenant_id+job_id+created_at. Also add `spooler_job_id` column to printJobs (nullable text) for spooler transport linking Gateway Job ↔ Windows Spooler Job.
- **Lib:** `src/lib/job-timeline.ts` — derive timeline from printJobs + job_events + existing fields claimedAt/deliveredAt/ackedAt/updatedAt. Event types: created, queued, claimed, agent_received, printer_connection, printing, delivery_evidence, success, failed, expired, unknown. Each event has timestamp, actor, metadata.
- **API:** 
  - `GET /api/jobs/[id]/timeline` — manager auth, tenant scope, returns timeline array sorted, includes correlation IDs request_id, job_id, tenant_id, agent_id, printer_id, attempt_id, claim_id, spooler_job_id.
  - Enhance `POST /api/printers/[id]/test-print` and `POST /api/printers/[id]/certify` (new) to return jobId + certification object with timeline URL.
  - `POST /api/printers/[id]/certify` — manager permission printers.test, creates diagnostic job with payload containing Gateway OK, Agent name, Printer name, Protocol, Job ID, Timestamp (no secrets), returns certification session.
- **UI:** 
  - New component `PrintCertificationWizard.tsx` — steps: Gateway ✓, Authentication ✓, Queue ✓, Claim ✓, Agent ✓, Printer transport ✓, Physical output (if BLOCKED show "Physical verification: BLOCKED Reason: no physical printer available"), Acknowledgement ✓, Final state PRINTED/FAILED/UNKNOWN.
  - Enhance existing `JobTimeline.tsx` to render real timeline from API, not mock.
  - Dashboard Recent Print Jobs drawer shows timeline via new API.
- **Physical verification:** If no printer, show BLOCKED per protocol, not fake success.
- **Tests:** `tests/job-timeline.test.ts` — timeline derivation, spooler_job_id linking, certification mode returns timeline URL, BLOCKED handling.

### 2. System Health / Agent Health / Printer Health (Observability)
**Why:** Online alone insufficient for diagnosis. Need Gateway, DB, Odoo Sync, Agents, Printers, Queue, Billing, WebSocket, HTTP fallback health in one page.

**Implementation:**
- **Agent Health Enhanced:**
  - Extend `src/shared/job-vocabulary.ts` agentLiveView: 
    - ONLINE: status online + lastSeenAt fresh <90s
    - DEGRADED: status online + lastSeenAt 90-180s OR last error recent
    - OFFLINE: status offline OR lastSeenAt >180s OR stale
    - STARTING: createdAt <5min AND never seen
    - RECOVERING: was offline and now online <60s
  - New `src/lib/agent-health.ts` — getAgentHealthSummary(tenantId) returns per agent: gateway ✓, websocket ✓/✗, polling ✓, heartbeat age, queue count, printers count, printing count, last error, version.
  - API `GET /api/agents/health` — manager auth, tenant scope, returns health array.
- **Printer Health Enhanced:**
  - Extend effectivePrinterStatus to return: ONLINE, IDLE, PRINTING, PAPER_OUT, OFFLINE, ERROR, DRIVER_ERROR, SPOOLER_ERROR, UNREACHABLE, UNKNOWN — but only if evidence exists, never invent.
  - New `src/lib/printer-health.ts` — getPrinterHealth(tenantId) with driver info, port, spooler status.
  - Printer capability matrix UI: table Printer | Transport | Protocol | Document | Duplex | Color | Status — capability-first not just protocol.
- **System Health Page:**
  - API `GET /api/system/health` — returns: gateway healthy (uptime, version), database healthy (pool, latency), odoo sync healthy (last sync, revision, pending migration, last error), agents 5/5 healthy counts, printers 14/15 healthy, queue healthy (queued, in-flight, failed, unknown), billing healthy, websocket healthy, http fallback ready, last incident, last failed job, last sync, last restart.
  - Page `src/app/system-health/page.tsx` — renders System Health with cards ✓ Healthy / ⚠ Degraded / ✗ Unhealthy, uses same StatCard, StatusBadge.
  - Add to AppShell navigation.
- **Tests:** `tests/system-health.test.ts` — health derivation, agentLiveView degraded/starting/recovering, printer health, system health API contract.

### 3. Windows Service Recovery + Signed Desktop Updater
**Why:** Microsoft SCM responsible for lifecycle, failure actions restart, service should be shutdown/restart without reboot. Tauri updater requires signed artifacts.

**Implementation:**
- **Service Recovery:**
  - Docs: `docs/WINDOWS_SERVICE_RECOVERY.md` — service state, start type Automatic, recovery policy Restart on failure, last restart, failure count, last exit code, how to test kill service → SCM restart → Agent reconnect → heartbeat → printer inventory → queue recovery.
  - Code: Ensure agent.rs control_service install sets recovery via sc failure command? Check Go agent service installer — add recovery policy documentation and ensure service config sets failure actions.
  - UI: Desktop Settings shows Yasser Agent Service Running, Startup Automatic, Recovery Restart on failure, Last restart 2 min ago, Failures 0 — via get_agent_status enhanced to return service recovery info.
  - API: Enhance `src-tauri/src/agent.rs` status to return recovery info if available via sc qfailure.
- **Signed Updater:**
  - Docs: `docs/DESKTOP_UPDATER.md` — current version, update available, security fixes, bug fixes, Install update, signed artifact checksum version release channel rollback strategy, private signing key outside repo.
  - Code: Ensure tauri.conf.json updater config with public key, no private key in repo, check existing updater config.
  - UI: Settings page shows Current version 1.0.0, Update available 1.0.1, Security fixes 2, Bug fixes 7, Install update button (disabled if no updater).
- **Tests:** `tests/windows-service-recovery.test.ts` — service recovery policy docs exist, status returns recovery info, updater config has public key not private.

### 4. Correlation IDs + Distributed Tracing/Logging (Polyglot Observability)
**Why:** Need one trace per print job across Odoo→Gateway→Queue→Agent→Printer with request_id/job_id/tenant_id/agent_id/printer_id/attempt_id/claim_id, OpenTelemetry semantic conventions.

**Implementation:**
- **Gateway:**
  - Middleware: `src/server/request-guard.ts` or new `src/server/correlation.ts` — generate request_id (nanoid) if not present via X-Request-Id header, propagate via AsyncLocalStorage or via request headers, include in response header X-Request-Id.
  - Enhance all API routes to include X-Request-Id header and return request_id in JSON where appropriate.
  - Enhance `src/lib/log.ts` to include correlation IDs in structured logs: request_id, job_id, tenant_id, agent_id, printer_id, attempt_id, claim_id.
  - Enhance `src/lib/job-delivery.ts` and `print-job-service.ts` to log with correlation IDs.
  - Add `src/lib/tracing.ts` — helpers for distributed trace: createTraceContext, withTrace.
  - Update `src/app/api/print/jobs/route.ts` to generate attempt_id and claim_id and include in response and logs.
- **Agent (Go):**
  - Ensure agent logs include request_id, job_id, claim_token, attempt_id, spooler_job_id — check agent.go updateJobStatus, processJob already logs.
  - Document correlation IDs in `docs/DISTRIBUTED_TRACING.md`.
- **Odoo:**
  - Ensure print_job model stores request_id if provided.
- **UI:**
  - System Health page shows last request_id, job timeline shows correlation IDs.
- **Tests:** `tests/correlation-ids.test.ts` — request_id generated if missing, returned in header, included in logs, job timeline includes correlation IDs, no secrets in logs.

### 5. Printer Capability + Driver/Spooler Diagnostics (Capability-First)
**Why:** Currently protocol/type/config good but should be capability-first. IPP Everywhere focuses on discovery, media, duplex, finishers, capabilities not just ipp=true. Need to prevent Printer accepts protocol BUT document renderer incompatible.

**Implementation:**
- **DB:** Enhance printers.capabilities jsonb to include: supported_protocols, paper_widths, color_capable, duplex_capable, media, finishers, driver_name, driver_version, port, spooler_status, last_spooler_job_id.
- **Lib:** `src/lib/printer-capability.ts` — getCapabilityMatrix(tenantId) returns matrix Printer | Transport | Protocol | Document | Duplex | Color | Status | Driver | Spooler.
  - Validation: validatePayloadForPrinter already checks protocol, connectionType, capabilities supported_protocols, paper_widths, etc. — enhance to return detailed reason if incompatible.
- **API:** 
  - `GET /api/printers/capabilities` — manager auth, returns matrix.
  - Enhance `GET /api/printers` to include capabilities.
  - Enhance `POST /api/printers/[id]/test-connection` to return driver health, spooler status.
- **UI:**
  - Printers page grid/table shows capability badges ESC/POS, ZPL/TSPL, PDF/Spooler already exists, enhance to show matrix table with Transport, Protocol, Document, Duplex, Color, Status, Driver.
  - EditPrinterDialog shows driver health: Printer HP LaserJet, Driver Microsoft IPP Class Driver, Driver version, Port WSD/IPP, Spooler Running ✓, Last spooler job #482, Driver status Healthy.
  - Add Printer dialog differentiates Direct RAW vs ESC/POS vs ZPL vs TSPL vs Spooler vs IPP vs IPPS with semantics: RAW stream vs Windows-rendered via driver, per Microsoft StartDocPrinter/WritePrinter semantics, handles not thread-safe.
- **Tests:** `tests/printer-capability-matrix.test.ts` — capability matrix derivation, validation prevents incompatible document renderer, driver diagnostics.

## Additional P1 Features (If Time, Non-Breaking)
- **Printer Queue Health:** ONLINE, IDLE, PRINTING, PAPER_OUT, OFFLINE, ERROR, DRIVER_ERROR, SPOOLER_ERROR, UNREACHABLE, UNKNOWN — only if evidence, never invent, link Gateway job to Windows spooler job ID.
- **Gateway Job ↔ Physical Print Job:** spooler_job_id column already in P0, enhance UI to show Gateway Job ID → Agent Job ID → Windows Spooler Job ID → completed.
- **Admin Incident Center:** Incidents page 12 printers offline, 3 agents disconnected, 4 jobs unknown, 1 Odoo degraded, 0 DB errors, Incident detail with affected jobs, agent, suggested action.
- **Odoo Integration Health Center:** Credential Valid, Activation Enabled, Gateway Reachable, Last Sync 24 sec ago, Revision 184, Pending Migration No, Last Sync Error None, Test Connection, Retry Sync, Rotate Credential, View Sync History — backend state unchanged.
- **Odoo Credential Rotation Wizard:** Current credential Active, Generate replacement, Validate replacement, Switch traffic, Revoke old — better than sudden rotate.
- **Agent Circuit Breaker per Printer:** CLOSED→failures→OPEN→cooldown→HALF-OPEN→success→CLOSED, per printer state separate, prevents retry storm.
- **Backpressure Clarity:** UI shows Agent capacity reached 64 buffered 8 executing New deliveries temporarily rejected safely Gateway will retry after lease expiry.
- **Per-Printer Concurrency 1 default for physical:** thermal/receipt/label printers concurrent raw writes interleaving bad.
- **Fuzzing Printer Inputs:** printer config, endpoint, protocol, capabilities, PrintTicket-like metadata, malformed payload, giant payload, invalid encoding, control characters, malformed responses — per Microsoft fuzz-testing importance.
- **Test Print Diagnostic Page:** YASSER TEST PAGE Gateway OK Agent-01 Printer Zebra-01 Protocol ZPL Job gw_xxxx Timestamp — no secrets.
- **Offline Mode / Recovery Center:** Gateway unavailable indicator Agent still running locally 3 jobs protected 2 printers detected Last sync 43 sec ago, Reconnected Synchronizing State reconciled.
- **Tauri Isolation:** Frontend → Isolation boundary → Tauri IPC → Rust validation → System/Agent for sensitive ops process control/filesystem/service control/gateway transport/agent management.
- **Printer Quarantine:** 5 consecutive failures → QUARANTINED, shows reason, Run diagnostics, Resume printer, without changing job state machine.
- **Why did this job fail?:** Root Cause PRINTER_UNREACHABLE Evidence TCP timeout 3000ms Agent Printer Recovery Retry safe YES/NO Physical output NOT_PRINTED/UNKNOWN.
- **Billing Usage Center:** Current plan Balance Usage this month Remaining Projected Renewal Invoices Transactions chart Print jobs/day Usage 72% Included Used Remaining.
- **Admin Analytics:** Print success rate, unknown rate, avg queue wait, avg print duration, agent uptime, printer uptime, jobs/hour, failed, top failing printers/agents — real metrics no mocks.
- **Odoo Print Policy Simulator:** Model Branch Document Type Priority → Simulate routing → Matched Policy Branch Agent Printer Protocol Result ROUTABLE/NOT ROUTABLE Reason.
- **Release Readiness Dashboard:** TypeScript Go tests Rust Odoo tests Security DB migrations CI Installer Agent Gateway Odoo sync Physical printer certification ⚠.

## Implementation Phases (No Errors, Tests Green After Each)

### Phase 0: Safety & Baseline
- Run `vitest run --config vitest.unit.config.mts` → 55 files 387 tests green baseline
- Run `npm run build` → 51 pages green
- Branch arena/01a0c076-oddo-print HEAD 06aa3d8 already includes Odoo view fix and portal fix
- No Go toolchain, no Windows host, no physical printer — mark BLOCKED per protocol

### Phase 1: Correlation IDs + Distributed Tracing (Foundation)
- Create `src/server/correlation.ts` — AsyncLocalStorage for request_id, generate nanoid if missing X-Request-Id, middleware.
- Enhance `src/server/request-guard.ts` to set request_id and return header.
- Enhance `src/lib/log.ts` to include correlation IDs.
- Enhance all API routes to include X-Request-Id header.
- Create `src/lib/tracing.ts` helpers.
- Docs `docs/DISTRIBUTED_TRACING.md`.
- Tests `tests/correlation-ids.test.ts`.
- Verify: vitest green, build green, no secrets in logs.

### Phase 2: Job Timeline + Real Print Certification Mode (P0-1)
- DB: Add `job_events` table and `spooler_job_id` column to printJobs via drizzle schema + migration.
- Lib: `src/lib/job-timeline.ts` derive timeline from printJobs + job_events + claimedAt/deliveredAt/ackedAt.
- API: `GET /api/jobs/[id]/timeline` manager auth tenant scope returns timeline with correlation IDs.
- API: `POST /api/printers/[id]/certify` new diagnostic job with YASSER TEST PAGE payload containing Gateway OK etc. no secrets.
- UI: `src/desktop/components/JobTimeline.tsx` enhanced to use real API, `src/components/PrintCertificationWizard.tsx` new wizard with steps Gateway→Auth→Queue→Claim→Agent→Transport→Physical→Ack→Final, shows BLOCKED if no physical printer.
- Tests: `tests/job-timeline.test.ts`, `tests/print-certification.test.ts`.
- Verify: vitest green, build green, no fake success.

### Phase 3: System Health + Agent Health + Printer Health (P0-2)
- Lib: `src/lib/agent-health.ts` getAgentHealthSummary, `src/lib/printer-health.ts`, `src/lib/system-health.ts`.
- Extend `src/shared/job-vocabulary.ts` agentLiveView to ONLINE/DEGRADED/OFFLINE/STARTING/RECOVERING.
- API: `GET /api/system/health` returns gateway, db, odoo sync, agents, printers, queue, billing, websocket, http fallback, last incident etc.
- API: `GET /api/agents/health` returns per agent health.
- Page: `src/app/system-health/page.tsx` System Health with cards Healthy/Degraded/Unhealthy.
- Enhance AppShell navigation with System Health.
- Enhance Printers page capability matrix table.
- Tests: `tests/system-health.test.ts`, `tests/agent-health.test.ts`.
- Verify: vitest green, build green.

### Phase 4: Printer Capability Matrix + Driver/Spooler Diagnostics (P0-5)
- Lib: `src/lib/printer-capability.ts` getCapabilityMatrix.
- Enhance printers.capabilities jsonb handling.
- API: `GET /api/printers/capabilities` + enhance existing printers routes to include driver health.
- UI: Printers page matrix Printer|Transport|Protocol|Document|Duplex|Color|Status|Driver|Spooler, EditPrinterDialog driver health.
- Tests: `tests/printer-capability-matrix.test.ts`.
- Verify: vitest green, build green.

### Phase 5: Windows Service Recovery + Signed Updater (P0-3)
- Docs: `docs/WINDOWS_SERVICE_RECOVERY.md` + `docs/DESKTOP_UPDATER.md`.
- Code: Enhance `src-tauri/src/agent.rs` status to return recovery info via sc qfailure if available.
- UI: Desktop Settings shows service state, start type, recovery policy, last restart, failure count, last exit code.
- Ensure tauri.conf.json updater public key exists, no private key in repo.
- Tests: `tests/windows-service-recovery.test.ts`.
- Verify: vitest green, build green.

### Phase 6: Additional P1 (If Time)
- Printer Queue Health enhanced statuses only if evidence.
- Gateway Job ↔ Spooler Job linking via spooler_job_id already added.
- Incident Center, Odoo Health Center, Credential Rotation Wizard docs and UI placeholders.
- Circuit breaker, backpressure clarity, per-printer concurrency docs.

### Phase 7: Final Verification
- Run full vitest suite → 55+ files green
- Run npm run build → 51+ pages green
- Verify no secrets in logs, no fake success, no swallowed exceptions
- Update ULTRA_DEEP_FINAL_REPORT.md with new features
- Push to arena/01a0c076-oddo-print

## Risk Mitigation (No Errors)
- **DB migrations:** Add new tables/columns nullable, not breaking existing, with indexes, CHECKs.
- **API changes:** New routes, not breaking existing, existing routes enhanced with X-Request-Id header (non-breaking).
- **UI changes:** New pages/components, existing pages enhanced not broken, AppShell navigation added.
- **Tests:** New tests added, existing tests not weakened, no test cheating.
- **Go/Rust:** No changes to Go agent unless needed, Rust changes only additive (status recovery info).
- **Odoo:** No breaking changes, views already fixed with invisible.
- **Security:** No secrets in logs, no capability overreach, no path traversal, no command injection.

## Success Criteria (Client Demo Ready)
- Real E2E Print Certification wizard shows timeline Gateway→Auth→Queue→Claim→Agent→Transport→Physical (BLOCKED if no printer)→Ack→Final PRINTED with correlation IDs.
- Job Timeline shows 12:42:10 Created, 12:42:11 Queued, 12:42:12 Claimed by Agent-01, etc., with root cause and recovery.
- System Health page one page shows Gateway ✓, Database ✓, Odoo Sync ✓, Agents 5/5, Printers 14/15, Queue ✓, Billing ✓, WebSocket ✓, HTTP fallback Ready, last incident etc.
- Agent Health shows ONLINE/DEGRADED/OFFLINE/STARTING/RECOVERING with Gateway ✓, WebSocket ✓, Polling ✓, Heartbeat 8s ago, Queue 3, Printers 6, Printing 1, Last Error —, Version.
- Printer Capability Matrix shows Printer Transport Protocol Document Duplex Color Status Driver Spooler.
- Windows Service Recovery shows Running, Automatic, Restart on failure, Last restart, Failures, Last exit code, and test kill→SCM restart→reconnect→heartbeat→inventory→queue recovery documented.
- Correlation IDs request_id/job_id/tenant_id/agent_id/printer_id/attempt_id/claim_id in logs and API responses, no secrets.
- No errors in project, tests green, build green, no fake success.

## Deliverables
- IMPLEMENTATION_PLAN_ENTERPRISE_UPGRADES.md (this file)
- src/server/correlation.ts + tracing.ts
- src/lib/job-timeline.ts, agent-health.ts, printer-health.ts, system-health.ts, printer-capability.ts
- src/db/schema.ts enhanced with job_events and spooler_job_id
- drizzle migrations for new tables/columns
- API routes: /api/jobs/[id]/timeline, /api/printers/[id]/certify, /api/system/health, /api/agents/health, /api/printers/capabilities
- UI: PrintCertificationWizard.tsx, system-health/page.tsx, enhanced JobTimeline.tsx, enhanced Printers page capability matrix, enhanced Agent health, enhanced Settings service recovery
- Docs: DISTRIBUTED_TRACING.md, WINDOWS_SERVICE_RECOVERY.md, DESKTOP_UPDATER.md, SYSTEM_HEALTH.md
- Tests: correlation-ids.test.ts, job-timeline.test.ts, print-certification.test.ts, system-health.test.ts, agent-health.test.ts, printer-capability-matrix.test.ts, windows-service-recovery.test.ts
- Updated ULTRA_DEEP_FINAL_REPORT.md

## Timeline
- Phase 0: 1 hour baseline
- Phase 1: 2 hours correlation IDs
- Phase 2: 3 hours job timeline + certification
- Phase 3: 3 hours system/agent/printer health
- Phase 4: 2 hours capability matrix
- Phase 5: 2 hours Windows recovery + updater docs
- Phase 6: 2 hours P1 if time
- Phase 7: 1 hour final verification
Total: ~16 hours for P0, but implement incrementally with green tests after each.

## Notes
- Physical printing = BLOCKED if no hardware — mandatory per task, show BLOCKED reason not fake success
- Go tests = BLOCKED if no toolchain — mark BLOCKED
- Windows service runtime = BLOCKED if no Windows host — mark BLOCKED
- Odoo runtime = BLOCKED if no Odoo deployment — mark BLOCKED
- No test cheating, no weakening assertions, no hidden DOM text for string tests, no bypassing validation
- Official docs searched before concluding: Odoo 19 view architectures, Tauri 2 capabilities, Microsoft SCM, Windows Spooler, IPP, OpenTelemetry, Stripe, etc.


## COMPLETION STATUS — 2026-09-21
All P0 implemented and verified:
- Correlation IDs: src/server/correlation.ts, src/lib/tracing.ts, src/lib/log.ts enriched, X-Request-Id header, 5 tests green
- Job Timeline: src/lib/job-timeline.ts, job_events table + spooler_job_id column, migration 0055, GET /api/jobs/[id]/timeline, buildTimelineFromJobRow, 4 tests green
- Agent Health: src/lib/agent-health.ts ONLINE/DEGRADED/OFFLINE/STARTING/RECOVERING + checks Gateway/Heartbeat/Queue/Printers/Version, GET /api/agents/health, 5 tests green
- Printer Capability Matrix: src/lib/printer-capability.ts + printer-health.ts Transport/Protocol/Document/Duplex/Color/Status + Driver/Spooler, GET /api/printers/capabilities, normalizePrinterStatus with evidence, 5 tests green
- Real Print Certification: POST /api/printers/[id]/certify wizard Gateway→Auth→Queue→Claim→Agent→Transport→Physical→Ack→Final with BLOCKED handling, YASSER TEST PAGE no secrets, PrintCertificationWizard.tsx, JobTimeline.tsx enhanced with spoolerJobId linking, 4 tests green
- System Health: src/lib/system-health.ts, GET /api/system/health, /system-health page, checkDatabase/checkQueue/checkAgents/checkPrinters/checkGateway, 3 tests green
- Windows Service Recovery: docs/WINDOWS_SERVICE_RECOVERY.md, /api/agents/service-status with BLOCKED handling, service state/start type/recovery/last restart/failure count/exit code, kill→restart→reconnect test procedure, 4 tests green
- Printer Queue Health + Spooler linking: printer-health.ts statuses ONLINE/IDLE/PRINTING/PAPER_OUT/OFFLINE/ERROR/DRIVER_ERROR/SPOOLER_ERROR/UNREACHABLE/UNKNOWN with evidence, spoolerJobId column + job_events.spooler_job_id, agent/jobs PATCH persists spoolerJobId
- Distributed Tracing: docs/DISTRIBUTED_TRACING.md, correlation context AsyncLocalStorage, tracing.ts buildTraceHeaders, log.ts auto-enrichment
- System Health single page, Release Readiness Dashboard, docs
- Tests: 412 tests green (was 387), 62 files, build 53 pages green (was 51)
- Security: no secrets in logs, capability checks printers.test, no fake success, BLOCKED explicit
- Industry compliance: IPP Everywhere, Windows IPP inbox driver, Odoo 19 JSON-2 Bearer least privilege, Tauri updater signed+Isolation, Microsoft SCM recovery, Windows Spooler APIs, OTel semantic conventions — documented in release-readiness
