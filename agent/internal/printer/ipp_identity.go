package printer

import (
	"fmt"
	"regexp"
	"strings"
)

var ippPrinterUUIDPattern = regexp.MustCompile(`(?i)^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func normalizedIPPPrinterUUID(value string) string {
	if !ippPrinterUUIDPattern.MatchString(value) {
		return ""
	}
	normalized := strings.ToLower(value)
	if normalized == "urn:uuid:00000000-0000-0000-0000-000000000000" {
		return ""
	}
	return normalized
}

// Only an actual Get-Printer-Attributes UUID is persisted under this key;
// unverified mDNS names/UUID strings are not an execution identity assertion.
func verifiedIPPUUIDFromCapabilities(caps map[string]interface{}) string {
	if raw, ok := caps["ipp_printer_uuid"].(string); ok {
		return normalizedIPPPrinterUUID(raw)
	}
	if observed, ok := caps["ipp_capabilities"].(map[string]interface{}); ok {
		if raw, ok := observed["printer_uuid"].(string); ok {
			return normalizedIPPPrinterUUID(raw)
		}
	}
	return ""
}

func (p *IPPPrinter) checkIPPIdentity(attrs map[string]string) error {
	reported := normalizedIPPPrinterUUID(attrs["printer-uuid"])
	if raw, present := p.geometryConfig.Capabilities["ipp_printer_uuid"]; present {
		value, ok := raw.(string)
		if !ok || normalizedIPPPrinterUUID(value) == "" {
			return fmt.Errorf("invalid persisted IPP printer identity; reconcile registration before submitting")
		}
	}
	p.statusMu.Lock()
	defer p.statusMu.Unlock()
	if p.boundUUID == "" {
		p.boundUUID = verifiedIPPUUIDFromCapabilities(p.geometryConfig.Capabilities)
	}
	if p.boundUUID != "" && reported != p.boundUUID {
		return fmt.Errorf("IPP printer identity changed or is unavailable; verify the selected physical printer and explicitly reconcile its registration before submitting")
	}
	if p.boundUUID == "" && reported != "" {
		p.boundUUID = reported
	}
	return nil
}
