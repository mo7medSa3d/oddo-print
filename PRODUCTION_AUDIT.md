# Production audit — 2026-10-03

Snapshot: uploaded archive, Git archive comment `52c422a93af3e04fbe6ed2ea9ace31058682930c`.

## Release decision

**BLOCKED pending verification.** Passing static/unit checks do not establish production readiness. This report distinguishes reproduced defects, source-proven defects, historical claims, and unavailable runtime checks. Earlier AUDIT_LOG.md/AUDIT_EDIT_STATE.md reports are historical, not proof for this snapshot.

Severity: P0 = immediate critical compromise/unsafe physical effect; P1 = major broken flow/security boundary; P2 = degraded correctness/reliability/coverage; P3 = cleanup/cosmetic.

## Architecture and critical contracts reviewed

- Odoo business events persist intents in their business transaction; post-commit dispatch creates a durable outbox, retaining the idempotency key across ambiguous submissions. Odoo owns company/branch bindings; Gateway owns tenant/runtime inventory and billing admission.
- Gateway hashes one-time pairing codes and agent credentials; runtime calls scope agents/printers/jobs by tenant. Pairing consumption, lifecycle fences, billing checks, quotas and claims rely on PostgreSQL locks/transactions, not process-local flags.
- Polling and WebSocket share claim tokens, attempt budgets and a 64-job in-flight ceiling. Agents persist execution in SQLite before hardware; unknown physical outcomes must never become automatic reprints under the default policy. TCP/spooler acceptance is not proof of paper output.
- Heartbeats carry paginated observations, tokened keep-alives and desired-state acknowledgements. Only the final response is a complete manager-owned desired-state snapshot. Freshness, lifecycle and capabilities gate delivery.
- Windows agent service/CLI use a shared ProgramData location and sealed secrets. Tauri confines native commands to local capabilities and proxies credentials in Rust. Gateway uses the custom server; `next start` alone bypasses WebSocket and admission middleware.
- Production Compose orders migrations before Gateway, keeps PostgreSQL/app ports internal, and terminates TLS in Caddy with an authenticated proxy header. Secure cookies and clean HTTPS origin are startup requirements.

Review coverage: runtime/auth/billing/queue/heartbeat routes and their helpers, database schema/migration journal and migration checker, Go lifecycle/pairing/discovery/printing/ledger contracts, Rust proxy/autostart/paths/capabilities, Odoo controllers/router/outbox/intents/configuration/security, frontend shared UI/i18n/desktop entry, deployment and all workflow YAML. Source scans include Python undefined names, TODO/conflict markers, transport/command execution, permissions and pinned dependency/config references. Coverage is source/contract review, not exhaustive proof of every branch or hardware behavior.

## Findings before fixes

| ID | Sev | Component / evidence and root cause | Production impact | Exact fix |
|---|---|---|---|---|
| A01 | P1 | `odoo_addons/print_gateway/controllers/runtime_printers.py`: eight `_()` calls with no import; pyflakes F821. | Discovery network/HTTP/invalid-response errors become NameError; Arabic errors also bypass translation in scope checks. | Use explicit Odoo environment translation (`request.env._`/`env._`), preserve actionable error propagation. |
| A02 | P1 | `models/print_router.py::_render_pdf_payload` and `_render_pdf_payload_from_target`: `pdf_content, _ = ...` makes translator `_` local; pyflakes F823. | Empty records/render exceptions raise UnboundLocalError instead of the intended error. | Give the report format return value a named variable. |
| A03 | P1 | `src/app/api/agent/register/route.ts`: outer subscription SELECT uses a tenant EXISTS subquery, then FOR UPDATE locks every outer subscription row. | Pairing blocks unrelated tenants and can contend/deadlock with billing mutations. | Use canonical `liveTenantSubscriptionWhere` on the actual `ts` row being locked. |
| A04 | P1 | `agent/internal/printer/ipp.go::getPrinterAttributes`: credentials applied to print POST but omitted from status POST. | Authenticated IPP printers become unknown and unavailable despite valid credentials. | Apply configured Basic Auth to the bounded, nonredirecting status request; test it. |
| A05 | P1 | `IPPPrinter.Status`: `printer-is-accepting-jobs=false` maps to busy; busy is executable at Gateway. | Jobs are delivered to a device explicitly rejecting new jobs; misleading online UI. | Report offline for explicit rejection; retain busy for processing/accepting devices. RFC 8011 §5.4.12. |
| A06 | P1 | `parseIPPStatus`: accepts an eight-byte success header even when attribute framing is truncated/missing end-of-attributes. | Truncated/invalid printer responses can falsely report successful submission. | Validate complete IPP response framing before accepting status; malformed submission remains outcome-unknown. |
| A07 | P1 | `network.go::writePrintPayload`: SetWriteDeadline error after earlier writes returns ordinary error. | Partially transmitted work may be classified safe to retry. | Return unknown outcome whenever bytes were already transmitted, including deadline setup failures. |
| A08 | P1 | `src/lib/log.ts`: only top-level keys redacted; nested objects and enumerable Error properties bypass sensitive-key checks. | Nested credentials/payloads can leak to logs; BigInt can crash the logger. | Recursively redact/bound/serialize values and errors, retaining opaque claim IDs. |
| A09 | P2 | `src/lib/metrics.ts`: online gauges count raw flags without heartbeat/printer freshness or parent lifecycle. Errors are silently swallowed. | Monitoring claims healthy fleet during stale/disabled/offline parent conditions; storage failures invisible. | Derive gauges from the same freshness/lifecycle gates and log metric persistence/read failures. |
| A10 | P1 | `scripts/audit-gate.mjs`: dev-only means absent from direct dependencies; ignores lockfile transitive runtime classification. Severity handling does not match stated high threshold. | An allowlisted vulnerability can migrate into runtime unnoticed; audit infrastructure responses can be misclassified. | Validate report schema and status, advisory severity/package binding and lockfile node dev flags; behavioral fixtures. |
| A11 | P2 | `src-tauri/src/commands.rs::apply_autostart_choice`: rollback uses `!enabled`, assuming prior state differs. | Idempotent request plus marker failure flips the original OS setting; get_autostart suppresses OS errors. | Capture actual prior state and restore it, propagate read errors; test both idempotent cases. |
| A12 | P2 | `print_gateway_backend.scss`: physical margins/borders/text-left in pairing and alert UI. | Arabic/RTL accents and subtitle alignment remain on the wrong side. | Use logical inline margins/borders and text-align:start. |
| A13 | P2 | `scripts/db-migrate.ts`: env detection omits DATABASE_URL_FILE/PGPASSWORD_FILE despite runtime support. | File-mounted connection-only config fails migration preflight. | Resolve database settings through runtimeSecret. |
| A14 | P2 | `src/lib/password.ts::verifyPassword`: ignores encoded version and accepts unbounded password input. | Malformed stored hash version is silently treated as Argon2 v19; helper callers lack uniform input bounds. | Validate version and password length before derivation. |
| A15 | P2 | `server.ts`: Next handler promise is neither returned nor awaited; request URL constructed from untrusted Host outside error boundary. | Async handler failures escape guard logging; malformed Host can throw synchronously. | Return handler promise; use a fixed-origin protocol request since proxy auth inspects headers. |
| A16 | P2 | Python static CI lacks undefined-name validation; existing pytest contracts miss A01/A02. | Broken production exception paths pass tests and compile checks. | Add AST/behavior regression tests plus undefined-name CI check. |
| A17 | P3 | Python unused imports/locals outside Odoo registration __init__ files. | Misleading/dead code, duplicate failover constant; unnecessary maintenance. | Remove actual unused imports/locals, retain import-driven model/controller/test registration. |
| A18 | P2 | `scripts/check-i18n.ts`: singular/dual exemption permits dropping every variable, not just count. | Lost non-count placeholders pass locale validation. | Exempt count alone; preserve all other placeholder multiplicities. |
| A19 | P2 | `runtime_printers.py::runtime_agents` catches HTTP ValidationError and returns empty disabled inventory. | Remote discovery failures look like disabled/unconfigured integration. | Separate missing/config-invalid response from Gateway HTTP errors and propagate translated actionable errors. |

| A20 | P2 | `agent/internal/printer/wsd_discovery.go::discover`: pre-cancelled discovery sends multicast before checking context. Existing cancellation test reproduced a network error. | Shutdown can perform unnecessary I/O and report discovery failures after cancellation. | Return immediately for a cancelled context before opening a socket. |
| A21 | P2 | `agent/internal/printer/health_test.go`: three listeners use fixed ports, including 19997 also used by another package. Full parallel Go tests reproduced address-in-use. | Nondeterministic CI failures mask actual printer regressions. | Allocate OS-selected ports and pass listener addresses to the printer under test. |
| A22 | P1 | `agent/cmd/agent/main.go` / `src-tauri/installer_hooks.nsh`: installing an existing service fails without updating its binary/config path; NSIS ignores command results and leaks plugin stack values. | Upgrades can retain the previous executable, report false success, or remove files while service removal failed. | Reconfigure only a stopped existing service, preserve its account/identity, check install/start/uninstall exit codes and missing resources, drain plugin results; refuse removal of a running service. |
| A23 | P2 | `agent/go.mod`: `golang.org/x/crypto v0.54.0` contains GO-2026-6354/6355/6303, discovered by verbose govulncheck. No imported vulnerable package/symbol was detected. | Avoidable vulnerable dependency footprint and future SSH-import exposure. | Upgrade to v0.56.0 and its required x/text v0.41.0; tidy and verify the locked module graph. |
| A24 | P3 | `tests/ci-toolchain.contract.test.ts`: regex permits only `go 1.26`, whereas modern Go normalizes to `go 1.26.0` during dependency upgrades. Reproduced one failing unit test after A23. | Correct toolchain alignment is incorrectly rejected. | Accept equivalent minor/zero-patch language declarations while keeping the required version assertion. |
| A25 | P3 | `src-tauri/build.rs`, `src-tauri/src/*.rs`: `cargo fmt --all -- --check` produced formatting diffs. | Inconsistent Rust style and failure of the available formatting check. | Apply the repository's Rust formatter and rerun the check. |

## Dependency and architecture risks

- **P2 R01 unresolved upstream:** npm reports high-severity `braces <=3.0.3`, GHSA-vfj7-8cjw-p6xm; no published fix reported. Reachable via trusted ESLint configuration in the dev tree. Production audit must remain clean and exception must be verifiably dev-only. Do not invent a patched release or erase the advisory. Sources: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm and https://github.com/micromatch/braces/issues/73.
- **P3 R02 upstream maintenance:** ESLint 9 is unsupported; current ESLint 10.12.0 is outside the current upstream `eslint-plugin-react` and `eslint-plugin-import` peer ranges (verified with `npm view`). Drizzle-kit 0.31.10 pulls deprecated esbuild-kit packages; upstream 0.31.11 is available, but does not establish removal of that upstream dependency chain. These are retained maintenance risks, not silently overridden peer constraints. A compatible upstream migration remains necessary.
- **P2 R03 upstream Rust advisories:** cargo-audit scans 477 locked crates and reports seven warnings: proc-macro-error (RUSTSEC-2024-0370); unic-char-property (2025-0081), unic-char-range (2025-0075), unic-common (2025-0080), unic-ucd-ident (2025-0100), unic-ucd-version (2025-0098), and glib 0.18.5 unsound VariantStrIter (2024-0429). These are transitive Tauri/native stack concerns. No vulnerability-class error was reported, but warnings remain unresolved; the Linux GTK stack must not be described as clean. Windows-target filtering does not prove every warning irrelevant. Upstream advisories: https://rustsec.org/advisories/ .
- **P3 R04 desktop performance:** emitted primary JS is 707.18 kB (190.91 kB gzip) and triggers Vite's 500 kB notice. Route/vendor splitting should be evaluated against startup measurements on representative POS PCs. This is a performance risk; no startup latency benchmark was possible.
- **P2 R05 Go advisory without an upstream fix:** GO-2026-5932 remains in the x/crypto module after upgrading: unsafe/unmaintained openpgp has no fixed version. The agent does not import that package and govulncheck finds zero vulnerable imported packages or reachable symbols. Preserve this distinction; importing openpgp in future would invalidate the result. https://pkg.go.dev/vuln/GO-2026-5932 .
- **P1 release limitation:** Windows service, USB/spooler/PDF driver, physical printers, installer execution/signing, live Stripe and Odoo runtime require their actual environments. No current CI results or live credentials were supplied.
- Exactly-once physical printing is not guaranteed by TCP or spooler acceptance. Explicit crash-reprint opt-in has at-least-once semantics and may duplicate output. Preserve outcome-unknown and operator reconciliation.
- Database migration text/schema consistency is weaker than executing upgrades. Browserless source/DOM checks do not prove Arabic shaping, mobile layout or accessibility in WebView2/Odoo.

## Verification baseline (before fixes)

- Node 24.19.0; locked npm installation succeeds (469 packages).
- Typecheck and ESLint succeed. Unit suite: 92 files passed, 1 skipped; 702 tests passed, 6 skipped. Python pytest: 143 passed.
- Gateway production build succeeds. Translation checks: 2,117 EN/AR keys, 18 tc call sites; Odoo 461/461 terms. Database documentation checker: 24 tables, 77 migrations, consistent.
- Integration suite without PostgreSQL: 14 passed, 325 skipped, 2 failed tripwire tests (DATABASE_URL absent, connection refused). This is **not** an integration pass.
- `tsx` CLI socket creation fails EPERM in this environment; `node --import tsx` executes nonserver scripts successfully. System PostgreSQL install fails sandbox setuid/setgroups; Docker/Rust/PowerShell absent. Go tooling downloaded locally; results pending.
- Initial Desktop Vite output was incomplete; a subsequent complete build succeeded. Public theme-init assets are emitted and referenced correctly; bundler notices about the nonmodule bootstrap script do not indicate missing shipped assets.

## Fixes applied / final verification

All A01–A25 have source corrections applied. A22 is syntax-compiled/cross-compiled, with physical Windows lifecycle testing still required. No claim is made that every branch, physical printer or external service has been proven defect-free. R01–R05 and the runtime limitations below remain disclosed.

### Regression coverage and reproduced outcomes

- `tests/production-audit-regressions.test.ts` executes nested log redaction/serialization, Argon2 bounds/version validation, audit-report fixtures, and checks the canonical pairing SQL predicate. Audit fixtures cover transitive runtime contamination, malformed reports, stale exceptions and severity handling.
- `tests/test_production_audit_regressions.py` executes the actual router/discovery method AST with environment stubs: empty/render-failing PDFs, HTTP failure and invalid JSON now produce translated actionable exceptions. This supplements static contracts; it does not replace installed Odoo ORM tests.
- `agent/internal/printer/production_audit_test.go` uses an authenticated HTTP IPP simulator and write-deadline fault injection. Authenticated discovery works, explicit job rejection is offline, malformed response framing stays unknown, and partial-write deadline failure stays outcome-unknown.
- Existing pre-cancelled WSD discovery and concurrent printer tests pass after A20/A21. Rust's eight actual pure autostart tests, extracted unchanged from source after formatting and compiled with edition 2024, pass including idempotent rollback. This is isolated Rust logic coverage, not a full Tauri build.
- `tests/agent-registration.test.ts` now holds another tenant's subscription row lock while pairing; `tests/agent-health-db.test.ts` checks busy/fresh printers and stale/disabled parents. Both new database-backed regressions are present but skipped here without PostgreSQL. They are not reported as executed.
- Arabic catalog now covers 470/470 Odoo source terms, including corrected scope/discovery errors; shared EN/AR remains 2,117/2,117. RTL styles now use logical inline alignment and spacing. Catalog parity is not visual Arabic/RTL acceptance.

### Verification performed

Commands run from repository root unless a component is identified. Detailed transcripts are included under `audit-evidence/`. `GOFLAGS=-buildvcs=false` avoids VCS stamping against the unrelated enclosing workspace repository; it is an archive verification setting, not a production code change.

| Check | Command / evidence | Result |
|---|---|---|
| Locked JS install | `npm ci --ignore-scripts` | Completed; production audit below checks the lock. Installer/native postinstall execution not asserted. |
| TypeScript | `npm run typecheck` | Pass after code and database regression changes. |
| ESLint | `npm run lint` | Pass; Python undefined-name CI validation also added. |
| JS unit/contract/DOM/simulated flows | `GOFLAGS=-buildvcs=false npm run test:unit` (JSON reporter for final evidence) | 712 passed, 1 skipped (database-backed HTTP cache override test), 0 failed; 94 test files. |
| Python standalone tests | `python3 -m pytest -q tests` | 147 passed. These are static/isolated behavior tests, not the installed Odoo test runner. |
| Python names/imports | `find odoo_addons scripts tests -name '*.py' ! -name '__init__.py' -print0 | xargs -0 python3 -m pyflakes` | Pass; registration imports intentionally retained. |
| Source/config parsing | Python AST, XML ElementTree, workflow YAML checks | 49 production/script Python files, 10 addon XML files, 5 workflows parse; job timeouts and 40-character action pins checked. Workflow execution and action provenance not proven by YAML parsing. |
| JS translations | `node --import tsx scripts/check-i18n.ts` | Pass: 2,117 EN/AR keys, 18 plural call sites. Node loader used because this environment rejects tsx CLI IPC socket creation. |
| Odoo translations | `python3 scripts/check-odoo-translations.py` | Pass: 470 source terms / 470 catalog entries. |
| DB schema/docs | `python3 scripts/check-db-docs.py` | Pass: 24 current tables, 77 migrations; not a live migration execution. |
| DB/integration | `npm run test:integration` with final JSON evidence | **NOT PASS:** 14 passed, 327 skipped, 2 failed. Tripwire deliberately rejects absent DATABASE_URL; second tripwire gets ECONNREFUSED ::1:5432. No bypass or deleted assertions. |
| Gateway production bundle | `npm run build` | Pass: Next.js production compilation, generated/prerendered routes. No production startup database probe or real TLS traffic claimed. |
| Desktop web bundle | `npm run desktop:vite:build` | Pass; emitted index/JS/CSS and public theme assets inspected. 707.18 kB primary JS warning remains R04. |
| Go race | In `agent`: `go test -race -mod=readonly ./...` | All 10 packages pass after crypto upgrade; service-control package additionally rerun after removal guard. Includes simulated printer/integration, ledger recovery and networking tests. |
| Go build/vet | In `agent`: `go build -mod=readonly ./...`; `go vet -mod=readonly ./...` | Pass; test compilation also covers the updated Linux package graph. |
| Windows Go compile | In `agent`: `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -mod=readonly ./...` | Pass; service installer command additionally rebuilt. Does not verify CGO-enabled SQLite/driver release runtime or physical Windows APIs. No audit cross-build executable is shipped. |
| Go module integrity/security | `go mod verify`; `govulncheck -show verbose ./...` | Module integrity passes; zero reachable/imported-package vulnerabilities; remaining module-only no-fix openpgp warning R05. |
| npm runtime security | `npm audit --omit=dev --json` | 0 vulnerabilities. |
| npm full audit gate | `node scripts/audit-gate.mjs` | Pass with one explicit lockfile-proven dev-only braces exception R01; not zero full-tree advisories. |
| Rust formatting | In `src-tauri`: `cargo fmt --all -- --check` | Pass after formatting. |
| Rust pure regression | `rustc --edition 2024 --test` on unchanged extracted autostart functions/tests | 8 passed. |
| Rust native build | In `src-tauri`: `cargo check --locked` | **BLOCKED:** pkg-config absent and glib-2.0 native dependencies unavailable. Installing system dependencies was attempted but the environment prevents required system package writes/setuid operations. |
| Rust dependency audit | In `src-tauri`: `cargo audit --target-os windows --target-arch x86_64` using cargo-audit 0.22.2 | Exit 0, seven upstream warnings retained as R03; registry/advisory fetch succeeded on final run. |
| Installer hook syntax | NSIS 3.09 compiles a harness inserting all three actual lifecycle macros | Pass; installer/uninstaller generated for syntax verification only. No signed production installer or Windows execution claimed. |
| Source hygiene | Scan production code for TODO/FIXME and merge-conflict markers; source comparison with uploaded archive | No pending markers found in reviewed production sources; generated caches, dependencies and cross-build binaries excluded from deliverable. |

### Critical-flow acceptance and release limitations

| Flow | Verified here | Required before release |
|---|---|---|
| Agent startup/pairing/auth/heartbeat/reconnect | Existing Go/TS simulated tests, credential/transport source contracts, race tests, corrected pairing lock predicate | Real service installation, upgrade/stop/uninstall, DPAPI/account ACLs, CGO-enabled release build, heartbeat with real PostgreSQL, gateway restart/network outage. |
| Discovery/capabilities/printing/results | Authenticated IPP simulator, framing/error/unknown-outcome fault injection, WSD cancellation and existing spooler/protocol/ledger tests | Real WSD/mDNS/SNMP subnet behavior, USB/spooler/driver/PDF execution and representative hardware, paper/cover faults, crash during physical submission. |
| Gateway tenant/auth/billing/queue/leases | Source tracing and unit contracts; schema/migration consistency; production compilation | PostgreSQL-backed entire integration suite including newly added lock/gauge regressions; empty DB and existing-state upgrade migration runs; live WebSocket/polling, Stripe signed webhook replay and quota/billing concurrency. |
| Odoo routing/outbox/errors/localization | Actual isolated method behavior, 147 standalone tests, XML/AST and Arabic catalog checks | Installed Odoo 19 registry/ORM/module install and upgrade tests, real business transactions/post-commit recovery, language switching, POS receipt and RTL browser rendering. Running pytest at repository root attempts addon ORM tests and fails collection because `odoo` is not installed; that is not an Odoo pass. |
| UI/mobile/accessibility/desktop | DOM contracts, production web bundles, locale parity and logical RTL fixes | Browser/WebView2 mobile widths, keyboard/focus/contrast/screen-reader and Arabic shaping acceptance; native Tauri build/test/clippy and signed NSIS/MSI release artifacts. |
| Production/staging deployment | Config/workflow source review, YAML/pin/timeout validation, custom-server build | Actual Compose/network/TLS/authenticated proxy deployments, migration-before-app ordering, restore drill and staged failure/recovery under production-like traffic. No Docker daemon, deployment credentials or current remote CI results supplied. |

Release acceptance must use the existing real-DB tripwire and real platform runners; mocks cannot satisfy those gates. All discovered source defects were corrected, but outstanding upstream advisories and unavailable runtime checks mean the repository is **not certified production-ready or free of known risks**. This is the concrete remaining work, not a claim of success based only on passing unit tests.


## CI recovery follow-up — 2026-10-04

This section supersedes earlier local pass claims for commit `7fa576e65f22d6b72b190b8f84f1efc3cd10c9a3`. The four runs supplied by the operator tested that exact commit on `main`; the source differs from the original archive baseline. Current job logs, rather than historical evidence files, establish the failures below.

### Failed-job evidence

| Run/job | Observed failure | Root cause |
|---|---|---|
| [Windows installer](https://github.com/mo7medSa3d/oddo-print/actions/runs/37178667437/job/111366538752) | `discovery_extended.go:8:2: "log" imported and not used` | Go compilation stopped before tests, Rust and packaging. |
| [CI](https://github.com/mo7medSa3d/oddo-print/actions/runs/37178667399/job/111366538804) | Same unused import | Early Go phase concealed downstream frontend checks. |
| [Supply chain](https://github.com/mo7medSa3d/oddo-print/actions/runs/37178667410/job/111366538566) | govulncheck package loading rejects the unused import | A compilation failure, not evidence of a newly reachable advisory. |
| [Docker](https://github.com/mo7medSa3d/oddo-print/actions/runs/37178667405/job/111366538662) | Webpack cannot resolve `net`/`tls` in pg | `dashboard-client → PrintCertificationWizard → job-status → database-clock → db → pg` crossed the browser/server boundary. |

### Additional findings and fixes

| ID | Severity | Files/evidence | Fix and preserved contract |
|---|---|---|---|
| CI01 | P1 | `agent/internal/printer/discovery_extended.go` unused log import, reproduced by Go build | Remove the actual unused import; no build gate bypass. |
| CI02 | P1 | `src/lib/job-status.ts` imports a timestamp parser from the database-owning clock module | Extract the unchanged pure parser to `database-timestamp.ts`, import it directly in job-status, re-export it from database-clock for server compatibility. Actual Next and Vite builds verify the boundary. Authoritative clock inputs and physical outcome semantics stay intact. |
| CI03 | P1 | `src/components/AppShell.tsx`: three LanguageSwitcher references without an import | Wire the existing translated language-switcher component into the shell. |
| CI04 | P2 | `src/lib/session-config.ts`: DOM Web Locks type inference creates a nested promise type | Normalize the lock/check result with Promise.resolve and return the typed shared flight. New behavioral tests cover locked concurrent admission, failure recovery and rejected credentials. |
| CI05 | P2 | Platform plan PATCH erases validated fields to Record<string,unknown> before the billing catalog lock | Use a schema-derived PlanPatch type, refining the validated nonnullable Stripe Price field. Validation, tenant/owner admission and locking remain unchanged. |
| CI06 | P2 | Release-readiness overall value `BLOCKED (explicit)` is not a key of the translated Status map | Keep overall within the existing canonical Status union, render its translated label, and calculate small row counts without unstable useMemo dependencies. |
| CI07 | P2 | Tenant/subscription pages reset pagination and loading synchronously from effects, causing lint errors and redundant old-offset requests | Reset offset in the search/filter events; derive loading from the completed request key including locale, offset, query and reload generation. Existing cancellation prevents stale completions from replacing current data. |
| CI08 | P2 | Certification/timeline state resets in effects; desktop saved-origin ref mutation during render | Key certification/timeline sessions by their printer/job ID, use unmount cleanup to abort old work, and synchronize the desktop origin ref after commit. No new job/reprint authority is introduced. |
| CI09 | P2 | Dashboard reenabling pairing invents an expiry from browser time; refresh callback misses translator dependency | Return the exact persisted database-derived expiry through lifecycle/actions, display it only with its pairing code, and include the translator dependency. |
| CI10 | P2 | Go test Gateways emit `{success:true}` where production requires `{success:true,status:...}`; wrapped stale-claim error is compared by equality | Update fixtures to echo the requested acknowledged status and use errors.Is for the fence sentinel. Production strict acknowledgement, immutable attempt tokens, unknown outcomes and dispatch fencing are retained. |
| CI11 | P2 | A database ingestion regression is embedded in discovery-unit.test.ts, violating suite classification | Move that block to discovery-identity.integration.test.ts and register it in the existing integration group. Pure taxonomy/CIDR tests remain in unit; database assertions are retained for real PostgreSQL. |
| CI12 | P3 | Existing tests assert obsolete implementation strings, English text removed by localization, old Odoo receipt props, old recovery-form absence, and a compatibility driver being virtual | Align assertions with the actual canonical capability module, Odoo 19 `order/basic_receipt` props, localized UI keys, explicit recovery controls, added reactive scope fields and handshake cleanup closure. Move the compatibility driver into the physical-printer table, preserving virtual-printer exclusions. Root assertions remain, rather than deleting failing tests. |
| CI13 | P3 | Timeline fixtures inject secret/irrelevant fields outside the builder's public input; offline VM harness variables shadow Next's module name | Fixtures now represent the actual public input. Rename VM locals to loadedModule while retaining actual-source execution. |
| CI14 | P3 | Go U1000 finds unused token logging helper once old token-adoption diagnostics are removed | Remove the unused helper and SHA import. A successful report does not need a token diagnostic; the log security test still rejects raw passed/live tokens. |
| CI15 | P3 | Odoo Arabic catalog contains obsolete `label` term removed by receipt changes | Remove that stale entry. Catalog check now matches 666 source terms and entries. |
| CI16 | P2 | GitHub setup-go resolves the module language declaration to exact Go 1.26.0, while local verification uses 1.26.8 | Declare `toolchain go1.26.8` in go.mod. The SHA-pinned setup-go implementation prioritizes that directive; language minimum remains 1.26.0. Add an alignment assertion and keep all workflows deriving the version from the module file. |
| CI17 | P3 | Background isolation saves undefined inert on hosts without native support | Normalize the saved state to Boolean before applying and restoring inert; the existing dialog isolation DOM regression passes. |
| CI18 | P1 | Fix-branch Docker run 37180751674/job 111372662122 fails copying `/app/public`, which does not exist in this Gateway | Create Next's optional public asset directory in the build stage before compiling; retain runtime asset copying for deployments with assets. This failure was masked by the earlier webpack error. |
| CI19 | P2 | `tests/agent-lifecycle.integration.test.ts` requires exactly one revision for concurrent disable/retire, although lifecycle permits disabled → retired | Assert retirement is final in both lock orders and that revision and audit count equal committed transitions. The database row lock, retirement fence and production transition rules remain unchanged. |
| CI20 | P1 | PostgreSQL run 37180933809/job 111373392218: shared-NAT test reads zero IP attempts; `reserveAuthAttempt` creates only account keys | Restore atomic reservations for valid source IPs alongside accounts using the existing wider NAT curve. Invalid/unknown IPs stay account-scoped to prevent a global lockout. Add runtime password-spray and unknown-address regressions; successful authentication still clears only the account budget. |
| CI21 | P2 | Same run: unrelated-subscription pairing test selects nonexistent `tenant_subscriptions.id` before its cleanup guard, leaking a connection and timing out afterAll | Select the actual primary key `tenant_id`; place transaction setup and request inside try/finally and guarantee connection release. Keep the assertion that pairing completes while the other tenant's lock is still held. |
| CI22 | P3 | Same run: Odoo synchronization contract asserts `last_enabled_sync_error` is absent although production intentionally exposes read-only recovery diagnostics | Assert the read-only diagnostic is present; retain post-commit replication, stale revision fencing, retry cron and credential cleanup contracts. |

### Verification of the corrected source

- Typecheck and ESLint pass with no warnings/errors. No lint, type, audit, or DB tripwire is disabled.
- Gateway Next production and Desktop Vite production builds pass. Desktop retains the known chunk-size warning.
- JavaScript unit/DOM/contract suite is rerun with a JSON report. New browser-boundary and session-admission tests accompany the existing physical-outcome, pairing, UI and authentication contracts.
- Standalone Python suite: 167 passed, including actual Rust std-helper compilation/execution with rustc. This does not claim installed Odoo ORM coverage.
- Offline actual-module Node audit suite: 16 passed. Shared EN/AR check: 2,238 keys each; Odoo catalog: 666/666; database documentation/migration consistency: checked.
- Go race suite: all 10 packages pass; build, vet, Linux/Windows U1000 and Windows amd64 cross-build are run. Production strict acknowledgement tests now simulate the real Gateway response.
- govulncheck reports zero reachable/imported-package vulnerabilities; the module-only no-fix OpenPGP warning remains. npm production audit is clean, and the existing full audit gate retains its explicit dev-only braces exception.
- Remote PostgreSQL integration, Docker runtime, native Windows Rust/build/installer and Odoo jobs must be checked on the fix commit. Original failed runs are historical and do not turn green retroactively. Current CI results will be recorded after the fix branch runs; local cross-compilation is not installer execution or physical-printer acceptance.

### First remote verification and follow-up

On code revision `18e49ec5e80a35dae68005d30461cdc51eae428e`, [Docker runtime 37180933810](https://github.com/mo7medSa3d/oddo-print/actions/runs/37180933810) passed image builds, ordered migrations, Gateway/PostgreSQL health, CSP/HTML nonce equality, absence of script unsafe-inline, Caddy configuration, and authenticated agent WebSocket checks. [Security/resilience 37180933772](https://github.com/mo7medSa3d/oddo-print/actions/runs/37180933772) passed supply-chain gates and real PostgreSQL LISTEN reconnect failure injection. [Static security 37180933802](https://github.com/mo7medSa3d/oddo-print/actions/runs/37180933802) passed all three CodeQL languages, secret scanning and dependency review.

[CI 37180933809](https://github.com/mo7medSa3d/oddo-print/actions/runs/37180933809) passed Go build/vet/race, dependency audits, typecheck/lint, localization/schema checks, 167 standalone Python tests, production Next build and 734 unit tests (one DB-gated skip). Installed Odoo 19 reported `0 failed, 0 error(s)` and addon statistics of 205 tests. PostgreSQL integration ran 347 tests: 344 passed and three failed, plus the leaked-connection teardown timeout, exposing CI20–CI22 above. These are corrected without disabling assertions or increasing timeouts. CI19 fixes a separate lock-order-dependent assertion that happened to pass in this run. A new real-database regression verifies the returned pairing expiry equals its persisted value and unchanged transitions expose no credentials.

[Windows 37180933782](https://github.com/mo7medSa3d/oddo-print/actions/runs/37180933782) passed native Go build/vet/race, Windows Rust audit, desktop bundle, locked Cargo check/build/tests and frontend typecheck/lint. Its sole Vitest failure was the same obsolete Odoo diagnostic assertion CI22; packaging was not reached. Final verification must rerun both integration and installer gates after these fixes.

The broader physical/runtime limitations and upstream risks elsewhere in this report still apply. Fixing CI is not a certification of physical printing or production readiness.
