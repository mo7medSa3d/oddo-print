package printer

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"

	"github.com/grandcat/zeroconf"
)

func TestMDNSDiscoveryPreservesWorkingIPFamily(t *testing.T) {
	for _, tc := range []struct {
		name   string
		failed zeroconf.IPType
	}{
		{"both_available", 0},
		{"ipv6_unavailable", zeroconf.IPv6},
		{"ipv4_unavailable", zeroconf.IPv4},
		{"both_unavailable", zeroconf.IPv4AndIPv6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			calls := make(map[zeroconf.IPType]int)
			devices, err := discoverMDNSPrintersWithBrowse(context.Background(), func(_ context.Context, family zeroconf.IPType, service string, entries chan<- *zeroconf.ServiceEntry) error {
				defer close(entries)
				mu.Lock()
				calls[family]++
				mu.Unlock()
				if tc.failed&family != 0 {
					return errors.New("multicast unavailable")
				}
				if service == "_printer._tcp" {
					// Either traffic family may carry the same A record; dedupe it.
					for n := 0; n < 2; n++ {
						entries <- &zeroconf.ServiceEntry{
							ServiceRecord: zeroconf.ServiceRecord{Service: service, Instance: "Queue"},
							Port:          515,
							AddrIPv4:      []net.IP{net.ParseIP("192.168.1.25")},
						}
					}
				}
				return nil
			})
			if (err != nil) != (tc.failed != 0) {
				t.Fatalf("family failures must be reported alongside partial results: %v", err)
			}
			for _, family := range []zeroconf.IPType{zeroconf.IPv4, zeroconf.IPv6} {
				if calls[family] != 3 {
					t.Fatalf("family %d browsed %d services, want 3", family, calls[family])
				}
			}
			want := 1
			if tc.failed == zeroconf.IPv4AndIPv6 {
				want = 0
			}
			if len(devices) != want {
				t.Fatalf("working advertisements lost or duplicated: got %d want %d", len(devices), want)
			}
			if want == 1 && (devices[0].Status != "unknown" || isCapabilityVerified(devices[0].Capabilities, "ipp_verified")) {
				t.Fatal("a multicast advertisement cannot establish printer health or IPP support")
			}
		})
	}
}

func TestMDNSDiscoveryRetainsIPv6Destination(t *testing.T) {
	devices, err := discoverMDNSPrintersWithBrowse(context.Background(), func(_ context.Context, family zeroconf.IPType, service string, entries chan<- *zeroconf.ServiceEntry) error {
		defer close(entries)
		if family == zeroconf.IPv6 && service == "_printer._tcp" {
			entries <- &zeroconf.ServiceEntry{
				ServiceRecord: zeroconf.ServiceRecord{Service: service, Instance: "IPv6 Queue"},
				Port:          515,
				AddrIPv6:      []net.IP{net.ParseIP("fd12:3456::25")},
			}
		}
		return nil
	})
	if err != nil || len(devices) != 1 || devices[0].Endpoint != "[fd12:3456::25]:515" {
		t.Fatalf("IPv6 destination not preserved: devices=%+v err=%v", devices, err)
	}
}
