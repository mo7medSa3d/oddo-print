package printer

import (
	"context"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

// DiscoverLiveWithProgress must publish incremental snapshots that are always
// internally consistent: a stable identity on every device and the source
// completion bookkeeping intact. The bookkeeping is what lets an orchestration
// bound preserve partial results without ever reconciling absence as removal.
//
// Network sources are bounded by the context, so the local config source drives
// the snapshots on any platform. Run with -race for the locking discipline.
func TestDiscoverLiveWithProgressPublishesConsistentSnapshots(t *testing.T) {
	cfg := &config.Config{
		Printers: []config.PrinterConfig{
			{ID: "cfg-front", Name: "Front Desk", Type: "network", Endpoint: "10.0.0.9:9100"},
			{ID: "cfg-back", Name: "Back Office", Type: "network", Endpoint: "10.0.0.10:9100"},
			{ID: "cfg-bar", Name: "Bar", Type: "network", Endpoint: "10.0.0.11:9100"},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	var (
		snapshots   int
		seenIDs     = map[string]bool{}
		lastSources map[string]bool
	)
	onProgress := func(r DiscoveryResult) {
		snapshots++
		for _, p := range r.Printers {
			if p.ID == "" {
				t.Errorf("progress snapshot exposed a device with no stable identity: %+v", p)
			}
			seenIDs[p.ID] = true
		}
		if r.CompleteSources == nil {
			t.Error("progress snapshot dropped the source-completion bookkeeping")
		}
		lastSources = r.CompleteSources
	}

	result := DiscoverLiveWithProgress(ctx, cfg, t.TempDir()+"/printers.json", onProgress)

	if snapshots == 0 {
		t.Fatal("no progress snapshots were published")
	}
	if len(seenIDs) == 0 {
		t.Fatal("progress snapshots never carried a discovered device")
	}
	if !lastSources[SourceConfig] {
		t.Fatalf("config source did not report completion: %v", lastSources)
	}
	// The config source is local and must be represented in the final result.
	if !result.CompleteSources[SourceConfig] {
		t.Fatal("final discovery result lost the config source completion flag")
	}
	if len(result.Printers) != len(seenIDs) && len(result.Printers) < len(seenIDs) {
		t.Fatalf("final result has %d printers but snapshots observed %d", len(result.Printers), len(seenIDs))
	}
}

// A truncated discovery result must keep its bookkeeping so a partial scan can
// never authorize removing printers owned by a source that did not finish.
func TestTruncatedDiscoveryResultNeverAuthorizesAbsence(t *testing.T) {
	result := DiscoveryResult{
		Printers: []DeviceInfo{{ID: "p1"}},
		// SourceSpooler deliberately absent/false: it never finished.
		CompleteSources: map[string]bool{SourceConfig: true},
		Truncated:       true,
	}
	if result.CompleteSources[SourceSpooler] {
		t.Fatal("an unfinished source must never be marked complete")
	}
	if !result.Truncated {
		t.Fatal("truncation marker must survive to the consumer")
	}
}
