package agent

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// resolveLocalPrinter is the identity today: every printer type is
// configured entirely by its own record, with no local profile
// resolution step. It stays as the single funnel for desired-state and
// discovery configs so a future local-resolution rule lands in one
// place instead of at every call site.
func (a *Agent) resolveLocalPrinter(pc config.PrinterConfig) (config.PrinterConfig, error) {
	return pc, nil
}

// Read-only generation fence after a potentially slow OS/protocol query.
// The lock order matches desired-state application and identity persistence.
func (a *Agent) printerObservationCurrent(id string, backend printer.Printer, expected config.PrinterConfig) bool {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	return a.identityGenerationCurrentLocked(id, expected, backend)
}

// verifyPrinterForDispatch is the dispatch-time fence, and it performs NO
// live probe and NO driver measurement. Operational verification is
// background evidence: the heartbeat probe loop refreshes it on its own
// cycle, and a failed or slow measurement must never refuse a print job —
// that failure mode badged healthy printers as unusable while Windows
// reported them ready. What remains here are hard configuration facts
// that make printing to this destination wrong regardless of any
// measurement:
//
//   - an unresolved identity collision (two devices claim one identity);
//   - a printer the current inventory says is gone;
//   - a destination binding that PROVABLY changed after the job was
//     admitted (checked only when the job carries a valid digest and the
//     current digest can be computed — both are local hashes, no I/O);
//   - a configuration change mid-dispatch (the generation fence).
//
// A stale, failed, or never-completed verification is logged as an
// advisory and the job proceeds. Real device errors (offline queue,
// paper out, missing tray) still fail the job at the physical attempt
// itself, with the printer's own explicit reason.
func (a *Agent) verifyPrinterForDispatch(ctx context.Context, id string, backend printer.Printer, expected config.PrinterConfig, admittedBinding string) error {
	if expected.Capabilities["identity_collision"] != nil {
		return fmt.Errorf("%w: printer identity requires explicit reconciliation", printer.ErrPrinterUnverified)
	}
	if expected.Capabilities["inventory_present"] == false {
		return fmt.Errorf("%w: printer is no longer present in the Agent inventory", printer.ErrPrinterUnverified)
	}
	if validAdmissionBinding(admittedBinding) {
		current, err := config.PrinterBindingDigest(expected)
		if err != nil {
			return fmt.Errorf("%w: invalid configured destination: %v", printer.ErrPrinterUnverified, err)
		}
		if current != admittedBinding {
			return fmt.Errorf("%w: current destination differs from the accepted job", printer.ErrPrinterUnverified)
		}
	}
	if !a.printerObservationCurrent(id, backend, expected) {
		return fmt.Errorf("%w: printer configuration changed during dispatch checks", printer.ErrPrinterUnverified)
	}
	if a.observations != nil {
		if advisory := a.observations.verificationAdvisory(id, time.Now()); advisory != "" {
			log.Printf("Job dispatch advisory for printer %s: %s; proceeding — operational verification is background evidence, not a print gate", id, advisory)
		}
	}
	return nil
}

func validAdmissionBinding(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
