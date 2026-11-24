package printer

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestSpoolerQueryUsesExactQueueScopeAndKeepsHandle(t *testing.T) {
	for _, test := range []struct {
		name   string
		remote bool
	}{
		{"POS80 Printer", false},
		{"Office Printer / 80mm", false},
		{`\\print-server\POS80 Printer`, true},
		{`\\127.0.0.1\Local Share`, true},
	} {
		localCalls, remoteCalls := 0, 0
		handle, err := openSpoolerQuery(test.name, func() (uintptr, error) {
			localCalls++
			return 71, nil
		}, func() (uintptr, error) {
			remoteCalls++
			return 92, nil
		})
		wantHandle := uintptr(71)
		if test.remote {
			wantHandle = 92
		}
		if err != nil || handle != wantHandle || localCalls+remoteCalls != 1 || (remoteCalls == 1) != test.remote {
			t.Fatalf("queue %q: handle=%d local=%d remote=%d error=%v", test.name, handle, localCalls, remoteCalls, err)
		}
	}
}

func TestFreshRemoteSpoolerFailureNeverReturnsCachedStatus(t *testing.T) {
	want := errors.New("remote spooler RPC unavailable")
	handle, err := openSpoolerQuery(`\\print-server\POS80 Printer`, func() (uintptr, error) {
		t.Fatal("fresh remote query must not retry against a stale cached handle")
		return 71, nil
	}, func() (uintptr, error) { return 0, want })
	if handle != 0 || !errors.Is(err, want) {
		t.Fatalf("fresh query failure lost: handle=%d error=%v", handle, err)
	}
}

func TestRegistrySpoolerCandidateKeepsNameWithoutPreventingConfirmedRemoval(t *testing.T) {
	const name = "Removed POS80 Queue"
	candidate := registrySpoolerCandidate(name)
	if candidate.Name != name || candidate.SpoolerName != name || candidate.Status != "unknown" ||
		candidate.Capabilities["candidate_reason"] != "registry_queue_unverified" {
		t.Fatalf("registry setup evidence lost: %#v", candidate)
	}
	path := filepath.Join(t.TempDir(), "printers.json")
	if _, err := UpsertRegistry(path, []DeviceInfo{auditAutoSpoolerDevice("old-native-queue", name)}); err != nil {
		t.Fatal(err)
	}
	// Native enumeration completed with zero queues; retained registry names
	// must not revive the old automatic runtime or invalidate completeness.
	runtime := RuntimeDiscoveryPrinters([]DeviceInfo{candidate})
	if len(runtime) != 0 {
		t.Fatalf("registry residue was promoted to executable inventory: %#v", runtime)
	}
	if discoveryErrorIncomplete(discoveryDiagnosticf("registry names retained as candidates")) {
		t.Fatal("registry diagnostic invalidated the complete native inventory")
	}
	rows, err := ReconcileDiscoveryRegistry(path, runtime, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 1 || IsRuntimeDiscoveryPrinter(rows[0]) {
		t.Fatalf("confirmed native queue absence lost history or remained executable: rows=%#v err=%v", rows, err)
	}
}
