package printer

import (
	"path/filepath"
	"testing"
)

// Nil UUIDs are missing evidence even when a discovery source uses a GUID
// wrapper or the compact spelling. Never merge distinct destinations on them.
func TestNilUUIDEncodingsKeepRegistryDestinationsSeparate(t *testing.T) {
	for _, value := range []string{
		"{00000000-0000-0000-0000-000000000000}",
		"00000000000000000000000000000000",
		"urn:uuid:{00000000-0000-0000-0000-000000000000}",
	} {
		for _, key := range []string{"uuid", "printer_uuid"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				a := DeviceInfo{Name: "Office", PrinterType: "physical", ConnectionType: "network", Protocol: "raw", Endpoint: "192.168.1.20:9100", NetworkAddress: "192.168.1.20", Port: 9100, Enabled: true, Capabilities: map[string]interface{}{key: value}}
				b := a
				b.Endpoint, b.NetworkAddress = "192.168.1.21:9100", "192.168.1.21"
				rows, err := UpsertRegistry(filepath.Join(t.TempDir(), "printers.json"), []DeviceInfo{a, b})
				if err != nil {
					t.Fatal(err)
				}
				if len(rows) != 2 || rows[0].ID == rows[1].ID {
					t.Fatalf("nil UUID spelling collapsed distinct physical printers: %+v", rows)
				}
			})
		}
	}
}

func TestNilUUIDEncodingFallsBackToRealSerial(t *testing.T) {
	d := DeviceInfo{Capabilities: map[string]interface{}{"uuid": "{00000000-0000-0000-0000-000000000000}", "serial": "real-device-001"}}
	if key, ok := physicalIdentityKey(d); !ok || key != "serial:real-device-001|manufacturer:|model:" {
		t.Fatalf("nil UUID hid actual serial identity: %q, %v", key, ok)
	}
}
