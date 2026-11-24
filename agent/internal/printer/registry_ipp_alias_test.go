package printer

import (
	"path/filepath"
	"testing"
)

func TestManualIPPExecutionAliasesKeepOneRegistryIdentity(t *testing.T) {
	for _, tc := range []struct {
		name      string
		endpoints []string
	}{
		{"root_resource", []string{"ipp://192.168.1.20", "ipp://192.168.1.20/", "http://192.168.1.20:631/"}},
		{"default_resource", []string{"ipp://192.168.1.20/ipp/print", "http://192.168.1.20:631/ipp/print"}},
		{"named_resource", []string{"ipp://192.168.1.20/printers/Office", "http://192.168.1.20:631/printers/Office"}},
		{"secure_resource", []string{"ipps://192.168.1.20/printers/Office", "https://192.168.1.20:631/printers/Office"}},
		{"ipv6_spelling", []string{"ipp://[fd12:3456::10]/printers/Office", "ipp://[fd12:3456:0:0:0:0:0:10]/printers/Office"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			var establishedID string
			for _, endpoint := range tc.endpoints {
				rows, err := RegisterManual(path, DeviceInfo{
					Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: endpoint, Enabled: true,
				})
				if err != nil {
					t.Fatal(err)
				}
				if len(rows) != 1 {
					t.Fatalf("same IPP execution destination registered %d times after alias %q: %+v", len(rows), endpoint, rows)
				}
				if establishedID == "" {
					establishedID = rows[0].ID
				}
				if rows[0].ID != establishedID {
					t.Fatalf("alias replaced established printer identity %q with %q", establishedID, rows[0].ID)
				}
			}
		})
	}
}

func TestManualIPPAliasPreservesLegacyIDAndDisabledIntent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := DeviceInfo{ID: "legacy_ipp", Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "http://192.168.1.20:631/printers/Office", Enabled: false}
	if err := SaveRegistry(path, []DeviceInfo{legacy}); err != nil {
		t.Fatal(err)
	}
	rows, err := RegisterManual(path, DeviceInfo{Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/printers/Office", Enabled: true})
	if err != nil || len(rows) != 1 || rows[0].ID != "legacy_ipp" || rows[0].Enabled {
		t.Fatalf("re-add alias lost the existing identity or enabled a disabled printer: rows=%+v error=%v", rows, err)
	}
}

func TestManualIPPDistinctExecutionDestinationsStaySeparate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	endpoints := []string{
		"ipp://192.168.1.20/",
		"ipp://192.168.1.20/ipp/print",
		"ipp://192.168.1.20/printers/Office",
		"ipp://192.168.1.20/printers/office",
		"ipp://192.168.1.20:80/printers/Office",
		"ipps://192.168.1.20/printers/Office",
		"ipp://192.168.1.21/printers/Office",
	}
	for index, endpoint := range endpoints {
		rows, err := RegisterManual(path, DeviceInfo{Name: "Same displayed name", ConnectionType: "ipp", Protocol: "ipp", Endpoint: endpoint, Enabled: true})
		if err != nil || len(rows) != index+1 {
			t.Fatalf("distinct destination %q was collapsed: rows=%+v error=%v", endpoint, rows, err)
		}
	}
}

func TestManualIPPAliasDoesNotChooseBetweenLegacyIdentities(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := []DeviceInfo{
		{ID: "legacy_one", Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/printers/Office", Enabled: false},
		{ID: "legacy_two", Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "http://192.168.1.20:631/printers/Office", Enabled: true},
	}
	if err := SaveRegistry(path, legacy); err != nil {
		t.Fatal(err)
	}
	rows, err := RegisterManual(path, DeviceInfo{Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20:631/printers/Office", Enabled: true})
	if err != nil || len(rows) != 2 || rows[0].ID != "legacy_one" || rows[0].Enabled || rows[1].ID != "legacy_two" || !rows[1].Enabled {
		t.Fatalf("ambiguous legacy aliases were changed or a third identity was invented: rows=%+v error=%v", rows, err)
	}
}

func TestLegacySecureDefaultQueueIDCannotBeReboundToPlainIPP(t *testing.T) {
	host := "192.168.1.20"
	legacyID := StableIDFromNetwork(host, 631)
	secureEndpoint := "ipps://" + host + ":631/ipp/print"
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := DeviceInfo{
		ID: legacyID, Name: "Saved secure queue",
		PrinterType: "physical", ConnectionType: "ipps", Protocol: "ipps",
		Endpoint: secureEndpoint, NetworkAddress: host, Port: 631,
		Enabled: false, Status: "online",
	}
	if err := SaveRegistry(path, []DeviceInfo{legacy}); err != nil {
		t.Fatal(err)
	}
	// A plain endpoint discovered by an older TCP scanner has the same
	// historical generated ID. It must not overwrite the secure endpoint,
	// upgrade the saved opt-out, or claim fresh health evidence for it.
	rows, err := UpsertRegistry(path, []DeviceInfo{{
		Name: "Untrusted plain discovery", PrinterType: "physical",
		ConnectionType: "ipp", Protocol: "ipp",
		Endpoint:       "ipp://" + host + ":631/ipp/print",
		NetworkAddress: host, Port: 631, Enabled: true, Status: "online",
	}})
	if err != nil || len(rows) != 1 {
		t.Fatalf("unsafe legacy ID reconciliation: rows=%+v err=%v", rows, err)
	}
	if rows[0].ID != legacyID || rows[0].Endpoint != secureEndpoint ||
		rows[0].Enabled || rows[0].Status != "unknown" {
		t.Fatalf("insecure discovery silently took over saved secure queue: %+v", rows[0])
	}
}
