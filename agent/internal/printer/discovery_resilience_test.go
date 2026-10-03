package printer

import (
	"context"
	"testing"
	"time"
)

// snmpIdentityInput mirrors probeSNMPPrinterWithPort's post-fix identity
// construction: the ID input pins the intended print port in both the
// reachable and unreachable branches, so a port flap cannot fork the ID.
func snmpIdentityInput(ip string, printerPort int, endpoint, name string) DeviceInfo {
	return DeviceInfo{
		NetworkAddress: ip,
		Port:           printerPort,
		Endpoint:       endpoint,
		Name:           name,
	}
}

// TestSNMPIdentityStableAcrossReachabilityFlap proves one physical printer
// keeps one ID when its TCP port flaps between reachable ("ip:9100") and
// unreachable (bare "ip"). Regression test for the duplicate-inventory fix:
// building the ID from the live observation forked namespaces
// (StableIDFromNetwork vs StableIDFromEndpoint).
func TestSNMPIdentityStableAcrossReachabilityFlap(t *testing.T) {
	const ip, port, name = "192.0.2.44", 9100, "ShopFloor-Laser"
	reachable := snmpIdentityInput(ip, port, ip+":9100", name)
	unreachable := snmpIdentityInput(ip, port, ip, name)
	if got, want := StableIDForDevice(reachable), StableIDForDevice(unreachable); got != want {
		t.Fatalf("flap forked the printer ID: reachable=%s unreachable=%s", got, want)
	}
}

// TestSNMPZeroPortTrapDocumentsOldBehavior locks in the reason the caller
// must pin the port: a zero Port falls through to the endpoint namespace,
// which is a different ID for the same device. If this ever stops
// differing, the pinning is redundant and the comment in snmp_discovery.go
// should be revisited.
func TestSNMPZeroPortTrapDocumentsOldBehavior(t *testing.T) {
	pinned := snmpIdentityInput("192.0.2.44", 9100, "192.0.2.44", "ShopFloor-Laser")
	unpinned := DeviceInfo{NetworkAddress: "192.0.2.44", Port: 0, Endpoint: "192.0.2.44", Name: "ShopFloor-Laser"}
	if StableIDForDevice(pinned) == StableIDForDevice(unpinned) {
		t.Fatal("expected the zero-port construction to land in a different ID namespace (trap changed?)")
	}
}

// TestWSDDiscoveryHonoursPreCancelledContext requires an already-cancelled
// context to return immediately, well under the 2.5s listen deadline.
func TestWSDDiscoveryHonoursPreCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	devs, err := discoverWSDPrinters(ctx)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("pre-cancelled discovery took %v, want < 2s", elapsed)
	}
	if err != nil {
		t.Fatalf("pre-cancelled discovery errored: %v", err)
	}
	if len(devs) != 0 {
		t.Fatalf("pre-cancelled discovery returned %d devices, want 0", len(devs))
	}
}

// TestWSDDiscoveryUnblocksOnMidListenCancel requires a cancellation
// arriving mid-listen to pull the read deadline forward instead of
// stalling for the remainder of the 2.5s window (service-stop path).
func TestWSDDiscoveryUnblocksOnMidListenCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(200*time.Millisecond, cancel)
	start := time.Now()
	_, _ = discoverWSDPrinters(ctx)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("mid-listen cancel took %v to unwind, want < 2s", elapsed)
	}
}
