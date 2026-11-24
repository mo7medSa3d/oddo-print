package agent

import (
	"log"
	"strings"
)

// gatewayDeviceClasses mirrors DEVICE_CLASSES in the Gateway's
// src/lib/printer-model.ts.
//
// The Gateway validates printerType and deviceClass against two DIFFERENT
// enums — PRINTER_TYPES = physical|file (src/lib/printer-model.ts) and
// DEVICE_CLASSES =
// thermal|laser|inkjet|label|other|unknown — and rejects the whole printer
// entry with "invalid_device_class_or_printer_type" when either value is out
// of range. Every payload that reports a device class must normalize against
// this list first: sending a printer class in the deviceClass field made the
// Gateway drop the printer from the inventory on every heartbeat.
var gatewayDeviceClasses = map[string]struct{}{
	"thermal": {},
	"laser":   {},
	"inkjet":  {},
	"label":   {},
	"other":   {},
	"unknown": {},
}

// normalizeDeviceClass maps an arbitrary declared class onto the Gateway's
// device-class vocabulary, failing closed to "unknown" (which is a member of
// the enum, so it is always accepted).
func normalizeDeviceClass(raw string) string {
	class := strings.ToLower(strings.TrimSpace(raw))
	if _, ok := gatewayDeviceClasses[class]; ok {
		return class
	}
	return "unknown"
}

// normalizePrinterType maps the legacy printer_type field onto the agent's
// local printer-type vocabulary. The Gateway itself only accepts
// physical|file; virtual and redirected are legacy agent-side classes that
// the classifier keeps distinct so a software capture is never inferred as
// production hardware. Legacy device classes are still treated as physical
// printers, while virtual and redirected remain semantically distinct.
func normalizePrinterType(raw string) string {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "virtual":
		return "virtual"
	case "redirected":
		return "redirected"
	case "physical":
		return "physical"
	case "file":
		log.Printf("normalizePrinterType: legacy printer type %q coerced to physical", raw)
		return "physical"
	default:
		if normalized != "" {
			log.Printf("normalizePrinterType: unclassified printer type %q coerced to physical", raw)
		}
		return "physical"
	}
}
