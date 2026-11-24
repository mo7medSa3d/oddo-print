package printer

import (
	"context"
	"testing"
)

// reporterPrinter is a test-only Printer that reports a platform job ID.
type reporterPrinter struct{ id string }

func (r *reporterPrinter) Print(ctx context.Context, data []byte) error { return nil }

func (r *reporterPrinter) Test(ctx context.Context) error { return nil }

func (r *reporterPrinter) Status() string { return "online" }

func (r *reporterPrinter) LastSpoolerJobID() string { return r.id }

// silentPrinter implements Printer WITHOUT the optional reporter
// interface, like the network/USB/IPP backends.
type silentPrinter struct{}

func (s *silentPrinter) Print(ctx context.Context, data []byte) error { return nil }

func (s *silentPrinter) Test(ctx context.Context) error { return nil }

func (s *silentPrinter) Status() string { return "online" }

// The SpoolerJobIDOf helper is pure dispatch logic: a reporter yields its
// ID, anything else (including the non-Windows stub, which can never reach
// a real spooler) yields "". No Win32 involved, runs everywhere.
func TestSpoolerJobIDOfReporter(t *testing.T) {
	if got := SpoolerJobIDOf(&reporterPrinter{id: "456"}); got != "456" {
		t.Fatalf("reporter must yield its platform job ID, got %q", got)
	}
}

func TestSpoolerJobIDOfNonReporter(t *testing.T) {
	if got := SpoolerJobIDOf(&silentPrinter{}); got != "" {
		t.Fatalf("non-reporter must yield no platform job ID, got %q", got)
	}
}

func TestStubSpoolerReportsNoJobID(t *testing.T) {
	p := NewSpooler("NoSuchQueue", "")
	if got := p.LastSpoolerJobID(); got != "" {
		t.Fatalf("stub backend must report no spooler job ID, got %q", got)
	}
	if got := SpoolerJobIDOf(p); got != "" {
		t.Fatalf("SpoolerJobIDOf(stub) must be empty, got %q", got)
	}
}
