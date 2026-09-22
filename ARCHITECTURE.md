# Odoo Print Gateway — Architecture

> **Version**: 19.0.2.4.0 | **Node**: 24.21.0 | **Go**: 1.26 | **Odoo**: 19 CE

## 1. System Overview

The Odoo Print Gateway is a multi-tenant SaaS platform that enables silent, hardware-level printing from Odoo ERP to physical printers through a three-tier distributed architecture.

```
┌──────────────────┐     ┌────────────────────┐     ┌──────────────────┐
│   Odoo 19 CE     │────▶│  Central Gateway    │◀───▶│ Windows Agent    │
│   (ERP Layer)    │ API │  (Control Plane)    │ WS  │ (Data Plane)     │
│                  │     │                     │     │                  │
│ Business Context │     │ Runtime Infra       │     │ Physical Print   │
│ Print Intent     │     │ Tenant Isolation    │     │ Device Discovery │
│ Binding Config   │     │ Job Queue           │     │ Job Execution    │
└──────────────────┘     └────────────────────┘     └──────────────────┘
         │                        │                        │
    ┌────▼────┐             ┌─────▼─────┐           ┌─────▼─────┐
    │ Odoo DB │             │PostgreSQL │           │ Printers  │
    │ (Biz)   │             │ (Runtime) │           │ (HW/Net)  │
    └─────────┘             └───────────┘           └───────────┘
```

### Ownership Boundary (Critical Design Decision)

| Concept | Owner | Rationale |
|---------|-------|-----------|
| Business records (orders, invoices) | Odoo | Odoo is the ERP system of record |
| Print intent & binding configuration | Odoo | Business context determines what prints where |
| Agent identity & lifecycle | Gateway | Runtime infrastructure concern |
| Printer inventory & status | Gateway | Agents report hardware state via heartbeat |
| Job queue & delivery guarantees | Gateway | At-least-once delivery with claim fencing |
| Physical print execution | Agent | Windows-local access to spooler/network/USB |

**Key prohibition**: The Gateway does NOT duplicate Odoo business models. It owns runtime infrastructure only.

## 2. Component Architecture

### 2.1 Central Gateway (Next.js 16.3.4 + Custom Server)

**Location**: `src/`, `server.ts`

The Gateway is a Next.js 16.3.4 application with a **custom HTTP server** (`server.ts`) that:
- Runs the Next.js request handler for API routes and dashboard UI
- Attaches a WebSocket server for real-time agent communication (`/api/agent/ws`)
- Runs periodic maintenance (job sweep, auth cleanup, agent presence sweep)
- Enforces trusted proxy authentication (Caddy → Gateway)
- Rejects known placeholder secrets in production mode

**API Route Structure** (50 routes):
- `/api/agent/*` — Agent data plane (heartbeat, jobs, register, discovery)
- `/api/agents/*` — Agent management (CRUD, discovery sessions)
- `/api/odoo/*` — Odoo integration endpoints (agents, printers, keys, health)
- `/api/print/*` — Job submission and batch status
- `/api/printers/*` — Printer management and test operations
- `/api/auth/*` — Customer authentication (register, login, verify-email, etc.)
- `/api/billing/*` — Stripe integration (checkout, webhook, portal)
- `/api/admin/*` — Platform admin (tenant lifecycle management)
- `/api/team/*` — Team management (invitations, members, ownership transfer)

### 2.2 Go Windows Agent

**Location**: `agent/`

A Go service designed for Windows deployment that:
- Connects to the Gateway via WebSocket with automatic reconnection (jittered exponential backoff)
- Falls back to HTTP polling when WebSocket is down (5s interval, safety poll every 30s when WS up)
- Sends heartbeats every 30s with full printer inventory and status
- Discovers printers via Windows Spooler API, network scanning, IPP discovery, and USB enumeration
- Executes print jobs with bounded concurrency (8 concurrent, 64 pending)
- Maintains a local SQLite queue for crash recovery
- Supports per-printer serialization to prevent concurrent physical prints

**Print Transports**: RAW TCP, ESC/POS, ZPL, TSPL, Windows Spooler, IPP/IPPS, Image rasterization

### 2.3 Tauri Desktop Manager

**Location**: `src-tauri/`, `src/desktop/`, `dist-desktop/`

A Tauri 2 desktop application for Windows that provides:
- Agent service management (start/stop/configure)
- Printer discovery and manual registration UI
- Pairing workflow (agent ↔ Gateway registration)
- Local printer test printing

### 2.4 Odoo 19 Addon (`print_gateway`)

**Location**: `odoo_addons/print_gateway/`

An Odoo 19 Community module that:
- Owns print bindings: maps (Company/Branch, Document Type, Destination) → (Gateway Agent, Gateway Printer)
- Intercepts `ir.actions.report` execution for silent PDF printing
- Overrides `/report/download` controller for defense-in-depth report interception
- Routes POS receipts and kitchen tickets as JPEG images
- Supports raw command routing (ZPL, TSPL, ESC/POS) with protocol enforcement
- Implements automated print policies with event-driven intent dispatch
- Provides diagnostic test page generation per printer protocol

## 3. Multi-Tenancy Architecture

### Model: Pool Tenancy

All tenants share a single PostgreSQL database with application-level tenant isolation via composite foreign keys.

**Isolation mechanism**: Every tenant-scoped table has a `tenant_id` column with:
- `NOT NULL` constraint
- Foreign key to `tenants(id)`
- Composite unique constraint: `UNIQUE(tenant_id, id)`
- Composite foreign keys between related tables (e.g., `printers(tenant_id, agent_id) → agents(tenant_id, id)`)

**Tenant lifecycle states**: `active` → `suspended` → `deleted`

**Auth gates**:
- `requireActiveTenant()` in `src/lib/tenant-guard.ts` — checks tenant lifecycle on every authenticated request
- Agent auth (`validateAgent()`) checks both agent lifecycle and tenant lifecycle
- Odoo API auth validates API key → tenant → active lifecycle chain

### Future Path (Documented, Not Implemented)

Pool → Bridge (schema-per-tenant) → Silo (DB-per-tenant) → Cells/Stamps

> **Note**: PostgreSQL RLS is NOT currently enabled. Tenant isolation relies on application-level `tenant_id` filtering in all queries. This is a documented architectural gap — RLS would provide defense-in-depth against query-level tenant leakage.

## 4. State Model

The system uses four DISTINCT state dimensions that must NOT be collapsed:

| Dimension | Values | Owner | Purpose |
|-----------|--------|-------|---------|
| **Lifecycle** | `active`, `disabled`, `retired` | Gateway DB | Administrative control |
| **Runtime** | `online`, `offline` | Gateway (via heartbeat) | Connection liveness |
| **Availability** | Computed from lifecycle + runtime + lastSeenAt | Gateway logic | Job routing eligibility |
| **Physical Outcome** | `success`, `failed`, `unknown` | Agent report | Actual print result |

### Job Status Flow

```
queued → claimed → printing → success
                            → failed
                            → expired
claimed → queued (fenced rejection / lease timeout)
```

## 5. Security Architecture

### Authentication Layers

| Path | Mechanism |
|------|-----------|
| Agent → Gateway | Bearer token: `{agentId}:{secret}` with SHA-256 hash comparison (timing-safe) |
| Odoo → Gateway | API key (Bearer token) with SHA-256 hash lookup |
| Manager → Gateway | JWT with per-session JTI, stored in `manager_sessions` |
| Customer → Gateway | Email/password with bcrypt hash, email verification, rate limiting |
| Proxy → Gateway | `TRUST_PROXY_SECRET` header validation (≥32 chars, reject known placeholders) |

### Rate Limiting

- Auth rate limiting: per-key with lockout (`auth_rate_limits` table)
- WebSocket upgrade: per-IP rate limiting
- WebSocket messages: per-agent token bucket (20 capacity, 5/s refill)
- Print job submission: per-API-key minute/hour windows (`print_job_rate_limits` table)

### Input Validation

- All API routes use Zod schema validation
- Mutating `/api/*` requests require a valid `Content-Length`, are capped at 8 MiB, and reserve authenticated/unauthenticated concurrent-byte budgets until the response closes
- Print job payloads are validated against `payloadContractCheck` (database CHECK constraint); PDF data must begin with `%PDF-`
- Printer protocol/capability gating prevents incompatible job routing
- Diagnostic ZPL/TSPL/ESC/POS pages sanitize user-controlled names for their target command language

## 6. Database Architecture

### PostgreSQL + Drizzle ORM

**Schema**: 24 tables defined in `src/db/schema.ts`
**Migrations**: 59 migrations (0000–0058) in `drizzle/`
**Driver**: `pg` 8.23.0 with connection pool

### Key Design Patterns

1. **Composite tenant keys**: `UNIQUE(tenant_id, id)` on all tenant-scoped tables
2. **CHECK constraints**: Status enums enforced at database level (not just application)
3. **Idempotency keys**: Unique partial indexes for deduplication
4. **Claim fencing**: `claim_token` column prevents stale-claim processing
5. **Soft deletes**: Tenant lifecycle with `suspended_at`/`deleted_at` timestamps
6. **Audit events**: Full audit trail with actor type, action, resource references

## 7. Job Delivery Guarantees

The system implements bounded at-least-once delivery with claim fencing:

1. **Claim**: Gateway atomically claims a job with a unique `claim_token`; both `delivery_attempts < 5` and `retries < 5` must hold.
2. **Deliver**: Job is pushed to the agent by WebSocket or returned by HTTP polling. A hand-off consumes one delivery attempt.
3. **Evidence**: `delivered_at` records successful Gateway transport hand-off, while `acked_at` is recorded only after the Agent admits the job into its bounded local executor.
4. **Print**: Agent executes physical print and reports terminal status with the active claim token.
5. **Fence**: All status transitions are fenced by claim token — stale claims are rejected.
6. **Safe return**: A proven pre-execution rejection refunds its delivery attempt and consumes retry budget; ambiguous delivery is never retried freely.

**Stale claim sweep**: Every 30s, claims older than 90s with no delivery or acknowledgement evidence are requeued and consume retry budget. Delivered-but-silent claims and stale `printing` jobs become terminal failures with an unknown-physical-outcome marker for manual reconciliation.

## 8. WebSocket Architecture

The WebSocket server (`src/server/ws.ts`) implements:

- **Per-agent socket management**: Up to 8 concurrent sockets per agent (rolling reconnect)
- **PostgreSQL LISTEN/NOTIFY**: Real-time job dispatch across gateway instances
- **Automatic reconnection**: Jittered exponential backoff (5s–60s)
- **Ping/pong keep-alive**: 30s server ping interval, 90s idle timeout
- **Back-pressure**: 1MB buffered-amount check before sending
- **Agent capacity fence**: Gateway claims at most 64 live claimed/printing jobs per Agent, matching the Agent local pending ceiling
- **Rate limiting**: Per-agent token bucket (prevents WebSocket abuse)

## 9. Deployment Architecture

### Production Stack

```
Internet → Caddy (reverse proxy + TLS) → Next.js Gateway → PostgreSQL 16
                                                          → Go Agent (per site)
```

- **Caddy**: Handles TLS termination, injects `TRUST_PROXY_SECRET` header
- **Docker**: `Dockerfile` for Gateway, `docker-compose.yml` for full stack
- **Multi-instance**: Multiple gateway instances supported via PostgreSQL LISTEN/NOTIFY

### CI/CD

GitHub Actions with two jobs:
1. **CI**: TypeScript (typecheck, lint, build), unit tests, migration replay, schema verification, integration tests, Go (build, vet, test, race)
2. **Odoo 19**: Full Odoo 19 CE environment with addon installation and test execution (≥80 tests expected)
