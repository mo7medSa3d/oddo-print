package printer

import (
	"context"
	"fmt"
	"github.com/grandcat/zeroconf"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAuditIPPQueuesKeepDistinctResourceIdentities(t *testing.T) {
	a := DeviceInfo{NetworkAddress: "10.0.0.20", Port: 631, ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://10.0.0.20:631/printers/A"}
	b := a
	b.Endpoint = "ipp://10.0.0.20:631/printers/B"
	if StableIDForDevice(a) == StableIDForDevice(b) || sameNetworkEndpoint(a, b) {
		t.Fatal("distinct IPP queues were conflated")
	}
	b.Endpoint = "ipp://10.0.0.20:631/printers/a"
	if StableIDForDevice(a) == StableIDForDevice(b) {
		t.Fatal("case-sensitive queue paths were conflated")
	}
	b = a
	b.Port = 9100
	b.Protocol = "raw"
	b.Endpoint = "10.0.0.20:9100"
	if sameNetworkEndpoint(a, b) {
		t.Fatal("same host must not conflate IPP and raw TCP endpoints")
	}
}

func TestAuditMergePromotesWholeSpoolerTransportTuple(t *testing.T) {
	a := DeviceInfo{ID: "stable", ConnectionType: "network", Type: "network", Protocol: "raw", Endpoint: "10.0.0.20:9100", NetworkAddress: "10.0.0.20", Port: 9100}
	b := DeviceInfo{ConnectionType: "spooler", Type: "spooler", Protocol: "spooler", Endpoint: "Office Queue", SpoolerName: "Office Queue"}
	got := mergeDeviceInfo(a, b)
	if got.ID != a.ID || got.Endpoint != b.Endpoint || got.Type != "spooler" || got.Protocol != "spooler" || got.Port != 0 {
		t.Fatalf("incoherent merged transport: %#v", got)
	}
}

func TestAuditMDNSPreservesIPPSAndDoesNotInventIPPForLPD(t *testing.T) {
	for _, tc := range []struct {
		service, protocol, connection string
		port                          int
	}{{"_ipps._tcp", "ipps", "ipps", 631}, {"_printer._tcp", "lpr", "network", 515}} {
		entry := &zeroconf.ServiceEntry{ServiceRecord: zeroconf.ServiceRecord{Service: tc.service, Instance: "Printer"}, Port: tc.port, AddrIPv4: []net.IP{net.ParseIP("10.0.0.20")}, Text: []string{"rp=printers/Queue"}}
		di, ok := parseMDNSServiceEntry(entry)
		if !ok || di.Protocol != tc.protocol || di.ConnectionType != tc.connection || di.Status != "unknown" {
			t.Fatalf("invalid protocol/health: %#v", di)
		}
		if tc.protocol == "lpr" && di.Capabilities["mdns_verified"] == true {
			t.Fatal("LPD advertisement is not verified IPP")
		}
	}
}

func TestAuditEnhancedPointAndPrintIsPhysical(t *testing.T) {
	di := DeviceInfo{Name: "Office Queue", SpoolerName: `\\server\queue`, ConnectionType: "spooler", Protocol: "spooler", Endpoint: `\\server\queue`, Capabilities: map[string]interface{}{"driver_name": "Microsoft enhanced point and print compatibility driver", "port_name": `\\server\queue`}}
	if ClassifyDeviceInfo(di).Class != ClassPhysical {
		t.Fatalf("shared physical queue was filtered: %#v", ClassifyDeviceInfo(di))
	}
}

func TestAuditRegistryQuarantineFailurePreservesOriginal(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "printers.json")
	original := []byte("{damaged registry")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	for delta := int64(-2); delta <= 2; delta++ {
		if err := os.Mkdir(fmt.Sprintf("%s.corrupt-%d", path, time.Now().Unix()+delta), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := UpsertRegistry(path, nil); err == nil {
		t.Fatal("failed quarantine must refuse overwrite")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(original) {
		t.Fatalf("original was changed: %q %v", got, err)
	}
}

func TestAuditBlockedNetworkWriteHonorsCancellation(t *testing.T) {
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := writePrintPayload(ctx, writer, []byte("receipt"), "pipe"); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled blocked write succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked write ignored cancellation")
	}
}

func auditAutoSpoolerDevice(id, name string) DeviceInfo {
	return DeviceInfo{
		ID:             id,
		Name:           name,
		ConnectionType: "spooler",
		Protocol:       "spooler",
		Endpoint:       name,
		SpoolerName:    name,
		SpoolerPort:    "USB001",
		SpoolerDriver:  "Audit Driver",
		Status:         "unknown",
		Enabled:        true,
		Capabilities: map[string]interface{}{
			"discovered_via":     SourceSpooler,
			"spooler_scope":      "machine_local",
			"spooler_attributes": float64(0),
		},
	}
}

func TestAuditCompleteSpoolerInventoryRemovesAbsentAutoQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	stale := auditAutoSpoolerDevice("spooler-stale", "Removed Queue")
	if _, err := UpsertRegistry(path, []DeviceInfo{stale}); err != nil {
		t.Fatal(err)
	}

	rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("complete spooler inventory retained absent auto queue: %#v", rows)
	}
}

func TestAuditPartialSpoolerInventoryPreservesAbsentAutoQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	stale := auditAutoSpoolerDevice("spooler-stale", "Temporarily Unreadable Queue")
	if _, err := UpsertRegistry(path, []DeviceInfo{stale}); err != nil {
		t.Fatal(err)
	}

	rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != stale.ID {
		t.Fatalf("partial spooler inventory deleted durable queue: %#v", rows)
	}
}

func TestAuditCompleteSpoolerInventoryPreservesManualAndConfigRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	manual := auditAutoSpoolerDevice("manual-spooler", "Manual Queue")
	manual.Capabilities["registration_source"] = "manual"
	configRow := auditAutoSpoolerDevice("config-spooler", "Configured Queue")
	// Distinct physical queue: registry identity intentionally deduplicates
	// rows that share the same spooler port + driver tuple.
	configRow.SpoolerPort = "USB002"
	configRow.Capabilities["registration_source"] = "config"
	if _, err := UpsertRegistry(path, []DeviceInfo{manual, configRow}); err != nil {
		t.Fatal(err)
	}

	rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("authoritative discovery deleted explicit operator inventory: %#v", rows)
	}
}

func TestAuditCompleteDiscoveryDoesNotDeleteSilentNetworkOrUSBInventory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	network := DeviceInfo{
		ID: "network-offline", Name: "Network Printer", ConnectionType: "network", Protocol: "raw",
		Endpoint: "10.0.0.20:9100", NetworkAddress: "10.0.0.20", Port: 9100, Status: "unknown",
		Capabilities: map[string]interface{}{"discovered_via": "tcp_port_scan", "registration_source": "discovery"},
	}
	usb := DeviceInfo{
		ID: "usb-unplugged", Name: "USB Printer", ConnectionType: "usb", Protocol: "raw",
		Endpoint: `\\?\usb#printer`, USBVID: "04b8", USBPID: "0202", Status: "unknown",
		Capabilities: map[string]interface{}{"discovered_via": SourceUSB, "registration_source": "discovery"},
	}
	if _, err := UpsertRegistry(path, []DeviceInfo{network, usb}); err != nil {
		t.Fatal(err)
	}

	rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{
		SourceSpooler: true,
		SourceRAW:     true,
		SourceUSB:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("probe non-response was mistaken for inventory deletion: %#v", rows)
	}
}

func TestAuditAutoSpoolerQueueCanReappearAfterConfirmedRemoval(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	queue := auditAutoSpoolerDevice("spooler-reappear", "Receipt Queue")
	if _, err := UpsertRegistry(path, []DeviceInfo{queue}); err != nil {
		t.Fatal(err)
	}
	if rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: true}); err != nil || len(rows) != 0 {
		t.Fatalf("failed to remove absent queue: rows=%#v err=%v", rows, err)
	}

	rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{queue}, map[string]bool{SourceSpooler: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != queue.ID {
		t.Fatalf("reappearing queue was not restored: %#v", rows)
	}
}

func TestAuditLegacyAutoSpoolerMetadataCanBeReconciled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	legacy := auditAutoSpoolerDevice("legacy-spooler", "Legacy Queue")
	delete(legacy.Capabilities, "discovered_via")
	legacy.Capabilities["registration_source"] = "registry"
	if err := SaveRegistry(path, []DeviceInfo{legacy}); err != nil {
		t.Fatal(err)
	}

	rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("legacy auto spooler row could never age out: %#v", rows)
	}
}

func TestAuditDiscoveryDiagnosticsDoNotInvalidateAuthoritativeQueueEnumeration(t *testing.T) {
	diagnosticOnly := fmt.Errorf("wrapped: %w", discoveryDiagnosticf("LocalSystem cannot see an interactive user's connections"))
	if discoveryErrorIncomplete(diagnosticOnly) {
		t.Fatal("diagnostic-only warning incorrectly made source inventory partial")
	}
	if !discoveryErrorIncomplete(fmt.Errorf("hard enumeration failure")) {
		t.Fatal("hard source failure was treated as authoritative")
	}
}
