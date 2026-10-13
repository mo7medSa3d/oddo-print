# STACK_NOTES.md — research cache (write once, reuse)

## Stack inventory (exact, from manifests)
- Node >=24.15.0 (deployment 24.21.0); Next.js 16.3.8; React/react-dom 19.3.0; TypeScript 5.9.3 and zod 4.6.2 (exact package-lock resolutions; manifest ^5.7.2/^4.6.1)
- drizzle-orm 0.45.3; drizzle-kit 0.31.10; pg 8.23.0 (PostgreSQL)
- ws 8.22.0; Stripe REST integration (no SDK dependency); API version selected by STRIPE_API_VERSION, otherwise account default
- Go 1.26.0 (agent/go.mod), gorilla/websocket 1.5.3, gosnmp 1.44.0, zeroconf 1.0.0, kardianos/service 1.3.0, klippa pdfium 1.21.1, sqlite3, wazero, x/sys 0.48.0
- Tauri =2.11.5, tauri-build =2.7.0, Rust edition 2024 / rust 1.90
- Odoo addon version 19.0.2.14.0 (R2 ownership migration), depends base/web/sale/account/stock/purchase/point_of_sale, ext deps requests+cryptography
- Tailwind 4.3.3, Radix dialog 1.1.15, GSAP 3.15.0, lucide-react 1.52.0
- PostgreSQL 16.15-alpine; Caddy 2.11.4-alpine (digest pinned); tsx 4.23.13, Vite 8.3.2, Vitest 5.0.3, @tauri-apps/api 2.11.1 (lockfile)

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

### Odoo 19 addon (OWL 2.8.4 / POS / translations; corrected against official 19.0 source in R2)
- JS `_t(source, ...substitutions)` interpolates `%s` and named placeholders natively; retain literal msgids and pass values as arguments. Prior `.replace` guidance was incorrect; see R2 primary-source cache below.
- Only literal strings are exportable; Python uses `_("...") % vars` (already compliant). Views export string/help/placeholder/confirm/title + text nodes; `check-odoo-translations.py` enforces occurrences, Arabic script, placeholder parity, `nplurals=6`.
- POS/OWL patterns match repo precedent: `patch(PosStore.prototype)`, `patch(SaleDetailsButton.prototype)`, `ir.actions.report handlers` registry, `fields` registry with `fieldDependencies`, `useEffect` scope subscriptions, `ir.actions.client` `display_notification`.
- Access posture kept: outbox read-only for group_user + `check_access("write")` gate + `sudo()` after scope validation; record rules per model; discovery controllers group_system-only.
- Contract: wire types/protocols/base64/5MiB/peripherals match; stored column names (`pdf/raster_jpeg/raw_cmd`) mapped in `_PAYLOAD_TYPE_MAP`; `none` peripherals omitted client-side (subset, never sent).

## INTEGRATION_MAP (continuation Phase 3 — static code evidence; runtime acceptance gates explicit below)

| # | Flow | Status | Notes |
|---|------|--------|-------|
| 1 | agent enrollment + auth | wired | register/agent-auth reviewed; WS token bucket across reconnects |
| 2 | WS connect + heartbeat | wired | envelope < 8MiB both sides; array fences, ping/pong, polling/reconnect fallback; deployed Caddy acceptance remains below |
| 3 | printer discovery → inventory payload | fixed | immutable merge preserves published snapshot evidence; taxonomy/omit-empty fields matched |
| 4 | Gateway validation + DB write | fixed | payload.ts/DB contract retained; shared driver binds raw dates in UTC across host timezones |
| 5 | tenant-scoped query → dashboard/desktop list/status | fixed | raw scanned-page cursor + allowlisted CLI/Rust headers + desktop traversal; fresh badges recompute with clock |
| 6 | Odoo printer selection + settings | fixed | fallback binding domain retained; required intent company with provable ownership migration; native translations |
| 7 | print request Odoo/POS → Gateway queue + idempotency | wired | field names exact (`printerId/documentType/destination/payload/idempotencyKey/expiresAt`); Bearer auth both sides; 4h TTL < 24h cap; idempotency 409 semantics both sides |
| 8 | dispatch → Agent → spooler | fixed | full Win32 spooler static review completed; shared single-flight gate recovers after rejected admission; attempt/claim keys unchanged |
| 9 | status/result back → Odoo outbox/UI | wired | closed vocab queued/claimed/printing/success/failed/expired; Odoo forward-chain maps + unknown-outcome markers; GW-F4 reuse-status aligned |
| 10 | billing entitlement enforcement | fixed | live-resource/revision fencing retained; UTC date binding corrects event-time fences; Odoo quota signaling unchanged |
| 11 | failure paths | fixed | structured auth outages, enumeration-safe reset persistence, stale/cancelled UI ownership; ambiguous physical outcomes still require explicit reconciliation |
| 12 | upgrade/rollback + deployment | fixed | SCM removal fails closed; selected-backup checksum; runtime secrets excluded from image context; Odoo ownership upgrade refuses ambiguity |
| 13 | desired-state sync | wired | flat `desiredState[]` rows + base64url cursor + 64-row pages match both sides |
| 14 | Odoo capture → Agent render → console preview/cleanup | fixed | expiry uses PostgreSQL on both status producers; private token/preview scope preserved; automatic local cleanup selects only generated artifacts |
| 15 | physical Windows/SCM/driver/printer acceptance | unverified | Linux host cannot execute real Win32 service/spooler; no physical printer |
| 16 | live Odoo 19 upgrade, ORM, OWL/POS and rollback | unverified | no running Odoo/PostgreSQL installation; offline syntax/migration tests cannot replace native acceptance |
| 17 | live Stripe webhook/account-version acceptance | unverified | no live/test account or signed external delivery; local contract tests only |
| 18 | deployed Caddy WebSocket + deployment acceptance | unverified | no deployed stack/agent credential; no image pulls or deployment permitted |

Static integration totals: 5 wired, 9 fixed, 4 unverified acceptance gates; 0 known broken flows after this pass. Fixes do not imply physical-output proof.

### Round 2 Phase 1 — desktop/deployment official research cache (2026-10-13)
- Exact manifest pins: Tauri 2.11.5, tauri-build 2.7.0, reqwest 0.13.4 (rustls, no default features); Rust minimum 1.90/edition 2024; Node minimum 24.15.0, container 24.21.0-alpine; PostgreSQL container 16.15-alpine; Caddy 2.11.4-alpine. Dependencies remain unchanged.
- Tauri capabilities merge per window/webview; restrict local main window and avoid remote URLs. Registered custom commands require `AppManifest::commands` for capability enforcement; capability JSON alone does not restrict undeclared custom commands. https://v2.tauri.app/security/capabilities/
- Tauri `invoke` arguments use camelCase unless command `rename_all` overrides it; heavy blocking commands must use async task dispatch to avoid freezing the UI; errors need serializable `Result` values. https://v2.tauri.app/develop/calling-rust/
- Child processes remain backend-only through existing Rust helpers, absolute bundled paths and bounded operations; no shell plugin or new dependency required (repo agent.rs/commands.rs cache).
- Docker: retain multi-stage builds, digest-pinned base and existing non-root `USER node`; `.dockerignore` must exclude secrets and machine/build artifacts; migrations remain ordered before gateway replicas. https://docs.docker.com/build/building/best-practices/
- Caddy `reverse_proxy` tunnels WebSockets automatically; config reload closes existing tunnels by default, so agent reconnect is required; overwrite forwarded identity before gateway token validation. https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- GitHub Actions: minimum token permissions, full-commit action pins, avoid expression interpolation of untrusted event fields in shell scripts (use environment variables), do not expose secrets to PR code. https://docs.github.com/en/actions/reference/security/secure-use
- Node 24 is LTS on the review date; stay on pinned available version and verify tooling without registry access. https://nodejs.org/en/about/previous-releases

### R2 Go agent / Windows printing research supplement (2026-10-13; cache reused)
- Exact pins: Go language 1.26.0/toolchain 1.26.9; gorilla/websocket 1.5.3; gosnmp 1.44.0; zeroconf 1.0.0; kardianos/service 1.3.0; go-pdfium 1.21.1; go-sqlite3 1.14.50; wazero 1.12.0; x/sys 0.48.0; x/text 0.42.0; lumberjack 2.2.1; yaml 3.0.1 (agent/go.mod).
- Go 1.26 supports existing context/error/concurrency patterns; URL parsing now rejects malformed colon hosts. Keep the pinned toolchain; no upgrades. https://go.dev/doc/go1.26
- Context cancellation releases associated resources only when cancel/AfterFunc stop is called; AfterFunc stop does not wait for a started callback, so callback/handle ownership must synchronize explicitly. https://pkg.go.dev/context
- gorilla 1.5.3: one reader and one writer; SetReadDeadline/PongHandler are reader operations, SetWriteDeadline is writer operation; Close and WriteControl may run concurrently. Read loops must continue to process ping/pong. https://pkg.go.dev/github.com/gorilla/websocket@v1.5.3
- gosnmp 1.44.0 exposes Context for overall deadlines, Timeout per request, Retries count and optional exponential timeout; use one connection per probe and close Conn. https://pkg.go.dev/github.com/gosnmp/gosnmp@v1.44.0
- kardianos/service Interface Start/Stop must return promptly; heavy work runs independently; x/sys svc.Execute must process requests and report state until return. https://github.com/kardianos/service/blob/v1.3.0/service.go ; https://pkg.go.dev/golang.org/x/sys@v0.48.0/windows/svc
- EnumPrinters level 4 uses LOCAL|CONNECTIONS only and local cache; level 2 may contact every remote queue and block. CONNECTIONS enumerates the calling user's connections, so service inventory cannot promise interactive-user queues. https://learn.microsoft.com/en-us/windows/win32/printdocs/enumprinters
- OpenPrinter handles are not thread-safe: serialize all access or open independent handles per worker. Remote OpenPrinter reads local cache; OpenPrinter2W NO_CACHE blocks on remote I/O. https://learn.microsoft.com/en-us/windows/win32/printdocs/openprinter
- StartDocPrinter requires level 1 DOC_INFO_1, returns spooler job ID or zero on failure; normal RAW sequence is StartDoc/StartPage/Write/EndPage/EndDoc. All calls may block in drivers. https://learn.microsoft.com/en-us/windows/win32/printdocs/startdocprinter
- JOB_STATUS_COMPLETE means sent to printer, not paper proof; PRINTED may likewise be set early by port monitors lacking TrueEndOfJob. Never infer physical completion from queue disappearance alone. https://learn.microsoft.com/en-us/windows/win32/printdocs/job-info-2
- PRINTER_INFO_2 carries driver/port/status/DEVMODE pointers owned by the returned buffer; bounds and buffer lifetime must survive syscall decoding. https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2
- IPP job-id/job-uri and job-state are server-assigned reconciliation identities; an ambiguous Print-Job response must not trigger blind replay. https://www.rfc-editor.org/rfc/rfc8011.html
- Reliable merge uses persistent hardware/queue identities plus normalized endpoint aliases, never display name alone; preserve richer evidence without treating discovery disappearance as deletion (repo stable_id/registry/discovery precedent).
- Dispatch durability uses persisted attempt/claim fencing before bytes leave, distinguishes pre-dispatch retry from unknown physical outcome, and reconciles the same spooler/IPP job ID (repo queue/outcome precedent; no wire change planned).

### R2 research cache — Odoo 19.0 (addon 19.0.2.13.0; official source verified 2026-10-13)
- CORRECTION to earlier Odoo cache: Odoo 19.0 bundles OWL **2.8.4**, not OWL 3 (official source `addons/web/static/lib/owl/owl.js`, version constant): https://raw.githubusercontent.com/odoo/odoo/19.0/addons/web/static/lib/owl/owl.js.
- CORRECTION: Odoo 19 JavaScript `_t(source, ...substitutions)` **does interpolate positional %s and named placeholders** using `translationSprintf`; earlier "never interpolates" claim is false. Native interpolation also preserves markup escaping/iterable formatting and avoids JS `String.replace` replacement metacharacter corruption: https://raw.githubusercontent.com/odoo/odoo/19.0/addons/web/static/src/core/l10n/translation.js; https://www.odoo.com/documentation/19.0/developer/reference/frontend/javascript_reference.html.
- Keep `_t` source strings literal for extraction; preserve msgids when fixing interpolation. Exported XML attributes/text and `i18n/*.po` terms must remain synchronized: https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/howtos/translations.rst.
- POS 19 actual store path is `@point_of_sale/app/services/pos_store`; `printReceipt({basic, order, printBillActionTriggered}={})`, `printChanges(order, orderChange, reprint=false, printers=...)` and `printOrderChanges(data,printer)` are verified in source: https://raw.githubusercontent.com/odoo/odoo/19.0/addons/point_of_sale/static/src/app/services/pos_store.js.
- Register prototype patches at module top level; OWL setup hooks rather than constructor overrides; Odoo assets/templates follow addon-qualified names: https://www.odoo.com/documentation/19.0/developer/reference/frontend/owl_components.html; https://www.odoo.com/documentation/19.0/developer/reference/frontend/javascript_reference.html.
- Public ORM methods are RPC-callable and do not automatically enforce ACLs until CRUD; validate record/company/session plus groups before sudo. ACLs add, global rules intersect, group rules union: https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/backend/security.rst.
- Upgrade scripts run only when `installedVersion < migrationVersion <= targetManifestVersion`; fixing historical post-migrations alone does not reach installations already upgraded: https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/upgrades/upgrade_scripts.rst.
- ASSUMPTION: preserve runtime files listed as fully reviewed in the previous pass unless targeted evidence proves remaining wrong; focus second-pass gaps in migrations/tests/styles and corrected translation research.

## Continuation research cache — 2026-10-13 (Phase 1, Gateway)

### Next.js 16.3.8 / React 19.3.0 / TypeScript 5.9.3
- Next16 requires async cookies/headers/params/searchParams; `proxy.ts` replaces middleware; ESLint runs separately from build. Existing webpack flag is supported; no framework migration is required. https://nextjs.org/docs/app/guides/upgrading/version-16
- Server Actions are public endpoints: authenticate and authorize every mutation in the action, validate arguments, and return minimum public data. Client UI hiding is not access control. https://nextjs.org/docs/app/guides/data-security
- React effects must clean up subscriptions and prevent stale asynchronous responses from overwriting later requests; built-in framework fetching is preferable where already supported. https://react.dev/reference/react/useEffect
- `strict: true` enables the strict typechecking family; widening to any silences security-relevant validation. Maintain existing strict/bundler configuration. https://www.typescriptlang.org/tsconfig/strict.html

### Drizzle 0.45.3 / drizzle-kit 0.31.10 / PostgreSQL 16.15 / pg 8.23.0
- Use transaction callback's `tx` consistently; thrown errors roll back; nested transaction provides savepoint. Keep APIs already proven by installed-version repo usage (online docs also describe newer releases). https://orm.drizzle.team/docs/transactions
- Generated SQL migrations must be reviewed and applied in order; do not mutate applied SQL or run `push` against deployment data. https://orm.drizzle.team/docs/migrations
- Row/advisory locks last to transaction end; take locks in consistent order; never hold them over external network work. https://www.postgresql.org/docs/16/explicit-locking.html
- Composite B-tree indexes are most effective with leading equality keys then range/order keys; tenant-first indexes match isolation and pagination queries. https://www.postgresql.org/docs/16/indexes-multicolumn.html

### zod 4.6.2 / ws 8.22.0
- z.object strips unknown properties; use parsed results (never raw inputs); strictObject intentionally rejects extensions, looseObject preserves them. Keep wire compatibility while validating type/range. https://zod.dev/api
- ws recommends ping/pong termination for broken peers; compression adds CPU/memory overhead; serialize state and apply payload/backpressure caps. https://github.com/websockets/ws

### Stripe REST (API version environment-selected, no SDK)
- Verify signature against original raw bytes; timestamp tolerance, duplicate event IDs, unordered delivery and retries require durable idempotency plus current-resource reconciliation. Respond quickly after durable processing. https://docs.stripe.com/webhooks
- This repo uses its own plan/quota enforcement; no new Stripe Entitlements API introduced. Entitlements overview retrieval was unavailable, so that API remains UNVERIFIED rather than an implementation dependency. https://docs.stripe.com/billing/entitlements
- ASSUMPTION: retain account/default API version behavior; pinning Stripe API version requires production account compatibility evidence, unavailable locally.

### Node 24 / i18n / RTL
- Native crypto.argon2/argon2Sync exists in Node24 docs; use installed runtime checks, do not add an Argon2 dependency to compensate for older local Node. https://nodejs.org/docs/latest-v24.x/api/crypto.html
- Use semantic dir on root and isolate unknown-direction user strings with bdi/dir=auto; logical spacing complements direction. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/dir
- Research cache is authoritative for version-compatible rules; live docs may display newer minor releases, which are recommendations only.
### Windows printing targeted confirmations (supplements cached Win32 rules)
- WritePrinter reports bytes written; successful short writes must continue and zero-progress must fail. It does not support XPS/OpenXPS, and RAW settings are encoded by payload, not DEVMODE. https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter
- AbortPrinter only deletes spool files on spooling queues; direct-print queues may already have output. ClosePrinter invalidates its handle even on failure; neither operation proves no paper output. https://learn.microsoft.com/en-us/windows/win32/printdocs/abortprinter ; https://learn.microsoft.com/en-us/windows/win32/printdocs/closeprinter
- GDI StartDocW returns a positive job ID; zero or negative values are failure (decode syscall return as signed int32). GetDeviceCaps reports physical/printable dimensions and offsets in device units. https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-startdocw ; https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getdevicecaps
- R2 targeted API confirmation: standard-library maps.Clone creates an independent top-level map (shallow values); discovery enrichment replaces top-level entries only, so copy-on-merge preserves earlier published snapshots. https://pkg.go.dev/maps#Clone
### Odoo upgrade targeted confirmations (addon now 19.0.2.14.0)
- Upgrade ordering verified in official Odoo source: pre-migrations precede model init, post-migrations follow it; `post_constraint` queues failed constraints/indexes on upgrade and `finalize_constraints` retries later, so existing post-dedupe unique-index migration remains valid: https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/modules/loading.py; https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/orm/registry.py; https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/orm/table_objects.py.
- R2 ownership scope: addon 19.0.2.14.0 makes intent company required; pre-migration takes durable outbox ownership, then supported business source ownership, preserves already-owned rows, and blocks unprovable leftovers. No Gateway/Agent wire-shape changes.

### R2 INTEGRATION_MAP evidence (fold into main map)
| Flow | Status | Evidence |
|------|--------|----------|
| Spooler/GDI dispatch -> attempt job-ID -> Gateway result | fixed | Full spooler/GDI review closes prior partial-review gap; shared preflight ownership recovers after pre-worker refusals; per-attempt ID and UNKNOWN outcomes preserved |
| Concurrent discovery -> bounded partial snapshot -> registry/Gateway inventory | fixed | Capability enrichment no longer mutates previously published maps; complete-source/truncated fences preserve durable inventory |
| Paired desktop fleet inventory -> CLI -> Rust -> UI | fixed | Optional allowlisted pagination headers, bounded read-only cursor queries and beforeIdEncoded contract coordinated with desktop producer/consumer |
| Odoo isolated capture -> Gateway -> Agent renderer -> scoped inbox/preview | fixed | Claim/result/key/tenant fences match; Agent inbox expiry now DB-authoritative; no physical job or print quota debit |
| Legacy service cleanup -> upgrade/uninstall | fixed | Exact installation ownership checks plus fail-closed unreadable SCM states; live Windows execution unverified |

### R2 cached recovery and timer rules
- GNU SHA-256 sidecar output binds digest AND filename; checking a sidecar's own file list is insufficient for a selected-archive restore. Local installed primary manual /usr/share/info/coreutils.info.gz confirms text output format; https://www.gnu.org/software/coreutils/manual/html_node/sha2-utilities.html timed out (no download).
- systemd `daily` expands to local `*-*-* 00:00:00`; explicit `*-*-* 02:00:00 UTC` matches the documented backup schedule. Installed primary manual /usr/share/man/man7/systemd.time.7.gz confirms UTC suffix; official https://www.freedesktop.org/software/systemd/man/systemd.time.html returned HTTP403.

### INTEGRATION_MAP Round2 desktop/deployment trace
| Flow | Status | Evidence / limit |
|------|--------|------------------|
| Gateway bounded fleet → CLI → Rust → desktop complete Agent/printer inventory | fixed | optional lowercase five-header map; GET-only keyset queries; Unicode cursor and empty virtual-only pages; legacy envelope compatibility |
| Capture monitor refresh/filter/page cancellation → loading/empty/error/success UI | fixed | generation fence retained; each replacement/finalizer owns both busy states |
| Desktop TestCenter → local PDFium / paired-Agent simulation inbox / terminal-only cleanup | wired | existing privileged commands, private evidence roots, bounded JPEG previews; physical rendering remains Windows-only |
| Deployment logical backup → selected archive checksum → explicit transactional restore | fixed | exact selected-file digest/name match before DB access; scheduled timer matches 02:00 UTC |
| Docker source context → non-root Gateway / ordered migration / Caddy identity and WS | fixed | actual local Agent runtime secrets excluded; prior Docker/Caddy/proxy wiring retained; container startup unverified here |
| Windows installer → service ownership → upgrade/uninstall/rollback | unverified | fail-closed SCM Query guards and NSIS ownership static coverage; native host and installed target needed |
- R2 Phase 4 targeted Drizzle/pg finding: bare Date interpolation inside custom sql templates uses node-pg's local-wall-clock serializer; PostgreSQL timestamp-without-timezone ignores the offset. Compose gte/lte with the timestamp column to retain Drizzle's UTC ISO encoder, matching typed detail queries (confirmed installed drizzle timestamp.js and pg utils.js; reused repo operators).
- R2/Root consolidated Date-binding decision: because multiple raw sql Date callers share the UTC-naive convention, set installed pg.defaults.parseInputDatesAsUTC=true once before pool construction. This preserves Date arguments everywhere and fixes local-host serialization at the driver boundary; interim per-query changes were removed.

### pg8.23.0 targeted UTC binding confirmation (Phase4 failure research, cached)
- Official type docs: TIMESTAMP/DATE results default to the Node process timezone; naive UTC storage needs an explicit parser for raw fixture pools. https://node-postgres.com/features/types
- Official driver source and installed pg8.23.0 utils/defaults: Date parameters use local wall-clock serialization unless defaults.parseInputDatesAsUTC=true; SQL TIMESTAMP ignores a trailing offset. Set this existing flag once at shared database initialization to preserve UTC for all raw SQL callers (auth/WS budgets, fleet filters, billing fences). https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/defaults.js ; https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/utils.js
- Drizzle typed timestamp-column writes already use UTC ISO. Fix binds only raw Date values; no schema/data migration or wire-shape change. Raw test pool1114 decoding also must honor the repository's UTC storage convention; existing assertions remain intact.
