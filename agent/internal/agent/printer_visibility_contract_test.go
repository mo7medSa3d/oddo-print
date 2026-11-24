package agent

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

// WP3: the heartbeat sharing view must include locally runtime-registered
// spooler printers, so one unrelated deny cannot privatise them (and their
// heartbeat rows cannot silently vanish). Gateway-owned desired-state rows
// are deliberately NOT included: a cloud-only destination still needs
// explicit local registration before it stops being private.
func TestHeartbeatSharingViewKeepsRuntimeRegisteredSpooler(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	cfg := &config.Config{}
	if err := cfg.Save(path); err != nil {
		t.Fatal(err)
	}
	denied := config.PrinterConfig{ID: "denied-local", Name: "Private", Type: "spooler", Protocol: "spooler", SpoolerName: "Private POS80"}
	runtimeLocal := config.PrinterConfig{ID: "runtime-local", Name: "Receipt", Type: "spooler", Protocol: "spooler", SpoolerName: "Receipt queue",
		Capabilities: map[string]interface{}{"registration_source": "discovery"}}
	gatewayCloud := config.PrinterConfig{ID: "gateway-cloud", Name: "Cloud", Type: "spooler", Protocol: "spooler", SpoolerName: `\\host.example.test\NativeShare`}
	// A runtime backend for a desired row: cloud intent, not local
	// permission, even though a backend object exists for it.
	desiredRuntime := config.PrinterConfig{ID: "desired-runtime", Name: "Desired", Type: "spooler", Protocol: "spooler", SpoolerName: `\\host.example.test\DesiredShare`}
	if err := config.SetPrinterVisibility(path, denied, nil, false); err != nil {
		t.Fatal(err)
	}
	a := &Agent{
		cfg:          cfg,
		configPath:   path,
		registryPath: config.RegistryPath(path),
		printerConfigs: map[string]config.PrinterConfig{
			"denied-local":    denied,
			"runtime-local":   runtimeLocal,
			"gateway-cloud":   gatewayCloud,
			"desired-runtime": desiredRuntime,
		},
	}
	snapshot := a.loadLocalPrinterVisibility()
	if snapshot.err != nil {
		t.Fatalf("sharing snapshot error: %v", snapshot.err)
	}
	if shared, err := snapshot.shared(runtimeLocal); err != nil || !shared {
		t.Fatalf("runtime-registered spooler privatised by unrelated deny: shared=%v err=%v", shared, err)
	}
	if shared, err := snapshot.shared(gatewayCloud); err != nil || shared {
		t.Fatalf("cloud-only desired spooler self-authorized: shared=%v err=%v", shared, err)
	}
	if shared, err := snapshot.shared(desiredRuntime); err != nil || shared {
		t.Fatalf("desired-state runtime backend authorized an unobserved destination: shared=%v err=%v", shared, err)
	}
	if shared, err := snapshot.shared(denied); err != nil || shared {
		t.Fatalf("denied spooler became shared: shared=%v err=%v", shared, err)
	}
	// Membership only: the synthetic desired row above has no wire
	// config, so hiddenPrinterIDs reports its own (empty) entry as
	// incomplete — that artifact is not the sharing decision under test.
	private, _ := a.hiddenPrinterIDs(snapshot)
	seen := map[string]bool{}
	for _, id := range private {
		seen[id] = true
	}
	if seen["runtime-local"] {
		t.Fatal("runtime-registered spooler landed in privatePrinterIds under an unrelated deny")
	}
	if !seen["denied-local"] || !seen["gateway-cloud"] || !seen["desired-runtime"] {
		t.Fatalf("private set wrong: %v", private)
	}
}
