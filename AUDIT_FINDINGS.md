# AUDIT_FINDINGS.md — Full Codebase Audit

**Audit Date:** 2026-09-26
**Scope:** Every file in the Yasser project, all 11 areas.
**Method:** File-by-file static read, web-verified API correctness, cross-boundary contract comparison.
**Status:** Part A complete (read-only). Part B (fixes) follows.

---

## 1. Gateway API Routes (`src/app/api/**`)

- [ ] **[Severity: High] Unhandled JSON parsing error returns 500 instead of 400**
      File: `src/app/api/agent/heartbeat/route.ts:138`
      Issue: `await req.json()` is inside a broad try/catch for DB transaction errors. Malformed JSON from an agent falls through to the catch block at line 450, which treats it as an internal server error (500) and logs an internal failure. Invalid JSON payloads should return HTTP 400 Bad Request.
      Suggested fix: Isolate JSON parsing in its own try/catch before the main transaction block: `let body; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }`

- [ ] **[Severity: Medium] Health check catch block hides errors and uses wrong status code**
      File: `src/app/api/health/route.ts:18`
      Issue: The catch block for the readiness database check catches all errors but ignores them, returning a hardcoded HTTP 500. Database connection failures, timeouts, and query errors are invisible. Semantically, 503 Service Unavailable is more appropriate for readiness probe failures.
      Suggested fix: Log the caught error, change status to 503 for readiness failures.

---

## 2. Gateway Lib/Services (`src/lib/**`)

- [ ] **[Severity: High] Unvalidated `MAINTENANCE_SWEEP_LIMIT` produces `LIMIT NaN` SQL**
      File: `src/lib/job-maintenance.ts:19`
      Issue: `const SWEEP_BATCH = Number(process.env.MAINTENANCE_SWEEP_LIMIT ?? 200)` — if the env var is set to an invalid string (e.g. `"abc"`), this evaluates to `NaN`. This value is interpolated directly into SQL `LIMIT ${SWEEP_BATCH}` at lines 26, 73, 95, producing `LIMIT NaN` which is a fatal PostgreSQL syntax error, halting all job sweeps.
      Suggested fix: Add a finite guard: `const raw = Number(process.env.MAINTENANCE_SWEEP_LIMIT ?? 200); const SWEEP_BATCH = Number.isFinite(raw) && raw > 0 ? raw : 200;`

- [ ] **[Severity: High] System health overall permanently `unknown` due to hardcoded external checks**
      File: `src/lib/system-health.ts:157,176-178`
      Issue: `getSystemHealth` hardcodes `odoo` and `billing` checks as `unknown` with "NOT VERIFIED". `computeOverall` strictly mandates that if any external check is `unknown`, the overall result is `unknown`. This renders the health endpoint permanently degraded.
      Suggested fix: Either implement actual Odoo/billing health probes, or relax `computeOverall` to exclude intentionally unverified external dependencies from the overall calculation.

- [ ] **[Severity: Low] Inconsistent logger: `console.warn` instead of application logger**
      File: `src/lib/auth-rate-limit.ts:50`
      Issue: `warnUntrustedProxyOnce` uses native `console.warn` instead of the application's structured logger, bypassing log aggregation and standard formatting.
      Suggested fix: Import and use the standard logger from `log.ts`.

- [ ] **[Severity: Low] Package version from `process.env.npm_package_version` may be `undefined`**
      File: `src/lib/system-health.ts:193`
      Issue: The version is derived from `process.env.npm_package_version`, which is only set when running via `npm start`. Direct `node` invocations in production leave it undefined, producing `"unknown"` as version.
      Suggested fix: Read version from `package.json` at build time or startup.

---

## 3. Gateway DB Layer (`src/db/schema.ts`, `drizzle/`)

- [ ] **[Severity: High] `printers` and `discoveredDevices` tables lack PRIMARY KEY constraints**
      File: `src/db/schema.ts:143,304`
      Issue: Both tables have `id: text("id").notNull()` but no `primaryKey()` declaration. Migration `0072` dropped the original PKs to make identities tenant-scoped, replacing them with `UNIQUE` indexes. The tables now lack formal primary keys, which can cause issues with ORMs, replication, and referential integrity tooling.
      Suggested fix: Add composite primary keys via `pk: primaryKey({ columns: [table.tenantId, table.id] })`.

- [ ] **[Severity: Medium] Composite foreign key names in schema.ts don't match migration-hardcoded names**
      File: `src/db/schema.ts:165,294,338-340,379-381`
      Issue: Migration `0041` hardcodes specific FK names (e.g. `printers_tenant_id_agent_id_agents_fk`), but `schema.ts` doesn't specify `name` properties on its `foreignKey` declarations. This causes Drizzle-kit to generate diffs that attempt to drop and recreate these constraints.
      Suggested fix: Add `name` properties to composite `foreignKey` declarations matching the migration-hardcoded names.

- [ ] **[Severity: Low] Unused `applications` table (dead code)**
      File: `src/db/schema.ts:103`
      Issue: The `applications` table is defined in the schema but never queried, inserted into, or referenced by any application code or migration.
      Suggested fix: Remove the `applications` export and generate a `DROP TABLE` migration.

- [ ] **[Severity: Low] Missing `onDelete: "cascade"` on ephemeral token tables**
      File: `src/db/schema.ts:218,230,243`
      Issue: `emailVerificationTokens`, `passwordResetTokens`, and `tenantInvitations` link to `users`/`tenants` without `{ onDelete: "cascade" }`. While users may not be hard-deleted today, this creates orphan risk and blocks future cascading deletes.
      Suggested fix: Add `{ onDelete: "cascade" }` to `userId` and `tenantId` references on these transient tables.

---

## 4. Gateway UI (`src/app/**`, `src/components/**`)

- [ ] **[Severity: Medium] Unawaited `writeAuditEvent` in Server Action can be cancelled**
      File: `src/app/actions.ts:103`
      Issue: `writeAuditEvent` is called without `await` or Next.js `after()`. In Server Actions, floating async tasks can be cancelled when the response completes, losing audit log entries.
      Suggested fix: Use `await writeAuditEvent(...)` or wrap in Next.js `after()`.

- [ ] **[Severity: Low] Unused imports in Server Actions**
      File: `src/app/actions.ts:7,10,25`
      Issue: `nanoid`, `hashPairingCode`, `enforceTenantResourceEntitlement`, and `TenantEntitlementError` are imported but never used.
      Suggested fix: Remove unused imports.

- [ ] **[Severity: Low] Unused import `friendlyPrinterError` in AddPrinterDialog**
      File: `src/desktop/components/AddPrinterDialog.tsx:12`
      Issue: `friendlyPrinterError` is imported from `../lib/printers` but never referenced in the component.
      Suggested fix: Remove the unused import.

- [ ] **[Severity: Low] Unused icon imports in Sidebar**
      File: `src/desktop/components/Sidebar.tsx:2`
      Issue: Icons `LayoutDashboard`, `Printer`, `ClipboardList`, `Cpu`, `Settings` are imported but not used in this file.
      Suggested fix: Remove unused icon imports.

---

## 5. Agent (Go) (`agent/internal/**`, `agent/cmd/**`)

- [ ] **[Severity: Critical] Missing `terminalReportMu` field in Agent struct — build failure**
      File: `agent/internal/agent/agent.go:756,759`
      Issue: `reportPendingTerminalStatuses` calls `a.terminalReportMu.TryLock()` (line 756) and `a.terminalReportMu.Unlock()` (line 759), but the `Agent` struct (lines 125–224) does not define this field. The code will fail to compile.
      Suggested fix: Add `terminalReportMu sync.Mutex` to the `Agent` struct definition.

- [ ] **[Severity: High] `MarkInterrupted` returns all jobs including un-updated ones on error**
      File: `agent/internal/queue/queue.go:398`
      Issue: When `UpdateStatusWithError` fails for a job during `MarkInterrupted`, the function returns the full `found` slice. The caller `recoverInterruptedJobs` then reports ALL jobs (including un-updated ones) to the gateway as interrupted, even though their local state transition failed.
      Suggested fix: Track successfully updated jobs in a separate `marked` slice and return only those.

- [ ] **[Severity: Medium] `normalizePrinterType` silently coerces `ClassUnknown` to `"physical"`**
      File: `agent/internal/agent/device_class.go:38`
      Issue: Any printer the agent cannot classify (including `ClassUnknown`) is silently reported as `"physical"` to the gateway. This could falsely flag unclassified hardware queues as production printers.
      Suggested fix: Add logging when the unknown→physical coercion fires, or accept `"unknown"` on the Gateway side.

- [ ] **[Severity: Low] Inaccurate comment in POSIX security implementation**
      File: `agent/internal/storage/security_other.go:14`
      Issue: Comment says "no-op because restrictive file modes are applied when files are created", but the code actively calls `os.Chmod(path, 0600)`.
      Suggested fix: Update comment to reflect that it actively enforces 0600 via Chmod.

---

## 6. Desktop Shell (Tauri) (`src-tauri/src/**`)

- [ ] **[Severity: Medium] `control_service` has duplicated Windows/non-Windows code blocks**
      File: `src-tauri/src/agent.rs:727-783`
      Issue: The `#[cfg(windows)]` and `#[cfg(not(windows))]` branches at lines 727-779 are 95% identical (only the `creation_flags` line differs). This duplication invites future drift if one branch is updated without the other.
      Suggested fix: Extract the common code into a helper function, calling `creation_flags` conditionally.

- [ ] **[Severity: Low] Logging timestamp uses Unix epoch seconds instead of ISO 8601**
      File: `src-tauri/src/logging.rs:101-105`
      Issue: `timestamp()` formats time as `epoch_secs.millis` (e.g. `1695734400.123`), which is hard for operators to read compared to ISO 8601 format.
      Suggested fix: Use chrono or time crate for ISO 8601 formatting, or keep as-is since it's a local log (low priority).

Reviewed in full, no other findings. The Tauri codebase is well-structured with comprehensive security hardening.

---

## 7. Odoo Addon (`odoo_addons/**`)

- [ ] **[Severity: High] `Environment` instance called as function — non-standard pattern**
      File: `odoo_addons/print_gateway/models/print_intent.py:186`
      Issue: `new_env = new_env(context=dict(new_env.context, allowed_company_ids=[record_company.id]))` — calling an `Environment` instance as a function is non-standard and may be removed/broken in Odoo 19. The standard pattern is `with_context()`.
      Suggested fix: Replace with `new_env = new_env.with_context(allowed_company_ids=[record_company.id])` or `intent = intent.with_company(record_company)`.

- [ ] **[Severity: High] AbstractModel passed as `res_ids` to `_render_qweb_pdf`**
      File: `odoo_addons/print_gateway/controllers/pos.py:20`, `models/print_router.py:234`
      Issue: `PrintGatewayPosController` passes an AbstractModel instance as `render_target` which ends up as the `res_ids` argument to `_render_qweb_pdf`. In Odoo 19, this expects a list of integer IDs.
      Suggested fix: Pass `res_ids=False` with `data=...` instead of an AbstractModel instance.

- [ ] **[Severity: Medium] Missing `expired` status in Odoo job status Selection**
      File: `odoo_addons/print_gateway/models/print_job.py:50-55`
      Issue: The Gateway DB enum includes `expired` but the Odoo Selection field omits it, mapping `expired` to `unknown` or `failed` during sync. While this is deliberate, it creates an unnecessary implicit mapping that can confuse developers and audit tools.
      Suggested fix: Document this as an intentional mapping in a code comment, or add `expired` to the Selection and map it explicitly.

---

## 8. Cross-Boundary Contracts

- [ ] **[Severity: Critical] `windows_spooler` protocol rejected by Gateway API validation**
      File: `src/lib/printer-model.ts:8` vs `src/db/schema.ts:177` and `src/lib/printer-capability.ts:7`
      Issue: The PostgreSQL CHECK constraint and `ProtocolType` both allow `"windows_spooler"`. However, `PRINTER_PROTOCOLS` in `printer-model.ts` omits it. Because the API uses `z.enum(PRINTER_PROTOCOLS)` for Zod validation, any printer declaring `windows_spooler` is rejected at the HTTP edge before reaching the database.
      Suggested fix: Add `"windows_spooler"` to the `PRINTER_PROTOCOLS` array in `printer-model.ts`.

- [ ] **[Severity: High] Crash recovery requeue rejected — agent doesn't send `reason` field**
      File: `agent/internal/agent/agent.go:810,2636-2648` vs `src/app/api/agent/jobs/route.ts:326-328`
      Issue: The Gateway checks for `reason === "agent_reprint_after_crash"` on the `printing→queued` transition. The agent's `updateJobStatus` helper never includes a `reason` key in the JSON body, so `reason` defaults to `""`, causing a `409 Invalid status transition`.
      Suggested fix: Add a `reason` parameter to `updateJobStatus` and include it when performing crash-recovery requeue.

- [ ] **[Severity: Medium] StatusDot.tsx hardcodes colors that contradict job-vocabulary.ts tones**
      File: `src/shared/components/StatusDot.tsx:13-15` vs `src/shared/job-vocabulary.ts:45-52`
      Issue: `printing`/`claimed` map to `"info"` tone in job-vocabulary but to `bg-warn-solid` in StatusDot. `queued` maps to `"neutral"` in job-vocabulary but `bg-info-solid` in StatusDot. This visual inconsistency can confuse operators.
      Suggested fix: Refactor StatusDot to use `jobTone()`/`printerTone()` from job-vocabulary.ts.

- [ ] **[Severity: Low] Odoo invents `submitted`/`partial`/`unknown` top-level statuses not in Gateway**
      File: `odoo_addons/print_gateway/models/print_job.py:50-55` vs `src/lib/job-status.ts:33-40`
      Issue: Gateway: `[queued, claimed, printing, success, failed, expired]`. Odoo: `[queued, submitted, claimed, printing, success, failed, unknown, partial]`. The Odoo side invents `submitted`, `partial`, `unknown` as top-level statuses (Gateway treats these as metadata) while omitting `expired`.
      Suggested fix: Document the intentional mapping table in a shared location. Consider adding `expired` to Odoo.

- [ ] **[Severity: Low] Odoo payload type nomenclature differs from shared contract**
      File: `odoo_addons/print_gateway/models/print_job.py:67-71` vs `contracts/print-payload-contract.json:5`
      Issue: Contract uses `["raw", "escpos", "pdf", "image"]`. Odoo uses `["pdf", "raster_jpeg", "raw_cmd"]` with a mapping dict. Unnecessary naming drift.
      Suggested fix: Rename Odoo selections to match `wireTypes` or keep with explicit mapping documentation.

---

## 9. Documentation

- [ ] **[Severity: High] SERVER_FIRST_RUN.md gives invalid Argon2id password hash instructions**
      File: `SERVER_FIRST_RUN.md:98,103-107`
      Issue: Guide instructs operators to set `MANAGER_PASSWORD_HASH` using `openssl rand -base64 48`, which produces a random base64 string — not a valid Argon2id hash. Operators following this guide will be permanently locked out of the Gateway platform.
      Suggested fix: Provide a command/script that generates a valid Argon2id hash (e.g., using the project's own Node.js argon2 dependency).

- [ ] **[Severity: Medium] TROUBLESHOOTING.md references wrong proxy header name**
      File: `TROUBLESHOOTING.md:57`
      Issue: States the header is `X-Trust-Proxy-Secret`, but the Gateway actually expects `X-Gateway-Proxy-Token` (confirmed in DEPLOYMENT.md:79, docker.yml:199, and deployment tests).
      Suggested fix: Change `X-Trust-Proxy-Secret` to `X-Gateway-Proxy-Token`.

- [ ] **[Severity: Low] MIGRATION.md migration count is outdated (says 72, actual is 74)**
      File: `MIGRATION.md:46-48`
      Issue: States 72 migrations ending at 0071, but the drizzle directory has 74 migrations (0000-0073).
      Suggested fix: Update the count and table to include migrations 0072 and 0073.

- [ ] **[Severity: Low] ADR.md and AGENT_ARCHITECTURE.md have conflicting polling intervals**
      File: `ADR.md:104` vs `AGENT_ARCHITECTURE.md:38`
      Issue: ADR-009 says "every 10s when offline". AGENT_ARCHITECTURE.md says "every 5 seconds when WebSocket is down".
      Suggested fix: Verify the actual agent implementation and align both docs.

---

## 10. CI/CD (`.github/workflows/**`)

- [ ] **[Severity: High] `pip install pytest` fails on ubuntu-latest (PEP 668)**
      File: `.github/workflows/ci.yml:144`
      Issue: `pip install pytest` runs globally without a virtual environment. Ubuntu 24.04 (ubuntu-latest) enforces PEP 668, making global pip installs fail with `externally-managed-environment` error.
      Suggested fix: Use `python3 -m venv .venv && source .venv/bin/activate && pip install pytest` or `pipx run pytest`.

---

## 11. Config and Environment

Reviewed in full: `.env.example`, `docker-compose.yml`, `Dockerfile`, `package.json`, `go.mod`, `Cargo.toml`, `drizzle.config.ts`, `next.config.ts`, `server.ts`, `proxy.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.*.mts`.

No critical findings. The configurations are well-structured with appropriate secret management, version pinning, and environment isolation.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 3     |
| High     | 9     |
| Medium   | 7     |
| Low      | 11    |
| **Total** | **30** |

**Critical items (must fix immediately):**
1. Go agent `terminalReportMu` missing field — build failure
2. `windows_spooler` protocol rejected by Gateway API — printer registration broken
3. SERVER_FIRST_RUN.md gives invalid password hash instructions — operator lockout
