package printer

import (
	"fmt"
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
)

// virtualSpoolerTestQueue is the Agent-side authoritative OS evidence check.
// Manager intent alone cannot turn a software queue into an execution target.
// Redirected printers and FAX queues are forbidden even in diagnostic mode.
func virtualSpoolerTestQueue(pc config.PrinterConfig, queues []DeviceInfo) error {
	name := strings.TrimSpace(pc.SpoolerName)
	if name == "" || pc.NormalizedType() != "spooler" || !strings.EqualFold(pc.PrinterType, "virtual") ||
		pc.Capabilities == nil || pc.Capabilities["virtual_spooler_test"] != true {
		return fmt.Errorf("virtual spooler testing requires an explicitly approved manager-owned virtual queue")
	}
	if strings.EqualFold(name, VirtualCaptureSpoolerName) || strings.Contains(strings.ToLower(name), "fax") ||
		strings.Contains(strings.ToLower(name), "(redirected") || strings.Contains(strings.ToLower(name), " in session ") {
		return fmt.Errorf("virtual spooler queue %q is a restricted capture, fax or redirected destination", name)
	}
	for _, q := range queues {
		if !strings.EqualFold(strings.TrimSpace(q.SpoolerName), name) {
			continue
		}
		classification := ClassifyDeviceInfo(q)
		if classification.Class != ClassVirtual || classification.IsRedirected ||
			strings.Contains(strings.ToLower(q.Name+" "+q.SpoolerDriver), "fax") {
			return fmt.Errorf("Windows queue %q is not an eligible local software printer", name)
		}
		if !strings.EqualFold(q.ConnectionType, "spooler") || !strings.EqualFold(q.Protocol, "spooler") {
			return fmt.Errorf("Windows queue %q has an unsupported spooler transport", name)
		}
		return nil
	}
	return fmt.Errorf("virtual Windows printer %q not found in the Agent service account's local print queues; install it for this account or use Yaseir file capture", name)
}

// ValidateVirtualSpoolerTestQueue inspects the actual Windows queues during
// desired-state application. This fails closed on Linux, unreadable inventory,
// renamed/removed queues, and if a Desktop session sees a printer that the
// Windows service account cannot see. It does not submit print data.
func ValidateVirtualSpoolerTestQueue(pc config.PrinterConfig) error {
	queues, err := EnumSpoolerQueuesForDiagnostics()
	if err != nil && len(queues) == 0 {
		return fmt.Errorf("inspect Windows virtual spooler queues: %w", err)
	}
	return virtualSpoolerTestQueue(pc, queues)
}
