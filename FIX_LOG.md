# FIX_LOG.md

RESUME HERE: DONE — all 5 passes recorded, integration traced, Phase 4 verified. See deliverable summary in chat.

- GW-F1 FIXED: `recordAuthSuccess` in src/lib/auth-rate-limit.ts now also clears the IP bucket on valid IPs (was account-bucket only; shared-NAT lockout drift).
- GW-F2 FIXED: provision route dedupe compares `canonicalize()`d JSON instead of key-order-sensitive `JSON.stringify`.
- OPEN (not fixed, need decision): GW-F3 heartbeat batch upsert in one long txn (needs batched writes); GW-F4 test-print 201-vs-200 reuse mismatch; GW-F5 cookie-over-Bearer precedence; GW-F6 double base64 decode; GW-F7/F8/F9 info-level, by design or defense-in-depth holds.
- GW-F3 DOWNGRADED Low + documented: pages capped at 500 (route.ts:208), per-statement 30s timeout (db/index.ts:74), advisory lock is per-tenant — bounded; `shortcut:` note added, bulk upsert deferred.
- GW-F4 FIXED: test-print returns `isReused ? 200 : 201`, matching POST /api/print/jobs reuse semantics.
- GW-F5 FIXED: `getAccessTokenFromRequest` prefers explicit Bearer over ambient cookie (no test pinned old order).
- GW-F6 FIXED: payload.ts admission decodes base64 once (length precheck via `.max()`, round-trip check + all signature checks share one buffer); messages/paths unchanged.
- ASSUMPTION: backend subagent's "verified against repo code" research accepted without web lookups since APIs are internal patterns.
- GO-F1..F3 FIXED (agent): heartbeat fence encodes `[]` not null; pollDiscovery logs transport/non-200 errors; WS discovery logs session-lookup misses. No contract change needed — wire enums/limits/signatures all match.
- TA-F1..F3 FIXED (infra): Caddy secret path absolute; 3 dead Tauri `allow-*` IPC permissions removed (build.rs + default.json); docker.yml now asserts Caddy-relayed proxy token. OPEN: TA-F4 agent-WS-through-Caddy E2E (needs CI credential); TA-F5 updater/signing (release-process).
- NOTE: Go agent `printer/spooler_windows.go` mostly unread (subagent) — Win32 handle-lifetime defects there may be uncaught; flagged for Phase 3/4 attention.
- UI-F1..F5 FIXED (UI): catalog placeholder, formatNumber display, collapsed-nav aria-labels, RTL-mirrored GSAP offset, empty Button child. UI-F6 FIXED without new key (aria-label now uses localized `JOB_TAB_LABELS[s.jobTab]`). OPEN: UI-F7 locale-freeze (router.refresh covers), UI-F8 relativeTime dup (refactor). No i18n key mismatches — all touched keys exist in en.
- OD-F1..F5 FIXED (Odoo): 7× `_t` interpolation sites fixed msgid-preserving (https://odoo.com/documentation/19.0/developer/howtos/translations.html); policy picker domain widened to company-wide fallback (model string untouched — pinned by test). OPEN: OD-F6 nullable company_id (shortcut; needs backfill); OD-F7/F8 fail-closed by design. Contract: no blocking mismatches.
- Phase 4: go build (linux+windows) clean; go tests 60 pass; vitest unit 1025 pass (10 pre-existing env failures proven on stash; 1 self-caused failure fixed at root cause — test pin now asserts `result.isReused ? 200 : 201`, both callers use response.ok); eslint clean; i18n/db-docs/odoo-i18n checkers + pytest-static (57) pass. UNVERIFIED: integration suite (no PG), cargo check (no registry), tsc/build (node_modules lacks radix/gsap).

Entries (append-only): what, why, URL if research-based. ASSUMPTION: prefix for guesses.
