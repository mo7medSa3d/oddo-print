# Agent Architecture

> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) § 2.2, [PRINTERS.md](./PRINTERS.md)

## Overview

The Go Windows Agent is the **data plane** of the print gateway system. It runs on Windows machines with physical access to printers and executes print jobs received from the central Gateway.

## Component Structure

```
agent/
├── cmd/
│   ├── agent/      # Service entry point (Windows SCM + standalone)
│   └── cli/        # CLI commands (pair, gateway-request, printer management/cleanup)
├── internal/
│   ├── agent/      # Core agent logic
│   ├── config/     # YAML configuration + registry paths
│   ├── diag/       # Diagnostic test page generation
│   ├── integration/# Integration tests
│   ├── payload/    # Payload processing (ESC/POS, ZPL, image raster)
│   ├── printer/    # Transport backends + discovery
│   ├── queue/      # SQLite durable local queue
│   ├── storage/    # Persistent key-value store
│   └── testutil/   # Test helpers
```

**Registration response:** HTTPS pairing uses a redirect-disabled client and accepts only a complete HTTP 200 JSON object of at most 1 MiB before persisting Agent credentials. A malformed or truncated Gateway body never rotates local credentials.

## Communication Model

### Primary: WebSocket
- Connects to `wss://gateway/api/agent/ws` with Bearer authentication
- Receives job deliveries in real-time via `print_job` envelope messages
- Sends `job_ack` frames back with claim tokens
- Ping/pong keep-alive (90s idle timeout)
- Automatic reconnection with jittered exponential backoff (5s–60s)

### Fallback: HTTP Polling
- Polls `GET /api/agent/jobs` every 5 seconds when WebSocket is down
- Safety poll every 30 seconds even when WebSocket is connected (catches stuck claims)

The poll decoder verifies the full response framing, byte and 20-job limits before dispatching any job. An extra JSON value or suffix (even after a valid first array) causes a fail-closed batch rejection; the original Gateway claim remains subject to the normal ambiguity-aware recovery rules.

### Heartbeat
- `POST /api/agent/heartbeat` every 30 seconds
- Sends bounded printer inventory with fresh observations and explicit source diagnostics
- Includes keep-alive for in-flight job claims
- Requires explicit application-level acknowledgement for every inventory page; rejected intermediate pages abort the cycle before final-page reconciliation

## Job Execution

### Concurrency Control
- **maxConcurrentJobs = 8**: Jobs physically executing at once
- **maxPendingJobs = 64**: Jobs accepted into the executor (executing + waiting)
- **Per-printer serialization**: One job at a time per physical printer

### Dispatch Flow

```
WS/Poll delivers job
  → Shutdown check (reject if stopping)
  → Dedup check (skip if already in-flight; never adopt a newer claim token)
  → Register in-flight (atomic with WaitGroup.Add)
  → Acquire pending slot (drop + reject if full)
  → Acquire exec semaphore (wait or reject on shutdown)
  → processJob (claim → print → report)
```

### Claim Fencing

The agent carries a `claimToken` through the entire lifecycle:
1. **Admission**: Reserve a local executor slot before acknowledging the delivery
2. **Ack**: Send `job_ack` only after the job is admitted locally; this is not a print-success signal
3. **Status transitions**: All PATCH calls include the token
4. **Heartbeat keep-alive**: Token echoed so Gateway can fence lease refresh
5. **Duplicate delivery**: An already in-flight job is ignored without replacing the active physical attempt claim token

### Crash Recovery

On startup, `recoverInterruptedJobs()` marks locally-tracked "printing" jobs as interrupted:
- `reprint_after_crash=true`: Explicitly asks the Gateway to requeue the current `printing` claim using the preserved claim token (at-least-once; may duplicate paper)
- `reprint_after_crash=false`: Reports the job as failed (conservative)

Either way, the physical outcome is recorded as UNKNOWN.

## Printer Discovery

### Discovery Phases

1. **Quick discovery** (synchronous at startup):
   - Config file printers
   - Windows Spooler enumeration
   - Registry (printers.json) reload

2. **Full discovery** (async, 2s after startup):
   - Network TCP 9100 scan (512 unique-host budget shared across local subnets per source; capped scans are partial evidence, TCP reachability is not hardware readiness)
   - USB enumeration (Windows)
   - IPP endpoint probes and IPP/IPPS DNS-SD advertisements; a valid DNS-SD advertisement supplies explicit IPP/IPPS transport metadata and may enter runtime inventory, while physical health remains `unknown` until the bounded runtime IPP status probe observes the endpoint
   - LPR/LPD discovery-only probes (candidates are not registered because LPR execution is not supported)
   - SNMP sysDescr queries across local private interfaces; identity and read-only discovery do not prove print capability
   - WSD discovery (bounded 512 observations; cancellation/socket errors and cap exhaustion preserve partial results **without declaring a complete source**)
   - DNS-SD/mDNS discovery with an independent resolver lifetime for each browse
   - The Gateway can request a per-session timeout; the Agent clamps it to the Gateway contract range of 500 ms–30 s.

3. **Periodic rediscovery** (every 30s, gateway-directed):
   - Processes pending discovery sessions from the gateway

### Printer Registry

Discovered printers are persisted to `printers.json` using `UpsertRegistry()`. This enables:
- Startup without rediscovery (instant load from cache)
- Manual registration persistence
- Idempotent re-merging on rediscovery

## Print Transports

| Transport | Protocol | Description |
|-----------|----------|-------------|
| RAW TCP | `raw` | Direct TCP socket write |
| ESC/POS | `escpos` | Thermal receipt printer commands |
| ZPL | `zpl` | Zebra label printer commands |
| TSPL | `tspl` | TSC label printer commands |
| Windows Spooler | `spooler` | Windows print queue (driver-rendered) |
| IPP | `ipp` | Internet Printing Protocol |
| IPP/S | `ipps` | IPP over TLS |

## Local Queue

SQLite database with WAL mode for crash durability. Tracks:
- Job ID, printer ID, status
- Claim token for gateway correlation
- Interrupted marker for crash recovery
- Result (success/failed/unknown) with reason

Discovery reports use the additive `errors: string[]` contract in `contracts/print-payload-contract.json` (maximum 64 messages, 2048 UTF-16 units each). The Gateway returns these in session `stats.errors`; optional unavailable device fields are omitted, and protocol defaults to `unknown`. Odoo consumes approved runtime printers, not discovery candidates or source diagnostics; no addon producer emits discovery reports.

New physical dispatch requires an acknowledged, claim-fenced `printing` response (`success: true`, `status: "printing"`). Local delivery receipt age is diagnostic only; a buffered frame may already have a stale claim. An unacknowledged admission sends no hardware bytes. Printing that already crossed this boundary retains its durable outcome reporting through a later disconnect. Repeated admission for the same live printing claim is acknowledged without creating another job or physical attempt.

PDF rendering preserves the caller-assigned deadline and cancellation throughout document dispatch. Kind-specific timeouts apply only without a caller deadline. Windows aborts unfinished GDI documents; an abort does not prove that no physical page was emitted, so post-admission failures remain unknown outcomes.

Terminal Agent reports echo their immutable attempt claim token. Matching closed-attempt SHA-256 evidence permits acknowledgement retries of the same terminal status only; it cannot authorize execution, replace evidence or extend reconciliation age. Agents retain terminal outbox tokens until the JSON response confirms success and the requested status. New claims clear closed acknowledgement evidence.

CLI printers discover --json retains its array contract and adds optional agentId on each local device from the loaded configuration. Tauri preserves this owner provenance; discovered USB/Windows queue choices are offered only for that Agent. Unpaired discovery remains visible but cannot be assigned to an unrelated remote Agent. USB discovery strings are hexadecimal; registration explicitly prefixes 0x and sends validated numeric VID/PID values to the Gateway.
