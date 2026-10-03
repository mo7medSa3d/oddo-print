# Debug Audit — Yaseir Cloud Printing Platform

Date: 2026-10-01 · Branch: `arena/01a0f69c-oddo-print` · Method: reproduce → trace →
root-cause → minimal fix → regression test → layered verification.

Every claim below is labelled as **confirmed defect**, **verified clean**,
**evidence-backed risk**, or **unverified**. Nothing is reported as a defect
without a reproduction or a source-level trace.

---

## 1. Scope and environment

| Item | Value |
| --- | --- |
| Repo | `/home/user/oddo-print` (Gateway + Go agent + Odoo addon + Tauri desktop) |
| Node | v22.22.3 (`.nvmrc` pins 24.21.0; deps installed with `npm ci --engine-strict=false`) |
| Go / Python / Postgres / Docker | **not available in this environment** — those suites are inspect-only |
| Baseline tree | `c196b6d` (UI overhaul), clean worktree, no uncommitted changes |

Audited surfaces: `src/lib/**` (job lifecycle, fencing, delivery, maintenance,
clock, routing, capabilities, health, entitlements), `src/server/**` (HTTP
guard, WebSocket push path), all 76 `src/app/api/**/route.ts` handlers,
`agent/internal/**` (status reporting, capability mirror, thresholds),
`odoo_addons/**` (time handling, credential crypto), and the cross-service
contracts (`contracts/print-payload-contract.json`, marker/reason vocabularies,
threshold constants).

## 2. Baseline (before any change)

Discovery-driven audit: the tree was already green, so a red baseline could not
point at the defect.

```
npm run typecheck   → clean
npm run lint        → clean
npm run test:unit   → 90 files passed / 1 skipped · 679 passed / 6 skipped · exit 0
```

---

## 3. Confirmed defect D1 — the Gateway rejected the agent's own terminal re-report

**Severity: high.** A job that printed exactly once could be recorded as a
physical-ambiguity failure, permanently for poll-claimed jobs.

### Reproduction

`tests/job-status.test.ts` → `canTransition("claimed", "success")` returned
`false` (assertion failed before the fix). No existing test covered the edge;
`grep -rn "claimed -> success\|Invalid status transition" tests/ agent/internal/`
returned nothing, and the Go agent's own tests run against
`newRecordingGateway(t)` — a stub that accepts whatever the agent sends — so
neither suite could see the disagreement.

### Trace

The agent deliberately re-reports a **durable local terminal result** instead of
printing a second time. Three sites, all with the claim token attached:

| Site | Trigger | Reported status |
| --- | --- | --- |
| `agent/internal/agent/agent.go:1283` | process-local terminal physical result; terminal SQLite write had failed | `terminal.status` (`success`) |
| `agent/internal/agent/agent.go:2376` | local ledger row is already `success` (duplicate delivery) | `success` |
| `agent/internal/agent/agent.go:2416` | `BeginPrint` → `queue.ErrTerminalState` with `storedStatus == "success"` | `success` |

All three return **before** the `printing` report, so the Gateway row is still
`claimed`. The agent's own comment at `agent.go:1285` states the contract it
relies on: *"Re-reporting is safe because the claim token remains fenced; a
stale reclaimed claim simply rejects the report."*

The Gateway broke that contract:

- `src/lib/job-status.ts` — `ALLOWED_TRANSITIONS.claimed` was
  `{printing, failed, queued}`; `success` was absent.
- `src/app/api/agent/jobs/route.ts:534` — the final gate therefore answered
  `409 Invalid status transition: claimed -> success`.

That body contains no `STALE_CLAIM` / `FENCE_REJECTED` marker, so
`updateJobStatus` (`agent.go:2665`) classified it as `ErrTransitionRejected`,
not `ErrStaleClaim`, and stopped re-reporting.

### Root cause

The state machine was missing the one-step form of a transition the two-step
path already allowed. `claimed → printing → success` was legal; the agent's
single-report form of the same physical event was not.

### Blast radius (traced through the sweeper)

`src/lib/job-maintenance.ts`:

- every claim stamps `error = 'DELIVERY_EVIDENCE_PENDING'`
  (`src/app/api/agent/jobs/route.ts:214`, `src/lib/job-delivery.ts:104`);
- the stale-claim **requeue** path excludes that marker (`job-maintenance.ts:75`);
- the **silentDeliveries** path includes it (`job-maintenance.ts:98`) and sets
  `status='failed'`, `error='UNKNOWN_PARTIAL_DELIVERY: claim lease expired after
  delivery without an execution report'`, preserving the fence.

So a stuck `claimed` row becomes a false physical-ambiguity record. Recovery
from there is gated at `src/app/api/agent/jobs/route.ts:461`:

- WebSocket-claimed rows carry `delivered_at`, so the late-success path can
  reconcile them within 24 h;
- **poll-claimed rows have `delivered_at`/`acked_at` NULL**, so the late report
  is answered `409 DELIVERY_RECONCILIATION_NOT_POSSIBLE` — the job stays
  `failed`/unknown permanently and needs manual operator reconciliation.

### Fix (minimal, gateway side)

`src/lib/job-status.ts` — `claimed` now also allows `success`. No new authority
is granted: `fencedJobWrite`/`fencedDeliveryWrite` (`src/lib/job-fencing.ts`)
still require the exact claim token *and* the expected status inside the
`UPDATE ... WHERE`, and entering `success` still stamps delivery evidence.

### Regression tests

- `tests/job-status.test.ts` — explicit `claimed → success` case.
- `tests/job-status.test.ts` — **cross-service sweep**: parses
  `agent/internal/agent/agent.go` for every literal `updateJobStatus(..., "<status>")`
  call site (17 sites today) and asserts each emitted status is legal *from
  `claimed`* — the exact predicate the route applies. This is the guard the two
  existing suites structurally could not provide.
- `tests/production-hardening-contract.test.ts` — its inline pin of the
  transition table was updated to the new contract (same assertiveness; the
  comment states why `success` is present).

---

## 4. Confirmed defect D2 — the dashboard offered a reprint the server always rejects

**Severity: medium (dead-end action / UX).**

- Server rule: `src/app/api/jobs/[id]/reprint/route.ts:39` rejects `success`
  with `JOB_REPRINT_NOT_ALLOWED` ("the document already printed").
- Dashboard rule (before fix): `canReprint = status !== "queued" && status !==
  "claimed" && status !== "printing"` — which **included `success`**. Every
  reprint attempt from the row menu or the detail dialog on a delivered job
  ended in a 409.

Found by a CI-run Python contract test
(`tests/test_final_security_hardening.py::test_operator_reprint_excludes_gateway_success_jobs`),
i.e. the TS suite did not catch it.

**Fix:** `src/app/dashboard/dashboard-client.tsx` — one in-flight predicate
(`isJobInFlight`) used by both call sites, plus an explicit
`!== "success"` guard mirroring the server.

---

## 5. Confirmed defect D3 — three UI-overhaul contract regressions (CI-red assertions)

The overhaul branch was green locally but had broken assertions in Python
contract files that CI **does** run (`ci.yml:145`). All three were presentation
regressions, no business logic involved.

| Assertion | File | Cause | Fix |
| --- | --- | --- | --- |
| `'Print usage is temporarily unavailable'` | `src/app/dashboard/dashboard-client.tsx` | callout reworded to "Plan usage unavailable" | restored the pinned operator-visible copy |
| `'href="/billing"' not in page` | `src/app/settings/page.tsx` | "Contact options" button pointed at `/billing` | removed the dead-end CTA (there is no support route; workspace deletion is a platform-admin action) — the block is now purely informational |
| `'brandSubtitle="Cloud Printing Platform"'` | `src/components/AppShell.tsx` | brand lockup used the tenant name as subtitle, dropping the product line | new `ConsoleBrand` lockup with a constant product subtitle; tenant identity remains in `WorkspaceMenu` (already rendered in the sidebar footer and mobile sheet) |

**Process finding:** `npm run test:unit` cannot detect these — 3 of the
repository's contract files are pytest-run, and `AGENTS.md`/CI treat them as
part of the gate. Local TS-only verification is therefore insufficient for
frontend changes; the Python contract files must be run before shipping UI work.

---

## 6. Verified clean (checked, no defect found)

| Area | Method | Result |
| --- | --- | --- |
| Route authz / BOLA | enumerated all 76 route handlers; guard vocabulary (`validateWorkspaceManager` ×38, `requireManagerPermission` ×32, `validateConsoleAuth`, `requirePlatformOwner`, `validateOdooKey`, `validateAgent`, …) | every `[id]`-parameterised route is tenant-scoped; the only unguarded handler is `team/invitations/accept`, which is token-based (hashed, rate-limited, non-enumerating) by design |
| Pagination / unbounded reads | every `limit` read: `clampListLimit`, explicit `Math.min(Math.max(...))` clamps, or strict integer validation returning 400 (`jobs` DELETE) | no unbounded or `NaN`-bearing `.limit()` |
| Job fencing | read `src/lib/job-fencing.ts` + consumers | token **and** expected status live inside the `UPDATE ... WHERE`; delivery evidence refuses tokenless/legacy rows — no read-then-write TOCTOU |
| Cross-service thresholds | compared Go ↔ TS constants | `STALE_CLAIM_SECONDS = 90` ↔ `staleClaimSafetyWindow = 90s`; `MAX_AGENT_IN_FLIGHT_JOBS = 64` ↔ `maxPendingJobs = 64`; per-printer 8; `MAX_RETRIES`/`MAX_DELIVERY_ATTEMPTS = 5`; requeue-reason vocabulary and unknown-outcome marker lists identical |
| Capability table (TS ↔ Go) | line-by-line comparison of `src/lib/routing.ts` and `agent/internal/printer/capability.go` | see R4 — the Go table is a superset only in branches unreachable given `CONNECTION_TYPES` and `validatePrinterTransportProtocol`; the gateway remains the enforcement point |
| WebSocket delivery path | `src/server/ws.ts` claim/push/report flow | reuses the shared fenced library (`claimJobForDelivery`, `markJobDelivered`, `releaseUndeliveredClaim`); no duplicated state machine; naive-UTC → RFC3339 conversion is guarded |
| Entitlements / billing gate | `src/lib/entitlements.ts` | `FOR UPDATE` on the subscription row while granting runtime access; the two live-subscription predicates are exact mirrors (one `EXISTS`-wrapped); every expiry comparison uses `clock_timestamp()` |
| Database clock authority | `src/lib/database-clock.ts` + all expiry SQL | no JS `Date.now()` comparison decides a lease/expiry; naive DB timestamps parsed as UTC |
| Payload contract | `contracts/print-payload-contract.json` ↔ `src/lib/payload.ts` ↔ Odoo | single JSON source consumed by the Zod schema; canonical base64 enforced; Odoo never parses gateway wall-clock timestamps (monotonic only), so no ms/s confusion exists to find |

## 7. Evidence-backed risks (no change made — reported, not patched)

- **R1 — N+1 query in `getAllPrintersCapabilityMatrix`** (`src/lib/printer-health.ts`):
  one full tenant scan, then one `queryWithTimeout(..., 3000)` per printer.
  Latency grows linearly with fleet size on a UI-facing endpoint.
  Correctness unaffected. *No fix applied (backend behaviour is out of scope for
  this pass).*
- **R2 — untyped capability reads** (`src/lib/printer-health.ts`):
  `paperWidths: config.paper_widths ?? …` and `duplexCapable: config.duplex_capable ?? …`
  accept non-array / non-boolean values from the agent-reported JSON and pass
  them through under a `number[]` / `boolean` type.
- **R3 — pytest dependency gap** (`ci.yml:144`): the step installs only
  `pytest` + `pytest-asyncio`, but 6 tests import
  `cryptography` (via `odoo_addons/print_gateway/models/crypto.py`, which does
  `from cryptography...aead import AESGCM` at module import). Those 6 tests fail
  in this sandbox for that reason alone; whether CI's runner image preinstalls
  `cryptography` is unverified here.
- **R4 — inaccurate "mirrors EXACTLY" claim** (`agent/internal/printer/capability.go`):
  Go's `declared()` accepts `family == protocol` as a fallback that the gateway
  table does not. Every such branch requires a combination the gateway rejects
  (`conn=ipp|ipps` with a non-matching protocol, or `conn=spooler` with a byte
  protocol), so it is unreachable today, and the direction is safe (Go looser ⇒
  the gateway still rejects first). It becomes reachable if the connection-type
  vocabulary ever grows.

## 8. Unverified — cannot be exercised in this environment

- **Go**: `go vet`, `go test -race`, `govulncheck`, `staticcheck -checks=U1000`,
  `gofmt -l .` (no Go toolchain). The agent-side analysis is by source reading
  only.
- **Postgres**: `db:migrate`, the SQL schema assertions,
  `npm run test:integration` (+ `RUN_MULTI_INSTANCE_TEST=1`), `test:e2e`
  (no PostgreSQL, no Docker).
- **Odoo 19 runtime addon tests** (`--test-tags=/print_gateway`) — no Docker.
- **Browser/Playwright verification** — unavailable and TLS-blocked; no visual
  or interaction assertions were executed.
- The 6 `cryptography`-dependent tests (R3).

## 9. Verification performed after the fixes

```
npm run typecheck   → clean
npm run lint        → clean
npm run test:unit   → 90 files passed / 1 skipped · 681 passed / 6 skipped
                      (was 679 passed; +2 new regression tests)
npx next build --webpack (prod env vars)  → succeeded, all routes compiled
```

Python contract files (CI set, run directly since `pytest` is not installable
here — same functions, same assertions):

```
tests/test_odoo19_printing_static.py     → 40 / 40 passed
tests/test_security_contracts.py         → 40 / 40 passed
tests/test_final_security_hardening.py   → 45 tests, 6 blocked by R3 only
```

Targeted re-runs after each fix: `job-status`, `physical-outcome`,
`production-hardening-contract`, `production-fixes-contract`,
`architecture-hardening` → 101/101 passed.

## 10. Change set, git status, follow-ups

### Files changed in this audit (6)

| File | Change |
| --- | --- |
| `src/lib/job-status.ts` | allow `claimed → success` (+ contract docblock) |
| `tests/job-status.test.ts` | 2 new regression tests (explicit case + agent-source sweep) |
| `tests/production-hardening-contract.test.ts` | updated the pinned transition table with rationale |
| `src/app/dashboard/dashboard-client.tsx` | reprint eligibility matches the server; restored pinned callout copy |
| `src/app/settings/page.tsx` | removed the dead-end `/billing` CTA |
| `src/components/AppShell.tsx` | `ConsoleBrand` lockup with constant product subtitle |

### Git

```
commit 4953ed1  fix(jobs): accept the agent's terminal re-report on a live claim, plus UI contract regressions
pushed fast-forward to origin/arena/01a0f69c-oddo-print (c196b6d..4953ed1)
working tree clean
PR #109 (Yaseir 2.0 — frontend UI/UX overhaul) → OPEN, now includes this commit
```

### Follow-ups for a full-fidelity environment

1. Run the Go suites and `gofmt -l .` — the agent-side re-report paths were
   verified by reading, not by executing.
2. Run `test:integration`/`test:e2e` against PostgreSQL to exercise the
   `claimed → success` path end-to-end through the real route.
3. Confirm whether CI's runner provides `cryptography` for `ci.yml:145` (R3);
   if not, that gate is already red independently of this change.
4. Consider R1/R2 (perf + typing) as separate, behaviour-preserving work.
