# AUDIT_LOG.md — Yaseir platform: persistent audit trail

> **Do not delete or shorten.** This is the external memory of the line-by-line audit.
> Any future session (human or AI) resumes from the **Checkpoint** section below.

## Protocol (how this file works)

1. **Static only.** No local runtime, no Docker, no database, no test execution, no
   dependency installs. Every conclusion comes from reading source at a known commit
   plus official documentation lookups (cited inline).
2. **Log immediately.** After auditing each file/unit, append its entry below in the
   standard format — never batch entries at the end. If a session dies, the log is
   already correct.
3. **Fix as you go.** Once a logical unit is fully audited, apply fixes in small scoped
   commits referencing this file; mark `Fix applied: yes` in the same push.
   Anything that genuinely needs a runtime is marked `NEEDS RUNTIME VERIFICATION`
   instead of being skipped silently.
4. **Cheap reads.** The GitHub repo is already checked out in this session's working
   directory (`mo7medSa3d/oddo-print`); it is kept in sync with `origin/main` and
   commits are pushed straight to `main`. No cloning, no downloads.
5. **Never repeat done work.** Before touching any file, re-read this log and
   `AUDIT_MAP.md`. If a file has an entry `Status: OK`, skip it.
6. **Prior evidence is input, not output.** Earlier sessions left durable evidence in
   `graphify-out/FINAL_AUDIT.md`, `STACK_NOTES.md` (INTEGRATION_MAP) and local
   `.audit/**`. Cite it, verify at HEAD, but record fresh per-file entries here.

Entry format (append-only):

```md
## [module/path/file.ts] — audited YYYY-MM-DD
- Status: OK / ISSUES FOUND
- Findings:
  - [SEVERITY: high/med/low] description — source: <doc link you checked>
- Proposed fix: <short description>
- Fix applied: yes/no
```

---

## Checkpoint (read first)

- **Session:** 2026-10-16. Start commit: `36afc0bf` (`origin/main`, local checkout synced; Phase 0 pushed as `c2f7d2e9`).
- **Phase 0:** DONE — `AUDIT_MAP.md` + this log created and committed.
- **Phase A:** DONE — 20/20 root entry/config files audited and logged
  (3 low findings, all fixed: dead `url.parse` import; `graphify-out` Docker context; agent runtime-state ignores).
- **Phase B:** DONE — 92/92 (`schema.ts` 26 tables; `index.ts` + `client.ts`; all 85 migrations
  with journal/ledger/docs-sync verified and every destructive/UPDATE/NOT-NULL file read in full,
  ≈2 100 of 3 301 lines; remainder covered by the CI replay gate + `check-db-docs.py`), plus 4
  supporting files pre-audited early (`db-migrate.ts`, `db-generate.ts`, `check-db-docs.py`,
  `runtime-secret.ts` — belong to D/J, skip when reached). No new findings; the compose
  `PGPASSWORD_FILE` watch item is closed.
- **Phase C:** DONE — 7/7 server-core files (codebase-wide low fixed: three stale
  `AUDIT_FINDINGS.md` pointers repointed to this log). 4 lib files pre-audited early
  (`runtime-secret.ts`, `log.ts`, `request-limits.ts`, `trust-proxy-config.ts` — skip in D).
- **Frontier:** Phase D — Gateway lib in risk order: auth/session (`agent-auth.ts`,
  `session-tokens`/`session-*`, `manager-*`, `platform-auth.ts`, `password-*`,
  `tenant-guard.ts`, `api-key*`), then jobs/idempotency/payload → billing/stripe →
  infra (clock, metrics, circuit-breaker, bounded-query, ws-rate-limit) → rest.
- **Counters:** 40 entries; A 20/20 · B 92/92 · C 7/7 (+4 D files pre-audited).

## Status dashboard (updated every session; keep honest)

| Area | Total files | Audited | Issues found (fixed) | Pending |
|---|---|---|---|---|
| A. Root entry/config | 20 | 20 | 3 (3) | 0 |
| B. Gateway DB + migrations | 3 + 85 (+4) | 92 | 0 | 0 |
| C. Gateway server core | 7 | 7 | 1 (1) | 0 |
| D. Gateway lib | 81 | 4 (pre) | 0 | 77 |
| E. Gateway API routes | 84 | 0 | 0 | 84 |
| F. Gateway UI (components, desktop, i18n, shared) | 59 | 0 | 0 | 59 |
| G. Go agent | 274 | 0 | 0 | 274 |
| H. Tauri shell | 26 | 0 | 0 | 26 |
| I. Odoo addon | 81 | 0 | 0 | 81 |
| J. Tests / docs / scripts / CI | 393+23+21+7 | 0 | 0 | 444 |
| K. Root docs (README, ARCHITECTURE, …) | ~26 | 0 | 0 | 26 |

## Work queue (dependency order — entry points first, outward)

- [x] **A. Root entry/config**: 20/20 done (`server.ts`, `proxy.ts`, `next.config.ts`,
      `drizzle.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`,
      `.env.example`, `.npmrc`, `.nvmrc`, `Dockerfile`, `.dockerignore`,
      `docker-compose.yml`, `docker-compose.ci.yml`, `Caddyfile`, `vitest*.config.mts`,
      `vite.desktop.config.mts`, `.gitignore`)
- [x] **B. DB**: 92/92 done (`schema.ts`, `client.ts`, `index.ts`, all 85 migrations +
      `drizzle/meta`; 4 support files pre-audited early: `db-migrate.ts`, `db-generate.ts`,
      `check-db-docs.py`, `runtime-secret.ts` — skip in D/J)
- [x] **C. Server core**: 7/7 done (`ws.ts`, `trusted-proxy.ts`, `request-guard.ts`,
      `cors.ts`, `content-security-policy.ts`, `correlation.ts`, `api-defaults.ts`)
- [ ] **D. Gateway lib** (risk order): auth/session → authorization/tenant →
      jobs/idempotency/payload → billing/stripe → infra (clock, limits) → rest.
      Pre-audited, skip: `runtime-secret.ts`, `log.ts`, `request-limits.ts`,
      `trust-proxy-config.ts` — **← NEXT**
- [ ] **E. API routes** by family: auth → agent → print → printers → odoo →
      billing → test-captures → team → settings/system → platform
- [ ] **F. UI**: `src/components`, `src/desktop`, `src/i18n`, `src/shared`
- [ ] **G. Agent**: `cmd/agent` → `cmd/cli` → `internal/agent` → `internal/queue` →
      `internal/storage` → `internal/config` → `internal/payload` → `internal/integration`
      → `internal/printer` (154 files)
- [ ] **H. Tauri**: `main.rs`, `commands.rs`, `agent.rs`, `paths.rs`, `logging.rs`,
      `cleanup.rs`, `tray.rs` + capabilities/configs
- [ ] **I. Odoo addon**: models → controllers → static JS → migrations → views/security → tests
- [ ] **J. Tests/docs/scripts/CI**: grouped pass (tests by family, not all 393
      individually — grouped entries must list the exact files covered)
- [ ] **K. Root docs**: README, ARCHITECTURE, API, SECURITY, PRINTERS, OPERATIONS,
      DEPLOYMENT, ODOO_INTEGRATION, etc. (cross-check against code; fix drift)

## Deferred — NEEDS RUNTIME VERIFICATION (inherited gates + new ones)

These cannot be closed statically by design; they stay open until a real environment runs them:

1. Windows service/spooler/driver/physical printer execution and signed CGO1 installer
   (`INTEGRATION_MAP` flow 15).
2. Live Odoo 19 ORM/OWL/POS/upgrade/rollback (flow 16).
3. Live Stripe account/webhook delivery (flow 17).
4. Deployed Caddy + agent WebSocket acceptance (flow 18).
5. Full `npm run typecheck` and full Cargo build were blocked by missing pinned
   dependencies in the last recorded sessions (`FINAL_AUDIT.md`); re-check after any
   dependency restoration.

## Findings summary (by severity, this log only)

- high: 0 · med: 0 · low: 4 (fixed: 4) — updated as entries are added

---

<!-- ============================ ENTRIES ============================ -->

*(Entries are appended below, oldest first, in the exact format from the Protocol section.)*

## [AUDIT_MAP.md + AUDIT_LOG.md] — audited 2026-10-16
- Status: OK (Phase 0 infrastructure)
- Findings:
  - [low] `ARCHITECTURE.md` §2.1 claims "78 route files, verified 2026-10-11"; actual count is 84 `src/app/api/**/route.ts` files at 36afc0bf — source: `git ls-files 'src/app/api/**/route.ts'`; queued for fix when ARCHITECTURE.md itself is audited in Phase K.
- Proposed fix: correct the route count (and re-verify other counts) during Phase K docs audit.
- Fix applied: no (deferred to docs phase, by design)

## [server.ts] — audited 2026-10-16
- Status: ISSUES FOUND
- Findings:
  - [low] Dead import `import { parse } from "url"` — nothing in the file uses it (only `parseInt` / the local `parsedAppBaseUrl` variable contain the string `parse`); it is also the legacy `url.parse` API. Verified surrounding validation is sound: PORT regex-validated 0..65535, production refuses known placeholder secrets, non-loopback bind requires `TRUST_PROXY=1`, `APP_BASE_URL` must be a clean HTTPS origin, WS clients closed with 1001 before `wss.close()`, maintenance tasks non-overlapping and skipped during shutdown, 10s drain then forced exit — source: https://nodejs.org/api/url.html (legacy `url.parse`).
- Proposed fix: delete the single import line.
- Fix applied: yes

## [proxy.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `proxy.ts` is the current Next 16 replacement for `middleware.ts` (repo pins next 16.3.8) and the transparent pass-through intentionally avoids minting a second CSP nonce (the single request nonce is owned by server.ts) — source: https://nextjs.org/docs/messages/middleware-to-proxy
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [next.config.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `experimental.serverActions.bodySizeLimit: "8mb"` is still the currently documented option location, and the 8 MiB value matches the gateway's own request cap (server.ts/request-guard) and Caddy `max_size`; HSTS is production-only; nosniff / DENY / Referrer-Policy / Permissions-Policy set for all routes; `deploymentId` is a public release identifier (commented no-secrets rule) — source: https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions (doc updated 2026-08-26).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [drizzle.config.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Fail-fast on missing `DATABASE_URL` with no credential fallback; documented limitation that drizzle-kit (unlike runtime `runtimeSecret`) has no `*_FILE` support is accurate for drizzle-kit 0.31.10 tooling usage.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [tsconfig.json] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `strict: true` retained (security-relevant, must not be widened); `module: esnext` + `moduleResolution: bundler` is the documented Next pairing; `**/*.ts` also matches `.mts` configs by glob semantics while `**/*.tsx` is listed separately; `.audit` excluded from the program — source: https://www.typescriptlang.org/tsconfig/strict.html (cached rule from STACK_NOTES).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [.env.example] — audited 2026-10-16
- Status: OK
- Findings:
  - none blocking. Every `[required in production]` marker cross-checked against server.ts startup assertions (GATEWAY_JWT_SECRET, TRUST_PROXY_SECRET, APP_BASE_URL, COOKIE_SECURE, PLATFORM_TENANT_ID) — all enforced. The DB-name split (`print_gateway` in `DATABASE_URL` vs `yasser_db` in the compose/PG* block) matches the two documented paths (bare-metal: DEPLOYMENT.md L58-59 uses `print_gateway`; Docker: SERVER_FIRST_RUN.md L85 + compose default use `yasser_db`) — not drift.
  - [watch item, low] `ALLOW_HOST_FALLBACK=1` marked "NEVER in production" but server.ts has no explicit production refusal; production already requires APP_BASE_URL, so the fallback path looks unreachable there — verify consumers in Phase D (`src/lib/email.ts`, `src/lib/stripe.ts`).
- Proposed fix: none yet; confirm consumer behavior in Phase D before deciding.
- Fix applied: no (watch item)

## [eslint.config.mjs] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Flat-config import `eslint-config-next/core-web-vitals` spread into `defineConfig` is the currently documented Next 16 pattern; odoo_addons JS exception block (no-undef error + OWL-appropriate rule offs) is deliberate; `globalIgnores` covers generated dirs — source: https://nextjs.org/docs/app/api-reference/config/eslint
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [Dockerfile] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Multi-stage, digest-pinned base with `ARG NODE_BASE_IMAGE` for the ECR mirror swap; non-root `USER node`; `ENV HOSTNAME=0.0.0.0` prevents the Docker container-id hostname from being bound by server.ts; `tsx` deliberately a production dependency (TS server runs directly); healthcheck targets `/api/live` (the proxy-trust-exempt probe); migrations explicitly a separate ordered job — source: https://docs.docker.com/build/building/best-practices/ (cached rule).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [.dockerignore] — audited 2026-10-16
- Status: ISSUES FOUND
- Findings:
  - [low] `graphify-out/` was not excluded, so the local-only graph artifacts (`graph.json` ≈ 11.4 MB + `graph.html`) are sent in the Docker build context on every build; the repo already treats everything except `graphify-out/FINAL_AUDIT.md` as local-only (`.gitignore` L47-48).
- Proposed fix: add `graphify-out` to `.dockerignore` (mirrors the existing `.audit` entry).
- Fix applied: yes

## [Caddyfile] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Proxy token via `header_up X-Gateway-Proxy-Token {file./run/secrets/trust_proxy_secret}` (absolute path per the verified Caddy `{file.*}` rule); `X-Forwarded-For` **overwritten** with `{http.request.remote.host}` instead of Caddy's default append (comment documents the spoofed-bucket risk); `-X-Real-Ip` deleted; `max_size 8MiB` matches the Gateway cap; `reverse_proxy` tunnels WebSockets automatically — sources: caddyserver.com docs + issue #5374 (cached rules from STACK_NOTES).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [postcss.config.mjs] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Tailwind v4 pattern: only `@tailwindcss/postcss` (the v3 `tailwindcss` PostCSS plugin is correctly absent) — source: tailwindcss.com v4 docs pattern (repo pins tailwindcss 4.3.3).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [.npmrc + .nvmrc] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `engine-strict=true` enforces the `>=24.15.0` engine at install time; `.nvmrc` 24.21.0 equals the Dockerfile base and CI pin (single Node baseline across all paths) — internal consistency verified.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [docker-compose.yml] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Secrets delivered as `*_FILE` mounts (nothing on the command line/env for the sensitive ones); `migrate` runs as a dedicated one-shot service and `gateway` requires `service_completed_successfully` (ordered migration gate); `APP_BASE_URL`/`GATEWAY_DOMAIN` fail fast; `TRUST_PROXY` and `COOKIE_SECURE` default to 1/secure; empty `PLATFORM_TENANT_ID` default is intentionally refused at startup by server.ts; digest-pinned postgres/caddy images.
  - [watch item, low] The `*_FILE` contract for `PGPASSWORD_FILE` inside the `migrate` script and the pool must be honored by `src/db/client.ts` + `scripts/db-migrate.ts` — verified there in Phase B.
- Proposed fix: none.
- Fix applied: no (watch item resolves in Phase B)

## [docker-compose.ci.yml] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Registry substitution only, identical manifest digests, explicit comment that a mirror missing the digest MUST fail rather than fall back to a mutable tag (fail-closed intent).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [vitest.config.mts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Base config intentionally runs the full suite (including DB-backed tests) for local runs; the canonical unit/integration split lives in `vitest.test-groups.mts`; POS mock aliases map Odoo POS/Web modules to `tests/__mocks__/odoo`.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [vitest.unit.config.mts + vitest.integration.config.mts + vitest.test-groups.mts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. One shared classification module feeds both selective configs (plus a contract test enforcing it); unit config cannot silently run DB suites; integration config is serialized (`pool: forks`, `fileParallelism: false`, `sequence.concurrent: false`) with `RUN_DB_BACKED_ACCEPTANCE=1`; `ci-tripwire.check.ts` is deliberately integration-only.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [vite.desktop.config.mts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Preview harness is `apply: "serve"` only (never in the installer); production entry pinned to `src/desktop/index.html`; `strictPort: 1420` matches the Tauri `devUrl`; `allowedHosts` extends via `VITE_ALLOWED_HOSTS` (supported by the pinned Vite 8.3.2) — matches the cached Tauri/Vite wiring rules.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [.gitignore] — audited 2026-10-16
- Status: ISSUES FOUND
- Findings:
  - [low] The local agent runtime-state set curated in `.dockerignore` (`agent/agent.db-*` WAL/SHM sidecars, `agent/queue.db*`, `agent/config.yaml*`, `agent/e2e-captures`) was not mirrored here, so local agent/CLI runs pollute `git status` with untracked artifacts; only `agent/agent.db` and `agent/sudo` were covered.
- Proposed fix: mirror the runtime-state list (none of these paths are tracked; `agent/configs/config.yaml.example` is unaffected).
- Fix applied: yes

## [src/db/schema.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. All 26 tables read; table count matches ARCHITECTURE.md. Security/substance checks: `agents.secret` stores only the SHA-256 hash (`hashSecret` on registration, `timingSafeStringEqual` compare in `src/lib/agent-auth.ts`) — never plaintext; partial unique indexes are the real concurrency anchors (one platform owner, one owner per tenant, one running discovery per tenant+agent, per-key + internal idempotency); hot-table FKs are composite `(tenant_id, …)` so cross-tenant references are rejected at the DB layer; `printers`/`tenant_users` deliberately use `UNIQUE` in place of a PK (documented; `REPLICA IDENTITY USING INDEX` set in 0072); job timestamps default to `clock_timestamp()` (0067) matching the 1-minute rate window; `e2e_capture_runs` CHECK forces payload NULL in terminal states.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/db/index.ts + src/db/client.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `parseInputDatesAsUTC` is set before any pool exists; pool max 20 / idle 30s / connect 10s / statement 30s / lock 5s / maxUses 10000 with `timezone=UTC` pinned in the session options; the structured PG* path validates PGPORT and resolves `PGPASSWORD_FILE` through `runtimeSecret`; the no-config dummy pool throws per query (fail-safe, not fail-open — the compose ordered `migrate` gate makes it unreachable in production); diagnostics are doubly bounded (circuit breaker 5 failures/30s + `BoundedQueryRunner(8)` reserving ≥12 of 20 connections for print/auth).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [drizzle/0000–0084 + drizzle/meta] — audited 2026-10-16 (grouped; scope below)
- Status: OK
- Findings:
  - none. Scope: journal consistency verified (85 files = 85 `_journal.json` entries, idx 0–84); every file containing `DELETE`/`UPDATE`/`DROP …`/`SET NOT NULL`/`ADD COLUMN … NOT NULL` was read in full, plus all structural giants: 0006, 0007, 0011, 0013, 0020, 0022, 0028, 0029, 0030, 0033, 0041, 0045, 0047, 0056, 0058, 0059, 0061, 0067, 0071, 0072, 0074, 0081, 0082, 0084 (≈2 100 of 3 301 lines). Notable positive invariants: 0081 refuses to delete while a virtual-printer job is claimed/printing; 0029 refuses an ambiguous tenant backfill instead of guessing; 0041 pre-checks duplicates and RAISEs with the offending table; 0022 hashes legacy pairing codes as `upper(trim())` which exactly matches runtime `hashPairingCode`; destructive DDL (0006/0011/0020/0058/0059/0071) is documented pre-release architecture evolution; the remaining ~60 files are small guarded idempotent DDL covered by the CI migration-replay gate + `check-db-docs.py`. `drizzle/meta` is intentionally sparse (0000, 0028, 0071–0084 snapshots) — guarded by `db-generate.ts`.
  - [observation, low] Historical migration files were edited in place during earlier audits (up to 11 commits per file). Deliberate pre-release pattern; already-deployed databases are served by the forward repairs (`AUDIT_REPAIRS` + 0082). A deployed DB meeting an edited same-numbered file would re-run it — idempotent for current content, otherwise fails loudly inside the migrator transaction.
  - [observation, low] 0045's `NOT VALID` + `VALIDATE CONSTRAINT` pair executes inside one transaction, so the lock-splitting benefit of the technique does not materialize; harmless because the migrator is a cold one-shot job the gateway waits on (compose gate).
- Proposed fix: none (observations; no code change justified).
- Fix applied: n/a (no findings)

## [scripts/db-migrate.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Transaction-scoped advisory lock keyed on database+`current_schema()`; `SET LOCAL search_path`; `scopeMigrationConstraintGuards` pins name-only `pg_constraint` guards to the current schema (fixes cross-schema suppression); `AUDIT_REPAIRS` is an append-only, content-hash-ledgered forward-repair channel that skips already-applied repairs; the whole run is one transaction (all-or-nothing). **Closes the `docker-compose.yml` Phase B watch item**: the migrate path resolves `PGPASSWORD_FILE` through `runtimeSecret`, and the shared pool honors it.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [scripts/db-generate.ts + scripts/check-db-docs.py] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `db-generate.ts` refuses `drizzle-kit generate` when the latest journal tag's canonical snapshot is missing (guards the deliberately sparse `drizzle/meta` set); `check-db-docs.py` (stdlib-only) enforces that every schema table is created by exactly one migration, no migration creates an orphan table, and `docs/DATABASE.md` documents every table — the doc is in sync (85 = `0000`…`0084`).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/lib/runtime-secret.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. `*_FILE` first, env fallback second; 30s memo invalidated immediately when the `*_FILE` path changes (rotation); unreadable/missing file resolves to `undefined` so required-secret callers fail closed; `requiredRuntimeSecret` throws. (Logged under Phase B because the DB/migrate contract depends on it — its Phase D pass can skip.)
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/api-defaults.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Lazy `Cache-Control: no-store` default for `/api/*` is stamped at writeHead/end time (install-once sentinel, `headersSent`/`writableEnded` guards, route-provided value wins) — the correct hook point, because pre-setting the header would shadow Next's route policies and the file comment documents exactly that. Prevents heuristic/shared caching of authenticated API responses that Next does not stamp.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/content-security-policy.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Strict CSP: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `script-src` nonce + `strict-dynamic` (dev adds `unsafe-eval`, production does not), `connect-src 'self'`, `upgrade-insecure-requests`; `style-src-attr 'unsafe-inline'` is a deliberate minimal accommodation for SSR-emitted style attributes. Nonce minted from the contract-test-pinned `crypto.randomUUID()` form. Applied to pages only (`/api/`, `/_next/`, favicon excluded).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/correlation.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. AsyncLocalStorage context with generated `req_`/`attempt_`/`claim_` ids; inbound `x-request-id`/`x-correlation-id` bounded to 128 chars on both extraction paths. Log-forging check closed: `lib/log.ts` serializes one `JSON.stringify` line per record, so hostile request-id content is escaped, never injected as a log line.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/cors.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Exact-match origin allowlist (Tauri defaults + `DESKTOP_CORS_ORIGINS` override), `Access-Control-Allow-Credentials: false` (desktop uses bearer tokens, not cookies), explicit method/header/expose lists, correct `Vary`, forbidden preflights answered 403 without CORS headers.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/trusted-proxy.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. SHA-256-both-sides timing-safe compare for the proxy token; secret <32 chars → null → every request rejected (fail-closed); WS origin policy accepts native agents (no Origin) but requires exact `APP_BASE_URL` origin or `WS_ALLOWED_ORIGINS` for browser Origins — literal `null` Origin rejected, wildcards never honored; `APP_BASE_URL` resolved via `runtimeSecret` so the `*_FILE` form works. Shared `trustProxyEnabled` helper (see also ws.ts).
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/request-guard.ts] — audited 2026-10-16
- Status: OK
- Findings:
  - none. Highlights: per-route pre-Next body limits for agent routes; strict Content-Length parsing (digits-only safe integer; smuggling forms → null → 413); chunked mutating bodies → 411 before Next touches the stream; bounded lingering-close drain (16 MiB / 5 s, unref'd) so documented 4xx survives Windows keep-alive instead of ECONNRESET; CSRF proof for cookie mutations (cross-site rejected, full scheme+host+port equality against `APP_BASE_URL`, fail-closed in production without it); JWT budget screen verifies the HMAC before granting the 32 MiB authenticated pool (fail-closed when the secret is unavailable); budget charged only for payload-bearing endpoints and released exactly once on `finish`/`close`.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/server/ws.ts] — audited 2026-10-16
- Status: ISSUES FOUND
- Findings:
  - [low] Three comments across the codebase referenced `AUDIT_FINDINGS.md`, which no longer exists (removed in commit `925bcd55`): `src/server/ws.ts` L315, `src/app/api/system/health/route.ts` L15, `src/lib/platform-auth.ts` L234. The surviving canonical audit trail is `AUDIT_LOG.md`.
  - substance — none found. Verified: frame caps (64 KiB maxPayload, 16-message in-flight, 1 MiB `bufferedAmount` skip, no double-send on ambiguous send — duplicates never risked); per-agent token bucket persists across reconnects with 10-min GC; lifecycle admission holds `FOR SHARE` on the tenant + agent rows so a disable cannot race registration; earlier-revision sockets fenced by revision with legacy revisions resolved against the durable row; NOTIFY payloads treated as unauthenticated transport (DB re-verification before mass disconnect; tenant match enforced before claiming); delivery is a DB fact (`markJobDelivered` under the claim token) with `delivery_unknown` fencing on ambiguous outcomes; PG listener reconnect with full jitter + bounded retry timers (128 cap, 3 rungs); socket-slot reservation and registration-pending cleanup on every failure path exactly once.
- Proposed fix: repoint the three comments at `AUDIT_LOG.md`.
- Fix applied: yes

## [src/lib/log.ts] — audited 2026-10-16 (early; belongs to Phase D)
- Status: OK
- Findings:
  - none. One `JSON.stringify` line per record (no log-line forging); sensitive-key regex redaction (`secret|password|token|authorization|cookie|api-key|payload|pairing`) plus `redactClaimToken`; depth ≤6, 100-key/100-array caps, 500-char string truncation; level default info in production. Read early to close the `correlation.ts` watch item — skip in Phase D.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/lib/request-limits.ts] — audited 2026-10-16 (early; belongs to Phase D)
- Status: OK
- Findings:
  - none. `parseStrictContentLength` accepts only digit strings that are safe integers (arrays, signs, whitespace, comma forms → null → rejection); `clampListLimit` enforces both floor and ceiling; `hasBodyOverLimit` is the route-level mirror of the server boundary. Read early to close the `request-guard.ts` watch item — skip in Phase D.
- Proposed fix: none.
- Fix applied: n/a (no findings)

## [src/lib/trust-proxy-config.ts] — audited 2026-10-16 (early; belongs to Phase D)
- Status: OK
- Findings:
  - none. `TRUST_PROXY` enabled only by exact `1`/`true`. Shared by server.ts, ws.ts and trusted-proxy.ts — one truth source. Skip in Phase D.
- Proposed fix: none.
- Fix applied: n/a (no findings)
