package printer

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	pdfium "github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
)

// Regression coverage for the Windows Service PDFium failure:
//
//	acquire embedded PDFium worker:
//	could not instantiate webassembly module:
//	GetFileType /dev/stdout: The handle is invalid
//
// A Windows Service launched by the SCM (and the Agent's desktop manager when
// started without a console) has no valid stdout/stderr handles. go-pdfium
// replaces nil stream writers with os.Stdout/os.Stderr, and wazero then stats
// the underlying handle, so instantiation fails before a single page renders.
//
// These checks are intentionally platform-independent. The PDFium pool is an
// embedded WebAssembly module executed by wazero, which is pure Go with no
// Win32 dependency, so the same policy and the same failure mode are
// reproducible on any GOOS. On Windows the subprocess additionally exercises
// the production getPDFiumPool path; on other hosts it exercises the identical
// shared configuration built by newPDFiumPoolConfig.

const (
	pdfiumChildEnv  = "YASEIR_TEST_HEADLESS_PDFIUM_CHILD"
	pdfiumResultEnv = "YASEIR_TEST_HEADLESS_PDFIUM_RESULT"
	// Second stage marker: the pool was also re-usable after a killed worker.
	pdfiumChildRecoveryMarker = "HEADLESS_PDFIUM_RECOVERY_OK"
)

// invalidStdHandle returns an *os.File whose handle is closed and unlinked, so
// any stat/GetFileType against it fails exactly as it does for an SCM service
// that inherited no standard handles.
func invalidStdHandle(t *testing.T) *os.File {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "yaseir-invalid-stdio-*")
	if err != nil {
		t.Fatalf("create invalid-handle fixture: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close invalid-handle fixture: %v", err)
	}
	if err := os.Remove(f.Name()); err != nil {
		t.Fatalf("remove invalid-handle fixture: %v", err)
	}
	return f
}

// TestPDFiumPoolConfigNeverUsesProcessStreams is the static half of the
// contract: a nil writer would silently become os.Stdout/os.Stderr and break
// every worker under a headless service.
func TestPDFiumPoolConfigNeverUsesProcessStreams(t *testing.T) {
	cfg := newPDFiumPoolConfig()
	if cfg.Stdout == nil || cfg.Stderr == nil {
		t.Fatalf("embedded PDFium pool must not use nil stream writers (go-pdfium substitutes os.Stdout/os.Stderr); got stdout=%T stderr=%T", cfg.Stdout, cfg.Stderr)
	}
	if cfg.Stdout != io.Discard || cfg.Stderr != io.Discard {
		t.Fatalf("embedded PDFium stream writers must be io.Discard (wazero's own default configures no guest fd); got stdout=%T stderr=%T", cfg.Stdout, cfg.Stderr)
	}
	if cfg.RuntimeConfig == nil {
		t.Fatal("embedded PDFium pool requires an explicit RuntimeConfig: the bundled module needs CoreFeaturesExceptionHandling for setjmp/longjmp")
	}
	if cfg.MaxTotal != pdfiumMaxTotal || pdfiumMaxTotal != 1 {
		t.Fatalf("embedded PDFium pool must stay bounded to a single worker (memory + shared-renderer safety); MaxTotal=%d", cfg.MaxTotal)
	}
}

// openAndCountPages opens a real PDF and returns its page count, proving the
// worker is genuinely usable rather than merely instantiated.
func openAndCountPages(worker pdfium.Pdfium) (int, error) {
	data := validPDF()
	doc, err := worker.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return 0, err
	}
	defer worker.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})
	pages, err := worker.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return 0, err
	}
	if pages == nil || pages.PageCount < 1 {
		return 0, fmt.Errorf("PDFium reported no printable pages")
	}
	return pages.PageCount, nil
}

// headlessPDFiumChild reproduces the service's invalid standard handles and
// verifies the renderer still initializes, renders, and recovers. It writes
// its outcome to a file so the parent does not depend on the child's broken
// stdio.
func headlessPDFiumChild(t *testing.T, resultPath string) {
	report := func(err error) {
		_ = os.WriteFile(resultPath, []byte(err.Error()), 0600)
		os.Exit(17)
	}

	// Simulate the invalid standard handles an SCM-launched process inherits.
	invalid := invalidStdHandle(t)
	os.Stdout = invalid
	os.Stderr = invalid

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var (
		pool   pdfium.Pool
		worker pdfium.Pdfium
		err    error
	)
	if runtime.GOOS == "windows" {
		// Exercise the real production pool, including its sync.Once caching.
		if pool, err = getPDFiumPool(); err != nil {
			report(fmt.Errorf("initialize embedded PDFium without a console: %w", err))
		}
	} else {
		if pool, err = webassembly.Init(newPDFiumPoolConfig()); err != nil {
			report(fmt.Errorf("initialize embedded PDFium without a console: %w", err))
		}
	}

	// Stage 1: build a worker and open a real PDF with no valid stdio.
	if worker, err = pool.GetInstanceWithContext(ctx); err != nil {
		report(fmt.Errorf("acquire embedded PDFium worker without a console: %w", err))
	}
	if _, err = openAndCountPages(worker); err != nil {
		report(fmt.Errorf("open embedded PDF without a console: %w", err))
	}
	if err = worker.Close(); err != nil {
		report(fmt.Errorf("close first embedded PDFium worker: %w", err))
	}

	// Stage 2: a cancelled job kills its worker. Prove the pool still
	// renders afterwards, so one abandoned job cannot disable the Agent's
	// renderer until the service is restarted. Killing is also the path that
	// used to log a misleading "already closed" worker-cleanup error.
	if worker, err = pool.GetInstanceWithContext(ctx); err != nil {
		report(fmt.Errorf("re-acquire embedded PDFium worker: %w", err))
	}
	if _, err = openAndCountPages(worker); err != nil {
		report(fmt.Errorf("re-open embedded PDF: %w", err))
	}
	var killed pdfiumKillTracker
	killed.kill(worker)
	if err = killed.close(worker); err != nil {
		report(fmt.Errorf("cleanup after killing embedded PDFium worker was reported as a failure: %w", err))
	}
	recovered, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		report(fmt.Errorf("embedded PDFium pool did not replace its killed worker: %w", err))
	}
	if _, err = openAndCountPages(recovered); err != nil {
		report(fmt.Errorf("render after a killed PDFium worker: %w", err))
	}
	if err = recovered.Close(); err != nil {
		report(fmt.Errorf("close recovered embedded PDFium worker: %w", err))
	}

	_ = os.WriteFile(resultPath, []byte(pdfiumChildRecoveryMarker), 0600)
}

// TestPDFiumWorkerWithoutConsoleHandles runs the headless scenario in a
// subprocess, because the parent test runner must keep its own intact
// standard handles.
func TestPDFiumWorkerWithoutConsoleHandles(t *testing.T) {
	if os.Getenv(pdfiumChildEnv) == "1" {
		headlessPDFiumChild(t, os.Getenv(pdfiumResultEnv))
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()

	resultPath := filepath.Join(t.TempDir(), "headless_pdfium_result.txt")
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPDFiumWorkerWithoutConsoleHandles$", "-test.v")
	cmd.Env = append(os.Environ(), pdfiumChildEnv+"=1", pdfiumResultEnv+"="+resultPath)
	output, err := cmd.CombinedOutput()
	result, _ := os.ReadFile(resultPath)
	if err != nil {
		t.Fatalf("embedded PDFium fails under service-like invalid stdout/stderr: %v\nchild result=%s\nchild output=%s", err, result, output)
	}
	if got := strings.TrimSpace(string(result)); got != pdfiumChildRecoveryMarker {
		t.Fatalf("headless PDFium worker did not complete the headless and worker-recovery scenarios: %q\nchild output=%s", got, output)
	}
}
