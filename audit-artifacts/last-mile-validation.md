# Last-Mile Forensic Validation Matrix & Concurrency Certification

## Execution & Certification Summary

This document details the final validation commands executed as part of the Last-Mile Independent Production Gate protocol for the Odoo Print Gateway (`mo7medSa3d/oddo-print`).

---

## 1. Concurrency & Printer Lock Architecture Review

### Refinement of Lock Scope (`executeJob` in `agent.go`)
- **Root Cause**: The physical printer mutex (`getPrinterLock(printerID)`) was previously held around local SQLite ledger setup (`BeginPrint`) and initial checks. This caused same-printer waiters to block prematurely before issuing their `updateJobStatus("printing")` HTTP reports to the Gateway.
- **Architectural Fix**: 
  - Local SQLite operations (`BeginPrint`) run outside the physical hardware lock using SQLite's native transaction safety.
  - Gateway status reports (`updateJobStatus("printing")`) execute concurrently for all queued jobs without holding mutexes.
  - The physical printer mutex (`getPrinterLock(printerID)`) is acquired at the physical execution boundary right before `dev.Print()`.
  - The global worker semaphore (`execSem`) is acquired **after** the printer lock, ensuring blocked same-printer waiters do not consume global execution slots.
- **Invariants Preserved**:
  1. `maxPendingJobsPerPrinter = 8` remains strictly enforced as the architectural DoS per-printer backpressure cap.
  2. Physical `Print()` calls for the same printer remain strictly serialized (`maxConcurrentPrints = 1`).
  3. Jobs for different printers execute concurrently up to `maxConcurrentJobs = 8`.

---

## 2. Command Execution Results

### 1. Mandatory Go Race Detector
- **Command**: `cd agent && go test -race -count=1 -p 2 ./...`
- **Exit Code**: `0`
- **Result**: **PASS (0 Race Conditions)**
- **Evidence**: All 9 Go agent packages passed cleanly under `-race`.

### 2. Targeted Concurrency Tests
- **Command**: `cd agent && go test -v ./internal/agent -run "TestDifferentJobsSamePrinterSerialized|TestSamePrinterWaitersDoNotConsumeGlobalExecutionSlots|TestDispatchBoundedAndDrained"`
- **Exit Code**: `0`
- **Result**: **PASS (All Targeted Concurrency Tests Passed in 0.01s)**

### 3. Go Static Analysis & Formatting
- **Command**: `cd agent && gofmt -l . && go vet ./...`
- **Exit Code**: `0`
- **Result**: **PASS (0 Errors, 0 Unformatted Files)**

### 4. Node.js Vitest Unit Suite
- **Command**: `npx vitest run --config vitest.unit.config.mts`
- **Exit Code**: `0`
- **Result**: **300 passed, 5 skipped (0 failures)**

### 5. TypeScript Compiler Check
- **Command**: `npx tsc --noEmit`
- **Exit Code**: `0`
- **Result**: **TYPECHECK_PASS (0 errors)**

### 6. ESLint Code Standard Verification
- **Command**: `npx eslint .`
- **Exit Code**: `0`
- **Result**: **LINT_PASS (0 errors)**
