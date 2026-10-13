# AUDIT_FINDINGS.md

Table: ID | Severity | Component | file:line | Problem | Status

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| GW-F1 | Medium | Gateway | src/lib/auth-rate-limit.ts:377 | `recordAuthSuccess` deleted only the account bucket; shared-NAT IP buckets accumulated toward lockout | FIXED |
| GW-F2 | Low | Gateway | src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts:191 | spooler/stable-id dedupe used key-order-sensitive `JSON.stringify` compare; identical configs duplicated printers | FIXED |
| GW-F3 | Low | Gateway | src/app/api/agent/heartbeat/route.ts:408-509 | per-printer sequential UPDATE/INSERT in one long txn holding per-tenant advisory lock; pages capped at 500 and statements are tiny indexed writes under per-statement 30s timeout, so bounded — bulk upsert deferred via `shortcut:` note | FIXED (documented) |
| GW-F4 | Low | Gateway | src/app/api/printers/[id]/test-print/route.ts:119-123 | idempotent reuse returns 201 while POST /api/print/jobs returns 200 for reuse; inconsistent reuse semantics | FIXED |
| GW-F5 | Low | Gateway | src/lib/session-tokens.ts:527-532 | `getAccessTokenFromRequest` prefers cookie over Bearer; stale cookie shadows valid Bearer on dual-credential calls | FIXED |
| GW-F6 | Low | Gateway | src/lib/payload.ts:23-36,33-75 | base64 payload decoded twice (refine + superRefine) on up to 5MiB per admission | FIXED |
| GW-F7 | Info | Gateway | src/app/api/billing/webhook/route.ts:46-48 | route `hasBodyOverLimit` sees only Content-Length; chunked bodies rely on custom-server 411 guard | OPEN (defense-in-depth holds) |
| GW-F8 | Info | Gateway | src/app/api/jobs/route.ts:39-41 | agent printerId/agentId query filters untrimmed/unbounded; safe (eq, tenant+agent fenced) | OPEN (no leak) |
| GW-F9 | Info | Gateway | src/app/api/odoo/keys/route.ts:22-33 | GET uncapped; deliberate (low-cardinality credential list) | OPEN (by design) |
| GO-F1 | Low | Go agent | internal/agent/heartbeat_pagination.go:117 | `gatewayOwnedIDsForPrinterPage` returned nil → JSON null for gatewayOwnedPrinterIds fence; Gateway expects array | FIXED |
| GO-F2 | Low | Go agent | internal/agent/discovery_manager.go:35-43 | `pollDiscovery` silently dropped transport errors and non-200s | FIXED |
| GO-F3 | Low | Go agent | internal/agent/agent.go:1454 | WS discovery branch silently released scan slot on session-lookup miss | FIXED |
| GO-F4 | Info | Go agent | internal/printer/ipp.go:342, network.go:223 | Status() probes use Background/timeout dial, not heartbeat ctx; bounded (5s/2s) inside 10s budget with last-known fallback | OPEN (by design) |
| GO-F5 | Info | Go agent | internal/agent/agent.go:2391 | `printerStatusPayload` never probeWG.Wait()s; deliberate, results chan buffered so late sends never block | OPEN (by design) |
| GO-F6 | Info | Go agent | internal/payload/payload.go:127 | base64 StdEncoding (ignores \r\n) vs Strict in e2e_capture; tightening would reject accepted payloads | OPEN (keep permissive) |
| TA-F1 | High | Infra | Caddyfile:16 | `{file./run/...}` relative path resolves against Caddy cwd, not secret mount | FIXED |
| TA-F2 | Medium | Tauri | src-tauri/build.rs:12-15, capabilities/default.json:20-23 | dead `allow-*` IPC permissions for 3 commands with no handler/caller | FIXED |
| TA-F3 | Medium | CI | .github/workflows/docker.yml:273 | CI never proved Caddy injects valid proxy token | FIXED |
| TA-F4 | Low | CI | Caddyfile/docker.yml | Agent WS through Caddy has no E2E proof (needs agent credential in CI) | OPEN |
| TA-F5 | Info | Tauri | src-tauri | no updater plugin, no code-signing config | OPEN (release-process) |
| UI-F1 | Medium | UI | src/app/team/page.tsx:653 | hardcoded `placeholder="colleague@company.com"` bypassed catalog | FIXED |
| UI-F2 | Low | UI | src/components/UpgradeLimitDialog.tsx:104 | `tc()` display var passed raw number, breaking formatNumber grouping convention | FIXED |
| UI-F3 | Medium | UI | src/components/AppShell.tsx:111 | collapsed-rail links icon-only with `title` but no accessible name | FIXED |
| UI-F4 | Low | UI | src/components/marketing/LandingMotion.tsx:24 | GSAP flow-item enter offset hard-coded LTR, wrong edge in RTL | FIXED |
| UI-F5 | Trivial | UI | src/app/platform/tenants/page.tsx:188 | dismiss Button carried empty `{""}` child | FIXED |
| UI-F6 | Low | UI | src/desktop/pages/Jobs.tsx:123 | mobile job-list `aria-label` reuses `tab.all` regardless of filter | FIXED (uses localized `JOB_TAB_LABELS[s.jobTab]`, no new key) |
| UI-F7 | Low | UI | src/app/verify-email/page.tsx:48 | `useState` initial message freezes first-locale copy on mid-verify language switch | OPEN (router.refresh path covers; effect resync deferred) |
| UI-F8 | Info | UI | src/app/system-health/system-health-client.tsx:97 | local `relativeTime` duplicates shared `formatRelativeTime` | OPEN (unification = refactor) |
| OD-F1 | Medium | Odoo | static/src/js/gateway_limit_dialog.js:145,157,160,165 | `_t("...%s...", v)` rendered literal `%s` (billing facts, retry hint) | FIXED |
| OD-F2 | Medium | Odoo | static/src/js/report_interceptor.js:216 | same `_t` interpolation bug in unconfirmed-outcome toast | FIXED |
| OD-F3 | Medium | Odoo | static/src/js/pos_sale_details_router.js:200 | same bug in Sale Details unconfirmed toast | FIXED |
| OD-F4 | Medium | Odoo | static/src/js/pos_print_router.js:808 | same bug, two placeholders, kitchen-failure message | FIXED |
| OD-F5 | Low | Odoo | views/print_policy_views.xml:65 | picker domain excluded company-wide fallback bindings though backend `_check_hierarchy`/`_onchange_scope` support them | FIXED |
| OD-F6 | Low | Odoo | models/print_intent.py:23 | `company_id` nullable + default; explicit-False rows invisible under record rule yet processed by sudo cron | OPEN (`# shortcut:` added; needs backfill) |
| OD-F7 | Info | Odoo | controllers/runtime_printers.py:45 | mismatched branch-pair raises — confirmed correct fail-closed | OPEN (by design; why-comment added) |
| OD-F8 | Info | Odoo | static/src/js/pos_print_router.js:440 | offline/unreachable Gateway returns no receipt, no native fallback — fail-closed kept | OPEN (by design; `# shortcut:` added) |

## Files fully reviewed
- contracts/print-payload-contract.json
- src/db/index.ts, client.ts, schema.ts
- src/server/ws.ts, request-guard.ts, api-defaults.ts, cors.ts, correlation.ts, trusted-proxy.ts
- src/lib: payload, print-job-service, stripe, entitlements, tenant-guard, agent-auth, odoo-auth, idempotency, job-delivery, job-fencing, routing, printer-capability, printer-model, printer-virtual, request-limits, runtime-secret, log, audit, billing-operation, manager-auth, authorization, console-auth, database-clock, bounded-query, session-tokens, auth-rate-limit, ws-rate-limit, agent-availability, network-address, canonicalize, job-status, job-timeline
- src/shared/job-vocabulary.ts, job-retention.ts
- routes: print/jobs, print/jobs/batch-status, agent/jobs, agent/heartbeat, agent/register, agent/discovery, agent/desired-state, agent/probe, billing/* (webhook/checkout/cancel/resume/portal/status/usage), odoo/keys, odoo/configuration, odoo/printers, odoo/agents, printers/[id]/test-print, jobs, jobs/[id]/reprint, agents/[id]/discovered-printers/[deviceId]/provision
- Go agent (full): payload/payload.go, agent/agent.go, desired_state, discovery_manager, heartbeat_pagination, e2e_capture, poll_response, ws_reconnect, pairing, config/*, queue/*, printer/{printer,factory,dispatch_admission,document,outcome,capability,peripherals,health,network,network_discovery,discovery_targets,snmp_discovery,wsd_discovery,discovery_scan,registry,ipp,pdf,stable_id,usb_windows}, storage/secure*, cmd/agent/main.go, cmd/cli/gateway.go. Partial: printer/discovery.go (1-350/1193), printer/spooler_windows.go (1-200/1856)
- Tauri/Infra (full): tauri.conf.json, Cargo.toml, build.rs, rust-toolchain.toml, capabilities/default.json, main.rs, commands.rs, agent.rs, paths.rs, logging.rs, tray.rs, cleanup.rs, audit_discovery_test.rs, tests/audit_logging.rs, installer_hooks.nsh, Dockerfile, docker-compose.yml, docker-compose.ci.yml, Caddyfile, .nvmrc, .npmrc, proxy.ts, server.ts, vite.desktop.config.mts, .github/workflows/{ci,build-windows,docker,security-supply-chain,static-security}.yml, dependabot.yml, CODEOWNERS
- UI (full): app layout/page/error/loading/not-found, login/signup/forgot/reset-password/verify-email/invite/onboarding, dashboard/page, api-keys, billing, settings, team, system-health(+client), pricing, platform/* (layout/page/login/dashboard/tenants/plans/subscriptions/audit), release-readiness(+client); components AppShell/AuthShell/ui/CommandPalette/TopNavbar/MobileAppBar/JobTimeline/JobCleanupButton/BillingActions/PrintCertificationWizard/UpgradeLimitDialog/brand/visual-system/marketing×3/PlatformSidebar/overview-charts; i18n config/index/react/server/translate/format; desktop main/ui/Sidebar/AddPrinterDialog/AdminPrivilegeDialog/JobTimeline/pages Overview/Jobs/Printers/Agents/Settings. Partial: dashboard-client (1-1330), desktop main (head 1279). Skipped: actions.ts, globals.css tail, TestCenter/CaptureHistory/desktop lib, message catalogs full read
- Odoo (full): __manifest__/__init__/runtime_clock, models (gateway_config/print_job/print_intent/print_router/print_policy/binding/runtime_assignment/crypto/pos_order/pos_session/stock_picking/account_move/ir_actions_report/e2e_capture_wizard), controllers (pos/runtime_printers), security/*, data/cron.xml, all 7 views, 8 static JS, 3 static components (+xml), check-odoo-translations.py. Sampled: i18n/ar.po head

## Recommendations (not applied — need decision / new dependency)
- GW-F3 follow-up: bulk upsert for heartbeat inventory pages when fleets approach the 500/page cap.
- OD-F6: backfill `print_intent.company_id` (default non-null) so record rules and cron see the same rows.
- TA-F4: add CI credential for agent-WS-through-Caddy E2E proof.
- TA-F5: updater channel + code-signing (release process).
- UI-F8: unify `relativeTime` with shared `formatRelativeTime`.
- Deps worth evaluating (not installed): none pinned — registry audit left to release process.

## Phase 4 verification (2026-10-13, single run, no installs)
- PASS: `go build ./...` + `GOOS=windows go build ./...`; `go vet` on touched pkgs; `go test` payload (17) + targeted agent (43).
- PASS: vitest unit — 1025 passed; only failures are 10 pre-existing environmental (missing native argon2, missing radix/gsap modules, desktop smoke env) proven identical on stashed tree. 1 failure was caused by GW-F4 change → fixed at root cause (test pin updated to `result.isReused ? 200 : 201`), now 37/37.
- PASS: eslint on all touched TS files; `tsx check-i18n.ts`; `check-db-docs.py`; `check-odoo-translations.py`; pytest static Odoo (57); python py_compile + XML parse.
- FAIL-ENV: `tsc --noEmit` has 12 pre-existing errors (node_modules lacks @radix-ui/gsap; none in changed files).
- UNVERIFIED: integration suite (no PostgreSQL on machine); `cargo check` (registry not cached, offline); `next build` (blocked by missing modules); real Windows machine, physical printers, live Odoo 19, live Stripe.
