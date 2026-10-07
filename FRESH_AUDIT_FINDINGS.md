# Fresh findings — 2026-10-07

Baseline: `a847797a4be3e27a98405b70e247f3d15b1ecbd4` on `main`.

These findings come from current source and fresh executions. Existing logs, findings, reports, archived work and named previous-agent audit artifacts were not read. Their Git tree entries remain unchanged. Fresh checkpoint filenames intentionally avoid overwriting them.

Confirmed findings: P0 **0**, P1 **3**, P2 **1**, P3 **0**. Counts describe demonstrated problems, not an assurance that no other problems exist. All four have source repairs and regressions; verification limitations below remain release gates.

| ID | Severity | Root cause | Local repair commits | Evidence status |
| --- | --- | --- | --- | --- |
| F01 | P1 | Physical execution admission preceded local waits and preparation | `5e75c8a`, `5243c8c` | Portable boundary regressions pass; full Agent and native Windows execution blocked |
| F02 | P1 | Windows PDF used the default driver form and fit-to-printable-area scaling | `47bf637`, `b0b6ad2`, `61750c3` | Geometry/DEVMODE byte tests pass, including negotiated scale/copies; native compilation and physical fidelity unverified |
| F03 | P1 | First/repeated Gateway printing admission omitted current printer eligibility | `5e75c8a` | 18 real-handler cases pass with mocked infrastructure; live SQL locking unverified |
| F04 | P2 | Buffered enqueue completion was treated as completed network discovery | `fa2c34a` | Cancellation/completeness policy tests pass; real LAN discovery unverified |

## F01 — Fresh admission after every local wait

Affected source: `agent/internal/agent/agent.go`, RAW/IPP/USB/spooler/PDF submission paths under `agent/internal/printer/`.

Before repair, `processJob` requested Gateway `printing` admission before the printer mutex and global physical-execution semaphore. A claimed job could remain queued locally until its TTL expired or its owner/printer changed, then start hardware using earlier admission. Gateway aliases also used different local pending-accounting/serialization keys from bare local IDs.

The Agent now canonicalizes aliases before pending accounting, serializes on the actual local backend, acquires the execution slot, checks current backend/capabilities and requests admission. A new context-carried callback checks local configuration fencing and repeats the claim-token-fenced Gateway admission at the actual transport boundary. It runs after RAW connection preparation, before IPP submission, after USB/spooler handle opening, and after first-page PDF preparation before `StartDocW`. Cancellation is checked before and after the acknowledgement. The final callback fails closed; it does not use an offline-admission fallback. PostgreSQL remains the TTL clock.

Regressions: new Agent blocked-printer/alias waiter test; updated fairness test; portable callback cancellation/refusal tests; actual IPP client and RAW writer refusal tests; Windows syscall refusal/cleanup test. Portable tests passed with `-race`. The full Agent test and native Windows syscall test were not executable here.

Admission remains a distributed point-in-time decision. It cannot make a database transaction atomic with a physical printer or revoke paper already submitted. Ambiguous post-submission outcomes retain the existing UNKNOWN/reconciliation semantics.

## F02 — Preserve PDF physical geometry

Affected source: `pdf_windows.go`; new `pdf_geometry.go` and `pdf_devmode_windows.go`.

Before repair, `CreateDCW` received no job-specific DEVMODE. The renderer centered/scaled each page into the queue's default printable rectangle. A receipt/custom sheet/landscape PDF could therefore silently become differently sized output.

The repair reads every PDF page's original dimensions, derives orientation and A4/Letter/Legal or custom dimensions, and uses driver-owned `DocumentPropertiesW` buffers including all private bytes. Standard paper IDs and custom dimension flags are kept separate; form-name overrides are cleared. Requested scale is 100% and copies are one. Each distinct form is preflighted against actual physical-sheet/DPI capabilities before `StartDocW`; substitution beyond 1 mm fails with a diagnostic. Physical page origin uses negative hardware offsets, retaining PDF scale/margins rather than fitting to the printable rectangle. `ResetDCW` changes forms between pages; cleanup follows the updated DC handle. Cached DEVMODE bytes are bounded to 8 MiB per document, with each driver allocation bounded to 1 MiB. Existing 500-page and 16-million-pixel raster limits remain.

The resumed review also checks the DEVMODE returned by the final driver merge before CreateDC. A driver-advertised scale other than 100% or copies other than one, or invalid public/private buffer lengths, now refuse execution. Optional members whose dmFields bits are cleared are treated as unused rather than interpreting their stale bytes. This closes a public-settings gap; driver-private transformations still require physical validation.

Regressions cover standard/custom 58/80 mm and landscape geometry, malformed/nonfinite/oversized input, driver-private byte preservation, paper flags, substitution, negotiated scale/copies, invalid returned-buffer lengths, unused fields, DPI and physical origin. These portable tests passed with `-race`, and the full partial-source verification script passed again after the resumed repair. The Windows code was syntax-parsed, not type-checked or executed. Pinned PDFium integration, driver acceptance, clipping at nonprintable margins, mixed-page behavior, Arabic fonts, images/barcodes and physical paper output require native validation. Source implementation is not proof of physical fidelity.

## F03 — Current printer eligibility for first and repeated admission

Affected source: `src/app/api/agent/jobs/route.ts`.

Before repair, a claimed job could enter `printing` after its printer was disabled/retired/absent. A repeated `printing` acknowledgement bypassed the transaction's current owner lifecycle checks. A lagging Agent desired-state snapshot could not close that server-side gap.

Both first and repeated admissions now share the locked transaction: job `FOR UPDATE`, exact tenant/Agent/printer ownership, current tenant subscription, active lifecycles, inventory presence, and applied/observed manager revisions at least equal to the desired revision. Owner/printer rows use `FOR SHARE`; the job update retains current status, claim token and database-clock expiry fences. Replayed admission does not duplicate timeline events. Terminal evidence reconciliation remains independent of new execution eligibility.

`tests/fresh-printing-admission.test.mjs` executes the actual TypeScript handler and status/date modules. Eighteen cases passed, including disabled/absent/suspended/retired/unapplied/unobserved states on first and replayed admission, active fences, stale token, atomic update refusal and terminal reconciliation. Next/Drizzle/auth/telemetry infrastructure is mocked; PostgreSQL transaction scheduling, query plans and subscription locking were not runtime-validated.

## F04 — Cancellation cannot establish authoritative absence

Affected source: `ipp_discovery.go`, `network_discovery.go`; new `discovery_scan.go`.

Before repair, all network targets could enter a buffered queue before workers finished. Cancellation then stopped workers, yet the queued-target count equalled the total and the scanner returned no completeness error. Consumers could treat unobserved printers as authoritatively absent.

Both scanners now retain partial devices and join source diagnostics with an explicit cancellation/truncation error, even when all targets were queued. Messages distinguish queued work from completed probes. Healthy complete and empty scans remain successful. Conservative cancellation diagnostics may retain stale inventory for another cycle rather than authorizing removal.

Portable cases for fully queued cancellation, partial enqueue, complete/empty scans and deadline identity passed. Actual mDNS/SNMP/WSD/RAW/IPP network discovery remains unverified.

## Publication and assurance limits

All commit references above identify local commits. GitHub branch creation was rejected with: `MCP tool call requires approval, but approval policy is never`. No remote repair branch, remote repair commit or PR was created. The repairs require full pinned builds, native Windows/driver tests and live PostgreSQL/Odoo validation before a production-readiness claim. See `FRESH_REAUDIT_REPORT.md` for the complete evidence boundary.
