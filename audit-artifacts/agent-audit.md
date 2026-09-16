# Print Agent Audit Report

## 1. Subsystem Overview
- **Language**: Go 1.23+
- **Architecture**: Daemon service (`agent/cmd/agent`) + CLI control tool (`agent/cmd/cli`) + SQLite local durable ledger (`agent/internal/queue`).

---

## 2. Invariants & Concurrency Rules

| Rule / Invariant | Value | Implementation File | Verification Result |
|------------------|-------|---------------------|---------------------|
| `maxPendingJobsPerPrinter` | `8` | `agent/internal/agent/agent.go` | **PASS** (Enforced in `dispatchJob`, contract verified in `dos-hardening-contract.test.ts`) |
| `maxConcurrentJobs` | `8` | `agent/internal/agent/agent.go` | **PASS** (Buffered semaphore `execSem` channel) |
| Physical Lock Scope | Hardware Only | `agent/internal/agent/agent.go` | **PASS** (Acquired around `dev.Print()`, outside network status reports & `BeginPrint`) |
| SQLite Retention Ticker | 24 Hours (7d retain) | `agent/internal/agent/agent.go` | **PASS** (Daily ticker calls `CleanupTerminal(7)`) |
| Windows Spooler Memory | `runtime.KeepAlive` | `agent/internal/printer/spooler_windows.go` | **PASS** (Defers added for UTF-16 pointers) |
| Secure Server URL | Opt-In HTTP | `agent/internal/agent/pairing.go` | **PASS** (`ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP=1` required for HTTP URLs) |

---

## 3. Concurrency & Race Detector Certification
- **Go Race Detector**: `cd agent && go test -race ./...` passed with **0 race conditions** across all 9 packages.
- **Go Vet**: `cd agent && go vet ./...` passed with **0 warnings**.
- **Go Code Format**: `gofmt -l .` passed with **0 unformatted files**.
- **Targeted Concurrency Suite**: `TestDifferentJobsSamePrinterSerialized` and `TestSamePrinterWaitersDoNotConsumeGlobalExecutionSlots` pass in 0.01s.
