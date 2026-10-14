package agent

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type localPrinterSharingSnapshot struct {
	policy config.PrinterSharing
	view   config.ResolvedPrinterSharing
	known  []config.PrinterConfig
	err    error
}

func (a *Agent) loadLocalPrinterSharing() localPrinterSharingSnapshot {
	policy, err := config.LoadPrinterSharing(a.configPath)
	snapshot := localPrinterSharingSnapshot{policy: policy, view: policy.Resolve(nil), err: err}
	if err != nil || !policy.Present {
		return snapshot
	}
	// Runtime desired state and GUI acknowledgements are not local authority.
	// Fresh operator bindings follow stable IDs across rename/rediscovery.
	cfg, err := config.Load(a.configPath)
	if err != nil {
		snapshot.err = fmt.Errorf("read current local config for sharing: %w", err)
		return snapshot
	}
	snapshot.known, snapshot.err = printer.LocalSharingBindings(cfg, a.registryPath)
	snapshot.view = policy.Resolve(snapshot.known)
	if snapshot.err == nil {
		snapshot.err = snapshot.view.Err()
	}
	return snapshot
}

func (snapshot localPrinterSharingSnapshot) shared(pc config.PrinterConfig) (bool, error) {
	if snapshot.err != nil {
		return false, snapshot.err
	}
	return snapshot.view.Shared(pc)
}

// Read fresh before physical admission; never cancel an admitted native
// session or fence terminal/outbox evidence or local diagnostic operations.
func (a *Agent) isPrinterSharedWithGateway(id string) bool {
	snapshot := a.loadLocalPrinterSharing()
	if snapshot.err != nil {
		log.Printf("Gateway dispatch fenced by local sharing policy: %v", snapshot.err)
		return false
	}
	if !snapshot.policy.Present {
		return true
	}
	a.printersMu.RLock()
	pc, exists := a.printerConfigs[id]
	a.printersMu.RUnlock()
	if !exists {
		return false
	}
	shared, err := snapshot.shared(pc)
	if err != nil {
		log.Printf("Gateway dispatch sharing binding unavailable for %s: %v", id, err)
	}
	return shared && err == nil
}

// Send all known private runtime/desired aliases plus durable denied IDs.
// Old Gateway inventory is hidden even after a denied stable ID is renamed.
func (a *Agent) privatePrinterIDs(snapshot localPrinterSharingSnapshot) ([]string, bool) {
	configs := append([]config.PrinterConfig{}, snapshot.known...)
	a.printersMu.RLock()
	byID := make(map[string]config.PrinterConfig, len(a.printerConfigs))
	for id, pc := range a.printerConfigs {
		byID[id] = pc
		configs = append(configs, pc)
	}
	owned := make([]string, 0, len(a.gatewayOwned))
	for id := range a.gatewayOwned {
		owned = append(owned, id)
	}
	a.printersMu.RUnlock()
	a.desiredStateMu.Lock()
	for _, row := range a.desiredStates {
		configs = append(configs, desiredPrinterConfig(row))
	}
	a.desiredStateMu.Unlock()
	private := make(map[string]struct{})
	for id := range snapshot.policy.DeniedPrinters {
		private[id] = struct{}{}
	}
	complete := snapshot.err == nil
	for _, pc := range configs {
		shared, err := snapshot.shared(pc)
		if !shared || err != nil {
			private[pc.ID] = struct{}{}
		}
		if err != nil {
			complete = false
		}
	}
	for _, id := range owned {
		localID := a.resolvePrinterAlias(id)
		if pc, exists := byID[localID]; exists {
			shared, err := snapshot.shared(pc)
			if !shared || err != nil {
				private[id] = struct{}{}
			}
			if err != nil {
				complete = false
			}
		} else if snapshot.err != nil {
			private[id] = struct{}{}
		}
	}
	ids := make([]string, 0, len(private))
	invalidCount := 0
	for id := range private {
		if validGatewaySharingID(id) {
			ids = append(ids, id)
		} else {
			complete = false
			invalidCount++
		}
	}
	if invalidCount > 0 {
		log.Printf("Heartbeat sharing inventory incomplete: %d private local IDs are outside the Gateway ID contract", invalidCount)
	}
	sort.Strings(ids)
	return ids, complete
}

func validGatewaySharingID(id string) bool {
	if id == "" || !utf8.ValidString(id) || strings.TrimSpace(id) != id || strings.ContainsFunc(id, unicode.IsControl) {
		return false
	}
	// Zod string length is UTF-16 code units. Avoid rejecting every page of a
	// snapshot because an old local ID could never fit the Gateway contract.
	units := 0
	for _, r := range id {
		units++
		if r > 0xffff {
			units++
		}
		if units > 120 {
			return false
		}
	}
	return true
}

func (a *Agent) localPrinterBindingDisabled(pc config.PrinterConfig) bool {
	if a.legacyPrinterDisabled(pc.ID) {
		return true
	}
	if a.cfg == nil {
		return false
	}
	digest, err := config.PrinterBindingDigest(pc)
	if err != nil {
		return false
	} // existing desired/backend validation owns unknown bindings
	for _, local := range a.cfg.Printers {
		if local.IsEnabled() {
			continue
		}
		localDigest, err := config.PrinterBindingDigest(local)
		if err == nil && localDigest == digest {
			return true
		}
	}
	return false
}

func (a *Agent) cloudDiscoveryPayload(result printer.DiscoveryResult) ([]map[string]interface{}, []string) {
	snapshot := a.loadLocalPrinterSharing()
	devices := make([]map[string]interface{}, 0, len(result.Printers))
	if snapshot.err == nil && snapshot.policy.Present {
		// Fresh local native groups may precede registry persistence. Resolve
		// the complete scan coherently before emitting even its first row.
		snapshot.known, snapshot.err = printer.AppendLocalSharingBindings(snapshot.known, result.Printers)
		if snapshot.err == nil {
			snapshot.view = snapshot.policy.Resolve(snapshot.known)
			snapshot.err = snapshot.view.Err()
		}
	}
	if snapshot.err != nil {
		log.Printf("[discovery] cloud report fenced by local sharing policy: %v", snapshot.err)
		return devices, []string{"local printer sharing policy unavailable; cloud discovery metadata withheld"}
	}
	for _, device := range result.Printers {
		if snapshot.view.DiscoveryShared(printer.SharingConfigForDevice(device)) {
			devices = append(devices, discoveryDevicePayload(a.cfg.Agent.ID, device))
		}
	}
	errors := result.Errors
	if len(snapshot.policy.DeniedPrinters) > 0 && len(errors) > 0 {
		// Native/source error strings can themselves contain private queue
		// names/addresses. Retain diagnostics locally, disclose a generic
		// bounded source error and preserve partial/failed status remotely.
		for _, sourceError := range errors {
			log.Printf("[discovery] local source warning: %s", sourceError)
		}
		errors = []string{"one or more local discovery sources reported errors; details retained locally"}
	}
	return devices, errors
}
