package printer

import (
	"fmt"
	"maps"

	"github.com/yaseir-agent/agent/internal/config"
)

// VerifiedIPPUUIDFromCapabilities reads only identity provenance emitted by a
// real IPP Get-Printer-Attributes response, never generic discovery UUID hints.
func VerifiedIPPUUIDFromCapabilities(caps map[string]interface{}) string {
	return verifiedIPPUUIDFromCapabilities(caps)
}

// SetIdentityPersistence installs the Agent's durable binding fence before the
// backend is published. Its callback must not be called while statusMu is held.
func (p *IPPPrinter) SetIdentityPersistence(persist func(string) error) {
	p.statusMu.Lock()
	p.identityPersistence = persist
	p.statusMu.Unlock()
}

// PersistVerifiedIdentity is called only after protocol validation and the
// established-identity check, before successful preflight can submit any job.
// A missing UUID keeps legacy endpoints usable without inventing an identity.
func (p *IPPPrinter) PersistVerifiedIdentity(uuid string) error {
	if uuid == "" {
		return nil
	}
	if normalizedIPPPrinterUUID(uuid) == "" {
		return fmt.Errorf("invalid verified IPP printer UUID")
	}
	p.statusMu.RLock()
	persist := p.identityPersistence
	p.statusMu.RUnlock()
	if persist != nil {
		if err := persist(uuid); err != nil {
			return fmt.Errorf("persist verified IPP printer identity before submission: %w", err)
		}
	}
	return nil
}

func conflictingVerifiedIPPUUID(left, right map[string]interface{}) bool {
	a, b := verifiedIPPUUIDFromCapabilities(left), verifiedIPPUUIDFromCapabilities(right)
	return a != "" && b != "" && a != b
}

func preserveVerifiedIPPUUID(caps map[string]interface{}, uuid string) {
	if uuid == "" {
		return
	}
	caps["ipp_printer_uuid"], caps["printer_uuid"], caps["uuid"] = uuid, uuid, uuid
}

func retainedIPPIdentityConflict(prior DeviceInfo) DeviceInfo {
	prior.Capabilities = maps.Clone(prior.Capabilities)
	delete(prior.Capabilities, "geometry")
	delete(prior.Capabilities, "ipp_capabilities")
	prior.Capabilities["status_detail"] = "ipp_identity_changed"
	prior.Status = "unknown"
	return prior
}

// PersistVerifiedIPPIdentity shares one durable registry boundary between the
// Agent runtime and explicit local diagnostic printing. Conflicting existing
// hardware or an ambiguous alias is never overwritten by this observation.
func PersistVerifiedIPPIdentity(registryPath string, pc config.PrinterConfig, uuid string) error {
	uuid = normalizedIPPPrinterUUID(uuid)
	if uuid == "" {
		return fmt.Errorf("invalid verified IPP printer identity")
	}
	expectedBinding, err := config.PrinterBindingDigest(pc)
	if err != nil {
		return err
	}
	capabilities := maps.Clone(pc.Capabilities)
	if capabilities == nil {
		capabilities = make(map[string]interface{})
	}
	preserveVerifiedIPPUUID(capabilities, uuid)
	if capabilities["registration_source"] == nil {
		capabilities["registration_source"] = "config"
	}
	observation := DeviceInfo{ID: pc.ID, Name: pc.Name, Type: pc.NormalizedType(), ConnectionType: pc.NormalizedType(),
		Protocol: pc.NormalizedProtocolOrUnknown(), Endpoint: pc.Endpoint, PrinterType: pc.PrinterType,
		Enabled: pc.IsEnabled(), Status: "unknown", Capabilities: capabilities}
	rows, err := UpsertRegistry(registryPath, []DeviceInfo{observation})
	if err != nil {
		return err
	}
	for _, stored := range rows {
		binding, bindingErr := config.PrinterBindingDigest(SharingConfigForDevice(stored))
		if stored.ID == pc.ID && bindingErr == nil && binding == expectedBinding && verifiedIPPUUIDFromCapabilities(stored.Capabilities) == uuid {
			return nil
		}
	}
	return fmt.Errorf("verified identity was not accepted by the established printer registry binding")
}
