package printer

import (
	"net"
	"strings"
	"testing"
)

func privateSubnet(t *testing.T, host, prefix string) *net.IPNet {
	t.Helper()
	_, parsed, err := net.ParseCIDR(prefix)
	if err != nil {
		t.Fatal(err)
	}
	parsed.IP = net.ParseIP(host)
	return parsed
}

func TestAutomaticDiscoverySharedSubnetDedupesByNetworkNotInterfaceAddress(t *testing.T) {
	// Two interfaces can have separate local addresses on the same /24. A
	// per-host IPNet.String key re-scanned every destination twice.
	one := privateSubnet(t, "10.45.2.20", "10.45.2.0/24")
	two := privateSubnet(t, "10.45.2.21", "10.45.2.0/24")
	targets, truncated := privateDiscoveryTargetsWithBudget([]*net.IPNet{one, two}, maxAutomaticDiscoveryTargets)
	if truncated || len(targets) != 253 {
		t.Fatalf("duplicate adapter generated %d targets, truncated=%v", len(targets), truncated)
	}
	seen := map[string]bool{}
	for _, target := range targets {
		if seen[target] {
			t.Fatalf("duplicate probe to %q", target)
		}
		seen[target] = true
	}
}

func TestAutomaticDiscoveryCapsCrossSubnetCostFairlyAndSignalsPartial(t *testing.T) {
	subnets := []*net.IPNet{
		privateSubnet(t, "10.45.2.20", "10.45.2.0/24"),
		privateSubnet(t, "10.46.3.22", "10.46.3.0/24"),
		privateSubnet(t, "10.47.4.24", "10.47.4.0/24"),
		privateSubnet(t, "10.48.5.26", "10.48.5.0/24"),
	}
	hosts, truncated := privateDiscoveryTargetsWithBudget(subnets, maxAutomaticDiscoveryTargets)
	if !truncated || len(hosts) != maxAutomaticDiscoveryTargets {
		t.Fatalf("unbounded/misclassified probe set: count=%d partial=%v", len(hosts), truncated)
	}
	counts := map[string]int{}
	for _, host := range hosts {
		counts[strings.Join(strings.Split(host, ".")[:3], ".")]++
	}
	if len(counts) != 4 {
		t.Fatalf("budget must reach all four subnets, counts=%v", counts)
	}
	for subnet, n := range counts {
		if n < 120 || n > 130 {
			t.Fatalf("unfair budget for %s: %d", subnet, n)
		}
	}
}

func TestAutomaticDiscoveryCompleteWhenNotTruncated(t *testing.T) {
	subnets := []*net.IPNet{
		privateSubnet(t, "10.45.2.20", "10.45.2.0/24"),
		privateSubnet(t, "10.46.3.22", "10.46.3.0/24"),
	}
	hosts, truncated := privateDiscoveryTargetsWithBudget(subnets, maxAutomaticDiscoveryTargets)
	if truncated || len(hosts) != 506 {
		t.Fatalf("unexpected complete scan count=%d partial=%v", len(hosts), truncated)
	}
	if !strings.HasPrefix(hosts[0], "10.45.2.") || !strings.HasPrefix(hosts[1], "10.46.3.") {
		t.Fatalf("interleaving unexpectedly changed: %v", hosts[:2])
	}
}

func TestAutomaticDiscoveryClampsWideCIDRAroundActualHost(t *testing.T) {
	target := privateSubnet(t, "10.45.188.22", "10.45.0.0/16")
	hosts, truncated := privateDiscoveryTargetsWithBudget([]*net.IPNet{target}, maxAutomaticDiscoveryTargets)
	if truncated || len(hosts) != 253 || hosts[0] != "10.45.188.1" {
		t.Fatalf("wide subnet scanned wrong /24 or overran: len=%d partial=%v first=%v", len(hosts), truncated, hosts)
	}
}

func TestAutomaticDiscoveryZeroBudgetIsPartialUnlessNoHosts(t *testing.T) {
	subnet := privateSubnet(t, "10.45.2.20", "10.45.2.0/24")
	hosts, partial := privateDiscoveryTargetsWithBudget([]*net.IPNet{subnet}, 0)
	if len(hosts) != 0 || !partial {
		t.Fatalf("zero budget should mark partial, count=%d partial=%v", len(hosts), partial)
	}
	hosts, partial = privateDiscoveryTargetsWithBudget(nil, 0)
	if len(hosts) != 0 || partial {
		t.Fatalf("empty scan should be complete, count=%d partial=%v", len(hosts), partial)
	}
}

func TestAutomaticDiscoveryDeduplicatesOverlappingSubnetMasks(t *testing.T) {
	// Multiple adapters may report overlapping CIDRs with different masks.
	// A unique (network,prefix) key alone is insufficient to avoid probing
	// the same host twice, wasting slots in the global discovery budget.
	subnets := []*net.IPNet{
		privateSubnet(t, "10.45.2.20", "10.45.2.0/24"),
		privateSubnet(t, "10.45.2.25", "10.45.2.0/25"),
	}
	hosts, truncated := privateDiscoveryTargetsWithBudget(subnets, maxAutomaticDiscoveryTargets)
	if truncated {
		t.Fatal("overlapping networks must fit in budget")
	}
	seen := make(map[string]bool)
	for _, host := range hosts {
		if seen[host] {
			t.Fatalf("same host targeted twice across overlapping CIDRs: %s", host)
		}
		seen[host] = true
	}
	if len(hosts) != 254 {
		t.Fatalf("wanted 254 unique network hosts, got %d", len(hosts))
	}
}
