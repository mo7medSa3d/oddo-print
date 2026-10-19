//go:build !windows

package printer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSimulatedTransportKeepsDiagnosticFilesWithoutPrinterSuccess(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT", "1")
	usb := &USBPrinter{DevicePath: filepath.Join(dir, "usb.prn")}
	spooler := NewSpooler("diagnostic", "Diagnostic")
	for _, tc := range []struct {
		name  string
		print func() error
	}{
		{"usb", func() error { return usb.Print(context.Background(), []byte("receipt")) }},
		{"spooler_raw", func() error { return spooler.Print(context.Background(), []byte("receipt")) }},
		{"spooler_pdf", func() error {
			return spooler.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.print(); err == nil || !strings.Contains(err.Error(), "SIMULATED_TRANSPORT") || OutcomeUnknown(err) {
				t.Fatalf("file-only diagnostic became physical submission success or ambiguity: %v", err)
			}
		})
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 3 {
		t.Fatalf("diagnostic artifacts were removed: files=%v error=%v", files, err)
	}
	if usb.Status() != "unknown" || spooler.Status() != "unknown" {
		t.Fatal("simulation invented physical readiness")
	}
}

func TestSimulationRespectsCancellationAndAdmissionBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT", "1")
	refusal := errors.New("retired before diagnostic write")
	ctx := WithDispatchAdmission(context.Background(), func(context.Context) error { return refusal })
	usb := &USBPrinter{DevicePath: filepath.Join(dir, "usb.prn")}
	spooler := NewSpooler("diagnostic", "Diagnostic")
	for _, err := range []error{usb.Print(ctx, []byte("receipt")), spooler.Print(ctx, []byte("receipt")), spooler.PrintDocument(ctx, Document{Kind: KindPDF, Data: validTestPDFBytes()})} {
		if !errors.Is(err, refusal) {
			t.Fatalf("diagnostic write bypassed admission: %v", err)
		}
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := spooler.PrintDocument(cancelled, Document{Kind: KindPDF, Data: validTestPDFBytes()}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled PDF diagnostic was written: %v", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 0 {
		t.Fatalf("refused diagnostic wrote files: %v %v", files, err)
	}
}
