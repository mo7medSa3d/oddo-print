package printer

import (
	"path/filepath"
	"testing"
)

func TestStableIDUUIDURNPrefixIsCaseInsensitive(t *testing.T) {
	const uuid = "5ba94674-bb0d-4f8d-9f5e-f497ef44f248"
	lower := DeviceInfo{Capabilities: map[string]interface{}{"uuid": "urn:uuid:" + uuid}}
	for _, raw := range []string{"URN:UUID:" + uuid, "UrN:UuId:" + uuid, uuid} {
		t.Run(raw, func(t *testing.T) {
			candidate := DeviceInfo{Capabilities: map[string]interface{}{"uuid": raw}}
			if got, want := StableIDForDevice(candidate), StableIDForDevice(lower); got != want {
				t.Fatalf("UUID spelling created a second printer identity: got %s want %s", got, want)
			}
		})
	}
}

func TestRegistryUUIDCaseChangeRetainsIdentityAndDisablement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := DeviceInfo{
		ID: "established-printer-id", Name: "Office", PrinterType: "physical",
		ConnectionType: "network", Protocol: "raw", Endpoint: "192.168.1.20:9100",
		NetworkAddress: "192.168.1.20", Port: 9100, Enabled: false,
		Capabilities: map[string]interface{}{"uuid": "URN:UUID:5BA94674-BB0D-4F8D-9F5E-F497EF44F248"},
	}
	if _, err := UpsertRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	incoming := prior
	incoming.ID = "rediscovered-printer-id"
	incoming.Endpoint, incoming.NetworkAddress = "192.168.1.55:9100", "192.168.1.55"
	incoming.Enabled = true
	incoming.Capabilities = map[string]interface{}{"uuid": "urn:uuid:5ba94674-bb0d-4f8d-9f5e-f497ef44f248"}
	rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != prior.ID || rows[0].Enabled {
		t.Fatalf("UUID spelling duplicated or re-enabled saved printer: %+v", rows)
	}
	// The chassis UUID cannot silently rebind the registered network
	// destination: a DHCP move on the same hardware keeps the old endpoint and
	// waits for explicit operator reconciliation instead.
	if rows[0].Endpoint != prior.Endpoint || rows[0].NetworkAddress != prior.NetworkAddress {
		t.Fatalf("different network destination silently rebound the same hardware: got %q", rows[0].Endpoint)
	}
	if rows[0].Capabilities["identity_collision"] != "same_hardware_different_network_binding" {
		t.Fatalf("moved endpoint on the same hardware must be flagged for reconciliation: %+v", rows[0])
	}
}

func TestStableIDUUIDCaseNormalizationKeepsDifferentDevicesSeparate(t *testing.T) {
	a := DeviceInfo{Capabilities: map[string]interface{}{"uuid": "URN:UUID:5ba94674-bb0d-4f8d-9f5e-f497ef44f248"}}
	b := DeviceInfo{Capabilities: map[string]interface{}{"uuid": "urn:uuid:5ba94674-bb0d-4f8d-9f5e-f497ef44f249"}}
	if StableIDForDevice(a) == StableIDForDevice(b) {
		t.Fatal("different UUIDs collapsed to one printer")
	}
}
