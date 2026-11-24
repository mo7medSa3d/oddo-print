package printer

import (
	"fmt"
	"net/url"
	"path/filepath"
	"testing"
)

// Alternate URI spellings must not create duplicate local identities for the
// same IPP resource. Only the URI spelling changes; authority (host, effective
// port, TLS) and the case-sensitive multi-queue resource remain identical.
func TestIPPQueueAliasSchemeStableIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, alias, canonical, otherQueue string
	}{
		{"plaintext", "http://192.168.1.20:631/printers/office", "ipp://192.168.1.20:631/printers/office", "ipp://192.168.1.20:631/printers/warehouse"},
		{"TLS", "https://192.168.1.20:631/printers/office", "ipps://192.168.1.20:631/printers/office", "ipps://192.168.1.20:631/printers/warehouse"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proto := "ipp"
			if tc.name == "TLS" {
				proto = "ipps"
			}
			device := func(endpoint string) DeviceInfo {
				return DeviceInfo{ConnectionType: proto, Protocol: proto, NetworkAddress: "192.168.1.20", Port: 631, Endpoint: endpoint}
			}
			a, b, different := device(tc.alias), device(tc.canonical), device(tc.otherQueue)
			if StableIDForDevice(a) != StableIDForDevice(b) || !sameNetworkEndpoint(a, b) {
				t.Fatalf("equivalent URI spellings forked a printer: %q / %q", StableIDForDevice(a), StableIDForDevice(b))
			}
			if StableIDForDevice(a) == StableIDForDevice(different) || sameNetworkEndpoint(a, different) {
				t.Fatal("different IPP queue resources were merged")
			}
		})
	}
	plain := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp", NetworkAddress: "192.168.1.20", Port: 631, Endpoint: "ipp://192.168.1.20:631/printers/office"}
	secure := DeviceInfo{ConnectionType: "ipps", Protocol: "ipps", NetworkAddress: "192.168.1.20", Port: 631, Endpoint: "ipps://192.168.1.20:631/printers/office"}
	if StableIDForDevice(plain) == StableIDForDevice(secure) || sameNetworkEndpoint(plain, secure) {
		t.Fatal("plaintext IPP and IPPS TLS must never share an execution identity")
	}
}

func TestIPPDedupDoesNotTreatUppercaseProtocolAsRAW(t *testing.T) {
	ipp := DeviceInfo{ConnectionType: "ipp", Protocol: "IPP", Endpoint: "ipp://192.168.1.20:631/ipp/print", NetworkAddress: "192.168.1.20", Port: 631}
	raw := DeviceInfo{ConnectionType: "network", Protocol: "raw", Endpoint: "192.168.1.20:631", NetworkAddress: "192.168.1.20", Port: 631}
	if sameNetworkEndpoint(ipp, raw) || sameNetworkEndpoint(raw, ipp) {
		t.Fatal("a mixed-case IPP declaration was merged with a distinct RAW transport")
	}
}

func TestIPPDedupRejectsInconsistentReportedPortAndResource(t *testing.T) {
	original := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp", NetworkAddress: "192.168.1.20", Port: 631,
		Endpoint: "ipp://192.168.1.20:631/printers/office"}
	for _, changedEndpoint := range []string{
		"http://192.168.1.20:80/printers/office", // advertised 631 is not execution port 80
		"ipp://192.168.1.21:631/printers/office", // same stale reported NetworkAddress, different URI authority
		"ipp://192.168.1.20:631/printers/office2",
		"ipp://192.168.1.20:631/printers/office?debug=1",
	} {
		altered := original
		altered.Endpoint = changedEndpoint
		if sameNetworkEndpoint(original, altered) {
			t.Fatalf("IPP queue identity merged an inconsistent address or resource: %s", changedEndpoint)
		}
	}
}

func TestUppercaseIPPStableIDPreservesMultiQueueResource(t *testing.T) {
	for _, proto := range []string{"ipp", "IPP", "IpPs"} {
		first := DeviceInfo{ConnectionType: proto, Protocol: proto, NetworkAddress: "192.168.1.20", Port: 631,
			Endpoint: "ipp://192.168.1.20:631/printers/office"}
		second := first
		second.Endpoint = "ipp://192.168.1.20:631/printers/warehouse"
		if proto == "IPP" {
			first.Endpoint = "http://192.168.1.20:631/printers/office"
			second.Endpoint = "http://192.168.1.20:631/printers/warehouse"
		} else if proto == "IpPs" {
			first.Endpoint = "https://192.168.1.20:631/printers/office"
			second.Endpoint = "https://192.168.1.20:631/printers/warehouse"
		}
		if StableIDForDevice(first) == StableIDForDevice(second) {
			t.Fatalf("case-insensitive protocol %q collapsed two separate queues", proto)
		}
		// Legacy registry observations may retain only Endpoint. Missing
		// NetworkAddress/Port must still preserve distinct print resources.
		first.NetworkAddress, first.Port = "", 0
		second.NetworkAddress, second.Port = "", 0
		if StableIDForDevice(first) == StableIDForDevice(second) {
			t.Fatalf("legacy endpoint-only protocol %q collapsed two separate IPP queues", proto)
		}
	}
}

func TestIPPMultiQueueIPv6TextualFormsShareIdentity(t *testing.T) {
	expanded := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp", NetworkAddress: "fd12:3456:0:0:0:0:0:10",
		Port: 631, Endpoint: "ipp://[fd12:3456:0:0:0:0:0:10]:631/printers/office"}
	short := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp", NetworkAddress: "[fd12:3456::10]",
		Port: 631, Endpoint: "ipp://[fd12:3456::10]:631/printers/office"}
	if StableIDForDevice(expanded) != StableIDForDevice(short) || !sameNetworkEndpoint(expanded, short) {
		t.Fatalf("same IPv6 IPP execution queue forked: %q vs %q", StableIDForDevice(expanded), StableIDForDevice(short))
	}
	secondQueue := short
	secondQueue.Endpoint = "ipp://[fd12:3456::10]:631/printers/other"
	if StableIDForDevice(expanded) == StableIDForDevice(secondQueue) || sameNetworkEndpoint(expanded, secondQueue) {
		t.Fatal("distinct IPv6 multi-queue resources merged")
	}
}

// The URI is the execution authority. Stale mDNS/SNMP enrichment must not
// stamp a different URI host or HTTP port with an existing printer ID before
// the later sameNetworkEndpoint checks ever run.
func TestIPPStableIDFencesStaleReportedHostAndPort(t *testing.T) {
	canonical := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp",
		NetworkAddress: "192.168.1.20", Port: 631,
		Endpoint: "ipp://192.168.1.20:631/printers/office"}
	for _, stale := range []string{
		"http://192.168.1.20:80/printers/office",
		"ipp://192.168.1.21:631/printers/office",
	} {
		incorrect := canonical
		incorrect.Endpoint = stale
		if StableIDForDevice(canonical) == StableIDForDevice(incorrect) {
			t.Fatalf("URI host/port mismatch reused another physical queue ID: %s", stale)
		}
	}
}

// IPP resources on HTTP virtual hosts can route to different print queues
// even if the DNS names currently resolve to the same observed IP address.
// Legacy /ipp/print retains its established IP+port continuity, but a custom
// queue URL must be bound to the actual URI authority.
func TestIPPNonDefaultQueueVirtualHostsStaySeparate(t *testing.T) {
	first := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp", NetworkAddress: "192.168.1.20", Port: 631,
		Endpoint: "ipp://frontdesk.local:631/printers/receipt"}
	second := first
	second.Endpoint = "ipp://warehouse.local:631/printers/receipt"
	if StableIDForDevice(first) == StableIDForDevice(second) || sameNetworkEndpoint(first, second) {
		t.Fatal("distinct IPP HTTP virtual hosts were collapsed by a shared observed IP")
	}
}

func TestIPPIdentityDefaultsMatchExecutionPort(t *testing.T) {
	for _, tc := range []struct {
		scheme string
		port   int
	}{{"ipp", 631}, {"ipps", 631}, {"http", 80}, {"https", 443}} {
		t.Run(tc.scheme, func(t *testing.T) {
			implicit := DeviceInfo{ConnectionType: "ipp", Protocol: "ipp", Endpoint: tc.scheme + "://192.168.1.20/ipp/print"}
			explicit := implicit
			explicit.Endpoint = fmt.Sprintf("%s://192.168.1.20:%d/ipp/print", tc.scheme, tc.port)
			backend, err := NewIPPPrinter(implicit.Endpoint, "fixture")
			if err != nil {
				t.Fatal(err)
			}
			uri, err := url.Parse(backend.PrinterURI)
			if err != nil || uri.Port() != fmt.Sprint(tc.port) {
				t.Fatalf("execution URI=%q err=%v", backend.PrinterURI, err)
			}
			if StableIDForDevice(implicit) != StableIDForDevice(explicit) {
				t.Fatalf("same execution endpoint has different IDs: implicit=%s explicit=%s", StableIDForDevice(implicit), StableIDForDevice(explicit))
			}
		})
	}
}

func TestIPPRootResourceIsNotTheDefaultIPPPrintQueue(t *testing.T) {
	const host = "192.168.1.20"
	root := StableIDFromIPPURI("ipp://192.168.1.20:631/", host, 631)
	implicitRoot := StableIDFromIPPURI("ipp://192.168.1.20:631", host, 631)
	defaultQueue := StableIDFromIPPURI("ipp://192.168.1.20:631/ipp/print", host, 631)
	if root != implicitRoot || root == defaultQueue {
		t.Fatalf("root URI must remain one identity, distinct from /ipp/print: root=%s implicit=%s default=%s", root, implicitRoot, defaultQueue)
	}
	device := DeviceInfo{
		ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20:631/",
		Capabilities: map[string]interface{}{"serial": "queue-server-123"},
	}
	rootKey, rootOK := physicalIdentityKey(device)
	device.Endpoint = "ipp://192.168.1.20:631/ipp/print"
	defaultKey, defaultOK := physicalIdentityKey(device)
	if !rootOK || !defaultOK || rootKey == defaultKey {
		t.Fatalf("strong hardware evidence cannot erase the IPP queue resource: root=%q default=%q", rootKey, defaultKey)
	}
}

func TestManualIPPPortsRemainSeparateDestinations(t *testing.T) {
	for _, tc := range []struct {
		scheme    string
		otherPort int
	}{{"ipps", 443}, {"http", 631}} {
		t.Run(tc.scheme, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			endpoints := []string{tc.scheme + "://192.168.1.20/ipp/print", fmt.Sprintf("%s://192.168.1.20:%d/ipp/print", tc.scheme, tc.otherPort)}
			var rows []DeviceInfo
			for _, endpoint := range endpoints {
				var err error
				rows, err = RegisterManual(path, DeviceInfo{Name: "Office", ConnectionType: "ipp", Protocol: "ipp", Endpoint: endpoint, Enabled: true})
				if err != nil {
					t.Fatal(err)
				}
			}
			if len(rows) != 2 {
				t.Fatalf("different physical destinations collapsed to %d registry rows: %+v", len(rows), rows)
			}
			seen := map[string]bool{}
			for _, row := range rows {
				seen[row.Endpoint] = true
			}
			for _, endpoint := range endpoints {
				if !seen[endpoint] {
					t.Fatalf("registration overwrote destination %q", endpoint)
				}
			}
		})
	}
}

func TestIPPDefaultResourceIdentifiesSeparateSecureTransport(t *testing.T) {
	// Both endpoints reach /ipp/print on port 631, but TLS and plaintext
	// are distinct execution authorities. Auto-discovery must never assign
	// the same registry ID and silently replace a queue's security binding.
	plain := StableIDFromIPPURI("ipp://192.168.1.20:631/ipp/print", "192.168.1.20", 631)
	secure := StableIDFromIPPURI("ipps://192.168.1.20:631/ipp/print", "192.168.1.20", 631)
	if plain == secure {
		t.Fatalf("IPP and IPPS endpoints collided at stable ID %q", plain)
	}
	if want := StableIDFromNetwork("192.168.1.20", 631); plain != want {
		t.Fatalf("historical plain IPP scan ID changed: got %q want %q", plain, want)
	}
	if got := StableIDFromIPPURI("https://192.168.1.20:631/ipp/print", "192.168.1.20", 631); got != secure {
		t.Fatalf("same secure destination changed identity when using HTTPS spelling: %q vs %q", secure, got)
	}
}

func TestDiscoveryKeepsPlainAndSecureIPPDefaultQueuesSeparate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	host := "192.168.1.20"
	for _, endpoint := range []string{
		"ipp://" + host + ":631/ipp/print",
		"ipps://" + host + ":631/ipp/print",
	} {
		protocol := "ipp"
		if endpoint == "ipps://"+host+":631/ipp/print" {
			protocol = "ipps"
		}
		rows, err := UpsertRegistry(path, []DeviceInfo{{
			Name: "Same server", PrinterType: "physical",
			ConnectionType: protocol, Protocol: protocol,
			Endpoint: endpoint, NetworkAddress: host, Port: 631,
			Enabled: true, Status: "online",
		}})
		if err != nil {
			t.Fatal(err)
		}
		if endpoint == "ipps://"+host+":631/ipp/print" {
			if len(rows) != 2 || rows[0].ID == rows[1].ID {
				t.Fatalf("secure queue overwrote plaintext queue: %+v", rows)
			}
		}
	}
}

func TestLegacySecureIPPRegistryRetainsIDAfterStableIDUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	host := "192.168.1.20"
	legacyID := StableIDFromNetwork(host, 631)
	endpoint := "ipps://" + host + ":631/ipp/print"
	original := DeviceInfo{
		ID: legacyID, Name: "Secure receipt queue",
		PrinterType: "physical", ConnectionType: "ipps", Protocol: "ipps",
		Endpoint: endpoint, NetworkAddress: host, Port: 631,
		Enabled: false, Status: "unknown",
	}
	if err := SaveRegistry(path, []DeviceInfo{original}); err != nil {
		t.Fatal(err)
	}
	rows, err := UpsertRegistry(path, []DeviceInfo{{
		Name: original.Name, PrinterType: "physical",
		ConnectionType: "ipps", Protocol: "ipps",
		Endpoint:       "https://" + host + ":631/ipp/print",
		NetworkAddress: host, Port: 631, Enabled: true, Status: "online",
	}})
	if err != nil || len(rows) != 1 || rows[0].ID != legacyID || rows[0].Enabled {
		t.Fatalf("secure registry upgrade rewrote existing ID or operator disablement: %+v, %v", rows, err)
	}
}
