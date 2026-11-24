package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestInitialDiscoveryPartialResultKeepsLiveWorkerOwnership(t *testing.T) {
	a := &Agent{cfg: &config.Config{}, registryPath: filepath.Join(t.TempDir(), "printers.json"), discoverySem: make(chan struct{}, 1)}
	release, finished := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		close(release)
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("startup discovery worker did not finish after release")
		}
	})

	a.runInitialDiscovery(context.Background(), 20*time.Millisecond, func(_ context.Context, progress printer.DiscoveryProgressFunc) printer.DiscoveryResult {
		defer close(finished)
		progress(printer.DiscoveryResult{Printers: []printer.DeviceInfo{}})
		<-release // a native discovery call may ignore cancellation
		return printer.DiscoveryResult{Printers: []printer.DeviceInfo{}}
	})
	if _, err := os.Stat(a.registryPath); err != nil {
		t.Fatalf("usable partial inventory was not persisted: %v", err)
	}
	secondStarted := false
	a.runInitialDiscovery(context.Background(), time.Second, func(context.Context, printer.DiscoveryProgressFunc) printer.DiscoveryResult {
		secondStarted = true
		return printer.DiscoveryResult{}
	})
	if secondStarted || len(a.discoverySem) != 1 {
		t.Fatal("partial startup result released the scan slot while the original native worker was still alive")
	}
}

func TestInitialDiscoveryCompletedWorkerReleasesOwnership(t *testing.T) {
	a := &Agent{cfg: &config.Config{}, registryPath: filepath.Join(t.TempDir(), "printers.json"), discoverySem: make(chan struct{}, 1)}
	a.runInitialDiscovery(context.Background(), time.Second, func(context.Context, printer.DiscoveryProgressFunc) printer.DiscoveryResult {
		return printer.DiscoveryResult{Printers: []printer.DeviceInfo{}}
	})
	if len(a.discoverySem) != 0 {
		t.Fatal("finished startup discovery retained its scan slot")
	}
}
