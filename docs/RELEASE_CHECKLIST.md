# Release checklist — Yaseir Cloud Printing Platform RC 2026-10-12

Base: `a0b5a8e9` plus the uncommitted 97-path tree archived at
`/home/mo7amed_saad/release-archives/yaseir-rc-20261012-final`
.Servlet. Do not release on `main` without every row below reading VERIFIED.

## Local gates — VERIFIED

| Gate | Result | Evidence |
|---|---|---|
| `typecheck`, `lint` (Node 24.21.0) | PASS | exit 0, this environment |
| Unit `test:unit` | 155 files / 1018 tests PASS | vitest output; DB-independent |
| Integration (PG 16.15, `TZ=UTC`, `RUN_MULTI_INSTANCE_TEST=1`) | 59 files / 433 tests PASS | incl. 8 new files / 20 tests; every P1 fix RED-verified via stash |
| Node `.mjs` contracts | 355 PASS | `node --test` output |
| Odoo static (`pytest tests/test_*.py` + pyflakes) | 481 PASS | 5 regressions triaged to intended contract changes |
| Go `gofmt`, `go vet`, `go test -count=1` | 10/10 ok | uncached run |
| Go `go test -race -count=1` | 10/10 ok; agent pkg ×11 fresh passes (`-count=2`, `-shuffle=on`, 80× new-test stress) | logs in release archive |
| `GOOS=windows` build + vet | PASS (compile-only) | — |
| `npm run build`, `npm audit` | PASS, 0 vulns | — |
| i18n web/odoo, `db:docs:check` | sync | catalog repaired for new strings |
| Every P1 fix RED→GREEN | verified via `git stash push -- <src>` | see hardening report |
| Recovery archive | 97/97 checksums, clean re-apply | release-archives dir |

## UNVERIFIED — must close before production

| Blocker | Evidence needed to close |
|---|---|
| Odoo 19 live suite (≥80 tests, upgrade path) | `docs/RELEASE_GATES.md` → Odoo 19 section green in CI |
| Windows race + service + DPAPI + spooler drill | `go test -race` on windows-latest; second-user decrypt refusal; SCM-stop drill |
| Physical-printer E2E per transport + UNKNOWN drill | PRINTERS.md matrix + OPERATIONS runbook walk-through |
| Browser E2E (no harness exists) | Playwright smoke per `docs/RELEASE_GATES.md`; jsdom partials only |
| CI-only (docker round-trip, Trivy SARIF, supply-chain, CodeQL, NSIS) | green workflow runs on this tree |
| Race flake (1 uncaptured FAIL vs 11 passes) | ≥5 archived full-log agent-race passes or a captured root cause |
| Approvals: MIGRATION_PLANS.md 0082–0086, A-12, D-5, I-6 | explicit product sign-off per item |

## Do-not-release rules

- No commits/pushes were made; the candidate is the archived tree, not a branch.
- Never reuse an idempotency key for a new operation; never flip a terminal
  row to `queued` by hand; never delete the agent SQLite file; never run a
  migration from MIGRATION_PLANS.md without its stated approval.
- `past_due` keeps print access during recovery by design; NULL-period
  `active`/`trialing` rows are treated as live until 0082 lands.
