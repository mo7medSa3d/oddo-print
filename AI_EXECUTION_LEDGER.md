# Actual engineering execution ledger - 2026-10-08

Repository baseline `mo7medSa3d/oddo-print` main `fa2c5ab021e6bea6ce0af8383d5f22b5207b7b3b`.
Branch `engineering/poll-claim-budget-20261008`; existing GitHub PR #127.
This session did not consume historical agent findings/logs as proof. See `FINAL_VERIFICATION_REPORT.md` for 30 phase evidence and limits.

| Area / Phase | Status | Actual source change and evidence | Remaining |
|---|---|---|---|
| Phase 08, queue claim | PARTIAL / corrected locally | Fixed oversized HTTP polling claim BEFORE update; 2 regression tests passed; `tests/ws-claim-delivery.test.ts` PG regression authored | PG-backed run and concurrency CI |
| Phase 24, noisy-neighbor limit | PARTIAL / corrected locally | Existing queued payload budget uses uncompressed JSON bytes; 2 native tests pass; new PG integration test classified for CI | Actual PG integration/load benchmark |
| Phase 26, recovery | PARTIAL / corrected locally | Zero/huge configured sweep batch corrected; 4 direct production-expression tests pass | Restart and PG crash-injection |
| Phase 00, 01-07, 09-23, 25 | PARTIAL or BLOCKED | See specific phase source evidence in FINAL_VERIFICATION_REPORT.md; do not mark as passes | Runtime and negative tests |
| Phase 27, CI | PARTIAL / CI green | GitHub source commit 7c782b2: 929 Vitest unit pass / 6 skipped; 392 PG integration pass; 235 Python pass; 209 real Odoo19 pass; Go race/vet, Typecheck, lint, Next build, Docker & security PASS | Windows NSIS workflow/physical E2E |
| Phase 28, physical E2E | BLOCKED | No physical printer or Windows agent/Odoo19 lab | Real deployment and paper output |
| Phase 29, certification | NOT READY | Readiness classification below | All gate evidence |

### GitHub changes (real source)

1. `a06a958a99c04de42a51bd4acf2f7b488e48195d` - `fix(queue): budget HTTP poll claims before marking delivery pending`.
2. `479b941e201cec2e0c7621541443b883dfa412c3` - `fix(queue): enforce per-agent payload budget on uncompressed JSON bytes`.
3. `1bbb095e36b8535521b1afc1356263a9ea662834` - `fix(maintenance): clamp recovery sweeps to safe nonzero batches`.
4. `0b0c633d402e9a97dac9c7725e9b3f257d0285c7` - `test(ci): register queue payload regression in PostgreSQL integration suite`.
5. `7c782b227bd8a16e48989feba4b0f1e9c166a7a3` - `test(queue): use canonical max-size base64 payload in integration regression`.

### Toolchain and fact boundaries

Local Node 22.16, Go 1.23.2, Python 3.13.5, missing PostgreSQL/Docker/Rust/Windows. GitHub CI supplies Node 24, Go 1.26, PostgreSQL 16, an Odoo19 container and Windows build workflows; outcomes must be checked against the current PR HEAD, never assumed green. No E2E latency or physical printer measurement was invented. Do NOT merge to main based on this report alone.
### Current live CI evidence (source commit 7c782b2)

- CI https://github.com/mo7medSa3d/oddo-print/actions/runs/37828492290 (Go/Node/PG16/Odoo19 passing)
- Docker https://github.com/mo7medSa3d/oddo-print/actions/runs/37828492395 (passing)
- Security https://github.com/mo7medSa3d/oddo-print/actions/runs/37828492429 and https://github.com/mo7medSa3d/oddo-print/actions/runs/37828492311 (passing)
- Windows https://github.com/mo7medSa3d/oddo-print/actions/runs/37828492253 (completion unverified as of this checkpoint)

No physical printing or realistic 10k-tenant benchmark was executed. The 30 phase evidence table is in FINAL_VERIFICATION_REPORT.md. Do not declare PRODUCTION READY.
