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
