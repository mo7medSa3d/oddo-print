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
- Totals this file: files audited: 335 | issues high: 0 med: 4 low: 33 | fixed: 0 | deferred runtime: 0.
- Note on counting: route/UI batches below re-verify files already line-by-line audited in Part B (AUDIT_FINDINGS.md). Session-4 does NOT re-do that work; it verifies currency (no changes since the fix SHAs), closes deferred follow-ups, and fully re-reads the highest-risk files. Each file still gets its own Status line.

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

## [gateway/src/lib/session-config.ts] — audited 2026-09-27
- Status: OK
- Findings: none. `LEGACY_SESSION_MAX_AGE_SECONDS` (8h) is a clearly-commented pre-cutover compat lifetime; `sessionCookieSecure()` returns true on `"1"`/`"true"`, false on `"0"`/`"false"`, defaults to `NODE_ENV === "production"`. Fail-closed in production (any unrecognized spelling → Secure). No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/console-auth.ts] — audited 2026-09-27
- Status: OK
- Findings: none. 18-line union (`manager` | `agent`), manager-first then agent-fallback, null when neither validates. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/password.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - Verified good (no finding): `crypto.argon2("argon2id", { message, nonce, parallelism, tagLength, memory, passes, version }, cb)` matches the current Node API exactly — source: https://nodejs.org/api/crypto.html (`crypto.argon2(algorithm, parameters, callback)`, `"argon2id"` variant; built-in since v24.7.0, engines pin `>=24.15.0`). Params m=65536 KiB (64 MiB), t=3, p=4, 32-byte tag, 16-byte salt = RFC 9106 SECOND RECOMMENDED option for memory-constrained environments — source: https://www.rfc-editor.org/info/rfc9106/ (first option's 2 GiB would self-DoS the gateway on login bursts). `timingSafeEqual` compare, PHC-style `$argon2id$v=19$m=…,t=…,p=…$salt$hash`, strict param pinning (fail-closed), 12-char minimum, 256-bit `base64url` opaque tokens, SHA-256 token hashing. Runtime path proven exercised (callers: register/reset-password routes, manager/platform-auth, bootstrap script, 3 test files — verified by grep).
  - [SEVERITY: low] Dual import of the same module (`import * as crypto` + `import { createHash, randomBytes, timingSafeEqual }` from `"node:crypto"`, `:1-2`) — no `no-duplicate-imports` eslint rule (verified by grep), so style-only. Merge into one import.
  - [SEVERITY: low] `verifyPassword` (`:53`) pins stored-hash params to current constants exactly — a future param bump fail-closes ALL existing hashes (users locked out until password reset). No `needsRehash`-style upgrade path. Not actionable now; document the constraint next to the constants.
  - Resolved from batch 1 (no finding): `users.email` case-sensitivity — `normalizeEmail` (trim+lowercase) is applied at every ingress (register, team invitations ×2, forgot-password, resend-verification, manager-auth ×2, platform-auth, bootstrap script — verified by grep). Login-route normalization to be confirmed in the auth-roles batch.
- Proposed fix: merge imports; add comment documenting the param-bump lockout constraint.
- Fix applied: no

## [gateway/src/lib/database-clock.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): `databaseNowMs` uses `clock_timestamp()` wall-clock authority — source: https://www.postgresql.org/docs/current/functions-datetime.html (`now()` = transaction start, `clock_timestamp()` = actual current time; same source as batch-1 printJobs finding). Midpoint RTT correction, 30s TTL, 2s timeout, single-flight dedup, failure throttling identical to success path, fail-soft offset 0 (degrades accuracy, never availability), `parseDbTimeMs` canonical single implementation (Part-B consolidation confirmed — same naive-UTC regex as `ws.ts` envelope builder, no drift).
  - [SEVERITY: low] Internal `withTimeout` (`:93-105`) timer lacks `unref` (holds the loop up to 2s if a calibration is in flight at shutdown; harmless under the 10s drain) and repeats the non-cancelling `Promise.race` pattern from `db/client.ts` (timeout abandons, does not abort). Add `unref` + comment.
- Proposed fix: `timer.unref?.()` + comment that timeout abandons but does not abort the query.
- Fix applied: no

## [gateway/src/lib/agent-auth.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): 6-char unambiguous-alphabet pairing codes (`randomInt` CSPRNG, normalized trim+uppercase hash/compare); 192-bit `base64url` secrets; plain SHA-256 for secret/pairing-code hashing is correct (high-entropy random values, not passwords — no KDF needed); `timingSafeStringEqual` hashes both sides to fixed digests before compare (length-oracle hardened, same pattern as `trusted-proxy.ts`); `validateAgent` splits `agentId:secret` on the FIRST colon (colon-bearing secrets preserved), checks `lifecycle === "active"` + tenant gate. Parameterized Drizzle `eq()` — no injection surface.
  - [SEVERITY: low] Imports from bare `"crypto"` (`:4`) while the rest of the codebase uses `"node:crypto"` — Node docs use the `node:`-prefixed form consistently (source: https://nodejs.org/api/crypto.html, all examples `import … from 'node:crypto'`). Behaviorally identical; consistency-only.
- Proposed fix: `from "node:crypto"`.
- Fix applied: no

## [gateway/src/lib/odoo-auth.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): dual Bearer/`x-api-key` intake with `odoo_` prefix gate; rotation-grace state machine (revoked + future `readOnlyUntil` → read-only, else deny) matches migration 0064/0065 intent; `lastUsedAt` fire-and-forget with `.catch` logging never breaks auth; credential-validity vs integration-enabled separation is deliberate and documented (config/health stay callable to re-enable); tenant gate with health-probe opt-out.
  - [SEVERITY: low] `timingSafeEqualStr` (`:13-18`) early-returns on length mismatch, unlike the hash-then-compare pattern in `agent-auth.ts:45-54` and `trusted-proxy.ts:10-16`. Harmless in practice (both sides are fixed 64-char hex digests) — consistency-only; normalize to the hashed pattern so the next reader doesn't copy the weaker form.
- Proposed fix: hash both inputs to SHA-256 digests before `timingSafeEqual`, mirroring `agent-auth.ts`.
- Fix applied: no

## [gateway/src/lib/authorization.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Pure RBAC matrix; role set matches `tenant_users` check constraint (`owner/admin/operator/viewer/integration_admin/billing_admin`); privilege ladder is sane (viewer read-only, operator +jobs/test, admin everything but `tenant.update`, owner all, billing_admin billing-only, integration_admin bindings+integrations). `?? false` on unknown role is fail-closed. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/tenant-guard.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): strict `!== "active"` denial mirrors the transactional `FOR SHARE` fence (prior §2 fallthrough fix confirmed in place `:99-101`); `requireActiveTenantOrNull` rethrows unexpected DB/transport errors (fail-visible); unknown-tenant → deleted-denial is documented.
  - [SEVERITY: low] Two stacked JSDoc blocks (`:52-67`) describe the same function — the first (`:52-60`) is a stale leftover from the pre-fix edit. Merge into one.
- Proposed fix: delete the stale block, keep the lifecycle/OrNull contract doc.
- Fix applied: no

## [gateway/src/lib/tenant-lifecycle.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Single authoritative transition with `FOR UPDATE` serialization, closed transition table (`deleted` terminal), mandatory reason, platform-tenant protection (fail-open only when `PLATFORM_TENANT_ID` unset — already fail-closed at boot by `server.ts:65-69`), `clock_timestamp()` ordering, session/family revocation + `pg_notify` on suspend/delete, in-transaction audit event, lost-update detection (`updated.length !== 1`).
- Resolved from batch 1 (no finding): hard-delete orphan risk — there is NO hard-delete path (deletion is a soft `lifecycle='deleted'` state; no `DELETE FROM tenants` exists), so FKs without `onDelete` cannot orphan via app flows. Manual DB surgery is out of scope.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/auth-rate-limit.ts] — audited 2026-09-27
- Status: OK
- Findings: none. DB-backed multi-instance limiter (in-memory would be bypassed by cross-instance spraying — documented): escalating account (5/10/15/20 → 0/30s/5m/15m/1h) and IP (20/30/40/50) curves, 15-min window, 24h retention cleanup, `FOR UPDATE` row locking, deterministic key sort (deadlock avoidance), parameterized `IN` lists, success-clears-budget, untrusted-proxy fail-safe (`"unknown"` shared bucket + one-time prod warning). Follow-up for route batch: callers must 429 on `retryAfterSec` carried by *allowed* reservation decisions (same pattern as `ws-rate-limit.ts`), not on the decision itself.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/customer-auth.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - Verified good (no finding): tenant-selection JWT (5-min, DB-clock iat/exp, `alg`/`typ` pinned rejecting `none`, HMAC + hashed compare, `tsel_` jti prefix, 60s future-iat tolerance); legacy-manager-cookie fallback explicitly rejects v2 tokens in the wrong cookie (no silent cross-acceptance); `issueCustomerSession` gates on tenant lifecycle. Login-normalization follow-up from batch 2a CLOSED: login route calls `authenticateForTenant` → `authenticateCustomer`, both `normalizeEmail` internally.
  - [SEVERITY: low] Membership list capped at 50 (`:186`) with silent truncation — users with 50+ memberships lose list-path access to the rest (direct-`tenantId` path still works). Document the cap or surface a `truncated` flag.
  - [SEVERITY: low] Dead re-export `export { normalizeEmail }` (`:198`) — zero importers from `customer-auth` (all callers import from `lib/password` directly or use the authenticate functions — verified by grep). Delete.
- Proposed fix: document/flag the 50-cap; delete the re-export.
- Fix applied: no

## [gateway/src/lib/session-tokens.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): refresh-token rotation with reuse detection matches current best practice — single-use rotation + immediate invalidation + whole-family revocation on reuse + atomic operations under locks + user notification — sources: OWASP OAuth 2.0 cheatsheet "refresh token rotation … to detect replay attempts" (https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html), Auth0 "Automatic Reuse Detection … invalidates the refresh token family" (https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/). Implementation: `pg_advisory_xact_lock` + `FOR UPDATE`, 5s rotation grace (concurrent double-submit rotates instead of false-alarming), 30-day absolute family TTL, per-rotation principal revalidation (tenant active, role match, email verified/unchanged), post-commit email alert, exact-TTL access tokens (`exp-iat !== 900` fails closed), kind-scoped `sub`, HttpOnly Lax/Strict path-scoped cookies, opaque 256-bit refresh tokens (SHA-256 stored). Pre-hash token lookup without kind scoping is safe (256-bit hash space) with the kind check enforced after.
  - [SEVERITY: low] `SessionTx` type via double-`Parameters` inference (`:225`) is copy-pasted in three files (`manager-auth.ts:303` as `LegacyManagerAuthTx`, `platform-auth.ts:213` as `LegacyPlatformAuthTx`). Canonicalize to one exported transaction type from `db/`.
- Proposed fix: export a single `DbTx`/`SessionTx` type and import it in all three files.
- Fix applied: no

## [gateway/src/lib/manager-auth.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - Verified good (no finding): v2/legacy dual validation with explicit cross-rejection (legacy path rejects any v2-shaped claims); v2 checks DB-clock expiry + exact TTL + family-active revocation + membership/role match + tenant gate; legacy checks durable row agreement (jti, `clock_timestamp()` expiry, JWT/row exp match); `resolveManagerTenantId` refuses to infer tenant from row counts (Host-header cross-tenant attack documented); bootstrap password has dummy-KDF timing cover for unknown users; scrypt→argon2 upgrade is compare-and-swap race-safe; email normalized on all password paths.
  - [SEVERITY: low] `revokeLegacyManagerSessionsForTenantInTransaction` (`:327-332`) uses `DELETE` while the user-scoped twin (`:314-325`) uses `revokedAt` update — destructive vs non-destructive revocation for the same table, losing session rows on tenant suspend. Prefer the revoke-update for consistency (refresh families already carry the durable revocation).
  - [SEVERITY: low] Non-null assertions on shape-validated claims (`:105`, `:259` here; same class at `customer-auth.ts:156`, `platform-auth.ts:102-103`) — safe today (validators guarantee presence per kind) but a future validator change silently becomes `undefined` downstream. Prefer explicit guards that fail closed.
- Proposed fix: revoke-update instead of delete; explicit presence guards.
- Fix applied: no

## [gateway/src/lib/platform-auth.ts] — audited 2026-09-27
- Status: OK (shared findings recorded under session-tokens/manager-auth)
- Findings: none independent. Correctly mirrors `manager-auth.ts` for the platform scope: v2/legacy dual path, family-active check bound to `userId`, `isPlatformOwner` + `emailVerifiedAt` gates on both paths, normalized login, tenant-less principal enforced both in claims shape and `validatePrincipal`. The two shared lows (triplicated tx-type inference, `!` assertions `:102-103`) are counted under session-tokens/manager-auth — not double-counted here.
- Proposed fix: none (see shared items)
- Fix applied: n/a

## [gateway/src/lib/agent-availability.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Canonical freshness gates on the calibrated `gatewayNow()` clock; `ageSeconds >= 0` lower bound present in both entry points (prior future-timestamp fix confirmed); effective printer status correctly folds parent-agent reachability before stored status; raw-status passthrough preserves unknown values instead of inventing them. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/agent-control.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - Verified good (no finding): 5-attempt uniqueness loop + per-tenant advisory lock + `max_agents` entitlement gate + `requireActiveTenantInTransaction` all inside one transaction; cross-tenant mint race is closed by the DB partial-unique (0032) fail-closed. Caller-supplied `ManagerClaims` (no cookie re-read) avoids the HTTP/Server-Action trust-boundary mismatch — documented.
  - [SEVERITY: low] Fire-and-forget audit `void writeAuditEvent(...).catch(() => undefined)` (`:84-91`) swallows even the error signal — a failing audit pipeline is invisible. Log at warn/error in the catch so audit loss is observable (keep it non-blocking).
  - [SEVERITY: low] Return shape carries both `expiresAt` and snake_case `expires_at` (`:92`) — dual-casing for the same instant invites client drift (cf. prior §1 shape-standardization fixes). Pick one canonical field.
- Proposed fix: log audit failures; single expiry field.
- Fix applied: no

## [gateway/src/lib/agent-health.ts] — audited 2026-09-27
- Status: ISSUES FOUND (2 low)
- Findings:
  - Verified good (no finding): prior fixes confirmed in place (`age < 0 → OFFLINE` at `:70` and the Gateway-check `:128`, shared `agentStaleThresholdSeconds()`, no `as any` on rows/metadata); per-query 3s timeouts with graceful `unknown` degradation; inferred-vs-observed labeling honest; `failureCount: null` with explicit NOT-MEASURED note instead of false 0.
  - [SEVERITY: low] `getAllAgentsHealth` (`:216-228`) awaits `getAgentHealth` sequentially — 3 queries per agent in series (N+1). Fine for small fleets and gentle on the 20-conn pool, but large fleets degrade linearly. Use bounded concurrency if fleet sizes grow.
  - [SEVERITY: low] `ONLINE_THRESHOLD_MS` snapshotted at module load (`:54`) while `agent-availability.ts` reads the env fresh per call — inconsistent evaluation points (env is boot-pinned in practice, so only a test-seam concern). Evaluate per call or document boot-pinned.
- Proposed fix: bounded-concurrency fan-out; per-call threshold read.
- Fix applied: no

## [gateway/src/lib/agent-lifecycle.ts] — audited 2026-09-27
- Status: OK
- Findings: none. `FOR UPDATE` + revision fencing + optimistic update predicate + post-update revision assertion close the claim/transition race; any transition nulls the secret and forces offline (session kill); re-enable re-gates billing and mints a fresh pairing code; tenant fence precedes credential mutation; `pg_notify` carries the new revision for WS fencing; audit in-transaction. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/agent-presence-maintenance.ts] — audited 2026-09-27
- Status: OK
- Findings: none. 15s convergence sweep fenced on `lifecycle/status` with NULL-`last_seen_at` coverage and env-driven threshold; historical jobs untouched. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/audit.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Metadata sanitizer redacts secret-bearing keys, enforces depth/node/item/string/byte budgets with safe fallbacks on serialization failure. Broad `payload|pairing` redaction is deliberate (document content must never land in audit rows). No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/lifecycle.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Closed transition table (`retired` terminal, same-state idempotent); `lifecycleAllowsNewJobs` single predicate. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/stale-threshold.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Dependency-free by documented design (client-bundle safety); env parse clamped to 10..3600s with floor and fail-safe default; printer threshold intentionally fixed to keep UI and claim gate aligned. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/cache.ts] — audited 2026-09-27
- Status: OK
- Findings: none. `SSA-Vary` segments caller+tenant so the single public preset (`billing/plans`) cannot replay across sessions; every other data route stays `no-store` via `api-defaults.ts`. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/canonicalize.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): codepoint (non-locale) key ordering with documented rationale (locale-sensitive fingerprints fixed); recursive.
  - [SEVERITY: low] Non-plain objects are not handled: `Object.entries(new Date())` is `[]`, so a `Date` instance canonicalizes to `{}` — two different dates would fingerprint identically and could false-match idempotency. Safe only if all inputs are JSON-round-tripped before fingerprinting. Verify at `idempotency.ts` audit that no live `Date`/class instance reaches `canonicalize`.
- Proposed fix: confirm JSON-only inputs at idempotency audit; else add explicit `Date` (toISOString) handling.
- Fix applied: no

## [gateway/src/lib/job-delivery.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Claim protocol is airtight: per-agent advisory lock serializes WS/poll claim paths so the 64 in-flight ceiling (matching the agent's `maxPendingJobs`, cross-checked in comments) is a true invariant; eligibility (agent/printer/tenant/billing) re-checked under `FOR UPDATE … SKIP LOCKED`; token-minted claims with fenced evidence writes; ambiguous delivery → terminal `failed` + unknown marker (never requeued — no duplicate print); release only when zero evidence exists. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/job-fencing.ts] — audited 2026-09-27
- Status: OK
- Findings: none. TOCTOU rule (token inside the UPDATE predicate, never app-memory compare) enforced by construction; `IS NOT DISTINCT FROM` legacy-NULL semantics and strict-`=` delivery-evidence rule both documented. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/job-maintenance.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): 6 sweep statements all bounded (`LIMIT` + `SKIP LOCKED`, env override guarded — prior NaN fix confirmed `:19-20`); evidence-preserving expiry (printing/ambiguous keep fences for bounded reconciliation, pre-dispatch clears); 5-min/24-h fence cleanup; metrics only on nonzero.
  - [SEVERITY: low] The two terminal fence-cleanup UPDATEs (`:180-204`) have no `LIMIT`, unlike the other six — steady-state tiny (only ambiguous rows retain tokens), but a post-outage backlog could hold one long statement past the 30s `statement_timeout`. Add `LIMIT` for symmetry.
- Proposed fix: bound the cleanup updates (e.g. `LIMIT 200` via CTE like the others).
- Fix applied: no

## [gateway/src/lib/job-status.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Closed DB/API/physical vocabularies with the Go/Odoo mirrors cited in the header (to verify at agent/odoo batches); `success` never implies paper; late-success override is opt-in with marker + 24h age fences; agent requeue reasons are provably-pre-execution only with budgets correctly not refunded on crash-reprint. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/job-timeline.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Claim tokens persisted only as truncated SHA-256 (`claim_<12hex>`, deterministic for correlation, irreversible); correlation-context backfill; 3s timeout + never-breaks-main-flow catch; pure row-to-timeline builder. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/idempotency.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Browser CSPRNG keygen with explicit failure (no `Math.random` degradation); the MDN claim in the comment verified accurate — `getRandomValues()` is "the only member of the Crypto interface which can be used from an insecure context" (source: https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues), `randomUUID()` is secure-context-only (source: https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID). RFC 4122 v4/variant bits set correctly. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/limit-signal.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Dependency-free (`import type` only — bundle-safe) signal shape + narrow type guard, with the Next.js thrown-error-serialization constraint documented. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/metrics.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Prometheus name validation matches the spec (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`); local+DB dual counters with fail-silent writes (metrics never break requests); DB-sourced names are safe (only enter via the validated `incrementMetric`); counts interpolated are `COUNT(*)` bigints. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/log.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): claimId redaction, sensitive-key redaction, 500-char truncation, AsyncLocalStorage correlation via guarded `require` (cycle documented), JSON lines.
  - [SEVERITY: low] Minted request IDs use `Math.random()` (`:25`) — uniqueness-only in practice (clients may supply their own IDs anyway), but inconsistent with the codebase CSPRNG posture; `node:crypto` is already imported. Use `randomBytes`/`randomUUID`. (Two `(as any)` casts nearby are style-only.)
- Proposed fix: `randomBytes(8).toString("hex")` suffix.
- Fix applied: no

## [gateway/src/lib/nanoid.ts] — audited 2026-09-27
- Status: OK
- Findings: none. CSPRNG `base64url` slice is uniform for ID purposes. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/utils.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Standard `cn()` (`clsx` + `tailwind-merge`). No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/nav.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Slash-boundary prefix match (no `/agents2` false-positive); auth explicitly server-side. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/clipboard.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): secure-context fallback chain documented (LAN-over-HTTP reality), never throws, boolean contract.
  - [SEVERITY: low] Legacy path leaks the hidden textarea if `select()`/`execCommand()` throws (`:22-33`) — `removeChild` is skipped on the throw path. Wrap in `try/finally`.
- Proposed fix: `try { … } finally { area.remove(); }`.
- Fix applied: no

### Batch-2d follow-up CLOSED
- `canonicalize` Date concern: sole caller is `print-job-service.ts:69` (`payload: canonicalize(input.payload)`) where `input.payload` is JSON-parsed request body — JSON deserialization cannot produce `Date`/class instances, so the `{}` collapse is unreachable. No finding; no code change needed.

## [gateway/src/lib/printer-model.ts] — audited 2026-09-27
- Status: OK
- Findings: none. SSRF-hardened authority: private/link-local-only destinations with cloud-metadata-IP block (`169.254.169.254`, `fd00:ec2::254`); IPv6 validation hand-verified (ULA `fc00::/7` + link-local `fe80::/10` accepted via top-7 `0x7e` match, `::`/`::1` rejected, IPv4-mapped and zone-ID forms fail closed); IPP URL rules (scheme allowlist, no creds/query/fragment, IPPS requires secure scheme); port allowlists per transport; USB requires Windows device path or spooler_name; transport/protocol matrix fenced (`unknown` allowed through, everything else must pair). Zod `.strict()` + 16/32 KiB metadata caps. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/printer-capability.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): vocabularies derive from `printer-model.ts` via `import type` (bundle-safe, prior taxonomy fix confirmed); language badges derive only from protocol/connection (device class never invents a language); display-name maps complete.
  - [SEVERITY: low] `getSupportedDocumentTypes("escpos", …)` returns `[escpos, raw]` but omits `image` — while `routing.ts:105-112` (the authoritative enforcer) explicitly allows image payloads on ESC/POS devices via raster conversion. Display-only (sole caller is the `printer-health.ts` matrix; enforcement is correct), but operators see image as unsupported on thermal printers. Align the matrix with the raster exception or comment the deliberate difference.
- Proposed fix: include the escpos-raster `image` case with a comment citing `routing.ts`.
- Fix applied: no

## [gateway/src/lib/routing.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Authoritative capability table: explicit `supported_protocols` wins, malformed (non-array) caps fail closed, `unknown`-protocol devices stay dark unless the transport is physically complete (spooler/IPP), byte transports fenced to the declared protocol, PDF/image require document-capable backends. Go mirror (`agent/internal/printer/capability.go`) cited for verification at the agent batch. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/discovery.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Discovery taxonomy kept explicitly distinct from printer protocols (commented); scan bounds (concurrency ≤64, timeout ≤30s, Zod `.strict()`); CIDR fenced to private IPv4 `/16-/30` (link-local excluded — unscannable; mirrors Go `isAllowedCIDR`); confidence heuristic sane. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/network-address.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Hand-verified bit logic (see printer-model entry); IPv4 loopback rejected, IPv6 `::`/`::1`/zone-IDs/mapped forms rejected fail-closed. The `top10 === 0x3fa` clause is a harmless redundant subset of the `top7 === 0x7e` match. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/printer-health.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): evidence-based normalization (stale → UNKNOWN, never ONLINE from stale data; future-dated rejected — same rule as agent-health/availability); spooler/driver health require explicit probe evidence, never inferred from DB status; per-query 3s timeouts.
  - [SEVERITY: low] Four `as any` casts on Drizzle rows (`:132`, `:198-200`, `:223`) discard the precise `printers` row type — the exact class removed from `agent-health.ts` in a prior fix (a renamed column would silently degrade instead of failing to compile). Plus the same sequential per-printer fan-out as `getAllAgentsHealth` (see agent-health entry). Remove casts; consider bounded concurrency.
- Proposed fix: type the rows from schema inference; bounded fan-out.
- Fix applied: no

## [gateway/src/lib/printer-virtual.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Defense-in-depth guard with the right precedence (normalized metadata → capability keys/port monitors → driver/PnP haystack → legacy name fallback); token lists cite the agent mirror (`softwareWriterTokens`/`sessionRedirectTokens` — verify at agent batch); legacy rows preserved-but-dark. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/payload.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Contract-single-sourced Zod (wire types/protocols/peripherals/sizes from `print-payload-contract.json`); canonical base64 round-trip check (correct given Node's forgiving decoder); magic-byte enforcement (`%PDF-`, JPEG SOI) with anti-mislabling (PDF-as-raw rejected); peripherals fenced to escpos; per-protocol test tickets with injection-safe escaping (C0 strip, PDF paren-escape, ZPL `^~` strip, TSPL quote-strip, 4 KiB cap). DB `CHECK` mirror already verified at schema audit. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/print-job-service.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Enqueue admission is triple-serialized (tenant → agent → idempotency-key advisory locks, consistent order — no inversion with the agent-only claim lock); owner/capability re-validated under `FOR UPDATE` row locks (closes enqueue-vs-PATCH and enqueue-vs-suspend TOCTOUs); LIKE-escaped reprint coordination; fingerprint idempotency with the Odoo/internal boundary conflict rule; credit reservation strictly after dedup (no double-charge); queue (256) / payload (128 MiB) / in-flight (64) ceilings; DB-clock expiry window (default 1h, max 24h); same-clock `createdAt` stamp; `pg_notify` dispatch; best-effort timeline with warn-level observability. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/entitlements.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Live-subscription predicates (past_due grace, NULL period-end live, blocked flag) shared by all gates; row-locked reads; atomic credit upsert (conflict-row serialization makes the quota check race-safe); per-minute/concurrent enforcement under caller-held locks; malformed-plan fail-closed with logging; `parseEntitlementDate` intentionally distinct from `parseDbTimeMs` (prior audit decision, different null semantics). No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/billing-operation.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Claim→execute→finalize with persisted idempotency keys (retry replays, never duplicates); stale-subscription-identity discard on both claim and finalize; definitive-vs-retryable Stripe error split (definitive clears the claim, ambiguous keeps it); guarded finalization applies the flip only to the owning operation. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/stripe.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 low)
- Findings:
  - Verified good (no finding): webhook verification implements the documented Stripe scheme — `t=…,v1=…` header, HMAC-SHA256 over `{timestamp}.{payload}`, 300s default tolerance, multi-`v1` support, constant-time compare — sources: https://docs.stripe.com/webhooks (timestamp-in-signature replay protection, 5-min default tolerance), https://docs.stripe.com/webhooks/signature. Calibrated-DB-clock reference (not host clock) prevents drift-induced sync stalls. Price binding cross-checks (id/type/recurring/currency/interval/product) are strict; retryable-status split (408/409/429/5xx) matches the billing-operation claim protocol; 15s timeouts on all calls.
  - [SEVERITY: low] Security-critical webhook/client code is written in minified one-liner style (`:4-5`, `:57-70`, `:167-170`) — inconsistent with the rest of the repo and materially harder to review. Reformat to one-statement-per-line (no formatter configured — no prettier in devDeps — so this is manual hygiene).
- Proposed fix: reformat `stripe.ts` to repo style; no behavior change.
- Fix applied: no

## [gateway/src/lib/system-health.ts] — audited 2026-09-27
- Status: ISSUES FOUND (1 med, 1 low)
- Findings:
  - [SEVERITY: med] `checkAgents` hardcodes `INTERVAL '90 seconds'` (`:99`) instead of interpolating `agentStaleThresholdSeconds()` — the exact display-vs-enforcement divergence class the stale-threshold consolidation (prior §2 fix) eliminated everywhere else. With `STALE_AGENT_THRESHOLD_SECONDS` set, health display disagrees with the claim gate and presence sweep. `metrics.ts` already shows the correct pattern (`make_interval(secs => $1)` with a bound param). (Prior-audit text claiming system-health "already interpolated the env" does not match current code — regression or misattribution; either way the literal is what's deployed.)
  - [SEVERITY: low] Three `as any` row casts (`:82`, `:103`, `:126`) — same class as `printer-health.ts`. Type from schema inference.
- Proposed fix: bind `agentStaleThresholdSeconds()` into the agents query; remove casts.
- Fix applied: no

## [gateway/src/lib/worker-schema.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Test-only schema isolation: production returns null; forced schemas require BOTH opt-in flags plus `test_*` naming/length guards; worker-derived names sanitized. `search_path` interpolation is safe (validated charset). No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/email.ts] — audited 2026-09-27
- Status: OK
- Findings: none. `APP_BASE_URL` via file-aware `runtimeSecret()` with HTTPS-in-prod and no-creds/query/fragment rules (consistent with `server.ts` boot checks); Resend client with 10s timeout and truncated error surfacing. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/action-error.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Trivial client-safe error carrier (status/code/details), correctly housed outside the `"use server"` module. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/runtime-secret.ts] — audited 2026-09-27
- Status: OK
- Findings: none. `*_FILE`-first then env fallback (Docker secrets convention), trimmed, empty→undefined, `requiredRuntimeSecret` fail-fast. Read fully in batch 1; consistent usage verified across `server.ts`, `email.ts`, auth modules. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/trust-proxy-config.ts] — audited 2026-09-27
- Status: OK
- Findings: none. 3-line single predicate (`TRUST_PROXY` is `"1"`/`"true"`); sole authority imported by both HTTP and WS trust paths. No finding.
- Proposed fix: none
- Fix applied: n/a

## [gateway/src/lib/request-limits.ts] — audited 2026-09-27
- Status: OK
- Findings: none. Strict decimal Content-Length parse (rejects arrays/non-digits/unsafe integers); `clampListLimit` floors at 1 (prior negative-limit fix confirmed — Postgres rejects `LIMIT -5`); `hasBodyOverLimit` fail-closed on unparsable length. No finding.
- Proposed fix: none
- Fix applied: n/a (fixed pre-session: see AUDIT_FINDINGS.md §1)

## [gateway/src/lib/ws-rate-limit.ts] — audited 2026-09-27
- Status: OK
- Findings: none. DB-backed WS-upgrade limiter (20 failures/60s window/60s lock, `FOR UPDATE` serialization, DB-clock authority, success-clears-budget, reservation-allowed-with-`retryAfterSec` contract consumed correctly by `ws.ts`). Canonical `parseDbTimeMs` import (Part-B consolidation). No finding.
- Proposed fix: none
- Fix applied: n/a

## Batch 3 — API routes (76 files) — re-verified 2026-09-27
Basis: `git log 15ab2bea..HEAD -- src/app/api` shows zero route changes beyond the Part-B fix commits themselves (HEAD adds docs only); every §1 fix confirmed present by targeted grep; `auth/login` + `billing/webhook` fully re-read line-by-line this session. Two session-4 follow-ups CLOSED: (1) `retryAfterSec`-on-allowed reservations are honored (`auth/login:39`, `auth/manager/login:79`, `agent/register:175,184`); (2) the 12 mutating routes without route-level `hasBodyOverLimit` are covered by the global 8 MiB + 411-on-chunked `guardApiRequest` ceiling plus downstream Zod/metadata caps — by design, no gap (concurrency-budget residual already logged in batch 1). No new issues in any route file.

### auth (14) — Status: OK (fixes 0d7da21e, afcb5a76, 0db704d4, 14706ddc confirmed)
- `auth/login` — READ FULLY: 64 KiB limit, 400-on-bad-JSON, reserve/clear rate limit with allowed-carries-`retryAfterSec` 429, 503 on store failure, generic credential errors, no-store. OK.
- `auth/register`, `auth/manager/login`, `auth/resend-verification`, `auth/forgot-password`, `auth/verify-email`, `auth/reset-password`, `auth/select-tenant` — token-consumption throttles + body limits + 409-replay confirmed by grep. OK.
- `auth/logout`, `auth/manager/logout`, `auth/manager/me`, `auth/manager/refresh`, `auth/me`, `auth/refresh` — probe-shape standardization (0db704d4) intact. OK.

### agent transport (4) — Status: OK (fixes 1771752d, dedb1955, ebc0cb05-context confirmed)
- `agent/heartbeat` — 400-on-malformed-JSON fix intact. OK.
- `agent/jobs`, `agent/register`, `agent/discovery` — dead-import removal intact; pairing throttle + `retryAfterSec` handling intact; discovery body limit intact. OK.

### agents console (9) — Status: OK (fixes ebc0cb05, 0db704d4, 8e1fc1b9 confirmed)
- `agents`, `agents/[id]`, `agents/health`, `agents/service-status` — limit clamp + coded Forbidden shape intact. OK.
- `agents/[id]/discovery`, `agents/[id]/discovery/[discoveryId]`, `agents/[id]/discovery/[discoveryId]/cancel`, `agents/[id]/discovered-printers/[deviceId]/verify`, `agents/[id]/discovered-printers/[deviceId]/provision` — `agentId` fence on devices query intact. OK.

### jobs / print / printers (12) — Status: OK (fixes ebc0cb05, dedb1955 confirmed)
- `jobs`, `jobs/[id]`, `jobs/[id]/reprint`, `jobs/[id]/timeline`, `print/jobs`, `print/jobs/batch-status` — clamps + dead-import removal intact. OK.
- `printers`, `printers/[id]`, `printers/capabilities`, `printers/[id]/certify`, `printers/[id]/test-connection`, `printers/[id]/test-print` — clamp + certify-import removal intact; per-protocol ticket selection (3cf36524) intact. OK.

### odoo (6) — Status: OK (fix 0db704d4 confirmed)
- `odoo/agents`, `odoo/configuration`, `odoo/health`, `odoo/keys`, `odoo/keys/[id]/rotate`, `odoo/printers` — coded-shape standardization intact; key-rotation grace semantics match `odoo-auth.ts` (batch 2b). OK.

### billing (8) — Status: OK (fixes afcb5a76, 2fe01934 confirmed)
- `billing/webhook` — READ FULLY: 2 MiB limit, deliberate-400 signature failure with pin comment intact, event validation, pre-check + `ON CONFLICT` + `FOR UPDATE` idempotency, live-snapshot retrieval with stale-snapshot fence, identity-conflict quarantine, row-locked tenant updates, in-tx audit. OK.
- `billing/cancel`, `billing/checkout`, `billing/plans`, `billing/portal`, `billing/resume`, `billing/status`, `billing/usage` — operation-claim protocol + plan pin intact. OK.

### platform (12) — Status: OK (fix d0bdc4b9-context confirmed)
- `platform/auth/login`, `platform/auth/logout`, `platform/auth/me`, `platform/auth/refresh`, `platform/audit`, `platform/plans`, `platform/plans/[id]`, `platform/stats`, `platform/subscriptions`, `platform/tenants`, `platform/tenants/[id]/reactivate`, `platform/tenants/[id]/suspend` — production `PLATFORM_TENANT_ID` boot refusal (server.ts) keeps the suspend-route fail-open branch unreachable; no drift. OK.

### team / settings / onboarding / misc (10) — Status: OK (fixes a1423c9d, 14706ddc confirmed)
- `team/invitations`, `team/invitations/accept`, `team/members`, `team/ownership` — accept throttle + 16 KiB limit intact. OK.
- `settings` — 401-for-no-claims fix intact. OK.
- `onboarding`, `health`, `live`, `metrics`, `admin/tenants/[id]/lifecycle`, `system/health` — 503-readiness fix intact; lifecycle route delegates to `tenant-lifecycle.ts` (batch 2b). OK.
- Proposed fix (batch): none. Fix applied: n/a (pre-session).

## Batch 4 — Gateway UI + Server Actions (~38 files) — re-verified 2026-09-27
Basis: `git log 15ab2bea..HEAD` on UI paths shows only the Part-B fix commits; every §4 fix re-confirmed by grep; `src/app/actions.ts` fully re-read line-by-line this session (highest-risk: raw SQL + deletes + authz). No new issues.

### `src/app/actions.ts` — READ FULLY — Status: OK
- Every action gates `requireManager()` + explicit `requireManagerPermission`; all queries tenant-scoped; `deleteAgent` hard-deletes only with zero print history (FK-safe: devices→sessions→printers→agent order, history preserved otherwise — consistent with the batch-2b "no tenant hard-delete" analysis, which concerned tenants, not history-less agents); printer lifecycle uses documented agent→printer lock order + optimistic predicate; limit trips RETURNED (not thrown) per the Next.js serialization constraint; LIKE wildcards escaped; dashboard projections exclude payload blobs (50-row cap); audit failures catch-logged. No finding.

### pages (17) + layouts/error/loading + clients — Status: OK
- `dashboard/page.tsx`, `dashboard/dashboard-client.tsx` — jobsError/retry panel + Idempotency-Key header confirmed (`:267,302-303,478,1244`). OK.
- `billing/page.tsx`, `team/page.tsx` — dotted log events + single `load()` implementation confirmed. OK.
- `system-health/page.tsx`, `release-readiness/page.tsx` (+clients) — workspace verifier + `agents.read` gate (Part-B fix) unchanged. OK.
- `login`, `signup`, `forgot-password`, `reset-password`, `verify-email`, `invite`, `onboarding`, `pricing`, `settings`, `api-keys`, `platform/*` (7), `page`, `layout`, `error`, `loading`, `not-found` — no changes since Part B; auth/layout shapes intact. OK.

### components + shared (16) — Status: OK
- `AgentHealthMatrix`, `AppShell`, `AuthShell`, `BillingActions`, `brand`, `JobCleanupButton`, `JobTimeline`, `platform/overview-charts`, `PrintCertificationWizard`, `PrinterCapabilityMatrix`, `ThemeToggle`, `TopNavbar`, `ui`, `UpgradeLimitDialog`, `shared/job-vocabulary`, `shared/components/StatusDot` — `jobTone`/`printerTone` usage confirmed; no drift. OK.
- Desktop copies (`src/desktop/components/JobTimeline.tsx` 136 lines vs `src/components/JobTimeline.tsx` 95; `src/desktop/ui.tsx` 105 vs `src/components/ui.tsx` 1077) DIFFER by design — separate Vite bundle with its own minimal primitives, not a fork to unify. Prior per-file drifts already fixed (badges, humanType). Map question CLOSED: intentional separation, managed per-file.
- Proposed fix (batch 4): none. Fix applied: n/a (pre-session).

## Batch 5 — Contract center (4 files) — audited 2026-09-27
Cross-boundary mirrors cited in gateway headers VERIFIED by side-by-side read (all local logic; contract JSON is the shared source).

## [contracts/print-payload-contract.json] — audited 2026-09-27
- Status: OK. 17 lines: v1, base64, 5 MiB, wireTypes raw/escpos/pdf/image, rawProtocols, peripheral enums, `%PDF-`/`ffd8ff` signatures. Both implementations import/mirror it (`payload.ts` reads it directly; Go constants match: 5*1024*1024 = 5242880). No finding.
- Proposed fix: none. Fix applied: n/a.

## [agent/internal/payload/payload.go] — audited 2026-09-27
- Status: OK. Mirror of `src/lib/payload.ts` VERIFIED rule-by-rule: type/protocol matrix, 5 MiB + `(Max/3)*4+8` pre-check, `%PDF-`/JPEG magic with anti-mislabling, peripheral enums + non-string hard error (Part-B fix intact) + none-means-inactive + escpos-only. Strict `StdEncoding` vs TS forgiving+round-trip-check converge on the same accept set. No finding.
- Proposed fix: none. Fix applied: n/a.

## [agent/internal/printer/capability.go] — audited 2026-09-27
- Status: OK. Mirror of `src/lib/routing.ts` VERIFIED: same family rule, same physicalPdf/physicalImage/physicalByteProtocol, same explicit-caps authority, same reason strings, same unknown-dark semantics. Edge-case encoding differs (Go `SupportedProtocolDeclared` flag vs TS property-presence) but both fail closed on malformed caps. No finding.
- Proposed fix: none. Fix applied: n/a.

## [agent/internal/printer/outcome.go] — audited 2026-09-27
- Status: OK. Mirror of `src/lib/job-status.ts` markers VERIFIED: identical 5 markers in identical order, prefix semantics both sides, sentinel message IS the wire marker with an explicit cross-change warning. Contract tests asserted on both sides per comments. No finding.
- Proposed fix (batch 5): none. Fix applied: n/a.

## Batch 6 — Go agent prod (54 files; 3 done in batch 5) — re-verified 2026-09-27
Basis: `git log 15ab2bea..HEAD -- agent/` shows only gofmt + the documented CLI-allowlist comment (Part-B items); every §5 fix marker re-confirmed by grep (COALESCE fence `:285-291`, `printerConfigFromDeviceInfo` ×2, `ExecutableDir` fallback, `ErrUseLastResponse`, `mergeDeviceInfo`, 0700 `MkdirAll`, `CreateTemp` atomic saves); `queue.go` fully re-read line-by-line this session. One new drift found (below).

## [agent/internal/queue/queue.go] — READ FULLY — audited 2026-09-27
- Status: OK. Local ledger invariants intact: WAL + single-writer + 0700 dir; `BeginPrint` transaction (insert-or-ignore → state read → success-never-reopen → same-token-duplicate `ErrAlreadyPrinting` → unknown-failed gate → COALESCE fenced update with `rows==1` assertion); outbox (`PendingTerminalReports`/`ClearClaimToken` post-2xx); `MarkInterrupted` returns only marked (Part-B fix); canonical 5-marker list identical to gateway + `outcome.go` (third copy verified). No finding.

## [agent] NEW FINDING — virtual-token drift
- [SEVERITY: low] `src/lib/printer-virtual.ts:122` lists `"vmware universal printer"` in `SESSION_REDIRECT_TOKENS`, but `agent/internal/printer/classify_device.go` `sessionRedirectTokens` lacks it (8 vs 9 entries; software-writer lists match 36/36 — verified by count+grep). No live bypass (agent miss would still be caught by the gateway guard at enqueue → 409 PRINTER_VIRTUAL), but the two authorities must agree — the exact drift class tracked by this audit.
- Proposed fix: add `"vmware universal printer"` to Go `sessionRedirectTokens`.
- Fix applied: no (queued for the fix pass)

### cmd (5) — Status: OK
- `cmd/agent/main.go`, `cmd/cli/main.go`, `cmd/cli/cleanup.go`, `cmd/cli/gateway.go`, `cmd/cli/helpers.go` — unchanged since Part B (gofmt + documented list-only-vs-single allowlist only). OK.

### internal/agent (6) — Status: OK
- `agent.go`, `desired_state.go`, `device_class.go`, `discovery_manager.go`, `heartbeat_pagination.go`, `pairing.go` — Part-B fixes intact (terminalReportMu, RegisterManual shared config, redirect policy, logged coercion); no changes. OK.

### internal/config (7) — Status: OK
- `config.go`, `paths.go`, `replace_file_posix.go`, `replace_file_windows.go`, `security_other.go`, `security_windows.go` (+`reprint_policy` test-only) — 0700 dirs, CreateTemp saves, QueueDBPath fallback intact; no changes. OK.

### internal/printer (29) — Status: OK except the 1 low above
- `classify.go`, `classify_device.go`, `discovery.go`, `discovery_other.go`, `discovery_windows.go`, `discovery_extended.go`, `network.go`, `network_discovery.go`, `ipp.go`, `ipp_discovery.go`, `snmp_discovery.go`, `wsd_discovery.go`, `usb_other.go`, `usb_windows.go`, `spooler_stub.go`, `spooler_windows.go`, `pdf.go`, `pdf_other.go`, `pdf_windows.go`, `document.go`, `image.go`, `raster_capability.go`, `registry.go`, `stable_id.go`, `health.go`, `factory.go`, `printer.go`, `peripherals.go` — LPT→spooler, merge-preserve, declared-class propagation, canonical Source vocabulary intact; no changes. OK.

### internal/queue (1 remaining) + storage (7) + testutil (1) — Status: OK
- `queue/cleanup.go`, `storage/secure.go`, `storage/secure_posix.go`, `storage/secure_windows.go`, `storage/security_other.go`, `storage/security_windows.go`, `storage/replace_file_posix.go`, `storage/replace_file_windows.go`, `testutil/mock_printer.go` — CreateTemp + 0600 + Chmod semantics intact; no changes. OK.
- Proposed fix (batch 6): the 1 low above. Fix applied: no (queued).

## Batch 7 — Tauri shell + desktop app (24 files) — re-verified 2026-09-27
Basis: `git log 15ab2bea..HEAD -- src-tauri src/desktop` shows only the Part-B commits; every §6 fix marker re-confirmed by grep (ISO-8601 `format_utc_iso8601`, malformed-line `continue`, documented allowlist asymmetry); `commands.rs:420-603` (gateway proxy core) re-read line-by-line this session. No new issues.

## [src-tauri/src/commands.rs] (partial re-read) — audited 2026-09-27
- Status: OK. Proxy core verified: no-redirect HTTP client, 8 MiB body caps on request and response, manager tokens stored Rust-side and stripped from renderer-visible bodies, strict allowlist (exact GET paths, charset-validated printer action paths, query-key allowlist with 200-char value cap), `..`/backslash rejection, PATCH unreachable for agent bearers, bounded CLI subprocess (20s, 256 KiB cap), real status codes preserved. No finding.

### Tauri (7) — Status: OK
- `main.rs`, `agent.rs`, `cleanup.rs`, `commands.rs`, `logging.rs`, `paths.rs`, `tray.rs` — Part-B fixes intact (deduplicated `control_service`, ISO-8601 logging, skip-malformed-lines, dead-filter removal, documented allowlist). OK.

### desktop app (17) — Status: OK
- `main.tsx`, `types.ts`, `ui.tsx`, `lib/ipc.ts`, `lib/printers.ts`, `components/AddPrinterDialog.tsx`, `components/AdminPrivilegeDialog.tsx`, `components/EditPrinterDialog.tsx`, `components/JobTimeline.tsx`, `components/Sidebar.tsx`, `pages/Agents.tsx`, `pages/Jobs.tsx`, `pages/Overview.tsx`, `pages/Printers.tsx`, `pages/Settings.tsx`, `preview/main.ts`, `preview/mock-tauri.ts` — Part-B fixes intact (ipc stub deletion, device_class badges, gateway-keyed agent cache, zpl/tspl options, protocol-derived Overview badges). OK.
- Proposed fix (batch 7): none. Fix applied: n/a (pre-session).

## Batch 8 — Odoo addon (69 files) — re-verified 2026-09-27
Basis: Part-B §7 + PATCH_LOG-documented post-tip commits; substance re-confirmed by grep this session (HTTPS-only `:249`, unlink archival guard `:1433`, `renderReceiptImage` export `pos_print_router.js:50`). No new issues.

### models (14) + runtime_clock + __init__ — Status: OK
- `print_intent`, `print_job`, `print_router`, `print_policy`, `binding`, `runtime_assignment`, `gateway_config`, `crypto`, `account_move`, `pos_order`, `pos_session`, `stock_picking`, `ir_actions_report` — `__call__(context=)` env API (reverted `with_context`, Part-B), `res_ids` real IDs, expired/status mapping documented, escpos-raster parity, archival unlink, HTTPS-only production. OK.

### controllers (3) + views/security/data XML (10) — Status: OK
- `pos.py`, `runtime_printers.py`, 7 views, `ir.model.access.csv`, `security.xml`, `cron.xml` — dual-binding notes, job-immortal access rules intact. OK.

### static JS/SCSS (10) — Status: OK
- `pos_print_router.js`, `pos_sale_details_router.js`, `report_interceptor.js`, `gateway_limit_dialog.js`, `gateway_config_auto_sync.js`, `runtime_agent_field.js`, `runtime_printer_field.js`, `binding_cascade_tour.js`, 2 SCSS — `fallbackUuid`, empty-filter-stays-empty, `renderReceiptImage` export intact. OK.

### migrations (17 py) + tests (8) — Status: OK
- 9 version dirs (1.1.0 → 19.0.2.10.0) + 7 contract tests — NEEDS RUNTIME VERIFICATION for live Odoo behavior (per constraints, static only); contract pins intact. OK (static).
- Proposed fix (batch 8): none. Fix applied: n/a (pre-session, NEEDS RUNTIME VERIFICATION for live-Odoo paths).

## Batch 5 — Contract center (4 files) — audited 2026-09-27
