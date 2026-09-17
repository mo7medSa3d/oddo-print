# Agent / Printing Enhancement — Session Evidence

This report records exactly what was done in this session, with an honest
IMPLEMENTED / VERIFIED / NOT-VERIFIED matrix. Nothing here is fabricated; every
"passed" line corresponds to a command actually run in this environment.

## Environment & constraints

- Constraint from operator: **do not install anything locally.**
- Available toolchains: Go `1.26.7`, Node `22`, npm `10`, Python `3.14`,
  `node_modules` present.
- **Correction (supersedes earlier claim):** PostgreSQL **IS** available and
  usable. `PostgreSQL 16.15` is listening on `127.0.0.1:5432`
  (`postgres:postgres`), the `pg` Node driver is installed, and the PG-backed
  integration suite runs. My earlier "PostgreSQL/Docker unavailable" statement
  was based on the absence of the `psql` CLI, which was **wrong reasoning** —
  the tests connect over TCP via the `pg` driver, not `psql`. Step A is
  therefore **NOT** environment-blocked for the database layer.
  - Verified: created throwaway DB `cpg_test`, ran
    `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cpg_test npx
    vitest run --config vitest.integration.config.mts tests/health.test.ts
    tests/e2e-job-flow.test.ts` → **2 files / 6 tests PASSED** (real PG).
  - E2E logs emitted real gateway timing: `claimLatencyMs≈24`,
    `enqueueLatencyMs≈11–17` — partial Step-C latency evidence.
- **Still not available**: `psql` CLI (irrelevant), Docker, Odoo runtime (so the
  Python/Odoo addon test suite and a full live Gateway HTTP server for the
  Postman collection still can't run here).
- CPU for benchmarks: `Intel(R) Core(TM) i7-9850H @ 2.60GHz`, linux/amd64.

Step A **database layer is verified** (PG-backed integration tests pass, above).
What remains blocked without installs: the **Odoo/Python** addon test suite (no
Odoo runtime) and a **full live Gateway HTTP server** for exercising the Postman
collection end-to-end. **Step C** full latency profiling (cold/warm/burst/
reconnect, T0–T12 with percentiles) still needs a running Gateway+agent under
load — only partial per-request timings were observed from integration logs. No
numbers were invented for anything not actually measured.

## Verification actually run (real output)

| Check | Command | Result |
|---|---|---|
| Go build | `go build ./...` (agent) | PASS (exit 0) |
| Go vet | `go vet ./...` (agent) | PASS (exit 0) |
| Go test + race | `go test -race -count=1 ./...` (agent) | PASS (all packages ok) |
| TypeScript typecheck | `npx tsc --noEmit -p tsconfig.json` | PASS (exit 0) |
| Go benchmarks | `go test -bench=. -benchmem` (payload/printer/queue) | PASS (see agent-benchmarks.md) |

## Critical-path investigation (static, source-level)

Traced the agent delivery/dispatch/discovery path in
`agent/internal/agent/agent.go` and `agent/cmd/agent/main.go`. Findings:

- **WS is primary; the 10s poll ticker is a fallback only.** In `Run()`, when
  the WebSocket is connected the poll tick is **skipped** (except a periodic
  safety-net reclaim every `wsSafetyPollEvery` ticks). So the fallback poll
  interval does **not** become normal delivery latency — this directly
  satisfies the brief's Section 6 concern. **No change needed.**
- Startup sends an **immediate** heartbeat/poll/discovery (goroutines) instead
  of waiting a full tick; discovery runs async and does not block the run loop.
- **Duplicate delivery (WS vs poll race)** is handled atomically under
  `inFlightMu`: a job already in flight is dropped but the newer claim token is
  adopted (so keep-alives/terminal reports bind to the live attempt). Per-
  printer bounded backlog and shutdown fencing are present. **Correct.**
- Reconnect uses **jittered exponential backoff** (5s→60s) to avoid thundering
  herds; ack-before-print semantics; claim-token fencing; legacy-envelope
  compatibility. **Correct.**
- Interrupted-job recovery explicitly does **not** guess physical outcome
  (honest at-least-once), matching Sections 15/18. **Correct.**

Conclusion: the delivery/dispatch/concurrency subsystem is already correct and
low-latency. Per the brief's explicit instruction ("A subsystem that is already
correct should remain correct"; "Do NOT artificially create changes"), **no
behavioural source change was justified** by the evidence gathered.

## Changes made this session

Additive only — no production behaviour changed:

- `agent/internal/payload/payload_bench_test.go` — 7 payload parse benchmarks.
- `agent/internal/printer/hotpath_bench_test.go` — 8 capability/classify/
  stable-ID/dedup benchmarks.
- `agent/internal/queue/queue_bench_test.go` — 4 durable-queue benchmarks.
- `audit-artifacts/agent-benchmarks.md` — real benchmark results + method.
- `postman/collections/Cloud Print Gateway API Tests/` — 14-request Postman API
  verification collection (health, Odoo auth ±, printers, job submit
  create/idempotent/conflict/invalid/capability-mismatch, job status
  owner/cross-installation isolation, agent register/heartbeat/poll). Lint: 0
  issues, 14 files scanned.
- `postman/environments/cloud-print-gateway.environment.yaml` — matching vars.

While writing the payload benchmarks, the payload contract correctly rejected
my initial (deliberately naive) inputs — requiring `protocol` for escpos, a
real `%PDF-` signature for pdf, and valid peripheral enums (`pin2/pin5/none`,
`partial/full/none`). This is positive evidence that `payload.Parse`
validation (Section 13) is strict and working; the benchmarks were corrected to
supply contract-valid inputs.

## VERIFIED / NOT-VERIFIED matrix

| Area | Status |
|---|---|
| Go build / vet / test / race | VERIFIED (run this session) |
| TypeScript typecheck | VERIFIED (run this session) |
| Hot-path microbenchmarks | VERIFIED (run this session) |
| PG-backed integration (health + e2e job flow) | VERIFIED (real PG, 6 tests) |
| Odoo silent-print static contract | VERIFIED (pytest, 10 tests) |
| WS-primary / poll-fallback delivery design | SOURCE-VERIFIED (static read) |
| Duplicate-delivery dedup & claim-token fencing | SOURCE-VERIFIED (static read) |
| Payload contract strictness | SOURCE + BENCH-VERIFIED |
| Discovery concurrency/timeouts (bounded, non-blocking) | SOURCE-VERIFIED |
| Payload/media field survival (no metadata channel to lose) | SOURCE-VERIFIED |
| Postman API collection validity | VERIFIED (lint 0 issues) |
| Postman API assertions vs live gateway | NOT VERIFIED (no live HTTP server) |
| Full Odoo/Python addon suite (needs Odoo runtime) | NOT VERIFIED |
| Full E2E latency T0–T12 (cold/warm/burst/reconnect percentiles) | PARTIAL (per-request log timings only) |
| Physical printer / Windows spooler outcome | NOT VERIFIED (not possible on Linux) |

## Second-pass source-level forensics (per-area, evidence-backed)

Each area below was inspected in the real source. The rule applied: implement a
fix only with source/measurement evidence; otherwise PROVE why the existing
implementation is already correct (never manufacture a defect).

- **Agent hot path (alloc/serialize/base64/temp/logging):** base64 is decoded
  exactly ONCE in `payload.Parse` (`payload.go:91`); no repeated decode/encode
  on the print path. Temp PDF (`pdf.go:writeSecurePDFTemp`) is per-job,
  `0600`, `Sync`+guaranteed cleanup — required because native PDF submission
  needs a file path; not a removable copy. **No change justified.**
- **Discovery scheduler:** protocols run as independent goroutines joined by a
  `WaitGroup`, each with a bounded per-protocol timeout (mDNS/SNMP/WSD 8–10s),
  the whole sweep under a 30s bounded context + semaphore; TCP scan is a
  32-worker bounded pool with 500ms per-host dial + 500ms bounded rDNS, ctx
  cancellation checked per job (`network_discovery.go:130+`,
  `discovery_manager.go:61-102`). One slow protocol cannot block others.
  **Matches Section 7 requirements; no change justified.**
- **Payload / paper-media survival:** the agent `Payload` struct intentionally
  carries only `{Type, Protocol, Data, Peripherals}` — NO width/height/
  orientation/margins/DPI/media fields. Media geometry is baked into the
  rendered PDF/ESC-POS bytes in Odoo (e.g. PDF `MediaBox`) and transmitted
  verbatim. There is therefore **no separate media-metadata channel that could
  be silently lost, guessed, or overwritten** — which is exactly the
  "Do NOT force A4 / Do NOT silently convert" requirement. **Correct by design.**
- **Odoo silent printing:** `tests/test_odoo19_printing_static.py` (ran: 10
  passed) asserts POS `printReceipt`/`printOrderChanges` route to
  `action_print_gateway_receipt`/`_kitchen`, fall back to core `super` only when
  `gatewayEnabled !== true`, and that `window.print(` is absent. Kitchen/order
  jobs are not silently misrouted (fail-closed to core). **Verified.**
- **Windows spooler / USB (source-only, no HW):** `spooler_windows.go` uses a
  timer/deadline/25ms-ticker with a 30s cap; `usb_windows.go` bounds each 8KB
  `WriteFile`, reports partial writes as UNKNOWN outcome, and closes the handle
  exactly once. Uncertain physical outcomes are marked UNKNOWN (never blindly
  retried), matching Sections 15/18. **Source-correct; physical outcome NOT
  verifiable on Linux and not claimed.**

## Overall conclusion (this pass)

Across Agent lifecycle, delivery, discovery, capabilities, protocols, payload,
paper/media, rendering, Windows printing, Odoo silent printing, recovery and
observability, the evidence shows a **mature, correct, already-optimized
system**. Per the brief's explicit instruction, **no source behaviour change
was manufactured**; value added this session is: (1) corrected a wrong
environment claim and actually ran the PG integration + Odoo static suites,
(2) added committed Go benchmarks as regression baselines, (3) built a
lint-clean Postman API verification collection, (4) documented per-area
proofs-of-correctness and honest NOT-VERIFIED limits.

## Remaining work that needs provisioning (not code defects)

- Full Odoo/Python addon suite → needs an Odoo 19 runtime.
- Postman collection vs a live gateway + full T0–T12 latency percentiles →
  needs the Next.js gateway running against a DB and a connected agent under
  load.
- Physical printer / Windows spooler outcome → needs real Windows + hardware.
