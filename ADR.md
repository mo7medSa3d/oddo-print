# Architecture Decision Records (ADR)

> **Document Status**: Approved  
> **Repository**: Yasser Cloud Printing Platform (`mo7medSa3d/oddo-print`)  
> **Last Updated**: 2026-09-15

---

## ADR-001: Modular Monolith vs. Microservices Architecture

* **Context**: The Gateway platform requires user authentication, tenant management, billing, agent management, printer inventory, job queueing, and Odoo integration.
* **Decision**: Adopt a **Modular Monolith** control plane (Next.js 16.3.4 App Router + custom HTTP/WebSocket server in a single codebase and deployment unit).
* **Rationale**:
  * Eliminates distributed transaction failures, network latency between internal services, and complex service mesh overhead.
  * Simplifies CI/CD, local development, migration management, and operational debugging.
  * Domain modules (`lib/auth`, `lib/routing`, `lib/job-delivery`, `lib/tenant-guard`) are cleanly separated with explicit interfaces, preserving a future path to extraction if bounded contexts exceed throughput limits.
* **Rejected Alternative**: Microservices architecture with separate Auth, Printer, Queue, and Billing services. Rejected due to premature operational complexity and lack of multi-team ownership requirements.

---

## ADR-002: Control Plane / Data Plane Separation

* **Context**: Print jobs originate in the cloud (Odoo SaaS / Cloud Gateway) but must execute on physical local hardware (LAN/USB/Windows Spooler) behind corporate NATs and firewalls.
* **Decision**: Split the system into:
  1. **Control Plane** (Cloud Next.js Gateway): Manages identity, tenancy, authorization, queueing, and routing.
  2. **Data Plane** (Edge Go Windows Service Agent): Runs on local Windows host, discovers local hardware, establishes outbound connections to Gateway, and executes physical prints.
* **Rationale**:
  * Cloud control plane never requires inbound open firewall ports or VPNs to customer local networks.
  * Windows Agent has direct OS-level access to the Windows Print Spooler (Win32 API) and direct LAN socket access.
* **Rejected Alternative**: Direct cloud-to-printer TCP printing (requires customer public IP/port forwarding, insecure and brittle).

---

## ADR-003: PostgreSQL as the Single Source of Durable Truth

* **Context**: The Gateway requires durable relational storage, ACID transactions, atomic queue claiming, multi-tenant referential integrity, and cross-instance real-time job notifications.
* **Decision**: Use **PostgreSQL 16** with **Drizzle ORM** for all control plane persistence, queue management, and pub/sub (`LISTEN/NOTIFY`).
* **Rationale**:
  * Eliminates external message brokers (Redis/RabbitMQ/Kafka).
  * Enables atomic transactional transitions between job creation, quota deduction, and audit logging.
  * Supports `FOR UPDATE SKIP LOCKED` for concurrent safe queue workers.
  * Composite foreign keys `(tenant_id, id)` enforce relational tenant isolation at the database engine level.
* **Rejected Alternative**: Separate Redis Queue + MongoDB + PostgreSQL. Rejected to eliminate dual-write consistency hazards.

---

## ADR-004: Pool Multi-Tenancy with Incremental Scaling Path

* **Context**: The SaaS platform must serve multiple customer organizations securely while maintaining cost-effective infrastructure.
* **Decision**: Implement **Pool Multi-Tenancy** (shared database, shared schema, composite foreign keys) with a documented roadmap toward Bridge (schema-per-tenant) and Silo (database-per-tenant).
* **Rationale**:
  * Maximizes resource utilization and simplifies unified schema migrations across all tenants.
  * Composite foreign keys and application-level `requireActiveTenant` guards prevent cross-tenant data leakage.
* **Rejected Alternative**: Silo-only multi-tenancy (too expensive and complex for initial SaaS customer onboarding).

---

## ADR-005: Strict Odoo Ownership Boundaries

* **Context**: Odoo ERP has rich data models for companies, branches, POS configs, and reports.
* **Decision**: Odoo **owns** all business context (companies, branches, report definitions, print intents, bindings). The Gateway **owns** runtime infrastructure (tenants, agents, printers, job queue).
* **Rationale**:
  * Prevents shadow ERP models and schema synchronization drift in the Gateway.
  * Gateway only deals with opaque tenant IDs, agent IDs, and printer IDs.
* **Rejected Alternative**: Mirroring Odoo company and branch hierarchies as first-class domain models in the Gateway.

---

## ADR-006: Go Windows Service Agent with Local SQLite Queue

* **Context**: The edge agent must run reliably as an unattended Windows Service (Win32 SCM) with minimal resource consumption (<50MB RAM) and zero runtime dependencies.
* **Decision**: Implement the edge agent in **Go** as a single statically compiled binary with an embedded **SQLite WAL** database for local crash recovery and offline job buffering.
* **Rationale**:
  * Native Windows Service integration, low footprint, zero DLL/runtime dependencies.
  * SQLite WAL mode ensures local job state survives unexpected process terminations or power outages.
* **Rejected Alternative**: Electron or Python-based agent (excessive memory consumption and dependency bundling complexity).

---

## ADR-007: Database-Backed Queue with Claim Fencing

* **Context**: Concurrent Gateway workers and agent instances must claim and process print jobs without double-printing or race conditions.
* **Decision**: Implement an atomic claim protocol using PostgreSQL `FOR UPDATE SKIP LOCKED` and randomized cryptographic `claim_token` fencing.
* **Rationale**:
  * Prevents double-delivery when multiple agents or gateway workers process queue backlog.
  * Claim tokens reject stale status updates from superseded delivery attempts.
* **Rejected Alternative**: Optimistic concurrency without fencing (risks double-printing on network partitions).

---

## ADR-008: End-to-End Idempotency

* **Context**: Network failures during job submission from Odoo to Gateway or Gateway to Agent can cause duplicate HTTP POSTs.
* **Decision**: Enforce unique `idempotency_key` constraints at both Odoo Outbox and Gateway Database levels.
* **Rationale**:
  * Retrying a failed HTTP request re-attaches to the existing job record rather than creating a duplicate.
* **Rejected Alternative**: Client-side deduplication alone (fails when client restarts).

---

## ADR-009: WebSocket Primary Channel + HTTP Polling Fallback

* **Context**: Low-latency print delivery is essential for POS counters, but WebSockets can be dropped by NAT firewalls, proxies, or network switches.
* **Decision**: Use **WebSocket** (`/api/agent/ws`) as the primary real-time push transport, backed by an autonomous **HTTP Polling** loop (every 10s when offline, safety poll every 30s when online).
* **Rationale**:
  * Sub-100ms real-time delivery during normal operation.
  * 100% reliable job delivery even under hostile corporate firewalls that terminate long-lived WebSocket connections.
* **Rejected Alternative**: WebSocket-only transport (causes silent outage on proxy WebSocket drop).

---

## ADR-010: No Premature Infrastructure (Kafka, Redis, RabbitMQ, K8s)

* **Context**: Industry hype often pushes microservices and complex distributed messaging layers for SaaS startups.
* **Decision**: Explicitly prohibit Kafka, RabbitMQ, Redis, Kubernetes, or service meshes until concrete telemetry demonstrates PostgreSQL/Next.js capacity limits.
* **Rationale**:
  * Standard PostgreSQL 16 on a modern multi-core instance easily handles 1,000+ print jobs per second with sub-10ms query latency.
  * Dramatically reduces operational burden, infrastructure costs, and failure modes.
* **Rejected Alternative**: Introducing Kafka/RabbitMQ for event streaming.

---

## Architecture Tradeoffs Summary Matrix

| Decision | Chosen Architecture | Rejected Alternative | Primary Advantage | Accepted Tradeoff |
| :--- | :--- | :--- | :--- | :--- |
| **App Topology** | Modular Monolith | Microservices | High velocity, simple transactions | Shared deployment lifecycle |
| **Data Plane** | Go Native Service | Electron / Node Agent | 15MB RAM footprint, robust Win32 SCM | Cross-compilation toolchain required |
| **Storage** | PostgreSQL + Drizzle | Polyglot (Mongo + Redis) | Single source of truth, ACID transactions | Database CPU scales with throughput |
| **Queue** | DB `SKIP LOCKED` | Kafka / RabbitMQ | Zero extra infrastructure, transactional | Table vacuuming needed at high volume |
| **Real-time** | WS + Polling Fallback | Long-polling only / WS only | Low latency + firewall resilience | Must maintain two delivery code paths |
| **Tenancy** | Pool (Composite FKs) | Silo (DB-per-tenant) | Low cost, unified migrations | Application must enforce tenant filters |
