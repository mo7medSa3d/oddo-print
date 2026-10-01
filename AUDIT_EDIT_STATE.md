# Audit/edit state

Updated: 2026-10-01 (UTC). Branch: `arena/01a0f87e-oddo-print` (session-fixed; never main).

## Constraints
- No installs, package downloads, toolchain downloads, or dependency updates. Offline flags for compiler/package-manager checks.
- Current source is authoritative; do not read previous audit/checkpoint reports except for a specific needed fact.
- Evidence is actual command output/tests or linked official documentation; runtime claims without evidence are **UNVERIFIED**.
- Schema/API/protocol changes must update all consumers and documentation in the same commit.
- Append a chronological entry to `AUDIT_LOG.md` and update this file after every work step; read both first on resume.

## Quick source map / entry points
```text
.
├── server.ts / proxy.ts / next.config.ts     Gateway HTTP + WebSocket process
├── src/
│   ├── app/                                Next.js pages, actions and API routes
│   ├── components/                         Dashboard / desktop UI
│   ├── db/                                 Drizzle schema + PostgreSQL access
│   ├── lib/                                Auth, tenant scope, jobs, discovery, runtime
│   └── ...                                 Hooks, types and UI assets
├── drizzle/0000…0041*.sql + meta/           Migration source (newer than stated 0036)
├── tests/ + scripts/                       TS/Python tests, migration/build tools
├── agent/
│   ├── cmd/agent/main.go                   Windows service / console Agent entry
│   ├── cmd/cli/main.go                     CLI entry + diagnostics / cleanup
│   └── internal/
│       ├── agent/                         Heartbeat, WS, dispatch, discovery manager
│       ├── printer/                       Winspool / USB / network / IPP / PDF
│       ├── queue/                         Durable SQLite job queue
│       ├── config/ + storage/             Configuration, atomic/secure persistence
│       └── integration/ + testutil/        Existing fakes and integration tests
├── src-tauri/
│   ├── src/main.rs                        Desktop entry, IPC, tray, lifecycle
│   ├── src/agent.rs + commands.rs          Agent child process / CLI commands
│   ├── capabilities/default.json          IPC allowlist
│   └── tauri.conf.json + installer_hooks.nsh
├── odoo_addons/print_gateway/
│   ├── __manifest__.py + __init__.py       Odoo 19 addon entry + assets
│   ├── models/ + controllers/             Config, router, intents/jobs, POS/runtime APIs
│   ├── security/ + views/ + data/          ACLs / record rules, XML UI, cron
│   ├── static/src/                        OWL/POS/report UI + styles
│   ├── migrations/                        Version upgrade hooks
│   └── tests/                             Odoo runtime tests
├── contracts/print-payload-contract.json   Shared print payload contract
└── docs/ + root *.md                      Existing documentation (not bulk re-read)
```
Full tracked source paths were enumerated with `git ls-files` at session start. Initial worktree clean. `docs/DATABASE.md` not present in initial tracked map; actual schema/migrations will determine table count (not assume 20).

## Task list
| Status | Task |
| --- | --- |
| done | Quick map and entry points; initialize mandatory memory files |
| done | Agent: Winspool session (EndDoc/Abort + BOOL verdicts), bounded PRINTER_INFO_2 queries, single-flight Status, level-4 enumeration, fake-based tests |
| doing | Agent: remaining printer backends (network/IPP/USB/PDF), queue/idempotency, reconnect/heartbeat, config/service, CLI |
| todo | Agent: all other printer backends, queue/idempotency, reconnect/heartbeat, config/service and CLI |
| todo | Gateway: all auth/tenant/input/security paths, WS/job dispatch, API consumers |
| done | Gateway DB: schema vs 76 migrations verified in sync; `docs/DATABASE.md` generated; `scripts/check-db-docs.py` added and passing |
| done | Odoo: Python/XML syntax (47 + 9 files), cron fields, jsonrpc routes, ACL/record-rule review |
| done | Gateway: authentication sweep across all 76 API route files |
| done | Cleanup: archived 4 unreferenced old audit snapshots to `archive/` |
| todo | Tauri: IPC/permissions, child lifecycle, shutdown/error paths |
| todo | Odoo 19: Python/XML/JS, ACLs/record rules, transport failures and official API compatibility |
| todo | Cleanup: prove unused references before removing/moving dead code/reports |
| todo | UI/UX: dashboard/core flow accessibility, async states, RTL, responsive polish |
| doing | Pre-push gate: run everything available locally, push, then let GitHub Actions (go build/vet/test -race, staticcheck, npm ci/typecheck/lint/test, Odoo pytest) verify the rest and fix failures |

## Architectural decisions
- Prioritize Windows printer correctness, using Microsoft Learn contracts, preserving honest unknown-outcome semantics: never automatically retry a possibly submitted job.
- Use existing dependencies and standard-library mocks; no environment setup/downloads.
- Treat migrations through 0041 and current schema as reality; do not force the outdated 20-table expectation.

## Last file / RESUME HERE
Last read: `agent/internal/printer/spooler_windows.go` (all 947 lines), Windows tests/stub, `usb_windows.go` first 220 lines; official Microsoft contracts.
**RESUME HERE:** Read both memory files; continue with the other Agent printer backends and lifecycle; the spooler fixes above are written but cannot be compiled here.

## Verification / limitations
- Initial evidence: `git status --short` empty; branch command returned session working branch.
- Blocked: **UNVERIFIED: tool go not available; tool cargo not available; tool rustc not available; tool pytest not available; tool psql not available; tool pwsh not available; tool wine not available.** Node v22.22.3/Python3/GCC present; project node_modules absent and required Node >=24.15.0 absent. No installs/downloads.
- UNVERIFIED: real Windows printers, Windows service, live Odoo 19 and PostgreSQL (no live environment exercised).
