package printer

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

// PDF printing.
//
// PDFs are rendered by the embedded PDFium backend on Windows. The renderer
// produces one bounded bitmap at a time and the Windows backend submits each
// page through a Windows printer device context. There is deliberately no
// shell, file association, external PDF application, or runtime download in
// the production path.
//
// A path-based callback remains as a dependency-injection seam for tests and
// platform-specific implementations. Production passes nil and therefore
// selects platformPrintPDF.
const (
	pdfHeaderMarker = "%PDF-"
	pdfEOFMarker    = "%%EOF"

	// %%EOF is the last token of a well-formed PDF; some writers append a few
	// bytes of padding/newlines after it.
	pdfEOFSearchWindow = 4096

	// Fallback when no renderer deadline was assigned by the caller.
	// A deliberate caller budget remains authoritative.
	defaultPDFPrintTimeout = 120 * time.Second
)

type PDFPrintFunc func(ctx context.Context, printerName, pdfPath string) error

// PDFPrintResultFunc is the result-bearing form used by platform paths that
// can return a durable spooler identity. An empty job ID is valid for
// transports that cannot expose one.
type PDFPrintResultFunc func(ctx context.Context, printerName, pdfPath string) (string, error)

func ValidatePDF(data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty PDF payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("PDF payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}
	if !bytes.HasPrefix(data, []byte(pdfHeaderMarker)) {
		return fmt.Errorf("payload is not a PDF document (missing %s header)", pdfHeaderMarker)
	}
	tail := data
	if len(tail) > pdfEOFSearchWindow {
		tail = tail[len(tail)-pdfEOFSearchWindow:]
	}
	if !bytes.Contains(tail, []byte(pdfEOFMarker)) {
		return fmt.Errorf("truncated or malformed PDF document (missing %s trailer)", pdfEOFMarker)
	}
	return nil
}

func ValidatePDFPrinterName(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("printer name is empty")
	}
	if len(name) > 220 {
		return fmt.Errorf("printer name is too long (%d bytes)", len(name))
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("printer name contains a control character (0x%02x)", r)
		}
	}
	if strings.ContainsAny(name, "\"") {
		return fmt.Errorf("printer name contains a quote character, which is not a valid Windows printer name")
	}
	return nil
}

func writeSecurePDFTemp(data []byte) (string, func(), error) {
	dir, err := os.MkdirTemp("", "odoo-print-pdf-")
	if err != nil {
		return "", func() {}, fmt.Errorf("create temp dir for PDF: %w", err)
	}
	// Harden ownership/DACL, not just mode bits: Go's Chmod on Windows only
	// toggles the read-only flag and never restricts which users can read
	// the rendered document. The shared storage helper applies a protected
	// DACL with secure ownership on Windows and 0700 on POSIX.
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		os.RemoveAll(dir)
		return "", func() {}, fmt.Errorf("secure temp PDF directory: %w", err)
	}
	cleanup := func() {
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("WARNING: failed to remove temporary PDF directory %s: %v", dir, err)
		}
	}

	f, err := os.CreateTemp(dir, "job-*.pdf")
	if err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("create temp PDF file: %w", err)
	}
	path := f.Name()
	if err := config.EnsureSecureFileACL(path); err != nil {
		_ = f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("restrict temp PDF permissions: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("write temp PDF: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("flush temp PDF: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("close temp PDF: %w", err)
	}
	return path, cleanup, nil
}

// printPDFWithResult preserves the assigned renderer deadline and cancellation,
// using a 120-second fallback only without a deadline. The result-bearing
// callback lets Windows propagate StartDocW's spooler job identifier without
// changing the generic Printer interface.
func printPDFWithResult(ctx context.Context, printerName string, doc Document, printFn PDFPrintResultFunc) (string, error) {
	if err := ValidatePDF(doc.Data); err != nil {
		return "", err
	}
	if err := ValidatePDFPrinterName(printerName); err != nil {
		return "", fmt.Errorf("refusing to print PDF: %w", err)
	}
	if printFn == nil {
		return "", fmt.Errorf("PDF print result function is nil")
	}

	path, cleanup, err := writeSecurePDFTemp(doc.Data)
	if err != nil {
		return "", err
	}
	defer cleanup()

	var printCtx context.Context
	var cancel context.CancelFunc
	if _, assigned := ctx.Deadline(); assigned {
		printCtx, cancel = context.WithCancel(ctx)
	} else {
		printCtx, cancel = context.WithTimeout(ctx, defaultPDFPrintTimeout)
	}
	defer cancel()

	spoolerJobID, err := printFn(printCtx, printerName, path)
	if err != nil {
		// Once Windows has allocated a spooler job identity, a later error
		// cannot honestly prove that no physical output occurred. Preserve
		// the identity and force UNKNOWN semantics unless the lower layer
		// already supplied a stronger unknown-outcome marker. This is the
		// final duplicate-prevention fence for renderer/cleanup failures.
		if spoolerJobID != "" && !OutcomeUnknown(err) {
			err = MarkUnknown("Windows spooler job %s was allocated before a later PDF failure; physical outcome is unknown: %v", spoolerJobID, err)
		}
		return spoolerJobID, fmt.Errorf("PDF print on %q failed: %w", printerName, err)
	}
	log.Printf("PDF job %s (%d bytes) submitted to printer %q via embedded PDFium path", doc.JobID, len(doc.Data), printerName)
	return spoolerJobID, nil
}

// PrintPDF preserves the public/test callback contract. Production callers
// that need a spooler job ID use printPDFWithResult with the platform result
// callback instead.
func PrintPDF(ctx context.Context, printerName string, doc Document, printFn PDFPrintFunc) error {
	if printFn == nil {
		printFn = platformPrintPDF
	}
	_, err := printPDFWithResult(ctx, printerName, doc, func(callCtx context.Context, name, path string) (string, error) {
		return "", printFn(callCtx, name, path)
	})
	return err
}
