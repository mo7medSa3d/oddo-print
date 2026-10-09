package printer

import (
	"path/filepath"
	"sync"
	"testing"
)

// The observation boundary has the shape emitted by EnumPrinters/GetPrinter;
// all reconciliation, persistence and classification below are production code.
func continuitySpooler(name, port, driver string) DeviceInfo {
	d := DeviceInfo{Name: name, SpoolerName: name, Endpoint: name,
		ConnectionType: "spooler", Protocol: "spooler", PrinterType: "thermal",
		SpoolerPort: port, SpoolerDriver: driver, Status: "unknown", Enabled: true,
		Capabilities: map[string]interface{}{"discovered_via": SourceSpooler,
			"registration_source": "discovery", "spooler_scope": "machine_local",
			"port_name": port, "driver_name": driver}}
	d.ID = StableIDForDevice(d)
	return d
}

func TestRegistrySpoolerRetainsBindingAcrossDetailLoss(t *testing.T) {
	for _, tc := range []struct {
		name, port, driver string
		legacy             bool
	}{
		{"both-details", "", "", false}, {"driver-only", "USB001", "", false},
		{"port-only", "", "Generic Thermal", false}, {"legacy-capabilities", "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			original := continuitySpooler("POS80 Printer", "USB001", "Generic Thermal")
			if tc.legacy {
				original.SpoolerPort = ""
				original.SpoolerDriver = ""
			}
			original.Enabled = false
			original.Capabilities["receipt_raster_dots"] = float64(512)
			rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{original}, map[string]bool{SourceSpooler: true})
			if err != nil || len(rows) != 1 {
				t.Fatalf("seed: %v %+v", err, rows)
			}
			id := rows[0].ID
			partial := continuitySpooler("POS80 Printer", tc.port, tc.driver)
			for _, observation := range []DeviceInfo{partial, continuitySpooler("POS80 Printer", "USB001", "Generic Thermal"), partial} {
				rows, err = ReconcileDiscoveryRegistry(path, []DeviceInfo{observation}, map[string]bool{SourceSpooler: true})
				if err != nil || len(rows) != 1 || rows[0].ID != id {
					t.Fatalf("identity changed: want %s got %+v err=%v", id, rows, err)
				}
				if rows[0].Enabled || rows[0].Capabilities["receipt_raster_dots"] != float64(512) {
					t.Fatalf("operator configuration lost: %+v", rows[0])
				}
				if _, ok := physicalIdentityKey(rows[0]); !ok {
					t.Fatal("last-known strong identity erased by optional detail loss")
				}
				durable, err := LoadRegistryPrinters(path)
				if err != nil || len(durable) != 1 || durable[0].ID != id {
					t.Fatalf("durable identity lost: %+v %v", durable, err)
				}
			}
		})
	}
}

func TestRegistrySpoolerEnrichmentKeepsEstablishedWeakID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	weak := continuitySpooler("Kitchen Printer", "", "")
	if err := SaveRegistry(path, []DeviceInfo{weak}); err != nil {
		t.Fatal(err)
	}
	strong := continuitySpooler("Kitchen Printer", "USB001", "Generic Thermal")
	rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{strong}, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 1 || rows[0].ID != weak.ID {
		t.Fatalf("enrichment replaced established binding: %+v %v", rows, err)
	}
	if rows[0].SpoolerPort != "USB001" || rows[0].SpoolerDriver != "Generic Thermal" {
		t.Fatalf("fresh details not retained: %+v", rows[0])
	}
}

func TestRegistrySpoolerContinuityCannotUseDisplayNamesOrOtherServers(t *testing.T) {
	for _, mode := range []string{"different-queue", "spaces-not-underscores", "different-server", "different-scope"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			prior := continuitySpooler("Queue A", "USB001", "Generic Thermal")
			current := continuitySpooler("Queue A", "", "")
			switch mode {
			case "different-queue":
				current.SpoolerName = "Queue B"
				current.Endpoint = "Queue B"
			case "spaces-not-underscores":
				current.SpoolerName = "Queue_A"
				current.Endpoint = "Queue_A"
			case "different-server":
				prior.SpoolerServer = `\\server-a`
				current.SpoolerServer = `\\server-b`
			case "different-scope":
				current.Capabilities["spooler_scope"] = "user_connections"
			}
			// Supplied observation IDs differ. Neither a common display name
			// nor optional-detail loss is authority to combine these queues.
			prior.ID = "established-a"
			current.ID = "observed-b"
			if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
				t.Fatal(err)
			}
			rows, err := UpsertRegistry(path, []DeviceInfo{current})
			if err != nil || len(rows) != 2 {
				t.Fatalf("unrelated queue adopted existing identity: %+v %v", rows, err)
			}
		})
	}
}

func TestRegistrySpoolerContradictoryDetailsCannotRebind(t *testing.T) {
	for _, mode := range []string{"port", "driver", "share", "strong-identity"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			prior := continuitySpooler("POS Printer", "USB001", "Generic Thermal")
			current := continuitySpooler("POS Printer", "", "")
			switch mode {
			case "port":
				current.SpoolerPort = "USB002"
				current.Capabilities["port_name"] = "USB002"
			case "driver":
				current.SpoolerDriver = "Different Thermal"
				current.Capabilities["driver_name"] = "Different Thermal"
			case "share":
				prior.SpoolerShare = "first"
				current.SpoolerShare = "second"
			case "strong-identity":
				current = continuitySpooler("POS Printer", "USB002", "Generic Thermal")
			}
			prior.ID = "established-a"
			current.ID = "observed-b"
			if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
				t.Fatal(err)
			}
			rows, err := UpsertRegistry(path, []DeviceInfo{current})
			if err != nil || len(rows) != 2 {
				t.Fatalf("conflicting evidence rebound durable identity: %+v %v", rows, err)
			}
		})
	}
}

func TestRegistrySpoolerAmbiguousWeakObservationCannotChooseBinding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	first := continuitySpooler("Same Queue", "USB001", "Generic Thermal")
	second := continuitySpooler("Same Queue", "USB002", "Generic Thermal")
	first.ID = "binding-a"
	second.ID = "binding-b"
	if err := SaveRegistry(path, []DeviceInfo{first, second}); err != nil {
		t.Fatal(err)
	}
	observation := continuitySpooler("Same Queue", "", "")
	rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{observation}, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 2 {
		t.Fatalf("ambiguous observation replaced or pruned established rows: %+v %v", rows, err)
	}
	found := map[string]bool{}
	for _, row := range rows {
		found[row.ID] = true
	}
	if !found[first.ID] || !found[second.ID] {
		t.Fatalf("arbitrary binding selected: %+v", rows)
	}
}

func TestRegistrySpoolerEnrichmentPreservesExplicitRegistration(t *testing.T) {
	for _, source := range []string{"manual", "config"} {
		t.Run(source, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			prior := continuitySpooler("Explicit Printer", "USB001", "Generic Thermal")
			prior.Capabilities["registration_source"] = source
			prior.Enabled = false
			if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
				t.Fatal(err)
			}
			for _, observation := range []DeviceInfo{continuitySpooler("Explicit Printer", "", ""), continuitySpooler("Explicit Printer", "USB001", "Generic Thermal")} {
				rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{observation}, map[string]bool{SourceSpooler: true})
				if err != nil || len(rows) != 1 || rows[0].ID != prior.ID || rows[0].Capabilities["registration_source"] != source || rows[0].Enabled {
					t.Fatalf("explicit ownership was demoted: %+v %v", rows, err)
				}
			}
			rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: true})
			if err != nil || len(rows) != 1 || rows[0].ID != prior.ID {
				t.Fatalf("missing scan deleted explicit registration: %+v %v", rows, err)
			}
		})
	}
}

func TestRegistrySpoolerStrongRenamePreservesExplicitIntent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := continuitySpooler("Receipt Printer", "USB001", "Generic Thermal")
	prior.ID = "legacy-explicit-binding"
	prior.Enabled = false
	prior.Capabilities["registration_source"] = "manual"
	prior.Capabilities["receipt_raster_dots"] = float64(512)
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	current := continuitySpooler("Renamed Receipt Printer", "USB001", "Generic Thermal")
	rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{current}, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 1 || rows[0].ID != prior.ID {
		t.Fatalf("rename lost binding: %+v %v", rows, err)
	}
	if rows[0].Enabled || rows[0].Capabilities["registration_source"] != "manual" || rows[0].Capabilities["receipt_raster_dots"] != float64(512) {
		t.Fatalf("identity-preserving rename destroyed explicit intent: %+v", rows[0])
	}
	if rows[0].SpoolerName != current.SpoolerName || rows[0].Endpoint != current.Endpoint {
		t.Fatalf("rename did not update execution queue: %+v", rows[0])
	}
}

func TestRegistrySpoolerConcurrentEnrichmentKeepsOneDurableBinding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := continuitySpooler("Concurrent Printer", "USB001", "Generic Thermal")
	prior.ID = "persisted-binding"
	prior.Enabled = false
	prior.Capabilities["registration_source"] = "manual"
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errors := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			port, driver := "USB001", "Generic Thermal"
			if i%2 == 0 {
				port, driver = "", ""
			}
			_, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{continuitySpooler("Concurrent Printer", port, driver)}, map[string]bool{SourceSpooler: true})
			errors <- err
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	rows, err := LoadRegistryPrinters(path)
	if err != nil || len(rows) != 1 || rows[0].ID != prior.ID || rows[0].Enabled || rows[0].Capabilities["registration_source"] != "manual" {
		t.Fatalf("concurrent enrichment lost durable intent: %+v %v", rows, err)
	}
}
