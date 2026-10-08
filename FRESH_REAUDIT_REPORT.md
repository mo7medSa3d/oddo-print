# Fresh source audit and adversarial re-audit — 2026-10-07

**Definition of Done: NOT SATISFIED.** Four demonstrated problems have source repairs and regressions. The available partial checks passed, but complete builds/native/live verification and remote publication are blocked. Manual review covered the principal paths below; it does not establish that every line or every user-requested scenario was exhaustively audited.

## Baseline and evidence boundary

- Repository: https://github.com/mo7medSa3d/oddo-print
- Source: latest checked `main`, `a847797a4be3e27a98405b70e247f3d15b1ecbd4`; tree `31c92fc114f0c9ef4eb7b4916d9ed829ce011f93`.
- Local repair branch: `audit/fresh-ground-up-20261007`.
- Acquisition: conventional clone failed on DNS; signed commit/tree/source Git objects were materialized through the GitHub connector and hash-verified. Excluded historical artifacts were neither fetched nor read and their baseline tree entries remain unchanged.
- Confirmed counts: P0 0; P1 3; P2 1; P3 0. This is a confirmed-findings count, not proof of completeness or absence of vulnerabilities.
- Existing findings/logs/reports and named previous-agent artifacts did not inform this audit. Fresh reports have separate filenames to preserve that instruction.
- Remote publication/PR: BLOCKED by GitHub tool approval policy. No remote branch or PR exists for this work.

## Architecture and workflow traces

The Odoo addon validates model/report access, company/branch and printer binding; native reports produce PDF bytes through the report renderer. POS produces receipt/image payloads from its own rendering hooks. A durable Odoo outbox submits fenced idempotent jobs to the Gateway. Gateway authenticated routes enforce tenant/Agent/printer ownership, entitlements, protocol/capability and size constraints before PostgreSQL persistence. Database-backed claims flow over WebSocket or polling to the Go Agent. The Agent uses a SQLite ledger, canonical printer serialization, bounded execution and claim-token admission, then selects Windows GDI PDF, spooler RAW, USB, network RAW or IPP according to actual capabilities. Status/outbox/reconciliation carries explicit accepted/failed/unknown evidence back to the Gateway and Odoo/UI. Tauri manages local Agent configuration/lifecycle through bounded, origin-checked IPC.

| Workflow | Source conclusion | Runtime boundary |
| --- | --- | --- |
| Odoo standard report | Existing report renderer supplies the PDF; binding and report/source-record access are validated | Odoo install/report generation and physical output unverified |
| Odoo POS receipt/kitchen | Operation identifiers/outbox preserve retry identity; configured binding/printer membership govern routing | Browser/POS crash replay, Arabic receipt and hardware output unverified |
| Binding Test Print | Selected binding itself is validated, with exact Agent/protocol/runtime eligibility | Native Odoo execution unverified |
| Gateway manual/test job | UI/API create typed document payloads with owner/capability validation | UI interaction/live DB unverified |
| Browser-originated document | Application-generated PDF/image bytes are the printable input | No source-supported interception of the browser's native print-dialog result/settings was established |

## Coverage against requested phases

“Reviewed” here means fresh source inspection and the stated limited checks, not native certification. No speculative cosmetic/index/protocol changes were made where source did not demonstrate a defect.

| Requested phases | Source areas reviewed | Result and unresolved evidence |
| --- | --- | --- |
| 0–1 Baseline/architecture/end-to-end traces | Odoo routing/render/outbox; Gateway creation/claims/status; Agent queue/backends; Tauri configuration | Map/traces above; conventional clone and full live end-to-end trace blocked |
| 2 Discovery/service identity/identity | Winspool level-4 enumeration/details, registry fallback, service visibility diagnostics, USB physical identity, TCP/IPP/mDNS/SNMP/WSD candidates, merge/completeness/pruning | F04 repaired; service account enumeration matrix and real LAN detection unverified |
| 3 Status | Agent health vs printer health/observation/job outcome; protocol evidence precedence/staleness | Source reviewed; physical status injection unverified |
| 4 Protocol/capabilities | Go factory/document capabilities, Gateway payload/inventory validators, Odoo bindings/UI consumers | WSD/LPR candidates are not invented executable support; no capability schema changes |
| 5–6 Windows execution/fidelity | RAW partial writes and cancellation, spooler cleanup, USB ownership, embedded PDFium/GDI, paper forms/DPI/margins | F01/F02 repaired; Windows compilation, drivers and physical fidelity remain mandatory gates |
| 7 Odoo 19 | ACLs/record rules/company-branch scope, report access, selected binding, POS hooks, outbox leases/retry/reconcile, encrypted credentials, translations | Source/static/crypto checks available; real Odoo install/upgrade/POS unverified; no Odoo production changes |
| 8–10 Contracts/inventory/jobs | Strict base64/document limits, nullable local queue fields, inventory version/full-partial snapshots, desired/applied revisions, idempotency receipts, claims/TTL/status reconciliation | F01/F03/F04 repaired; live DB races and crash replay unverified |
| 11 Realtime | Authenticated Agent socket ownership, lifecycle revisions, reconnect replacement, bounded sockets/buffers/rate buckets, claim send/ACK and notification reconnect | Source review; live partition/reconnect injection unverified |
| 12 Security | Platform/manager/customer/Agent/Odoo auth, tenant ownership/RBAC, pairing/rotation, Argon2, CSRF/CORS/proxy proof, CSP, IPC secret boundaries, log redaction | F03 strengthens admission authorization; not a penetration-test or current vulnerability-scanner pass |
| 13 Database | Composite owner FKs/checks/unique keys/indexes, claim locks, bounded maintenance, migration journal/forward migrations, SQLite WAL/ledger | No schema/migration modifications; migration/rollback/EXPLAIN/deadlock tests blocked |
| 14 Performance | Request/job/render/claim budgets, backpressure, bounded discovery/execution, pagination, retention | DEVMODE cache now capped at 8 MiB/document; extra final admission adds HTTP/DB work; no benchmark claims |
| 15–16 Quality/errors | Shared admission/completeness/geometry policies; cleanup/partial-write/UNKNOWN semantics; dangerous/error-swallowing patterns on principal paths | Focused helpers and diagnostics added; full lint/type checks blocked |
| 17 Frontend/RTL/Desktop | Gateway menus/focus/viewport flipping, locale/dir/theme, stale/request states; Tauri origin/timeouts/credential generation/path/process ownership | Catalog/ordinary contracts pass where available; rendered UI/screenshots/desktop runtime unverified; no UI production changes |
| 18–19 CI/dependencies | Five workflow/toolchain/lock configurations, native Node/Go/Rust gates, Docker/Compose startup, dependency manifests | Pinned versions preserved; full dependency installation/build/scanner evidence unavailable |
| 20 Research | Microsoft DocumentPropertiesW/DEVMODEW/ResetDCW, IPP RFC 8011, Odoo 19 security and upstream PDFium APIs | Primary sources listed below; pinned PDFium native API compatibility still requires full compile |
| 21–23 Regression/fault/adversarial testing | Fresh handler harness, portable transport refusal/cancellation, queue packages, discovery/geometry policy and second-pass resource/race review | Available checks pass; native syscall/Agent/DB/Odoo/partition/fault tests remain blocked |
| 24–26 Observability/retention/deployment | Request/job trace IDs, status evidence/UNKNOWN, metrics access, bounded receipt/payload cleanup, startup secret/migration guards, service/installer ownership | Source reviewed; no production deployment, restore test, load test or physical health certification |

## Repairs and second adversarial pass

See `FRESH_AUDIT_FINDINGS.md` for evidence, affected consumers, regression scope and local commit references.

1. F01/P1: canonical local serialization and fresh Gateway admission after local waits. The second pass found renderer/driver preparation could still wait afterward; a fail-closed admission callback now runs immediately before each backend's first submission boundary.
2. F02/P1: page-specific driver-owned DEVMODE and physical PDF origin/dimensions replace default-paper fitting. The second pass separated standard paper IDs from custom-size flags, capped aggregate driver buffers, checked invalid physical offsets before first submission, and verified the cleanup closure follows ResetDC's handle. The resumed pass validates the final driver-merged public/private lengths and active scale/copies before DC creation; unused optional fields remain compatible.
3. F03/P1: initial/replayed Gateway `printing` admission share current locked owner/printer/subscription/desired-state and TTL/claim validation. Replay avoids duplicate timeline events; terminal reconciliation does not require new printer eligibility.
4. F04/P2: a cancelled fully buffered RAW/IPP target queue cannot report authoritative completeness; successful partial inventory and source errors survive.

The changed-source diff was reviewed against the baseline. No additional source-proven unresolved P0/P1 was established in that pass. Unexecuted P1/native/database paths remain material risks; this is not a guarantee that none exist.

## Verification results

| Check | Outcome | Evidence/limit |
| --- | --- | --- |
| `bash scripts/verify-fresh-source.sh` | PASS — partial only | Real handler 18 cases, four Go packages, selected real transport/policy tests, catalogs and whitespace |
| Fresh Gateway handler regression | PASS | Node 24 VM/type transform executes actual route/status/date source; unavailable infrastructure mocked |
| Go config/payload/queue/storage | PASS | `go test -mod=readonly -count=1 -race` |
| Selected actual printer source tests | PASS | RAW in-memory/IPP mocked RoundTripper; geometry/cancellation/capability/document cases, `-race`; not entire package |
| Ordinary Python attempted suite | 184 PASS; 3 BLOCKED | Three failures are missing deliberately excluded documentation, not passing integration tests |
| Ordinary native Node contracts | 18 files PASS; 3 BLOCKED | Missing excluded documentation blocks fleet/team/status documentation cases |
| i18n/Odoo catalog checkers | PASS | en/ar 2,376 keys each, 25 count-aware call sites; Odoo 684 terms/entries |
| Syntax inventory | PASS — syntax only | Go 147, JS/TS non-JSX 409, Python 65, XML 10, JSON 19, YAML 7; excludes JSX/type/link/runtime assurance |
| Bash script syntax | PASS — syntax only | Six present `.sh` scripts pass `bash -n`; does not prove runtime/deployment behavior |
| Negotiated PDF driver settings | PASS — portable regression | Half/enlarged scale, duplicate/zero copies, malformed buffers refused; healthy and unused optional fields accepted; `-race` |
| npm typecheck/lint/Next/desktop builds/Vitest unit/integration | BLOCKED, attempted | Required binaries unavailable after offline `npm ci` hit uncached pinned packages |
| Full Go vet/race/module verify | BLOCKED, attempted | Pinned dependencies absent and module cache read-only; PDFium unavailable offline |
| Socket-backed tests | BLOCKED, attempted | Environment denies local `listen` sockets; never converted to PASS |
| Cargo check/test offline/locked | BLOCKED, attempted | Pinned `tauri-build=2.7.0` not cached; no downgrade to cached 2.6.3 |
| Rust syntax parser | BLOCKED, attempted on resume | rustfmt component missing from pinned `1.98.1` toolchain; no substitute compiler or formatter used |
| PostgreSQL migrations/concurrency/EXPLAIN/backup restore | BLOCKED | No server/client; Docker access denied and Podman runtime unavailable |
| Windows/driver/service/USB/native spooler and PDFium | UNVERIFIED | Windows syntax parsed only; no native build/runner/hardware |
| Odoo 19 install/upgrade/report/POS, browser/desktop UX | UNVERIFIED | No live applications/browser fixtures or rendered-output evidence |

Reproduction for the available subset, from a complete clone with pinned dependencies available:

```bash
# Use the declared Node 24 runtime and Go toolchain; do not modify locks.
bash scripts/verify-fresh-source.sh
# Available shell syntax gate, separate from runtime smoke tests:
for file in scripts/*.sh; do bash -n "$file"; done
```

The script deliberately labels its scope and does not claim to replace required full CI. Existing native test globs pick up the new `.test.mjs` and Go regressions. Excluded old artifacts must not be read to reproduce this audit.

## Remaining release gates and compatibility

- Run full pinned typecheck/lint/build/unit/integration/vet/race/Cargo/scanner gates in a permitted connected runner. Verify pinned PDFium page-size API and Windows syscall signatures compile.
- Run PostgreSQL concurrent printer/Agent/tenant changes, first/replayed admission, expiry/reclaim and terminal reconciliation; inspect lock order/query plans and migration/restore behavior.
- On Windows test interactive user, LocalSystem/LocalService/NetworkService and dedicated service identities; stale/missing queues, USB stalls and RAW partial writes. Hardware submission cannot prove paper completion.
- Print A4/Letter/Legal, 58/80 mm/custom and mixed portrait/landscape PDFs with supported and rejecting drivers; check original scale/margins, nonprintable clipping, Arabic/mixed text, images, QR/barcodes and large documents. Unsupported substituted forms now fail rather than silently resize; operators may need to configure a supported driver form.
- Run Odoo standard report/selected binding/POS duplicate-crash-recovery and company/branch denial paths, browser-generated PDF/receipt outputs and desktop RTL/menu/config lifecycle interactions.
- Evaluate added final admission latency/DB locking and driver form preflight cost under load. No throughput or paper-quality improvement is claimed without measurement.
- No schema migration, lockfile change, public protocol enum change or Odoo/UI production modification is included. Rolling compatibility and manager-inventory lifecycle behavior still need integration coverage.

## Publication and completion verdict

Main remained at the recorded baseline when rechecked. The GitHub create-branch operation was rejected with `MCP tool call requires approval, but approval policy is never`. The local repair commits and review package exist; no remote branch/PR was created and no merge/deployment occurred.

On resume (2026-10-08 Cairo), branch/DNS/publication status was rechecked, the driver-output guard and regressions were added, partial verification passed again and six Bash syntax checks passed. Native/live/full-build gaps remain; missing rustfmt also prevents a Rust syntax-parser claim. New evidence strengthens F02 without changing the confirmed-finding counts.

**Definition of Done: NOT SATISFIED** because a conventional clone could not complete, excluded artifacts limit whole-repository checks, exhaustive line-by-line/scenario coverage was not established, full dependency-backed builds/tests and native/live/physical evidence are absent, and publication/PR creation is prohibited. The implemented source repairs are ready for review and the listed verification gates; production readiness is not certified.

## Primary references used for uncertain contracts

- Microsoft DocumentProperties: https://learn.microsoft.com/en-us/windows/win32/printdocs/documentproperties
- Microsoft DEVMODEW: https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-devmodew
- Microsoft ResetDCW: https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-resetdcw
- IPP model and semantics, RFC 8011: https://www.rfc-editor.org/rfc/rfc8011
- Odoo 19 security: https://www.odoo.com/documentation/19.0/developer/reference/backend/security.html
- Upstream PDFium Go binding: https://github.com/klippa-app/go-pdfium
