package agent

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/queue"
)

func TestUnreadableRegistryCannotPublishFallbackDiscovery(t *testing.T) {
	for _, live := range []bool{false, true} {
		name := "startup"
		if live {
			name = "live"
		}
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			original := []byte(`[{"id":"established","enabled":false} interrupted`)
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			a := &Agent{cfg: &config.Config{}, registryPath: path}
			observed := []printer.DeviceInfo{{ID: "established", Name: "Receipt", PrinterType: "thermal", ConnectionType: "network", Protocol: "raw", Endpoint: "10.0.0.10:9100", Enabled: true}}
			var retained []printer.DeviceInfo
			var err error
			if live {
				retained, err = a.persistLiveDiscovery(printer.DiscoveryResult{Printers: observed})
			} else {
				retained, err = a.persistDiscoveredPrinters(observed)
			}
			if !errors.Is(err, printer.ErrRegistryUntrusted) || len(retained) != 0 {
				t.Fatalf("unreadable operator authority was bypassed by executable observations: retained=%+v error=%v", retained, err)
			}
			current, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(current, original) {
				t.Fatalf("damaged authority was moved or rewritten: %v", err)
			}
		})
	}
}

func TestUnreadableRegistryBlocksStartupBeforeConfiguredBackend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	queuePath := config.QueueDBPath(path)
	q, err := queue.New(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.BeginPrint("unresolved", "established", []byte("document"), "original-claim", false); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatusWithError("unresolved", "failed", printer.MarkUnknown("transport interrupted after output").Error()); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	queueBefore, err := os.ReadFile(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	registryPath := config.RegistryPath(path)
	original := []byte(`[{"id":"established","enabled":false} interrupted`)
	if err := os.WriteFile(registryPath, original, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Printers: []config.PrinterConfig{{ID: "established", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "10.0.0.10:9100"}}}
	a, err := New(cfg, path)
	if a != nil {
		defer a.queue.Close()
	}
	if !errors.Is(err, printer.ErrRegistryUntrusted) || a != nil {
		t.Fatalf("startup accepted configured printing despite unreadable saved authority: agent=%v error=%v", a != nil, err)
	}
	current, err := os.ReadFile(registryPath)
	if err != nil || !bytes.Equal(current, original) {
		t.Fatalf("startup moved or rewrote damaged authority: %v", err)
	}
	queueAfter, err := os.ReadFile(queuePath)
	if err != nil || !bytes.Equal(queueAfter, queueBefore) {
		t.Fatalf("blocked startup changed the durable queue: %v", err)
	}
	recovered, err := queue.New(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	if pending, err := recovered.PendingTerminalReports(10); err != nil || len(pending) != 1 || pending[0].ID != "unresolved" || pending[0].ClaimToken != "original-claim" {
		t.Fatalf("registry failure lost pending outcome reconciliation: pending=%+v error=%v", pending, err)
	}
}

func TestMissingRegistryAllowsFirstInstallStartup(t *testing.T) {
	a, err := New(&config.Config{}, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("missing registry blocked first-install startup: %v", err)
	}
	defer a.queue.Close()
}
