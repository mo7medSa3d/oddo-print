package printer

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

// Legacy StableIDFromSpooler replaced spaces with underscores. Two distinct
// installed Windows queues can therefore share an ID even though their actual
// spooler names and physical execution destinations differ.
func TestQuickDiscoveryMustFenceTwoDistinctSpoolerQueuesWithSameLegacyID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	saved := continuitySpooler("Queue A", "USB001", "Office Driver")
	other := continuitySpooler("Queue_A", "USB001", "Office Driver")
	// Current strong IDs correctly keep distinct native queues separate.
	// Simulate persisted pre-upgrade weak IDs explicitly: legacy normalization
	// collapsed spaces and underscores before hashing. The collision fence
	// must still protect users upgrading from that historical registry.
	if saved.ID == other.ID {
		t.Fatal("new stable spooler identity must distinguish unrelated native queues")
	}
	legacyID := StableIDFromSpooler(saved.SpoolerName)
	if legacyID != StableIDFromSpooler(other.SpoolerName) {
		t.Fatal("legacy spooler algorithm no longer reproduces the fixture collision")
	}
	saved.ID = legacyID
	other.ID = legacyID
	saved.Capabilities["geometry"] = map[string]interface{}{"printer_id": saved.ID, "source": "windows_driver"}
	if err := SaveRegistry(path, []DeviceInfo{saved}); err != nil {
		t.Fatal(err)
	}
	// Config and registry complete concurrently, in either order. Neither
	// source's selection priority may silently hide the second live queue.
	cfg := &config.Config{Printers: []config.PrinterConfig{{
		ID:          other.ID,
		Name:        other.Name,
		Type:        "spooler",
		Protocol:    "spooler",
		Endpoint:    other.SpoolerName,
		SpoolerName: other.SpoolerName,
		PrinterType: "physical",
	}}}
	for i := 0; i < 10; i++ {
		result := DiscoverQuick(cfg, path)
		if len(result.Printers) != 1 {
			t.Fatalf("one quarantined identity expected, not an arbitrarily selected queue: %+v", result.Printers)
		}
		ambiguous := result.Printers[0]
		if got := ambiguous.Capabilities["identity_collision"]; got != "same_id_different_queue" {
			t.Fatalf("discovery silently merged different native queues into an executable ID: %+v", ambiguous)
		}
		if IsRuntimeDiscoveryPrinter(ambiguous) || ambiguous.Capabilities["geometry"] != nil {
			t.Fatalf("collision retained runnable or measured printer evidence: %+v", ambiguous)
		}
	}
}
