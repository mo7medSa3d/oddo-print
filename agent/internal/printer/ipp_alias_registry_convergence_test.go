package printer

import (
	"path/filepath"
	"testing"
)

// A change in the spelling of an IPP resource must never create a new
// printer record or silently clear explicit local disablement. This checks
// the persistent registry boundary, not only the pure stable-ID function.
func TestIPPNonDefaultQueueAliasesKeepRegistryIdentityAndDisablement(t *testing.T) {
	for _, tc := range []struct {
		name, protocol, original, alias string
	}{
		{"plain", "ipp", "ipp://192.168.1.20:631/printers/office", "http://192.168.1.20:631/printers/office"},
		{"secure", "ipps", "ipps://192.168.1.20:631/printers/office", "https://192.168.1.20:631/printers/office"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			original := DeviceInfo{ID: "original-printer-id", Name: "Office receipts", PrinterType: "physical",
				ConnectionType: tc.protocol, Protocol: tc.protocol, Endpoint: tc.original,
				NetworkAddress: "192.168.1.20", Port: 631, Enabled: false}
			if err := SaveRegistry(path, []DeviceInfo{original}); err != nil {
				t.Fatal(err)
			}
			observed := DeviceInfo{Name: "Office receipts", PrinterType: "physical",
				ConnectionType: tc.protocol, Protocol: tc.protocol, Endpoint: tc.alias,
				NetworkAddress: "192.168.1.20", Port: 631, Enabled: true, Status: "online"}
			rows, err := UpsertRegistry(path, []DeviceInfo{observed})
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].ID != original.ID || rows[0].Enabled {
				t.Fatalf("IPP URI alias forked a persisted printer or overrode operator disablement: %+v", rows)
			}
			persisted, err := LoadRegistryPrinters(path)
			if err != nil || len(persisted) != 1 || persisted[0].ID != original.ID || persisted[0].Enabled {
				t.Fatalf("IPP alias did not preserve the durable original: rows=%+v err=%v", persisted, err)
			}
		})
	}
}
