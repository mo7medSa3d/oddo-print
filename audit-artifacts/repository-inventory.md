# Repository Inventory & Subsystem Mapping

## Overview
- **Repository**: `mo7medSa3d/oddo-print` (Odoo Print Gateway)
- **Primary Subsystems**: Gateway Server (Next.js / TypeScript), Print Agent (Go), Odoo Addon (`print_gateway`), Desktop App (Tauri / React), Reverse Proxy (Caddy), Database (PostgreSQL / Drizzle ORM).

---

## 1. Gateway Server (`src/`, `server.ts`)
- **Language**: TypeScript / Node.js >=24.15.0
- **Entry Point**: `server.ts` (custom HTTP + WebSocket server setup with production security guards)
- **API Routes**: `src/app/api/` (21 endpoint groups covering auth, agent ws/polling/discovery, print jobs, printers, team, billing, settings, live health)
- **Database Access**: `src/db/` (16 schema tables, migration runner, tenant helper)
- **Core Libraries**: `src/lib/` (agent-auth, manager-auth, odoo-auth, job-delivery, job-fencing, metrics, log, ws-rate-limit, auth-rate-limit, payload, entitlements)

---

## 2. Print Agent (`agent/`)
- **Language**: Go 1.23+
- **Entry Points**: `agent/cmd/agent/main.go` (daemon service), `agent/cmd/cli/main.go` (CLI tool)
- **Core Modules**:
  - `agent/internal/agent/`: Job dispatch, WebSocket client, heartbeat, poll fallback, per-printer queue, idempotency, server URL validation.
  - `agent/internal/printer/`: Physical printer transport drivers (RAW, ESC/POS, PDF driver rendering), Windows spooler integration (`spooler_windows.go`).
  - `agent/internal/queue/`: Local SQLite durable job queue & terminal status ledger (`cleanup.go` daily retention ticker).
  - `agent/internal/config/`: Configuration parser and validator.

---

## 3. Odoo Addon (`odoo_addons/print_gateway/`)
- **Language**: Python 3 / Odoo 17 & 19 Framework
- **Models**:
  - `gateway_config.py`: Connection testing, API key rotation, health notifications.
  - `print_intent.py`: Intent creation, company context rebinding (`with_env`), dispatch routing.
  - `print_router.py`: Document type rules and printer matching.

---

## 4. Desktop Client (`src/desktop/`, `src-tauri/`)
- **Language**: React 19 / TypeScript / Rust (Tauri 2.0)
- **Pages**: `src/desktop/pages/` (Overview, Jobs, Printers, Settings, Logs)
- **Components**: `src/desktop/components/` (Header, Sidebar, StatusPill, AddPrinterDialog)

---

## 5. Deployment & CI/CD
- `Dockerfile`: 4-stage multi-stage Alpine build with `wget --spider` liveness probe.
- `docker-compose.yml`: Gateway, Postgres, Caddy proxy configuration.
- `Caddyfile`: Reverse proxy setup with automatic HTTPS & proxy token header injection.
- `.github/workflows/ci.yml`: Multi-job CI pipeline (Node tests, Go tests, Odoo linting, Docker build).
