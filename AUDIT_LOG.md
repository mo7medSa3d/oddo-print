# AUDIT_LOG.md — Persistent audit trail, session 4 (2026-09-27)
> External memory. Append per file, immediately. Never batch at end.
> Prior trail (DO NOT duplicate): `AUDIT_FINDINGS.md` (full file-by-file audit v1+v2+v3, all boxes checked per PATCH_LOG close-out) + `PATCH_LOG.md` (Part B fix evidence, 4000+ lines).
> This file continues from there: it records only NEW sessions/deltas. Format per file below matches the brief.
> Severities: high (security/correctness/data-loss), med (bug-prone/perf/contract drift), low (style/dead code/stale comment).
> `NEEDS RUNTIME VERIFICATION` = cannot confirm without Docker/Postgres/Odoo/printer (no runtime per constraints).

## Summary
- Status: IN PROGRESS — session 4 (2026-09-27, ~22:57 UTC). Setup + batch 1 (gateway entry/server/DB foundation) audited. No code fixes applied yet.
- Prior state at session start: HEAD `95ea4688`; `AUDIT_FINDINGS.md` all `[x]` (0 open boxes); `PATCH_LOG.md` Part B close-out recorded; working tree had staged deletions of both files — RESTORED via `git restore` (no history lost). `__pycache__/*.pyc` on disk are git-ignored local artifacts (0 tracked).
- Pinned versions for doc-verification: Next 16.3.6, React 19.3.0, Drizzle 0.45.2 / Kit 0.31.10, Node >=24.15, Go 1.26, Tauri =2.11.5 / build =2.6.3, Rust 1.90 ed.2024, Odoo addon 19.0.2.10.0.
- Totals this file: files audited: 13 | issues high: 0 med: 3 low: 10 | fixed: 0 | deferred runtime: 0.

## 2026-09-27 — Session 4 setup (PHASE 0)
- Confirmed repo `mo7medSa3d/oddo-print`, branch `main` via `gh repo view` + `git remote -v`; `gh auth status` OK.
- `tools.opencode.list_mcp_resources` returned zero resources/templates — no GitHub MCP server configured; working via workspace checkout + `gh` CLI (no new clone, no Docker/DB/tests per constraints).
- Full file tree listed (`find src agent src-tauri odoo_addons drizzle contracts`, root `*.ts`) — recorded in `AUDIT_MAP.md` (created this session; no prior map existed).
- Created `AUDIT_MAP.md` + this file. Next: PHASE 1 batch 1 below.

---
<!-- Per-file entries. Newest appended at end. -->

## [gateway/server.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 med, 2 low)
- Findings:
  - [SEVERITY: med] `app.prepare().then(...)` has no `.catch` — a failed Next prepare leaves the process alive with no listener and an unhandled rejection. Source: Next.js custom-server guide (`app.prepare().then(...)` pattern, https://nextjs.org/docs/pages/guides/custom-server) — guide shows bare pattern but production hardening requires fail-fast on prepare failure.
  - [SEVERITY: low] Production `COOKIE_SECURE` guard only blocks `"0"`/`"false"` spellings (`server.ts:61`) — `"FALSE"`, `"off"`, `"no"` would pass a denylist that should be fail-closed. No doc source needed (local logic); hardening only.
  - [SEVERITY: low] `parseInt(process.env.PORT ?? "3000", 10)` (`:23`) has no NaN/range validation — `PORT=abc` fails obscurely inside `server.listen`. Local logic; hardening only.
- Proposed fix: add `app.prepare().then(...).catch(err => { logError(...); process.exit(1); })`; make COOKIE_SECURE check case-insensitive / allowlist-only; validate PORT is 1..65535 with clear error.
- Fix applied: no

## [gateway/proxy.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Pass-through `export function proxy()` + matcher excluding `api|_next/static|_next/image|favicon.ico` with prefetch-missing guards matches Next 16 proxy convention exactly — sources: https://nextjs.org/docs/app/getting-started/proxy, https://nextjs.org/docs/messages/middleware-to-proxy, CSP-with-proxy guide https://nextjs.org/docs/app/guides/content-security-policy. Deliberate single-nonce ownership by `server.ts` is documented in the file comment.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/server/content-security-policy.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - [SEVERITY: low] Nonce via global `crypto.randomUUID()` with no import (`:2`) — works (Node 19+ global + Edge) and byte-matches the official guide (`Buffer.from(crypto.randomUUID()).toString('base64')`, `script-src 'self' 'nonce-…' 'strict-dynamic'` + dev-only `'unsafe-eval'`, whitespace collapse — source: https://nextjs.org/docs/app/guides/content-security-policy), but an explicit `node:crypto` import would make the custom-server (Node-only) context obvious and survive lint rule changes. `shouldApplyPageContentSecurityPolicy` exclusions (`/api/`, `/_next/`, favicon) are correct.
- Proposed fix: `import { randomUUID } from "node:crypto"` + use it; no behavior change.
- Fix applied: no

## [gateway/src/server/correlation.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - [SEVERITY: low] `extractRequestIdFromHeaders` record-branch (`:44`) returns the raw trimmed header with no 128-char cap, while `ensureRequestId` (`:50`) caps at 128. An overlong `x-request-id`/`x-correlation-id` through the extract path can propagate unbounded into logs/DB. AsyncLocalStorage usage itself is the standard pattern.
- Proposed fix: clamp extract path to 128 chars (truncate or reject→null), mirroring `ensureRequestId`.
- Fix applied: no

## [gateway/src/server/cors.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Prior audit §2 CORS-headers gap already fixed (ALLOWED_HEADERS now carries Idempotency-Key, X-Refresh-Token, X-Request-Id with rationale comment, `:5-8`). Origin allowlist + `Access-Control-Allow-Credentials: false` + `Vary: Origin,…` + 403-JSON preflight denial is fail-closed and correct. No change since fix.
- Proposed fix: none
- Fix applied: n/a (fixed pre-session: see AUDIT_FINDINGS.md §2)

## [gateway/src/server/api-defaults.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Lazy `no-store` stamp at `writeHead`/`end` time respecting route-set `Cache-Control` is the correct remedy for Next App Router stamping no default (claim verified against Next caching behavior; rationale comment `:3-20` cites `lib/cache.ts` contract and the public `/api/billing/plans` CDN exception). Single-install guard correct.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/server/trusted-proxy.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - [SEVERITY: low] `isAllowedWebSocketOrigin` reads `process.env.APP_BASE_URL` directly (`:43`) while `server.ts` resolves the same setting via `runtimeSecret()` (supports `*_FILE` mounts). With file-mounted secrets the WS origin allowlist can be empty and browser WS handshakes 403. Hash-then-`timingSafeEqual` comparison (`:10-16`) follows Node docs best practice (source: https://nodejs.org/api/crypto.html `timingSafeEqual` for HMAC/secret comparison); null-Origin accept + explicit-allowlist-only + fail-closed missing secret are correct (ASVS comment accurate).
- Proposed fix: use `runtimeSecret("APP_BASE_URL")` in `isAllowedWebSocketOrigin` for consistency.
- Fix applied: no

## [gateway/src/server/request-guard.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - [SEVERITY: low] `guardApiRequest` (`:264`) tests `MUTATING_METHODS.includes(req.method ?? "")` without case normalization — a lowercase `post` (non-standard but forwardable by proxies) would bypass body/CSRF admission. Node always emits uppercase, so this is defense-in-depth only.
  - [SEVERITY: low] Concurrency-budget reservation covers only `/api/agent/` + `/api/print/` (`isPayloadBearingEndpoint`, `:232-235`) — large-body `/api/odoo/*` and `/api/billing/*` mutating routes are size-checked but never charge the budget. Intentional per comment (`:252-253`); flagging for re-verification when auditing those routes (potential budget bypass if any accept multi-MB payloads).
  - Verified good (no finding): HMAC-double-SHA256 + `timingSafeEqual` quick-auth classification (`:92-119`) matches Node constant-time guidance (source: https://nodejs.org/api/crypto.html); CSRF same-origin triple (Sec-Fetch-Site + Origin/Referer vs Host, fail-closed ambiguous, `:136-171`) is strong; lingering-close bounded drain (`:38-91`) matches the cited Go/nginx trade-off; 411-on-chunked + strict Content-Length + 8 MiB ceiling are correct.
- Proposed fix: `((req.method ?? "GET").toUpperCase())`; confirm odoo/billing max body sizes at route audit.
- Fix applied: no

## [gateway/src/server/ws.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - [SEVERITY: low] `websocketClientKey` (`:286-298`) trusts `X-Forwarded-For`/`X-Real-IP` whenever `TRUST_PROXY=1` without itself verifying the proxy token — safe on the current upgrade path (token checked at `:906` before use) but the helper is trust-boundary-sensitive if ever reused elsewhere. Add a comment or a `trusted` parameter.
  - [SEVERITY: low] `wss.on("connection")` message path (`:1059`) passes `ws.tenantId!` (non-null assertion) — `tenantId` is set pre-registration at `:981` from validated auth, so this is a typing-guarantee gap, not a live null. Prefer an explicit guard + close on missing identity.
  - Verified good (no finding): `noServer` + pre-auth `handleUpgrade` + manual `wss.emit("connection")` after lifecycle fencing matches the official `ws` noServer/client-auth pattern (source: https://github.com/websockets/ws/blob/master/doc/ws.md + npm `ws` usage examples); 30s ping/isAlive heartbeat matches the `ws` FAQ broken-connection recipe; `maxPayload: 64KiB` uses the documented option; per-agent persistent TokenBucket + in-flight cap + `bufferedAmount` skip + ambiguous-send never-retry (no duplicate physical print) + `FOR SHARE` lifecycle registration + PG LISTEN full-jitter reconnect are all correct. Prior §2 findings (console.*, interpolated event names, dead publish helpers) confirmed fixed — none remain.
- Proposed fix: comment/`trusted` flag on `websocketClientKey`; explicit `tenantId` guard in message handler.
- Fix applied: no

## [gateway/src/db/index.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 med)
- Findings:
  - [SEVERITY: med] No `pool.on("error")` listener — idle-client errors on a `pg` Pool rethrow and can crash Node if unhandled (verified: `grep pool.on src/ server.ts` returns only config lines; no listener anywhere). DB bounces would risk process crash instead of contained error. Pool options themselves (`max 20`, `idleTimeout 30s`, `connectionTimeout 10s`, `statement_timeout 30s`, `lock_timeout 5s`, `maxUses 10k`, UTC `options`) are all valid `pg`/`pg-pool` settings — sources: https://node-postgres.com/apis/client (statement/lock/connection timeouts, options), pg-pool `maxUses` docs. Timezone pinning + worker `search_path` + non-prod global caching + fail-closed dummy pool are correct.
  - [SEVERITY: low] `Number(process.env.PGPORT ?? "5432")` (`:42`) has no NaN guard — fail-closed at connect with an obscure message. Hardening only.
- Proposed fix: add `pool.on("error", (err) => logError("pg.pool_idle_client_error", ...))` (guard the dummy pool which lacks `.on` semantics — its stub `.on` returns self, so safe); validate PGPORT digits.
- Fix applied: no — NEEDS RUNTIME VERIFICATION for bounce behavior (static reasoning only per constraints)

## [gateway/src/db/client.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - [SEVERITY: low] `// @ts-ignore` on `timer?.unref?.()` (`:10-11`) masks typing instead of narrowing; `Promise.race` timeout does not cancel the underlying query (no AbortSignal) — callers must not assume cancellation. Re-export shape (`db`, `pool`) is the thin-compat shim; canonical import is `src/db/index.ts` (both exist — canonicalize on `index.ts` per AUDIT_MAP open question).
- Proposed fix: `if (typeof (timer as unknown as { unref?: unknown })?.unref === "function")` narrowing + doc comment that timeout abandons but does not abort the query.
- Fix applied: no

## [gateway/drizzle.config.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - [SEVERITY: low] Reads `process.env.DATABASE_URL` directly (`:6`) with no `*_FILE` fallback, inconsistent with runtime `runtimeSecret()` used by the app. Fail-fast on missing URL is correct (avoids silent local targeting). CLI context makes file-mount support awkward — documenting the asymmetry suffices.
- Proposed fix: comment documenting that drizzle-kit requires env (not file) + CI must export it; no behavior change.
- Fix applied: no

## [gateway/src/db/schema.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low — rest confirmed against prior audit)
- Findings:
  - [SEVERITY: low] `tenantUsers` composite identity uses `uniqueIndex("tenant_users_pk")` (`:97`) while `printUsagePeriods` uses `primaryKey(...)` (`:532`) — same intent, two mechanisms. Prior §3 PK saga resolved printers/discoveredDevices as documented-deliberate UNIQUE (CI-pinned); this residual inconsistency is cosmetic but should be normalized or commented. Drizzle composite-PK form is `primaryKey({ columns: [...] })` — source: https://orm.drizzle.team/docs/indexes-constraints.
  - [SEVERITY: low] Most FKs lack `onDelete` (only sessions/tokens/job_events cascade) — safe under the soft-lifecycle model (tenants suspended/deleted, never hard-deleted; 0074 added token cascades) but a manual hard delete could orphan rows. Confirm `tenant-lifecycle.ts` enforces ordering at lib audit.
  - Verified good (no new finding): tenant-scoped identities + composite FKs with explicit migration-short names (post-§3 fix), pairing-code partial unique, lifecycle/status/device/protocol/type/connection/management checks, `printJobs.payloadContractCheck` COALESCE two-valued guard, `clock_timestamp()` wall-clock defaults on printJobs vs `defaultNow()` elsewhere (intentional per 0067 + Postgres docs source: https://www.postgresql.org/docs/current/functions-datetime.html — `now()` = txn start, `clock_timestamp()` = wall clock), `gateway_metrics` raw-SQL declaration, audit scope check, subscription/billing partial uniques. Email case-sensitivity + payload-contract sync deferred to `customer-auth.ts` / `print-job-service.ts` route-lib batch.
- Proposed fix: normalize `tenant_users_pk` to `primaryKey` or comment the deliberate unique; verify hard-delete ordering in tenant-lifecycle audit.
- Fix applied: no
