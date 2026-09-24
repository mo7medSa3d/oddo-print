# Agent Architecture

> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) § 2.2, [PRINTERS.md](./PRINTERS.md)

## Overview

The Go Windows Agent is the **data plane** of the print gateway system. It runs on Windows machines with physical access to printers and executes print jobs received from the central Gateway.

## Component Structure

```
agent/
├── cmd/
│   ├── agent/      # Service entry point (Windows SCM + standalone)
│   └── cli/        # CLI commands (register, discover, test-print, etc.)
├── internal/
│   ├── agent/      # Core agent logic (1911 lines)
│   ├── config/     # YAML configuration + registry paths
│   ├── diag/       # Diagnostic test page generation
│   ├── integration/# Integration tests
│   ├── payload/    # Payload processing (ESC/POS, ZPL, image raster)
│   ├── printer/    # Transport backends + discovery
│   ├── queue/      # SQLite durable local queue
│   ├── storage/    # Persistent key-value store
│   └── testutil/   # Test helpers
```

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

### Heartbeat
- `POST /api/agent/heartbeat` every 30 seconds
- Sends full printer inventory with live status probes
- Includes keep-alive for in-flight job claims

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
- `reprint_after_crash=true`: Leaves the job for gateway lease reclaim (at-least-once)
- `reprint_after_crash=false`: Reports the job as failed (conservative)

Either way, the physical outcome is recorded as UNKNOWN.

## Printer Discovery

### Discovery Phases

1. **Quick discovery** (synchronous at startup):
   - Config file printers
   - Windows Spooler enumeration
   - Registry (printers.json) reload

2. **Full discovery** (async, 2s after startup):
   - Network scan (mDNS/DNS-SD, SNMP, raw port probe)
   - IPP discovery
   - USB enumeration
   - Full LAN scan with bounded timeout

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
