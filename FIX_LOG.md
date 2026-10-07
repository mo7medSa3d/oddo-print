RESUME HERE: PHASE 1 — COMPLETE REPOSITORY AUDIT | Agent/Windows, Gateway/job lifecycle, DB, Odoo audited; DEP-001 and Desktop capability drift (DESK-001/002/003) fixed | finish billing/entitlements and web UI/i18n audit | audit observability/deployment/CI/docs/performance, then adversarial pass | GitHub Contents API writes fail; using Git tree commits; local clone unavailable because container DNS cannot resolve github.com

# FIX LOG

Audit branch: `audit/production-hardening-2026-10-07`
Base: `main@136e0d057c0fc987de459f432491cc4e787008fd`
Started: 2026-10-07
Policy: evidence-driven production audit; no verification claim without an executed check.

## Phase 1 — Audit checklist

- [x] Repository/build/dependency topology
- [x] Shared contracts / serialization / enums / canonical identities
- [x] Agent core lifecycle / config / auth / reconnect / cancellation
- [x] Windows discovery / network discovery / Windows print execution
- [x] Agent → Gateway inventory synchronization / ordering / stale deletion / idempotency
- [x] Gateway API / validation / authorization / tenant isolation
- [x] WebSocket / dispatch / queues / retries / fencing / reconciliation
- [x] Database schema / migrations / constraints / indexes / transactions
- [x] Print job lifecycle / idempotency / payload limits / cleanup
- [x] Odoo 19 integration / bindings / Test Print / POS / reports / security
- [ ] Gateway web UI / dashboard / job/printer state / i18n / RTL
- [x] Desktop/Tauri IPC / config / privileged operations / updater — command registry/capability parity, origin fencing, credential isolation, bounded subprocess/HTTP paths and privileged relaunch reviewed; three missing command grants repaired.
- [ ] Billing / entitlements / limits / auditability
- [ ] Observability / logging / secrets / operational failure recovery
- [ ] Deployment / Docker / reverse proxy / CI / release workflows / DR
- [ ] Documentation / backward compatibility
- [ ] Performance / scalability / N+1 / unbounded work / cache correctness
- [ ] Security sweep / injection / unsafe defaults / cross-tenant access

## Desktop capability repair

Tauri 2 command authorization requires a capability grant for frontend invocation. Comparing `tauri::generate_handler!` with `src-tauri/capabilities/default.json` found three registered and actively invoked commands omitted from the main-window capability.

- DESK-001 / P1: `relaunch_as_admin` omitted, breaking Administrator relaunch/service recovery.
- DESK-003 / P1: `probe_gateway_health` omitted, breaking the pre-save Gateway URL probe used by Settings.
- DESK-002 / P3: `set_tray_locale` omitted, breaking native tray EN/AR synchronization.
- Repair grants only these commands; no shell/filesystem/general network capability was added.

## Prior repair

- DEP-001 / P1: Next.js 16.3.6 → 16.3.8 with matching Dependabot lockfile.

## Verification baseline

Main: CI PASS; Docker PASS; Security and Resilience Gates PASS; Windows Installer PASS; Secret Scan PASS. Static Security Gates requires a fresh CodeQL run because the main run failed on GitHub incremental-analysis cache infrastructure after SARIF generation.

## Phase 2 — Repair

DEP-001, DESK-001, DESK-002 and DESK-003 fixed. Further repair queue depends on remaining audit.

## Phase 3 — Verification

Local full-tree execution unavailable because the environment cannot clone GitHub (DNS resolution failure). GitHub Actions and repository-native checks will be used through the PR; anything not actually executed remains UNVERIFIED.

## Phase 4 — Adversarial second pass

Pending.

## Phase 5 — Final production review

Pending.
