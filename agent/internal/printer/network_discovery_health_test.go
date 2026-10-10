package printer

import "testing"

func TestNetworkDiscoveryMetadataDoesNotClaimHardwareReady(t *testing.T) {
	// A TCP 9100 listener and a successful SNMP identity query are not
	// printer-state measurements. They may enrich an inventory candidate
	// but must not fabricate that paper, cover and media are ready.
	tcp := DeviceInfo{
		ID: "network-9100", Name: "Network Printer 10.22.33.44",
		NetworkAddress: "10.22.33.44", Port: 9100,
		Protocol: "unknown", ConnectionType: "network", Status: "unknown",
		Capabilities: map[string]interface{}{"discovered_via": "tcp_port_scan", "verification": "print_endpoint_verified"},
	}
	snmp := tcp
	snmp.Name = "Model from sysDescr"
	snmp.Status = "unknown"
	snmp.Capabilities = map[string]interface{}{
		"discovered_via": SourceSNMP, "snmp_verified": true,
		"sysDescr": "Network Receipt Printer", "serial": "AA123",
		"verification": "verified",
	}
	merged := mergeNetworkDevices([]DeviceInfo{tcp, snmp})
	if len(merged) != 1 {
		t.Fatalf("duplicate endpoint, got %d records", len(merged))
	}
	if merged[0].Status != "unknown" {
		t.Fatalf("TCP/SNMP identity evidence promoted to health %q", merged[0].Status)
	}
	if merged[0].Capabilities["snmp_verified"] != true || merged[0].Capabilities["serial"] != "AA123" {
		t.Fatalf("lost useful SNMP identity metadata: %+v", merged[0].Capabilities)
	}
}
