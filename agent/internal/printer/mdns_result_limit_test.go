package printer

import (
	"fmt"
	"testing"
)

// Collector memory stays finite even if the LAN advertises thousands of
// unique services in a single browse window. Duplicate endpoint names may
// not consume extra slots; the cap does not weaken destination validation.
func TestMDNSResultCollectorHasHardCap(t *testing.T) {
	var collected []DeviceInfo
	seen := make(map[string]bool)
	for n := 0; n < maxMDNSDiscoveryResults*10; n++ {
		endpoint := fmt.Sprintf("ipp://192.168.%d.%d:631/ipp/print", n/256, n%256)
		appendMDNSDiscoveryResult(&collected, seen, DeviceInfo{Endpoint: endpoint}, maxMDNSDiscoveryResults)
		appendMDNSDiscoveryResult(&collected, seen, DeviceInfo{Endpoint: endpoint}, maxMDNSDiscoveryResults)
	}
	if len(collected) != maxMDNSDiscoveryResults || len(seen) != maxMDNSDiscoveryResults {
		t.Fatalf("collector allocated beyond bound: rows=%d seen=%d", len(collected), len(seen))
	}
	if appendMDNSDiscoveryResult(&collected, seen, DeviceInfo{Endpoint: "ipp://192.168.1.50:631/print"}, maxMDNSDiscoveryResults) {
		t.Fatal("collector admitted a new destination after reaching cap")
	}
}

func TestMDNSResultCollectorRejectsInvalidOrRepeatedEntries(t *testing.T) {
	var collected []DeviceInfo
	seen := make(map[string]bool)
	if appendMDNSDiscoveryResult(&collected, seen, DeviceInfo{}, maxMDNSDiscoveryResults) {
		t.Fatal("empty endpoint was added")
	}
	if !appendMDNSDiscoveryResult(&collected, seen, DeviceInfo{Endpoint: "ipps://10.0.0.5:631/print"}, maxMDNSDiscoveryResults) {
		t.Fatal("first valid endpoint was rejected")
	}
	if appendMDNSDiscoveryResult(&collected, seen, DeviceInfo{Endpoint: "ipps://10.0.0.5:631/print"}, maxMDNSDiscoveryResults) {
		t.Fatal("duplicate endpoint was added")
	}
	if len(collected) != 1 || len(seen) != 1 {
		t.Fatal("duplicate altered collector memory")
	}
}
