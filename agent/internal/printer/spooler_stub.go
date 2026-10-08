//go:build !windows

package printer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// SpoolerPrinter is a NON-Windows stand-in. There is no Windows print
// subsystem here, so the truthful answer is a failure that says so. A
// simulated write to a file is ONLY performed when an operator explicitly
// sets ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1 (development/diagnostic
// mode); by default nothing pretends to have printed.
type SpoolerPrinter struct {
	Name              string
	SpoolerName       string
	ReceiptPaperMM    int
	ReceiptRasterDots int
	ReceiptDPI        int
	PDFPrint          PDFPrintFunc
	ProbeFunc         func(spoolerName string) string
	Timeout           time.Duration
}

func simulatedTransportAllowed() bool {
	return os.Getenv("ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT") == "1"
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter {
	name := spoolerName
	if displayName != "" {
		name = displayName
	}
	return &SpoolerPrinter{Name: name, SpoolerName: spoolerName}
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
	if !simulatedTransportAllowed() {
		return fmt.Errorf("ERR_UNSUPPORTED_TRANSPORT: the Windows spooler backend cannot run on this OS; nothing was printed to %q", p.SpoolerName)
	}
	dir := os.TempDir()
	fpath := filepath.Join(dir, fmt.Sprintf("spooler_%s_%d.prn", sanitizeFilename(p.SpoolerName), time.Now().UnixNano()))
	if err := os.WriteFile(fpath, data, 0600); err != nil {
		return fmt.Errorf("simulated spooler write failed: %w", err)
	}
	return nil
}

func (p *SpoolerPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS, KindPDF, KindImage:
		return true
	default:
		return false
	}
}

// LastSpoolerJobID implements SpoolerJobIDReporter. The non-Windows stub
// never reaches a real spooler, so there is no platform identity to report.
func (p *SpoolerPrinter) LastSpoolerJobID() string { return "" }

func (p *SpoolerPrinter) PrintDocument(ctx context.Context, doc Document) error {
	switch NormalizeKind(doc.Kind) {
	case KindPDF:
		if !simulatedTransportAllowed() {
			return fmt.Errorf("ERR_UNSUPPORTED_TRANSPORT: the Windows spooler backend cannot run on this OS; nothing was printed to %q", p.SpoolerName)
		}
		if err := ValidatePDF(doc.Data); err != nil {
			return err
		}
		fpath := filepath.Join(os.TempDir(), fmt.Sprintf("spooler_%s_%d.pdf", sanitizeFilename(p.SpoolerName), time.Now().UnixNano()))
		if err := os.WriteFile(fpath, doc.Data, 0600); err != nil {
			return fmt.Errorf("simulated spooler PDF write failed: %w", err)
		}
		return nil
	case KindImage:
		var pdf []byte
		var err error
		if p.ReceiptPaperMM == 58 || p.ReceiptPaperMM == 80 {
			pdf, err = JPEGToPDFReceipt(doc.Data, p.ReceiptPaperMM, p.ReceiptRasterDots, p.ReceiptDPI)
		} else {
			pdf, err = JPEGToPDF(doc.Data)
		}
		if err != nil {
			return fmt.Errorf("render image for Windows spooler: %w", err)
		}
		return p.PrintDocument(ctx, Document{Kind: KindPDF, Data: pdf, JobID: doc.JobID})
	case KindRaw, KindESCPOS:
		return p.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("spooler printer %q cannot render %s payloads", p.SpoolerName, NormalizeKind(doc.Kind))
	}
}

// SpoolerProbe mirrors the Windows probe record on non-Windows platforms:
// the print subsystem is absent, so the verdict is honestly unavailable.
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

const (
	SpoolerReadyToAccept    = "SPOOLER_READY_TO_ACCEPT"
	SpoolerQueueUnavailable = "SPOOLER_QUEUE_UNAVAILABLE"
	SpoolerDriverError      = "SPOOLER_DRIVER_ERROR"
	SpoolerPortError        = "SPOOLER_PORT_ERROR"
	SpoolerStatusUnknown    = "SPOOLER_STATUS_UNKNOWN"
	SpoolerJobAccepted      = "SPOOLER_JOB_ACCEPTED"
	PhysicalOutcomeUnknown  = "PHYSICAL_OUTCOME_UNKNOWN"
)

// ProbeSpoolerQueue on non-Windows always reports the subsystem as absent.
func ProbeSpoolerQueue(spoolerName string) SpoolerProbe {
	return SpoolerProbe{
		QueueName:        spoolerName,
		OpenPrinterError: "Windows print subsystem unavailable on this OS",
		Verdict:          SpoolerQueueUnavailable,
		VerdictReason:    "no Windows spooler on this platform",
	}
}

func (p *SpoolerPrinter) Test(ctx context.Context) error {
	// Non-Windows stand-in: never pretend to have printed. A simulated write
	// happens only under the explicit development opt-in; otherwise fail
	// closed so CI/dev never masks a missing Windows path.
	if !simulatedTransportAllowed() {
		return fmt.Errorf("ERR_UNSUPPORTED_TRANSPORT: the Windows spooler backend cannot run on this OS; nothing was printed to %q", p.SpoolerName)
	}
	return p.Print(ctx, []byte("Spooler Test Print"))
}

func sanitizeFilename(s string) string {
	out := ""
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			out += string(r)
		}
	}
	if out == "" {
		return "printer"
	}
	return out
}

// Status runs an injected ProbeFunc under a bounded deadline (a wedged
// spooler RPC must never block the heartbeat) and recovers probe panics.
// With no probe available (this platform has no Windows print subsystem),
// the honest answer is UNREADABLE - not a healthy "online".
func (p *SpoolerPrinter) Status() string {
	if p.ProbeFunc != nil {
		timeout := p.Timeout
		if timeout <= 0 {
			timeout = 1500 * time.Millisecond
		}
		resCh := make(chan string, 1)
		go func() {
			defer func() {
				if r := recover(); r != nil {
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
			// Keep the non-Windows stand-in aligned with the Windows spooler
			// implementation: a spooler RPC timeout proves nothing about the
			// physical device, so report "unknown" — never a fabricated error.
			return "unknown"
		}
	}
	if simulatedTransportAllowed() {
		return "online"
	}
	return "unknown"
}
