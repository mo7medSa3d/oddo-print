package printer

import (
	"path/filepath"
	"testing"
)

func TestStableIDForDevicePrefersUUIDOverNetworkAddress(t *testing.T) {
	before := DeviceInfo{
		NetworkAddress: "10.0.0.20",
		Port:           9100,
		Capabilities:   map[string]interface{}{"uuid": "urn:uuid:ABC-123"},
	}
	after := before
	after.NetworkAddress = "10.0.0.55"
	if got, want := StableIDForDevice(before), StableIDForDevice(after); got != want {
		t.Fatalf("UUID identity changed across IP update: before=%s after=%s", got, want)
	}
}

func TestStableIDForDevicePrefersSerialOverNetworkAddress(t *testing.T) {
	before := DeviceInfo{
		NetworkAddress: "10.0.0.20",
		Port:           9100,
		Name:           "Office Printer",
		Capabilities:   map[string]interface{}{"serial": "SN-42", "manufacturer": "Zebra", "model": "ZD421"},
	}
	after := before
	after.NetworkAddress = "10.0.0.55"
	after.Name = "Office Printer New"
	if got, want := StableIDForDevice(before), StableIDForDevice(after); got != want {
		t.Fatalf("serial identity changed across IP/name update: before=%s after=%s", got, want)
	}
}

func TestDedupeKeySerialDoesNotDependOnDisplayName(t *testing.T) {
	a := DeviceInfo{
		Capabilities: map[string]interface{}{"serial": "SN-42", "manufacturer": "Zebra", "model": "ZD421"},
		Name:         "Old Name",
	}
	b := a
	b.Name = "New Name"
	if gotA, gotB := dedupeKey(a), dedupeKey(b); gotA != gotB {
		t.Fatalf("dedupe key changed on printer rename: %q != %q", gotA, gotB)
	}
}

func TestStableIDForSpoolerSurvivesQueueRename(t *testing.T) {
	a := DeviceInfo{
		SpoolerName:    "Receipt Front",
		SpoolerPort:    "USB001",
		SpoolerDriver:  "Generic Thermal",
		Protocol:       "spooler",
		ConnectionType: "spooler",
	}
	b := a
	b.SpoolerName = "Receipt Front Renamed"
	if gotA, gotB := StableIDForDevice(a), StableIDForDevice(b); gotA != gotB {
		t.Fatalf("spooler identity changed on queue rename: %s != %s", gotA, gotB)
	}
}

func TestUpsertRegistryPreservesLegacyIDWhenPhysicalIdentityMatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := DeviceInfo{
		ID:             "printer_net_legacy",
		Name:           "Office Printer",
		PrinterType:    "physical",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       "10.0.0.20:9100",
		NetworkAddress: "10.0.0.20",
		Port:           9100,
		Status:         "online",
		Enabled:        true,
		Capabilities:   map[string]interface{}{"serial": "SN-42", "manufacturer": "Zebra", "model": "ZD421"},
	}
	if _, err := UpsertRegistry(path, []DeviceInfo{legacy}); err != nil {
		t.Fatalf("seed registry: %v", err)
	}
	incoming := legacy
	incoming.ID = "printer_identity_new"
	incoming.Name = "Office Printer New"
	incoming.Endpoint = "10.0.0.55:9100"
	incoming.NetworkAddress = "10.0.0.55"
	rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
	if err != nil {
		t.Fatalf("upsert registry: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != legacy.ID {
		t.Fatalf("expected legacy ID %q to be preserved, got %#v", legacy.ID, rows)
	}
	if rows[0].NetworkAddress != "10.0.0.55" {
		t.Fatalf("expected endpoint to update to new IP, got %q", rows[0].NetworkAddress)
	}
}

func TestUpsertRegistryPreservesSpoolerIDAcrossQueueRename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := DeviceInfo{
		ID:             StableIDFromSpooler("Receipt Front"),
		Name:           "Receipt Front",
		SpoolerName:    "Receipt Front",
		SpoolerPort:    "USB001",
		SpoolerDriver:  "Generic Thermal",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		Status:         "online",
		Enabled:        true,
	}
	if _, err := UpsertRegistry(path, []DeviceInfo{legacy}); err != nil {
		t.Fatalf("seed spooler registry: %v", err)
	}

	incoming := legacy
	incoming.Name = "Receipt Front Renamed"
	incoming.SpoolerName = incoming.Name
	incoming.Endpoint = incoming.Name
	incoming.ID = StableIDForDevice(incoming)
	if incoming.ID == legacy.ID {
		t.Fatal("test precondition: stronger physical ID must differ from legacy name-derived ID")
	}

	rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
	if err != nil {
		t.Fatalf("upsert renamed spooler: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("renamed queue duplicated registry row: %#v", rows)
	}
	if rows[0].ID != legacy.ID {
		t.Fatalf("renamed queue lost established printer ID: got %q want %q", rows[0].ID, legacy.ID)
	}
	if rows[0].SpoolerName != incoming.SpoolerName || rows[0].Name != incoming.Name {
		t.Fatalf("renamed queue did not refresh display/spooler name: %#v", rows[0])
	}
}
func TestUpsertRegistryRefreshesSpoolerTupleWhenStrongIDSurvivesRename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	original := DeviceInfo{
		Name:           "Receipt Front",
		SpoolerName:    "Receipt Front",
		SpoolerPort:    "USB001",
		SpoolerDriver:  "Generic Thermal",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		Endpoint:       "Receipt Front",
		Status:         "online",
		Enabled:        true,
	}
	original.ID = StableIDForDevice(original)
	if _, err := UpsertRegistry(path, []DeviceInfo{original}); err != nil {
		t.Fatalf("seed registry: %v", err)
	}

	renamed := original
	renamed.Name = "Receipt Front Renamed"
	renamed.SpoolerName = renamed.Name
	renamed.Endpoint = renamed.Name
	if got := StableIDForDevice(renamed); got != original.ID {
		t.Fatalf("test precondition: strong spooler identity changed on rename: %s != %s", got, original.ID)
	}

	rows, err := UpsertRegistry(path, []DeviceInfo{renamed})
	if err != nil {
		t.Fatalf("upsert renamed spooler: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("renamed queue duplicated registry row: %#v", rows)
	}
	if rows[0].ID != original.ID {
		t.Fatalf("renamed queue changed stable ID: got %q want %q", rows[0].ID, original.ID)
	}
	if rows[0].SpoolerName != renamed.SpoolerName || rows[0].Endpoint != renamed.Endpoint {
		t.Fatalf("same-ID rename retained stale spooler tuple: %#v", rows[0])
	}
}

func TestUpsertRegistryMatchesLegacyCapabilityOnlySpoolerIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := DeviceInfo{
		ID:             StableIDFromSpooler("Receipt Front"),
		Name:           "Receipt Front",
		SpoolerName:    "Receipt Front",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		Endpoint:       "Receipt Front",
		Status:         "online",
		Enabled:        true,
		Capabilities: map[string]interface{}{
			"port_name":   "USB001",
			"driver_name": "Generic Thermal",
		},
	}
	if _, err := UpsertRegistry(path, []DeviceInfo{legacy}); err != nil {
		t.Fatalf("seed legacy registry: %v", err)
	}

	incoming := DeviceInfo{
		Name:           "Receipt Front Renamed",
		SpoolerName:    "Receipt Front Renamed",
		SpoolerPort:    "USB001",
		SpoolerDriver:  "Generic Thermal",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		Endpoint:       "Receipt Front Renamed",
		Status:         "online",
		Enabled:        true,
	}
	incoming.ID = StableIDForDevice(incoming)
	if incoming.ID == legacy.ID {
		t.Fatal("test precondition: strong identity ID must differ from legacy queue-name ID")
	}

	rows, err := UpsertRegistry(path, []DeviceInfo{incoming})
	if err != nil {
		t.Fatalf("upsert renamed spooler: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("legacy capability-only row was duplicated: %#v", rows)
	}
	if rows[0].ID != legacy.ID {
		t.Fatalf("legacy established ID was not preserved: got %q want %q", rows[0].ID, legacy.ID)
	}
	if rows[0].SpoolerName != incoming.SpoolerName || rows[0].SpoolerPort != "USB001" || rows[0].SpoolerDriver != "Generic Thermal" {
		t.Fatalf("legacy row did not migrate to current spooler identity tuple: %#v", rows[0])
	}
}
