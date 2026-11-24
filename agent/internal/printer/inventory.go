package printer

import (
	"runtime"
	"strings"
)

// RuntimeInventoryPrinters separates the main fleet from setup observations.
// On Windows, automatic inventory follows installed physical and printable
// virtual print queues (such as Microsoft Print to PDF and XPS Document
// Writer); network/USB scan results remain available through discovery for
// explicit selection. Operator registrations and non-Windows behavior are
// unchanged. RuntimeDiscoveryPrinters still describes executable transport
// capability.
func RuntimeInventoryPrinters(printers []DeviceInfo) []DeviceInfo {
	return runtimeInventoryPrintersForPlatform(printers, runtime.GOOS)
}

func runtimeInventoryPrintersForPlatform(printers []DeviceInfo, platform string) []DeviceInfo {
	filtered := make([]DeviceInfo, 0, len(printers))
	for _, device := range printers {
		if IsRuntimeDiscoveryPrinter(device) && mainInventoryPrinterForPlatform(device, platform) {
			filtered = append(filtered, device)
		}
	}
	return filtered
}

func mainInventoryPrinterForPlatform(device DeviceInfo, platform string) bool {
	if platform != "windows" {
		return true
	}
	if isOperatorRegisteredDevice(device) {
		return true
	}
	source, _ := device.Capabilities["registration_source"].(string)
	discoveredVia, observed := device.Capabilities["discovered_via"]
	automatic := observed && discoveredVia != nil
	if text, ok := discoveredVia.(string); ok {
		automatic = strings.TrimSpace(text) != ""
	}
	automatic = automatic || strings.EqualFold(strings.TrimSpace(source), "discovery")
	if !automatic {
		// Older ambiguous registry rows may be deliberate operator state.
		// Do not infer automatic ownership or destroy their execution path.
		return true
	}
	// v3: per-user spooler connections discovered from an interactive
	// session (or an unverifiable session) are setup evidence only. The
	// Session-0 service cannot execute them, yet admitting them here made
	// the Gateway route jobs to queues that always fail pre-execution
	// while looking healthy in inventory. They stay visible in discovery
	// display (which lists all observations) and in the registry for
	// explicit selection; they are simply not main-fleet inventory.
	// Session-0 discovery itself is never marked (markUserSpoolerConnectionScope
	// skips session 0), so service-discovered rows are unaffected.
	if scope, _ := device.Capabilities["runtime_scope"].(string); scope == "interactive_session_discovery_only" || scope == "unverified_session_discovery_only" {
		return false
	}
	return isSpoolerDevice(device) && strings.TrimSpace(device.SpoolerName) != ""
}

func isOperatorRegisteredDevice(device DeviceInfo) bool {
	source, _ := device.Capabilities["registration_source"].(string)
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "manual", "config":
		return true
	default:
		return false
	}
}

func isSpoolerDevice(device DeviceInfo) bool {
	connection := strings.TrimSpace(device.ConnectionType)
	if connection == "" {
		connection = strings.TrimSpace(device.Type)
	}
	return strings.EqualFold(strings.TrimSpace(device.Protocol), "spooler") ||
		strings.EqualFold(strings.TrimSpace(device.Protocol), "windows_spooler") ||
		strings.EqualFold(connection, "spooler") || strings.EqualFold(connection, "windows_spooler")
}
