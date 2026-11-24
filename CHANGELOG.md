# Changelog

All notable changes to **Yaseir** are documented in this file.

## v14 — Cross-System Hardening, Lifecycle & POS Hardware Fixes

### Printer Sharing & `max_printers`
- **Go Agent (`agent/internal/agent/agent.go`)**: Added `sharedPrinterCount()` so `CheckPrinterLimit` counts only printers shared with Odoo (`isPrinterAvailableToOdoo`), never unshared Windows/virtual printers.
- **Odoo (`controllers/agent_api.py`, `models/printer.py`)**: Fixed heartbeat `available_to_odoo` overwrite loop and removed arbitrary `ORDER BY id DESC` printer disabling; newly discovered printers beyond `max_printers` are added unshared, `write()` enforces `max_printers` under `pg_advisory_xact_lock`, and `pendingJobs` is counted after availability updates.

### Agent Lifecycle (`max_agents`), WebSocket Revoke & Fail-Fast Routing
- **Odoo (`models/agent.py`, `views/agent_views.xml`, `controllers/agent_api.py`, `controllers/agent_ws.py`)**: Added advisory lock in `agent_register`, `write()` limit enforcement on agent reactivation, automatic printer unshare + offline status on archive, `Revoke & Disconnect` action button, and immediate WebSocket termination when an agent is archived or revoked.
- **Odoo (`models/print_router.py`)**: Added fail-fast validation in `_persist_durable_job` so printing to an unshared printer or archived agent fails immediately with an actionable message instead of hanging in `queued`.

### Gateway DB Binding Lock, Plan Controls & Desktop Visibility
- **Gateway (`src/app/api/license/refresh/route.ts`)**: Added isolated per-tenant `db_<hash>` binding lock in `odoo_installations` (`403 ODOO_DB_ALREADY_BOUND` + signed revocation tombstone) without colliding with legacy installation rows.
- **Gateway Plans (`src/lib/manual-plans.ts`, `src/app/api/platform/plans/[id]/route.ts`, `src/app/platform/plans/page.tsx`, `src/i18n/messages/v4-admin.ts`)**: Added real `maxAgents` and `maxPrinters` controls and marked `monthlyQuota` as informational/optional in License-Only mode.
- **Desktop (`src/desktop/pages/Printers.tsx`)**: Added shared-with-Odoo printer counter (`Shared with Odoo: X / Y`) in the Printers footer.

### POS Hardware Peripherals & Practical Tolerance
- **Go Agent (`agent/internal/printer/peripherals.go`)**: Fixed `BuzzerEpson` escape bytes from `0x1B 0x70 0x00 0x19 0xFA` (Pin 2 cash drawer kick) to standard ESC/POS buzzer `0x1B 0x42 0x02 0x02` (`ESC B 2 2`).
- **Go Agent (`agent/internal/agent/agent.go`, `printer/document.go`, `printer/raster_document.go`)**: Fixed POS JPEG receipt peripheral corruption by deferring `WrapPeripheralCommands` (buzzer/cutter) until *after* `JPEGToESCPOSWithMaxWidth` rasterization.
- **Go Agent & Odoo (`agent/internal/printer/pdf_receipt.go`, `models/binding.py`)**: Added ~2mm receipt-width fit tolerance in `pdf_receipt.go`, updated Epson buzzer label, and added `paper_width_mm` fallback for ESC/POS network/USB printers.

## [1.0.0] - 2026-11-19

### Added
- **Direct Odoo 19 ↔ Go Agent Print Plane:** Zero-dependency RFC 6455 WebSocket (`/api/agent/ws`) backed by PostgreSQL `pg_notify('print_gateway_job_ready', ...)` wakeups with automatic 5-second HTTPS polling fallback, claim-token fencing, and local SQLite recovery.
- **License-Only Cloud Gateway:** Scoped Next.js + PostgreSQL + Drizzle control plane limited to tenant accounts, manual subscriptions, workspace administration, and signed licensing — no print payloads or cloud job queues.
- **Ed25519 v2 Offline Licensing:** Signed license issuance (`/api/license/refresh`) and verification (`/api/license/verify`) with monotonic revision anti-rollback (`rev`), revocation tombstones (`status: "revoked"`), key IDs (`key_id`), and build-time public key pinning (`PinnedPublicKeyB64`).
- **Clean Production Schema:** Consolidated 21-table PostgreSQL schema in `src/db/schema.ts` with a single clean initial migration (`drizzle/0000_*`) and `npm run db:reset` support.
- **Hardened Container & TLS Stack:** Non-root multi-stage `Dockerfile` (`node`), digest-pinned `Dockerfile.odoo-hardened` (`odoo`), least-privilege PostgreSQL role separation (`docker-compose.yml`), and automatic HTTPS/TLS reverse proxy with security headers (`Caddyfile`).
- **Bilingual UI & Translations:** Full English and Arabic catalog coverage across the web portal (2,589 keys) and Odoo 19 addon (`i18n/ar.po`, 685 terms) with canonical typography tokens.

### Removed
- Retired legacy cloud print-job queues, `/api/printers` data-plane routes, `/platform/operations` UI, and unreferenced prototype/audit report files.
