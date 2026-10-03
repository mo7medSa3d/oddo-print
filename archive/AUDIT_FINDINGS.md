# AUDIT_FINDINGS.md

Read-only audit of the Yaseir Cloud Printing Platform, performed on branch
`arena/01a0f69c-oddo-print` (PR #109). This file is Part A of the audit/fix
engagement; the commit that introduces it changes **no code**.

**How to read this file.** Every finding is a checkbox with a severity, the
exact location, the issue, and a suggested fix. Part B fixes findings top to
bottom, one focused commit each. When a fix is verified by the real GitHub
Actions run for its push, the box is checked and the fixing SHA is appended.
Items that cannot be fixed are marked `BLOCKED:` with the reason.

Legend: `[Critical]` · `[High]` · `[Medium]` · `[Low]` · `[info]` (non-actionable note).

Method: every source file was read or swept on this branch at `840953f`.
Areas that could not be read line-by-line in this pass are listed under
"Open verification items" rather than being silently implied as clean.

---

## Findings

### 1. Gateway API — `src/app/api/**` (76 route files)

Coverage: all 76 route files swept for method set, auth guards, error shapes,
`code:` values, body limits, and list-limit clamping; full reads of
`billing/webhook/route.ts` (467 lines) and `agent/jobs/route.ts` (605 lines).
The remaining large routes are listed under "Open verification items".

- [ ] **[Medium] 403 responses are uncoded in 45 places while three routes use a coded error shape** — e.g. `src/app/api/billing/checkout/route.ts:44`, `src/app/api/team/members/route.ts` (×3), `src/app/api/team/invitations/route.ts` (×3), `src/app/api/printers/[id]/route.ts` (×3), `src/app/api/onboarding/route.ts` (×3), and 40 more. The coded counterpart (`ActionError` with `code: "FORBIDDEN"`) exists in `src/lib/action-error.ts` and is used in `src/app/api/agents/[id]/route.ts`. Clients cannot distinguish a permission failure from any other 403, and the dashboard/desktop error handling branches on `code`. **Suggested fix:** extend `ActionError` (or add a shared `forbidden()` helper) and migrate the 45 hand-rolled bodies to the coded shape: `{ error, code: "FORBIDDEN", retryable: false }`.

- [ ] **[Low] JSON-parse error text drifted into two families** — `"Invalid JSON body"` appears 6 times (`src/app/api/admin/tenants/[id]/lifecycle/route.ts:47`, `src/app/api/agent/jobs/route.ts:265`, `src/app/api/platform/auth/login/route.ts:17`, `src/app/api/platform/plans/route.ts:13`, `src/app/api/platform/tenants/[id]/suspend/route.ts:39`, `src/app/api/print/jobs/batch-status/route.ts:41`) against `"Invalid JSON"` in 26 other routes. `print/jobs/batch-status` additionally sets `code:"INVALID_BODY"` while the other five do not; `platform/plans` throws the string instead of returning a response. **Suggested fix:** one shared parse helper returning `{ error: "Invalid JSON body", code: "INVALID_JSON", retryable: false }` (or the majority spelling) and use it everywhere.

- [ ] **[Low] `"Not found"` 404 bodies are duplicated 10 times with no shared helper**, and neighboring routes use entity-specific text (`"Job not found"`, `agent/jobs/route.ts:279`; `"Tenant not found"`, `billing/checkout/route.ts:225`). **Suggested fix:** a shared `notFound(entity?)` helper so the shape and `code` are consistent.

- [ ] **[Medium] `Error` objects passed as values into structured logs serialize to `{}`** — 11 confirmed sites: `server.ts:191,206,220,229`; `src/app/api/agent/register/route.ts:211`; `src/server/ws.ts:120,700,736,783,821,874`. Proof: `JSON.stringify({ error: new Error("the real message") })` returns `'{"error":{}}'`, so the message and stack vanish from the emitted log line. Most route handlers already use the correct pattern (`e instanceof Error ? e.message : "unknown"`), so the root cause is the serializer in `src/lib/log.ts`. **Suggested fix:** normalize `Error` values (top-level, `error`, `cause`, nested objects with an `error` key) inside `log.ts` before serialization, and add a regression test asserting a logged `Error` produces its message.

- [ ] **[Low] The printer-eligibility SQL predicate is copy-pasted four times in one file** — `src/app/api/agent/jobs/route.ts:88–96` (capacity exclusion), `:130` (stale candidates), `:161` (queued candidates), `:192` (claimable re-check). The four copies must stay byte-equivalent for capacity accounting and claiming to agree; a future edit to one copy silently breaks the other three. **Suggested fix:** extract one `sql` fragment/helper (or add a contract test asserting the four copies remain identical), matching how `liveTenantSubscriptionPredicate` is already shared.

Everything else in the sweep was clean: only `src/app/api/team/invitations/accept/route.ts` lacks a standard guard and it is invitation-token gated (hashed, `accepted_at`/`revoked_at`/`expires_at` checked) and IP rate-limited by design; all `[id]` routes are tenant-scoped; list limits are clamped (`clampListLimit` and hand-rolled clamps in `platform/audit` 1–500, `platform/plans` 1–1000, `platform/subscriptions` 1–1000); the `jobs` DELETE cleanup requires manager auth + `jobs.cancel` + `confirm=1` + a past `before` date and refuses rows carrying unknown-outcome markers.

### 2. Gateway libraries — `src/lib/**`

Coverage: full reads of `console-auth.ts`, `action-error.ts`, `stripe.ts`,
`log.ts`, `runtime-secret.ts`, `job-fencing.ts`, `job-status.ts`,
`database-clock.ts`, `job-delivery.ts`, `job-maintenance.ts`, `payload.ts`,
`routing.ts`; structured read of `session-tokens.ts` (786 lines);
selected reads of `manager-auth.ts`, `customer-auth.ts`, `job-timeline.ts`.

- [ ] **[Medium] Three independent claim-token redaction implementations exist** — `src/lib/log.ts:13` (`redactClaimId` for log fields), `src/lib/job-timeline.ts:24` (SHA-256 prefix persisted into `job_events`), and `src/app/api/jobs/[id]/timeline/route.ts:32` + `:44` (`redactClaimToken` / `redactClaimIdForTimeline` for API responses). The claim token is a fencing credential; having three algorithms means the redaction guarantee differs per surface and can drift silently. **Suggested fix:** one shared `redactClaimToken` module with tests, imported by all three call sites.

- [ ] **[Medium] `src/lib/log.ts` does not normalize `Error` values** — root cause of finding 1.4. **Suggested fix:** see 1.4.

Everything else reviewed was clean, including: `job-fencing.ts` (id + tenant + agent + status inside the `WHERE`; `claim_token IS NOT DISTINCT FROM <token>` on status writes; strict `=` on delivery evidence so tokenless legacy rows are never evidence-eligible); `database-clock.ts` (DB `clock_timestamp()` is the time authority, 30 s skew TTL, single-flight refresh); `job-status.ts` (transition table, markers, late-success windows); `stripe.ts` (no SDK — raw HMAC verification against the DB clock, multi-`v1` timing-safe compare, price binding checks); `runtime-secret.ts`; `payload.ts` (contract schema matches `contracts/print-payload-contract.json`); `routing.ts` (capability table mirrored by `agent/internal/printer/capability.go`).

### 3. Database — `src/db/**`, `drizzle/**`

Reviewed: `src/db/schema.ts`, `src/db/index.ts`, every `drizzle/*.sql`
migration swept (CREATE/ALTER table coverage, numbering, constraints,
legacy-table drops).

**Reviewed in full, no findings.** 76 migrations, no numbering collisions,
every `schema.ts` table is touched by at least one migration, the legacy
tables found in older migrations (`applications`, `branches`, `destinations`,
`document_types`, `local_networks`, `print_job_rate_limits`, `printer_bindings`)
are dropped by later migrations, and `print_jobs_status_check` enumerates the
canonical six statuses.

### 4. UI — `src/app/**` pages, `src/components/**`

Coverage: mechanical sweeps this pass (raw hex colors, inline color styles,
`transition-all`, `animate-pulse`, `!important`, `style={{`); prior
overhaul rounds already read the main shells (`AppShell`, `TopNavbar`,
`CommandPalette`, `ui.tsx`, dashboard/settings/platform surfaces).

**No findings from this pass.** No raw hex colors outside `globals.css`, no
`transition-all`/`animate-pulse`, the 10 `style={{` uses only pass CSS
variables (`--overlay`, `--platform-accent`), and the only three `!important`
declarations are the desktop reduced-motion overrides
(`src/desktop/theme-light.css:81–83`), which are intentional. A full
component/page pass remains under "Open verification items".

### 5. Go agent — `agent/**`

Coverage: full read of `agent/internal/agent/device_class.go`; sweeps for
ignored errors, panics, HTTP client timeouts/redirect policy, env reads,
secret-bearing log lines, and temporary artifacts across
`agent/internal/**` and `agent/cmd/**`.

- [ ] **[High] The agent logs raw claim tokens in cleartext** — `agent/internal/agent/agent.go:2668`: `log.Printf("Job %s: claim token override (passed %q, using live %q)", jobID, claimToken, live)`. Claim tokens are the fencing credentials the Gateway everywhere redacts (three redaction helpers on the Gateway side); agent stdout is also the kind of artifact operators paste into support requests. **Suggested fix:** redact both values (prefix/hash) before logging, matching the Gateway's policy.

- [ ] **[Medium] `agent/internal/diag/diag_test.go` is a self-described temporary CI workaround committed as a package** — its docstring says "Package diag contains TEMPORARY CI observability plumbing … Remove this package once the Windows job is green." It runs in CI (`ci.yml:76`, `build-windows.yml:89`, both `go test ./... -race`): when `GITHUB_ACTIONS=true` it re-runs *every other package's tests* (`go test -count=1 <pkg>` per package) purely to re-emit failures as `::error::` annotations, duplicating the outer test matrix and roughly doubling Go test wall time for no gate value. **Suggested fix:** delete the package (`agent/internal/diag/`) and the CI condition is unchanged — the outer `go test ./... -race` already fails on the same packages.

- [ ] **[Low] The Gateway device-class enum is duplicated in Go with comment-only synchronization** — `agent/internal/agent/device_class.go:19–31` hardcodes `gatewayDeviceClasses` mirroring `DEVICE_CLASSES` in `src/lib/printer-model.ts`. The normalizer itself is correct (fails closed to `unknown`, which is always accepted), but nothing pins the two lists together; this is exactly the enum-drift class that previously dropped printers from inventory. **Suggested fix:** add a cross-language contract test (the repo already extracts source text in `tests/shared-vocabulary.contract.test.ts`) asserting the Go map keys equal the TS `DEVICE_CLASSES` list.

Everything else swept was clean: all four `http.Client`s have explicit timeouts (15 s / 15 s / 5 s / 15 s) and disable redirects on credential-bearing paths; no `panic(` in non-test code; every ignored error is a benign close (`resp.Body.Close`, `tmp.Close`, `conn.Close`, `os.Remove`); no TODO/FIXME/HACK markers; no secret-shaped values in other log lines.

### 6. Tauri shell — `src-tauri/**`

Reviewed: `commands.rs`/`agent.rs`/`cleanup.rs`/`logging.rs` command
surface (20+ `#[tauri::command]`), `unsafe` blocks, `Cargo.toml`
(pinned `tauri = "=2.11.5"`, `tauri-build = "=2.6.3"`, release profile),
`capabilities/default.json`, `tauri.conf.json`.

**Reviewed in full (static sweep), no findings.** The three `unsafe` blocks
are confined to the Win32 process-inspection path in `agent.rs`
(`OpenProcess` / `QueryFullProcessImageNameW` / `GetProcessTimes` /
`TerminateProcess` / `CloseHandle`) with handles closed on every path; the
capability manifest is present and minimal.

### 7. Odoo addon — `odoo_addons/print_gateway/**`

Coverage: `__manifest__.py`, `models/print_job.py` (status/outcome
definitions and the sync mapping), `models/gateway_config.py` (queue sync
error path), `models/print_intent.py`, `models/binding.py`, `security/`
(ACL + record rules), `migrations/`, POS JS assets, `cr.execute` census.

- [ ] **[Medium] CI runs only 3 of the 5 Python test files, and both excluded files currently fail on comment-substring assertions** — `ci.yml:145` runs `test_odoo19_printing_static.py`, `test_security_contracts.py`, `test_final_security_hardening.py`. Excluded: `tests/test_gateway_activation_robustness.py` and `tests/test_pos_receipt_font_rendering.py`, which fail like this:
  - `tests/test_pos_receipt_font_rendering.py:54,98–100` asserts `@font-face` / `fonts.odoocdn.com` / `NotoSans` are absent from `pos_print_router.js`, but those tokens appear in the file's *explanatory comments* (the comments describing the bug the code fixes) — 2 failures.
  - `tests/test_gateway_activation_robustness.py:140` asserts `_persist_enabled_sync_result` is absent from the malformed-credential error path, but the identifier appears in the explanatory comment inside that path in `odoo_addons/print_gateway/models/gateway_config.py` — 1 failure. The actual guard (no second cursor, local write via `skip_enabled_sync`) is present; the assertion is testing the comment text.
  **Suggested fix:** make the assertions comment-aware (strip `//` … `#` comments before matching, or assert on code-only regexes) and add both files to the `ci.yml` pytest invocation so excluded suites cannot rot.

- [ ] **[Low] `cr.execute` call sites (64) were counted but not individually reviewed for parameterization** — see "Open verification items"; if any interpolate values, that becomes a [High]. **Suggested fix:** finish the parameterization sweep, then either fix or record it as clean.

Odoo was otherwise clean: no `eval`/`exec`, the `print_job.status` selection is a documented superset of the Gateway vocabulary with an explicit `expired` mapping (`models/print_job.py:1463–1478` maps `expired` → `unknown`/`failed` from the same five unknown markers as the Gateway, `:403–409`), `physical_outcome` is `not_printed|printed|unknown`, ACL and record-rule files exist, and the manifest's `external_dependencies` (`requests`, `cryptography`) are declared.

### 8. Cross-boundary contracts

Reviewed by extracting the actual literals from each side:
`src/lib/job-status.ts`, `src/lib/printer-model.ts`, `src/lib/routing.ts`,
`src/db/schema.ts`, `agent/internal/**/*.go`,
`odoo_addons/print_gateway/models/*.py`, `contracts/print-payload-contract.json`.

| Vocabulary | Gateway | Go agent | Odoo | Verdict |
| --- | --- | --- | --- | --- |
| Job statuses | `queued, claimed, printing, success, failed, expired` | same set used (no `expired` literal needed) | superset with explicit `expired` mapping | match |
| Unknown-outcome markers | 5 (`AGENT_EXECUTION_TIMEOUT`, `AGENT_RESTART_DURING_PRINT`, `JOB_EXPIRED_DURING_PRINT`, `UNKNOWN_PARTIAL_DELIVERY`, `UNKNOWN_SUBMISSION_OUTCOME`) | 5, exact | 5, exact | match |
| Requeue reasons | 5 | 5, exact | n/a | match |
| Printer protocols | 9 | 9, exact | same names | match |
| Connection types | `network, usb, spooler, ipp, ipps` | same used | same names | match |
| Device classes | 6 (`thermal, laser, inkjet, label, other, unknown`) | extra literals `virtual`/`redirected` belong to the *printer-type* normalizer, not the device-class map | — | see 5.3 (unpinned) |

- [ ] **[Low] Add a regression pin for the Gateway↔Go device-class vocabulary** — same as finding 5.3; the only cross-boundary pair with no automated pin and real drift history. **Suggested fix:** the contract test described in 5.3.

**Reviewed, no further findings.**

### 9. Docs — root `*.md` + `docs/**`

Coverage: full inventory, version-claim checks against `.nvmrc` /
`go.mod` / `Cargo.toml`, npm-script references validated against
`package.json`, `.env.example` cross-checked against every env read in
`src/`, `scripts/`, `server.ts`, `drizzle.config.ts`.

- [ ] **[Medium] Stale session artifacts are committed at the repository root** — `AUDIT_EDIT_STATE.md` (41 lines) and `AUDIT_LOG.md` (62 lines). They are process notes from an earlier editing session (dated 2026-09-30, "Branch: main, HEAD: 50e31e34", a "Phase 5" checklist still unticked, "RESUME HERE" scaffolding), are referenced by nothing in code, CI, or docs, and now misstate the repository's state ("no bugs found"). **Suggested fix:** delete both files.

- [ ] **[Low] `.env.example` and the docs drift from the runtime env surface** — read by code but absent from `.env.example`: `ALLOW_LEGACY_MANAGER_AUTH`, `ALLOW_PLATFORM_BOOTSTRAP_FORCE`, `MAINTENANCE_SWEEP_LIMIT`, `MANAGER_PASSWORD`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PLATFORM_OWNER_EMAIL`, `PLATFORM_OWNER_PASSWORD`, `PLATFORM_OWNER_PASSWORD_FILE`, `WS_ALLOWED_ORIGINS` (test-only `RUN_MULTI_INSTANCE_TEST`, `TEST_WORKER_SCHEMA`, `VITEST*` acceptable to omit). Present in `.env.example` but not read by app code: `GATEWAY_DOMAIN`, `GATEWAY_HTTP_PORT`, `GATEWAY_HTTPS_PORT`, `POSTGRES_DB/USER/PASSWORD` (compose/Caddy consumers — fine), `STRIPE_PUBLISHABLE_KEY`, `YASEIR_AGENT_ALLOW_INSECURE_HTTP` (consumer to be confirmed — see open items). Root docs never mention `DESKTOP_CORS_ORIGINS`. **Suggested fix:** sync `.env.example` (grouped, commented) and confirm/remove the two unresolved entries.

Everything else was clean: README's Node baseline matches `.nvmrc`; all nine npm scripts referenced by docs exist; no Go/Rust version drift claims exist in the docs.

### 10. CI workflows — `.github/workflows/**`

Reviewed: `ci.yml` (415 lines), `security-supply-chain.yml` (199),
`static-security.yml` (95), `docker.yml` (234), `build-windows.yml`.

- [ ] **[Medium] The container-image pin gate misses digest-less references** — `security-supply-chain.yml:136` scans only for image references that already use `@sha256:` and fails when a *docker/compose* image is unpinned; compose refs without a digest are still accepted by the regex. (The current `docker-compose.yml` is in fact fully digest-pinned, so this is a gate-strength issue, not a live violation.) **Suggested fix:** extend the check to `image:` values in `docker-compose.yml` and fail on any tag that is not a `@sha256:` digest.

- [ ] **[Medium] The pytest step under-runs the Python suites** — `ci.yml:145` names three files; the two excluded files currently fail (see 7.1). **Suggested fix:** run `pytest tests/test_*.py` (or add the two files explicitly) after fixing their assertions.

- [ ] **[Medium] The Go test matrix is executed twice per CI run** — `agent/internal/diag/diag_test.go` (see 5.2) re-runs every package's tests inside the outer `go test ./... -race` on both `ci.yml:76` and `build-windows.yml:89`. **Suggested fix:** delete the diag package (or make it inert).

Everything else was clean: all `uses:` are 40-char SHA-pinned; images are digest-pinned; `npm audit --audit-level=high` and the supply-chain fixture gate are present; CodeQL runs for js/ts + python + go; dependency-review and gitleaks are armed; `docker.yml` verifies the CSP nonce equality and that `script-src` has no `unsafe-inline`; `ci.yml` enforces gofmt, the SQL schema assertions, and Odoo's ≥80 passing (0 failed/error/skipped) tests.

### 11. Configuration and environment

Reviewed: `.env.example` (40 lines, cross-checked against every env read
in the code), `docker-compose.yml` (4 services, secrets via `*_FILE`),
`Dockerfile` (digest-pinned, non-root, healthcheck), `package.json`,
`agent/go.mod`, `src-tauri/Cargo.toml`.

- [ ] **[Low] `.env.example` drift** — see 9.2 (single shared fix).

**Reviewed in full, no other findings.** Compose secrets are file-based with
no inline credentials; the gateway waits for `migrate` completion; the Docker
image runs as the non-root `node` user with a real healthcheck; toolchain
pins are consistent (`engines.node >=24.15.0`, `.nvmrc` 24.21.0, README
24.21.0; `go 1.26`; `rust-version 1.90`).

---

## Verified false alarms (do not chase in Part B)

- `docs/WINDOWS_SERVICE_RECOVERY.md:8`'s `winsvc/ns-winsvc-service_failure_actionsa`
  string is a **Microsoft Learn URL**, not a documented API route.
- The migration sweep's "24 tables never created by a migration" initial result
  was a grep artifact (most migrations use `ALTER TABLE`/`DO $$` blocks); the
  precise sweep shows every `schema.ts` table is touched.
- `src/desktop/theme-light.css:81–83` `!important` is the reduced-motion
  override block and is intentional.
- All Go `http.Client{}` literals were verified to carry timeouts (the earlier
  "missing timeout" suspicion was a multi-line grep artifact).

## Open verification items (finish before or during Part B)

- [ ] Full reads of the remaining largest Gateway routes: `agent/heartbeat`
      (461), `billing/checkout` (457), `printers/[id]/certify` (445),
      `print/jobs` (248), `agent/discovery` (237), `platform/plans/[id]` (221),
      `agent/register` (214), `provision` (193), `printers/[id]` (187),
      `odoo/configuration` (185), `odoo/keys` (184), `jobs` (176),
      `platform/stats` (167), `platform/plans` (165), `jobs/[id]/timeline` (148),
      `printers` (146), `printers/[id]/test-print` (140).
- [ ] Full UI pass over `src/app/**` pages and `src/components/**` matched
      against the design-token system (only mechanical sweeps so far).
- [ ] Odoo `cr.execute` parameterization spot-check (64 call sites).
- [ ] Go `virtual`/`redirected` literal context check (expected: printer-type
      normalizer, not device-class drift).
- [ ] Confirm consumers of `STRIPE_PUBLISHABLE_KEY` and
      `YASEIR_AGENT_ALLOW_INSECURE_HTTP` (shell scripts / Caddy / Go agent)
      before removing them from `.env.example`.
- [ ] Decide the documentation layout (`docs/` holds 7 supplementary documents
      while the main docs live at the repository root).

## Fix log (Part B)

_(empty — populated as findings are fixed, each with the verifying CI run.)_
