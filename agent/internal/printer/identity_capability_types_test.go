package printer

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestPhysicalIdentityRejectsNonStringCapabilities(t *testing.T) {
	for _, key := range []string{"uuid", "printer_uuid", "serial", "mac", "mac_address", "macAddress"} {
		for _, value := range []interface{}{nil, false, true, float64(42), []interface{}{"serial"}, map[string]interface{}{"id": "serial"}} {
			t.Run(fmt.Sprintf("%s/%T/%v", key, value, value), func(t *testing.T) {
				d := DeviceInfo{NetworkAddress: "192.168.1.20", Port: 9100, Capabilities: map[string]interface{}{key: value}}
				if identity, ok := physicalIdentityKey(d); ok {
					t.Fatalf("untyped capability was promoted into physical identity: %q", identity)
				}
				if got, want := StableIDForDevice(d), StableIDFromNetwork(d.NetworkAddress, d.Port); got != want {
					t.Fatalf("invalid identity must use endpoint fallback: got %s want %s", got, want)
				}
			})
		}
	}
}

func TestRegistryMalformedIdentityCannotOverwriteAnotherPrinter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	a := DeviceInfo{
		Name: "Office", PrinterType: "physical", ConnectionType: "network", Protocol: "raw",
		Endpoint: "192.168.1.20:9100", NetworkAddress: "192.168.1.20", Port: 9100,
		Enabled: true, Capabilities: map[string]interface{}{"uuid": nil},
	}
	b := a
	b.Endpoint, b.NetworkAddress = "192.168.1.21:9100", "192.168.1.21"
	rows, err := UpsertRegistry(path, []DeviceInfo{a, b})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID == rows[1].ID {
		t.Fatalf("untyped UUID merged distinct physical destinations: %+v", rows)
	}
	if rows[0].Endpoint != a.Endpoint || rows[1].Endpoint != b.Endpoint {
		t.Fatalf("malformed identity overwrote a configured destination: %+v", rows)
	}
}
