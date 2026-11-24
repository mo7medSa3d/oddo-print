package printer

import (
	"path/filepath"
	"testing"
)

func TestPhysicalIdentityRejectsNormalizedPlaceholders(t *testing.T) {
	for _, value := range []string{"urn:uuid:unknown", "URN:UUID:null", "urn:uuid:", "00000000-0000-0000-0000-000000000000", "urn:uuid:00000000-0000-0000-0000-000000000000"} {
		t.Run(value, func(t *testing.T) {
			d := DeviceInfo{NetworkAddress: "192.168.1.20", Port: 9100, Capabilities: map[string]interface{}{"uuid": value}}
			if key, ok := physicalIdentityKey(d); ok {
				t.Fatalf("placeholder became physical identity: %q", key)
			}
			if got, want := StableIDForDevice(d), StableIDFromNetwork(d.NetworkAddress, d.Port); got != want {
				t.Fatalf("placeholder must retain endpoint identity: got %s want %s", got, want)
			}
		})
	}
}

func TestRegistryNilUUIDCannotMergePhysicalDestinations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	a := DeviceInfo{Name: "Office", PrinterType: "physical", ConnectionType: "network", Protocol: "raw", Endpoint: "192.168.1.20:9100", NetworkAddress: "192.168.1.20", Port: 9100, Enabled: true, Capabilities: map[string]interface{}{"uuid": "urn:uuid:00000000-0000-0000-0000-000000000000"}}
	b := a
	b.Endpoint, b.NetworkAddress = "192.168.1.21:9100", "192.168.1.21"
	rows, err := UpsertRegistry(path, []DeviceInfo{a, b})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID == rows[1].ID {
		t.Fatalf("nil UUID merged separate printers: %+v", rows)
	}
	if rows[0].Endpoint != a.Endpoint || rows[1].Endpoint != b.Endpoint {
		t.Fatalf("placeholder redirected selected printer: %+v", rows)
	}
}
