package printer

import (
	"strings"
	"testing"
)

// These tests pin the identity contract that network discovery depends on:
// a printer's identity must derive from the DEVICE (host + intended print
// port), never from a live reachability observation.
//
// Background: probeSNMPPrinterWithPort builds its DeviceInfo differently
// depending on whether TCP 9100 answered at probe time — reachable produced
// Endpoint "ip:9100" with Port 9100, unreachable produced Endpoint "ip" with
// Port 0. StableIDForDevice dispatches on `NetworkAddress != "" && Port != 0`,
// so Port 0 fell through to StableIDFromEndpoint and produced a DIFFERENT id
// for the same physical printer. A printer whose port flapped (asleep, busy,
// filtered) was therefore inventoried once per state.

func TestNetworkIdentityIsPinnedByHostAndPort(t *testing.T) {
	const ip = "10.0.0.20"
	const printPort = 9100

	// The endpoint string varies with what discovery observed; identity must
	// not follow it.
	reachable := DeviceInfo{NetworkAddress: ip, Port: printPort, Endpoint: "10.0.0.20:9100", Name: "Front Desk"}
	unreachable := DeviceInfo{NetworkAddress: ip, Port: printPort, Endpoint: ip, Name: "Front Desk"}

	if got, want := StableIDForDevice(unreachable), StableIDForDevice(reachable); got != want {
		t.Fatalf("identity followed the endpoint string, not the device: reachable=%s unreachable=%s", want, got)
	}
}

func TestNetworkIdentityIgnoresDisplayName(t *testing.T) {
	// The display name is the least durable attribute and must not feed the id
	// once a host+port is known.
	a := DeviceInfo{NetworkAddress: "10.0.0.20", Port: 9100, Name: "Front Desk"}
	b := DeviceInfo{NetworkAddress: "10.0.0.20", Port: 9100, Name: "Front Desk (renamed)"}
	if got, want := StableIDForDevice(b), StableIDForDevice(a); got != want {
		t.Fatalf("identity followed the display name: %s vs %s", want, got)
	}
}

func TestNetworkIdentitySeparatesDistinctPorts(t *testing.T) {
	// Two queues on one host (a common multi-port print server setup) must not
	// collapse into one printer.
	a := StableIDForDevice(DeviceInfo{NetworkAddress: "10.0.0.20", Port: 9100})
	b := StableIDForDevice(DeviceInfo{NetworkAddress: "10.0.0.20", Port: 9101})
	if a == b {
		t.Fatalf("distinct ports collapsed to one identity: %s", a)
	}
}

// TestZeroPortFallsBackToEndpointNamespace documents the hazard the SNMP fix
// avoids. It is not a desired behaviour — it is the trap. If someone changes
// StableIDForDevice's dispatch, this test explains why callers must pin the
// port rather than passing 0.
func TestZeroPortFallsBackToEndpointNamespace(t *testing.T) {
	const ip = "10.0.0.20"

	withPort := StableIDForDevice(DeviceInfo{NetworkAddress: ip, Port: 9100, Endpoint: "10.0.0.20:9100"})
	withoutPort := StableIDForDevice(DeviceInfo{NetworkAddress: ip, Port: 0, Endpoint: ip})

	if withPort == withoutPort {
		t.Fatalf("expected Port 0 to fall through to the endpoint namespace; both gave %s", withPort)
	}
	// And the two namespaces are visibly different.
	if !strings.HasPrefix(withPort, "printer_net_") {
		t.Fatalf("expected host+port to use the net namespace, got %s", withPort)
	}
	if !strings.HasPrefix(withoutPort, "printer_ep_") {
		t.Fatalf("expected a bare endpoint to use the ep namespace, got %s", withoutPort)
	}
}
