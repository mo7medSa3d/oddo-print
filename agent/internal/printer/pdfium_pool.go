package printer

import (
	"context"
	"io"
	"sync"

	pdfium "github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/webassembly"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
)

// Embedded PDFium pool configuration.
//
// This file is deliberately platform-independent: the pool is pure Go (an
// embedded WebAssembly module run by wazero) and has no Win32 dependency, so
// the headless-execution policy it encodes can be compiled and exercised on
// any supported GOOS. Keeping the policy in one place also means every
// PDFium consumer (Windows spooler PDF printing, IPP PWG Raster, IPP JPEG
// fallback) inherits the same configuration instead of re-deriving it.
//
// Production sizing: one PDFium worker. This both bounds resident memory and
// serializes rendering so concurrent PDF jobs cannot overlap on shared
// renderer state. Job-level admission is enforced by embeddedPDFPrintSlot;
// this constant only governs the WASM worker pool beneath it.
const (
	maxPDFPages        = 500
	pdfiumMinIdle      = 0
	pdfiumMaxIdle      = 1
	pdfiumMaxTotal     = 1
	pdfiumReuseWorkers = true
)

var (
	pdfiumInitMu sync.Mutex
	pdfiumPool   pdfium.Pool
	// Shared by native GDI and portable IPP preflight/rendering. Acquisition
	// must use a context-aware select; never wait indefinitely on a mutex.
	embeddedPDFPrintSlot = make(chan struct{}, 1)
)

func getPDFiumPool() (pdfium.Pool, error) {
	pdfiumInitMu.Lock()
	defer pdfiumInitMu.Unlock()
	if pdfiumPool != nil {
		return pdfiumPool, nil
	}
	// Only a successful initialization is latched. A transient first
	// failure (module compile under memory pressure, a briefly missing
	// runtime file) must not disable PDF rendering for the whole
	// process lifetime — the next job retries initialization.
	pool, err := webassembly.Init(newPDFiumPoolConfig())
	if err != nil {
		return nil, err
	}
	pdfiumPool = pool
	return pdfiumPool, nil
}

// getPDFiumPoolWithContext keeps synchronous module compilation behind the
// shared, context-bounded warmup flight so a canceled print cannot wait on
// the initialization mutex until a cold WASM runtime finishes compiling.
func getPDFiumPoolWithContext(ctx context.Context) (pdfium.Pool, error) {
	if err := awaitPDFiumWarmup(ctx); err != nil {
		return nil, err
	}
	return getPDFiumPool()
}

// pdfiumRuntimeConfig returns the wazero runtime configuration required by
// the bundled PDFium module.
//
// The pinned PDFium WASM lowers setjmp/longjmp to WebAssembly exception
// handling instructions, so CoreFeaturesExceptionHandling is mandatory: a
// configuration that omits it makes PDFium fail to compile/instantiate.
// WithCloseOnContextDone(true) lets pdfiumInstance.Kill() interrupt an
// in-flight worker, which the renderer relies on for cancellation.
func pdfiumRuntimeConfig() wazero.RuntimeConfig {
	return wazero.NewRuntimeConfig().
		WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
		WithCloseOnContextDone(true)
}

// pdfiumStreamWriters returns the stdout/stderr sinks for the PDFium WASM
// module.
//
// These are NEVER nil. go-pdfium's webassembly.Init replaces a nil writer
// with os.Stdout/os.Stderr before handing it to wazero:
//
//	if config.Stdout == nil { config.Stdout = os.Stdout }
//
// wazero then stats the writer's underlying file to decide how to serve
// guest fd 1/2. A Windows Service launched by the SCM has no valid stdout or
// stderr handle, so that stat fails and every worker instantiation aborts
// with:
//
//	could not instantiate webassembly module:
//	GetFileType /dev/stdout: The handle is invalid
//
// On POSIX hosts the same defect surfaces as a stat on a closed file, so the
// failure is reproducible and testable off Windows.
//
// io.Discard is also wazero's own documented default for these fields, so it
// configures no guest file descriptor at all: no console is spawned, no
// handle is inherited, and nothing is written. PDFium reports results and
// errors exclusively through its API, never through a process console, and
// Agent diagnostics go through the structured logger instead.
func pdfiumStreamWriters() (io.Writer, io.Writer) {
	return io.Discard, io.Discard
}

// newPDFiumPoolConfig builds the single configuration used to construct the
// process-wide PDFium pool.
func newPDFiumPoolConfig() webassembly.Config {
	stdout, stderr := pdfiumStreamWriters()
	return webassembly.Config{
		MinIdle:       pdfiumMinIdle,
		MaxIdle:       pdfiumMaxIdle,
		MaxTotal:      pdfiumMaxTotal,
		ReuseWorkers:  pdfiumReuseWorkers,
		RuntimeConfig: pdfiumRuntimeConfig(),
		FSConfig:      wazero.NewFSConfig(),
		// Explicit, headless-safe: never default to the service's
		// (possibly invalid) standard handles.
		Stdout: stdout,
		Stderr: stderr,
	}
}

// pdfiumKillTracker records that a borrowed PDFium worker was killed to
// interrupt an in-flight render.
//
// pdfiumInstance.Kill() closes the instance and invalidates it in the worker
// pool, so a subsequent Close returns "instance is already closed". That is
// expected cancellation cleanup, not a worker-cleanup failure. Without this
// tracker every cancelled or timed-out PDF job logs a misleading worker-close
// error, which hides genuine worker-close failures in the Agent log.
//
// Killing is also idempotent here: go-pdfium's Kill does not guard against a
// second call, and the render path can reach it more than once per job.
type pdfiumKillTracker struct {
	killed bool
}

// kill interrupts the worker and remembers that it is no longer closeable.
func (k *pdfiumKillTracker) kill(instance pdfium.Pdfium) {
	if k == nil || instance == nil || k.killed {
		return
	}
	k.killed = true
	_ = instance.Kill()
}

// close releases the worker, treating a killed worker as already released.
func (k *pdfiumKillTracker) close(instance pdfium.Pdfium) error {
	if k == nil || instance == nil || k.killed {
		return nil
	}
	return instance.Close()
}
