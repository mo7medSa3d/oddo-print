# Audit/edit log (append-only)

## 2026-10-01T17:24:26Z — Initial source mapping and first printer read
- Files: root tree, `package.json`, `agent/go.mod`, `src-tauri/Cargo.toml`, tracked source paths, `agent/internal/printer/discovery_windows.go`, `agent/internal/printer/spooler_windows.go`, new `AUDIT_EDIT_STATE.md` and `AUDIT_LOG.md`.
- Change: initialized the two required memory files and component-by-component task plan; began reading Windows printer code immediately, without installs or build setup.
- Why: preserve resume context; prioritize Agent and use present code rather than old audit reports. Current migration list ends at 0041 (not 0036), so table count needs source verification.
- Evidence: `pwd` => `/home/user/oddo-print`; `git status --short` => empty; `git branch --show-current` => `arena/01a0f87e-oddo-print`; `git ls-files` and source reads completed with exit 0. No build/runtime claims made.
- UNVERIFIED: Windows/printer/Odoo/PostgreSQL runtime and available toolchains pending later checks.

## 2026-10-01T17:30:00Z — Windows contracts and available-tool blockers
- Files: `spooler_windows.go`, `spooler_stub.go`, `spooler_windows_test.go`, `usb_windows.go`, `classify.go` references.
- Findings: EndDocPrinter incorrectly treats last-error as the success predicate; failure cleanup submits incomplete RAW jobs; Status spawns a fresh helper after every timeout; GetPrinter sizing ignores errors/reallocation; EnumPrinters level 2 can block on every remote connection.
- Decisions/research: use BOOL return values (last-error only on failure): https://learn.microsoft.com/en-us/windows/win32/printdocs/enddocprinter ; abort incomplete spool files instead of finalizing: https://learn.microsoft.com/en-us/windows/win32/printdocs/abortprinter ; bounded retries for ERROR_INSUFFICIENT_BUFFER and fast level-4 queue enumeration: https://learn.microsoft.com/en-us/windows/win32/printdocs/enumprinters and https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rprn/4a41f1ef-45ca-41ba-88e9-d041c9347299 ; RAW requires device-native data, not XPS: https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter ; queue fields/status combinations: https://learn.microsoft.com/en-us/windows/win32/printdocs/printer-info-2 .
- Evidence: source reads and `git grep` call-site inventory; `command -v` found node/npm/python3/gcc only among requested toolchains. `node --version` => v22.22.3 (package requires >=24.15.0); `go version` => command not found; `rustc --version` => command not found; no node_modules/cache directories found at standard paths.
- UNVERIFIED: tool go not available; tool cargo not available; tool rustc not available; tool pytest not available; tool psql not available; tool pwsh not available; tool wine not available. Gateway dependencies absent; no installs/downloads attempted.

## 2026-10-01T17:52:00Z — Agent: Windows spooler session correctness (EndDoc/Abort, BOOL returns)
- File: `agent/internal/printer/spooler_windows.go`.
- Changes:
  1. Added `AbortPrinter` (`procAbortPrinter`, `spoolerSyscalls.abortPrinter`) and `finishSpoolerDoc`: a COMPLETE document is finalized with EndDocPrinter, an incomplete one is DISCARDED with AbortPrinter. Previously every failed/cancelled session called EndDocPrinter, which released truncated RAW/ESC-POS output (cut receipts, half-printed labels) that the agent then reported as failed.
  2. Success is now decided by the BOOL return value, not `GetLastError`: the old `if _, endErr := sys.endDocPrinter(...); endErr != nil && endErr != syscall.Errno(0)` treated a stale non-zero last error on a successful call as a failure. Microsoft: "If the function succeeds, the return value is a nonzero value" — https://learn.microsoft.com/en-us/windows/win32/printdocs/enddocprinter .
  3. Documented and kept the deliberate no-Abort on a byte-complete document whose EndDocPrinter fails (outcome stays UNKNOWN; destroying the spool file could lose deliverable output).
- Why: match the documented job sequence and per-call contracts; never finalize what was not fully written.
- Evidence: source edits plus new fake-syscall tests (see below). UNVERIFIED: not compiled/run — Go toolchain absent.

## 2026-10-01T17:58:00Z — Agent: bounded buffer queries, single-flight status, level-4 enumeration
- File: `agent/internal/printer/spooler_windows.go`.
- Changes:
  1. New `getPrinterInfo2` (used by pre-flight, probe and discovery): documented two-call GetPrinterW(2) pattern that recognizes ERROR_INSUFFICIENT_BUFFER as the normal sizing answer, retries up to 3 times when the queue grows between calls (https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rprn/e35fa2d2-8ca1-4369-be52-6e606759bd0e), and never dereferences a buffer smaller than PRINTER_INFO_2. Removed ~50 duplicated lines between `preFlightSpoolerCheck` and `ProbeSpoolerQueue`.
  2. `Status()` no longer spawns a fresh helper goroutine per call: it reuses `boundedPreflight` (single-flight + bounded wait). The old code leaked one blocked goroutine (and an OpenPrinter handle) per heartbeat timeout against a wedged spooler. Added `ErrSpoolerUnresponsive` so an unanswered RPC reports "unknown" instead of a fabricated offline/error.
  3. `EnumSpoolerPrinters` rewritten: level 4 enumeration (names/attributes, no per-queue OpenPrinter) instead of level 2 (which per Microsoft performs an OpenPrinter on every remote connection and waits for RPC timeouts on dead connections — https://learn.microsoft.com/en-us/windows/win32/printdocs/enumprinters), bounded at 30s on a helper goroutine, with proper ERROR_INSUFFICIENT_BUFFER retry and an empty-result cross-check against the registry; details come from bounded per-queue GetPrinterW (3s each, 30s total budget) and unreadable queues report "unknown" instead of a fake "online".
  4. Added `openPrinterWPtrFn` / `getPrinterInfo2Fn` indirections so the printer layer is faked in tests.
- Why: correct buffer sizing, no goroutine/handle leaks, discovery that cannot hang on one dead queue.
- Evidence: new tests below; brace/paren balance checked mechanically. UNVERIFIED: not compiled/run — Go toolchain absent (searched /usr/local/go, /usr/lib/go, /opt/go, /snap: none).

## 2026-10-01T18:02:00Z — Agent: fake-based tests for the printer layer
- File: `agent/internal/printer/spooler_windows_test.go` (+ `fmt` import, abortPrinter fakes on two existing tests so they never call the real AbortPrinter with a fake handle).
- Added: `TestSpoolerCompleteDocumentIsFinalizedNotAborted`, `TestSpoolerEndDocPrinterStaleLastErrorIsNotAFailure`, `TestSpoolerEndDocPrinterFailureIsUnknown`, `TestSpoolerPartialWriteIsAbortedNotFinalized`, `TestSpoolerCancelledBeforeWriteIsAborted`, `TestPreFlightAcceptsHealthyQueue`, `TestPreFlightRejectsOfflineQueue`, `TestPreFlightRejectsWorkOfflineQueue`, `TestPreFlightRejectsPaperOutAndIsNotOffline`, `TestPreFlightFailsClosedWhenStatusUnreadable`, `TestSpoolerStatusUnreadableQueueIsNotOnline`.
- Why: prove the Win32 session and status logic with fakes, with no printer, driver or spooler present.
- Evidence: `git diff --stat` shows the test file grew; UNVERIFIED: `go test` not runnable here.
- Still needs real hardware: actual paper output, driver rendering, XPS/EMF data types, SNMP/Standard-TCP/IP false-offline behaviour, WSD, and Windows-service (session 0) visibility of per-user queues.
