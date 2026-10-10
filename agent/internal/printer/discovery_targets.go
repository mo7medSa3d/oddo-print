package printer

import (
	"fmt"
	"net"
)

// maxAutomaticDiscoveryTargets caps active probes per source across ALL local
// subnets, not per interface. An installation with dozens of VPN/LAN adapters
// must not enqueue unbounded TCP/SNMP/LPR/IPP probes on every discovery cycle.
const maxAutomaticDiscoveryTargets = 512

func generateHosts(ipNet *net.IPNet) []net.IP {
	var hosts []net.IP
	ip := ipNet.IP.To4()
	mask := ipNet.Mask
	if ip == nil {
		return hosts
	}
	network := ip.Mask(mask)
	// For /24, iterate 1..254
	// For other masks, iterate all hosts but cap
	ones, bits := mask.Size()
	if bits != 32 {
		return hosts
	}
	total := 1 << (32 - ones)
	if total > 1024 {
		total = 1024 // safety cap
	}
	base := ipToUint32(network)
	for i := 1; i < total-1 && len(hosts) < 254; i++ {
		h := uint32ToIP(base + uint32(i))
		if h != nil {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

func ipToUint32(ip net.IP) uint32 {
	ip = ip.To4()
	if ip == nil {
		return 0
	}
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}
func uint32ToIP(n uint32) net.IP {
	return net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}

// privateDiscoveryTargets fairly schedules every local subnet. Wide networks
// are bounded to the local /24 rather than the first /24 of a /8 or /16.
func privateDiscoveryTargets(subnets []*net.IPNet) []string {
	targets, _ := privateDiscoveryTargetsWithBudget(subnets, maxAutomaticDiscoveryTargets)
	return targets
}

// privateDiscoveryTargetsWithBudget round-robins subnets to avoid starving all
// but the first interface when a budget is reached. Each subnet is canonicalized
// to its network address before deduplicating overlapping local interfaces.
// truncated is an important negative observation: callers must not treat a
// limited scan as an authoritative complete inventory.
func privateDiscoveryTargetsWithBudget(subnets []*net.IPNet, budget int) ([]string, bool) {
	var groups [][]string
	seenSubnets := make(map[string]bool)
	for _, subnet := range subnets {
		ip := subnet.IP.To4()
		if ip == nil || !ip.IsPrivate() || ip.IsLoopback() {
			continue
		}
		mask := subnet.Mask
		if len(mask) == 16 {
			mask = mask[12:]
		}
		ones, bits := mask.Size()
		if bits != 32 {
			continue
		}
		if ones < 24 {
			mask = net.CIDRMask(24, 32)
		}
		local := &net.IPNet{IP: ip, Mask: mask}
		key := (&net.IPNet{IP: ip.Mask(mask), Mask: mask}).String()
		if seenSubnets[key] {
			continue
		}
		seenSubnets[key] = true
		var group []string
		for _, host := range generateHosts(local) {
			if !host.Equal(ip) {
				group = append(group, host.String())
			}
		}
		groups = append(groups, group)
	}
	if budget < 0 {
		budget = 0
	}
	var targets []string
	seenHosts := make(map[string]struct{})
	for offset := 0; ; offset++ {
		hasCandidates := false
		for _, group := range groups {
			if offset < len(group) {
				hasCandidates = true
				host := group[offset]
				if _, seen := seenHosts[host]; seen {
					continue
				}
				if len(targets) >= budget {
					return targets, true
				}
				seenHosts[host] = struct{}{}
				targets = append(targets, host)
			}
		}
		if !hasCandidates {
			break
		}
	}
	return targets, false
}

func localPrivateDiscoveryTargets() ([]string, []string) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, []string{fmt.Sprintf("network interfaces: %v", err)}
	}
	var subnets []*net.IPNet
	var diagnostics []string
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			diagnostics = append(diagnostics, fmt.Sprintf("addresses for %s: %v", iface.Name, err))
			continue
		}
		for _, address := range addresses {
			if subnet, ok := address.(*net.IPNet); ok {
				subnets = append(subnets, subnet)
			}
		}
	}
	targets, truncated := privateDiscoveryTargetsWithBudget(subnets, maxAutomaticDiscoveryTargets)
	if truncated {
		diagnostics = append(diagnostics, fmt.Sprintf("automatic discovery truncated to %d unique hosts across interfaces; source inventory is partial", maxAutomaticDiscoveryTargets))
	}
	return targets, diagnostics
}
