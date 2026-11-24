package agent

import (
	"fmt"
	"reflect"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func clonePrinterConfig(pc config.PrinterConfig) config.PrinterConfig {
	clone := pc
	if pc.Capabilities != nil {
		clone.Capabilities = make(map[string]interface{}, len(pc.Capabilities))
		for key, value := range pc.Capabilities {
			clone.Capabilities[key] = value
		}
	}
	return clone
}

func sameConfigWithoutObservedIPPUUID(left, right config.PrinterConfig) bool {
	left = clonePrinterConfig(left)
	right = clonePrinterConfig(right)
	for _, key := range []string{
		"ipp_printer_uuid",
		"verified_ipp_uuid",
		"ipp_identity_source",
		"operational_verification",
		"status_detail",
		"status_reason",
		"spooler_status_raw",
		"last_probe",
		"ipp_capabilities",
		"registry_persistence_error",
	} {
		delete(left.Capabilities, key)
		delete(right.Capabilities, key)
	}
	if len(left.Capabilities) == 0 {
		left.Capabilities = nil
	}
	if len(right.Capabilities) == 0 {
		right.Capabilities = nil
	}
	return reflect.DeepEqual(left, right)
}

func (a *Agent) identityGenerationCurrentLocked(id string, expected config.PrinterConfig, backend printer.Printer) bool {
	current, present := a.printerConfigs[id]
	if !present || a.printers[id] != backend || !sameConfigWithoutObservedIPPUUID(current, expected) {
		return false
	}
	return true
}

func (a *Agent) attachPrinterIdentityPersistence(backend printer.Printer, pc config.PrinterConfig) {
	if setter, ok := backend.(interface{ SetIdentityPersistence(func(string) error) }); ok {
		persistedUUID := ""
		setter.SetIdentityPersistence(func(uuid string) error {
			return a.persistPrinterIdentity(pc.ID, backend, pc, uuid, &persistedUUID)
		})
	}
}

func (a *Agent) persistPrinterIdentity(id string, backend printer.Printer, expected config.PrinterConfig, uuid string, persistedUUID *string) error {
	uuid = printer.VerifiedIPPUUIDFromCapabilities(map[string]interface{}{"ipp_printer_uuid": uuid})
	if uuid == "" {
		return fmt.Errorf("invalid verified printer identity")
	}
	a.printersMu.Lock()
	if !a.identityGenerationCurrentLocked(id, expected, backend) {
		a.printersMu.Unlock()
		return fmt.Errorf("printer configuration changed during IPP identity observation")
	}
	current := a.printerConfigs[id]
	known := printer.VerifiedIPPUUIDFromCapabilities(current.Capabilities)
	if known != "" && known != uuid {
		a.printersMu.Unlock()
		return fmt.Errorf("verified IPP identity conflicts with established printer registration")
	}
	if known == uuid && *persistedUUID == uuid {
		a.printersMu.Unlock()
		return nil
	}
	a.printersMu.Unlock()

	err := printer.PersistVerifiedIPPIdentity(a.registryPath, current, uuid)
	if err != nil {
		return err
	}

	a.printersMu.Lock()
	defer a.printersMu.Unlock()
	if !a.identityGenerationCurrentLocked(id, expected, backend) {
		return fmt.Errorf("printer configuration changed while persisting IPP identity")
	}
	current = a.printerConfigs[id]
	current = clonePrinterConfig(current)
	if current.Capabilities == nil {
		current.Capabilities = make(map[string]interface{})
	}
	current.Capabilities["ipp_printer_uuid"] = uuid
	current.Capabilities["verified_ipp_uuid"] = uuid
	current.Capabilities["ipp_identity_source"] = "verified"
	a.printerConfigs[id] = current
	*persistedUUID = uuid
	return nil
}
