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

	"github.com/grandcat/zeroconf"
)

// discoverIPPPrinters performs IPP/IPPS discovery via TCP 631 scan and mDNS.
// It is additive and bounded. Currently TCP 631 scan is primary; mDNS is best-effort.
func discoverIPPPrinters(ctx context.Context) ([]DeviceInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	// First, try mDNS for _ipp._tcp.local and _ipps._tcp.local
	mdnsFound, mdnsErr := discoverMDNSPrinters(ctx)

	// Then TCP 631 scan of local private subnets (similar to 9100)
	tcpFound, err := discoverIPPviaTCP(ctx)
	if err != nil {
		log.Printf("[discovery] IPP TCP scan error: %v", err)
	}

	// Merge mDNS and TCP results with dedup by host:port
	seen := make(map[string]bool)
	var out []DeviceInfo
	for _, di := range append(mdnsFound, tcpFound...) {
		key := di.Endpoint
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, di)
	}
	if len(out) > 0 {
		log.Printf("[discovery] IPP discovery found %d printers (mDNS %d, TCP %d)", len(out), len(mdnsFound), len(tcpFound))
	} else {
		log.Printf("[discovery] IPP discovery: no printers found (mDNS %d, TCP %d)", len(mdnsFound), len(tcpFound))
	}
	return out, errors.Join(mdnsErr, err)
}

func discoverIPPviaTCP(ctx context.Context) ([]DeviceInfo, error) {
	hosts, diagnostics := localPrivateDiscoveryTargets()
	var sourceErr error
	if len(diagnostics) > 0 {
		sourceErr = errors.New(strings.Join(diagnostics, "; "))
	}
	targets := make([]string, 0, len(hosts))
	for _, host := range hosts {
		targets = append(targets, net.JoinHostPort(host, "631"))
	}
	if len(targets) == 0 {
		return nil, sourceErr
	}
	const workers = 32
	const perHostTimeout = 500 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for target := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				host, portStr, err := net.SplitHostPort(target)
				if err != nil {
					log.Printf("[discovery] skipping malformed IPP target %q: %v", target, err)
					continue
				}
				d := net.Dialer{Timeout: perHostTimeout}
				connCtx, cancel := context.WithTimeout(ctx, perHostTimeout)
				conn, err := d.DialContext(connCtx, "tcp", target)
				cancel()
				if err != nil {
					// Most hosts on a /24 refuse the connection: skipping
					// the target must not kill this worker (a plain return
					// here silently drained the worker pool after ~32
					// refusals and truncated the scan).
					continue
				}
				conn.Close()
				port := 631
				fmt.Sscanf(portStr, "%d", &port)
				// Try to verify it is really IPP by doing Get-Printer-Attributes.
				// A bare TCP/631 listener is only a discovery candidate: it must
				// never become executable inventory until the IPP protocol probe
				// succeeds. mDNS IPP advertisements are handled separately.
				ippURL := fmt.Sprintf("ipp://%s/ipp/print", target)
				ippProbe, constructorErr := NewIPPPrinter(ippURL, host)
				status := "unknown"
				verified := false
				statusDetail := "probe_unanswered"
				probeCtx, cancel2 := context.WithTimeout(ctx, 2*time.Second)
				if constructorErr == nil {
					// Reuse this probe's attributes with the single shared
					// interpreter (no second probe): a reachable IPP endpoint
					// whose printer-state is stopped/paused/rejecting must
					// not be reported online.
					if attrs, probeErr := ippProbe.getPrinterAttributes(probeCtx); probeErr == nil {
						status, statusDetail = interpretIPPPrinterStatus(attrs)
						verified = true
					}
				}
				cancel2()
				id := StableIDFromNetwork(host, port)
				// Use ipp:// URL as endpoint for later printing
				name := fmt.Sprintf("IPP Printer %s", host)

				// Bounded rDNS reverse lookup (500ms)
				rDnsCtx, rDnsCancel := context.WithTimeout(ctx, 500*time.Millisecond)
				var resolver net.Resolver
				if names, err := resolver.LookupAddr(rDnsCtx, host); err == nil && len(names) > 0 {
					n := strings.TrimSuffix(names[0], ".")
					if n != "" {
						name = fmt.Sprintf("IPP Printer %s (%s)", host, n)
					}
				}
				rDnsCancel()

				verification := "candidate_only"
				protocol := "unknown"
				connectionType := "network"
				typeName := "network"
				if verified {
					verification = "verified"
					protocol = "ipp"
					connectionType = "ipp"
					typeName = "ipp"
				}
				di := DeviceInfo{
					ID:             id,
					Name:           name,
					DisplayName:    name,
					PrinterType:    "unknown",
					ConnectionType: connectionType,
					Protocol:       protocol,
					Endpoint:       ippURL,
					NetworkAddress: host,
					Port:           port,
					Status:         status,
					Enabled:        true,
					Type:           typeName,
					Capabilities: map[string]interface{}{
						"discovered_via":     "ipp_tcp_scan",
						"candidate_protocol": "ipp",
						"verification":       verification,
						"ipp_url":            ippURL,
						"ipp_verified":       verified,
						"ipp_status_detail":  statusDetail,
					},
				}
				select {
				case results <- di:
					log.Printf("[discovery] found IPP printer: %s:631 -> %s", host, id)
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	dispatched := 0
targetLoop:
	for _, t := range targets {
		select {
		case jobs <- t:
			dispatched++
		case <-ctx.Done():
			break targetLoop
		}
	}
	close(jobs)
	// discovery_extended.go): close(results) only after EVERY worker has
	// finished its send. Workers are bounded: dial/rDNS/IPP-probe contexts
	// all derive from this ctx, so each returns within ~1s of expiry and
	// buffered sends never block.
	// Channel-ownership law (see discoverSNMPPrinters in
	// discovery_extended.go): close(results) only after EVERY worker has
	// finished its send. Workers are bounded: dial/rDNS/IPP-probe contexts
	// all derive from this ctx, so each returns within ~1s of expiry and
	// buffered sends never block.
	wg.Wait()
	close(results)
	var out []DeviceInfo
	seenID := make(map[string]bool)
	for di := range results {
		if !seenID[di.ID] {
			seenID[di.ID] = true
			out = append(out, di)
		}
	}
	// A scan that could not dispatch every target is partial inventory, not
	// a complete one: callers gate pruning on a nil error, so truncation
	// must surface as one. A fully dispatched scan stays clean even when
	// the context expires during the bounded result drain (C006).
	if dispatched < len(targets) {
		return out, errors.Join(sourceErr, fmt.Errorf("IPP TCP scan truncated: %d of %d targets probed: %w", dispatched, len(targets), ctx.Err()))
	}
	return out, sourceErr
}

// discoverMDNSPrinters performs mDNS query for _ipp._tcp, _ipps._tcp, and _printer._tcp.
func discoverMDNSPrinters(ctx context.Context) ([]DeviceInfo, error) {

	browseCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	services := []string{"_ipp._tcp", "_ipps._tcp", "_printer._tcp"}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var out []DeviceInfo
	var diagnostics []error
	seen := make(map[string]bool)

	for _, svc := range services {
		wg.Add(1)
		go func(s string) {
			defer wg.Done()
			// Each Browse owns and closes its resolver's sockets.
			resolver, err := zeroconf.NewResolver(nil)
			if err != nil {
				mu.Lock()
				diagnostics = append(diagnostics, fmt.Errorf("mDNS %s resolver: %w", s, err))
				mu.Unlock()
				return
			}
			ch := make(chan *zeroconf.ServiceEntry, 32)
			doneCh := make(chan struct{})
			go func() {
				defer close(doneCh)
				for entry := range ch {
					di, ok := parseMDNSServiceEntry(entry)
					if !ok {
						continue
					}
					key := di.Endpoint
					mu.Lock()
					if !seen[key] {
						seen[key] = true
						out = append(out, di)
					}
					mu.Unlock()
				}
			}()

			if err := resolver.Browse(browseCtx, s, "local.", ch); err != nil {
				mu.Lock()
				diagnostics = append(diagnostics, fmt.Errorf("mDNS %s Browse: %w", s, err))
				mu.Unlock()
			}
			<-doneCh
		}(svc)
	}

	wg.Wait()
	return out, errors.Join(diagnostics...)
}

func parseMDNSServiceEntry(entry *zeroconf.ServiceEntry) (DeviceInfo, bool) {
	if entry == nil {
		return DeviceInfo{}, false
	}
	var address net.IP
	if len(entry.AddrIPv4) > 0 {
		address = entry.AddrIPv4[0]
	}
	if address == nil {
		for _, candidate := range entry.AddrIPv6 {
			// Link-local IPv6 requires an interface zone absent from ServiceEntry.
			if candidate != nil && !candidate.IsLinkLocalUnicast() {
				address = candidate
				break
			}
		}
	}
	if address == nil {
		return DeviceInfo{}, false
	}
	ip := address.String()
	port := entry.Port
	if port <= 0 || port > 65535 {
		return DeviceInfo{}, false
	}

	txtMeta := parseMDNSTXT(entry.Text)

	name := txtMeta.ty
	if name == "" {
		name = txtMeta.product
	}
	if name == "" && txtMeta.model != "" {
		name = txtMeta.model
	}
	if name == "" {
		name = entry.Instance
	}
	if name == "" {
		name = fmt.Sprintf("mDNS Printer %s", ip)
	}

	rp := txtMeta.rp
	if rp == "" {
		rp = "ipp/print"
	}
	rpClean := strings.TrimPrefix(rp, "/")

	protocol := "ipp"
	endpointScheme := "ipp"
	if strings.Contains(entry.Service, "_ipps") {
		protocol = "ipps"
		endpointScheme = "ipps"
	}

	if strings.Contains(entry.Service, "_printer._tcp") {
		protocol = "lpr"
		endpointScheme = "lpd"
	}
	endpoint := fmt.Sprintf("%s://%s/%s", endpointScheme, net.JoinHostPort(ip, fmt.Sprint(port)), rpClean)
	if protocol == "lpr" {
		endpoint = net.JoinHostPort(ip, fmt.Sprint(port))
	}
	connectionType := protocol
	if protocol == "lpr" {
		connectionType = "network"
	}

	caps := map[string]interface{}{
		"mdns_verified":  protocol != "lpr",
		"discovered_via": SourceMDNS,
		"pdl":            txtMeta.pdlList,
	}
	if txtMeta.mfg != "" {
		caps["manufacturer"] = txtMeta.mfg
	}
	if txtMeta.model != "" {
		caps["model"] = txtMeta.model
	}
	if txtMeta.ty != "" {
		caps["ty"] = txtMeta.ty
	}
	if txtMeta.rp != "" {
		caps["rp"] = txtMeta.rp
	}

	di := DeviceInfo{
		ID:             StableIDFromIPPURI(endpoint, ip, port),
		Name:           name,
		DisplayName:    name,
		PrinterType:    "unknown",
		ConnectionType: connectionType,
		Protocol:       protocol,
		Endpoint:       endpoint,
		NetworkAddress: ip,
		Port:           port,
		Status:         "unknown",
		Enabled:        true,
		Type:           connectionType,
		Capabilities:   caps,
	}
	if protocol == "lpr" {
		di.ID = StableIDFromNetwork(ip, port)
	}
	return di, true
}

type mdnsTXTMetadata struct {
	ty      string
	product string
	rp      string
	pdlList []string
	mfg     string
	model   string
}

func parseMDNSTXT(text []string) mdnsTXTMetadata {
	var meta mdnsTXTMetadata
	for _, t := range text {
		parts := strings.SplitN(t, "=", 2)
		k := strings.ToLower(strings.TrimSpace(parts[0]))
		v := ""
		if len(parts) == 2 {
			v = strings.TrimSpace(parts[1])
		}
		switch k {
		case "ty":
			meta.ty = v
		case "product":
			meta.product = strings.Trim(v, "()")
		case "rp":
			meta.rp = v
		case "pdl":
			if v != "" {
				for _, p := range strings.Split(v, ",") {
					p = strings.TrimSpace(p)
					if p != "" {
						meta.pdlList = append(meta.pdlList, p)
					}
				}
			}
		case "usb_mfg":
			meta.mfg = v
		case "usb_mdl":
			meta.model = v
		}
	}
	return meta
}
