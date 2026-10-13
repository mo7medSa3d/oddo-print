# STACK_NOTES.md — research cache (write once, reuse)

## Stack inventory (exact, from manifests)
- Node >=24.15.0; Next.js 16.3.8; React 19.3.0; TypeScript ~5.7.2; zod ^4.6.1
- drizzle-orm 0.45.3; drizzle-kit 0.31.10; pg 8.23.0 (PostgreSQL)
- ws 8.22.0; Stripe (version TBD — check src/lib/billing*)
- Go 1.26.0 (agent/go.mod), gorilla/websocket 1.5.3, gosnmp 1.44.0, zeroconf 1.0.0, kardianos/service 1.3.0, klippa pdfium 1.21.1, sqlite3, wazero, x/sys 0.48.0
- Tauri =2.11.5, tauri-build =2.7.0, Rust edition 2024 / rust 1.90
- Odoo addon version 19.0.2.13.0, depends base/web/sale/account/stock/purchase/point_of_sale, ext deps requests+cryptography
- Tailwind 4.3.3, Radix dialog 1.1.15, GSAP 3.15.0, lucide-react 1.52.0

## Per-technology notes (filled in Phase 1)

### Go agent (Go 1.26; gorilla/ws 1.5.3; DPAPI; SQLite; kardianos/service; gosnmp; Win32 spooler/SetupDi)
- gorilla/websocket: one concurrent reader + one writer max; Close/WriteControl may run concurrently with everything — ping-handler WriteControl alongside mutex-serialized WriteMessage is safe (pkg.go.dev/gorilla/websocket).
- `context.AfterFunc` (1.21+): runs in own goroutine after cancel; caller must call `stop()` or it leaks until parent cancels — `defer stopCancellation()` is the pattern (pkg.go.dev/context).
- Go 1.20+: global math/rand auto-seeded; unseeded jitter is correct.
- DPAPI CryptProtectData + CRYPTPROTECT_LOCAL_MACHINE lets LocalSystem service + desktop app share secrets file; UI_FORBIDDEN mandatory in services (learn.microsoft.com dpapi).
- SQLite queue: WAL + synchronous=FULL + single writer + busy_timeout=5000 = crash-durable pattern; MaxOpenConns(1) avoids Windows SQLITE_BUSY.
- kardianos/service: Windows SCM gives ~30s stop; 27s Stop bound + never closing SQLite while Run() is live = integrity-over-speed.
- gosnmp: Timeout is per attempt; probe ctx budget must cover Timeout*(Retries+1).
- SetupDiGetDeviceInstanceIdW sizing call: NULL buffer + ERROR_INSUFFICIENT_BUFFER two-call pattern; size in UTF-16 code units (learn.microsoft.com setupapi).
- Budgets (static-confirmed): 512 targets, 32 TCP workers, 500ms/host, 8s scan, 30s session, 10s heartbeat probe with last-known fallback.
- IPP: never follow redirects on document POST (would resend 5MB); CheckRedirect=ErrUseLastResponse everywhere. RFC 8010 printer-uri uses ipp(s) scheme over http(s) transport.
- Wire shapes: heartbeat gatewayOwnedPrinterIds must encode `[]` not null (fixed); discovery uses non-nil slices; base64 StdEncoding permissive by design (Strict would reject accepted payloads).

### Gateway backend (Next 16 App Router / Drizzle 0.45.3 / pg 8.23 / ws 8.22 / zod 4 / Stripe; verified against repo code, no web lookup needed)
- Route `Request` has no trusted peer IP; trust X-Forwarded-For only behind verified proxy token (`src/server/trusted-proxy.ts`).
- Drizzle `sql` template interpolates `${}` as bound params; `sql.join`/literal `ESCAPE '\\'` must stay literal SQL, not params.
- `FOR UPDATE/SHARE/SKIP LOCKED` + `pg_advisory_xact_lock` is the repo linearization pattern for claim/enqueue/billing races.
- Claim-token-in-`WHERE` (fenced writes) beats read-then-write; `IS NOT DISTINCT FROM` preserves legacy NULL-token rows.
- Stripe: never trust snapshot ordering; retrieve live resource, fence with `stripeStateRevision`/`stripeLastEventCreatedAt`, retry 408/409/429/5xx only.
- Webhook HMAC: `t.v1` multi-sig, `timingSafeEqual`, timestamp tolerance on DB-calibrated clock.
- WS: heartbeat ping/pong, per-agent token bucket across reconnects, in-flight cap, bufferedAmount gate, envelope < agent 8MiB read limit.
- pg `LISTEN/NOTIFY` is lossy: verify tenant/agent lifecycle in DB before acting; polling is the durable backstop.
- DB `now()` vs `clock_timestamp()` vs host clock: TTL/lease/sweep use DB time; JS uses calibrated `gatewayNowMs()`.
- `ON CONFLICT ... WHERE predicate RETURNING` for quota: empty return = limit trip, then read `used` and throw typed error.
- Auth cookies: access Lax + refresh Strict/path-scoped; refresh rotation with reuse detection + family revocation.
- Rate limits in `auth_rate_limits` (shared across instances); IP buckets skipped for unknown IPs to avoid global lockout.
- Idempotency: advisory lock per key + receipt-first lookup + fingerprint compare; mismatch = 409, never 200.
- Unknown physical outcome markers are closed vocab; `success` stays `unknown` physical outcome (no paper proof inferred).
- Contract check: wireTypes/rawProtocols/peripherals/signatures/5MiB/base64 match `payload.ts` + DB CHECK; discovery omit-absent-fields rule matched by agent/discovery zod. Minor: DB `payloadContractCheck` accepts pdf/image with missing OR `""` protocol while zod rejects explicit `""` (API stricter, no wire breakage).

### Gateway frontend (Next 16 App Router / React 19 / Tailwind 4 / Radix / GSAP; i18n en↔ar; verified against repo code, no web lookups)
- `scripts/check-i18n.ts` is the convention: en↔ar key parity, non-empty, exact `{placeholder}` match, `tc()` dot families need `base.other` fallback; `.one/.two` may drop `{count}`.
- RTL is token-driven: logical Tailwind props app-wide, `rtl:-scale-x-100` on directional icons, `document.dir` mirroring; mono/identifier spans isolated LTR.
- GSAP: dynamic import, `prefers-reduced-motion` early return + CSS kill-switch, `gsap.context().revert()` cleanup, silent catch — motion never gates content.
- Radix Dialog: `Title`+`Overlay`+`Content`, `aria-describedby={undefined}` when description-less, focus-return handlers.
- `useSearchParams` Suspense-wrapped for Next 16 static rendering. Brand/DB/identifier literals correctly uncatalogued.

### Tauri 2.11 / Docker / Caddy / GitHub Actions (verified via official Caddy docs + repo code)
- Caddy `{file./path}` is a stock global placeholder (adapt-time `{env.*}` vs request-time `{file.*}`); `{file...}` designed for Docker secrets, cached per config load (Caddy docs + issue #5374). Secret path must be absolute — relative resolves against Caddy cwd.
- `reverse_proxy` transparently upgrades WebSocket; no extra WS stanza needed. `header_up -X` deletion and `request_body max_size` are standard.
- Tauri capability `allow-*` entries must map 1:1 to registered commands; dead entries are privileged surface — removed.
- Versions pinned consistently: .nvmrc 24.21.0 = Dockerfile base = CI; Rust 1.98.1 both workflows; Tauri 2.11.x line.
- Ports/paths verified: vite 1420 = devUrl; server 3000 = EXPOSE/reverse_proxy; healthchecks hit `/api/live` (proxy-trust exempt); Tauri resource binaries = agent.rs resolver = CI outputs; Caddy `max_size 8MiB` = commands.rs 8MiB cap.

### Odoo 19 addon (OWL 3 / POS / translations; verified against odoo.com 19.0 translations doc)
- JS `_t()` never interpolates: use `sprintf(_t("...%s..."), v)` (odoo.com/documentation/19.0/developer/howtos/translations.html). 7 call sites passed args to `_t` directly → literal `%s`; fixed with msgid-preserving `.replace` so `ar.po` entries stay valid.
- Only literal strings are exportable; Python uses `_("...") % vars` (already compliant). Views export string/help/placeholder/confirm/title + text nodes; `check-odoo-translations.py` enforces occurrences, Arabic script, placeholder parity, `nplurals=6`.
- POS/OWL patterns match repo precedent: `patch(PosStore.prototype)`, `patch(SaleDetailsButton.prototype)`, `ir.actions.report handlers` registry, `fields` registry with `fieldDependencies`, `useEffect` scope subscriptions, `ir.actions.client` `display_notification`.
- Access posture kept: outbox read-only for group_user + `check_access("write")` gate + `sudo()` after scope validation; record rules per model; discovery controllers group_system-only.
- Contract: wire types/protocols/base64/5MiB/peripherals match; stored column names (`pdf/raster_jpeg/raw_cmd`) mapped in `_PAYLOAD_TYPE_MAP`; `none` peripherals omitted client-side (subset, never sent).

## INTEGRATION_MAP (Phase 3 — statuses: wired / broken / fixed / unverified; all static, runtime unverified)

| # | Flow | Status | Notes |
|---|------|--------|-------|
| 1 | agent enrollment + auth | wired | register/agent-auth reviewed; WS token bucket across reconnects |
| 2 | WS connect + heartbeat | wired* | envelope < 8MiB both sides; GO-F1 fixed `[]` fence shape; *via-Caddy path unproven (TA-F4) |
| 3 | printer discovery → inventory payload | wired | contract discoveryReport matched both sides; omit-empty rule both sides |
| 4 | Gateway validation + DB write | wired | payload.ts single-decode + DB CHECK match contract v1 |
| 5 | tenant-scoped query → dashboard list/status | wired | tenant guard reviewed; UI states polished |
| 6 | Odoo printer selection + settings | fixed | OD-F5 picker domain widened to company-wide fallback |
| 7 | print request Odoo/POS → Gateway queue + idempotency | wired | field names exact (`printerId/documentType/destination/payload/idempotencyKey/expiresAt`); Bearer auth both sides; 4h TTL < 24h cap; idempotency 409 semantics both sides |
| 8 | dispatch → Agent → spooler | wired* | claim row keys (`id/printerId/agentId/status/claimToken/payload`) match `decodeJobFields`; ack `jobId` accepted; *spooler_windows.go mostly unread — residual risk |
| 9 | status/result back → Odoo outbox/UI | wired | closed vocab queued/claimed/printing/success/failed/expired; Odoo forward-chain maps + unknown-outcome markers; GW-F4 reuse-status aligned |
| 10 | billing entitlement enforcement | wired | live-resource retrieval + revision fencing; Odoo reads Retry-After/entitlement on 429 |
| 11 | failure paths | wired* | pre-dispatch vs ambiguous error taxonomy (Odoo), claim fencing, offline fail-closed (OD-F8); *physical-printer paths need hardware |
| 12 | upgrade/rollback + deployment | wired* | versions consistent; Caddy secret absolute; *no updater/signing (TA-F5) |
| 13 | desired-state sync | wired | flat `desiredState[]` rows + base64url cursor + 64-row pages match both sides |
