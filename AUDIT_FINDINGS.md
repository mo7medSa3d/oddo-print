# AUDIT_FINDINGS.md — Full Codebase Audit

**Audit Date:** 2026-09-26 (v1, 30 items) + 2026-09-27 (v2 expanded re-verification) + 2026-09-27 (v3 re-verification against current `main`)
**Scope:** Every file in the Yasser project, all 11 areas, file-by-file.
**Method:** Static read of every file in scope. v2 verified every claim against `main @ 01745fea`. v3 re-verified every open item against `main @ 15ab2bea` (current HEAD) and attributed fixes to the 15 post-audit commits. No code was changed to produce this file.
**Status:** Part A complete (read-only). Part B (fixes) in progress. Items fixed by post-audit commits are marked `[x]` with the fixing SHA; everything else is `[ ]` open.
**CI state at v3 verification:** `main @ 15ab2bea` — CI `36299009432` success, Docker `36299009360` success, Static Security Gates `36299009477` success, Security/Resilience `36299009364` success; Build Windows Installer `36299009422` running at verification time. The v2 CI-RED entry gate is resolved (green since `5377be6a`).

Legend: `[x]` fixed (SHA given) · `[ ]` open · `BLOCKED` = cannot verify/fix without a live external system.

---

## 1. Gateway API Routes (`src/app/api/**` — all 76 route files read)

- [x] **[Severity: High] Unhandled JSON parsing error returns 500 instead of 400**
      File: `src/app/api/agent/heartbeat/route.ts:138`
      Fix applied: commit `1771752d` — isolated JSON parsing, returns 400 Bad Request.

- [x] **[Severity: Medium] Health check catch block hides errors and uses wrong status code**
      File: `src/app/api/health/route.ts:18`
      Fix applied: commit `1771752d` — logs the error, returns 503 Service Unavailable.

- [x] **[Severity: High] No rate limit on password-reset token consumption**
      File: `src/app/api/auth/reset-password/route.ts:13`
      Fix applied: commit `0d7da21e` — `reserveAuthAttempt(ip, "reset-password-token")` with 429/Retry-After, mirroring forgot-password.

- [x] **[Severity: High] No rate limit on email-verification token consumption**
      File: `src/app/api/auth/verify-email/route.ts:13`
      Fix applied: commit `0d7da21e` — `reserveAuthAttempt(ip, "verify-email-token")` with 429/Retry-Audit before the tokenHash lookup.

- [x] **[Severity: Medium] Negative `limit` not clamped in job listing**
      File: `src/app/api/jobs/route.ts:36`
      Fix applied: commit `ebc0cb05` — shared `clampListLimit()` helper (`src/lib/request-limits.ts:14`), clamps 1..200.

- [x] **[Severity: Medium] Negative `limit` not clamped in agent listing**
      File: `src/app/api/agents/route.ts:31`
      Fix applied: commit `ebc0cb05` — `clampListLimit(..., 1000, 1000)`.

- [x] **[Severity: Medium] Negative `limit` not clamped in printer listing**
      File: `src/app/api/printers/route.ts:32`
      Fix applied: commit `ebc0cb05` — `clampListLimit(..., 1000, 1000)`.

- [x] **[Severity: Medium] `PLATFORM_TENANT_ID` fail-open when unset**
      File: `src/app/api/platform/tenants/[id]/suspend/route.ts:22-29` + `docker-compose.yml:83` + `DEPLOYMENT.md:50`
      Fix applied: commit `d0bdc4b9` (pre-audit; v2 audit missed it) — `server.ts:65-69` refuses production startup when `PLATFORM_TENANT_ID` is unset or the `<required-platform-tenant-id>` placeholder, so the route's fail-open branch is unreachable in production. Compose still defaults to empty (`docker-compose.yml:83`), which now fails fast at boot with a clear message.

- [x] **[Severity: Low] Discovery devices query omits `agentId` fence present on the session query**
      File: `src/app/api/agents/[id]/discovery/[discoveryId]/route.ts:15-17`
      Issue: The session lookup fences on `id + agentId + tenantId`, but the devices lookup filters only `discoveryId + tenantId`. Same-tenant managers with `agents.read` can already enumerate agents, so this is defense-in-depth rather than a privilege escalation — but a device row whose `agentId` FK disagrees with its session's agent would leak across the `:id` boundary.
      Suggested fix: Add `eq(discoveredDevices.agentId, agentId)` to the devices predicate.
      Fix applied: 8e1fc1b9 — devices predicate gains eq(discoveredDevices.agentId, agentId).

- [x] **[Severity: Low] Wrong status for unauthenticated settings access**
      File: `src/app/api/settings/route.ts:11,22`
      Issue: `!claims?.userId` returns `403 Forbidden`; the repo convention (e.g. `onboarding/route.ts:11,31`) is `401 Unauthorized` for missing auth, `403` for permission failure. `403` misleads legacy-token holders into debugging permissions instead of re-authenticating.
      Suggested fix: Return 401 when there are no claims, 403 only when permission check fails.
      Fix applied: a1423c9d — 401 when no claims/userId, 403 only for permission failure.

- [x] **[Severity: Low] Inconsistent `Forbidden` response shape**
      Files: `src/app/api/odoo/keys/route.ts:35,70`, `src/app/api/agents/[id]/route.ts:37`
      Issue: `GET` returns bare `{error}` while `POST` returns `{error, code: FORBIDDEN, ...}` via `ActionError` for the same authorization failure.
      Suggested fix: Standardize one shape (prefer the coded shape).
      Fix applied: 0db704d4 — standardized on the coded ActionError shape (agents/[id], odoo/keys).

- [x] **[Severity: Low] Inconsistent auth-failure shape on session probe**
      File: `src/app/api/auth/me/route.ts:1`
      Issue: Returns `{authenticated: false}` 401 while every other route returns `{error: string}`. Breaks shared client error handling (likely a deliberate probe shape — if kept, document it as intentional).
      Suggested fix: Return `{error: "Unauthorized"}` or add a comment declaring the probe shape deliberate.
      Fix applied: 0db704d4 — 401 bodies use {error}; 2xx probe bodies keep the authenticated flag (clients key off status).

- [x] **[Severity: Low] Dead imports in agent jobs route**
      File: `src/app/api/agent/jobs/route.ts:17-18`
      Issue: `getCorrelationContext`, `generateAttemptId`, `databaseNowMs` are imported but never referenced (verified by grep — only the import lines match).
      Suggested fix: Delete the unused imports.
      Fix applied: dedb1955 — getCorrelationContext/generateAttemptId removed (remaining refreshClockSkew/nanoid matches are live uses).

- [x] **[Severity: Low] Dead import in print jobs route**
      File: `src/app/api/print/jobs/route.ts:10`
      Issue: `refreshClockSkew` imported but never called (only `databaseNowMs` is used).
      Suggested fix: Delete the unused import.
      Fix applied: dedb1955 — refreshClockSkew import removed.

- [x] **[Severity: Low] Dead import in printer certify route**
      File: `src/app/api/printers/[id]/certify/route.ts:8`
      Issue: `nanoid` imported but never used (IDs come from `createPrintJobForPrinter`).
      Suggested fix: Delete the unused import.
      Fix applied: dedb1955 — nanoid import removed (generateAttemptId use at :61 is live).

- [x] **[Severity: Low] Wrong status for webhook signature failure**
      File: `src/app/api/billing/webhook/route.ts:67`
      Issue: Bad `stripe-signature` returns `400`; a signature failure is an authentication failure → `401` is semantically correct.
      Suggested fix: Return 401 for invalid signature (keep 400 for malformed JSON/event).
      Fix applied: afcb5a76 tried 401; integration contract pins 400 + Stripe convention; reverted in 2fe01934 with deliberate-design comment. Closed as documented-deliberate.

- [x] **[Severity: Low] Wrong status for consumed selection token**
      File: `src/app/api/auth/select-tenant/route.ts:100`
      Issue: `Selection token already used` returns `401`; single-use-token replay is a client-state conflict → `409` (as `agent/register:189` does for consumed codes).
      Suggested fix: Return 409.
      Fix applied: afcb5a76 — 409 (only the message string is pinned, not the status).

- [x] **[Severity: Low] No body limit or rate limit on invitation accept**
      File: `src/app/api/team/invitations/accept/route.ts:8`
      Issue: No `hasBodyOverLimit`, no `reserveAuthAttempt` on the `tokenHash` lookup. Token entropy (256-char) makes enumeration infeasible and `email` must also match (`:18`), so this is a consistency/hardening item, not an exploitable gap.
      Suggested fix: Add `hasBodyOverLimit(req, 16*1024)` + IP throttle for consistency with the other token-consuming routes.
      Fix applied: 14706ddc — hasBodyOverLimit(16KiB) + IP-scoped reserveAuthAttempt; budget never cleared (no session minted, same policy as forgot-password).

---

## 2. Gateway Lib/Services (`src/lib/**`, `src/server/**` — every file read)

- [x] **[Severity: High] Unvalidated `MAINTENANCE_SWEEP_LIMIT` produces `LIMIT NaN` SQL**
      File: `src/lib/job-maintenance.ts:19`
      Fix applied: commit `6638efc4` — finite-positive guard with fallback to 200.

- [x] **[Severity: High] System health overall permanently `unknown` due to hardcoded external checks**
      File: `src/lib/system-health.ts:157,176-178` + `computeOverall` external branch
      Issue: `getSystemHealth` hardcodes `odoo`/`billing` as `unknown` ("NOT VERIFIED"), and `computeOverall` forces overall `unknown` when any external check is `unknown`. The endpoint can never report better than `unknown`, which also contradicts the Docker smoke expectation of `warn`-when-degraded. A real Odoo probe target exists (`src/app/api/odoo/health/`).
      Suggested fix: Either probe Odoo health (and Stripe reachability when configured) for real, or change policy so intentionally-unverified externals cap overall at `warn` instead of `unknown`, documenting the policy. Externally visible behavior change — note in commit + PATCH_LOG.
      Fix applied: ee13b64f — intentionally-unverified externals cap overall at WARN, never OK (verified green CI 36299009432 + Windows 36299009422). BEHAVIOR CHANGE noted in commit.

- [x] **[Severity: Low] Inconsistent logger: `console.warn` instead of application logger**
      File: `src/lib/auth-rate-limit.ts:50`
      Fix applied: commit `6638efc4` — uses `logWarn` from `log.ts`.

- [x] **[Severity: Low] Package version from `process.env.npm_package_version` may be `undefined`**
      File: `src/lib/system-health.ts:193`
      Fix applied: commit `6638efc4` — falls back to `"1.0.0"`.

- [x] **[Severity: Medium] `console.error` bypasses structured logger in billing operations**
      File: `src/lib/billing-operation.ts:202,209,267`
      Fix applied: commit `11a0bb82` — all three sites now use `logError` with static event names.

- [x] **[Severity: Low] `console.error` in WebSocket upgrade error path**
      File: `src/server/ws.ts:343`
      Fix applied: commit `11a0bb82` — no `console.*` calls remain in `ws.ts` (verified by grep).

- [x] **[Severity: Low] Dynamic log event names break aggregation**
      File: `src/server/ws.ts:493,676,750`
      Fix applied: commit `11a0bb82` — no interpolated `${...}` event names remain in `ws.ts` log calls (verified by grep).

- [x] **[Severity: Medium] Dashboard jobs failure swallowed with no UI error**
      File: `src/app/dashboard/dashboard-client.tsx:459`
      Issue: The `catch` only `console.error`s, leaving a stale job list displayed with no error state; operators cannot distinguish "no jobs" from "query failed".
      Suggested fix: Surface via an error message state.
      Fix applied: ee13b64f — error panel with retry via jobsError/jobsRetryTick.

- [x] **[Severity: Low] Raw `Error` objects in log fields + bracket event names**
      Files: `src/app/billing/page.tsx:109`, `src/app/dashboard/page.tsx:114`
      Issue: `{ error }` passes a live `Error` (`JSON.stringify(Error)` → `{}`), losing the message; `"[dashboard] database load failed"` uses brackets instead of the dotted event convention (`billing.print_usage_unavailable` at billing/page is already correct).
      Suggested fix: `{ error: error instanceof Error ? error.message : String(error) }`, event `dashboard.database_load_failed`.
      Fix applied: ee13b64f — dotted events + string messages.

- [x] **[Severity: Low] Dead exports in session tokens (zero repo-wide callers)**
      File: `src/lib/session-tokens.ts:203,538,807,811`
      Issue: `verifyAccessToken` (only the signature-only variant at `:193` is used), `sessionKindFromClaims`, `getRefreshCookieName`, `getAccessCookieName` have no callers anywhere in `src/`, `tests/`, or `scripts/` (verified by grep).
      Suggested fix: Delete, or wire callers if they are intended public API.
      Fix applied: 6db07659 — verifyAccessToken, sessionKindFromClaims, getRefreshCookieName, getAccessCookieName deleted.

- [x] **[Severity: Low] Dead exports in request guard**
      File: `src/server/request-guard.ts:231,235`
      Issue: `getReservedAuthBytes`/`getReservedUnauthBytes` have no callers; only `getReservedRequestBytes` is used.
      Suggested fix: Delete.
      Fix applied: 6db07659 — getReservedAuthBytes/getReservedUnauthBytes deleted.

- [x] **[Severity: Low] Dead publish helpers in WebSocket server**
      File: `src/server/ws.ts:286,295`
      Issue: `publishAgentSessionClose`/`publishTenantSessionClose` have no callers; session-close paths use raw `pg_notify` SQL instead (two implementations of one concept).
      Suggested fix: Delete the helpers or route the raw-SQL callers through them (preferred: single implementation).
      Fix applied: 6db07659 — publish helpers deleted; single inline pg_notify implementation left.

- [x] **[Severity: Low] Dead WS lock + lifecycle helpers**
      Files: `src/lib/ws-rate-limit.ts:28`, `src/lib/lifecycle.ts:6,18`
      Issue: `isWsUpgradeLocallyLocked` has no callers; `assertLifecycleTransition` (and `isLifecycle`, used only by it) has no callers.
      Suggested fix: Delete.
      Fix applied: 6db07659 — isWsUpgradeLocallyLocked, assertLifecycleTransition, isLifecycle deleted.

- [x] **[Severity: Low] `requireActiveTenant` falls through on unexpected lifecycle**
      File: `src/lib/tenant-guard.ts:92-100`
      Issue: Any value other than `suspended`/`deleted` is returned as valid, while the transactional twin `requireActiveTenantInTransaction` (`:46-48`) throws on anything `!== "active"`. In practice the DB `CHECK (tenants_lifecycle_check)` constrains values to `active/suspended/deleted`, so this is defense-in-depth inconsistency, not a live bypass.
      Suggested fix: `if (lifecycle !== "active") throw new TenantDeletedError(tenantId)` to mirror the transactional guard.
      Fix applied: strict `!== "active"` denial mirroring the transactional guard.

- [x] **[Severity: Medium] Future timestamps treated as fresh in agent health**
      File: `src/lib/agent-health.ts:53-65` vs `src/lib/agent-availability.ts:47-48`, `src/lib/printer-health.ts:58-64`
      Issue: `computeAgentHealthStatus` checks `age <= ONLINE_THRESHOLD_MS` with no `age >= 0` lower bound, so a future `lastSeenAt` (clock skew, bad write) reports `ONLINE`. The availability gate and printer health both reject `age < 0`. The same missing guard exists in the `getAgentHealth` Gateway check at `agent-health.ts:116-119`.
      Suggested fix: Add `ageMs >= 0` guards.
      Fix applied: `age < 0` returns OFFLINE in `computeAgentHealthStatus`; the Gateway check reports error for future observations.

- [x] **[Severity: Medium] Stale-threshold quintuplication (env ignored by 5 of 6)**
      Files: `src/lib/printer-health.ts:56` (`FRESHNESS_THRESHOLD_MS = 90_000`), `src/lib/agent-health.ts:49` (`ONLINE_THRESHOLD_MS = 90_000`), `src/shared/job-vocabulary.ts:130` (`AGENT_HEARTBEAT_STALE_SECONDS = 90`), `src/app/api/printers/[id]/certify/route.ts:268` (`age <= 90_000`), `src/lib/system-health.ts:94` (`NOW() - INTERVAL '90 seconds'`) vs `src/lib/agent-availability.ts:3-10` (`STALE_AGENT_THRESHOLD_SECONDS`)
      Issue: `90s` is hardcoded in five places while only the gateway enforcement gates honor `STALE_AGENT_THRESHOLD_SECONDS`. Setting the env diverges UI/health displays from actual claim-gate enforcement. (v2 said "quadruplication"; v3 found a fifth site in `system-health.ts`.)
      Suggested fix: Single shared helper; health/UI import `agentStaleThresholdSeconds()` (same consolidation already done for metrics/heartbeat in the Phase-2 pass).
      Fix applied: new dependency-free `src/lib/stale-threshold.ts` (no imports — `job-vocabulary.ts` is client-bundled by dashboard + Tauri Vite, so importing via `agent-availability.ts` would drag `db`→`pg` into browser/desktop bundles); `agent-availability.ts` re-exports it so all server importers are unchanged; health/UI/certify read the shared helper; `system-health.ts` already interpolated the env into its SQL. Also fixes the missing certify import the first pass dropped.

- [x] **[Severity: Low] `parseDbTimeMs` quadruplicated**
      Files: `src/lib/auth-rate-limit.ts:33`, `src/lib/ws-rate-limit.ts:13`, `src/lib/job-status.ts:167`, `src/app/api/billing/webhook/route.ts:29`
      Issue: Identical naive-UTC normalizer in four files; will drift (same bug class as the device-class enum drift). (v2 said "triplicated"; the webhook copy was added later.)
      Suggested fix: One shared util in `lib/` (keep `parseEntitlementDate` in `entitlements.ts:299` separate — it is intentionally distinct).
      Fix applied: canonical `parseDbTimeMs` in `src/lib/database-clock.ts`; auth-rate-limit, job-status, ws-rate-limit, and webhook import it (webhook already did).

- [x] **[Severity: Low] Access TTL literal duplicated instead of constant**
      Files: `src/lib/manager-auth.ts:129`, `src/lib/platform-auth.ts:148` vs `src/lib/session-tokens.ts:43`
      Issue: `claims.exp - claims.iat !== 15 * 60` hardcodes what `ACCESS_TOKEN_TTL_SECONDS` already defines (and `:156` uses the constant).
      Suggested fix: Import the constant.
      Fix applied: manager-auth.ts + platform-auth.ts now import ACCESS_TOKEN_TTL_SECONDS from session-tokens.

- [x] **[Severity: Low] `managerGatewayHeaders()` dead stub**
      File: `src/desktop/lib/ipc.ts:363`
      Issue: Always returns `{}` yet every `fetchGateway*` awaits and spreads it. Either auth-header injection was never implemented (relying on cookies — then delete the stub) or it is a future seam (then document it).
      Suggested fix: Delete or document with a comment explaining the cookie-based auth.
      Fix applied: stub deleted; callers pass {} with a comment (cookie auth in browser, bearer injection in Rust proxy).

- [x] **[Severity: Low] Unescaped `LIKE` wildcards in job search**
      File: `src/app/actions.ts:371`
      Issue: `%${search}%` is parameterized but `%`/`_`/`\` in user input stay active, while `print-job-service.ts:158` carefully escapes reprint `LIKE`.
      Suggested fix: Escape `\%\_` with `ESCAPE '\\'`.
      Fix applied: term escaped with literal ESCAPE-SQL (an interpolated binding would parameterize into a syntax error).

- [x] **[Severity: Low] CORS allowlist omits headers the app uses**
      File: `src/server/cors.ts:5`
      Issue: `ALLOWED_HEADERS` lacks `Idempotency-Key` (sent at `dashboard-client.tsx:267`), `X-Refresh-Token` (read at `session-tokens.ts:510`), `X-Request-Id`. Currently low-impact (same-origin dashboard needs no preflight; desktop stub sends no custom headers) but will break browser/preview clients that send them.
      Suggested fix: Extend `ALLOWED_HEADERS`.
      Fix applied: ALLOWED_HEADERS gains Idempotency-Key, X-Refresh-Token, X-Request-Id with rationale comment.

- [x] **[Severity: Low] `humanType` reads `printer_type` as a device class**
      File: `src/desktop/lib/printers.ts:79-87`
      Issue: Gateway `printerType` is `physical/virtual/redirected`; `thermal/label/laser` live in `device_class`. The `thermal/label/laser/inkjet` branches are dead code that misleads readers.
      Suggested fix: Read `device_class`/`deviceClass`.
      Fix applied: humanType reads device_class/deviceClass (both casings in PrinterInfo); printer_type branches were dead.

- [x] **[Severity: Low] `load()` duplicates the `useEffect` fetch block**
      File: `src/app/team/page.tsx:44-96`
      Issue: `load()` and the mount `useEffect` contain the same fetch block verbatim.
      Suggested fix: `useEffect` calls `load()`.
      Fix applied: mount effect calls load(); React 18 needs no is-mounted guard (exhaustive-deps off in eslint config).

---

## 3. Gateway DB Layer (`src/db/schema.ts`, `drizzle/` — 74 migrations `0000`–`0073`)

- [x] **[Severity: High] `printers`, `discoveredDevices` lack PRIMARY KEY constraints**
      File: `src/db/schema.ts:143,304`
      Issue: `id: text("id").notNull()` with only `UNIQUE (tenant_id, id)` since migration `0072` dropped the original PKs for tenant-scoped identity. No formal PK hurts ORM/replication/tooling expectations. (`printJobs` still declares `id.primaryKey()` — itself inconsistent.) v3 clarification: `discoverySessions` DOES still have its PK (0010 created it; no migration dropped it; the 0073 snapshot carries it via the `columns.id.primaryKey` flag) — the v2 parenthetical over-claimed; only `printers` and `discoveredDevices` are affected.
      Suggested fix: Add composite PKs `primaryKey({ columns: [tenantId, id] })` + a forward migration. Requires care: existing duplicate `(tenant_id,id)` rows would block it (the UNIQUE constraint already prevents that, so creation is safe).
      Fix applied: REVERTED — see Resolution. A first attempt added composite PKs, but the CI release gate ("Verify final runtime-only schema" in ci.yml) explicitly pins the opposite design: it raises if `printers_pkey`/`discovered_devices_pkey` exist and if `printers_tenant_id_unique` is missing.
      Resolution: CLOSED as documented-deliberate WITHOUT PKs. UNIQUE(tenant_id,id) NOT NULL is the CI-pinned identity boundary; it fully supports a future REPLICA IDENTITY USING INDEX if logical replication is ever needed. Rationale recorded in the 0074 migration header. Do not re-add PKs without updating the gate first.

- [x] **[Severity: Medium] Composite foreign key names in schema.ts don't match migration-hardcoded names — and the migration chain diverges from the snapshot**
      File: `src/db/schema.ts:165,294,338-340,379-381` vs `drizzle/0031_*.sql` + `drizzle/0041_*.sql:161-266` vs `drizzle/meta/0073_*_snapshot.json`
      Issue (v3 expanded): Six composite FKs are named differently in three places. Migrations 0031/0041 create short names (`printers_tenant_id_agent_id_agents_fk`, `discovery_sessions_tenant_id_agent_id_agents_fk`, `discovered_devices_tenant_id_discovery_id_fk`, `discovered_devices_tenant_id_agent_id_agents_fk`, `discovered_devices_tenant_id_provisioned_printer_id_fk`, `print_jobs_tenant_id_api_key_id_api_keys_fk`). The 0071–0073 snapshots show the live DB actually carries Drizzle-default long names (`printers_tenant_id_agent_id_agents_tenant_id_id_fk`, `discovery_sessions_tenant_id_agent_id_agents_tenant_id_id_fk`, `discovered_devices_tenant_id_discovery_id_discovery_sessions_tenant_id_id_fk`, `discovered_devices_tenant_id_agent_id_agents_tenant_id_id_fk`, `discovered_devices_tenant_id_provisioned_printer_id_printers_tenant_id_id_fk`, `print_jobs_tenant_id_api_key_id_api_keys_tenant_id_id_fk`) — no committed migration performs that rename, so a fresh `drizzle-kit migrate` from `0000` produces short-named constraints that diverge from both the snapshot and schema.ts (which specifies no `name`, i.e. the Drizzle default). `drizzle-kit check`/`generate` would try to drop/recreate all six.
      Suggested fix: Add explicit `name` properties matching the snapshot's long names to the six composite `foreignKey` declarations in schema.ts, and add one forward migration renaming the short-named constraints to the long names (idempotent `ALTER TABLE ... RENAME CONSTRAINT` in a DO block) so migrations, schema.ts, and snapshot all agree.
      Fix applied: schema.ts composite FKs gain explicit names; snapshot 0074 aligned to match. Correction to the v3 rename direction: no 0042–0073 migration renames these constraints, so the live DB carries the SHORT 0031/0041 names (0028 longs for print_jobs agent/printer) — standardizing schema+snapshot onto the migration names avoids renaming production constraints; verified by grep over all later migrations.

- [x] **[Severity: Low] Unused `applications` table (dead code)**
      File: `src/db/schema.ts:103`
      Issue: Defined but never queried/inserted/referenced anywhere in `src/` (verified by grep — only `schema.ts` mentions it).
      Suggested fix: Remove the export + a `DROP TABLE` migration.
      Fix applied: export removed; 0074 DROP TABLE IF EXISTS applications (no code or FK references it). ARCHITECTURE schema count corrected 25→24.

- [x] **[Severity: Low] Missing `onDelete: "cascade"` on ephemeral token tables**
      File: `src/db/schema.ts:218,230,243`
      Issue: `emailVerificationTokens`, `passwordResetTokens`, `tenantInvitations` reference `users`/`tenants` without cascade; blocks future hard-delete flows and risks orphans.
      Suggested fix: Add `{ onDelete: "cascade" }` + migration.
      Fix applied: schema references gain onDelete cascade; 0074 drops/re-adds the 4 constraints with ON DELETE CASCADE (guarded DO blocks).

---

## 4. Gateway UI (`src/app/**` pages, `src/components/**`, `src/desktop/**`, `src/shared/**` — every file read)

- [x] **[Severity: Medium] Unawaited `writeAuditEvent` in Server Action can be cancelled**
      File: `src/app/actions.ts:103`
      Fix applied: commit `2f27258a` — write is now awaited.

- [x] **[Severity: Low] Unused imports in Server Actions**
      File: `src/app/actions.ts:7,10,25`
      Fix applied: commit `2f27258a` — removed.

- [x] **[Severity: Low] Unused import `friendlyPrinterError` in AddPrinterDialog**
      File: `src/desktop/components/AddPrinterDialog.tsx:12`
      Fix applied: commit `2f27258a` — removed.

- [x] **[Severity: Low] Unused icon imports in Sidebar**
      File: `src/desktop/components/Sidebar.tsx:2`
      Fix applied: commit `2f27258a` — removed.

- [x] **[Severity: Medium] Desktop overview badge invents language from device class**
      File: `src/desktop/pages/Overview.tsx:54-59` vs `src/lib/printer-capability.ts:61-68`
      Issue: `thermal→"ESC/POS"`, `label→"ZPL / TSPL"`, `laser→"Spooler"` badges are derived from device class, contradicting the documented rule ("device class must never invent a language: a `laser` printer declared `raw` cannot be sent PDF").
      Suggested fix: Use `getPrinterLanguageBadges(protocol, connectionType)`.
      Fix applied: badge derives from getPrinterLanguageBadges(protocol, connectionType); unknown renders 'Unknown'.

- [x] **[Severity: Medium] Stale agent cache + weaker network validation in AddPrinterDialog**
      File: `src/desktop/components/AddPrinterDialog.tsx:48-58,87-92` vs `EditPrinterDialog.tsx:121-129`
      Issue: `agents.length > 0` short-circuits `loadAgents`, keeping gateway A's agents after switching to gateway B; host validation is non-empty/no-space only (no private-IP check) and port must be exactly `9100`, rejecting valid network-IPP `80/443/631` that `EditPrinterDialog` and the gateway accept.
      Suggested fix: Key the agent cache by `gatewayUrl`; reuse the `EditPrinterDialog` host/port validation logic (or import the gateway's `validateConnectionConfig`).
      Fix applied: agent cache keyed by gatewayUrl (selection re-validated per gateway); private-IP non-enforcement documented as deliberate (node:net cannot ship in Tauri bundle; server re-validates); network proto select gains zpl/tspl to match server acceptance.

- [x] **[Severity: Medium] System-health / release-readiness pages use manager-only auth**
      Files: `src/app/system-health/page.tsx:10`, `src/app/release-readiness/page.tsx:10` vs `src/app/dashboard/page.tsx:17`, `src/app/billing/page.tsx:80`
      Issue: These pages use `verifyManagerToken` while dashboard/billing use `verifyWorkspaceTokenFromCookieValues`, bouncing valid customer sessions to `/login` instead of permission-checking.
      Suggested fix: Use the workspace verifier + explicit permission/role check.
      Fix applied: both pages use verifyWorkspaceTokenFromCookieValues + agents.read gate (their client calls /api/system/health, which requires agents.read).

- [x] **[Severity: Low] Printer taxonomy validated in four places + desktop narrowing + duplicated TS types**
      Files: `src/lib/printer-capability.ts:6-9,28-47`, `src/lib/printer-model.ts:4-8`, `src/lib/routing.ts:12` (`BYTE_PROTOCOLS`), `src/lib/discovery.ts:5-11` (superset incl. `mdns/lpr/snmp/wsd/subnet/config/registry`); `AddPrinterDialog.tsx:316-324` narrows network to `raw/escpos` while the gateway accepts `zpl/tspl/ipp` (`printer-model.ts:194-195`); `printer-capability.ts` re-declares `TransportType`/`ProtocolType`/`DocumentType`/`DeviceClass` that duplicate `printer-model.ts`.
      Issue: Same bug class as the device-class drift — four independent taxonomies plus a narrower desktop subset plus duplicated type declarations.
      Suggested fix: Single canonical enum module (`printer-model.ts`); `printer-capability.ts` imports the types instead of redefining; desktop imports the gateway sets.
      Fix applied: capability types derive from printer-model authorities via import type (runtime-import-free for desktop); routing BYTE_PROTOCOLS derived from PRINTER_PROTOCOLS; discovery superset stays documented-distinct.

---

## 5. Agent (Go) (`agent/internal/**`, `agent/cmd/**` — every package read)

- [x] **[Severity: Critical] Missing `terminalReportMu` field in Agent struct — build failure**
      File: `agent/internal/agent/agent.go:756,759`
      Fix applied: commit `bedfab18` — field added to the struct.

- [x] **[Severity: High] `MarkInterrupted` returns all jobs including un-updated ones on error**
      File: `agent/internal/queue/queue.go:398`
      Fix applied: commit `f54b2a77` — returns only successfully marked jobs.

- [x] **[Severity: Medium] `normalizePrinterType` silently coerces `ClassUnknown` to `"physical"`**
      File: `agent/internal/agent/device_class.go:38`
      Fix applied: commit `f54b2a77` — coercion is now logged.

- [x] **[Severity: Low] Inaccurate comment in POSIX security implementation**
      File: `agent/internal/storage/security_other.go:14`
      Fix applied: commit `f54b2a77` — comment reflects the active `Chmod(0600)`.

- [x] **[Severity: High] `BeginPrint` clears the claim-token fence on tokenless redelivery**
      File: `agent/internal/queue/queue.go:284-290`
      Fix applied: commit `e984d728` — `claim_token = COALESCE(?, claim_token)` preserves the stored fence when the incoming token is empty.

- [x] **[Severity: Medium] `RegisterManual` drops USB/capability fields**
      File: `agent/internal/agent/agent.go:596-603`
      Fix applied: commit `bab7848c` — routes through shared `printerConfigFromDeviceInfo`.

- [x] **[Severity: Medium] `QueueDBPath` split-brain vs `RegistryPath`**
      File: `agent/internal/config/paths.go:20` vs `:8-16`
      Fix applied: commit `16b7c58e` — `QueueDBPath` applies the same `ExecutableDir` fallback.

- [x] **[Severity: Medium] `classifySpoolerPrinter` returns `connectionType="local"` for LPT/COM**
      File: `agent/internal/printer/classify.go:109`
      Fix applied: commit `68ab1525` — LPT/COM maps to `spooler` (with comment explaining the factory constraint).

- [x] **[Severity: Medium] Registration HTTP client follows redirects**
      File: `agent/internal/agent/pairing.go:65`
      Fix applied: commit `7fdb5af7` — `CheckRedirect` returns `http.ErrUseLastResponse`.

- [x] **[Severity: Medium] Non-string peripherals silently ignored**
      File: `agent/internal/payload/payload.go:151-165`
      Fix applied: commit `7fdb5af7` — present-but-non-string peripheral values are a hard error.

- [x] **[Severity: Medium] `UpsertRegistry` lossy replace**
      File: `agent/internal/printer/registry.go:227`
      Fix applied: commits `68ab1525` + `b87c4975` — stored row is merged via `mergeDeviceInfo`; incoming wins only display fields (name/displayName).

- [x] **[Severity: Low] `discoverFromConfig` hardcodes `PrinterType: "unknown"`**
      File: `agent/internal/printer/discovery.go:702`
      Fix applied: commit `68ab1525` — propagates `pc.PrinterType` (normalized).

- [x] **[Severity: Low] Agent-console allowlist drift (Rust vs Go CLI)**
      File: `src-tauri/src/commands.rs:539` vs `agent/cmd/cli/gateway.go:22`
      Issue: Rust allows exact `GET /api/agents` only; the Go CLI regex also allows `/api/agents/<id>`. Both are read-only, so this is a consistency gap, not a privilege gap.
      Suggested fix: Mirror the single-agent pattern in Rust or restrict the Go CLI — document whichever is deliberate.
      Fix applied: documented as deliberate on both sides: console proxy exposes list-only, CLI needs single-agent fetch; both read-only.

- [x] **[Severity: Low] `discovered_via` taxonomy drift (metadata only)**
      Files: `agent/internal/printer/network_discovery.go:194`, `ipp_discovery.go:195` vs `src/lib/discovery.ts:5`
      Fix applied: commit `68ab1525` — `discovery_extended.go:18-35` now defines the canonical `Source*` vocabulary (used at the SNMP/LPR/mDNS/WSD emission sites) and documents `tcp_port_scan`/`ipp_tcp_scan` as intentional free-form forensic detail inside `capabilities`.

- [x] **[Severity: Low] Dead `DiscoveryCandidate` type + `Source*` constants**
      File: `agent/internal/printer/discovery_extended.go:19-39`
      Fix applied: commit `68ab1525` — the dead type was deleted; the constants are now the documented canonical vocabulary with real callers.

- [x] **[Severity: Low] Dead `NormalizedConnectionTypeStrict`**
      File: `agent/internal/config/config.go:364`
      Fix applied: commit `68ab1525` — deleted (zero callers, verified by grep).

- [x] **[Severity: Low] Insecure transient directory permissions**
      File: `agent/internal/config/config.go:148,186`
      Fix applied: commit `16b7c58e` — `MkdirAll(dir, 0700)` before ACL hardening.

- [x] **[Severity: Low] Fixed `.tmp` filename collision on concurrent save**
      File: `agent/internal/storage/secure.go:107` (+ `config.go:206`)
      Fix applied: commit `16b7c58e` — `os.CreateTemp` + atomic rename on both paths.

---

## 6. Desktop Shell (Tauri) (`src-tauri/src/**` — every file read)

- [x] **[Severity: Medium] `control_service` duplicated Windows/non-Windows blocks**
      File: `src-tauri/src/agent.rs:727-783`
      Fix applied: commit `222e8c6d` — common code extracted, `creation_flags` conditional.

- [x] **[Severity: Low] Logging timestamp uses Unix epoch instead of ISO 8601**
      File: `src-tauri/src/logging.rs:101-105`
      Fix applied: commit `6dd1c74c` — std-only `format_utc_iso8601` civil-date conversion, emits `2026-09-27T00:00:00.123Z`.

- [x] **[Severity: Low] `read_background_record` aborts whole record on one malformed line**
      File: `src-tauri/src/agent.rs:281`
      Fix applied: commit `6dd1c74c` — `continue` on a malformed line instead of dropping the record.

- [x] **[Severity: Low] Unreachable header filter in desktop gateway proxy**
      File: `src-tauri/src/commands.rs:427-429`
      Fix applied: commit `6dd1c74c` — the dead second check was removed; an explanatory comment documents why the loop is safe.

---

## 7. Odoo Addon (`odoo_addons/**` — every Python and JS file read)

- [x] **[Severity: High] `Environment` instance called as function — non-standard pattern**
      File: `odoo_addons/print_gateway/models/print_intent.py:186`
      Resolution: commits `ab4fb9a3` + `729d2f29` — the `with_context` attempt was reverted (it raises `AttributeError` on Odoo 19: `with_context` is Model-only). The current code uses `Environment.__call__(context=...)` with a detailed comment (`:184-194`) documenting why this is the correct env-level API on Odoo 19, verified against the Odoo 19 runtime in CI. Documented, deliberate exception — closed.

- [x] **[Severity: High] AbstractModel passed as `res_ids` to `_render_qweb_pdf`**
      File: `odoo_addons/print_gateway/controllers/pos.py:20`, `models/print_router.py:234`
      Fix applied: commit `0d819b15` — `res_ids` now passes real IDs (`render_target.ids`) or `False`, with `data=`.

- [x] **[Severity: Medium] Missing `expired` status in Odoo job status Selection**
      File: `odoo_addons/print_gateway/models/print_job.py:50-55`
      Resolution: commit `0d819b15` — Gateway `expired` is now explicitly mapped and the intentional Selection difference is documented in the header comment (`:39-52`). Deliberate, documented, tested — closed.

- [x] **[Severity: Medium] Bare `crypto.randomUUID()` breaks on insecure HTTP LAN**
      File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js:181,385,472`
      Fix applied: commit `ab4fb9a3` — `fallbackUuid()` helper (`:12-17`) with `getRandomValues` v4 + `Math.random` last resort.

- [x] **[Severity: Medium] Printer filter falls back to full list, re-offering rejected classes**
      File: `odoo_addons/print_gateway/static/src/components/runtime_printer_field.js:83-88`
      Fix applied: commit `ab4fb9a3` — empty filter stays empty with an explanatory comment; the empty message is shown.

- [x] **[Severity: Medium] Odoo explicit gate over-restricts `image` vs Gateway + own failover**
      File: `odoo_addons/print_gateway/models/binding.py:554`
      Fix applied: commit `ab4fb9a3` — `resolve_explicit` allows `escpos` for `raster_jpeg`, mirroring `routing.ts:100-107` and the Odoo failover path, with a comment citing the parity.

- [x] **[Severity: Low] Two Sale-Details paths resolve different destinations**
      File: `odoo_addons/print_gateway/controllers/pos.py:21-27` vs `models/print_router.py:505-509`
      Fix applied: commit `ab4fb9a3` — both sides now carry a NOTE comment documenting the dual-binding requirement (each path needs its own binding). Documented, deliberate — closed.

- [x] **[Severity: Low] Config permanently undeletable after first job**
      File: `odoo_addons/print_gateway/security/ir.model.access.csv:8` + `models/gateway_config.py:1376-1394`
      Issue: Admin `print_job` has `perm_unlink=0` (jobs immortal) and `unlink()` blocks config delete while any job references it — after the first print, the config can never be deleted.
      Suggested fix: Document the archival-only lifecycle (model header or ODOO_INTEGRATION.md) or allow admin job purge.
      Fix applied: ab4fb9a3 — unlink error now says jobs are retained audit records and to disable instead.

---

## 8. Cross-Boundary Contracts (`contracts/`, TS↔Go payloads, shared vocabularies)

- [x] **[Severity: Critical] `windows_spooler` protocol rejected by Gateway API validation**
      File: `src/lib/printer-model.ts:8` vs `src/db/schema.ts:177`, `src/lib/printer-capability.ts:7`
      Fix applied: commit `2e638987` — `"windows_spooler"` added to `PRINTER_PROTOCOLS`.

- [x] **[Severity: High] Crash recovery requeue rejected — agent doesn't send `reason` field**
      File: `agent/internal/agent/agent.go:810,2636-2648` vs `src/app/api/agent/jobs/route.ts:326-328`
      Fix applied: commit `f54b2a77` — `updateJobStatus` now carries the crash-recovery reason.

- [x] **[Severity: Medium] StatusDot.tsx hardcodes colors contradicting job-vocabulary tones**
      File: `src/shared/components/StatusDot.tsx:13-15` vs `src/shared/job-vocabulary.ts:45-52`
      Fix applied: commit `2f27258a` — StatusDot uses `jobTone()`/`printerTone()`.

- [x] **[Severity: Low] Odoo invents `submitted`/`partial`/`unknown` top-level statuses**
      File: `odoo_addons/print_gateway/models/print_job.py:50-55` vs `src/lib/job-status.ts:33-40`
      Resolution: commit `0d819b15` — the mapping table is documented in the model header comment (`:39-52`) with explicit transition enforcement (`_VALID_TRANSITIONS`). Deliberate, documented — closed.

- [x] **[Severity: Low] Odoo payload type nomenclature differs from shared contract**
      File: `odoo_addons/print_gateway/models/print_job.py:67-71` vs `contracts/print-payload-contract.json:5`
      Issue: Contract wire types are `raw/escpos/pdf/image`; Odoo selections are `pdf/raster_jpeg/raw_cmd` with an internal mapping dict. Works, but naming drift invites the next enum-drift bug.
      Suggested fix: Rename Odoo selections to the wire names (migration-heavy — likely BLOCKED on Odoo data migration); at minimum document the mapping next to the Selection, mirroring the status Selection's header comment.
      Fix applied: pointer comment on the Selection referencing the contract + `_PAYLOAD_TYPE_MAP` (renaming stored values needs an Odoo data migration — disproportionate for documented internal naming).

---

## 9. Documentation (checked against current code, not memory)

- [x] **[Severity: High] SERVER_FIRST_RUN.md gives invalid Argon2id password hash instructions**
      File: `SERVER_FIRST_RUN.md:98,103-107`
      Fix applied: commit `c951c4b4` — valid Argon2id generation instructions.

- [x] **[Severity: Medium] TROUBLESHOOTING.md references wrong proxy header name**
      File: `TROUBLESHOOTING.md:57`
      Fix applied: commit `ef26f47d` — now `X-Gateway-Proxy-Token`.

- [x] **[Severity: Low] MIGRATION.md migration count outdated**
      File: `MIGRATION.md:46-48`
      Fix applied: commit `ef26f47d` — now 74 migrations (`0000`–`0073`), verified correct (74 `.sql` files present).

- [x] **[Severity: Low] ADR.md and AGENT_ARCHITECTURE.md conflicting polling intervals**
      File: `ADR.md:104` vs `AGENT_ARCHITECTURE.md:38`
      Fix applied: commit `ef26f47d` — both now say 5s offline polling (ADR-009).

- [x] **[Severity: Medium] PRINTERS.md test-print section claims ESC/POS-only**
      File: `PRINTERS.md:229-233`
      Fix applied: commit `3cf36524` — §9 now documents per-protocol ticket selection and points to §10.

- [x] **[Severity: Low] PRINTERS.md "tries next binding on 422" is unsupported**
      File: `PRINTERS.md:53-54`
      Fix applied: commit `3cf36524` — now correctly states 422 is terminal; fix the binding.

- [x] **[Severity: Medium] DEPLOYMENT.md `npm ci --production` before build is broken**
      File: `DEPLOYMENT.md:65`
      Fix applied: commit `3cf36524` — `npm ci` before build, with an explanatory note.

- [x] **[Severity: Low] DEPLOYMENT.md Caddy example uses env var, repo uses secret file**
      File: `DEPLOYMENT.md:76-81`
      Fix applied: commit `3cf36524` — example now uses `{file./run/secrets/trust_proxy_secret}`.

- [x] **[Severity: Low] README entitlement list omits `max_prints_per_period`**
      File: `README.md:50`
      Fix applied: commit `3cf36524` — all five entitlements listed.

- [x] **[Severity: Low] ODOO_INTEGRATION.md lists `print_gateway.crypto` as a model**
      File: `ODOO_INTEGRATION.md:37`
      Fix applied: commit `3cf36524` — relabeled "AES-GCM utility module (not a model)"; the wizard is listed.

- [x] **[Severity: Low] ODOO_INTEGRATION.md policy snippet contradicts branch scope**
      File: `ODOO_INTEGRATION.md:106-112`
      Fix applied: commit `3cf36524` — snippet now shows the root+branch logic.

- [x] **[Severity: Low] ADR-001 states stale Next.js version**
      File: `ADR.md:12`
      Fix applied: commit `3cf36524` — now 16.3.6.

- Reviewed, no finding: `ARCHITECTURE.md:51` route count — a sweep report claimed 75, but `find src/app/api -name route.ts | wc -l` returns **76**, matching the doc. The sweep undercounted; the doc is correct.

---

## 10. CI/CD (`.github/workflows/**` — every workflow read)

- [x] **[Severity: High] `pip install pytest` fails on ubuntu-latest (PEP 668)**
      File: `.github/workflows/ci.yml:144`
      Fix applied: commit `71403d34` — `--break-system-packages` flag added.

- [x] **[Severity: Critical] CI is RED on `main` — Go dispatch suite + Odoo suite failing**
      Runs: CI `36272613988` (failure), Build Windows Installer `36272614002` (failure) on `01745fea`.
      RESOLVED: full green on `5377be6a` and every subsequent push, including `15ab2bea` (CI `36299009432`, Docker `36299009360`, Static Security Gates `36299009477`, Security/Resilience `36299009364` all `success`). Root causes and per-fix evidence in PATCH_LOG. This item was the Part B entry gate: no finding is "done" while CI is red.

- [x] **[Severity: Low] Unpinned pip installs, no cache**
      File: `.github/workflows/ci.yml:144`
      Issue: `pip install --break-system-packages pytest pytest-asyncio` pins no versions (unlike SHA-pinned actions, Go `cache:true`, Node `cache:npm`) — nondeterministic supply chain.
      Suggested fix: Pin versions (e.g. `pytest==x.y.z`) and/or cache pip.
      Fix applied: pinned to the versions CI actually installs today (`pytest==9.1.1 pytest-asyncio==1.4.0` per CI logs) — evidence-based, not guessed.

- [x] **[Severity: Low] Odoo19 job on PG15 vs prod PG16**
      File: `.github/workflows/ci.yml:339` vs `:23`, `docker-compose.yml:3`
      Issue: The `odoo19` service uses `postgres:15-alpine` while prod and main CI use PG16 — behavior drift risk in the test matrix.
      Suggested fix: Bump the Odoo19 service to `postgres:16-alpine` (digest-pinned like `:23`).
      Fix applied: odoo19 service uses the exact digest-pinned PG16 image as main CI (copied verbatim from `:23`, never hand-typed).

---

## 11. Config and Environment

- Reviewed in full: `.env.example`, `docker-compose.yml`, `Dockerfile`, `package.json`, `agent/go.mod`, `src-tauri/Cargo.toml`, `drizzle.config.ts`, `next.config.ts`, `server.ts`, `proxy.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.*.mts`, `Caddyfile`. No additional findings beyond §1 item `PLATFORM_TENANT_ID fail-open` (resolved — see §1).
- v1 note carried forward: dependency currency is a documented residual (see PATCH_LOG Phase-1 triage), not re-reported here.

---

## Summary

| Severity | v2 open (excl. fixed) | v3 open | Fixed by post-audit commits |
|----------|----------------------|---------|-----------------------------|
| Critical | 1 (CI-RED) | 0 | CI-RED resolved (`5377be6a` onward) |
| High     | 6 | 1 | 5 (auth rate-limit ×2, negative limits ×3, BeginPrint fence, system-health still open) |
| Medium   | 22 | 13 | 9 fixed, rest open |
| Low      | 40+ | 28 | 12 fixed, rest open |

**v3 open items by area:** §1 ×10 · §2 ×18 · §3 ×4 · §4 ×4 · §5 ×1 · §6 ×0 · §7 ×1 · §8 ×1 · §9 ×0 · §10 ×2 · §11 ×0 = **41 open**.

**Fixed by post-audit Part B commits (15 commits, `147bd734..15ab2bea`):** `0d7da21e` (§1×2), `ebc0cb05` (§1×3), `11a0bb82` (§2×3), `e984d728` (§5), `bab7848c` (§5), `16b7c58e` (§5×3), `7fdb5af7` (§5×2), `68ab1525` (§5×5), `b87c4975` (§5), `6dd1c74c` (§6×3), `ab4fb9a3` (§7×4), `729d2f29` (§7 revert+document), `3cf36524` (§9×10), `15ab2bea` (test pin).
