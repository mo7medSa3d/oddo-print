package printer

import (
	"fmt"
	"net"
	"reflect"
	"testing"

	"github.com/grandcat/zeroconf"
	"github.com/yaseir-agent/agent/internal/config"
)

func destinationAdvertisement(service, ip string, port int, resource string) *zeroconf.ServiceEntry {
	entry := &zeroconf.ServiceEntry{
		ServiceRecord: zeroconf.ServiceRecord{Instance: "Policy Test Printer", Service: service, Domain: "local."},
		Port:          port, Text: []string{"rp=" + resource},
	}
	address := net.ParseIP(ip)
	if address != nil && address.To4() != nil {
		entry.AddrIPv4 = []net.IP{address}
	} else {
		entry.AddrIPv6 = []net.IP{address}
	}
	return entry
}

func TestDiscoveryMDNSRejectsDisallowedDestinations(t *testing.T) {
	for _, tc := range []struct {
		name, ip string
		port     int
		resource string
	}{
		{"loopback", "127.0.0.1", 631, "ipp/print"},
		{"mapped-loopback", "::ffff:127.0.0.1", 631, "ipp/print"},
		{"public", "8.8.8.8", 631, "ipp/print"},
		{"metadata", "169.254.169.254", 80, "latest/meta-data"},
		{"metadata-v6", "fd00:0ec2:0:0:0:0:0:0254", 80, "latest/meta-data"},
		{"multicast", "224.0.0.1", 631, "ipp/print"},
		{"unspecified", "0.0.0.0", 631, "ipp/print"},
		{"unspecified-v6", "::", 631, "ipp/print"},
		{"loopback-v6", "::1", 631, "ipp/print"},
		{"public-v6", "2001:4860:4860::8888", 631, "ipp/print"},
		{"zone-missing-v6", "fe80::abcd", 631, "ipp/print"},
		{"forbidden-port", "192.168.1.25", 22, "ipp/print"},
		{"invalid-port", "192.168.1.25", 65536, "ipp/print"},
		{"query", "192.168.1.25", 631, "ipp/print?redirect=http://127.0.0.1"},
		{"fragment", "192.168.1.25", 631, "ipp/print#other"},
		{"control-character", "192.168.1.25", 631, "ipp/\nprint"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseMDNSServiceEntry(destinationAdvertisement("_ipp._tcp", tc.ip, tc.port, tc.resource))
			if ok {
				t.Fatalf("untrusted advertisement passed destination admission: %+v", got)
			}
		})
	}
}

func TestDiscoveryMDNSSelectsAllowedAddress(t *testing.T) {
	for _, tc := range []struct {
		name   string
		v4, v6 []net.IP
		want   string
	}{
		{"bad-first-v4", []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("192.168.1.25")}, nil, "192.168.1.25"},
		{"nil-first-v4", []net.IP{nil, net.ParseIP("10.1.2.3")}, nil, "10.1.2.3"},
		{"fallback-v6", []net.IP{net.ParseIP("8.8.8.8")}, []net.IP{net.ParseIP("fd12::25")}, "fd12::25"},
		{"bad-first-v6", nil, []net.IP{net.ParseIP("::1"), net.ParseIP("fd12::25")}, "fd12::25"},
		{"prefer-permitted-v4", []net.IP{net.ParseIP("10.1.2.3")}, []net.IP{net.ParseIP("fd12::25")}, "10.1.2.3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := destinationAdvertisement("_ipp._tcp", "192.168.1.25", 631, "Printers/Main")
			entry.AddrIPv4, entry.AddrIPv6 = tc.v4, tc.v6
			got, ok := parseMDNSServiceEntry(entry)
			if !ok || got.NetworkAddress != tc.want || IsRuntimeDiscoveryPrinter(got) {
				t.Fatalf("allowed mDNS address must remain an unverified candidate: got %+v, ok=%v", got, ok)
			}
		})
	}
}

func TestDiscoveryMDNSPreservesSupportedDestinations(t *testing.T) {
	for _, tc := range []struct {
		service, ip string
		port        int
	}{
		{"_ipp._tcp", "192.168.1.25", 631},
		{"_ipp._tcp", "10.1.2.3", 80},
		{"_ipps._tcp", "172.16.1.25", 443},
		{"_ipps._tcp", "192.168.1.25", 631},
		{"_ipp._tcp", "169.254.10.20", 631},
		{"_ipp._tcp", "fd12::25", 631},
	} {
		t.Run(fmt.Sprintf("%s-%s-%d", tc.service, tc.ip, tc.port), func(t *testing.T) {
			got, ok := parseMDNSServiceEntry(destinationAdvertisement(tc.service, tc.ip, tc.port, "Printers/Main"))
			if !ok || IsRuntimeDiscoveryPrinter(got) {
				t.Fatalf("supported DNS-SD endpoint must remain candidate until IPP probe: %+v", got)
			}
			got.Capabilities["ipp_verified"] = true
			if !IsRuntimeDiscoveryPrinter(got) {
				t.Fatalf("successful IPP protocol proof must promote permitted endpoint: %+v", got)
			}
			pc := config.PrinterConfig{ID: got.ID, Name: got.Name, Type: got.ConnectionType, Protocol: got.Protocol, Endpoint: got.Endpoint}
			if err := config.ValidatePrinterConfig(pc); err != nil {
				t.Fatalf("discovery/config policy diverged: %v", err)
			}
			if _, err := New(pc); err != nil {
				t.Fatalf("permitted discovery could not construct backend: %v", err)
			}
		})
	}
	lpr, ok := parseMDNSServiceEntry(destinationAdvertisement("_printer._tcp", "192.168.1.25", 515, "queue"))
	if !ok || IsRuntimeDiscoveryPrinter(lpr) {
		t.Fatalf("LPR must remain a visible non-executable candidate: %+v", lpr)
	}
}

func TestDiscoveryRuntimeAndFactoryShareDestinationPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, connection, protocol, endpoint string
		allowed                              bool
	}{
		{"raw-private", "network", "raw", "192.168.1.25:9100", true},
		{"tcp-private", "tcp", "escpos", "10.1.2.3:9100", true},
		{"raw-v6", "network", "zpl", "[fd12::25]:9100", true},
		{"raw-link-local", "network", "tspl", "169.254.1.2:9100", true},
		{"ipp-private", "ipp", "ipp", "ipp://192.168.1.25:631/Printers/Main", true},
		{"network-ipp", "network", "ipp", "192.168.1.25:631", true},
		{"ipps-private", "ipps", "ipps", "ipps://[fd12::25]:631/ipp/print", true},
		{"raw-loopback", "network", "raw", "127.0.0.1:9100", false},
		{"raw-public", "tcp", "raw", "8.8.8.8:9100", false},
		{"raw-metadata", "network", "raw", "169.254.169.254:9100", false},
		{"raw-port", "network", "raw", "192.168.1.25:22", false},
		{"raw-hostname", "network", "raw", "printer.example:9100", false},
		{"ipp-public", "ipp", "ipp", "ipp://8.8.8.8:631/ipp/print", false},
		{"ipp-port", "ipp", "ipp", "ipp://192.168.1.25:22/ipp/print", false},
		{"ipp-userinfo", "ipp", "ipp", "ipp://user:secret@192.168.1.25/ipp/print", false},
		{"ipp-query", "ipp", "ipp", "ipp://192.168.1.25/ipp/print?x=1", false},
		{"ipp-fragment", "ipp", "ipp", "ipp://192.168.1.25/ipp/print#x", false},
		{"ipps-downgrade", "ipps", "ipps", "ipp://192.168.1.25/ipp/print", false},
		{"ipp-metadata-v6", "ipp", "ipp", "ipp://[fd00:ec2::254]/ipp/print", false},
		{"empty-endpoint", "network", "raw", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pc := config.PrinterConfig{ID: "policy-test", Name: "Policy Test", Type: tc.connection, Protocol: tc.protocol, Endpoint: tc.endpoint}
			if (config.ValidatePrinterConfig(pc) == nil) != tc.allowed {
				t.Fatal("fixture must agree with existing configured/manual policy")
			}
			di := DeviceInfo{ID: pc.ID, Name: pc.Name, ConnectionType: tc.connection, Protocol: tc.protocol, Endpoint: tc.endpoint,
				// An advertised address/verification cannot override the actual endpoint.
				NetworkAddress: "192.168.1.25", Port: 631, Capabilities: map[string]interface{}{"verification": "verified", "mdns_verified": true}}
			if got := IsRuntimeDiscoveryPrinter(di); got != tc.allowed {
				t.Errorf("runtime admission=%v, want %v", got, tc.allowed)
			}
			if _, err := New(pc); (err == nil) != tc.allowed {
				t.Errorf("factory admission err=%v, allowed=%v", err, tc.allowed)
			}
			// Legacy registry rows may populate only Type, not ConnectionType.
			di.Type, di.ConnectionType = di.ConnectionType, ""
			if got := IsRuntimeDiscoveryPrinter(di); got != tc.allowed {
				t.Errorf("legacy type admission=%v, want %v", got, tc.allowed)
			}
		})
	}
}

func TestDiscoveryDestinationFilterPreservesIntentWithoutMutation(t *testing.T) {
	input := []DeviceInfo{
		{ID: "spooler", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Office Queue"},
		{ID: "usb", ConnectionType: "usb", Protocol: "zpl", Endpoint: `\\?\usb#vid_1234&pid_5678#001`, USBVID: "1234", USBPID: "5678"},
		{ID: "manual", ConnectionType: "network", Protocol: "unknown", Endpoint: "192.168.1.25:9100", Capabilities: map[string]interface{}{"registration_source": "manual"}},
		{ID: "auto-unknown", ConnectionType: "network", Protocol: "unknown", Endpoint: "192.168.1.26:9100", Capabilities: map[string]interface{}{"discovered_via": "tcp_port_scan"}},
		{ID: "unsafe-manual", ConnectionType: "network", Protocol: "unknown", Endpoint: "127.0.0.1:9100", Capabilities: map[string]interface{}{"registration_source": "manual"}},
	}
	before := append([]DeviceInfo(nil), input...)
	got := RuntimeDiscoveryPrinters(input)
	if len(got) != 3 || got[0].ID != "spooler" || got[1].ID != "usb" || got[2].ID != "manual" {
		t.Fatalf("permitted non-network/explicit unknown inventory changed: %+v", got)
	}
	if !reflect.DeepEqual(before, input) {
		t.Fatal("runtime filter mutated caller input")
	}
}

func FuzzMDNSDestinationPolicy(f *testing.F) {
	f.Add("192.168.1.25", 631, "ipp/print")
	f.Add("127.0.0.1", 631, "ipp/print")
	f.Add("fd00:ec2::254", 80, "latest/meta-data")
	f.Add("10.1.2.3", 22, "ipp/print")
	f.Fuzz(func(t *testing.T, ip string, port int, resource string) {
		got, ok := parseMDNSServiceEntry(destinationAdvertisement("_ipp._tcp", ip, port, resource))
		if !ok {
			return
		}
		pc := config.PrinterConfig{ID: got.ID, Name: got.Name, Type: got.ConnectionType, Protocol: got.Protocol, Endpoint: got.Endpoint}
		if err := config.ValidatePrinterConfig(pc); err != nil {
			t.Fatalf("promoted discovery violates shared policy: %v", err)
		}
	})
}
