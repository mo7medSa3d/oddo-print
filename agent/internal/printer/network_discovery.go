package printer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// discoverNetworkPrinters performs active LAN discovery for RAW TCP printers
// (port 9100). It is additive to spooler enumeration and respects safety:
// - only scans private IPv4 subnets derived from local interfaces
// - bounded concurrency (32), per-host 500ms, global 8s timeout
// - context cancellation
// - deduplication via stable ID
// Returns DeviceInfos with ConnectionType network and a verified TCP endpoint.
// Port 9100 reachability does not identify the print language, so Protocol
// remains unknown until an operator or a protocol-specific probe identifies it.
func discoverNetworkPrinters(ctx context.Context) ([]DeviceInfo, error) {
	// Global timeout for network discovery
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("net.Interfaces: %w", err)
	}

	var subnets []*net.IPNet
	localIPs := make(map[string]bool)
	var sourceDiagnostics []error

	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Shared exclusion list (see isDiscoveryInterfaceExcluded): virtual
		// bridges, VPN tunnels and tailscale/tap devices never consume scan
		// budget on any discovery source.
		if isDiscoveryInterfaceExcluded(iface.Name) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			sourceDiagnostics = append(sourceDiagnostics, fmt.Errorf("interface %s addresses unreadable: %w", iface.Name, err))
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || !ip.IsPrivate() || ip.IsLoopback() || ip.IsMulticast() {
				continue
			}
			localIPs[ip.String()] = true
			subnets = append(subnets, ipNet)
		}
	}

	hosts, truncated := privateDiscoveryTargetsWithBudget(subnets, maxAutomaticDiscoveryTargets)
	if truncated {
		sourceDiagnostics = append(sourceDiagnostics, fmt.Errorf("network TCP scan limited to %d unique hosts; inventory is partial", maxAutomaticDiscoveryTargets))
	}
	targets := make([]string, 0, len(hosts))
	for _, host := range hosts {
		if !localIPs[host] {
			targets = append(targets, net.JoinHostPort(host, "9100"))
		}
	}

	var tcpDevices []DeviceInfo
	dispatchedTargets := 0
	if len(targets) == 0 {
		log.Printf("[discovery] network discovery: no private subnets found, skipping TCP scan")
	} else {
		// Bounded concurrent TCP probes
		const tcpWorkers = 32
		const perHostTimeout = 500 * time.Millisecond

		jobs := make(chan string, len(targets))
		openHosts := make(chan DeviceInfo, len(targets))
		results := make(chan DeviceInfo, len(targets))

		var tcpWg sync.WaitGroup
		for w := 0; w < tcpWorkers; w++ {
			tcpWg.Add(1)
			go func() {
				defer tcpWg.Done()
				for target := range jobs {
					select {
					case <-ctx.Done():
						return
					default:
					}
					host, portStr, err := net.SplitHostPort(target)
					if err != nil {
						log.Printf("[discovery] skipping malformed TCP target %q: %v", target, err)
						continue
					}
					d := net.Dialer{Timeout: perHostTimeout}
					connCtx, cancel := context.WithTimeout(ctx, perHostTimeout)
					conn, err := d.DialContext(connCtx, "tcp", target)
					cancel()
					if err != nil {
						continue
					}
					conn.Close()

					port := 9100
					if portStr != "" {
						fmt.Sscanf(portStr, "%d", &port)
					}
					id := StableIDFromNetwork(host, port)
					name := fmt.Sprintf("Network Printer %s", host)

					// Bounded rDNS reverse lookup (500ms)
					rDnsCtx, rDnsCancel := context.WithTimeout(ctx, 500*time.Millisecond)
					var resolver net.Resolver
					if names, err := resolver.LookupAddr(rDnsCtx, host); err == nil && len(names) > 0 {
						n := strings.TrimSuffix(names[0], ".")
						if n != "" {
							name = fmt.Sprintf("Network Printer %s (%s)", host, n)
						}
					}
					rDnsCancel()

					di := DeviceInfo{
						ID:             id,
						Name:           name,
						DisplayName:    name,
						PrinterType:    "unknown",
						ConnectionType: "network",
						Protocol:       "unknown",
						Endpoint:       target,
						NetworkAddress: host,
						Port:           port,
						Status:         "unknown",
						Enabled:        true,
						Type:           "network",
						Capabilities: map[string]interface{}{
							"discovered_via": "tcp_port_scan",
							"port":           port,
							"verification":   "print_endpoint_verified",
							"confidence":     "low",
						},
					}
					select {
					case openHosts <- di:
						log.Printf("[discovery] found TCP printer: %s (9100) -> %s", host, id)
					case <-ctx.Done():
						return
					}
				}
			}()
		}

		// SNMP worker pool (max 16 concurrent workers) to enrich candidate metadata
		const snmpWorkers = 16
		var snmpWg sync.WaitGroup
		for sw := 0; sw < snmpWorkers; sw++ {
			snmpWg.Add(1)
			go func() {
				defer snmpWg.Done()
				for di := range openHosts {
					select {
					case <-ctx.Done():
						return
					default:
					}

					snmpDev, ok := probeSNMPPrinter(ctx, di.NetworkAddress)
					if ok {
						if di.Capabilities == nil {
							di.Capabilities = make(map[string]interface{})
						}
						di.Capabilities["snmp_verified"] = true
						di.Capabilities["discovered_via"] = SourceSNMP
						di.Capabilities["verification"] = "verified"
						di.Capabilities["confidence"] = "high"
						if snmpDev.Capabilities != nil {
							if descr, ok := snmpDev.Capabilities["sysDescr"]; ok {
								di.Capabilities["sysDescr"] = descr
							}
							if ser, ok := snmpDev.Capabilities["serial"]; ok && ser != "" {
								di.Capabilities["serial"] = ser
							}
							if mfg, ok := snmpDev.Capabilities["manufacturer"]; ok && mfg != "" {
								di.Capabilities["manufacturer"] = mfg
							}
						}
						if snmpDev.Name != "" && isGenericPrinterName(di.Name) {
							di.Name = snmpDev.Name
							di.DisplayName = snmpDev.DisplayName
						}
						if snmpDev.Protocol != "" && snmpDev.Protocol != "raw" {
							di.Protocol = snmpDev.Protocol
						}
						// SNMP sysDescr/serial and a TCP connection do not report
						// paper/device readiness; retain UNKNOWN until a
						// protocol-level status probe provides such evidence.
						di.Status = "unknown"
					}
					select {
					case results <- di:
					case <-ctx.Done():
						return
					}
				}
			}()
		}

	targetLoop:
		for _, t := range targets {
			select {
			case jobs <- t:
				dispatchedTargets++
			case <-ctx.Done():
				break targetLoop
			}
		}
		close(jobs)

		// Channel ownership is kept in the caller: wait for every TCP worker,
		// then close openHosts so SNMP workers can finish, then close results.
		// No detached channel-closer goroutines are needed.
		tcpWg.Wait()
		close(openHosts)
		snmpWg.Wait()
		close(results)

		for di := range results {
			tcpDevices = append(tcpDevices, di)
		}
	}

	// WSD has one independently accounted source in DiscoverAll. Keeping it
	// out of the TCP scanner preserves partial results and diagnostics there.
	out := mergeNetworkDevices(tcpDevices)
	log.Printf("[discovery] network discovery completed: %d printers found (TCP+SNMP)", len(out))
	return out, errors.Join(append(sourceDiagnostics, discoveryScanError("network TCP", dispatchedTargets, len(targets), ctx.Err()))...)
}

func isGenericPrinterName(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return true
	}
	if strings.HasPrefix(lower, "network printer") ||
		strings.HasPrefix(lower, "wsd printer") ||
		strings.HasPrefix(lower, "snmp printer") ||
		strings.HasPrefix(lower, "ipp printer") {
		return true
	}
	return false
}

func mergeNetworkDevices(devices []DeviceInfo) []DeviceInfo {
	merged := make(map[string]*DeviceInfo)
	var order []string

	for _, d := range devices {
		key := dedupeKey(d)
		if key == "" {
			if d.NetworkAddress != "" && d.Port > 0 {
				key = fmt.Sprintf("ip:%s:%d", strings.ToLower(d.NetworkAddress), d.Port)
			} else {
				key = d.ID
			}
		}
		if key == "" {
			key = StableIDForDevice(d)
		}

		// Also check by IP:Port to ensure TCP 9100 and WSD (with UUID) merge on same host
		ipPortKey := ""
		if d.NetworkAddress != "" && d.Port > 0 {
			ipPortKey = fmt.Sprintf("ip:%s:%d", strings.ToLower(d.NetworkAddress), d.Port)
		}

		existing, ok := merged[key]
		if !ok && ipPortKey != "" {
			existing, ok = merged[ipPortKey]
		}

		if !ok {
			dCopy := d
			if dCopy.Capabilities == nil {
				dCopy.Capabilities = make(map[string]interface{})
			}
			if dCopy.ID == "" {
				dCopy.ID = StableIDForDevice(dCopy)
			}
			merged[key] = &dCopy
			if ipPortKey != "" && ipPortKey != key {
				merged[ipPortKey] = &dCopy
			}
			order = append(order, key)
			continue
		}

		// Merge attributes
		if existing.Capabilities == nil {
			existing.Capabilities = make(map[string]interface{})
		}

		for k, v := range d.Capabilities {
			if _, exists := existing.Capabilities[k]; !exists || v == true {
				existing.Capabilities[k] = v
			}
		}

		snmpV := isCapabilityVerified(existing.Capabilities, "snmp_verified") || isCapabilityVerified(d.Capabilities, "snmp_verified")
		mdnsV := isCapabilityVerified(existing.Capabilities, "ipp_verified") || isCapabilityVerified(d.Capabilities, "ipp_verified")

		if snmpV || mdnsV {
			existing.Capabilities["verification"] = "verified"
			existing.Capabilities["confidence"] = "high"
		}

		if isGenericPrinterName(existing.Name) && !isGenericPrinterName(d.Name) {
			existing.Name = d.Name
			existing.DisplayName = d.DisplayName
		}

		if mfg, ok := d.Capabilities["manufacturer"]; ok && fmt.Sprint(mfg) != "" {
			existing.Capabilities["manufacturer"] = mfg
		}
		if model, ok := d.Capabilities["model"]; ok && fmt.Sprint(model) != "" {
			existing.Capabilities["model"] = model
		}

		if (existing.Protocol == "" || existing.Protocol == "raw") && d.Protocol != "" && d.Protocol != "raw" {
			existing.Protocol = d.Protocol
		}

		if d.Status != "" && d.Status != "unknown" {
			// Preserve explicit negative health evidence. A successful
			// TCP connection must never be represented as printer-ready.
			existing.Status = d.Status
		}

		existing.ID = StableIDForDevice(*existing)
	}

	seen := make(map[string]bool)
	var out []DeviceInfo
	for _, k := range order {
		dev := merged[k]
		if dev != nil && !seen[dev.ID] {
			seen[dev.ID] = true
			out = append(out, *dev)
		}
	}
	return out
}

func isCapabilityVerified(caps map[string]interface{}, key string) bool {
	if caps == nil {
		return false
	}
	v, ok := caps[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b
}
