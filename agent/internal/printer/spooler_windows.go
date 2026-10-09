//go:build windows

package printer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	modWinspool          = syscall.NewLazyDLL("winspool.drv")
	procOpenPrinterW     = modWinspool.NewProc("OpenPrinterW")
	procClosePrinter     = modWinspool.NewProc("ClosePrinter")
	procStartDocPrinterW = modWinspool.NewProc("StartDocPrinterW")
	procStartPagePrinter = modWinspool.NewProc("StartPagePrinter")
	procWritePrinter     = modWinspool.NewProc("WritePrinter")
	procEndPagePrinter   = modWinspool.NewProc("EndPagePrinter")
	procEndDocPrinter    = modWinspool.NewProc("EndDocPrinter")
	procAbortPrinter     = modWinspool.NewProc("AbortPrinter")
	procEnumPrintersW    = modWinspool.NewProc("EnumPrintersW")
	procGetPrinterW      = modWinspool.NewProc("GetPrinterW")
	modKernel32          = syscall.NewLazyDLL("kernel32.dll")
	procProcessIDSession = modKernel32.NewProc("ProcessIdToSessionId")

	// postCancelSpoolerResultGrace bounds how long a caller waits for an
	// already-started synchronous Win32 print worker after ctx cancellation.
	// Windows exposes no safe cross-thread cancellation primitive for these
	// calls, so the worker retains every handle and the printer session while
	// the caller eventually returns UNKNOWN. A var keeps the contract
	// regression-testable without a 30-second sleep.
	postCancelSpoolerResultGrace = 30 * time.Second

	// platformPrintPDFObserved publishes StartDocW's job identity before the
	// remaining GDI session finishes. Tests replace this seam only to emulate a
	// wedged driver; production uses the real Windows implementation.
	platformPrintPDFObserved = platformPrintPDFWithJobIDObserved
)

const (
	PRINTER_STATUS_PAUSED            = 0x00000001
	PRINTER_STATUS_ERROR             = 0x00000002
	PRINTER_STATUS_PENDING_DELETION  = 0x00000004
	PRINTER_STATUS_PAPER_JAM         = 0x00000008
	PRINTER_STATUS_PAPER_OUT         = 0x00000010
	PRINTER_STATUS_MANUAL_FEED       = 0x00000020
	PRINTER_STATUS_PAPER_PROBLEM     = 0x00000040
	PRINTER_STATUS_OFFLINE           = 0x00000080
	PRINTER_STATUS_IO_ACTIVE         = 0x00000100
	PRINTER_STATUS_BUSY              = 0x00000200
	PRINTER_STATUS_PRINTING          = 0x00000400
	PRINTER_STATUS_OUTPUT_BIN_FULL   = 0x00000800
	PRINTER_STATUS_NOT_AVAILABLE     = 0x00001000
	PRINTER_STATUS_WAITING           = 0x00002000
	PRINTER_STATUS_PROCESSING        = 0x00004000
	PRINTER_STATUS_INITIALIZING      = 0x00008000
	PRINTER_STATUS_WARMING_UP        = 0x00010000
	PRINTER_STATUS_TONER_LOW         = 0x00020000
	PRINTER_STATUS_NO_TONER          = 0x00040000
	PRINTER_STATUS_PAGE_PUNT         = 0x00080000
	PRINTER_STATUS_USER_INTERVENTION = 0x00100000
	PRINTER_STATUS_OUT_OF_MEMORY     = 0x00200000
	PRINTER_STATUS_DOOR_OPEN         = 0x00400000
	PRINTER_STATUS_SERVER_UNKNOWN    = 0x00800000
	PRINTER_STATUS_POWER_SAVE        = 0x01000000
	PRINTER_STATUS_SERVER_OFFLINE    = 0x02000000
)

const (
	PRINTER_ATTRIBUTE_NETWORK      = 0x00000010
	PRINTER_ATTRIBUTE_LOCAL        = 0x00000040
	PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400
)

type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

// SpoolerPrinter interacts with the Windows Spooler API (winspool.drv).
//
// Win32 WritePrinter is inherently synchronous in the Windows kernel driver
// and cannot be cancelled: a wedged spooler RPC blocks the worker goroutine
// until it returns, however long that takes. Containment is therefore
// per-printer (sessionMu): a wedged printer can only ever tie up its OWN
// session — never other printers'. Cross-printer burst protection comes from
// the agent's job executor cap, which the spooler routinely absorbs.
type SpoolerPrinter struct {
	Name              string
	SpoolerName       string
	ReceiptPaperMM    int
	ReceiptRasterDots int
	ReceiptDPI        int
	PDFPrint          PDFPrintFunc
	// PDFPrintResult is an injectable result-bearing seam used by the Windows
	// GDI/PDF path to propagate StartDocW job identity. Tests may override it.
	PDFPrintResult PDFPrintResultFunc
	ProbeFunc      func(spoolerName string) string
	Timeout        time.Duration
	// preflightActive single-flights the readiness probe per printer: at
	// most one helper goroutine may ever be stuck inside Win32 for this
	// printer. Only pointer receivers ever exist (see NewSpooler and all
	// call sites), so atomic access is race-safe.
	preflightActive atomic.Bool
	// sessionMu serializes full print sessions per printer. A session that
	// wedges inside synchronous WritePrinter holds this mutex (not a shared
	// pool slot), so repeated Prints against the SAME wedged printer fail
	// fast via TryLock below while every OTHER printer proceeds normally.
	// sync.Mutex is safe as a zero value, so struct literals in tests and
	// all constructors behave identically.
	sessionMu sync.Mutex
	// lastJobID is backend-wide diagnostic history, not an invocation identity.
	// Only a session-owning worker publishes it. Agent dispatch uses separate
	// context-scoped evidence, since a rejected caller can see the prior ID.
	lastJobID atomic.Uint64
	// inflight counts reserved RAW/PDF sessions until their worker cleanup
	// completes (including sessionMu release). A worker can outlive Print's return when the
	// caller times out and the Win32 session stays active (see the
	// post-cancel grace path): the counter lets backend replacement defer
	// while a prior session may still own the physical queue, instead of
	// installing a fresh backend (fresh mutex) that permits overlapping
	// submissions to the same device.
	inflight atomic.Int32
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter {
	name := spoolerName
	if displayName != "" {
		name = displayName
	}
	return &SpoolerPrinter{Name: name, SpoolerName: spoolerName}
}

// preflightTimeout bounds the readiness probe. Win32 OpenPrinterW/GetPrinterW
// expose NO timeout of their own and block indefinitely against a wedged
// spooler RPC, so the caller must bound them. 5s is generous: a healthy
// local spooler answers in single-digit milliseconds (per Microsoft docs);
// anything slower is already an unresponsive control plane. Reduced from 10s
// to 5s to halve user-perceived delay on test-print and job dispatch when
// spooler is wedged. A timeout here is provably pre-dispatch (status queries
// can never spool a document), so it stays a plain typed failure, never an
// unknown outcome.
const preflightTimeout = 5 * time.Second

// ErrSpoolerUnresponsive marks a probe that never completed because the
// spooler RPC did not answer: a hard timeout, or a refusal because an
// earlier probe is still stuck inside Win32. It proves NOTHING about the
// physical device, so callers reporting device status must surface
// "unknown" instead of inventing offline/error (a queue that is merely slow
// must not be reported as broken, and a device that is printing must never
// be reported offline).
var ErrSpoolerUnresponsive = errors.New("spooler RPC unresponsive")

// ErrSpoolerStatusUnknown means Windows returned an explicit
// PRINTER_STATUS_SERVER_UNKNOWN bit. The queue exists, but Windows has no
// authoritative device status; dispatch fails closed while heartbeat reports
// "unknown" rather than inventing a physical offline condition.
var ErrSpoolerStatusUnknown = errors.New("spooler status unknown")

// ErrSpoolerQueueInaccessible means the current Windows security/session
// context could not obtain a queue handle. It is a control-plane/access fact,
// not evidence that the physical device is offline. Dispatch fails closed,
// while status reporting remains unknown.
var ErrSpoolerQueueInaccessible = errors.New("spooler queue inaccessible from current security context")

// boundedPreflight runs one readiness check with single-flight semantics
// for this printer: if a previous check is still stuck inside Win32, fail
// fast instead of spawning another helper goroutine. Without this, every
// timed-out Print against a wedged spooler would leak one more blocked
// helper (each Print gets its own, because the stuck one never returns to
// clear the way) — unbounded accumulation over hours of steady job flow.
// The flag clears when the stuck helper's check finally returns, so
// recovery after a transient stall is automatic, with no restart and no
// operator action. A refused call is a plain pre-dispatch failure: no
// document bytes were ever submitted.
func (p *SpoolerPrinter) boundedPreflight(ctx context.Context, timeout time.Duration, check func() error) error {
	if !p.preflightActive.CompareAndSwap(false, true) {
		return fmt.Errorf("%w: %w: readiness probe for %q already in progress (previous probe stuck in spooler RPC)", ErrPrinterNotReady, ErrSpoolerUnresponsive, p.SpoolerName)
	}
	return runPreflightBounded(p.SpoolerName, timeout, ctx, func() error {
		defer p.preflightActive.Store(false)
		return check()
	})
}

// A Win32 driver RPC has no cancellable timeout. An abandoned preflight
// helper remains owned until *its worker* returns, not until the caller's
// deadline elapses. This shared, bounded registry covers the PDF render path
// (which does not own a SpoolerPrinter instance) as well as normal queue
// probes, so repeated timeouts cannot leave unbounded native worker threads.
const maxOutstandingSpoolerPreflights = 32

var spoolerPreflightOwnership = struct {
	sync.Mutex
	active map[string]struct{}
}{active: make(map[string]struct{})}

func reserveSpoolerPreflight(displayName string) (func(), error) {
	key := strings.ToLower(strings.TrimSpace(displayName))
	spoolerPreflightOwnership.Lock()
	defer spoolerPreflightOwnership.Unlock()
	if _, inProgress := spoolerPreflightOwnership.active[key]; inProgress {
		return nil, fmt.Errorf("%w: %w: readiness probe already in progress for %q", ErrPrinterNotReady, ErrSpoolerUnresponsive, displayName)
	}
	if len(spoolerPreflightOwnership.active) >= maxOutstandingSpoolerPreflights {
		return nil, fmt.Errorf("%w: %w: too many outstanding Windows readiness probes (%d)", ErrPrinterNotReady, ErrSpoolerUnresponsive, maxOutstandingSpoolerPreflights)
	}
	spoolerPreflightOwnership.active[key] = struct{}{}
	return func() {
		spoolerPreflightOwnership.Lock()
		delete(spoolerPreflightOwnership.active, key)
		spoolerPreflightOwnership.Unlock()
	}, nil
}

// runPreflightBounded bounds its caller, but continues to own the Win32
// helper until the actual RPC returns. The ownership slot is never released
// on timeout or cancellation, preventing repeated abandoned driver calls.
func runPreflightBounded(displayName string, timeout time.Duration, ctx context.Context, check func() error) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("readiness probe for %q cancelled before dispatch (no bytes sent): %w", displayName, err)
	}
	release, err := reserveSpoolerPreflight(displayName)
	if err != nil {
		return err
	}
	type outcome struct{ err error }
	done := make(chan outcome, 1)
	go func() {
		// Release native ownership BEFORE notifying a successful caller;
		// otherwise an immediate next probe could be spuriously refused.
		result := check()
		release()
		done <- outcome{result}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-done:
		return r.err
	case <-ctx.Done():
		return fmt.Errorf("readiness probe for %q cancelled before dispatch (no bytes sent): %w", displayName, ctx.Err())
	case <-timer.C:
		return fmt.Errorf("%w: %w: readiness probe for %q timed out after %v (fail-closed, no bytes sent)", ErrPrinterNotReady, ErrSpoolerUnresponsive, displayName, timeout)
	}
}

type spoolerTaskResult struct {
	written uint32
	jobID   uintptr
	err     error
}

type spoolerSyscalls struct {
	openPrinterW     func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error)
	closePrinter     func(hPrinter syscall.Handle) (uintptr, error)
	startDocPrinterW func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error)
	startPagePrinter func(hPrinter syscall.Handle) (uintptr, error)
	writePrinter     func(hPrinter syscall.Handle, buf unsafe.Pointer, len int, bytesWritten *uint32) (uintptr, error)
	endPagePrinter   func(hPrinter syscall.Handle) (uintptr, error)
	endDocPrinter    func(hPrinter syscall.Handle) (uintptr, error)
	abortPrinter     func(hPrinter syscall.Handle) (uintptr, error)
}

var defaultSpoolerSyscalls = spoolerSyscalls{
	openPrinterW: func(printerName *uint16, hPrinter *syscall.Handle) (uintptr, error) {
		r, _, err := procOpenPrinterW.Call(
			uintptr(unsafe.Pointer(printerName)),
			uintptr(unsafe.Pointer(hPrinter)),
			0,
		)
		return r, err
	},
	closePrinter: func(hPrinter syscall.Handle) (uintptr, error) {
		r, _, err := procClosePrinter.Call(uintptr(hPrinter))
		return r, err
	},
	startDocPrinterW: func(hPrinter syscall.Handle, di *docInfo1) (uintptr, error) {
		r, _, err := procStartDocPrinterW.Call(
			uintptr(hPrinter),
			1,
			uintptr(unsafe.Pointer(di)),
		)
		return r, err
	},
	startPagePrinter: func(hPrinter syscall.Handle) (uintptr, error) {
		r, _, err := procStartPagePrinter.Call(uintptr(hPrinter))
		return r, err
	},
	writePrinter: func(hPrinter syscall.Handle, buf unsafe.Pointer, len int, bytesWritten *uint32) (uintptr, error) {
		r, _, err := procWritePrinter.Call(
			uintptr(hPrinter),
			uintptr(buf),
			uintptr(len),
			uintptr(unsafe.Pointer(bytesWritten)),
		)
		return r, err
	},
	endPagePrinter: func(hPrinter syscall.Handle) (uintptr, error) {
		r, _, err := procEndPagePrinter.Call(uintptr(hPrinter))
		return r, err
	},
	endDocPrinter: func(hPrinter syscall.Handle) (uintptr, error) {
		r, _, err := procEndDocPrinter.Call(uintptr(hPrinter))
		return r, err
	},
	abortPrinter: func(hPrinter syscall.Handle) (uintptr, error) {
		r, _, err := procAbortPrinter.Call(uintptr(hPrinter))
		return r, err
	},
}

// abortSpoolerDoc discards a Win32 document session that is not verifiably
// complete.
//
// Per Microsoft's spooler contract
// (https://learn.microsoft.com/en-us/windows/win32/printdocs/enddocprinter and
// https://learn.microsoft.com/en-us/windows/win32/printdocs/abortprinter),
// EndDocPrinter FINALIZES a job (releasing it to the printer) while
// AbortPrinter DELETES the job's spool file. Every Win32 call reports success
// through its BOOL return value; GetLastError is meaningful only after a
// zero return.
//
// Completion must be proven by the write loop (every byte genuinely
// accepted), never inferred from byte counters: a faulty driver can
// over-report, and failed/cancelled writes can still fold bytes into the
// counter. An incomplete or uncertain document must therefore be aborted,
// never finalized — calling EndDocPrinter on a partial RAW/ESC-POS stream
// releases truncated output (a cut receipt, a half-printed label) that the
// caller is about to report as failed or UNKNOWN.
func abortSpoolerDoc(sys spoolerSyscalls, hPrinter syscall.Handle, spoolerName string, bytesWritten, bytesTotal uint32) error {
	r, lastErr := sys.abortPrinter(hPrinter)
	if r == 0 {
		// AbortPrinter is best-effort: the spool file could not be deleted,
		// so a truncated job may still print. Report it — never claim success.
		return fmt.Errorf("AbortPrinter(%q) failed after %d/%d bytes (truncated job may still print): %w", spoolerName, bytesWritten, bytesTotal, lastErr)
	}
	log.Printf("spooler job on %q aborted after %d/%d bytes (incomplete document discarded)", spoolerName, bytesWritten, bytesTotal)
	return nil
}

func executeSpoolerSession(spoolerName string, data []byte, cancelNotice <-chan struct{}, onJobID func(uintptr), admit ...func() error) spoolerTaskResult {
	return executeSpoolerSessionWithSyscallsObserved(spoolerName, data, cancelNotice, defaultSpoolerSyscalls, onJobID, admit...)
}

// currentExecuteSpoolerSession runs the Win32 session for Print. It is a
// package variable (defaulting to the real session) solely so tests can
// fake a complete session — including the StartDocPrinterW job identity —
// without real Win32 handles. Production never reassigns it.
var currentExecuteSpoolerSession = executeSpoolerSession

func executeSpoolerSessionWithSyscalls(spoolerName string, data []byte, cancelNotice <-chan struct{}, sys spoolerSyscalls) spoolerTaskResult {
	return executeSpoolerSessionWithSyscallsObserved(spoolerName, data, cancelNotice, sys, nil)
}

func executeSpoolerSessionWithSyscallsObserved(spoolerName string, data []byte, cancelNotice <-chan struct{}, sys spoolerSyscalls, onJobID func(uintptr), admit ...func() error) spoolerTaskResult {
	printerNamePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return spoolerTaskResult{err: fmt.Errorf("invalid spooler name %q: %w", spoolerName, err)}
	}

	var hPrinter syscall.Handle
	ret, err := sys.openPrinterW(printerNamePtr, &hPrinter)
	if ret == 0 {
		return spoolerTaskResult{err: fmt.Errorf("OpenPrinterW(%q) failed: %w", spoolerName, err)}
	}
	defer sys.closePrinter(hPrinter)
	if len(admit) > 0 && admit[0] != nil {
		if err := admit[0](); err != nil {
			return spoolerTaskResult{err: fmt.Errorf("spooler print admission refused: %w", err)}
		}
	}

	select {
	case <-cancelNotice:
		return spoolerTaskResult{err: fmt.Errorf("spooler job cancelled before doc start")}
	default:
	}

	docName, err := syscall.UTF16PtrFromString("Yaseir Print Job")
	if err != nil {
		return spoolerTaskResult{err: fmt.Errorf("invalid document name: %w", err)}
	}
	defer runtime.KeepAlive(docName)
	dataType, err := syscall.UTF16PtrFromString("RAW")
	if err != nil {
		return spoolerTaskResult{err: fmt.Errorf("invalid datatype: %w", err)}
	}
	defer runtime.KeepAlive(dataType)
	di := docInfo1{pDocName: docName, pDatatype: dataType}
	jobID, err := sys.startDocPrinterW(hPrinter, &di)
	if jobID == 0 {
		return spoolerTaskResult{err: fmt.Errorf("StartDocPrinterW(%q) failed: %w", spoolerName, err)}
	}
	// Publish the platform identity immediately after StartDocPrinterW succeeds,
	// not only after the whole session succeeds. If a later Write/End call blocks
	// or fails, reconciliation still needs the allocated Windows job identity.
	if onJobID != nil {
		onJobID(jobID)
	}
	// Every path after StartDocPrinterW succeeded must close the document
	// session. Only the explicit success path below may call EndDocPrinter
	// (it releases a COMPLETE document). The deferred call owns every early
	// return (cancellation, StartPagePrinter failure, partial/failed writes,
	// over-report, uncertain wire state) and always aborts: completion is
	// proven by the write loop, never inferred from byte counters, so a
	// fabricated or over-reported counter can never finalize truncated
	// output as a complete job.
	totalBytes := uint32(len(data))
	var written uint32
	docCompleted := false
	defer func() {
		if docCompleted {
			return
		}
		if err := abortSpoolerDoc(sys, hPrinter, spoolerName, written, totalBytes); err != nil {
			log.Printf("spooler cleanup warning for %s: %v", spoolerName, err)
		}
	}()

	select {
	case <-cancelNotice:
		return spoolerTaskResult{jobID: jobID, err: fmt.Errorf("spooler job cancelled before page start")}
	default:
	}

	ret, err = sys.startPagePrinter(hPrinter)
	if ret == 0 {
		return spoolerTaskResult{jobID: jobID, err: fmt.Errorf("StartPagePrinter(%q) failed: %w", spoolerName, err)}
	}
	pageCompleted := false
	defer func() {
		if !pageCompleted {
			sys.endPagePrinter(hPrinter)
		}
	}()

	for int(written) < len(data) {
		select {
		case <-cancelNotice:
			if written > 0 {
				return spoolerTaskResult{
					written: written,
					jobID:   jobID,
					err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: print cancelled after %d/%d bytes", written, len(data)),
				}
			}
			return spoolerTaskResult{jobID: jobID, err: fmt.Errorf("print cancelled")}
		default:
		}

		var bytesWritten uint32
		chunk := data[written:]
		if len(chunk) > networkWriteChunkSize {
			chunk = chunk[:networkWriteChunkSize]
		}
		r, writeErr := sys.writePrinter(hPrinter, unsafe.Pointer(&chunk[0]), len(chunk), &bytesWritten)
		if r == 0 {
			// A failed WritePrinter may still have accepted bytes. Fold them
			// into `written` (capped at the payload size, so a driver that
			// over-reports cannot make a truncated job look complete) so the
			// deferred cleanup reports the same evidence the caller returns
			// instead of under-reporting as "0 bytes".
			if remaining := uint32(len(data)) - written; bytesWritten > remaining {
				bytesWritten = remaining
			}
			written += bytesWritten
			totalWritten := written
			if totalWritten > 0 {
				return spoolerTaskResult{
					written: totalWritten,
					jobID:   jobID,
					err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) failed after %d/%d bytes: %w", spoolerName, totalWritten, len(data), writeErr),
				}
			}
			return spoolerTaskResult{written: written, jobID: jobID, err: fmt.Errorf("WritePrinter(%q) failed after %d/%d bytes: %w", spoolerName, written, len(data), writeErr)}
		}
		if bytesWritten == 0 {
			if written > 0 {
				return spoolerTaskResult{
					written: written,
					jobID:   jobID,
					err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) wrote 0 bytes after %d/%d bytes", spoolerName, written, len(data)),
				}
			}
			return spoolerTaskResult{written: written, jobID: jobID, err: fmt.Errorf("WritePrinter(%q) wrote 0 bytes", spoolerName)}
		}
		if bytesWritten > uint32(len(chunk)) {
			// A driver that reports more bytes than the submitted chunk is
			// faulty and the wire state is uncertain: report UNKNOWN with
			// the honestly confirmed byte count (bytes accepted before this
			// chunk). The counter is NOT advanced to the payload size — a
			// fabricated total must never read as completion evidence, and
			// the deferred cleanup aborts this session.
			return spoolerTaskResult{
				written: written,
				jobID:   jobID,
				err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) over-reported %d bytes for a %d-byte chunk after %d/%d confirmed bytes", spoolerName, bytesWritten, len(chunk), written, len(data)),
			}
		}
		written += bytesWritten
	}

	pageCompleted = true
	if r, endPageErr := sys.endPagePrinter(hPrinter); r == 0 {
		return spoolerTaskResult{
			written: written,
			jobID:   jobID,
			err:     MarkUnknown("spooler EndPagePrinter failed for %q after writing %d/%d bytes (submission state unknown): %v", spoolerName, written, len(data), endPageErr),
		}
	}

	// All bytes were accepted, so the document is complete and EndDocPrinter
	// is the documented way to release it. Success is decided by the BOOL
	// return value alone: GetLastError is only meaningful after a zero
	// return, and trusting a stale error here reported healthy prints as
	// ambiguous failures. docCompleted is set first so the deferred cleanup
	// never issues EndDocPrinter a second time.
	docCompleted = true
	if r, endErr := sys.endDocPrinter(hPrinter); r == 0 {
		// WritePrinter accepted all bytes, but the Win32 doc session did not
		// close cleanly: the spooler may discard the job. "Printed" would be
		// a false confirmation, so the outcome stays ambiguous. The spool
		// file is intentionally left in place (never AbortPrinter): the
		// document is byte-complete, and destroying it could lose output
		// that the spooler is still able to deliver.
		return spoolerTaskResult{
			written: written,
			jobID:   jobID,
			err:     MarkUnknown("spooler session for %q failed to close after writing %d/%d bytes (submission state unknown): %v", spoolerName, written, len(data), endErr),
		}
	}

	return spoolerTaskResult{written: written, jobID: jobID, err: nil}
}

const (
	// errorInsufficientBuffer is Win32 ERROR_INSUFFICIENT_BUFFER — the
	// documented way the spooler reports the buffer size it needs.
	errorInsufficientBuffer = uintptr(122)
	// getPrinterMaxAttempts bounds the two-call GetPrinterW pattern. The
	// queue can grow between the sizing call and the fetch (another client
	// changing the queue), so the fetch may fail with
	// ERROR_INSUFFICIENT_BUFFER again and MUST be retried
	// (https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rprn/e35fa2d2-8ca1-4369-be52-6e606759bd0e).
	// It is bounded so a spooler that keeps reporting a larger size can
	// never hang discovery forever.
	getPrinterMaxAttempts = 3
)

func isInsufficientBuffer(err error) bool {
	errno, ok := err.(syscall.Errno)
	return ok && uintptr(errno) == errorInsufficientBuffer
}

// openPrinterWPtr performs OpenPrinterW for one UTF-16 queue name.
//
// It exists as a package-level indirection (openPrinterWPtrFn) purely so the
// printer layer can be faked in tests: no test needs a real print queue to
// prove the PRINTER_INFO_2 status logic above it.
func openPrinterWPtr(printerNamePtr *uint16) (syscall.Handle, error) {
	var hPrinter syscall.Handle
	ret, _, lastErr := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNamePtr)),
		uintptr(unsafe.Pointer(&hPrinter)),
		0,
	)
	if ret == 0 {
		return 0, fmt.Errorf("OpenPrinterW failed: %w", lastErr)
	}
	return hPrinter, nil
}

var openPrinterWPtrFn = openPrinterWPtr

// getPrinterInfo2Fn is the test indirection for the PRINTER_INFO_2 query.
var getPrinterInfo2Fn = getPrinterInfo2

// Both indirections are read on helper goroutines that a bounded Win32 call
// deliberately ABANDONS when the caller times out — that abandonment is the
// entire point of bounding a blocking API. A test that restores a hook in
// t.Cleanup while such a goroutine is still inside its probe therefore races
// with it (and -race reports it), so every read and write goes through this
// mutex rather than touching the variables directly.
var printerHooksMu sync.RWMutex

func currentOpenPrinterWPtr() func(*uint16) (syscall.Handle, error) {
	printerHooksMu.RLock()
	defer printerHooksMu.RUnlock()
	return openPrinterWPtrFn
}

func currentGetPrinterInfo2() func(syscall.Handle) (*printerInfo2, []byte, error) {
	printerHooksMu.RLock()
	defer printerHooksMu.RUnlock()
	return getPrinterInfo2Fn
}

// setPrinterHooks swaps both Win32 indirections and returns a restore
// function. Tests must call it instead of assigning the variables, and must
// not restore while a probe goroutine can still be running.
func setPrinterHooks(
	open func(*uint16) (syscall.Handle, error),
	info func(syscall.Handle) (*printerInfo2, []byte, error),
) func() {
	printerHooksMu.Lock()
	prevOpen, prevInfo := openPrinterWPtrFn, getPrinterInfo2Fn
	openPrinterWPtrFn, getPrinterInfo2Fn = open, info
	printerHooksMu.Unlock()
	return func() {
		printerHooksMu.Lock()
		openPrinterWPtrFn, getPrinterInfo2Fn = prevOpen, prevInfo
		printerHooksMu.Unlock()
	}
}

// getPrinterInfo2 performs the documented two-call GetPrinterW(level 2)
// pattern and returns a PRINTER_INFO_2 view of one queue: call once with a
// zero-length buffer to learn pcbNeeded, allocate, then call again.
//
// The returned pointer points INTO the returned slice, so callers must keep
// that slice reachable (runtime.KeepAlive) for as long as they read fields.
// Every failure is fail-closed: a buffer smaller than PRINTER_INFO_2 is
// never dereferenced, because doing so would read out of bounds.
func getPrinterInfo2(hPrinter syscall.Handle) (*printerInfo2, []byte, error) {
	minSize := unsafe.Sizeof(printerInfo2{})
	for attempt := 0; attempt < getPrinterMaxAttempts; attempt++ {
		var needed uint32
		ret, _, lastErr := procGetPrinterW.Call(
			uintptr(hPrinter),
			2,
			0,
			0,
			uintptr(unsafe.Pointer(&needed)),
		)
		// The sizing call is EXPECTED to fail: pcbNeeded is delivered
		// together with ERROR_INSUFFICIENT_BUFFER. Any other error is real.
		if ret == 0 && !isInsufficientBuffer(lastErr) {
			return nil, nil, fmt.Errorf("GetPrinterW sizing failed: %w", lastErr)
		}
		if uintptr(needed) < minSize {
			return nil, nil, fmt.Errorf("GetPrinterW returned a %d-byte buffer (minimum %d) for level 2", needed, minSize)
		}

		buf := make([]byte, needed)
		ret, _, lastErr = procGetPrinterW.Call(
			uintptr(hPrinter),
			2,
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(needed),
			uintptr(unsafe.Pointer(&needed)),
		)
		if ret != 0 {
			if uintptr(len(buf)) < minSize {
				return nil, nil, fmt.Errorf("GetPrinterW returned a %d-byte buffer (minimum %d)", len(buf), minSize)
			}
			return (*printerInfo2)(unsafe.Pointer(&buf[0])), buf, nil
		}
		if !isInsufficientBuffer(lastErr) {
			return nil, nil, fmt.Errorf("GetPrinterW level 2 failed: %w", lastErr)
		}
		// The queue grew between the two calls; pcbNeeded now carries the
		// larger size, so size again on the next iteration.
	}
	return nil, nil, fmt.Errorf("GetPrinterW level 2 still reports a short buffer after %d attempts", getPrinterMaxAttempts)
}

func preFlightSpoolerCheck(spoolerName string) error {
	printerNamePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return fmt.Errorf("invalid spooler name %q: %w", spoolerName, err)
	}

	hPrinter, err := currentOpenPrinterWPtr()(printerNamePtr)
	if err != nil {
		return fmt.Errorf("%w: %w: OpenPrinterW(%q) failed: %v", ErrPrinterNotReady, ErrSpoolerQueueInaccessible, spoolerName, err)
	}
	defer procClosePrinter.Call(uintptr(hPrinter))

	pi, keepBuf, err := currentGetPrinterInfo2()(hPrinter)
	if err != nil || pi == nil {
		// Fail-closed: without PRINTER_INFO_2 the queue state is unproven,
		// so readiness cannot be claimed.
		if err == nil {
			err = fmt.Errorf("GetPrinterW(%q) returned no PRINTER_INFO_2", spoolerName)
		}
		return fmt.Errorf("%w: %w", ErrPrinterNotReady, err)
	}
	defer runtime.KeepAlive(keepBuf)

	// WorkOffline is a queue attribute the operator sets ("Use Printer
	// Offline"), not a device report. The spooler queues jobs instead of
	// sending them, so an attempt would strand a durable job until someone
	// clears the flag. Fail fast with an explicit reason.
	if (pi.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0 {
		return fmt.Errorf("%w: spooler printer %q has WorkOffline set (queue is holding jobs; clear \"Use Printer Offline\" to resume)", ErrPrinterOffline, spoolerName)
	}
	if (pi.Status & PRINTER_STATUS_OFFLINE) != 0 {
		return fmt.Errorf("%w: spooler printer %q is offline (status 0x%08x)", ErrPrinterOffline, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_SERVER_OFFLINE) != 0 {
		return fmt.Errorf("%w: print server reports spooler printer %q offline (status 0x%08x)", ErrPrinterOffline, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_NOT_AVAILABLE) != 0 {
		return fmt.Errorf("%w: spooler printer %q is not available (status 0x%08x)", ErrPrinterOffline, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PENDING_DELETION) != 0 {
		return fmt.Errorf("%w: spooler printer %q is pending deletion and cannot accept new jobs (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAUSED) != 0 {
		return fmt.Errorf("%w: spooler printer %q is paused (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_ERROR) != 0 {
		return fmt.Errorf("%w: spooler printer %q is in error state (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAPER_JAM) != 0 {
		return fmt.Errorf("%w: spooler printer %q has a paper jam (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAPER_PROBLEM) != 0 {
		return fmt.Errorf("%w: spooler printer %q reports a paper problem (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_MANUAL_FEED) != 0 {
		return fmt.Errorf("%w: spooler printer %q requires manual feed (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_OUTPUT_BIN_FULL) != 0 {
		return fmt.Errorf("%w: spooler printer %q output bin is full (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_NO_TONER) != 0 {
		return fmt.Errorf("%w: spooler printer %q is out of toner (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAGE_PUNT) != 0 {
		return fmt.Errorf("%w: spooler printer %q cannot print the current page (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_OUT_OF_MEMORY) != 0 {
		return fmt.Errorf("%w: spooler printer %q is out of memory (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_USER_INTERVENTION) != 0 {
		return fmt.Errorf("%w: spooler printer %q requires user intervention (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_DOOR_OPEN) != 0 {
		return fmt.Errorf("%w: spooler printer %q door or cover is open (status 0x%08x)", ErrPrinterCoverOpen, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAPER_OUT) != 0 {
		return fmt.Errorf("%w: spooler printer %q is out of paper (status 0x%08x)", ErrPrinterPaperOut, spoolerName, pi.Status)
	}
	// SERVER_UNKNOWN is inconclusive evidence, so it is considered only
	// after every explicit non-routable queue/device condition above.
	// This matches mapWindowsStatus: a concrete paused/error/media state
	// must not be hidden by a simultaneously reported unknown-server bit.
	if (pi.Status & PRINTER_STATUS_SERVER_UNKNOWN) != 0 {
		return fmt.Errorf("%w: %w: spooler printer %q status is unknown from the print server (status 0x%08x)", ErrPrinterNotReady, ErrSpoolerStatusUnknown, spoolerName, pi.Status)
	}
	return nil
}

// dispatchPreFlightSpoolerCheck applies the same concrete blocking checks as
// preFlightSpoolerCheck but does not turn SERVER_UNKNOWN into a hard dispatch
// rejection. SERVER_UNKNOWN means Windows cannot report device status; it is
// not an OFFLINE/PAUSED/ERROR bit. The queue is still allowed to prove its own
// admission through StartDocPrinterW/StartDocW. Status()/diagnostics continue
// to surface the evidence as unknown rather than online.
func dispatchPreFlightSpoolerCheck(spoolerName string) error {
	err := preFlightSpoolerCheck(spoolerName)
	if errors.Is(err, ErrSpoolerStatusUnknown) {
		return nil
	}
	return err
}

// observedSpoolerStatus reads the same PRINTER_INFO_2 snapshot used during
// discovery and reduces it with the shared Windows status mapper. This keeps
// heartbeat status consistent with discovery without turning non-blocking
// activity bits (PRINTING/PROCESSING/BUSY/IO_ACTIVE/INITIALIZING/WARMING_UP)
// into dispatch failures.
func observedSpoolerStatus(spoolerName string) (string, error) {
	printerNamePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return "unknown", fmt.Errorf("invalid spooler name %q: %w", spoolerName, err)
	}
	hPrinter, err := currentOpenPrinterWPtr()(printerNamePtr)
	if err != nil {
		return "unknown", fmt.Errorf("%w: OpenPrinterW(%q) failed: %v", ErrSpoolerQueueInaccessible, spoolerName, err)
	}
	defer procClosePrinter.Call(uintptr(hPrinter))
	pi, keepBuf, err := currentGetPrinterInfo2()(hPrinter)
	if err != nil || pi == nil {
		if err == nil {
			err = fmt.Errorf("GetPrinterW(%q) returned no PRINTER_INFO_2", spoolerName)
		}
		return "unknown", err
	}
	defer runtime.KeepAlive(keepBuf)
	return mapWindowsStatus(pi.Status, pi.Attributes), nil
}

// waitBeginSession acquires this printer's session slot with a bounded
// waiting lock (15-second timeout), honoring ctx cancellation. Used by
// Print to serialize full sessions per printer.
func (p *SpoolerPrinter) waitBeginSession(ctx context.Context) error {
	const lockTimeout = 15 * time.Second
	deadline := time.NewTimer(lockTimeout)
	defer deadline.Stop()

	// Fast path
	if p.sessionMu.TryLock() {
		return nil
	}

	// Bounded wait loop
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("%w: spooler session lock for %q timed out after %v", ErrPrinterNotReady, p.SpoolerName, lockTimeout)
		case <-ticker.C:
			if p.sessionMu.TryLock() {
				return nil
			}
		}
	}
}

func (p *SpoolerPrinter) endSession() {
	p.sessionMu.Unlock()
}

func (p *SpoolerPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// Pre-flight check printer status before allocating worker slots.
	// The check itself is bounded (see runPreflightBounded): a wedged
	// spooler RPC must not wedge the caller before the worker machinery
	// below even starts. Single-flight (see boundedPreflight) additionally
	// guarantees repeated timeouts cannot accumulate stuck helpers.
	preflightStart := time.Now()
	if err := p.boundedPreflight(ctx, preflightTimeout, func() error {
		return dispatchPreFlightSpoolerCheck(p.SpoolerName)
	}); err != nil {
		log.Printf("print.trace spooler_preflight printer=%s latency_ms=%d success=false", p.SpoolerName, time.Since(preflightStart).Milliseconds())
		return fmt.Errorf("pre-flight spooler check failed: %w", err)
	}
	log.Printf("print.trace spooler_preflight printer=%s latency_ms=%d success=true", p.SpoolerName, time.Since(preflightStart).Milliseconds())

	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// Serialize full sessions per printer with a bounded 15s wait.
	if err := p.waitBeginSession(ctx); err != nil {
		return err
	}

	// A new attempt must never inherit evidence from an earlier job — but it
	// must also never erase a still-running attempt's evidence. Clear only
	// AFTER acquiring the session (mirroring the PDF path): an attempt that
	// merely times out waiting behind a running worker returns without
	// touching the first attempt's StartDocPrinterW identity.
	p.lastJobID.Store(0)

	// Ownership of sessionMu is transferred to the worker. Win32 WritePrinter
	// is not cancellable; if the caller times out while the worker is still
	// inside the spooler RPC, releasing the mutex here would allow a second
	// physical print session to overlap the stuck one. The worker therefore
	// keeps the per-printer lock until executeSpoolerSession actually returns.
	printStart := time.Now()
	resultCh := make(chan spoolerTaskResult, 1)
	cancelNotice := make(chan struct{})

	// Reserve liveness before scheduling: even an unscheduled worker owns
	// this generation once Print can return to its caller on cancellation.
	p.inflight.Add(1)
	go func() {
		defer p.inflight.Add(-1)
		defer p.endSession()
		res := currentExecuteSpoolerSession(p.SpoolerName, data, cancelNotice, func(jobID uintptr) {
			p.recordSpoolerJobID(ctx, uint64(jobID))
		}, func() error { return runDispatchAdmission(ctx) })
		// Publish before releasing this worker's session, even if its caller
		// already returned UNKNOWN. Do not write backend history in the caller:
		// a later worker may acquire the session before that caller is scheduled.
		p.recordSpoolerJobID(ctx, uint64(res.jobID))
		resultCh <- res
	}()

	select {
	case <-ctx.Done():
		close(cancelNotice)
		// The worker may already be past WritePrinter. Wait a bounded time
		// for its authoritative result; whatever it reports (including
		// UNKNOWN_PARTIAL_DELIVERY from a mid-write cancel) is returned as
		// is. If the Win32 call never returns, the outcome is unknown BY
		// DEFINITION and must be reported as such — never as a clean
		// not-printed failure, which would invite a duplicate reprint.
		select {
		case res := <-resultCh:
			return res.err
		case <-time.After(postCancelSpoolerResultGrace):
			return MarkUnknown("spooler session on %q still active after cancellation (bytes written unknown): %v", p.SpoolerName, ctx.Err())
		}
	case res := <-resultCh:
		if res.err != nil {
			log.Printf("print.trace spooler_session printer=%s latency_ms=%d success=false", p.SpoolerName, time.Since(printStart).Milliseconds())
			return res.err
		}
		log.Printf("print.trace spooler_session printer=%s latency_ms=%d success=true", p.SpoolerName, time.Since(printStart).Milliseconds())
		log.Printf("Spooler printed %d bytes to %s (job %d)", res.written, p.SpoolerName, res.jobID)
		return nil
	}
}

// SessionMayBeLive implements LiveSessionReporter: true while a print
// session is reserved or its worker has not completed cleanup. After the caller
// gives up waiting (post-cancel grace expiry), the Win32 session can still
// own the physical queue — the counter stays raised until that exact worker
// returns.
func (p *SpoolerPrinter) SessionMayBeLive() bool {
	return p.inflight.Load() > 0
}

// recordSpoolerJobID is called only by the native session-owning worker.
// Diagnostic history and attempt evidence are intentionally separate: history
// may survive a rejected call, while evidence must never cross invocations.
func (p *SpoolerPrinter) recordSpoolerJobID(ctx context.Context, jobID uint64) {
	if jobID == 0 {
		return
	}
	p.lastJobID.Store(jobID)
	RecordSpoolerJobID(ctx, jobID)
}

// LastSpoolerJobID implements the legacy diagnostic accessor. It can refer to
// a previous or still-running session and must not be attributed to a caller.
func (p *SpoolerPrinter) LastSpoolerJobID() string {
	if id := p.lastJobID.Load(); id != 0 {
		return strconv.FormatUint(id, 10)
	}
	return ""
}

func (p *SpoolerPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS, KindPDF, KindImage:
		return true
	default:
		return false
	}
}

func (p *SpoolerPrinter) printPDFDocument(ctx context.Context, doc Document) error {
	// Serialize the full GDI session with RAW/ESC-POS sessions on this same
	// Windows queue. Ownership is transferred to the worker below: if a driver
	// blocks in StartDocW/StartPage/StretchDIBits/EndPage/EndDoc, the worker
	// keeps the mutex until that exact session returns. A caller timing out must
	// never unlock the printer and allow a second physical job to overlap an
	// uncertain first one.
	if err := p.waitBeginSession(ctx); err != nil {
		return err
	}

	// A PDF/image attempt must never inherit evidence from an earlier RAW job.
	// Clear only AFTER acquiring the session: a second attempt that merely
	// times out waiting behind a still-running worker must not erase the first
	// attempt's StartDocW evidence.
	p.lastJobID.Store(0)

	type pdfTaskResult struct {
		jobID string
		err   error
	}
	resultCh := make(chan pdfTaskResult, 1)
	var attemptJobID atomic.Uint64
	recordJobID := func(jobID uint64) {
		if jobID != 0 {
			attemptJobID.Store(jobID)
			p.recordSpoolerJobID(ctx, jobID)
		}
	}

	// PDF/image workers have the same physical ownership as RAW workers.
	// Keep the counter raised across timeout, result publication and cleanup;
	// only this exact worker may release its generation's liveness fence.
	p.inflight.Add(1)
	go func() {
		defer p.inflight.Add(-1)
		defer p.endSession()

		if p.PDFPrint != nil {
			resultCh <- pdfTaskResult{err: PrintPDF(ctx, p.SpoolerName, doc, p.PDFPrint)}
			return
		}

		resultFn := p.PDFPrintResult
		if resultFn == nil {
			resultFn = func(callCtx context.Context, printerName, pdfPath string) (string, error) {
				return platformPrintPDFObserved(callCtx, printerName, pdfPath, func(jobID uint32) {
					if jobID != 0 {
						// Publish StartDocW identity immediately, before any later GDI
						// call can block. Publish only to this invocation's evidence.
						recordJobID(uint64(jobID))
					}
				})
			}
		}

		spoolerJobID, printErr := printPDFWithResult(ctx, p.SpoolerName, doc, resultFn)
		if spoolerJobID != "" {
			id, parseErr := strconv.ParseUint(spoolerJobID, 10, 64)
			if parseErr != nil || id == 0 {
				if printErr != nil {
					resultCh <- pdfTaskResult{jobID: spoolerJobID, err: fmt.Errorf("%w; Windows PDF renderer also returned invalid spooler job ID %q", printErr, spoolerJobID)}
					return
				}
				resultCh <- pdfTaskResult{jobID: spoolerJobID, err: fmt.Errorf("Windows PDF renderer returned invalid spooler job ID %q", spoolerJobID)}
				return
			}
			recordJobID(id)
		}
		resultCh <- pdfTaskResult{jobID: spoolerJobID, err: printErr}
	}()

	select {
	case result := <-resultCh:
		return result.err
	case <-ctx.Done():
		// The worker owns every GDI/PDFium handle and the session mutex. Give a
		// just-completing synchronous call a bounded chance to report its real
		// result, but never AbortDoc/DeleteDC/Close from this goroutine. If the
		// driver remains blocked, UNKNOWN is the only physically safe answer.
		select {
		case result := <-resultCh:
			return result.err
		case <-time.After(postCancelSpoolerResultGrace):
			if jobID := attemptJobID.Load(); jobID != 0 {
				return MarkUnknown("Windows PDF/GDI session on %q (spooler job %d) is still active after cancellation; physical outcome is unknown: %v", p.SpoolerName, jobID, ctx.Err())
			}
			return MarkUnknown("Windows PDF/GDI session on %q is still active after cancellation; StartDocW may still complete, so physical outcome is unknown: %v", p.SpoolerName, ctx.Err())
		}
	}
}

func (p *SpoolerPrinter) PrintDocument(ctx context.Context, doc Document) error {
	switch NormalizeKind(doc.Kind) {
	case KindPDF:
		return p.printPDFDocument(ctx, doc)
	case KindImage:
		if err := runDispatchAdmission(ctx); err != nil {
			return fmt.Errorf("image spooler admission refused: %w", err)
		}
		roll, dots, dpi := p.ReceiptPaperMM, p.ReceiptRasterDots, p.ReceiptDPI
		if roll == 0 {
			// Read the actual Windows driver paper form. Never infer 80mm
			// from product names: the same queue can be configured for A4.
			roll, dots, dpi = spoolerDetectedReceiptPaper(ctx, p.SpoolerName)
		}
		var pdf []byte
		var err error
		if roll == 58 || roll == 80 {
			pdf, err = JPEGToPDFReceipt(doc.Data, roll, dots, dpi)
		} else {
			// A4/Letter and unknown paper keep generic image behavior.
			pdf, err = JPEGToPDF(doc.Data)
		}
		if err != nil {
			return fmt.Errorf("render image for Windows spooler: %w", err)
		}
		return p.printPDFDocument(ctx, Document{Kind: KindPDF, Data: pdf, JobID: doc.JobID})
	case KindRaw, KindESCPOS:
		return p.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("spooler printer %q cannot render %s payloads", p.SpoolerName, NormalizeKind(doc.Kind))
	}
}

// SpoolerProbe is the evidence record for one Windows print queue. Every
// field names its source: queue/driver/port/attributes come from GetPrinterW
// level 2 (the Windows authority for installed queues), availability comes
// from OpenPrinter + GetPrinter results with exact Win32 errors, and the
// verdict distinguishes queue health from physical-device truth.
type SpoolerProbe struct {
	QueueName        string `json:"queue_name"`
	DriverName       string `json:"driver_name,omitempty"`
	PortName         string `json:"port_name,omitempty"`
	PrintProcessor   string `json:"print_processor,omitempty"`
	Datatype         string `json:"datatype,omitempty"`
	ShareName        string `json:"share_name,omitempty"`
	Comment          string `json:"comment,omitempty"`
	Location         string `json:"location,omitempty"`
	Attributes       uint32 `json:"attributes"`
	WorkOffline      bool   `json:"work_offline"`
	StatusFlags      uint32 `json:"status_flags"`
	PendingJobs      uint32 `json:"pending_jobs"`
	OpenPrinterOK    bool   `json:"open_printer_ok"`
	OpenPrinterError string `json:"open_printer_error,omitempty"`
	GetPrinterOK     bool   `json:"get_printer_ok"`
	GetPrinterError  string `json:"get_printer_error,omitempty"`
	Verdict          string `json:"verdict"`
	VerdictReason    string `json:"verdict_reason"`
}

// Spooler verdicts. SPOOLER_JOB_ACCEPTED is the strongest truthful claim for
// a submission path (Windows accepted the bytes); PHYSICAL_OUTCOME_UNKNOWN
// is the honest physical state after acceptance. Nothing here claims paper.
const (
	SpoolerReadyToAccept    = "SPOOLER_READY_TO_ACCEPT"
	SpoolerQueueUnavailable = "SPOOLER_QUEUE_UNAVAILABLE"
	SpoolerDriverError      = "SPOOLER_DRIVER_ERROR"
	SpoolerPortError        = "SPOOLER_PORT_ERROR"
	SpoolerStatusUnknown    = "SPOOLER_STATUS_UNKNOWN"
	SpoolerJobAccepted      = "SPOOLER_JOB_ACCEPTED"
	PhysicalOutcomeUnknown  = "PHYSICAL_OUTCOME_UNKNOWN"
)

// ProbeSpoolerQueue collects Windows spooler evidence for one queue without
// submitting any document. OpenPrinter/GetPrinter failures carry the exact
// Win32 error; status bits are reported as observed flags, never collapsed
// into physical truth.
func ProbeSpoolerQueue(spoolerName string) SpoolerProbe {
	probe := SpoolerProbe{QueueName: spoolerName}
	printerNamePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		probe.OpenPrinterError = fmt.Sprintf("encode spooler name: %v", err)
		probe.Verdict = SpoolerQueueUnavailable
		probe.VerdictReason = "invalid spooler name"
		return probe
	}
	var hPrinter syscall.Handle
	ret, _, lastErr := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNamePtr)),
		uintptr(unsafe.Pointer(&hPrinter)),
		0,
	)
	if ret == 0 {
		if lastErr != nil {
			probe.OpenPrinterError = lastErr.Error()
		} else {
			probe.OpenPrinterError = "OpenPrinterW returned zero"
		}
		probe.Verdict = SpoolerQueueUnavailable
		probe.VerdictReason = "OpenPrinterW failed; queue inaccessible from service context (install as a per-machine printer connection — per-user queues are invisible to Windows Services)"
		return probe
	}
	probe.OpenPrinterOK = true
	defer procClosePrinter.Call(uintptr(hPrinter))

	pi, keepBuf, gpErr := getPrinterInfo2(hPrinter)
	if gpErr != nil || pi == nil {
		if gpErr != nil {
			probe.GetPrinterError = gpErr.Error()
		} else {
			probe.GetPrinterError = "GetPrinterW level 2 returned no PRINTER_INFO_2"
		}
		probe.Verdict = SpoolerStatusUnknown
		probe.VerdictReason = "GetPrinterW failed; queue state unreadable"
		return probe
	}
	defer runtime.KeepAlive(keepBuf)
	probe.GetPrinterOK = true
	probe.DriverName = utf16PtrToString(pi.pDriverName)
	probe.PortName = utf16PtrToString(pi.pPortName)
	probe.PrintProcessor = utf16PtrToString(pi.pPrintProcessor)
	probe.Datatype = utf16PtrToString(pi.pDatatype)
	probe.ShareName = utf16PtrToString(pi.pShareName)
	probe.Comment = utf16PtrToString(pi.pComment)
	probe.Location = utf16PtrToString(pi.pLocation)
	probe.Attributes = pi.Attributes
	probe.WorkOffline = (pi.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0
	probe.StatusFlags = pi.Status
	probe.PendingJobs = pi.cJobs
	if probe.DriverName == "" {
		probe.Verdict = SpoolerDriverError
		probe.VerdictReason = "queue has no driver name; driver missing or corrupt"
		return probe
	}
	if probe.PortName == "" {
		probe.Verdict = SpoolerPortError
		probe.VerdictReason = "queue has no port; port missing or invalid"
		return probe
	}
	if probe.WorkOffline {
		probe.Verdict = SpoolerQueueUnavailable
		probe.VerdictReason = "WorkOffline attribute set (\"Use Printer Offline\"); spooler holds jobs"
		return probe
	}
	if (pi.Status & PRINTER_STATUS_PENDING_DELETION) != 0 {
		probe.Verdict = SpoolerQueueUnavailable
		probe.VerdictReason = "queue pending deletion; Windows refuses new print jobs"
		return probe
	}
	if (pi.Status & PRINTER_STATUS_PAUSED) != 0 {
		probe.Verdict = SpoolerQueueUnavailable
		probe.VerdictReason = "queue paused; spooler holds jobs"
		return probe
	}
	if (pi.Status & (PRINTER_STATUS_ERROR | PRINTER_STATUS_PAPER_JAM | PRINTER_STATUS_PAPER_OUT | PRINTER_STATUS_MANUAL_FEED | PRINTER_STATUS_PAPER_PROBLEM | PRINTER_STATUS_OUTPUT_BIN_FULL | PRINTER_STATUS_NO_TONER | PRINTER_STATUS_PAGE_PUNT | PRINTER_STATUS_USER_INTERVENTION | PRINTER_STATUS_OUT_OF_MEMORY | PRINTER_STATUS_DOOR_OPEN)) != 0 {
		probe.Verdict = SpoolerStatusUnknown
		probe.VerdictReason = fmt.Sprintf("queue reports a blocking device condition (status 0x%08x); Agent preflight refuses new dispatch until it clears; physical outcome of existing jobs remains unknown", pi.Status)
		return probe
	}
	if (pi.Status & (PRINTER_STATUS_OFFLINE | PRINTER_STATUS_SERVER_OFFLINE | PRINTER_STATUS_NOT_AVAILABLE)) != 0 {
		probe.Verdict = SpoolerQueueUnavailable
		probe.VerdictReason = fmt.Sprintf("port monitor reports unavailable/offline (status 0x%08x); queue exists and is accessible; physical device state remains driver/monitor-reported (for Standard TCP/IP ports, verify 'SNMP Status Enabled'/community if this disagrees with a known-working printer)", pi.Status)
		return probe
	}
	if (pi.Status & PRINTER_STATUS_SERVER_UNKNOWN) != 0 {
		probe.Verdict = SpoolerStatusUnknown
		probe.VerdictReason = fmt.Sprintf("print server reports printer status unknown (status 0x%08x); queue exists and is accessible; physical device state is unproven", pi.Status)
		return probe
	}
	probe.Verdict = SpoolerReadyToAccept
	probe.VerdictReason = "queue exists, driver and port present, no blocking status; submission eligible (physical outcome still unknown until observed)"
	return probe
}

func (p *SpoolerPrinter) Test(ctx context.Context) error {
	// A spooler queue is driver-rendered: sending RAW ESC/POS bytes to an
	// office printer (Brother MFC, HP LaserJet, …) bypasses the driver and
	// produces garbage or nothing. The correct local check proves the
	// Windows path is usable (OpenPrinter + GetPrinter level 2) without
	// submitting a document; genuine document tests travel the Gateway
	// "Send Test Page" path as PDF (spooler) so the driver renders them.
	// No bytes are spooled by this probe: success means SPOOLER_READY_TO_ACCEPT
	// (queue exists, driver loads, spooler answered) — the physical outcome
	// of any later document remains UNKNOWN until observed.
	if err := p.boundedPreflight(ctx, preflightTimeout, func() error {
		return dispatchPreFlightSpoolerCheck(p.SpoolerName)
	}); err != nil {
		return fmt.Errorf("spooler test probe for %q (SPOOLER_QUEUE_UNAVAILABLE): %w", p.SpoolerName, err)
	}
	log.Printf("Spooler test probe for %q succeeded (SPOOLER_READY_TO_ACCEPT; no document spooled)", p.SpoolerName)
	return nil
}

func (p *SpoolerPrinter) Status() string {
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 1500 * time.Millisecond
	}
	// An injected probe (tests, diagnostics) keeps its own bounded,
	// panic-recovering contract.
	if p.ProbeFunc != nil {
		resCh := make(chan string, 1)
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("Spooler status probe panic for %s: %v", p.SpoolerName, r)
					resCh <- "error"
				}
			}()
			resCh <- p.ProbeFunc(p.SpoolerName)
		}()
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case st := <-resCh:
			return st
		case <-timer.C:
			return "unknown"
		}
	}

	// Real spooler probe. This MUST go through boundedPreflight: the
	// previous version spawned a fresh goroutine per call and abandoned it
	// on timeout, so every heartbeat against a wedged spooler leaked one
	// more blocked helper (each holding an OpenPrinter handle) for the
	// lifetime of the process. Single-flight + bounded wait means at most
	// one stuck helper per printer, ever.
	//
	// Evaluate the same PRINTER_INFO_2 status bits as the dispatch
	// preflight: a queue that merely OPENS (paused, error, jam, door open,
	// paper out) must not report "online" or the gateway keeps routing jobs
	// at a printer that refuses them.
	observed := "unknown"
	err := p.boundedPreflight(context.Background(), timeout, func() error {
		status, err := observedSpoolerStatus(p.SpoolerName)
		if err == nil {
			observed = status
		}
		return err
	})
	if err == nil {
		return observed
	}
	if errors.Is(err, ErrSpoolerUnresponsive) || errors.Is(err, ErrSpoolerQueueInaccessible) {
		log.Printf("WARNING: Spooler status for %q is inconclusive: %v", p.SpoolerName, err)
		return "unknown"
	}
	log.Printf("WARNING: Spooler status read failed for %q: %v", p.SpoolerName, err)
	return "unknown"
}

type printerInfo2 struct {
	pServerName         *uint16
	pPrinterName        *uint16
	pShareName          *uint16
	pPortName           *uint16
	pDriverName         *uint16
	pComment            *uint16
	pLocation           *uint16
	pDevMode            uintptr
	pSepFile            *uint16
	pPrintProcessor     *uint16
	pDatatype           *uint16
	pParameters         *uint16
	pSecurityDescriptor uintptr
	Attributes          uint32
	Priority            uint32
	DefaultPriority     uint32
	StartTime           uint32
	UntilTime           uint32
	Status              uint32
	cJobs               uint32
	AveragePPM          uint32
}

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	return windows.UTF16PtrToString(p)
}

func fallbackRegistryPrinters() ([]DeviceInfo, error) {
	log.Printf("[discovery] falling back to registry for spooler printers")
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Print\Printers`, registry.READ)
	if err != nil {
		return nil, fmt.Errorf("registry fallback failed to open Printers key: %w", err)
	}
	defer k.Close()

	names, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, fmt.Errorf("registry fallback failed to read printer names: %w", err)
	}

	var out []DeviceInfo
	for _, name := range names {
		if name == "" {
			continue
		}
		out = append(out, DeviceInfo{
			Name:           name,
			Protocol:       "spooler",
			ConnectionType: "spooler",
			Endpoint:       name,
			SpoolerName:    name,
			Capabilities: map[string]interface{}{
				"discovered_via": SourceSpooler,
			},
		})
	}
	log.Printf("[discovery] registry fallback found %d printers", len(out))
	return out, nil
}

// queueDetails is the PRINTER_INFO_2 evidence discovery needs for one queue.
type queueDetails struct {
	portName   string
	driverName string
	serverName string
	shareName  string
	status     uint32
	attributes uint32
}

const (
	// printerEnumTimeout bounds one EnumPrintersW pass. Microsoft documents
	// EnumPrinters as a blocking synchronous call whose duration depends on
	// network status, print server configuration and driver implementation,
	// and warns it can make an application unresponsive
	// (https://learn.microsoft.com/en-us/windows/win32/printdocs/enumprinters).
	// Discovery must therefore bound it itself instead of trusting the API.
	printerEnumTimeout = 5 * time.Second
	// printerEnumMaxAttempts bounds the two-call buffer sizing loop. The
	// printer list can grow between the sizing call and the fetch, which
	// makes the fetch fail with ERROR_INSUFFICIENT_BUFFER again and again;
	// retrying is required, looping forever is not.
	printerEnumMaxAttempts = 4
	// queueDetailTimeout bounds one OpenPrinterW + GetPrinterW pair.
	queueDetailTimeout = 3 * time.Second
	// queueDetailBudget bounds the TOTAL time spent reading queue details so
	// a machine with dozens of stalled queues still finishes discovery.
	queueDetailBudget = 8 * time.Second
)

// printerInfo4 is PRINTER_INFO_4 (pPrinterName, pServerName, Attributes).
type printerInfo4 struct {
	pPrinterName *uint16
	pServerName  *uint16
	Attributes   uint32
}

// printerQueueRef is a decoded queue identity. Names are copied out of the
// spooler buffer as Go strings, so no caller can outlive the enumeration
// buffer (the previous struct-copy approach could, in principle, leave
// pointers into a collected buffer). server carries PRINTER_INFO_4
// pServerName: empty for machine-local queues, set for connections, so
// cross-server queue identity retains its provenance.
type printerQueueRef struct {
	name       string
	server     string
	attributes uint32
	scope      string // machine_local or user_connection (EnumPrinters source)
}

// enumPrinterQueues enumerates queue names and attributes with
// EnumPrintersW level 4.
//
// Level 4 is deliberate. Per the EnumPrinters documentation, a level 2
// enumeration "performs an OpenPrinter call on each remote connection": if a
// connection is down, or the remote server or printer no longer exists, the
// function must wait for RPC to time out — one dead \\server\queue can stall
// discovery for minutes, or fail the whole enumeration. Level 4 returns names
// and attributes WITHOUT opening each queue, so a single unreachable queue
// can only ever cost one bounded per-queue query (see queueDetail).
//
// Level 4 supports exactly the flags used here (PRINTER_ENUM_LOCAL and
// PRINTER_ENUM_CONNECTIONS) and requires a NULL Name, as documented.
var enumerationActive atomic.Bool
var queueDetailsActive sync.Map

func enumPrinterQueuesPass(flags uintptr, scope string) ([]printerQueueRef, error) {
	const printerEnumLevel = 4
	structSize := unsafe.Sizeof(printerInfo4{})
	for attempt := 0; attempt < printerEnumMaxAttempts; attempt++ {
		var needed, returned uint32
		ret, _, lastErr := procEnumPrintersW.Call(
			flags, 0, uintptr(printerEnumLevel), 0, 0,
			uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)),
		)
		if ret == 0 && !isInsufficientBuffer(lastErr) {
			return nil, fmt.Errorf("EnumPrintersW %s level %d sizing failed: %w", scope, printerEnumLevel, lastErr)
		}
		if needed == 0 {
			if ret == 0 {
				return nil, fmt.Errorf("EnumPrintersW %s level %d failed: %w", scope, printerEnumLevel, lastErr)
			}
			return nil, nil
		}

		buf := make([]byte, needed)
		ret, _, lastErr = procEnumPrintersW.Call(
			flags, 0, uintptr(printerEnumLevel), uintptr(unsafe.Pointer(&buf[0])), uintptr(needed),
			uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)),
		)
		if ret != 0 {
			if structSize > 0 && uintptr(returned)*structSize > uintptr(len(buf)) {
				// Malformed count: the spooler reported more entries than
				// fit the buffer it sized. A truncated inventory must never
				// stay authoritative (reconciliation could prune omitted
				// queues), so re-run the sizing loop instead of silently
				// clamping. Exhaustion below surfaces a hard
				// incomplete-source error.
				continue
			}
			queues := make([]printerQueueRef, 0, returned)
			for i := uint32(0); i < returned; i++ {
				offset := uintptr(i) * structSize
				pi := (*printerInfo4)(unsafe.Pointer(uintptr(unsafe.Pointer(&buf[0])) + offset))
				queues = append(queues, printerQueueRef{
					name:       utf16PtrToString(pi.pPrinterName),
					server:     utf16PtrToString(pi.pServerName),
					attributes: pi.Attributes,
					scope:      scope,
				})
			}
			runtime.KeepAlive(buf)
			return queues, nil
		}
		if !isInsufficientBuffer(lastErr) {
			return nil, fmt.Errorf("EnumPrintersW %s level %d failed: %w", scope, printerEnumLevel, lastErr)
		}
	}
	return nil, fmt.Errorf("EnumPrintersW %s level %d still reports a short buffer after %d attempts", scope, printerEnumLevel, printerEnumMaxAttempts)
}

func enumPrinterQueues() ([]printerQueueRef, error) {
	const (
		printerEnumLocal       = 0x00000002
		printerEnumConnections = 0x00000004
	)
	if !enumerationActive.CompareAndSwap(false, true) {
		return nil, fmt.Errorf("previous spooler enumeration is still pending")
	}

	type passResult struct {
		queues []printerQueueRef
		err    error
	}
	results := make(chan passResult, 2)
	// Keep one helper responsible for both synchronous Winspool calls. It
	// publishes the LOCAL result before entering CONNECTIONS, so if the
	// user-scoped provider later stalls the caller can retain proven machine
	// queues. enumerationActive stays set until the blocked helper itself
	// exits, preventing repeated timeout calls from accumulating RPC helpers.
	go func() {
		defer enumerationActive.Store(false)
		queues, err := enumPrinterQueuesPass(printerEnumLocal, "machine_local")
		results <- passResult{queues: queues, err: err}
		queues, err = enumPrinterQueuesPass(printerEnumConnections, "user_connection")
		results <- passResult{queues: queues, err: err}
	}()

	var (
		locals      []printerQueueRef
		connections []printerQueueRef
		errs        []error
	)
	timer := time.NewTimer(printerEnumTimeout)
	defer timer.Stop()
	for completed := 0; completed < 2; completed++ {
		select {
		case r := <-results:
			if r.err != nil {
				errs = append(errs, r.err)
			}
			if completed == 0 {
				locals = r.queues
			} else {
				connections = r.queues
			}
		case <-timer.C:
			err := fmt.Errorf("EnumPrintersW exceeded %v (spooler RPC stalled)", printerEnumTimeout)
			errs = append(errs, err)
			completed = 2 // leave loop after building any partial LOCAL result
		}
	}

	// A queue returned as LOCAL is machine-installed and therefore wins if
	// the same queue name also appears as a caller-user connection.
	queues := make([]printerQueueRef, 0, len(locals)+len(connections))
	seen := make(map[string]struct{}, len(locals)+len(connections))
	appendUnique := func(items []printerQueueRef) {
		for _, item := range items {
			key := strings.ToLower(normalizeUnicode(strings.TrimSpace(item.name)))
			if key == "" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			queues = append(queues, item)
		}
	}
	appendUnique(locals)
	appendUnique(connections)
	return queues, errors.Join(errs...)
}

// queueDetail reads PRINTER_INFO_2 for one queue (port, driver, status,
// attributes) under a hard deadline. OpenPrinterW and GetPrinterW expose no
// timeout of their own and block against a wedged spooler RPC, so the call
// runs on a helper goroutine the caller abandons on timeout; the handle is
// opened and closed inside that helper, so nothing is left dangling.
func queueDetail(name string) (queueDetails, error) {
	gateValue, _ := queueDetailsActive.LoadOrStore(name, &atomic.Bool{})
	gate := gateValue.(*atomic.Bool)
	if !gate.CompareAndSwap(false, true) {
		return queueDetails{}, fmt.Errorf("previous queue detail for %q is still pending", name)
	}

	type detailResult struct {
		detail queueDetails
		err    error
	}
	done := make(chan detailResult, 1)
	go func() {
		defer func() { queueDetailsActive.Delete(name); gate.Store(false) }()
		namePtr, err := syscall.UTF16PtrFromString(name)
		if err != nil {
			done <- detailResult{err: fmt.Errorf("encode queue name %q: %w", name, err)}
			return
		}
		var hPrinter syscall.Handle
		ret, _, lastErr := procOpenPrinterW.Call(
			uintptr(unsafe.Pointer(namePtr)),
			uintptr(unsafe.Pointer(&hPrinter)),
			0,
		)
		if ret == 0 {
			done <- detailResult{err: fmt.Errorf("OpenPrinterW(%q) failed: %w", name, lastErr)}
			return
		}
		defer procClosePrinter.Call(uintptr(hPrinter))

		pi, keep, err := getPrinterInfo2(hPrinter)
		if err == nil && pi == nil {
			err = fmt.Errorf("GetPrinterW(%q) returned no PRINTER_INFO_2", name)
		}
		if err != nil {
			done <- detailResult{err: err}
			return
		}
		detail := queueDetails{
			portName:   utf16PtrToString(pi.pPortName),
			driverName: utf16PtrToString(pi.pDriverName),
			serverName: utf16PtrToString(pi.pServerName),
			shareName:  utf16PtrToString(pi.pShareName),
			status:     pi.Status,
			attributes: pi.Attributes,
		}
		runtime.KeepAlive(keep)
		done <- detailResult{detail: detail}
	}()

	timer := time.NewTimer(queueDetailTimeout)
	defer timer.Stop()
	select {
	case r := <-done:
		return r.detail, r.err
	case <-timer.C:
		return queueDetails{}, fmt.Errorf("queue detail for %q exceeded %v (spooler RPC stalled)", name, queueDetailTimeout)
	}
}

// currentProcessSessionID distinguishes a Windows service session (Session 0)
// from an interactive desktop session. PRINTER_ENUM_CONNECTIONS is scoped to
// the calling user, so an interactive user's remote connection must never be
// persisted as if the LocalSystem service had proved it executable.
func currentProcessSessionID() (uint32, error) {
	var sessionID uint32
	ret, _, callErr := procProcessIDSession.Call(
		uintptr(uint32(os.Getpid())),
		uintptr(unsafe.Pointer(&sessionID)),
	)
	if ret == 0 {
		if errno, ok := callErr.(syscall.Errno); ok && errno == 0 {
			callErr = syscall.EINVAL
		}
		return 0, fmt.Errorf("ProcessIdToSessionId failed: %w", callErr)
	}
	return sessionID, nil
}

// markInteractiveUserConnectionsCandidateOnly keeps per-user Windows printer
// connections visible as discovery evidence but prevents them from entering
// the shared ProgramData runtime registry used by the Session-0 service. A
// service account's own Session-0 connection remains eligible.
func markInteractiveUserConnectionsCandidateOnly(infos []DeviceInfo, sessionID uint32) int {
	if sessionID == 0 {
		return 0
	}
	marked := 0
	for i := range infos {
		scope, _ := infos[i].Capabilities["spooler_scope"].(string)
		if scope != "user_connection" {
			continue
		}
		caps := make(map[string]interface{}, len(infos[i].Capabilities)+3)
		for key, value := range infos[i].Capabilities {
			caps[key] = value
		}
		caps["verification"] = "candidate_only"
		caps["candidate_reason"] = "per_user_spooler_connection"
		caps["runtime_scope"] = "interactive_session_discovery_only"
		infos[i].Capabilities = caps
		marked++
	}
	return marked
}

// EnumSpoolerPrinters enumerates installed Windows print queues.
//
// Strategy, in order of authority:
//  1. EnumPrintersW level 4 for the queue list (fast, never opens a queue).
//  2. A bounded GetPrinterW level 2 per queue for port, driver and status.
//  3. The registry as a last resort, so a stopped/unreachable spooler still
//     yields the queue names an operator can act on.
//
// A queue whose details cannot be read is still reported — with an
// "unknown" status rather than a fabricated "online" — because EnumPrinters
// proved it exists.
func EnumSpoolerPrinters() ([]DeviceInfo, error) {
	infos, err := enumerateSpoolerPrintersWindows()
	if sessionID, sessionErr := currentProcessSessionID(); sessionErr != nil {
		err = errors.Join(err, fmt.Errorf("read discovery session: %w", sessionErr))
	} else if marked := markInteractiveUserConnectionsCandidateOnly(infos, sessionID); marked > 0 {
		err = errors.Join(err, discoveryDiagnosticf("%d per-user Windows printer connection(s) were discovered in interactive Session %d and kept discovery-only; the Session-0 Agent service cannot assume those user-scoped queues or credentials are available", marked, sessionID))
	}
	// EnumPrinters CONNECTIONS is scoped to the calling account, not the
	// interactive desktop. Surface the limitation in the discovery report.
	token, tokenErr := windows.OpenCurrentProcessToken()
	if tokenErr != nil {
		return infos, errors.Join(err, fmt.Errorf("read discovery account: %w", tokenErr))
	}
	defer token.Close()
	user, userErr := token.GetTokenUser()
	if userErr != nil {
		return infos, errors.Join(err, fmt.Errorf("read discovery account SID: %w", userErr))
	}
	if user.User.Sid.String() == "S-1-5-18" {
		err = errors.Join(err, discoveryDiagnosticf("LocalSystem printer discovery cannot see interactive users' per-user connections; install shared queues for this service account/machine or run the service under the authorized print account"))
	}
	return infos, err
}

func enumerateSpoolerPrintersWindows() ([]DeviceInfo, error) {
	log.Printf("[discovery] starting Windows spooler discovery (EnumPrintersW level 4 + bounded GetPrinterW level 2)")

	queues, enumErr := enumPrinterQueues()
	if len(queues) == 0 && enumErr != nil {
		log.Printf("[discovery] EnumPrintersW unusable (%v) — falling back to registry", enumErr)
		infos, regErr := fallbackRegistryPrinters()
		return infos, errors.Join(enumErr, regErr)
	}
	if enumErr != nil {
		log.Printf("[discovery] EnumPrintersW returned partial queue inventory: %v", enumErr)
	}
	if len(queues) == 0 {
		// An empty answer is only trustworthy if the registry agrees: a
		// spooler that silently returned nothing must not make real
		// printers disappear from the inventory.
		if reg, regErr := fallbackRegistryPrinters(); regErr == nil && len(reg) > 0 {
			log.Printf("[discovery] EnumPrintersW returned no queues but the registry lists %d — using the registry", len(reg))
			return reg, nil
		}
		log.Printf("[discovery] spooler discovery found no queues")
		return nil, nil
	}

	deadline := time.Now().Add(queueDetailBudget)
	out := make([]DeviceInfo, 0, len(queues))
	unreadable := 0
	for _, q := range queues {
		name := q.name
		if name == "" {
			continue
		}

		var (
			portName, driverName, serverName, shareName string
			status, attributes                          uint32
			statusText                                  string
		)
		switch {
		case !time.Now().Before(deadline):
			// Out of detail budget: keep the queue with what EnumPrinters
			// proved (its name and attributes) instead of dropping it.
			unreadable++
			attributes = q.attributes
			serverName = q.server
			statusText = "unknown"
		default:
			detail, derr := queueDetail(name)
			if derr != nil {
				unreadable++
				log.Printf("[discovery] queue detail unreadable for %q: %v", name, derr)
				attributes = q.attributes
				serverName = q.server
				statusText = "unknown"
			} else {
				portName, driverName = detail.portName, detail.driverName
				serverName, shareName = detail.serverName, detail.shareName
				if serverName == "" {
					serverName = q.server
				}
				status, attributes = detail.status, detail.attributes
				statusText = mapWindowsStatus(status, attributes)
			}
		}

		if isVirtualSpooler(portName, driverName, name) {
			log.Printf("[discovery] hiding virtual Windows spooler queue %q (port=%q driver=%q)", name, portName, driverName)
			continue
		}
		info := spoolerQueueDeviceInfo(name, portName, driverName, serverName, shareName, statusText, attributes)
		info.Capabilities["spooler_scope"] = q.scope
		out = append(out, info)
	}
	log.Printf("[discovery] spooler discovery completed: %d queues (%d with unreadable details)", len(out), unreadable)
	if unreadable > 0 {
		return out, errors.Join(enumErr, discoveryDiagnosticf("%d spooler queues have unreadable details; queue identities were retained", unreadable))
	}
	return out, enumErr
}

// spoolerDeviceInfo keeps queue transport identity in first-class DeviceInfo
// fields as well as the legacy capability bag. Stable-ID generation and
// registry rename reconciliation consume the top-level fields; capabilities
// alone are informational and must not be the identity source of truth.
func spoolerDeviceInfo(name, portName, driverName, statusText string, attributes uint32) DeviceInfo {
	return spoolerQueueDeviceInfo(name, portName, driverName, "", "", statusText, attributes)
}

// spoolerQueueDeviceInfo keeps queue transport identity in first-class
// DeviceInfo fields as well as the legacy capability bag. Stable-ID
// generation and registry rename reconciliation consume the top-level
// fields; capabilities alone are informational and must not be the identity
// source of truth. serverName/shareName come from PRINTER_INFO_2 (with the
// PRINTER_INFO_4 server as fallback) so separate queues on the same
// port/driver keep distinct identities.
func spoolerQueueDeviceInfo(name, portName, driverName, serverName, shareName, statusText string, attributes uint32) DeviceInfo {
	printerType, connectionType := classifySpoolerPrinter(portName, driverName, name)
	return DeviceInfo{
		Name:           name,
		Protocol:       "spooler",
		ConnectionType: connectionType,
		PrinterType:    printerType,
		Endpoint:       name,
		SpoolerName:    name,
		SpoolerPort:    portName,
		SpoolerDriver:  driverName,
		SpoolerServer:  serverName,
		SpoolerShare:   shareName,
		Status:         statusText,
		Capabilities: map[string]interface{}{
			"discovered_via":     SourceSpooler,
			"port_name":          portName,
			"driver_name":        driverName,
			"server_name":        serverName,
			"share_name":         shareName,
			"spooler_attributes": attributes,
		},
	}
}
