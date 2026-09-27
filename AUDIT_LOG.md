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
- Totals this file: files audited: 27 | issues high: 0 med: 3 low: 21 | fixed: 0 | deferred runtime: 0.

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
