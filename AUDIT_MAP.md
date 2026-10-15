# AUDIT_MAP.md — Yaseir platform: living architecture map

> Maintained by the audit protocol defined in `AUDIT_LOG.md`. Update this file whenever
> the audit changes our understanding of how the system fits together. Do not delete.
>
> Last verified: **2026-10-16 @ 36afc0bf** (all facts below re-checked against this commit).

## What this system is

Yaseir is a multi-tenant cloud-printing platform. An Odoo 19 ERP instance declares
print intent; a central Gateway (Next.js) queues and routes jobs; a Windows Go agent
executes them on physical printers (spooler, network, USB, IPP); a Tauri desktop app
manages the agent. One GitHub repo holds all four components plus shared wire contracts.

```text
Odoo 19 (ERP, print intent + bindings)
   │  HTTPS REST (Bearer API key)
   ▼
Yaseir Gateway (Next.js custom server, PostgreSQL 16)   ← multi-tenant control plane
   │  WSS /api/agent/ws  +  HTTP polling fallback
   ▼
Yaseir Agent (Go, Windows service)                       ← data plane, owns hardware
   ▼
Physical printers (Spooler / RAW TCP / IPP / USB)
        ▲
Yaseir Print Manager (Tauri desktop) — manages the Agent service locally
```

## Modules

| Module | Paths | Stack (exact pins) | Entry points | Owns |
|---|---|---|---|---|
| **Gateway** | `server.ts`, `proxy.ts`, `src/` | Next 16.3.8, React 19.3.0, TS 5.9.3, Node 24.21.0 (.nvmrc), Drizzle 0.45.3, pg 8.23.0, zod 4.6.2, ws 8.22.0, Tailwind 4.3.3, PostgreSQL 16.15 | `server.ts` (HTTP + WS + periodic maintenance), `proxy.ts` (Next 16 proxy), `src/app/api/**` (84 `route.ts` files), `src/app/**` (23 pages) | tenant/agent/printer/job runtime, job queue + delivery, billing entitlements, auth/sessions, dashboard UI |
| **Go Agent** | `agent/` | Go 1.26.0 (toolchain 1.26.9), gorilla/websocket 1.5.3, gosnmp 1.44.0, grandcat/zeroconf 1.0.0, kardianos/service 1.3.0, go-pdfium 1.21.1, go-sqlite3 1.14.50, wazero 1.12.0, x/sys 0.48.0 | `agent/cmd/agent/main.go` (Windows service), `agent/cmd/cli/main.go` (CLI used by Tauri) | printer discovery, job execution, local SQLite queue, heartbeats, local printer sharing choice |
| **Tauri Print Manager** | `src-tauri/` (UI: `src/desktop/`) | Tauri =2.11.5, tauri-build =2.7.0, Rust toolchain 1.98.1 (edition 2024, min 1.90), reqwest 0.13.4 (rustls) | `src-tauri/src/main.rs`, `commands.rs`, `agent.rs` | agent service lifecycle (install/start/stop), pairing, local printer/test/capture UI |
| **Odoo addon** | `odoo_addons/print_gateway/` | Odoo 19 CE, addon 19.0.2.15.0, OWL 2.8.4, Python deps: requests + cryptography | `__manifest__.py`, `models/print_router.py`, `models/print_intent.py`, `controllers/pos.py`, `static/src/js/report_interceptor.js` | print bindings, durable outbox, POS/report interception, automated print policies |
| **Shared contracts** | `contracts/` | JSON + zod mirrors | `print-payload-contract.json` and siblings | payload wire shape shared by Gateway/Agent/Odoo |
| **DB schema/migrations** | `src/db/`, `drizzle/` | Drizzle ORM + drizzle-kit, SQL migrations 0000–0084 (85 files) | `src/db/schema.ts` (26 tables) | all runtime state |
| **Ops/CI** | `Dockerfile`, `docker-compose*.yml`, `Caddyfile`, `.github/workflows/`, `scripts/` | Node 24.21.0 image, PostgreSQL 16.15, Caddy 2.11.4 | workflows: `ci.yml`, `docker.yml`, `build-windows.yml` | build, test, release, backup/restore |

## How the pieces connect

- **Odoo → Gateway**: HTTPS REST, `Authorization: Bearer <api key>` (only the SHA-256 hash is stored). Outbox row + idempotency key created before submission; retries reuse the key. `runtime_clock.py` uses Odoo's `db_now_utc` for retry scheduling.
- **Agent → Gateway**: WSS at `/api/agent/ws` (Bearer `{agentId}:{secret}`, timing-safe hash compare) with HTTP polling fallback; heartbeat every 30s carries full printer inventory. Cross-instance fanout via PostgreSQL LISTEN/NOTIFY; polling is the durable backstop.
- **Gateway ↔ PostgreSQL**: Drizzle + `pg` pool; advisory locks (`pg_advisory_xact_lock`) and claim-token fencing for queue/billing races; soft-deleted tenants.
- **Tauri → Agent**: Rust helpers spawn the agent CLI with bounded stdin/stdout; no shell plugin. Commands are capability-scoped in `src-tauri/capabilities/`.
- **Caddy → Gateway**: TLS termination + injected `TRUST_PROXY_SECRET` header (≥32 chars, placeholder-rejecting); trusted-proxy code lives in `src/server/trusted-proxy.ts`.
- **Gateway → Stripe**: REST calls (no SDK), SHA-verified webhooks, DB-calibrated clock tolerance.

## State model (do not collapse these)

| Dimension | Values | Owner |
|---|---|---|
| Lifecycle | `active` / `disabled` / `retired` | Gateway DB |
| Runtime | `online` / `offline` | Gateway via heartbeat |
| Availability | computed (lifecycle + runtime + last_seen_at) | Gateway logic |
| Physical outcome | `success` / `failed` / `unknown` (paper proof never inferred) | Agent report |

Job flow: `queued → claimed → printing → success|failed|expired`; fenced returns
`claimed → queued`. Claim token in WHERE clause for every transition.

## Multi-tenancy

Pool tenancy: one PostgreSQL database, app-level `tenant_id` filtering, composite
`UNIQUE(tenant_id, id)` + composite FKs. Auth gates: `requireActiveTenant()`
(`src/lib/tenant-guard.ts`), agent auth checks agent + tenant lifecycle, Odoo key
chain key→tenant→lifecycle. **RLS is NOT enabled** (documented gap, ARCHITECTURE.md §3).

## File inventory (counts at 36afc0bf)

| Area | Files | Notes |
|---|---|---|
| `src/app` | 126 | 84 API routes, 23 pages, layouts/fonts |
| `src/lib` | 81 | domain logic: auth, jobs, billing, printer, validation |
| `src/server` | 7 | ws.ts, trusted-proxy, request-guard, cors, csp, correlation, api-defaults |
| `src/db` | 3 | schema.ts (26 tables), client.ts, index.ts |
| `src/desktop` | 27 | Tauri web UI (pages, components, ipc) |
| `src/components` | 20 | Gateway dashboard UI |
| `src/i18n` | 8 | en/ar catalogs + helpers |
| `src/shared` | 4 | job vocabulary, retention, printer presentation, diagnostic test |
| `agent` | 274 | internal/printer 154, internal/agent 47, internal/config 17, internal/storage 9, internal/queue 6, cmd 29 (agent + cli), payload 3, integration 3 |
| `src-tauri` | 26 | src 8 Rust files + capabilities/icons/configs |
| `odoo_addons/print_gateway` | 81 | models 16, migrations 11, static 17, views 8, controllers 3, tests 9 |
| `drizzle` | 102 | 85 SQL migrations + meta snapshots |
| `tests` | 393 | vitest + pytest + contract tests |
| `scripts` | 21 | CI helpers, db tooling, backup/restore, audit-gate |
| `docs` | 23 | platform guides/docs |

## Prior audit artifacts (use, don't re-derive)

- `graphify-out/GRAPH_REPORT.md`, `graphify-out/FINAL_AUDIT.md` — committed graph-led
  audit snapshot (2026-10-14/15): 9k+ nodes, community map, 6 completed findings (FG-*).
- `STACK_NOTES.md` — curated research cache: per-technology official-doc rules
  (Go/Win32/IPP, Next/Drizzle/pg/zod/ws/Stripe, Tauri/Docker/Caddy/GHA, Odoo 19)
  plus **INTEGRATION_MAP** (lines ~82–108): 21 flows = 3 wired / 14 fixed / 4 runtime-gated.
- `.audit/**` — local (gitignored) per-lane evidence from previous sessions
  (`gateway-complete-20261015`, `odoo-automation-20261015`, …). Not in Git.
- `graphify-out/graph.json` — machine-readable knowledge graph (stale vs HEAD).

## Known documented gaps / stale-doc watchlist

- ARCHITECTURE.md §2.1 states "78 route files, verified 2026-10-11"; actual count is
  **84** `route.ts` files at 36afc0bf. (Confirmed by this audit; log entry added.)
- PostgreSQL RLS not enabled (documented above, by design).
- 4 live acceptance gates can never be closed statically: Windows service/spooler/
  physical printers, live Odoo 19 ORM/POS/upgrade, live Stripe delivery, deployed Caddy WS.

## Update discipline

1. Any audit session that learns a new module boundary, entry point, connection, or
   ownership change edits this file in the same commit as the audit-log entry that
   discovered it.
2. Keep facts date-stamped; never silently rewrite history — supersede with a note.
