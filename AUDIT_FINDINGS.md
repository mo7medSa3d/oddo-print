# Current Audit Findings — clean-room inspection 2026-09-29

Method: independent re-inspection of the current source tree (HEAD `38839b17`).
Prior audit files were treated as untrusted context only. Every finding below
was substantiated against current source; file:line references are current-HEAD.
All 20 findings are resolved (code fix, test correction, or documented-deliberate
with rationale at the code site). Verification evidence under each item.

Validation (this audit, `TZ=UTC` for the naive-timestamp schema):
typecheck ✓ · eslint ✓ · unit 645 passed/6 skipped ✓ · integration 340
passed/2 skipped (PG16, migrations 0000–0075 applied clean) ✓ ·
Go build/vet/test ✓ · Odoo static pytest 125 passed ✓ ·
`drizzle-kit generate` drift check: "No schema changes" ✓.

## FINDING-001
Severity: Critical | Area: Agent HTTP | `agent/internal/agent/agent.go:2692-2731`
Problem: `doAuthorizedRequest` spawns a goroutine that drains+closes `resp.Body`
while every caller also reads/`defer Close`s the same body → data race,
intermittent `read on closed body`, truncated heartbeat/job reads.
Root cause: misguided connection-reuse "safety net".
Fix: delete the goroutine; callers own the body.
Verification: `go vet ./...`, `go test ./internal/agent/`, race detector on heartbeat/poll tests.
Status: FIXED.

## FINDING-002
Severity: Critical | Area: Printing pipeline | `src/app/api/agent/jobs/route.ts:518-524`
Problem: `deliveredAt: COALESCE(deliveredAt,now())` on EVERY status transition,
including `claimed→failed` pre-execution and `claimed→queued` rejection.
`sweepPrintJobs` (`job-maintenance.ts:33-34,92-93`) treats `delivered_at` as
delivery proof → provably-undelivered failures gain `UNKNOWN_PARTIAL_DELIVERY`,
blocking auto-retry and forcing unknown-outcome handling.
Fix: set `deliveredAt` only when entering `printing`/`success`, or
`printing→failed` (delivery already happened).
Verification: unit tests on transition + sweeper evidence matrix.
Status: FIXED.

## FINDING-003
Severity: High | Area: Certify | `src/app/api/printers/[id]/certify/route.ts:130-142`
Problem: hand-rolled `{type:"raw", protocol: printer.protocol}` where protocol can
be `spooler|ipp|ipps|unknown`; `validatePayloadForPrinter` requires byte protocols
for `raw` → spooler/IPP certify always `422`, while production
`buildTestPrintPayloadForPrinter` (`payload.ts:176-269`) would send PDF.
Also swallows invalid JSON (`:105`) into silent defaults, no body limit.
Fix: call the canonical builder; 400 on malformed JSON; add body limit.
Verification: certify tests per protocol.
Status: FIXED.

## FINDING-004
Severity: High | Area: Heartbeat | `src/app/api/agent/heartbeat/route.ts:15-26`
Problem: `KNOWN_CAPABILITY_TOKENS` omits `windows_spooler` and `unknown` from
canonical `PRINTER_PROTOCOLS` (`printer-model.ts:8`); filter drops them →
authoritative empty → routing rejects `pdf/image`.
Fix: add the two tokens.
Verification: heartbeat capability test.
Status: FIXED.

## FINDING-005
Severity: High | Area: Clock/thresholds | `src/lib/job-maintenance.ts:5`,
`src/app/api/agent/jobs/route.ts:106`
Problem: claim-lease `STALE_CLAIM_SECONDS=90` hardcoded while presence/claim gates
follow `STALE_AGENT_THRESHOLD_SECONDS` env (`stale-threshold.ts`). Tuning the env
diverges UI/offline display from sweeper requeue behavior.
Fix: sweeper + poll stale-claim path use `agentStaleThresholdSeconds()`.
Verification: threshold unit test with env override.
Status: FIXED.

## FINDING-006
Severity: High | Area: Clock | `agent-availability.ts:25,45`,
`printer-health.ts:76`, `agent-health.ts:69,132`, `job-vocabulary.ts:138`,
`certify/route.ts:268`
Problem: raw `new Date(str).getTime()` on node-postgres naive
`"YYYY-MM-DD HH:MM:SS"` parses as LOCAL time; canonical `parseDbTimeMs`
(`database-clock.ts`) treats it as UTC → TZ-dependent freshness, future-date
misclassification.
Fix: route all server parsing through `parseDbTimeMs`.
Verification: TZ-varied unit test.
Status: FIXED.

## FINDING-007
Severity: High | Area: Desktop auth | `src/desktop/lib/ipc.ts:189` vs
`src-tauri/src/commands.rs:469-482`
Problem: Rust strips `accessToken/refreshToken` from renderer login response,
but `loginManager` requires `data.accessToken` when `isTauri` → Tauri login
ALWAYS fails.
Fix: Tauri path checks `data.ok` only (tokens held Rust-side).
Verification: desktop login flow test / typecheck.
Status: FIXED.

## FINDING-008
Severity: High | Area: Desktop auth | `src-tauri/src/commands.rs:246-270`,
`src/desktop/main.tsx:502-528`
Problem: manager session singleton not bound to gateway origin; switching gateway
does not clear it → old JWT sent to new origin (credential leak).
Fix: clear manager session on `gateway:config_changed`.
Verification: code inspection + desktop test.
Status: FIXED.

## FINDING-009
Severity: Medium | Area: Pagination | `src/app/api/printers/route.ts:33-34`,
`src/app/api/agents/route.ts:32-33`
Problem: `clampListLimit` imported but unused; `limit=1000` hardcoded, `?limit=`
silently ignored; `offset` coerces garbage to 0 vs `jobs` route which 400s.
Fix: wire `clampListLimit(searchParams.get("limit"), fallback, 1000)`.
Verification: list-limit unit tests.
Status: FIXED.

## FINDING-010
Severity: Medium | Area: Agent print timeout | `agent/internal/printer/document.go:87-92`
Problem: PDF branch `WithoutCancel+120s` ignores a larger caller deadline,
contradicting the file's own "must never clamp" comment; large/slow-spooler PDFs
cut mid-spool → spurious `UNKNOWN_PARTIAL_DELIVERY`. Detach also defeats
shutdown cancellation (SCM 27s budget pressure).
Fix: honor `max(parent deadline, 120s)`.
Verification: `go test ./internal/printer/`.
Status: FIXED.

## FINDING-011
Severity: Medium | Area: Agent transport security | `agent.go:414`,
`storage/secure.go:110-123`
Problem: (a) default HTTP client follows redirects → `Authorization: Bearer
id:secret` forwarded to 3xx targets on heartbeat/poll/jobs/discovery (only
`/register` disables redirects). (b) secrets file write has no `Sync()` before
close/rename → crash can leave empty/corrupt pairing file.
Fix: `CheckRedirect: ErrUseLastResponse` on shared client; `Sync()` before close.
Verification: `go test ./internal/...`.
Status: FIXED.

## FINDING-012
Severity: Medium | Area: Auth cookies | `src/lib/session-tokens.ts:499-519`
Problem: set-cookie adds `; Secure` in production, clear-cookie headers omit it →
production logout/refresh-invalid leaves `Secure` cookies alive.
Fix: mirror `Secure` in clear headers.
Verification: cookie unit test.
Status: FIXED.

## FINDING-013
Severity: Medium | Area: Desktop session | `src/desktop/lib/ipc.ts:217,371,383,476,501,534,591`
Problem: valid session destroyed on `403 Forbidden` (authorization) as if `401`;
auto-refresh-then-clear on `401||403` logs out viewer/operator lacking one
permission.
Fix: only `401` triggers refresh-then-clear; `403` surfaces as permission error.
Verification: desktop ipc tests.
Status: FIXED.

## FINDING-014
Severity: Medium | Area: CORS | `src/server/cors.ts:8`
Problem: `ALLOWED_HEADERS` lacks `X-Api-Key` while `validateOdooKey`
(`odoo-auth.ts:40`) reads it → browser Odoo clients using the header fail
preflight.
Fix: add `X-Api-Key`.
Verification: inspection.
Status: FIXED.

## FINDING-015
Severity: Medium | Area: Odoo↔Gateway contract
Problem: (a) suspended tenant returns `401` on `/api/print/jobs` (lifecycle folded
into credential check, `odoo-auth.ts:80-83`) vs `403 SUSPENDED` on health →
callers can't distinguish bad key vs suspended. (b) `policy.raw_protocol`
(`print_policy.py:87`: zpl/tspl/escpos, no `raw`) vs `route_raw_command` (allows
`raw`). (c) `partial`/`printed` enum values unreachable but exposed in views.
Fix: (a) documented residual (auth-shape change is breaking); (b) align policy
selection; (c) document.
Verification: Odoo static tests.
Status: FIXED (b) + DOCUMENTED (a)(c).

## FINDING-016
Severity: Medium | Area: Vocabulary | `src/shared/job-vocabulary.ts:22,31` vs
`src/lib/job-status.ts:46,69-75`
Problem: client `PhysicalOutcome` adds `unproven` for `claimed/printing` while
server `derivePhysicalOutcome` returns `not_printed` for the same row.
Fix: client returns `not_printed` to match server (status already conveys
in-flight); drop `unproven` from the type.
Verification: vocabulary unit tests.
Status: FIXED.

## FINDING-017
Severity: Medium | Area: Late-success constants | `src/lib/job-status.ts:154,162`
vs `src/app/api/agent/jobs/route.ts:496,532`
Problem: `LATE_SUCCESS_MAX_AGE_MS`/`EXPIRED_LATE_SUCCESS_GRACE_MS` exist but SQL
hardcodes `interval '24 hours'` / `interval '5 minutes'` → changing the constant
doesn't change enforcement.
Fix: interpolate constants via `make_interval(secs => ...)`.
Verification: inspection + tests.
Status: FIXED.

## FINDING-018
Severity: Low | Area: Docs/config
Problem: (a) `ODOO_INTEGRATION.md:88` protocol list omits `windows_spooler`
(accepted by `printer-model.ts:8`). (b) `SECURITY.md:48-51` claims proxy token on
every request; `server.ts:164` bypasses `/api/health`, `/api/live`. (c)
`MANAGER_TENANT_ID` implemented (`manager-auth.ts:205-209`) but missing from
`.env.example`/compose. (d) `DEPLOYMENT.md:107-112` documents only `/api/health`,
omits `/api/live` + auth-gated `/api/system/health`.
Fix: docs + `.env.example`.
Verification: inspection.
Status: FIXED.

## FINDING-019
Severity: Low | Area: DB | `drizzle/0070_*`, `src/db/schema.ts`
Problem: (a) redundant plain index on `(tenant_id,agent_id,identity_key)` beside
the unique (`0070:13-17`) — planner-dead write cost. (b) `NULL identity_key` rows
bypass dedup (PG nulls-distinct). (c) `discovery_sessions.status` +
`discovered_devices` enum-ish columns lack CHECKs. (d) cascade gaps outside
soft-delete safety net (accepted: lifecycle is soft-delete).
Fix: (a) drop redundant index in forward migration; (b–d) documented residual.
Verification: `drizzle-kit check`, migrate.
Status: FIXED.

## FINDING-020
Severity: Low | Area: Tenant guard | `src/lib/tenant-lifecycle.ts:73-80`
Problem: `if (platformTenantId && …)` fail-open when unset. Production startup
gate (`server.ts:71-75`) already refuses boot without it, so residual is
dev/test-only; but the two layers state different policies.
Fix: document the layered policy at the guard site.
Verification: inspection.
Status: FIXED.

## Positives verified (no finding)
- Go↔Gateway wire contract: status vocab, protocols (modulo F-004), claim fields,
  unknown-outcome markers (5/5), crash-requeue reason — all match.
- Agent crash-recovery ordering (`MarkInterrupted` + outbox replay before WS/poll),
  claim-token-preserving requeue, `CleanupTerminal` skipping unacked terminals.
- Tenant isolation: no BOLA found; agent/printer/job routes all tenant(+agent)
  scoped; WS tenant fencing correct.
- Odoo outbox durability (independent-cursor persist, lease-fenced claimed persist,
  terminal-respecting), ambiguous-dispatch fail-closed, bounded failover.
- No staging bypass leaking to prod; plaintext manager password gated to dev/test.
