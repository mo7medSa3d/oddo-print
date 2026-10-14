# Release gates — exact validation steps

Every gate below must read PASS with the stated evidence before a production
release. Gates marked UNVERIFIED have never executed in this environment;
never report them as passing on the basis of unit/integration results alone.

## Local gates (executed during hardening)

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"  # project runtime is 24.21.0 (see .nvmrc); Node 22 fails 9 Argon2 tests
# Keep the host timezone for DB acceptance: the shared PostgreSQL adapter enforces UTC storage/read semantics; a TZ override must not conceal regressions.
npm ci && npm run typecheck && npm run lint && npm test
npm run test:unit && npm run test:integration   # integration needs DATABASE_URL below
npm run build && npm audit
node --experimental-vm-modules --test tests/*.test.mjs
npm run i18n:check && npm run i18n:odoo:check && npm run db:docs:check
pytest tests/test_*.py
cd agent && gofmt -l . && go vet ./... && go test -count=1 ./... && go test -race -count=1 ./...
GOOS=windows go build ./... && GOOS=windows go vet ./...
```

PostgreSQL for integration (throwaway container, removed after the run):

```bash
docker run -d --name gate-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app_db -p 5433:5432 \
  public.ecr.aws/docker/library/postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
docker exec gate-pg pg_isready -U postgres -d app_db
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/app_db
npm run db:migrate
export RUN_MULTI_INSTANCE_TEST=1
npx vitest run --config vitest.integration.config.mts
docker stop gate-pg && docker rm gate-pg
```

Pass criteria: typecheck 0, lint clean, unit 155 files green, integration
59 files green with zero skips beyond documented DB-less skips, Go 10/10
packages ok (plus race), pytest green, pyflakes clean, build green.

## UNVERIFIED — Odoo 19 live suite

Requires Docker + the pinned Odoo image. Runs the addon's 80+ runtime tests
(static source tests are NOT a substitute):

```bash
# Mirror .github/workflows/ci.yml `odoo19` job: start postgres, create
# odoo19_test, then run the container with the addon mounted and assert
# `odoo.tests.stats: print_gateway: N tests` with N >= 80 and
# `0 failed, 0 error(s)`.
```

Must-pass: full `print_gateway` suite green, especially
`test_control_plane.py` (submit loop incl. offline-requeue + park cap),
binding revalidation, and the `-u print_gateway` upgrade path on a copy of
production data (see ODOO_INTEGRATION.md upgrade gate).

## UNVERIFIED — Windows Agent

On windows-latest (see `.github/workflows/build-windows.yml`):

```powershell
cd agent
go test -mod=readonly -race -vet=all ./...
```

Plus, on a real Windows host with printers: pair an agent, run discovery,
send ESC/POS + ZPL + spooler-PDF test pages, verify `CryptUnprotectData`
fails for a second non-admin user (LOCAL_MACHINE scope residual), exercise
service stop during a print (SCM 30s bound), and run
`jobs cleanup --include-unknown` only after physical reconciliation.

## UNVERIFIED — physical printers

Per PRINTERS.md: network RAW/ESC-POS, ZPL-II and TSPL labels, Windows
spooler PDF, IPP/IPPS PDF. For each transport: print, then kill the
network/agent mid-job and confirm the outcome is UNKNOWN (never silent
success, never blind reprint), then recover via the OPERATIONS.md
unknown-outcome runbook as an explicit new attempt.

## UNVERIFIED — browser E2E

No Playwright/Cypress harness exists yet (only jsdom partials:
RTL agreement, tooltip overlay, axe primitives). To close: add a minimal
Playwright smoke — manager login → dashboard loads → locale switch to `ar`
asserts `dir=rtl` → command palette keyboard nav → printer test-print
dialog opens — and run it in CI against the compose stack. Until then,
responsive/RTL/keyboard behavior is covered only by unit-level tests.

## UNVERIFIED — CI-only

- `docker.yml`: full compose build + backup/restore round-trip + Trivy SARIF.
- `security-supply-chain.yml`: `govulncheck`, `cargo audit`, audit-gate fixture.
- `static-security.yml`: CodeQL + secret scan.
- `build-windows.yml`: NSIS installer + Tauri bundle.

Windows release signing identity must come from repository secrets or the
current runner's ephemeral self-signed certificate. Private PFX/passwords must
never be stored in Actions caches: fork pull requests can read base-branch
caches. Delete any existing `yaseir-windows-signing-cert-*` caches and rotate
any affected signing identity before a trusted release; removing the workflow
cache cannot revoke previously exposed keys. Private-key cleanup/rotation is
an external operator gate and was not performed by the local audit.
PR/merge-queue builds receive no release PFX/password or secret-writing token.

The local release helper aligns Go Windows/CGO1 resources with the selected
Tauri MSVC target: x86_64→amd64, i686→386, aarch64→arm64. Non-default targets
require the matching C compiler and native installer acceptance; the current
CI release target remains x86_64. Unknown targets and requested-but-missing
certificates fail before builds. A matching self-signed signature can report
NotTrusted without claiming established publisher trust; signing failures and
unexpected signer identities fail the release.

## Flake watch (must clear before release)

One uncaptured `internal/agent` race FAIL occurred once amid 9+ fresh
passes (including `-count=2`, `-shuffle=on`, 80 targeted stress runs).
Repro attempt: loop `go test -race -count=1 ./internal/agent/` ≥5× with full
logs archived. Prime suspects: timing-sensitive suites (WS/poll reconnect
windows; the 50ms discovery-watchdog test). If it reproduces, capture the
failing test name + `WARNING: DATA RACE` (or timeout) output and file it
before release. The discovery semaphore test was de-flaked (deadline
polling, no fixed sleeps) during hardening.

## Rollout compatibility (mixed-version deploys)

- D-1/D-2/D-6/checkout-liveness: old instances are strictly *more*
  restrictive (409/403) than new ones. During a rolling upgrade some
  renewals or heartbeats take the old path until all instances converge;
  clients already retry those paths, so the window is a transient delay,
  never a split-brain. No flag needed.
- T-2 NOTIFY `tenantId`: new receivers accept legacy notices without the
  field (claim fencing is the second layer); old receivers ignore the
  unknown JSON field. Safe in both directions; the 30s poll loop backstops
  any dropped instant push.
- 0082 must land before 0086 (grace math references non-NULL period ends).
  0083/0084 are independent of each other but share the retention batch
  discipline; land 0084 first so archived receipts carry summaries from
  day one. 0085 is independent (additive columns, closed vocabulary
  enforced at write time on new code; old code simply never sends the
  field).

## Native desktop Gateway pipe acceptance

The paired Agent CLI accepts the existing8MiB body either through legacy
`-body` or selected `-body-stdin`; using both is rejected. The desktop uses
owned stdin, signals EOF after all bytes, and retains command timeout,
output budgets, child kill/reap and bounded pipe joins. A failed helper's
origin/config diagnostics remain visible; an incomplete input write can
never make a successful helper count as accepted.

General response envelopes allow `6 * (8MiB + 64KiB)` bytes: Go JSON escaping
can expand one body/header byte sixfold; the five permitted pagination values
are each at most4096 UTF-8 bytes, with fixed metadata within64KiB. Oversized
allowed metadata rejects the response; cursors are never truncated or silently
dropped. Content-Type and private response headers do not cross this bridge.
Capture preview keeps its existing512KiB envelope/single256KiB JPEG limit;
private PDFs and physical printing remain excluded from capture.

`tests/test_desktop_gateway_io.py` compiles the actual std-only production
Rust pipe functions and embedded tests using the cached pinned compiler;
it supplies no replacement Tauri implementation and exercises no service,
installer, certificate or physical printer. The locked Cargo/Windows IPC
acceptance gate still must pass separately.

### Agent-owned printer sharing release gate

Apply migration `0084`, then deploy this Gateway, then the matching Agent/Desktop and addon sources. Retain protected `printer-sharing.json` beside the existing configuration through upgrade/rollback; an older Agent/Gateway cannot confirm the new publication policy. Do not downgrade an Agent/CLI to a version lacking sharing enforcement while private preferences remain in use; keep the matching bundle or deliberately resolve those preferences before the downgrade. Native acceptance must cover offline/unpaired persistence, service restart/rediscovery/renamed queue aliases, per-user versus service-visible queues, and a sharing change while a job waits for admission. Verify private metadata is absent from heartbeat and remote scan reports, cloud/Odoo lists and new job delivery; existing history/UNKNOWN/outbox results must still reconcile. Completed handoff and a Windows job status never substitute for physical paper inspection.
