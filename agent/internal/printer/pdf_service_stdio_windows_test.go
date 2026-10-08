//go:build windows

package printer

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/klippa-app/go-pdfium/requests"
)

// Windows Services have no guaranteed valid stdout/stderr handles. Run this
// regression in a subprocess, without destroying the parent test runner's IO.
func TestPDFiumWorkerWithoutConsoleHandles(t *testing.T) {
	const childEnv = "YASEIR_TEST_NO_STDIO_PDFIUM_CHILD"
	const resultEnv = "YASEIR_TEST_NO_STDIO_PDFIUM_RESULT"
	if os.Getenv(childEnv) == "1" {
		report := func(err error) {
			_ = os.WriteFile(os.Getenv(resultEnv), []byte(err.Error()), 0600)
			os.Exit(17)
		}
		// A closed os.File simulates the invalid standard handles an SCM-
		// launched process can inherit. No printer hardware is required.
		invalid, err := os.CreateTemp("", "yaseir-closed-stdio-*")
		if err != nil {
			report(fmt.Errorf("create invalid-handle fixture: %w", err))
		}
		_ = invalid.Close()
		_ = os.Remove(invalid.Name())
		os.Stdout = invalid
		os.Stderr = invalid

		pool, err := getPDFiumPool()
		if err != nil {
			report(fmt.Errorf("initialize PDFium without a console: %w", err))
		}
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		worker, err := pool.GetInstanceWithContext(ctx)
		if err != nil {
			report(fmt.Errorf("instantiate PDFium without a console: %w", err))
		}
		data := validPDF()
		pdf, err := worker.OpenDocument(&requests.OpenDocument{File: &data})
		if err != nil {
			report(fmt.Errorf("open embedded PDF: %w", err))
		}
		pages, err := worker.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: pdf.Document})
		if err != nil || pages.PageCount != 1 {
			report(fmt.Errorf("PDFium page count: %v, %v", pages, err))
		}
		_, _ = worker.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: pdf.Document})
		if err := worker.Close(); err != nil {
			report(fmt.Errorf("close PDFium worker: %w", err))
		}
		if err := os.WriteFile(os.Getenv(resultEnv), []byte("PDFIUM_HEADLESS_WORKER_OK"), 0600); err != nil {
			os.Exit(18)
		}
		os.Exit(0)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	resultFile := t.TempDir() + "\\headless_pdfium_result.txt"
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPDFiumWorkerWithoutConsoleHandles$")
	cmd.Env = append(os.Environ(), childEnv+"=1", resultEnv+"="+resultFile)
	output, err := cmd.CombinedOutput()
	result, _ := os.ReadFile(resultFile)
	if err != nil {
		t.Fatalf("PDFium WASM worker fails under service-like invalid stdout/stderr: %v; result=%s; child output=%s", err, result, output)
	}
	if strings.TrimSpace(string(result)) != "PDFIUM_HEADLESS_WORKER_OK" {
		t.Fatalf("headless PDFium worker did not report successful PDF open: %q", result)
	}
}
