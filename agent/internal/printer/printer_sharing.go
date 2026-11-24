package printer

import (
	"fmt"
	"os"
	"strings"
	"unicode"

	"github.com/yaseir-agent/agent/internal/config"
)

// SharingConfigForDevice uses only the selected execution tuple. Display
// names, hardware serials and discovery reachability never choose a queue.
func SharingConfigForDevice(device DeviceInfo) config.PrinterConfig {
	connection := device.ConnectionType
	if strings.TrimSpace(connection) == "" {
		connection = device.Type
	}
	return config.PrinterConfig{
		ID: device.ID, Name: device.Name, Type: connection,
		Endpoint: device.Endpoint, Protocol: device.Protocol, SpoolerName: device.SpoolerName,
		PrinterType: device.PrinterType, USBVID: device.USBVID, USBPID: device.USBPID,
		USBSerial: device.USBSerial, Capabilities: device.Capabilities,
	}
}

// Winspool.h PRINTER_ATTRIBUTE_SHARED=0x8. First-class PRINTER_INFO_2
// server/share fields prove this alternate queue name; a capability-only
// declaration or an unrelated queue sharing its port/serial cannot do so.
func SharingBindingsForDevice(device DeviceInfo, local ...*config.Config) ([]config.PrinterConfig, error) {
	primary := SharingConfigForDevice(device)
	bindings := []config.PrinterConfig{primary}
	source, _ := device.Capabilities["discovered_via"].(string)
	if primary.NormalizedType() != "spooler" || source != SourceSpooler || device.SpoolerShare == "" {
		return bindings, nil
	}
	var attributes uint32
	switch value := device.Capabilities["spooler_attributes"].(type) {
	case uint32:
		attributes = value
	case int:
		if value < 0 || uint64(value) > uint64(^uint32(0)) {
			return bindings, nil
		}
		attributes = uint32(value)
	case int64:
		if value < 0 || uint64(value) > uint64(^uint32(0)) {
			return bindings, nil
		}
		attributes = uint32(value)
	case uint:
		if uint64(value) > uint64(^uint32(0)) {
			return bindings, nil
		}
		attributes = uint32(value)
	case uint64:
		if value > uint64(^uint32(0)) {
			return bindings, nil
		}
		attributes = uint32(value)
	case float64:
		if value < 0 || value > float64(^uint32(0)) || value != float64(uint32(value)) {
			return bindings, nil
		}
		attributes = uint32(value)
	default:
		return bindings, nil
	}
	if attributes&0x00000008 == 0 {
		return bindings, nil
	}
	share := device.SpoolerShare
	server := strings.TrimPrefix(device.SpoolerServer, `\\`)
	if strings.TrimSpace(share) != share || strings.ContainsAny(share, `/\`) || strings.ContainsFunc(share, unicode.IsControl) {
		return nil, fmt.Errorf("invalid native printer share identity")
	}
	if server == "" {
		var err error
		server, err = os.Hostname()
		if err != nil || server == "" {
			return nil, fmt.Errorf("native local printer share server unavailable")
		}
	}
	if strings.TrimSpace(server) != server || strings.ContainsAny(server, `/\`) || strings.ContainsFunc(server, unicode.IsControl) {
		return nil, fmt.Errorf("invalid native printer share server")
	}
	alias := primary
	alias.SpoolerName, alias.Endpoint = `\\`+server+`\`+share, `\\`+server+`\`+share
	alias.VerifiedSpoolerSharingAlias = true
	return append(bindings, alias), nil
}

// LocalSharingBindings reads persisted local identities as well as YAML. It
// deliberately does not use cloud desired-state files as operator authority.
func LocalSharingBindings(cfg *config.Config, registryPath string) ([]config.PrinterConfig, error) {
	registered, err := LoadRegistryPrinters(registryPath)
	if err != nil {
		return nil, fmt.Errorf("read local printer bindings: %w", err)
	}
	known := make([]config.PrinterConfig, 0, len(registered))
	if cfg != nil {
		for _, pc := range cfg.Printers {
			caps := make(map[string]interface{}, len(pc.Capabilities)+1)
			for key, value := range pc.Capabilities {
				caps[key] = value
			}
			caps["registration_source"] = "config"
			pc.Capabilities = caps
			known = append(known, pc)
		}
	}
	return AppendLocalSharingBindings(known, registered, cfg)
}

// AppendLocalSharingBindings consumes local observations only. Desired state
// is never an input; fresh read-only enumeration need not mutate the registry
// to project known local queues or propagate a verified share group's deny.
func AppendLocalSharingBindings(known []config.PrinterConfig, devices []DeviceInfo, local ...*config.Config) ([]config.PrinterConfig, error) {
	for _, device := range devices {
		bindings, err := SharingBindingsForDevice(device, local...)
		if err != nil {
			return nil, err
		}
		known = append(known, bindings...)
	}
	return known, nil
}

// AnnotatePrinterVisibility returns DTO copies only: never persist this choice in
// the replaceable discovery registry/capabilities or change observed health.
func AnnotatePrinterVisibility(configPath string, cfg *config.Config, registryPath string, devices []DeviceInfo) ([]DeviceInfo, error) {
	policy, err := config.LoadPrinterVisibility(configPath)
	if err != nil {
		return nil, err
	}
	var known []config.PrinterConfig
	if policy.Present {
		known, err = LocalSharingBindings(cfg, registryPath)
		if err != nil {
			return nil, err
		}
		known, err = AppendLocalSharingBindings(known, devices, cfg)
		if err != nil {
			return nil, err
		}
	}
	result := make([]DeviceInfo, 0, len(devices))
	view := policy.Resolve(known)
	if err := view.Err(); err != nil {
		return nil, err
	}
	for _, device := range devices {
		pc := SharingConfigForDevice(device)
		shared, bindingErr := view.Shared(pc)
		if bindingErr != nil {
			shared = false
		} // unknown setup-only destinations remain private
		device.SharedWithGateway = &shared
		result = append(result, device)
	}
	return result, nil
}

// SharingCandidateReason explains why a device cannot be shared or
// unshared through the local toggle, or "" when it can. A refusal used to
// be a single opaque sentence; the Desktop control and the CLI now surface
// this reason next to the button / in the CLI error so an operator can
// tell a per-user connection, a software queue, and a merely unadmitted
// row apart instead of retrying the same toggle. The reason never changes
// the decision itself: only a locally admitted physical execution
// destination is selectable, whatever its health (offline queues included).
func SharingCandidateReason(device DeviceInfo) string {
	return SharingCandidateReasonWithOptions(device, false)
}

// SharingCandidateReasonWithOptions explains why a device cannot be shared or
// unshared, or "" when it can. When allowVirtual is true, explicitly opted-in
// virtual/software queues (such as Microsoft Print to PDF / XPS Document Writer)
// are permitted while redirected and unverified setup-only candidates stay blocked.
func SharingCandidateReasonWithOptions(device DeviceInfo, allowVirtual bool) string {
	classification := ClassifyDeviceInfo(device)
	verification, _ := device.Capabilities["verification"].(string)
	verification = strings.TrimSpace(verification)
	switch {
	case classification.Class == ClassRedirected:
		return "redirected session queue, not a local physical execution destination"
	case classification.IsUnusable:
		return "unusable non-printable queue (fax or blackhole), not an execution destination"
	case classification.IsVirtual && !allowVirtual:
		return "virtual or software-only queue, not a physical execution destination"
	case strings.EqualFold(verification, "candidate_only"):
		if reason, _ := device.Capabilities["candidate_reason"].(string); strings.TrimSpace(reason) != "" {
			return "setup-only candidate: " + strings.TrimSpace(reason)
		}
		return "setup-only candidate: discovered but not admitted as a service printer (per-user connection or unverified session discovery)"
	case strings.EqualFold(verification, "device_detected_only"):
		return "setup-only candidate: device detected but never admitted as a service printer"
	case !IsRuntimeDiscoveryPrinter(device):
		return "not in the main runtime inventory: confirm it as a local printer before changing sharing"
	default:
		return ""
	}
}

// SelectSharingPrinter accepts a unique locally known execution destination,
// including offline queues. Health is not evidence of ownership; setup-only
// per-user/registry/PnP candidates cannot become service printers via this flag.
func SelectSharingPrinter(id string, devices []DeviceInfo, local ...*config.Config) (config.PrinterConfig, error) {
	return SelectSharingPrinterWithOptions(id, devices, false, local...)
}

// SelectSharingPrinterWithOptions selects a unique locally known execution
// destination, optionally allowing virtual/software queues when allowVirtual is true.
func SelectSharingPrinterWithOptions(id string, devices []DeviceInfo, allowVirtual bool, local ...*config.Config) (config.PrinterConfig, error) {
	var selected config.PrinterConfig
	found := false
	for _, device := range devices {
		if device.ID != id {
			continue
		}
		if reason := SharingCandidateReasonWithOptions(device, allowVirtual); reason != "" {
			return selected, fmt.Errorf("printer is not a locally admitted physical execution destination: %s", reason)
		}
		pc := SharingConfigForDevice(device)
		if _, err := config.PrinterBindingDigest(pc); err != nil {
			return selected, err
		}
		if found {
			return selected, fmt.Errorf("local printer ID is ambiguous")
		}
		selected, found = pc, true
	}
	if !found {
		return selected, fmt.Errorf("local printer ID was not found")
	}
	return selected, nil
}
