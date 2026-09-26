# AUDIT_FINDINGS.md — Full Codebase Audit

**Audit Date:** 2026-09-26 (v1, 30 items) + 2026-09-27 (v2 expanded re-verification, this file)
**Scope:** Every file in the Yasser project, all 11 areas, file-by-file.
**Method:** Static read of every file in scope; each finding below was verified against the exact cited lines on `main` @ `01745fea`. Four parallel area sweeps + targeted re-verification of every Medium-or-higher claim. No code was changed to produce this file.
**Status:** Part A complete (read-only). Part B (fixes) follows. Items already fixed by in-flight Part B commits are marked `[x]` with the fixing SHA; everything else is `[ ]` open.
**CI state at audit time:** `main` @ `01745fea` is RED — CI run `36272613988` (failure) and Build Windows Installer `36272614002` (failure); Static Security Gates `36272614125`, Docker `36272614092`, Security/Resilience `36272613987` are green. See §10 item CI-RED.

Legend: `[x]` fixed (SHA given) · `[ ]` open · `BLOCKED` = cannot verify/fix without a live external system.

---

## 1. Gateway API Routes (`src/app/api/**` — all 76 route files read)

- [x] **[Severity: High] Unhandled JSON parsing error returns 500 instead of 400**
      File: `src/app/api/agent/heartbeat/route.ts:138`
      Issue: `await req.json()` was inside a broad try/catch; malformed JSON fell through to a 500.
      Fix applied: commit `1771752d` — isolated JSON parsing, returns 400 Bad Request.

- [x] **[Severity: Medium] Health check catch block hides errors and uses wrong status code**
      File: `src/app/api/health/route.ts:18`
      Issue: Readiness DB failure returned hardcoded 500 with the error swallowed.
      Fix applied: commit `1771752d` — logs the error, returns 503 Service Unavailable.

- [ ] **[Severity: High] No rate limit on password-reset token consumption**
      File: `src/app/api/auth/reset-password/route.ts:13`
      Issue: Unlike `forgot-password` (`src/app/api/auth/forgot-password/route.ts:17-24`, which calls `reserveAuthAttempt(ip, email)`), this route performs the `tokenHash` DB lookup and password change with no `reserveAuthAttempt`/`clientIpFrom` throttle. Unlimited token-guessing attempts against a stolen-or-leaked reset flow; each attempt also burns an expensive `hashPassword` call on success path setup.
      Suggested fix: Add `reserveAuthAttempt(ip)` + 429 handling mirroring `forgot-password`, keyed by IP (no user id is known pre-token).

- [ ] **[Severity: High] No rate limit on email-verification token consumption**
      File: `src/app/api/auth/verify-email/route.ts:13`
      Issue: `clientIpFrom` is imported but used only for audit logging (`:97`); no `reserveAuthAttempt` guards the `tokenHash` lookup, and success mints a full customer session (`issueCustomerSession`). Same shape as the reset-password gap.
      Suggested fix: Throttle by IP/token-hash with `reserveAuthAttempt` before the DB lookup.

- [ ] **[Severity: Medium] Negative `limit` not clamped in job listing**
      File: `src/app/api/jobs/route.ts:36`
      Issue: `Math.min(parseInt(...) || 50, 200)` passes negative values (e.g. `?limit=-5`) to `.limit(-5)`; only `offset` is clamped (`Math.max(...,0)` at `:37`). Drizzle emits `LIMIT -5` → Postgres error → 500 on crafted authenticated input.
      Suggested fix: `Math.min(Math.max(1, ...), 200)` as `src/app/api/platform/tenants/route.ts:20` already does.

- [ ] **[Severity: Medium] Negative `limit` not clamped in agent listing**
      File: `src/app/api/agents/route.ts:31`
      Issue: Same shape — `Math.min(parseInt(...) || 1000, 1000)` with no lower clamp.
      Suggested fix: Clamp `1..1000`.

- [ ] **[Severity: Medium] Negative `limit` not clamped in printer listing**
      File: `src/app/api/printers/route.ts:32`
      Issue: Same shape — `Math.min(parseInt(...) || 1000, 1000)` with no lower clamp.
      Suggested fix: Clamp `1..1000`. Consider one shared `clampListLimit()` helper for all three routes + `platform/tenants`.

- [ ] **[Severity: Medium] `PLATFORM_TENANT_ID` fail-open when unset**
      File: `src/app/api/platform/tenants/[id]/suspend/route.ts:22-29` + `docker-compose.yml:83` + `DEPLOYMENT.md:50`
      Issue: The route comment states explicitly: "When it is not configured we fail open for ordinary tenants ... while still refusing to guess which tenant is the platform one." Compose defaults `PLATFORM_TENANT_ID` to empty (`${PLATFORM_TENANT_ID:-}`) although docs call it "required in production". With it unset, the platform tenant itself loses its suspension protection silently.
      Suggested fix: Make Compose require it (`${PLATFORM_TENANT_ID:?...}`) or fail startup closed when unset in production (`NODE_ENV=production` + missing → throw at boot).

- [ ] **[Severity: Low] Discovery devices query omits `agentId` fence present on the session query**
      File: `src/app/api/agents/[id]/discovery/[discoveryId]/route.ts:15-17`
      Issue: The session lookup fences on `id + agentId + tenantId`, but the devices lookup filters only `discoveryId + tenantId`. Same-tenant managers with `agents.read` can already enumerate agents, so this is defense-in-depth rather than a privilege escalation — but a device row whose `agentId` FK disagrees with its session's agent would leak across the `:id` boundary.
      Suggested fix: Add `eq(discoveredDevices.agentId, agentId)` to the devices predicate.

- [ ] **[Severity: Low] Wrong status for unauthenticated settings access**
      File: `src/app/api/settings/route.ts:11,22`
      Issue: `!claims?.userId` returns `403 Forbidden`; the repo convention (e.g. `onboarding/route.ts:11,31`) is `401 Unauthorized` for missing auth, `403` for permission failure. `403` misleads legacy-token holders into debugging permissions instead of re-authenticating.
      Suggested fix: Return 401 when there are no claims, 403 only when permission check fails.

- [ ] **[Severity: Low] Inconsistent `Forbidden` response shape**
      Files: `src/app/api/odoo/keys/route.ts:35,70`, `src/app/api/agents/[id]/route.ts:37`
      Issue: `GET` returns bare `{error}` while `POST` returns `{error, code: FORBIDDEN, ...}` via `ActionError` for the same authorization failure.
      Suggested fix: Standardize one shape (prefer the coded shape).

- [ ] **[Severity: Low] Inconsistent auth-failure shape on session probe**
      File: `src/app/api/auth/me/route.ts:1`
      Issue: Returns `{authenticated: false}` 401 while every other route returns `{error: string}`. Breaks shared client error handling (likely a deliberate probe shape — if kept, document it as intentional).
      Suggested fix: Return `{error: "Unauthorized"}` or add a comment declaring the probe shape deliberate.

- [ ] **[Severity: Low] Dead imports in agent jobs route**
      File: `src/app/api/agent/jobs/route.ts:17-18`
      Issue: `getCorrelationContext`, `generateAttemptId`, `databaseNowMs` are imported but never referenced (only `recordJobEvent`, `refreshClockSkew` are used).
      Suggested fix: Delete the unused imports.

- [ ] **[Severity: Low] Dead import in print jobs route**
      File: `src/app/api/print/jobs/route.ts:10`
      Issue: `refreshClockSkew` imported but never called (only `databaseNowMs` at `:167` is used).
      Suggested fix: Delete the unused import.

- [ ] **[Severity: Low] Dead import in printer certify route**
      File: `src/app/api/printers/[id]/certify/route.ts:8`
      Issue: `nanoid` imported but never used (IDs come from `createPrintJobForPrinter`).
      Suggested fix: Delete the unused import.

- [ ] **[Severity: Low] Wrong status for webhook signature failure**
      File: `src/app/api/billing/webhook/route.ts:67`
      Issue: Bad `stripe-signature` returns `400`; a signature failure is an authentication failure → `401` is semantically correct.
      Suggested fix: Return 401 for invalid signature (keep 400 for malformed JSON/event).

- [ ] **[Severity: Low] Wrong status for consumed selection token**
      File: `src/app/api/auth/select-tenant/route.ts:100`
      Issue: `Selection token already used` returns `401`; single-use-token replay is a client-state conflict → `409` (as `agent/register:189` does for consumed codes).
      Suggested fix: Return 409.

- [ ] **[Severity: Low] No body limit or rate limit on invitation accept**
      File: `src/app/api/team/invitations/accept/route.ts:8`
      Issue: No `hasBodyOverLimit`, no `reserveAuthAttempt` on the `tokenHash` lookup. Token entropy (256-char) makes enumeration infeasible and `email` must also match (`:18`), so this is a consistency/hardening item, not an exploitable gap.
      Suggested fix: Add `hasBodyOverLimit(req, 16*1024)` + IP throttle for consistency with the other token-consuming routes.

---

## 2. Gateway Lib/Services (`src/lib/**`, `src/server/**` — every file read)

- [x] **[Severity: High] Unvalidated `MAINTENANCE_SWEEP_LIMIT` produces `LIMIT NaN` SQL**
      File: `src/lib/job-maintenance.ts:19`
      Fix applied: commit `6638efc4` — finite-positive guard with fallback to 200.

- [ ] **[Severity: High] System health overall permanently `unknown` due to hardcoded external checks**
      File: `src/lib/system-health.ts:157,176-178` + `computeOverall` external branch
      Issue: `getSystemHealth` hardcodes `odoo`/`billing` as `unknown` ("NOT VERIFIED"), and `computeOverall` forces overall `unknown` when any external check is `unknown`. The endpoint can never report better than `unknown`, which also contradicts the Docker smoke expectation of `warn`-when-degraded. A real Odoo probe target exists (`src/app/api/odoo/health/`).
      Suggested fix: Either probe Odoo health (and Stripe reachability when configured) for real, or change policy so intentionally-unverified externals cap overall at `warn` instead of `unknown`, documenting the policy. Externally visible behavior change — note in commit + PATCH_LOG.

- [x] **[Severity: Low] Inconsistent logger: `console.warn` instead of application logger**
      File: `src/lib/auth-rate-limit.ts:50`
      Fix applied: commit `6638efc4` — uses `logWarn` from `log.ts`.

- [x] **[Severity: Low] Package version from `process.env.npm_package_version` may be `undefined`**
      File: `src/lib/system-health.ts:193`
      Fix applied: commit `6638efc4` — falls back to `"1.0.0"`.

- [ ] **[Severity: Medium] `console.error` bypasses structured logger in billing operations**
      File: `src/lib/billing-operation.ts:202,209,267`
      Issue: Three raw `console.error` calls (Stripe rejection, failure, finalization) lose correlation IDs and log-redaction handling.
      Suggested fix: Use `logError` from `./log` with a static event name + fields.

- [ ] **[Severity: Low] `console.error` in WebSocket upgrade error path**
      File: `src/server/ws.ts:343`
      Issue: `logUpgradeError` uses raw `console.error`, bypassing the structured logger.
      Suggested fix: `logError("ws.upgrade_failed", { error: message })`.

- [ ] **[Severity: Medium] Dashboard jobs failure swallowed with no UI error**
      File: `src/app/dashboard/dashboard-client.tsx:459`
      Issue: The `catch` only `console.error`s, leaving a stale job list displayed with no error state; operators cannot distinguish "no jobs" from "query failed".
      Suggested fix: Surface via an error message state.

- [ ] **[Severity: Low] Raw `Error` objects in log fields + bracket event names**
      Files: `src/app/billing/page.tsx:109`, `src/app/dashboard/page.tsx:114`
      Issue: `{ error }` passes a live `Error` (`JSON.stringify(Error)` → `{}`), losing the message; `"[dashboard] database load failed"` uses brackets instead of the dotted event convention (`billing.print_usage_unavailable` at billing/page is already correct).
      Suggested fix: `{ error: error instanceof Error ? error.message : String(error) }`, event `dashboard.database_load_failed`.

- [ ] **[Severity: Low] Dynamic log event names break aggregation**
      File: `src/server/ws.ts:493,676,750`
      Issue: Interpolating `agentId`/`jobId`/delay into the event string (`[ws] job send to agent ${agentId} ...`) creates unbounded event cardinality.
      Suggested fix: Static event names with IDs in fields, e.g. `logWarn("ws.job_send_ambiguous", { agentId, ... })`.

- [ ] **[Severity: Low] Dead exports in session tokens (zero repo-wide callers)**
      File: `src/lib/session-tokens.ts:203,538,807,811`
      Issue: `verifyAccessToken` (only the signature-only variant at `:193` is used), `sessionKindFromClaims`, `getRefreshCookieName`, `getAccessCookieName` have no callers anywhere in `src/`, `tests/`, or `scripts/` (verified by grep).
      Suggested fix: Delete, or wire callers if they are intended public API.

- [ ] **[Severity: Low] Dead exports in request guard**
      File: `src/server/request-guard.ts:231,235`
      Issue: `getReservedAuthBytes`/`getReservedUnauthBytes` have no callers; only `getReservedRequestBytes` is used.
      Suggested fix: Delete.

- [ ] **[Severity: Low] Dead publish helpers in WebSocket server**
      File: `src/server/ws.ts:286,295`
      Issue: `publishAgentSessionClose`/`publishTenantSessionClose` have no callers; session-close paths use raw `pg_notify` SQL instead (two implementations of one concept).
      Suggested fix: Delete the helpers or route the raw-SQL callers through them (preferred: single implementation).

- [ ] **[Severity: Low] Dead WS lock + lifecycle helpers**
      Files: `src/lib/ws-rate-limit.ts:28`, `src/lib/lifecycle.ts:6,18`
      Issue: `isWsUpgradeLocallyLocked` has no callers; `assertLifecycleTransition` (and `isLifecycle`, used only by it) has no callers.
      Suggested fix: Delete.

- [ ] **[Severity: Low] `requireActiveTenant` falls through on unexpected lifecycle**
      File: `src/lib/tenant-guard.ts:92-100`
      Issue: Any value other than `suspended`/`deleted` is returned as valid, while the transactional twin `requireActiveTenantInTransaction` (`:46-48`) throws on anything `!== "active"`. In practice the DB `CHECK (tenants_lifecycle_check)` constrains values to `active/suspended/deleted`, so this is defense-in-depth inconsistency, not a live bypass.
      Suggested fix: `if (lifecycle !== "active") throw new TenantDeletedError(tenantId)` to mirror the transactional guard.

- [ ] **[Severity: Medium] Future timestamps treated as fresh in agent health**
      File: `src/lib/agent-health.ts:53-65` vs `src/lib/agent-availability.ts:47-48`, `src/lib/printer-health.ts:58-64`
      Issue: `computeAgentHealthStatus` checks `age <= ONLINE_THRESHOLD_MS` with no `age >= 0` lower bound, so a future `lastSeenAt` (clock skew, bad write) reports `ONLINE`. The availability gate and printer health both reject `age < 0`.
      Suggested fix: Add `ageMs >= 0` guards.

- [ ] **[Severity: Medium] Stale-threshold quadruplication (env ignored by 3 of 4)**
      Files: `src/lib/printer-health.ts:56`, `src/lib/agent-health.ts:49`, `src/shared/job-vocabulary.ts:130` vs `src/lib/agent-availability.ts:3-10`
      Issue: `90s` is hardcoded in three places while only the gateway enforcement gates honor `STALE_AGENT_THRESHOLD_SECONDS`. Setting the env diverges UI/health displays from actual claim-gate enforcement.
      Suggested fix: Single shared helper; health/UI import `agentStaleThresholdSeconds()` (same consolidation already done for metrics/heartbeat in the Phase-2 pass).

- [ ] **[Severity: Low] `parseDbTimeMs` triplicated**
      Files: `src/lib/auth-rate-limit.ts:33`, `src/lib/ws-rate-limit.ts:13`, `src/lib/job-status.ts:167`
      Issue: Identical naive-UTC normalizer in three files; will drift (same bug class as the device-class enum drift).
      Suggested fix: One shared util in `lib/` (keep `parseEntitlementDate` in `entitlements.ts:299` separate — it is intentionally distinct).

- [ ] **[Severity: Low] Access TTL literal duplicated instead of constant**
      Files: `src/lib/manager-auth.ts:129`, `src/lib/platform-auth.ts:148` vs `src/lib/session-tokens.ts:43`
      Issue: `claims.exp - claims.iat !== 15 * 60` hardcodes what `ACCESS_TOKEN_TTL_SECONDS` already defines (and `:156` uses the constant).
      Suggested fix: Import the constant.

- [ ] **[Severity: Low] `managerGatewayHeaders()` dead stub**
      File: `src/desktop/lib/ipc.ts:363`
      Issue: Always returns `{}` yet every `fetchGateway*` awaits and spreads it. Either auth-header injection was never implemented (relying on cookies — then delete the stub) or it is a future seam (then document it).
      Suggested fix: Delete or document with a comment explaining the cookie-based auth.

- [ ] **[Severity: Low] Unescaped `LIKE` wildcards in job search**
      File: `src/app/actions.ts:371`
      Issue: `%${search}%` is parameterized but `%`/`_`/`\` in user input stay active, while `print-job-service.ts:158` carefully escapes reprint `LIKE`.
      Suggested fix: Escape `\%\_` with `ESCAPE '\\'`.

- [ ] **[Severity: Low] CORS allowlist omits headers the app uses**
      File: `src/server/cors.ts:5`
      Issue: `ALLOWED_HEADERS` lacks `Idempotency-Key` (sent at `dashboard-client.tsx:267`), `X-Refresh-Token` (read at `session-tokens.ts:510`), `X-Request-Id`. Currently low-impact (same-origin dashboard needs no preflight; desktop stub sends no custom headers) but will break browser/preview clients that send them.
      Suggested fix: Extend `ALLOWED_HEADERS`.

- [ ] **[Severity: Low] `humanType` reads `printer_type` as a device class**
      File: `src/desktop/lib/printers.ts:79-87`
      Issue: Gateway `printerType` is `physical/virtual/redirected`; `thermal/label/laser` live in `device_class`. The `thermal/label/laser/inkjet` branches are dead code that misleads readers.
      Suggested fix: Read `device_class`/`deviceClass`.

- [ ] **[Severity: Low] `load()` duplicates the `useEffect` fetch block**
      File: `src/app/team/page.tsx:44-96`
      Issue: `load()` and the mount `useEffect` contain the same fetch block verbatim.
      Suggested fix: `useEffect` calls `load()`.

---

## 3. Gateway DB Layer (`src/db/schema.ts`, `drizzle/` — 74 migrations `0000`–`0073`)

- [ ] **[Severity: High] `printers`, `discoveredDevices` (and `discoverySessions`) lack PRIMARY KEY constraints**
      File: `src/db/schema.ts:143,304` (+ `discoverySessions`)
      Issue: `id: text("id").notNull()` with only `UNIQUE (tenant_id, id)` since migration `0072` dropped the original PKs for tenant-scoped identity. No formal PK hurts ORM/replication/tooling expectations. (`printJobs` still declares `id.primaryKey()` — itself inconsistent.)
      Suggested fix: Add composite PKs `primaryKey({ columns: [tenantId, id] })` + a forward migration. Requires care: existing duplicate `(tenant_id,id)` rows would block it (the UNIQUE constraint already prevents that, so creation is safe).

- [ ] **[Severity: Medium] Composite foreign key names in schema.ts don't match migration-hardcoded names**
      File: `src/db/schema.ts:165,294,338-340,379-381` vs `drizzle/0041_*.sql:161-266`
      Issue: Migration `0041` hardcodes names like `printers_tenant_id_agent_id_agents_fk`, but schema `foreignKey()` declarations specify no `name`, so Drizzle-kit diffs will try to drop/recreate the constraints.
      Suggested fix: Add matching `name` properties to the composite `foreignKey` declarations.

- [ ] **[Severity: Low] Unused `applications` table (dead code)**
      File: `src/db/schema.ts:103`
      Issue: Defined but never queried/inserted/referenced anywhere in `src/` (verified by grep — only `schema.ts` mentions it).
      Suggested fix: Remove the export + a `DROP TABLE` migration.

- [ ] **[Severity: Low] Missing `onDelete: "cascade"` on ephemeral token tables**
      File: `src/db/schema.ts:218,230,243`
      Issue: `emailVerificationTokens`, `passwordResetTokens`, `tenantInvitations` reference `users`/`tenants` without cascade; blocks future hard-delete flows and risks orphans.
      Suggested fix: Add `{ onDelete: "cascade" }` + migration.

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

- [ ] **[Severity: Medium] Desktop overview badge invents language from device class**
      File: `src/desktop/pages/Overview.tsx:54-59` vs `src/lib/printer-capability.ts:61-68`
      Issue: `thermal→"ESC/POS"`, `label→"ZPL / TSPL"`, `laser→"Spooler"` badges are derived from device class, contradicting the documented rule ("device class must never invent a language: a `laser` printer declared `raw` cannot be sent PDF").
      Suggested fix: Use `getPrinterLanguageBadges(protocol, connectionType)`.

- [ ] **[Severity: Medium] Stale agent cache + weaker network validation in AddPrinterDialog**
      File: `src/desktop/components/AddPrinterDialog.tsx:48-58,87-92` vs `EditPrinterDialog.tsx:121-129`
      Issue: `agents.length > 0` short-circuits `loadAgents`, keeping gateway A's agents after switching to gateway B; host validation is non-empty/no-space only (no private-IP check) and port must be exactly `9100`, rejecting valid network-IPP `80/443/631` that `EditPrinterDialog` and the gateway accept.
      Suggested fix: Key the agent cache by `gatewayUrl`; reuse the `EditPrinterDialog` host/port validation logic.

- [ ] **[Severity: Medium] System-health / release-readiness pages use manager-only auth**
      Files: `src/app/system-health/page.tsx:10`, `src/app/release-readiness/page.tsx:10` vs `src/app/dashboard/page.tsx:17`, `src/app/billing/page.tsx:80`
      Issue: These pages use `verifyManagerToken` while dashboard/billing use `verifyWorkspaceTokenFromCookieValues`, bouncing valid customer sessions to `/login` instead of permission-checking.
      Suggested fix: Use the workspace verifier + explicit permission/role check.

- [ ] **[Severity: Low] Printer taxonomy validated in four places + desktop narrowing**
      Files: `src/lib/printer-capability.ts:6-9,28-47`, `src/lib/printer-model.ts:4-8`, `src/lib/routing.ts:12` (`BYTE_PROTOCOLS`), `src/lib/discovery.ts:5-11` (superset incl. `mdns/lpr/snmp/wsd/subnet/config/registry`); `AddPrinterDialog.tsx:316-324` narrows network to `raw/escpos` while the gateway accepts `zpl/tspl/ipp` (`printer-model.ts:194-195`).
      Issue: Same bug class as the device-class drift — four independent taxonomies plus a narrower desktop subset.
      Suggested fix: Single canonical enum module; desktop imports the gateway sets.

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

- [ ] **[Severity: High] `BeginPrint` clears the claim-token fence on tokenless redelivery**
      File: `agent/internal/queue/queue.go:284-290`
      Issue: `updateToken = nil` when `claimToken == ""` overwrites a stored `claim_token` with `NULL`, destroying the execution fence/outbox evidence. Reachable whenever a job row carries a token (pushed with one) and `BeginPrint` is later called with `""` — made more likely by `01745fea` permitting empty `claimToken` in `decodeJobFields`.
      Suggested fix: Only overwrite when the incoming token is non-empty, else preserve the stored token.

- [ ] **[Severity: Medium] `RegisterManual` drops USB/capability fields**
      File: `agent/internal/agent/agent.go:596-603` vs `agent/internal/printer/printer.go:30-38`, `factory.go:72-78`
      Issue: Builds `PrinterConfig` with only `ID/Name/Type/Endpoint/Protocol/SpoolerName`; `DeviceInfo` fields `USBVID/USBPID/USBSerial/Capabilities/PaperWidthMM/Enabled` are lost, so a direct-USB printer registered manually gets `VID 0/PID 0` in `NewUSBPrinter`.
      Suggested fix: Propagate all `DeviceInfo` fields as `desiredPrinterConfig` does.

- [ ] **[Severity: Medium] `QueueDBPath` split-brain vs `RegistryPath`**
      File: `agent/internal/config/paths.go:20` vs `:8-16`
      Issue: `RegistryPath` falls back to `ExecutableDir` when the config dir is `""`/`.`, but `QueueDBPath` joins directly — a bare config filename puts the registry in the exe dir and the queue in the CWD.
      Suggested fix: Apply the same `ExecutableDir` fallback.

- [ ] **[Severity: Medium] `classifySpoolerPrinter` returns `connectionType="local"` for LPT/COM**
      File: `agent/internal/printer/classify.go:109` vs `factory.go:93`, `config.go:410`
      Issue: LPT/COM ports classify as `"local"`, but `New`/`Validate` only accept `network/usb/spooler/ipp/ipps` — LPT-attached printers always fail construction.
      Suggested fix: Map `local` to `spooler`.

- [ ] **[Severity: Medium] Registration HTTP client follows redirects**
      File: `agent/internal/agent/pairing.go:65` vs `ipp.go:199`, `src-tauri/src/commands.rs:421`
      Issue: `&http.Client{Timeout: 15s}` uses the default redirect policy, which can resend the `pairingCode` body to a 3xx target; the IPP client and the Rust client both disable redirects (`ErrUseLastResponse` / `Policy::none()`).
      Suggested fix: Set `CheckRedirect` to `http.ErrUseLastResponse`.

- [ ] **[Severity: Medium] Non-string peripherals silently ignored**
      File: `agent/internal/payload/payload.go:151-165`
      Issue: `if d, ok := periphMap["drawer"].(string); ok` skips present-but-non-string `drawer/cutter/buzzer` values (numbers/bools), while Gateway `payload.ts:15` (`z.enum`) rejects them — the agent would print without the requested drawer kick instead of erroring.
      Suggested fix: Error on present-but-non-string peripheral values.

- [ ] **[Severity: Medium] `UpsertRegistry` lossy replace**
      File: `agent/internal/printer/registry.go:227` vs `discovery.go:mergeDeviceInfo`
      Issue: `existing[idx] = d` overwrites the whole row, losing previously observed `capabilities/serial`; the discovery path merges instead.
      Suggested fix: `existing[idx] = mergeDeviceInfo(existing[idx], d)`.

- [ ] **[Severity: Low] `discoverFromConfig` hardcodes `PrinterType: "unknown"`**
      File: `agent/internal/printer/discovery.go:702`
      Issue: Discards `pc.PrinterType`; heartbeat (`agent.go:1876`) reports the true class while CLI/discover shows `unknown`.
      Suggested fix: Propagate `pc.PrinterType` (normalized).

- [ ] **[Severity: Low] Agent-console allowlist drift (Rust vs Go CLI)**
      File: `src-tauri/src/commands.rs:539` vs `agent/cmd/cli/gateway.go:22`
      Issue: Rust allows exact `GET /api/agents` only; the Go CLI regex also allows `/api/agents/<id>`. Both are read-only, so this is a consistency gap, not a privilege gap.
      Suggested fix: Mirror the single-agent pattern in Rust or restrict the Go CLI — document whichever is deliberate.

- [ ] **[Severity: Low] `discovered_via` taxonomy drift (metadata only)**
      Files: `agent/internal/printer/network_discovery.go:194` (`"tcp_port_scan"`), `ipp_discovery.go:195` (`"ipp_tcp_scan"`) vs `src/lib/discovery.ts:5` (`DISCOVERY_SOURCES`)
      Issue: Values live inside the free-form `capabilities` map (not the validated `source` array), so nothing rejects them — but they are outside the canonical taxonomy.
      Suggested fix: Emit `raw`/`ipp` or add the scan values to the Gateway enum.

- [ ] **[Severity: Low] Dead `DiscoveryCandidate` type + `Source*` constants**
      File: `agent/internal/printer/discovery_extended.go:19-39`
      Issue: Zero callers (verified by grep); the actual code hardcodes `"tcp_port_scan"` etc. instead of using them.
      Suggested fix: Delete, or use the constants at the emission sites (preferred — fixes the drift above too).

- [ ] **[Severity: Low] Dead `NormalizedConnectionTypeStrict`**
      File: `agent/internal/config/config.go:364`
      Issue: Zero callers (verified by grep).
      Suggested fix: Delete.

- [ ] **[Severity: Low] Insecure transient directory permissions**
      File: `agent/internal/config/config.go:148,186` vs `storage/secure.go:77`, `printer/registry.go:137`, `queue.go:50`
      Issue: `MkdirAll(dir, 0755)` before `EnsureSecureDirectoryACL` (0700/SDDL) leaves a world-readable window; every other secrets path uses `0700` directly.
      Suggested fix: `MkdirAll(dir, 0700)`.

- [ ] **[Severity: Low] Fixed `.tmp` filename collision on concurrent save**
      File: `agent/internal/storage/secure.go:107` (+ `config.go:206`) vs `registry.go:147`, `desired_state.go:185`
      Issue: `tmp := p + ".tmp"` collides under concurrent `SaveSecret`/`Save`; the registry/desired-state paths use `os.CreateTemp` (unique).
      Suggested fix: `os.CreateTemp` + rename.

---

## 6. Desktop Shell (Tauri) (`src-tauri/src/**` — every file read)

- [x] **[Severity: Medium] `control_service` duplicated Windows/non-Windows blocks**
      File: `src-tauri/src/agent.rs:727-783`
      Fix applied: commit `222e8c6d` — common code extracted, `creation_flags` conditional.

- [ ] **[Severity: Low] Logging timestamp uses Unix epoch instead of ISO 8601**
      File: `src-tauri/src/logging.rs:101-105`
      Issue: `timestamp()` formats `epoch_secs.millis`; hard for operators to read. No `chrono`/`time` dependency is available offline, so this needs either a new dep (lockfile must be regenerated where network exists — CI) or a small std-only UTC civil-date conversion.
      Suggested fix: Emit ISO 8601 UTC (preferred) with a unit test pinning the format.

- [ ] **[Severity: Low] `read_background_record` aborts whole record on one malformed line**
      File: `src-tauri/src/agent.rs:281`
      Issue: `let (k, v) = line.split_once('=')?` inside an `Option`-returning function drops the entire background record (→ agent looks unmanaged) on a single bad line.
      Suggested fix: `let Some((k, v)) = ... else continue`.

- [ ] **[Severity: Low] Unreachable header filter in desktop gateway proxy**
      File: `src-tauri/src/commands.rs:427-429` vs `:371-385`
      Issue: `host`/`cookie` already `return Err` in the first filter, so the later `if host||cookie continue` never executes.
      Suggested fix: Delete the second check.

---

## 7. Odoo Addon (`odoo_addons/**` — every Python and JS file read)

- [ ] **[Severity: High] `Environment` instance called as function — non-standard pattern**
      File: `odoo_addons/print_gateway/models/print_intent.py:186`
      Issue: `new_env(context=dict(new_env.context, allowed_company_ids=[...]))` relies on `Environment.__call__`; the standard, version-stable pattern is `with_context()`. A nearby comment even claims `with_company` semantics that don't exist. Behavior today is equivalent, but `__call__` is not the documented API surface.
      Suggested fix: `new_env = new_env.with_context(allowed_company_ids=[record_company.id])`.

- [x] **[Severity: High] AbstractModel passed as `res_ids` to `_render_qweb_pdf`**
      File: `odoo_addons/print_gateway/controllers/pos.py:20`, `models/print_router.py:234`
      Fix applied: commit `0d819b15` — `res_ids` now passes real IDs (`render_target.ids`) or `False`, with `data=`.

- [x] **[Severity: Medium] Missing `expired` status in Odoo job status Selection**
      File: `odoo_addons/print_gateway/models/print_job.py:50-55`
      Resolution: commit `0d819b15` — Gateway `expired` is now explicitly mapped (`:1350-1365` expired→unknown/failed with reason; `:1579` sync handling) and the intentional Selection difference is documented in the header comment (`:39-52`). Deliberate, documented, tested — closed.

- [ ] **[Severity: Medium] Bare `crypto.randomUUID()` breaks on insecure HTTP LAN**
      File: `odoo_addons/print_gateway/static/src/js/pos_print_router.js:181,385,472`
      Issue: Kitchen/reprint operation IDs call `crypto.randomUUID()` with no fallback; it is `undefined` in non-secure contexts (plain-HTTP LAN, which the repo otherwise tolerates) → throws and aborts `printChanges`.
      Suggested fix: `crypto.randomUUID?.() ?? fallbackUuid()` helper (RFC-4122 v4 via `getRandomValues`, with `Math.random` last resort).

- [ ] **[Severity: Medium] Printer filter falls back to full list, re-offering rejected classes**
      File: `odoo_addons/print_gateway/static/src/components/runtime_printer_field.js:83-88` vs `models/binding.py:366-369`
      Issue: When the thermal filter yields empty, the widget returns the full printer list — re-offering laser/inkjet for POS destinations the server will reject.
      Suggested fix: Return `[]` with an empty-message instead of the unfiltered fallback.

- [ ] **[Severity: Medium] Odoo explicit gate over-restricts `image` vs Gateway + own failover**
      File: `odoo_addons/print_gateway/models/binding.py:554` vs `src/lib/routing.ts:100-107`, `models/print_job.py:1041-1042`
      Issue: `resolve_explicit` requires `spooler/ipp/ipps` for both `pdf` and `raster_jpeg`, but Gateway `physicalImage` allows `spooler` or `network+escpos`, and Odoo's own failover path allows `spooler/escpos` for raster. Valid ESC/POS kitchen image jobs are rejected when explicitly bound.
      Suggested fix: Allow `escpos` for `image`/`raster_jpeg` in `resolve_explicit`, mirroring `routing.ts`.

- [ ] **[Severity: Low] Two Sale-Details paths resolve different destinations**
      File: `odoo_addons/print_gateway/controllers/pos.py:21-27` vs `models/print_router.py:505-509`
      Issue: HTTP `/pos/sale_details_report` resolves destination from the report action; `action_print_gateway_sale_details` resolves `explicit_destination=session.config_id`. The same logical report needs two bindings.
      Suggested fix: Document the dual-binding requirement or pass the POS config through the controller path.

- [ ] **[Severity: Low] Config permanently undeletable after first job**
      File: `odoo_addons/print_gateway/security/ir.model.access.csv:8` + `models/gateway_config.py:1415-1422`
      Issue: Admin `print_job` has `perm_unlink=0` (jobs immortal) and `unlink()` blocks config delete while any job references it — after the first print, the config can never be deleted.
      Suggested fix: Document the archival-only lifecycle or allow admin job purge.

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
      Resolution: commit `0d819b15` — the mapping table is now documented in the model header comment (`:39-52`) with explicit transition enforcement (`_VALID_TRANSITIONS`). Deliberate, documented — closed.

- [ ] **[Severity: Low] Odoo payload type nomenclature differs from shared contract**
      File: `odoo_addons/print_gateway/models/print_job.py:67-71` vs `contracts/print-payload-contract.json:5`
      Issue: Contract wire types are `raw/escpos/pdf/image`; Odoo selections are `pdf/raster_jpeg/raw_cmd` with an internal mapping dict. Works, but naming drift invites the next enum-drift bug.
      Suggested fix: Rename Odoo selections to the wire names (migration-heavy — likely BLOCKED on Odoo data migration; at minimum document the mapping next to the Selection).

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

- [ ] **[Severity: Medium] PRINTERS.md test-print section claims ESC/POS-only**
      File: `PRINTERS.md:229-233` vs `src/lib/payload.ts:176-268`, `models/print_router.py:759-824`, and `PRINTERS.md` §10 itself
      Issue: §9 says test-print uses "an ESC/POS test payload"; the code builds per-protocol zpl/tspl/raw/pdf tickets, and §10 ("build a test ticket in the language the printer actually speaks") contradicts §9.
      Suggested fix: Document the per-protocol selection in §9.

- [ ] **[Severity: Low] PRINTERS.md "tries next binding on 422" is unsupported**
      File: `PRINTERS.md:53-54` vs `src/lib/print-job-service.ts` (only defines the `CAPABILITY_MISMATCH` code; no next-binding retry) and `models/print_job.py:1320-1340` (Odoo terminalizes 400/403/404/409/422 as `failed`)
      Issue: No routing layer retries the next binding after `CAPABILITY_MISMATCH`; Odoo-side 422 is terminal.
      Suggested fix: Correct to "422 is terminal; fix the binding" or implement next-binding retry (behavior change).

- [ ] **[Severity: Medium] DEPLOYMENT.md `npm ci --production` before build is broken**
      File: `DEPLOYMENT.md:65` vs `Dockerfile:8-12`
      Issue: Instructs `npm ci --production` then `npm run build`, but the build needs devDependencies; the Dockerfile correctly uses full `npm ci` for build and `--omit=dev` only for runtime.
      Suggested fix: `npm ci` before build.

- [ ] **[Severity: Low] DEPLOYMENT.md Caddy example uses env var, repo uses secret file**
      File: `DEPLOYMENT.md:76-81` vs `Caddyfile:13`, `docker-compose.yml:73,82`
      Issue: Example shows `header_up X-Gateway-Proxy-Token {$TRUST_PROXY_SECRET}`; the real config reads `{file./run/secrets/trust_proxy_secret}`.
      Suggested fix: Align the example with the secret-file pattern.

- [ ] **[Severity: Low] README entitlement list omits `max_prints_per_period`**
      File: `README.md:50` vs `odoo_addons/print_gateway/models/print_job.py:1214-1220`, `static/src/js/gateway_limit_dialog.js:7-13`
      Issue: Lists 4 entitlements; the code enforces 5.
      Suggested fix: Add the fifth entitlement.

- [ ] **[Severity: Low] ODOO_INTEGRATION.md lists `print_gateway.crypto` as a model**
      File: `ODOO_INTEGRATION.md:37` vs `odoo_addons/print_gateway/models/crypto.py:1-164`, `models/gateway_config.py:1971`
      Issue: `crypto.py` defines only AES-GCM helpers, no `models.Model`; the real `print_gateway.pair_agent_wizard` is omitted.
      Suggested fix: Relabel crypto as a utility module; list the wizard.

- [ ] **[Severity: Low] ODOO_INTEGRATION.md policy snippet contradicts branch scope**
      File: `ODOO_INTEGRATION.md:106-112` vs `models/print_policy.py:290-303`
      Issue: Snippet filters `("company_id","=",order.company_id.id)`; the code searches the root company + `branch_id in [False, branch]`. The snippet misses branch-company orders.
      Suggested fix: Update the snippet to the root+branch logic.

- [ ] **[Severity: Low] ADR-001 states stale Next.js version**
      File: `ADR.md:12` vs `package.json:41`, `ARCHITECTURE.md:40`
      Issue: Says Next.js 16.3.4; pinned is 16.3.6.
      Suggested fix: Update to 16.3.6.

- Reviewed, no finding: `ARCHITECTURE.md:51` route count — a sweep report claimed 75, but `find src/app/api -name route.ts | wc -l` returns **76**, matching the doc. The sweep undercounted; the doc is correct.

---

## 10. CI/CD (`.github/workflows/**` — every workflow read)

- [x] **[Severity: High] `pip install pytest` fails on ubuntu-latest (PEP 668)**
      File: `.github/workflows/ci.yml:144`
      Fix applied: commit `71403d34` — `--break-system-packages` flag added.

- [ ] **[Severity: Critical] CI is RED on `main` — Go dispatch suite + Odoo suite failing**
      Runs: CI `36272613988` (failure), Build Windows Installer `36272614002` (failure) on `01745fea`.
      Issue: (a) ~20 Go `agent/internal/agent` dispatch tests fail in `Agent Phase 0 - Go race tests` (`TestPerPrinterSerialization`, `TestSameJobID*`, `TestDispatch*`, `TestKeepAliveEchoesClaimTokens`, `TestPollJobsDispatchesBoundedBatch`, `TestPanicAfterLocalAdmissionIsPersistedAsUnknown`, `TestPhysicalSuccessWithTerminalLedgerWriteFailureCannotReprint`, …). The suite passed at `d996bad0`; the breakage window is `d996bad0..01745fea` (prime suspects: `f54b2a77` queue/agent changes, `01745fea` `decodeJobFields` relaxation). (b) Odoo `test_04b2_interactive_failover_never_deadlocks` (Connection refused surfacing) and `test_26c_submit_refuses_uncommitted_outbox_without_remote_side_effect` (`post.assert_not_called` — POST performed once) fail in the same runs; Odoo failures have been evolving since `ff40d0b2`.
      Suggested fix: Root-cause the dispatch admission regression first (likely the optional-`claimToken` relaxation interacting with the claim fence — see §5 `BeginPrint` item), then the Odoo outbox-guard regression. This item is the Part B entry gate: no finding is "done" while CI is red.

- [ ] **[Severity: Low] Unpinned pip installs, no cache**
      File: `.github/workflows/ci.yml:144`
      Issue: `pip install --break-system-packages pytest pytest-asyncio` pins no versions (unlike SHA-pinned actions, Go `cache:true`, Node `cache:npm`) — nondeterministic supply chain.
      Suggested fix: Pin versions (e.g. `pytest==x.y.z`) and/or cache pip.

- [ ] **[Severity: Low] Odoo19 job on PG15 vs prod PG16**
      File: `.github/workflows/ci.yml:339` vs `:23`, `docker-compose.yml:3`
      Issue: The `odoo19` service uses `postgres:15-alpine` while prod and main CI use PG16 — behavior drift risk in the test matrix.
      Suggested fix: Bump the Odoo19 service to `postgres:16-alpine` (digest-pinned like `:23`).

---

## 11. Config and Environment

- Reviewed in full: `.env.example`, `docker-compose.yml`, `Dockerfile`, `package.json`, `agent/go.mod`, `src-tauri/Cargo.toml`, `drizzle.config.ts`, `next.config.ts`, `server.ts`, `proxy.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.*.mts`, `Caddyfile`. No additional findings beyond §1 item `PLATFORM_TENANT_ID fail-open` (whose Compose half lives here: `docker-compose.yml:83` defaults to empty while `DEPLOYMENT.md:50` calls it required in production).
- v1 note carried forward: dependency currency is a documented residual (see PATCH_LOG Phase-1 triage), not re-reported here.

---

## Summary

| Severity | v1 count | v2 open (excl. fixed) |
|----------|----------|----------------------|
| Critical | 3 | 1 (CI-RED; the other 2 fixed) |
| High     | 9 | 6 (3 fixed, 1 carried open, +4 new: 2 auth rate-limit, BeginPrint fence, +system-health) |
| Medium   | 7 | 22 (4 fixed, rest open/new) |
| Low      | 11 | 40+ (8 fixed, rest open/new) |

Fixed in-flight (Part B, pre-v2): `1771752d` (§1×2), `6638efc4` (§2×3), `bedfab18` (§5 critical), `2e638987` (§8 critical), `f54b2a77` (§5×3 + §8 crash-reason), `2f27258a` (§4×4 + §8 StatusDot), `0d819b15` (§7 res_ids + §7/§8 expired/statuses documented), `222e8c6d` (§6 control_service), `c951c4b4` (§9 first-run), `ef26f47d` (§9×3), `71403d34` (§10 pip).
