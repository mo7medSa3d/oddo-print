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
	for _, tc := range []struct{ service, protocol, connection string }{{"_ipps._tcp", "ipps", "ipps"}, {"_printer._tcp", "lpr", "network"}} {
		entry := &zeroconf.ServiceEntry{ServiceRecord: zeroconf.ServiceRecord{Service: tc.service, Instance: "Printer"}, Port: 515, AddrIPv4: []net.IP{net.ParseIP("10.0.0.20")}, Text: []string{"rp=printers/Queue"}}
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
