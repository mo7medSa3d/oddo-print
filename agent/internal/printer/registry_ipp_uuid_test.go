package printer

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

const registryIPPUUIDA = "urn:uuid:11111111-2222-3333-4444-555555555555"
const registryIPPUUIDB = "urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

func registryIPPIdentityFixture(id, endpoint, uuid string) DeviceInfo {
	return DeviceInfo{ID: id, Name: "Office printer", Type: "ipp", ConnectionType: "ipp", Protocol: "ipp", Endpoint: endpoint,
		NetworkAddress: "192.168.1.20", Port: 631, Enabled: false, PrinterType: "physical", Status: "online",
		Capabilities: map[string]interface{}{"registration_source": "manual", "ipp_printer_uuid": uuid, "uuid": uuid,
			"printer_uuid": uuid, "geometry": map[string]interface{}{"printable_width_dots": 2480},
			"ipp_capabilities": map[string]interface{}{"printer_uuid": uuid}}}
}

func TestRegistryIPPRejectsSameEndpointDifferentVerifiedUUID(t *testing.T) {
	for _, alias := range []bool{false, true} {
		t.Run(map[bool]string{false: "same_id", true: "canonical_alias"}[alias], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			prior := registryIPPIdentityFixture("historical-id", "ipp://192.168.1.20/ipp/print", registryIPPUUIDA)
			if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
				t.Fatal(err)
			}
			incoming := registryIPPIdentityFixture(prior.ID, prior.Endpoint, registryIPPUUIDB)
			incoming.Enabled = true
			if alias {
				incoming.ID = "new-discovery-id"
				incoming.Endpoint = "http://192.168.1.20:631/ipp/print"
			}
			rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
			if err != nil || len(rows) != 1 {
				t.Fatalf("rows=%+v error=%v", rows, err)
			}
			got := rows[0]
			if got.ID != prior.ID || got.Endpoint != prior.Endpoint || got.Enabled || verifiedIPPUUIDFromCapabilities(got.Capabilities) != registryIPPUUIDA {
				t.Fatalf("different physical printer replaced an established binding: %+v", got)
			}
			if got.Status != "unknown" || got.Capabilities["geometry"] != nil || got.Capabilities["ipp_capabilities"] != nil {
				t.Fatalf("conflicting identity retained fresh readiness or geometry: %+v", got)
			}
			reloaded, err := LoadRegistryPrinters(path)
			if err != nil || len(reloaded) != 1 || verifiedIPPUUIDFromCapabilities(reloaded[0].Capabilities) != registryIPPUUIDA {
				t.Fatalf("identity fence did not survive reload: %+v %v", reloaded, err)
			}
		})
	}
}

func TestRegistryIPPWeakerUUIDCannotEraseVerifiedIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := registryIPPIdentityFixture("historical-id", "ipp://192.168.1.20/ipp/print", registryIPPUUIDA)
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	incoming := prior
	incoming.Capabilities = map[string]interface{}{"uuid": registryIPPUUIDB, "printer_uuid": registryIPPUUIDB}
	rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
	if err != nil || len(rows) != 1 {
		t.Fatal(err)
	}
	if rows[0].Capabilities["uuid"] != registryIPPUUIDA || rows[0].Capabilities["printer_uuid"] != registryIPPUUIDA || verifiedIPPUUIDFromCapabilities(rows[0].Capabilities) != registryIPPUUIDA {
		t.Fatalf("unverified metadata replaced verified identity aliases: %+v", rows[0].Capabilities)
	}
}

func TestDiscoveryMergeRejectsConflictingVerifiedIPPUUID(t *testing.T) {
	prior := registryIPPIdentityFixture("same-id", "ipp://192.168.1.20/ipp/print", registryIPPUUIDA)
	incoming := registryIPPIdentityFixture(prior.ID, prior.Endpoint, registryIPPUUIDB)
	got := mergeDeviceInfo(prior, incoming)
	if verifiedIPPUUIDFromCapabilities(got.Capabilities) != registryIPPUUIDA || got.Status != "unknown" || got.Capabilities["geometry"] != nil {
		t.Fatalf("live discovery silently merged different printers: %+v", got)
	}
}

func TestRegistryIPPSameVerifiedServiceUUIDKeepsHistoricalIDAfterAddressChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := registryIPPIdentityFixture("historical-id", "ipp://192.168.1.20/ipp/print", registryIPPUUIDA)
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	incoming := registryIPPIdentityFixture("new-address-id", "ipp://192.168.1.21/ipp/print", registryIPPUUIDA)
	incoming.NetworkAddress = "192.168.1.21"
	// Only an actual discovery observation can establish UUID continuity at
	// a new endpoint. A manual declaration of the same UUID cannot do so.
	incoming.Capabilities["registration_source"] = "discovery"
	rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
	if err != nil || len(rows) != 1 || rows[0].ID != prior.ID || rows[0].Enabled {
		t.Fatalf("same verified IPP service lost ID or operator intent: %+v %v", rows, err)
	}
	// UUID continuity across a different IPP destination cannot silently
	// rebind the established queue: keep the registered endpoint and wait for
	// explicit operator reconciliation.
	if rows[0].Endpoint != prior.Endpoint || rows[0].Capabilities["identity_collision"] != "same_hardware_different_network_binding" {
		t.Fatalf("verified UUID silently rebound to a different IPP destination: %+v", rows[0])
	}
}

func TestConfiguredIPPDiagnosticRetainsPersistedVerifiedUUID(t *testing.T) {
	target := registryIPPIdentityFixture("configured", "ipp://192.168.1.20/ipp/print", registryIPPUUIDA)
	cfg := &config.Config{Printers: []config.PrinterConfig{{ID: target.ID, Name: target.Name, Type: "ipp", Protocol: "ipp", Endpoint: target.Endpoint}}}
	pc := printerConfigForTest(cfg, &target)
	if verifiedIPPUUIDFromCapabilities(pc.Capabilities) != registryIPPUUIDA {
		t.Fatal("configured diagnostic discarded the registry's verified printer identity")
	}
}
