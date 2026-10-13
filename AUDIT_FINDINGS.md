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
| GW-F8 | Info | Gateway | src/app/api/jobs/route.ts:39-41 | agent printerId/agentId query filters untrimmed/unbounded; safe (eq, tenant+agent fenced) | FIXED (R3-GW2: trimmed + bounded <= 2048 chars) |
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
| UI-F7 | Low | UI | src/app/verify-email/page.tsx:48 | `useState` initial message freezes first-locale copy on mid-verify language switch | FIXED (R3-UI1: render-derived copy + locale-independent effect) |
| UI-F8 | Info | UI | src/app/system-health/system-health-client.tsx:97 | local `relativeTime` duplicates shared `formatRelativeTime` | OPEN (by design; pinned by tests/desktop-health-ui.contract.test.ts:21-29 for second-level granularity) |
| OD-F1 | Medium | Odoo | static/src/js/gateway_limit_dialog.js:145,157,160,165 | Earlier claim that native `_t` rendered literal placeholders was incorrect | SUPERSEDED by R2-OD1; native substitutions restored |
| OD-F2 | Medium | Odoo | static/src/js/report_interceptor.js:216 | Earlier manual replacement change bypassed native interpolation | SUPERSEDED by R2-OD1; native substitutions restored |
| OD-F3 | Medium | Odoo | static/src/js/pos_sale_details_router.js:200 | Earlier manual replacement change bypassed native interpolation | SUPERSEDED by R2-OD1; native substitutions restored |
| OD-F4 | Medium | Odoo | static/src/js/pos_print_router.js:808 | Earlier manual replacement change bypassed native interpolation | SUPERSEDED by R2-OD1; native substitutions restored |
| OD-F5 | Low | Odoo | views/print_policy_views.xml:65 | picker domain excluded company-wide fallback bindings though backend `_check_hierarchy`/`_onchange_scope` support them | FIXED |
| OD-F6 | Low | Odoo | models/print_intent.py:23 | `company_id` nullable + default; explicit-False rows invisible under record rule yet processed by sudo cron | FIXED by R2-OD2; required company + safe 19.0.2.14.0 migration |
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
- OD-F6 resolved by R2-OD2; stage the safe company-ownership upgrade and restore verified ownership if ambiguous legacy rows block it.
- TA-F4: add CI credential for agent-WS-through-Caddy E2E proof.
- TA-F5: updater channel + code-signing (release process).
- UI-F8: unify `relativeTime` with shared `formatRelativeTime`.
- Deps worth evaluating (not installed): none pinned — registry audit left to release process.

## Prior-pass Phase 4 verification (historical; continuation results below supersede environment limits)
- PASS: `go build ./...` + `GOOS=windows go build ./...`; `go vet` on touched pkgs; `go test` payload (17) + targeted agent (43).
- PASS: vitest unit — 1025 passed; only failures are 10 pre-existing environmental (missing native argon2, missing radix/gsap modules, desktop smoke env) proven identical on stashed tree. 1 failure was caused by GW-F4 change → fixed at root cause (test pin updated to `result.isReused ? 200 : 201`), now 37/37.
- PASS: eslint on all touched TS files; `tsx check-i18n.ts`; `check-db-docs.py`; `check-odoo-translations.py`; pytest static Odoo (57); python py_compile + XML parse.
- FAIL-ENV: `tsc --noEmit` has 12 pre-existing errors (node_modules lacks @radix-ui/gsap; none in changed files).
- UNVERIFIED: integration suite (no PostgreSQL on machine); `cargo check` (registry not cached, offline); `next build` (blocked by missing modules); real Windows machine, physical printers, live Odoo 19, live Stripe.

## R2 Go agent follow-up findings (Phase 2 static)

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|-----------|---------|--------|
| R2-GO-1 | High | Windows agent | agent/internal/printer/spooler_windows.go:185 | Redundant instance preflight gate was raised before shared reservation/context admission; a refusal started no worker to clear it, permanently disabling that printer backend | FIXED; Windows regression compiled; native Win32 execution UNVERIFIED |
| R2-GO-2 | High | Go discovery | agent/internal/printer/discovery.go:1028 | mergeDeviceInfo wrote into prior capability maps shared by progress snapshots; after orchestration timeout the snapshot could race JSON/registry readers and mutate already published evidence | FIXED; immutable merge regression and Go race suite PASS |

### R2 files fully reviewed (additions to prior list)
- agent/internal/printer/spooler_windows.go (all 1856 original lines), discovery.go (remaining 350-1193; prior 1-350 retained), discovery_extended.go, spooler_receipt_windows.go
- agent/internal/printer/discovery_progress_test.go, discovery_destination_test.go, preflight_ownership_windows_test.go, admission_windows_test.go

## Continuation findings (2026-10-13)
| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-GW1 | Medium | Gateway / Desktop | src/app/api/printers/route.ts:95 | Cursor chosen after virtual filtering made hidden pages untraversable and revisited trailing virtual records | FIXED; raw bounded-page cursor + CLI/Rust/UI consumer trace complete; fleet regressions PASS |
| R2-GW2 | Medium | Gateway auth | src/app/api/auth/forgot-password/route.ts:29 | Lookup/token-persistence failures escaped generic reset response, permitting account enumeration during partial DB failures | FIXED; generic 202 + operational logging, never sends unpersisted token |
| R2-GW3 | Low | Gateway team | src/app/api/team/invitations/route.ts:85 | Arbitrary nonempty strings could create unusable invitations and reach email provider | FIXED; reuse validEmail at admission |

### Continuation files fully reviewed — Gateway (static)
- src/app/actions.ts (459 lines; prior omission completed); src/lib/password.ts, customer-auth.ts, team-authorization.ts, manager-mutation-authorization.ts, roles.ts, email.ts, circuit-breaker.ts, fetch-timeout.ts, cache.ts, inventory-snapshot.ts, printer-identity.ts, discovery.ts, discovery-observation.ts, desired-state-page.ts, fleet-cursor.ts, database-timestamp.ts, limit-signal.ts.
- src/app/api/auth/{login,register,forgot-password,reset-password,verify-email,resend-verification,select-tenant}/route.ts; src/app/api/team/{members,invitations,ownership}/route.ts; src/app/api/team/invitations/accept/route.ts; src/app/api/printers/route.ts, src/app/api/printers/[id]/route.ts.
- tests/fleet-cursor-route.test.ts, team-invitation-authority.test.ts, auth-rate-limit-fail-closed.test.ts, app-base-url.test.ts. Regression tests written; no verification executed before Phase 4.
| R2-GO-3 | Medium | Gateway/Go/Tauri integration | agent/cmd/cli/gateway.go:177 | Paired desktop CLI envelope discarded fleet pagination headers and rejected cursor query paths, hiding inventory after the first bounded page | FIXED CLI producer/allowlist; coordinated Rust/UI consumers; shared contract and Go/TypeScript regressions PASS; Rust compilation blocked by uncached dependency |

### R2 files fully reviewed (continued)
- agent/cmd/cli/gateway.go, gateway_test.go (revisited only for newly demonstrated cross-component pagination break), agent/internal/printer/classify.go, classify_device.go; docs/DISTRIBUTED_TRACING.md; contracts/gateway-console-contract.json
- R2-GO-3 real CLI integration fixture now exercises cursor GET paths, preserves actual status/body/pagination envelope, and rejects Set-Cookie forwarding; written only until Phase 4. Fully reviewed: agent/cmd/cli/cli_integration_test.go.

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-GW4 | Medium | Gateway captures | src/app/api/test-captures/route.ts:141,197 | Host Date.now disagreed with PostgreSQL expiry: UI misreported capture state and single-run cleanup incorrectly rejected expired runs under clock skew | FIXED; count query supplies authoritative clock; locked row supplies active SQL predicate |

### Continuation files fully reviewed — Gateway continued
- src/lib/platform-auth.ts, agent-control.ts, agent-lifecycle.ts, agent-presence-maintenance.ts, tenant-lifecycle.ts, job-maintenance.ts, dashboard-state.ts, metrics.ts, system-health.ts, worker-schema.ts.
- src/app/api/platform/{plans,tenants,subscriptions,stats,audit}/route.ts; src/app/api/{settings,onboarding,test-captures}/route.ts; src/app/api/test-captures/preview/route.ts; scripts/db-migrate.ts, scripts/db-generate.ts.
- tests/gateway-capture-console-postgres.test.ts; new gateway-capture-console-clock.test.ts and forgot-password-persistence.test.ts reviewed but not run before Phase 4.

## R2 Odoo review findings

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-OD1 | Medium | Odoo/i18n | odoo_addons/print_gateway/static/src/js/report_interceptor.js:216; pos_sale_details_router.js:200; pos_print_router.js:809; gateway_limit_dialog.js:145 | Prior research falsely claimed Odoo 19 `_t` cannot interpolate; seven manual replacements corrupt error strings containing replacement sequences and bypass native formatting | FIXED: native `_t` substitutions restored with unchanged msgids; cache corrects OWL version to 2.8.4; executable placeholder/error regressions PASS |
| R2-OD2 | Medium | Odoo/company ownership | odoo_addons/print_gateway/models/print_intent.py:23; migrations/19.0.2.14.0/pre-migrate.py:4 | Nullable company lets explicit-False intents disappear under company record rules while recovery processes them; previous OD-F6 remained open | FIXED: company required; safe ownership pre-migration; addon 19.0.2.14.0 and both architecture/integration docs updated; offline migration regressions PASS; native Odoo ORM upgrade UNVERIFIED |
| R2-OD3 | Low | Odoo/upgrade credentials | odoo_addons/print_gateway/migrations/19.0.2.4.0/post-migrate.py:37 | Migration updates credential using raw SQL after reading it into shared ORM cache, leaving pre-encryption value cached for subsequent upgrade work | FIXED: invalidate the exact credential field after its SQL write; executable migration/cache regression PASS |

### R2 files fully reviewed (additive; prior fully reviewed runtime scope preserved)
- odoo_addons/print_gateway/migrations/*/{__init__,pre-migrate,post-migrate}.py (all existing nonempty migration source and new 19.0.2.14.0/pre-migrate.py).
- odoo_addons/print_gateway/tests/test_migration_upgrade.py, test_intent_recovery.py, test_gateway_url_transport.py.
- odoo_addons/print_gateway/static/src/js/async_control.js, operation_recovery.js, receipt_raster.js, tours/binding_cascade_tour.js.
- odoo_addons/print_gateway/static/src/css/receipt_raster.css; static/src/scss/print_gateway_tokens.scss, print_gateway_backend.scss.
- tests/audit-pos-offline.test.mjs, current-run-sale-details.node.test.mjs, test_audit_repair_regressions.py, test_odoo_policy_intent_safety_current_run.py, test_odoo_config_key_rotation_f015.py; new test_odoo_intent_company_upgrade.py and test_odoo_migration_cache.py.
- Reopened only proven-wrong translation sections in gateway_limit_dialog.js, report_interceptor.js, pos_sale_details_router.js, pos_print_router.js, and nullable company definition in print_intent.py. Remaining old runtime review conclusions preserved.

### R2 Odoo recommendations and verification boundaries
- Required: stage backed-up Odoo 19 addon upgrade/rollback to 19.0.2.14.0 before worker activation; rows without provable company intentionally block upgrade and need verified ownership restoration.
- UNVERIFIED until live acceptance: native Odoo ORM/module-upgrade PostgreSQL ordering and rollback, OWL asset load in real browser, Arabic thermal geometry/font output, physical POS receipt/kitchen printing.
- No package installs, dependency changes, speculative replacements, or pre-Phase-4 test/build/lint runs performed.

### R2 remaining Go findings

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|-----------|---------|--------|
| R2-GO-4 | High | Windows service | agent/cmd/agent/service_install_windows.go:332 | Legacy service removal ignored Query errors, so unreadable/running services could be deleted and their durable data purged without proving dispatch stopped | FIXED fail-closed; Windows contract regression coordinated, real SCM UNVERIFIED |
| R2-GO-5 | Medium | Go CLI | agent/cmd/cli/capture.go:96 | Automatic local capture pruning matched any capture-*.pdf/png name inside an operator-selected output directory, deleting unrelated old documents | FIXED; reuse strict generated-artifact filename allowlist; regression written |

### R2 files fully reviewed (continued)
- agent/internal/printer/pdf_windows.go, pdfium_pool.go, pdf_devmode_windows.go, pdf_geometry.go, spooler_evidence.go, ipp_render_windows.go, ipp_pwg_windows.go, ipp_discovery.go, ipp_acceptance.go, raster_capability.go, ipp_formats.go, ipp_jpeg_geometry.go, ipp_jfif.go, spooler_stub.go
- agent/cmd/agent/service_install_windows.go, service_install_other.go, runtime_singleton_windows.go, runtime_singleton_other.go
- agent/cmd/cli/main.go, helpers.go, cleanup.go, capture_config.go, capture_cleanup.go, capture.go, capture_test.go

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-GW5 | Low | Gateway health | src/lib/agent-health.ts:65 | Future createdAt classified an unseen agent as STARTING indefinitely under bad timestamps/clock skew | FIXED; startup age now must be non-negative |

### Continuation files fully reviewed — Gateway final groups
- src/lib/agent-health.ts, printer-health.ts, discovery-session-expiry.ts, platform-stats-cache.ts, server-action-version.ts, clipboard.ts, job-diagnostic-payload.ts, receipt-width.ts, job-timeline-presentation.ts, api-error-keys.ts, action-error.ts, billing-labels.ts, lifecycle-labels.ts, nav.ts, utils.ts; src/server/content-security-policy.ts.
- src/app/api/jobs/[id]/{route.ts,timeline/route.ts}; src/app/api/agents/{service-status,health}/route.ts; src/app/api/agents/[id]/route.ts; src/app/api/agents/[id]/discovery/{route.ts,[discoveryId]/route.ts,[discoveryId]/cancel/route.ts}; src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts; src/app/api/printers/[id]/test-connection/route.ts; src/app/api/{health,live,metrics}/route.ts; src/app/api/system/health/route.ts.

## R2 Gateway authentication follow-through (Odoo review owner)

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-GW-OD1 | Medium | Gateway/platform auth | src/app/api/platform/auth/login/route.ts:46 | Identity/session-store failures escaped the route and success-bucket clear failure incorrectly rejected valid login; failures lacked stage-specific logging | FIXED: temporary operational refusal for lookup/session failures, warn-and-continue only after valid identity for bucket clearing, credential-change rejection preserved; behavioral regression PASS |
| R2-GW-OD2 | Medium | Gateway/manager auth | src/app/api/auth/manager/login/route.ts:56 | Hostname/configured-tenant lookup can fail against DB and reject the handler before structured unavailable response/logging | FIXED: logged temporary refusal retains rate-limit headers and never reaches credential/session issuance; behavioral regression PASS |

### R2 Gateway files fully reviewed (additive)
- src/app/api/auth/{logout,refresh,me}/route.ts; src/app/api/auth/manager/{login,logout,refresh,me}/route.ts; src/app/api/platform/auth/{login,logout,refresh,me}/route.ts.
- src/app/api/platform/plans/[id]/route.ts; src/app/api/platform/tenants/[id]/{suspend,reactivate}/route.ts; src/app/api/admin/tenants/[id]/lifecycle/route.ts.
- tests/auth-rate-limit-fail-closed.test.ts, logout-fail-safe.test.ts, session-refresh-recovery.test.ts; new tests/auth-login-operational.test.ts; vitest.unit.config.mts.
- Integration evidence: authenticated probes, refresh rotation and logout retain their existing consumer shapes; platform mutation routes require platform-owner identity; lifecycle transitions delegate to shared transactional/fenced helper; plan mutation preserves live Stripe validation before row lock and checks billing identity again under lock. No schema/wire change beyond the Odoo-local intent ownership constraint.

| R2-GO-6 | Medium | Agent/Gateway capture integration | src/app/api/agent/test-captures/status/route.ts:37 | Host Date.now() classified DB-written expiresAt, making queued/claimed simulation status disagree under clock skew | FIXED SQL expiry decision; behavioral ahead/behind clock regression written |

### R2 capture integration review
- Fully reviewed: src/lib/e2e-capture.ts; src/app/api/agent/test-captures/{route,status/route,preview/route}.ts; src/app/api/odoo/test-captures/route.ts (concurrent root review shared); agent/internal/printer/test_capture{,_windows,_other}.go; agent/cmd/cli/diagnose.go; agent/internal/printer/pwg_raster.go, pwg_options.go, ipp_jfif_test.go
- Odoo capture admission requires active tenant/key/agent, same-key idempotency fingerprint and billing access; Agent claims have independent 75s/3-attempt token fences and clear private payloads on terminal reports; preview remains paired-agent/tenant bounded JPEG evidence. readOdooCapture expiry already uses PostgreSQL now(), so no helper change required. No print quota debit, spooler dispatch or physical success inferred.

### R2 agent static completion and verification boundary
- Fully reviewed remaining platform helpers: agent/internal/storage/{security_windows,security_other,replace_file_windows,replace_file_posix}.go; agent/internal/printer/{usb_other,pdf_other,pdfium_pool_other,ipp_render_other,ipp_pwg_other,physical_only,discovery_windows,discovery_other}.go.
- All production Agent files are now covered by the prior fully-reviewed list plus R2 additions; remaining test fixtures/benchmarks are validated by Phase 4 rather than blanket rereading. Prior partial spooler/discovery risks are superseded by full static review.
- UNVERIFIED before Phase 4: all execution checks intentionally deferred. Live Windows SCM/driver/spooler/USB/GDI/Session-0 queues, multicast discovery against real LAN/printers and physical paper outcomes require unavailable target hardware. Static ownership, completion/error classification, bounded discovery, endpoint policy and Gateway capture/fleet wire alignment are reviewed.

### R2 Phase 4 — Python and Odoo static verification (2026-10-13)
- PASS: `python3 -m pytest -q tests/` — **486 passed**, including executable intent-company upgrade and encryption-cache regressions; no failing/skipped test reported. Existing pytest-asyncio warning about unset future loop-scope default is informational; no configuration/dependency changes added.
- PASS: `py_compile.compile(..., doraise=True)` on all **50** addon Python files; ElementTree parsing all **11** addon XML files.
- PASS: `python3 scripts/check-odoo-translations.py` — **785** extracted terms and **785** catalog entries, complete/consistent after native interpolation restoration.
- UNVERIFIED: Odoo TransactionCase suite, live PostgreSQL addon upgrade/rollback and browser/hardware behavior; this host has no running Odoo 19 test database/runtime. The added native ORM rejection test is preserved for that environment.
- R2-OD1/R2-OD2/R2-OD3 Python/static parts verified; Node interpolation regression and Gateway operational auth regression are included in root's single Node/Vitest verification run.

### Round 2 — desktop, integration, deployment and remaining UI review
| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|-----------|---------|--------|
| R2-TA1 | High | Docker context | .dockerignore:19 | Current Agent queue.db/WAL, paired config.yaml/backups and private capture state were not excluded from build context | FIXED explicit actual-runtime exclusions; hygiene regression extended |
| R2-TA2 | High | Recovery | scripts/postgres-restore.sh:68 | sha256sum -c verified filenames listed in sidecar rather than proving the selected archive matched, permitting wrong-file sidecars before DB access | FIXED compare exact selected-file digest/name; executable wrong-file regression written |
| R2-TA3 | Low | Desktop UI | src/desktop/pages/TestCenter.tsx:527 | Clipboard rejection was unhandled, with no success/failure feedback | FIXED reuse existing localized CopyButton |
| R2-TA4 | Low | Desktop i18n | src/desktop/lib/printers.ts:204 | Circular-object error fallback forced English despite requested Arabic locale | FIXED requested locale used; circular-error regression written |
| R2-TA5 | Low | Deployment docs | DEPLOYMENT.md:215 | Daily 02:00 UTC backup example used systemd daily, which means local midnight | FIXED explicit date/time plus UTC; runbook assertion added |
| R2-TA6 | Medium | Fleet integration | src/desktop/lib/ipc.ts:190; src-tauri/src/commands.rs:446,636 | Desktop read first bounded Agent/printer page only; paired CLI/Rust discarded pagination headers and denied keyset queries | FIXED all producers/consumers; optional allowlisted header envelope and GET-only bounded query contract; 6 traversal regressions plus Rust and CLI tests |
| R2-TA7 | Medium | Capture monitor UI | src/app/capture-tests/capture-tests-client.tsx:114 | Replacing an older-page request with refresh/filter left paging latched forever; inverse retained refresh spinner | FIXED replacement/finalizer owns both flags; 2 callback race regressions written |
| R2-TA8 | Low | Dashboard UI | src/app/dashboard/dashboard-client.tsx:1696,1798 | Snapshot freshness prevented stale badges from aging alongside effective status | FIXED derive freshness from timestamp and advancing clock in both presentations |
| R2-TA9 | Low | Dashboard UX | src/app/dashboard/dashboard-client.tsx:1504 | Empty-Agent registration action ignored busy/DB failure guard present on heading action | FIXED same guard reused |
| R2-TA10 | Low | Desktop preview | src/desktop/preview/mock-tauri.ts:205 | Browser preview lacked current credential-free probe and tray-locale commands, leaving Gateway disconnected | FIXED existing preview backend handlers; behavioral startup regression written |

Files fully reviewed in this pass (new coverage; prior fully reviewed production Rust/CI files retained without repeat):
- src/desktop/lib/{ipc,printers,gateway-connectivity}.ts; src/desktop/pages/TestCenter.tsx; src/desktop/components/CaptureHistory.tsx; src/desktop/main.tsx remaining1280–1525; src/desktop/types.ts, theme-light.css, index.html, preview.html, preview/{main,mock-tauri}.ts, public/theme-init.{js,css}.
- scripts/{postgres-backup,postgres-restore,ci-postgres,verify-fresh-source,setup-tauri-linux,count-ignored-results}.sh; scripts/{build-windows-installer,smoke-test-windows}.ps1; scripts/{audit-gate,print-latency-report,generate-icons}.mjs; .dockerignore. Manifests read for versions only; prior CI workflow and Docker/Caddy full-review evidence preserved.
- src/app/dashboard/dashboard-client.tsx remaining1331–2489; src/app/capture-tests/capture-tests-client.tsx full559; src/app/globals.css tail1100–1751 (earlier cutoff unspecified, so full stylesheet coverage remains unclaimed); src/components/{ThemeToggle,LanguageSwitcher}.tsx full.
- Rust changes statically traced through GatewayResponse, GET path allowlist, paired CLI invocation, bounded output, command registration and capability manifest; existing custom commands already use AppManifest::commands, so no new capability defect.

Recommendations (not applied):
- Keep existing TA-F4/TA-F5 release recommendations: real Agent WebSocket-through-Caddy proof, trusted code-signing/updater decisions. No packages or versions changed.
- Windows installer custom -Target cross-architecture output remains UNVERIFIED: production CI/default target is x86_64; standalone helper currently builds Go binaries with host GOARCH. Validate/support other targets deliberately before advertising ARM64/x86 release artifacts.

### Round 2 Phase 4 — desktop/Rust verification
- UNVERIFIED/ENV: `npm run desktop:vite:build` reached Vite8.3.2/Rolldown and failed resolving the already-pinned but absent installed `@radix-ui/react-dialog` from src/desktop/components/Sidebar.tsx. Full log: /tmp/r2-desktop-build.log. Required dependency remains intact; no installs or unsafe externalization.
- UNVERIFIED/ENV: `CARGO_NET_OFFLINE=true RUSTUP_TOOLCHAIN=1.98.1 RUSTUP_AUTO_INSTALL=0 cargo check --offline --locked --manifest-path src-tauri/Cargo.toml` failed because locked quinn-proto0.11.18 is not cached. Offline blocked the attempted HTTP request before any download. Full log: /tmp/r2-cargo-check.log. Cargo test has the same unresolved prerequisite and was not redundantly run.
- Windows NSIS/SCM, physical rendering/printers, container Caddy proxy and live Gateway/Stripe/Odoo execution remain unverified on this Linux/offline dependency environment. Root owns shared Vitest/typecheck/lint/Node/i18n results; Odoo agent owns static pytest and addon syntax/XML results.

### R2 Phase 4 Go verification (2026-10-13; no network/install)
- PASS: `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -vet=all -mod=readonly ./...` — all 10 Go packages passed, including real CLI stub-Gateway integration, discovery immutable-map regression and local capture filesystem retention regression. Printer package completed in 68.052s; Agent in 33.395s. No test weakened/skipped to obtain green.
- PASS: native `go build -mod=readonly ./...`; Windows `GOOS=windows CGO_ENABLED=0 go build -mod=readonly ./...`; Windows `go vet -mod=readonly ./...`; Windows printer test binary compiled with `go test -c` (not executed on Linux).
- Verified with installed `go1.26.8-X:nodwarf5 linux/amd64` using local-only toolchain selection. Manifest requests go1.26.9; exact pinned toolchain execution UNVERIFIED because downloads are prohibited. Dependency versions/manifests unchanged.
- R2-GO-1 Windows preflight recovery regressions compile; actual Win32 execution UNVERIFIED. R2-GO-2/3/5 Go behavioral regressions PASS. R2-GO-4 SCM policy source contract and R2-GO-6 clock-skew Gateway behavioral regression are included in root verification runs. Hardware/session/physical printing remain UNVERIFIED.

| R2-TA11 | Low | Asset tooling | scripts/generate-icons.mjs:52 | Icon regeneration attempted public/favicon.png on a source checkout with no public directory | FIXED create target directory using existing Node filesystem API; no assets regenerated |
- PASS: Phase4 deployment regression run `python3 -m pytest -q tests/test_postgres_dr_contract.py tests/test_docker_context_hygiene.py` —5 passed, including wrong-file sidecar rejected before mocked DB command access and actual-runtime build exclusions. Log /tmp/r2-deploy-regressions.log; installed pytest-asyncio emitted upstream Python3.14 deprecation warnings.
- PASS after repair: focused desktop/fleet/error/envelope Vitest18/18; direct-browser production transport header regression1/1. Root typecheck caught an introduced browser response-header local shadowing the request header parameter; repaired with distinct responseHeaders and covered caller Authorization + fleet continuation headers. Re-run typecheck reports only15 absent-Radix/GSAP module/type-inference errors, no introduced IPC/test errors. Logs /tmp/r2-desktop-focused.log, /tmp/r2-browser-headers.log, /tmp/r2-desktop-typecheck.log.

### Phase 4 continuation verification (in progress)
- PASS: full ESLint; en/ar i18n 2574 keys per locale; DB-doc checker (26 current tables,84 migrations).
- PASS: Vitest unit1066 tests; one desktop smoke blocked by absent installed @radix-ui/react-dialog. All new route/clock/fleet/auth regressions passed.
- PASS: Node offline tests367; standalone pg-concurrent-claim initially refused missing DATABASE_URL, then PASS with actual cached PostgreSQL scratch database (20 unique claims, no repeat delivery).
- PASS: production migration script against fresh PostgreSQL16.15 scratch DB. Temporary cached-image container uses --pull=never, tmpfs and localhost-only port; no user data touched.
- IN PROGRESS: full PostgreSQL integration suite now running against scratch DB; detected remaining key-rotation/health discrepancies are being investigated rather than reported green.
- BLOCKED ENV: Next production build and desktop Vite build lack installed pinned Radix; GSAP also absent for Next. Typecheck sequential rerun found an introduced direct-browser header shadow, being repaired; no ambient declaration/mocked dependency workaround is applied.

### R2 Phase 4 live PostgreSQL follow-up

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|-----------|---------|--------|
| R2-GO-7 | Medium | Gateway Agent health | src/lib/agent-health.ts:328 | Fleet custom SQL interpolated raw Dates, serialized by pg in Cairo host time; naive UTC timestamps then excluded fresh busy printers while detail reported ONLINE | FIXED by shared UTC driver setup (R2-GW6); original query/assertions preserved; Cairo/New York/Tokyo regression PASS |

- Fully reviewed reopened due real failure: src/lib/agent-health.ts, tests/agent-health-db.test.ts, tests/helpers/pg.ts; pg serializer and Drizzle timestamp encoder inspected only for proven root cause. Existing route/public contract remains identical.
- R2-GO-7 targeted live PostgreSQL verification PASS: tests/agent-health-db.test.ts 9/9, including unchanged fleet/detail test and added three-timezone regression, on the existing isolated scratch PostgreSQL container. Full suite not repeated; no test expectation weakened.
- R2-GO-7 final implementation uses the root shared pg UTC-input default in src/db/index.ts, superseding the interim per-query timestamp operator changes (reverted). The original Agent-health query and public contract remain unchanged; three-timezone regression retained. Verification after shared fix pending.

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-GW6 | High | Gateway/DB integration | src/db/index.ts:8 | Raw SQL Date parameters serialized in host local time into UTC-naive TIMESTAMP columns, shifting billing event fences, auth/WS windows and fleet aggregate bounds by hours on non-UTC hosts | FIXED once at shared pg initialization using pinned driver's existing UTC input flag; three-timezone DB regressions and full431-test PostgreSQL integration suite PASS |

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R2-GW-OD3 | Medium | Gateway/integration fixture dates | tests/helpers/pg.ts:4,24 | Raw pg Date input was serialized in host-local time into UTC-naive columns, and raw timestamp1114 results were parsed as host-local; Cairo caused +3h stored grace timestamps and -3h observed expiry, failing correct auth assertions | FIXED: driver-confirmed UTC input default, UTC session, pool-local UTC timestamp parser reusing parseDbTimeMs; binary/unknown/infinity delegation preserved. Root applies the same input convention in production; original auth assertions unchanged |

### R2 Phase 4 — scratch PostgreSQL authentication verification (2026-10-13)
- Diagnosis: read-only parameter probe against the isolated scratch PostgreSQL showed raw local-Date insertion skew **+10,799.997 seconds** on Africa/Cairo while explicit ISO produced correct UTC storage. The untouched Odoo rotation assertion passed under UTC, confirming the auth algorithm was correct.
- PASS after shared adapter fix: `vitest run --config vitest.integration.config.mts tests/odoo-gateway-activation-sync.test.ts tests/manager-auth.test.ts tests/session-tokens.integration.test.ts` on native **Africa/Cairo** — **27 passed across 3 files**, no skips.
- Added regression independently switches the test host to **Pacific/Honolulu (UTC-10)** and checks Date readback, stored UTC SQL epoch, timestamptz preservation and infinity fallback. Existing rotation/session assertions were preserved.
- Fully reviewed: tests/helpers/pg.ts, tests/odoo-gateway-activation-sync.test.ts, tests/manager-auth.test.ts, tests/session-tokens.integration.test.ts, tests/database-clock.integration.test.ts; reopened src/lib/odoo-auth.ts and Odoo configuration/key-rotation/print-jobs routes solely for integration failure diagnosis, unchanged.
- Evidence logs: `.audit/continuation/odoo-rotation-utc.log`, `.audit/continuation/auth-rotation-utc-adapter.log`. This proves Gateway/Odoo-key/session database behavior in scratch PostgreSQL; native Odoo addon upgrade/TransactionCase and physical printing remain UNVERIFIED.
- R2-GO-7 FINAL VERIFICATION PASS against shared driver UTC fix and original raw-Date Agent-health query: targeted agent-health-db.test.ts 9/9, including Cairo/New York/Tokyo regression. Targeted health/test ESLint and diff whitespace checks PASS. Earlier interim per-query fix is absent from final source.

## Final continuation status — 2026-10-13

- Implemented component fixes and coordinated contracts without package installation, image pulls or dependency/version changes. The Odoo addon itself advances to19.0.2.14.0 to run its required ownership migration.
- INTEGRATION_MAP in STACK_NOTES.md:5 wired /9 fixed /4 UNVERIFIED target acceptance gates;0 known remaining broken static flows. Prior "spooler mostly unread" limitation is closed by full static spooler review. Historical false Odoo `_t`/OWL cache was corrected, preserving native behavior and msgids.
- PASS: full PostgreSQL integration431 tests across60 files on cached PostgreSQL16.15. Existing framework guards left9 production-build/multi-instance cases unverified; no test or assertion disabled. The previously failing13 cases were fixed through shared UTC input and fixture parsing; timezone regressions cover Cairo/New York/Tokyo/Honolulu.
- PASS: final Vitest unit1067 tests across165 files; one desktop UI smoke FAIL-ENV because installed pinned Radix is absent. New CLI/fleet/auth/capture/translation regressions PASS.
- PASS: final Node offline/SQL tests369/369, no skips; SQL20-job concurrent claim probe proves no duplicate claim and no second-round delivery.
- PASS: all10 Go packages with race/vet; native build; Windows cross-build/vet; Windows printer regression compilation. Installed Go1.26.8 used with downloads disabled; exact pinned1.26.9 UNVERIFIED.
- PASS: Python486 tests;50 addon Python syntax checks;11 XML parses;785 Odoo translation terms; en/ar2574 keys each;26-table/84-migration DB-doc consistency; full ESLint; new icon-script syntax; diff whitespace.
- UNVERIFIED/ENV: Next/desktop production builds and desktop smoke require existing-but-uninstalled @radix-ui/react-dialog; Next also lacks gsap. Full typecheck reports15 missing-module/cascading-type diagnostics; no new changed backend/IPC/test typing errors. No replacement stubs, dependencies or test skips added.
- UNVERIFIED/ENV: Rust check/test needs uncached locked quinn-proto0.11.18; offline prevented downloads. Native NSIS/Windows SCM/USB/LAN/printers, live Odoo19 ORM/assets/upgrade rollback, live Stripe/Caddy deployment need target runtime/hardware/account evidence.
- Recommendations needing release decisions: signing/updater rollout; real Agent-WebSocket-through-Caddy acceptance; restore already-pinned frontend/Rust dependencies in an authorized setup before production build acceptance. On existing non-UTC deployments, inspect legacy raw-SQL timestamp fields against authoritative event evidence; no blind historical timestamp shift applied.
- Upgrade risk: Odoo rows without provable company ownership intentionally stop19.0.2.14.0 upgrade; restore verified source/ownership before activating workers. Offline migration tests passed; native addon upgrade/rollback remains a release gate.
- Multi-instance opt-in was also attempted explicitly: production Gateway refused startup because .next/BUILD_ID could not be generated with missing frontend modules. UNVERIFIED/ENV, with startup failure retained in .audit/continuation/multi-instance.log; no fabricated build or skipped assertion.
- Cleanup complete: temporary PostgreSQL container stopped and automatically removed with tmpfs database; cached image retained. Dependency manifests/lockfiles unchanged; final diff whitespace clean.

## Round 3 — Final Enhancement & Integration Pass (2026-10-13)

| ID | Severity | Component | file:line | Problem | Status |
|----|----------|-----------|------------|---------|--------|
| R3-UI1 | Low | Gateway UI / i18n | src/app/verify-email/page.tsx:48-115 | `msg` and `resendMsg` stored pre-translated strings in `useState`, freezing initial locale copy on language toggle and including `t` in verification `useEffect` deps | FIXED; structured outcome state derives translated strings at render time without re-running verification POST |
| R3-UI2 | Low | Gateway / Desktop RTL CSS | src/app/globals.css:594-597,1066-1073 | `.yz-slide-in-left`/`.yz-slide-in-right` lacked the `[dir="rtl"]` keyframe mirroring applied to legacy `.pg-slide-in-*`, and `.yz-menu-in` hardcoded `transform-origin: top right` in RTL | FIXED; mirrored `.yz-slide-in-*` keyframes and `[dir="rtl"] .yz-menu-in` transform-origin |
| R3-UI3 | Low | UI copy/token checker | scripts/check-ui-copy.py:242,380 | `JSX_TEXT` falsely flagged multi-line PascalCase icon import lists (`capture-tests-client.tsx:6-8`, `CaptureHistory.tsx:4-5`) and `UNIT_OR_TOKEN` omitted `mm`/`dpi` (`TestCenter.tsx:354`) | FIXED; `python3 scripts/check-ui-copy.py` now passes 0 findings across all TSX files and 2,574 en/ar keys |
| R3-GW1 | Low | Gateway scripts | scripts/bootstrap-platform-owner.ts:97,162 | Platform bootstrap stamped `emailVerifiedAt`/`updatedAt` from host `new Date()` instead of PostgreSQL `clock_timestamp()` and exited before `pool.end()` | FIXED; uses `sql\`clock_timestamp()\`` inside advisory-locked txn and closes pool in `.finally()` |
| R3-GW2 | Low | Gateway API | src/app/api/jobs/route.ts:39-52 | `printerId` and `agentId` query parameters were untrimmed and unbounded (`GW-F8`) | FIXED; trimmed and bounded to `MAX_FILTER_ID_LENGTH = 2048` with 400 rejection |
| R3-PY1 | Low | Security test isolation | tests/test_final_security_hardening.py:215-225 | `test_credential_key_file_provider_and_deployment_template_are_safe` mutated `os.environ["ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64_FILE"]` directly without `monkeypatch`, leaking a deleted temp path into subsequent tests when run out of source order | FIXED; uses `monkeypatch.delenv`/`monkeypatch.setenv` |

### R3 files fully reviewed (completes 100% of production source files)
- Go agent remaining files: `agent/internal/printer/image.go`, `agent/internal/agent/desired_state_pagination.go`, `agent/internal/agent/device_class.go`, `agent/internal/queue/cleanup.go`, `agent/internal/queue/queue.go`
- Gateway API & libs remaining files: `src/app/api/agents/route.ts`, `src/app/api/billing/plans/route.ts`, `src/app/api/odoo/health/route.ts`, `src/app/api/odoo/keys/[id]/rotate/route.ts`, `src/app/api/printers/[id]/certify/route.ts`, `src/app/api/printers/capabilities/route.ts`, `src/app/capture-tests/page.tsx`, `src/lib/lifecycle.ts`, `src/lib/nanoid.ts`, `src/lib/session-config.ts`, `src/lib/stale-threshold.ts`, `src/lib/trust-proxy-config.ts`, `src/shared/diagnostic-test.ts`
- Stylesheet & scripts remaining files: `src/app/globals.css` (lines 1–1752 full coverage), `scripts/bootstrap-platform-owner.ts`, `scripts/provision-plans.ts`, `scripts/check-ui-copy.py`, `scripts/pg-concurrent-claim.sh`, `scripts/pg-notify-failure-injection.ts`

### R3 Phase 4 Verification Summary (current VM environment)
- PASS: `python3 scripts/check-db-docs.py` — 26 `schema.ts` tables, 84 migrations, and `docs/DATABASE.md` in sync.
- PASS: `python3 scripts/check-odoo-translations.py` — 785 extracted terms and 785 `i18n/ar.po` catalog entries in sync.
- PASS: `python3 scripts/check-ui-copy.py` — 2,574 `en` and 2,574 `ar` catalog keys, 0 hardcoded UI copy hits, all design tokens defined, all WCAG contrast pairs passing.
- PASS: `py_compile` on all 50 Odoo addon Python files and `xml.etree.ElementTree` parse on all 11 addon XML files.
- PASS: 485 / 486 Python tests across all 55 `tests/test_*.py` files via Python 3.11 stdlib runner (only `test_tauri_std_audit.py::test_actual_rust_logging_and_process_identity` is UNVERIFIED/ENV on this VM because `rustc` is not installed).
- PASS: 40 standalone Node `.mjs` test suites (`node --experimental-vm-modules --test`); the remaining 31 `.mjs` files require Node 22.6+/24 `node:module.stripTypeScriptTypes` or installed `node_modules/typescript` (this VM has Node v18.20.4 and no `node_modules`).
- UNVERIFIED/ENV on this VM (retained alongside R2 verification evidence): `tsc`/`eslint`/`vitest`/`next build` (`node_modules` not installed; offline no-install rule), `go build`/`go test` (`go` binary not installed on this VM; passed 10/10 packages with `-race` in R2), `cargo check` (`cargo`/`rustc` not installed on this VM), live PostgreSQL integration (`psql`/Docker not installed on this VM; passed 431 tests in R2), real Windows SCM/spooler/physical printers, live Odoo 19 runtime, live Stripe webhooks, and deployed Caddy WebSocket proxy.
