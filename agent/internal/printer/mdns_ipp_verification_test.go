package printer

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

func mdnsCandidateForVerification(ip string) DeviceInfo {
	return DeviceInfo{
		ID: "mdns-" + ip, Name: "Discovered printer", Type: "ipp", ConnectionType: "ipp", Protocol: "ipp",
		Endpoint: "ipp://" + ip + ":631/ipp/print", Status: "unknown",
		Capabilities: map[string]interface{}{
			"discovered_via": SourceMDNS, "mdns_verified": false,
			"ipp_verified": false, "verification": "candidate",
		},
	}
}

func TestMDNSAdvertisementAloneIsNeverProtocolVerified(t *testing.T) {
	d := mdnsCandidateForVerification("192.168.1.53")
	if IsRuntimeDiscoveryPrinter(d) {
		t.Fatal("a self-advertised DNS-SD service was promoted without an IPP exchange")
	}
	d.Capabilities["mdns_verified"] = true // prior release erroneously set this on TXT receipt
	d.Capabilities["verification"] = "verified"
	if IsRuntimeDiscoveryPrinter(d) {
		t.Fatal("old mdns_verified must not bypass the live IPP proof")
	}
	d.Capabilities["ipp_verified"] = true
	if !IsRuntimeDiscoveryPrinter(d) {
		t.Fatal("validated IPP endpoint should enter executable inventory")
	}
}

// Discovery sources may be merged or enriched in a different order. A valid
// SNMP result or a stale "verified" string must not turn an unprobed IPP
// endpoint into an executable printer. Explicit operator registration is
// separate and can use its own direct format negotiation.
func TestDiscoveredIPPEndpointRequiresIPPProofRegardlessOfObservationSource(t *testing.T) {
	for _, source := range []string{SourceMDNS, SourceSNMP, "ipp_tcp_scan", SourceWSD} {
		d := mdnsCandidateForVerification("10.0.0.27")
		d.Capabilities["discovered_via"] = source
		d.Capabilities["snmp_verified"] = true
		d.Capabilities["mdns_verified"] = true
		d.Capabilities["verification"] = "verified"
		if IsRuntimeDiscoveryPrinter(d) {
			t.Fatalf("unprobed IPP endpoint from %q promoted from unrelated evidence", source)
		}
		d.Capabilities["ipp_verified"] = true
		if !IsRuntimeDiscoveryPrinter(d) {
			t.Fatalf("IPP-confirmed endpoint from %q was rejected", source)
		}
	}
}

func TestIPPPortScanAndMDNSShareStrictProtocolStateProof(t *testing.T) {
	for _, c := range []struct {
		attrs map[string]string
		good  bool
	}{
		{map[string]string{"printer-state": "3"}, true},
		{map[string]string{"printer-state": "4"}, true},
		{map[string]string{"printer-state": "5"}, true},
		{map[string]string{"printer-state": "999"}, false},
		{map[string]string{"status-message": "successful-ok"}, false},
		{nil, false},
	} {
		if hasUsableIPPPrinterState(c.attrs) != c.good {
			t.Fatalf("unexpected IPP proof decision for %v", c.attrs)
		}
	}
}

func TestMDNSProbePromotesOnlyUsableIPPState(t *testing.T) {
	for _, tt := range []struct {
		name   string
		attrs  map[string]string
		err    error
		verify bool
		status string
	}{
		{"idle", map[string]string{"printer-state": "3", "printer-is-accepting-jobs": "true"}, nil, true, "online"},
		{"busy", map[string]string{"printer-state": "4"}, nil, true, "busy"},
		{"stopped", map[string]string{"printer-state": "5"}, nil, true, "error"},
		{"unsupported", map[string]string{"document-format-supported": "application/pdf"}, nil, false, "unknown"},
		{"malformed", map[string]string{"printer-state": "999"}, nil, false, "unknown"},
		{"timeout", nil, context.DeadlineExceeded, false, "unknown"},
		{"refusal", nil, errors.New("HTTP 403"), false, "unknown"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			devices := []DeviceInfo{mdnsCandidateForVerification("10.0.0.27")}
			var calls atomic.Int32
			verifyMDNSIPPCandidatesWithProbe(context.Background(), devices, func(_ context.Context, _ DeviceInfo) (map[string]string, error) {
				calls.Add(1)
				return tt.attrs, tt.err
			})
			if calls.Load() != 1 {
				t.Fatalf("probe count %d", calls.Load())
			}
			if verified, _ := devices[0].Capabilities["ipp_verified"].(bool); verified != tt.verify {
				t.Fatalf("verified=%t want %t", verified, tt.verify)
			}
			if devices[0].Status != tt.status {
				t.Fatalf("status %s, want %s", devices[0].Status, tt.status)
			}
			if got := IsRuntimeDiscoveryPrinter(devices[0]); got != tt.verify {
				t.Fatalf("runtime promotion=%t want %t", got, tt.verify)
			}
		})
	}
}

func TestMDNSProbeKeepsUntrustedEndpointsOffNetwork(t *testing.T) {
	devices := []DeviceInfo{mdnsCandidateForVerification("127.0.0.1"), mdnsCandidateForVerification("8.8.8.8"), mdnsCandidateForVerification("10.0.0.27")}
	var calls atomic.Int32
	verifyMDNSIPPCandidatesWithProbe(context.Background(), devices, func(_ context.Context, _ DeviceInfo) (map[string]string, error) {
		calls.Add(1)
		return map[string]string{"printer-state": "3"}, nil
	})
	if calls.Load() != 1 {
		t.Fatalf("network probe executed for %d endpoints instead of one permitted RFC1918 host", calls.Load())
	}
	for n := 0; n < 2; n++ {
		if IsRuntimeDiscoveryPrinter(devices[n]) {
			t.Fatalf("unsafe endpoint %d promoted", n)
		}
	}
	if !IsRuntimeDiscoveryPrinter(devices[2]) {
		t.Fatal("safe endpoint not promoted after successful probe")
	}
}

func TestMDNSProbeIsBoundedAndCancellationAware(t *testing.T) {
	devices := make([]DeviceInfo, 72)
	for i := range devices {
		devices[i] = mdnsCandidateForVerification(fmt.Sprintf("10.1.%d.%d", i/255, i%255+1))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var active, maximum atomic.Int32
	start := time.Now()
	verifyMDNSIPPCandidatesWithProbe(ctx, devices, func(probeCtx context.Context, _ DeviceInfo) (map[string]string, error) {
		now := active.Add(1)
		for {
			max := maximum.Load()
			if now <= max || maximum.CompareAndSwap(max, now) {
				break
			}
		}
		defer active.Add(-1)
		<-probeCtx.Done()
		return nil, probeCtx.Err()
	})
	if max := maximum.Load(); max == 0 || max > maxMDNSVerificationWorkers {
		t.Fatalf("expected actual bounded concurrent probes, got concurrency %d", max)
	}
	if duration := time.Since(start); duration > 600*time.Millisecond {
		t.Fatalf("candidate verification blocked after context expiration: %s", duration)
	}
	for _, di := range devices {
		if IsRuntimeDiscoveryPrinter(di) {
			t.Fatal("failed or unexecuted probe promoted candidate")
		}
	}
}

func TestIPPSourceMergePrefersConfirmedProtocolOverEarlierAdvertisement(t *testing.T) {
	mdns := mdnsCandidateForVerification("10.0.0.27")
	mdns.Name = "Advertised but not responding"
	confirmed := mdnsCandidateForVerification("10.0.0.27")
	confirmed.Name = "Confirmed TCP IPP service"
	confirmed.Capabilities["ipp_verified"] = true
	confirmed.Capabilities["verification"] = "verified"
	confirmed.Status = "online"

	merged := mergeIPPSourceObservations([]DeviceInfo{mdns}, []DeviceInfo{confirmed})
	if len(merged) != 1 || merged[0].Name != confirmed.Name || !IsRuntimeDiscoveryPrinter(merged[0]) {
		t.Fatalf("earlier mDNS candidate hid a confirmed TCP IPP result: %+v", merged)
	}

	mdns.Capabilities["ipp_verified"] = true
	mdns.Capabilities["verification"] = "verified"
	merged = mergeIPPSourceObservations([]DeviceInfo{mdns}, []DeviceInfo{confirmed})
	if len(merged) != 1 || merged[0].Name != mdns.Name {
		t.Fatalf("equally confirmed DNS-SD observations lost their preferred metadata: %+v", merged)
	}
}
