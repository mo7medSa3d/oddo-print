package agent

import (
	"fmt"
	"strings"

	"github.com/yaseir-agent/agent/internal/printer"
)

// isPrinterExecutionAllowed checks local registration and an explicit local
// disable/visibility setting only. It never probes or certifies hardware.
func (a *Agent) isPrinterExecutionAllowed(printerID string) bool {
	if !printer.ValidPrinterID(printerID) {
		return false
	}
	a.printersMu.RLock()
	pc, present := a.printerConfigs[printerID]
	_, backendPresent := a.printers[printerID]
	a.printersMu.RUnlock()
	if !present || !backendPresent || a.localPrinterBindingDisabled(pc) {
		return false
	}
	return a.isPrinterAvailableToOdoo(printerID)
}

func (a *Agent) isOdooManaged(id string) bool {
	return false
}

// jobWireFields is the strict subset of the Odoo job contract that the
// Agent reads directly. Payload decoding remains owned by payload.Parse, while
// these runtime decision fields must never silently collapse to zero values.
type jobWireFields struct {
	ID            string
	AgentID       string
	PrinterID     string
	Status        string
	RequestID     string
	ClaimToken    string
	BindingDigest string
	DocumentType  string
}

func readStringField(m map[string]interface{}, field string, required, nullable bool) (string, error) {
	if m == nil {
		return "", fmt.Errorf("field %q cannot be read from a nil object", field)
	}
	raw, exists := m[field]
	if !exists {
		if required {
			return "", fmt.Errorf("field %q is missing", field)
		}
		return "", nil
	}
	if raw == nil {
		if nullable {
			return "", nil
		}
		return "", fmt.Errorf("field %q has invalid type null; expected string", field)
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("field %q has invalid type %T; expected string", field, raw)
	}
	if required && value == "" {
		return "", fmt.Errorf("field %q is empty", field)
	}
	return value, nil
}

func decodeJobFields(job map[string]interface{}) (jobWireFields, error) {
	id, err := readStringField(job, "id", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	printerID, err := readStringField(job, "printerId", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	agentID, err := readStringField(job, "agentId", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	status, err := readStringField(job, "status", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	if status != "claimed" {
		return jobWireFields{}, fmt.Errorf("field %q has invalid state %q; expected claimed", "status", status)
	}
	requestID, err := readStringField(job, "requestId", false, true)
	if err != nil {
		return jobWireFields{}, err
	}
	claimToken, err := readStringField(job, "claimToken", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	documentType, err := readStringField(job, "documentType", false, true)
	if err != nil {
		return jobWireFields{}, err
	}
	// Missing historical bindings may be reconciled from a durable terminal
	// result, but fresh execution below always requires an exact digest.
	bindingDigest, err := readStringField(job, "bindingDigest", false, true)
	if err != nil {
		return jobWireFields{}, err
	}
	if bindingDigest != "" && !validAdmissionBinding(bindingDigest) {
		return jobWireFields{}, fmt.Errorf("field bindingDigest must be a lowercase SHA-256 digest")
	}
	return jobWireFields{
		ID:            id,
		AgentID:       agentID,
		PrinterID:     printerID,
		Status:        status,
		RequestID:     requestID,
		ClaimToken:    claimToken,
		BindingDigest: bindingDigest,
		DocumentType:  documentType,
	}, nil
}

// isPOSPrintJob reports whether the claimed job is a time-critical POS print
// (receipt, kitchen/order ticket, cash drawer, etc.). POS jobs must degrade
// gracefully and log rather than being blocked or delayed by license,
// verification, or sync failures.
func isPOSPrintJob(fields jobWireFields) bool {
	dt := strings.ToLower(strings.TrimSpace(fields.DocumentType))
	if dt == "" {
		return false
	}
	return dt == "pos" ||
		strings.HasPrefix(dt, "pos_") ||
		strings.HasPrefix(dt, "pos-") ||
		strings.Contains(dt, "receipt") ||
		strings.Contains(dt, "kitchen") ||
		strings.Contains(dt, "order_ticket") ||
		strings.Contains(dt, "cash_drawer")
}

func documentForClaimedJob(fields jobWireFields, kind string, data []byte) printer.Document {
	return printer.Document{
		Kind: kind, Data: data, JobID: fields.ID,
		TestPage: fields.DocumentType == "test_page" && kind == printer.KindPDF,
	}
}

// classifyPanicOutcome decides the terminal report for a panic during job
// execution. A panic is phase-ambiguous: it may strike before admission,
// after BeginPrint, or after bytes reached the device. The only safe rule is:
//
//   - ledger unreadable or row in `printing`: UNKNOWN (bytes may be sent);
//   - row already `success`: success stands (never reopened);
//   - row already failed with an unknown-outcome marker: UNKNOWN is preserved
//     so Odoo cannot misclassify the job as provably not printed and
//     auto-retry onto possibly existing paper;
//   - otherwise (queued, plain failed, missing row): plain failed.
//
// Pure function of its inputs so the matrix stays pinned by unit tests.
func classifyPanicOutcome(readErr error, found bool, localStatus string, priorUnknown bool, r interface{}) (status, msg string) {
	panicMsg := fmt.Sprintf("AGENT_PANIC: %v", r)
	if readErr != nil || (found && localStatus == "printing") {
		return "failed", "UNKNOWN_PARTIAL_DELIVERY: " + panicMsg + " (physical outcome cannot be proven absent after agent panic)"
	}
	if found && localStatus == "success" {
		return "success", ""
	}
	if priorUnknown {
		return "failed", "UNKNOWN_PARTIAL_DELIVERY: " + panicMsg + " (prior attempt outcome unknown; physical outcome cannot be proven absent after agent panic)"
	}
	return "failed", panicMsg
}
