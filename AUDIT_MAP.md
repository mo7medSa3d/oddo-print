# AUDIT_MAP.md — Living architecture map (oddo-print / Yasser Print Gateway)
Last updated: 2026-09-27 (session 1, PHASE 0 setup)
Repo: mo7medSa3d/oddo-print, branch: main
Name note: package.json `name: yasser-gateway`; Go module `github.com/yasser-agent/agent`; Tauri package `yasser-manager`; Odoo addon `print_gateway` (v19.0.2.10.0). "oddo-print" is the repo slug only.

## 1. Top-level modules
| Module | Dir | Language / runtime | Entry point(s) |
|---|---|---|---|
| Gateway (Next.js + custom Node server) | `src/`, `server.ts`, `proxy.ts`, `next.config.ts`, `drizzle/` | Node >=24.15, Next 16.3.6, React 19.3.0, Drizzle ORM 0.45.2, pg 8.23.0, ws 8.21.3, zod 4.6.1 | `server.ts` (custom HTTP+WS server, real entrypoint; `npm run dev/start` via tsx), `proxy.ts` (pass-through only, CSP owned by server.ts), `src/app/layout.tsx`, `src/app/page.tsx` |
| DB schema / migrations | `src/db/schema.ts`, `src/db/client.ts`, `src/db/index.ts`, `drizzle/*.sql` (0000–0074), `drizzle.config.ts`, `scripts/db-*.ts` | Drizzle Kit 0.31.10, Postgres | `src/db/schema.ts` is source of truth; `drizzle/` SQL is generated history |
| Go agent (Windows service + polling/WS worker) | `agent/` (`cmd/agent/main.go`, `cmd/cli/`, `internal/agent|config|printer|queue|storage|payload|diag|integration|testutil/`) | Go 1.26, gorilla/websocket 1.5.3, gosnmp, zeroconf, kardianos/service, go-pdfium, mattn/go-sqlite3, wazero, lumberjack, yaml | `agent/cmd/agent/main.go` (service), `agent/cmd/cli/main.go` (CLI) |
| Tauri shell / desktop manager | `src-tauri/` (`src/main.rs`, `commands.rs`, `agent.rs`, `tray.rs`, `paths.rs`, `logging.rs`, `cleanup.rs`), `src/desktop/` (Vite+React UI) | Rust 1.90 ed.2024, Tauri 2.11.5, reqwest rustls, `src/desktop` Vite 8 + React 19 | `src-tauri/src/main.rs`, `src/desktop/main.tsx`, `src/desktop/lib/ipc.ts` |
| Odoo addon | `odoo_addons/print_gateway/` (models/, controllers/, views/, static/src/js, migrations/19.0.x, tests/) | Python (Odoo 19), JS (POS assets), XML | `__manifest__.py`, `__init__.py`, `models/`, `controllers/pos.py`, `controllers/runtime_printers.py` |
| Shared contracts/docs | `contracts/print-payload-contract.json`, `docs/`, `ARCHITECTURE.md`, `PRINTING_ARCHITECTURE.md`, `API.md`, `ODOO_INTEGRATION.md`, `TENANT_ISOLATION.md`, `SECURITY.md`, etc. | — | `contracts/print-payload-contract.json` (payload contract Go↔Gateway↔Odoo) |

## 2. How they connect
```
Odoo (print_gateway addon: print_intent/print_job/print_router/print_policy/binding/runtime_assignment)
  │  HTTPS REST (gateway /api/odoo/*, /api/print/jobs) + API-key auth (odoo-auth.ts)
  ▼
Gateway (Next.js App Router + custom server.ts)
  │  ├─ Postgres (Drizzle, src/db/*) — tenants, jobs, printers, agents, billing, audit
  │  ├─ Agent transport: WS push (/api/agent/ws via src/server/ws.ts) + HTTPS poll fallback
  │  │    (/api/agent/jobs, /heartbeat, /register, /discovery)
  │  ├─ Browser UI (src/app/* dashboard/platform/billing/team) + session cookies
  │  └─ Stripe webhooks (/api/billing/webhook)
  ▼
Go agent (per-site Windows host): WS/poll → local SQLite queue → WinSpooler/IPP/USB/PDF pipeline
  │  local print (Win32 spooler, IPP, USB, SNMP/WSD/mDNS discovery)
Tauri manager (desktop): manages local agent via IPC/commands (commands.rs, agent.rs) + talks to gateway REST for overview
```

- Gateway↔Agent auth: `src/lib/agent-auth.ts`, pairing-code hash (migrations 0022/0032), agent lifecycle (`agent-lifecycle.ts`, `agent-presence-maintenance.ts`).
- Gateway↔Odoo auth: `src/lib/odoo-auth.ts`, API keys (`/api/odoo/keys`), key rotation grace (0064/0065).
- Multi-tenancy: tenant_id scoping everywhere (`tenant-guard.ts`, `authorization.ts`, migrations 0028–0031, TENANT_ISOLATION.md).
- Job path: Odoo intent → gateway `print-job-service.ts` / `job-delivery.ts` / `job-fencing.ts` / `job-status.ts` → agent claim → printer (`agent/internal/printer/*`, `queue/*`) → timeline/events (`job-timeline.ts`, `job-events` migrations 0055/0063/0066).
- Discovery: agent `discovery_manager.go` + `printer/discovery*.go` (mDNS/IPP/SNMP/WSD/USB) → gateway `/api/agents/[id]/discovery*`, `discovered-printers/*` + `src/lib/discovery.ts`.
- Desktop IPC: `src/desktop/lib/ipc.ts` ↔ `src-tauri/src/commands.rs`; no direct DB access from desktop/agent.
- Observability: `src/lib/metrics.ts`, `/api/metrics`, `/api/system/health`, `system-health.ts`, `src/server/correlation.ts`, `src/lib/log.ts`.

## 3. File inventory (abridged — full tree in session-1 shell dump)
- Gateway routes: `src/app/api/*` (~70 route.ts: auth/*, agent/*, agents/*, jobs, printers, print/jobs, odoo/*, billing/*, platform/*, team/*, settings, onboarding, health/live/metrics).
- Gateway lib: `src/lib/*` (~50: auth×5, agent×6, job×6, billing, entitlements, tenant, printer, discovery, stripe, ws-rate-limit, …).
- Gateway server: `src/server/*` (ws.ts, request-guard.ts, cors.ts, csp, correlation, trusted-proxy, api-defaults).
- Gateway UI: `src/app/*` pages + `src/components/*` + `src/desktop/*` (separate Vite app, NOT Next).
- Agent: ~90 Go files (incl. _test.go); prod code ≈ `cmd/agent`, `cmd/cli/{gateway,cleanup,helpers}`, `internal/{agent,config,printer,queue,storage,payload}`.
- Tauri: 7 Rust files + `tauri.conf.json`, `capabilities/`, Vite desktop (`src/desktop/*` ~20 tsx/ts).
- Odoo: 13 models, 2 controllers, 8 views, 8 static JS, 8 migrations dirs, 7 tests.
- Drizzle: 75 SQL migrations (0000–0074) + 4 snapshot JSON + journal.
- Tests (NOT to run per constraints): `tests/` (vitest unit/integration/e2e), `agent/**/*_test.go`, Odoo `tests/test_*.py`, `pytest_cache`.

## 4. Open questions / to verify while auditing
- `docs/DATABASE.md` referenced in brief but no such file in `docs/` listing (only 6 docs there) — root *.md (ARCHITECTURE, PRINTING_ARCHITECTURE, TENANT_ISOLATION, SECURITY, API, DEPLOYMENT…) may be stale vs schema.ts — verify per file.
- Dual `src/db/client.ts` vs `src/db/index.ts` — which is canonical import?
- `proxy.ts` vs old `middleware.ts` naming (Next 16 proxy convention) — verify doc.
- Desktop has TWO JobTimeline/UI copies (`src/components/` vs `src/desktop/components/`, `src/desktop/ui.tsx` vs `src/components/ui.tsx`) — drift?
- Odoo `__pycache__/` committed? Check .gitignore.
- Exact pinned versions: Next 16.3.6, Drizzle 0.45.2, Go 1.26, Tauri =2.11.5/=2.6.3 build, Odoo 19 — all judgments must web-verify against these pins.

## 5. Audit order (dependency order, entry points outward)
1. `server.ts`, `proxy.ts`, `src/server/*`, `src/db/schema.ts`+client, `drizzle.config.ts`
2. `src/lib/*` (auth/tenant → agent → job → printer/discovery → billing → misc)
3. `src/app/api/*` routes, then `src/app/*` pages + components
4. `contracts/print-payload-contract.json`, `agent/internal/payload/*` (contract center)
5. `agent/` prod Go files, `src-tauri/src/*` + `src/desktop/*`
6. `odoo_addons/print_gateway/` (manifest → models → controllers → views/static → migrations)
7. `drizzle/*.sql` vs schema.ts, root docs vs code.
Update this file whenever understanding changes.
