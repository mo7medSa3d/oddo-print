package agent

import (
	"fmt"
	"log"
	"sort"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type localPrinterVisibilitySnapshot struct {
	policy config.PrinterVisibility
	view   config.ResolvedPrinterVisibility
	known  []config.PrinterConfig
	err    error
}

// loadLocalPrinterVisibility reads only the Agent's local printer registry and
// the local user visibility file. There is no Cloud desired-state dependency.
func (a *Agent) loadLocalPrinterVisibility() localPrinterVisibilitySnapshot {
	policy, err := config.LoadPrinterVisibility(a.configPath)
	snapshot := localPrinterVisibilitySnapshot{policy: policy, view: policy.Resolve(nil), err: err}
	if err != nil || !policy.Present {
		return snapshot
	}
	cfg, err := config.Load(a.configPath)
	if err != nil {
		snapshot.err = fmt.Errorf("read local config for printer visibility: %w", err)
		return snapshot
	}
	snapshot.known, snapshot.err = printer.LocalSharingBindings(cfg, a.registryPath)
	if snapshot.err != nil {
		return snapshot
	}
	seen := make(map[string]struct{}, len(snapshot.known))
	for _, pc := range snapshot.known {
		seen[pc.ID] = struct{}{}
	}
	a.printersMu.RLock()
	for id, pc := range a.printerConfigs {
		if _, exists := seen[id]; exists {
			continue
		}
		if pc.NormalizedType() == "spooler" {
			reg, _ := pc.Capabilities["registration_source"].(string)
			if reg == "" {
				continue
			}
		}
		snapshot.known = append(snapshot.known, pc)
		seen[id] = struct{}{}
	}
	a.printersMu.RUnlock()
	snapshot.view = policy.Resolve(snapshot.known)
	snapshot.err = snapshot.view.Err()
	return snapshot
}

func (snapshot localPrinterVisibilitySnapshot) shared(pc config.PrinterConfig) (bool, error) {
	if snapshot.err != nil {
		return false, snapshot.err
	}
	return snapshot.view.Shared(pc)
}

// Visibility is an explicit local setting. It is independent of device
// operational verification and is checked only for the selected printer.
func (a *Agent) isPrinterAvailableToOdoo(id string) bool {
	a.printersMu.RLock()
	_, odooDisabled := a.odooDisabledPrinters[id]
	a.printersMu.RUnlock()
	if odooDisabled {
		return false
	}
	snapshot := a.loadLocalPrinterVisibility()
	if snapshot.err != nil {
		log.Printf("Printer visibility configuration is unavailable; defaulting to available: %v", snapshot.err)
		return true
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
		log.Printf("Printer visibility could not be resolved for %s: %v", id, err)
		return false
	}
	return shared
}

// hiddenPrinterIDs lets Odoo mark previously published local printers as
// unavailable after an operator hides them. IDs are local and never aliased.
func (a *Agent) hiddenPrinterIDs(snapshot localPrinterVisibilitySnapshot) ([]string, bool) {
	configs := append([]config.PrinterConfig{}, snapshot.known...)
	a.printersMu.RLock()
	for _, pc := range a.printerConfigs {
		configs = append(configs, pc)
	}
	a.printersMu.RUnlock()
	private := make(map[string]struct{})
	for id := range snapshot.policy.DeniedPrinters {
		private[id] = struct{}{}
	}
	complete := snapshot.err == nil
	seen := make(map[string]struct{}, len(configs))
	for _, pc := range configs {
		if pc.ID == "" {
			complete = false
			continue
		}
		if _, exists := seen[pc.ID]; exists {
			continue
		}
		seen[pc.ID] = struct{}{}
		shared, err := snapshot.shared(pc)
		if err != nil {
			complete = false
			continue
		}
		if !shared {
			private[pc.ID] = struct{}{}
		}
	}
	ids := make([]string, 0, len(private))
	for id := range private {
		if validOdooPrinterID(id) {
			ids = append(ids, id)
		} else {
			complete = false
		}
	}
	sort.Strings(ids)
	return ids, complete
}

func validOdooPrinterID(id string) bool {
	return printer.ValidPrinterID(id)
}

func (a *Agent) localPrinterBindingDisabled(pc config.PrinterConfig) bool {
	disabled, err := printer.LoadLocalPrinterDisablement(a.cfg, a.registryPath)
	if err != nil {
		log.Printf("Printer disabled-state configuration is unavailable; ignoring optional disablement: %v", err)
		return false
	}
	return disabled.Disabled(pc)
}
