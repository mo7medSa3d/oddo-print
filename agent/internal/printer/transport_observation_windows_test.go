//go:build windows

package printer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUSBHandleProbePreservesUnknownHealthAndClearsLostAccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "probe-handle")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	p := nativeUSBPrintFixture("probe", "Probe", path)
	if status := p.Status(); status != "unknown" || !p.TransportObserved() {
		t.Fatalf("accessible handle: status=%q observed=%v", status, p.TransportObserved())
	}
	p.DevicePath = filepath.Join(filepath.Dir(path), "absent")
	if status := p.Status(); status != "unknown" || p.TransportObserved() {
		t.Fatalf("lost handle access retained old observation: status=%q observed=%v", status, p.TransportObserved())
	}
}
