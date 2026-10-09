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
	"github.com/yaseir-agent/agent/internal/config"
)

// discoverIPPPrinters probes DNS-SD and subnet TCP concurrently. They share an
// overall deadline but never consume each other's discovery budget: a slow
// multicast network must not prevent direct IPP printers from being scanned.
func discoverIPPPrinters(ctx context.Context) ([]DeviceInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	mdnsResultCh := make(chan ippSourceResult, 1)
	go func() {
		devices, err := discoverMDNSPrinters(ctx)
		mdnsResultCh <- ippSourceResult{devices: devices, err: err}
	}()
	tcpFound, tcpErr := discoverIPPviaTCP(ctx)
	mdns := <-mdnsResultCh
	if tcpErr != nil {
		log.Printf("[discovery] IPP TCP scan warning: %v", tcpErr)
	}
	out := mergeIPPSourceObservations(mdns.devices, tcpFound)
	log.Printf("[discovery] IPP discovery found %d printers (mDNS %d, TCP %d)", len(out), len(mdns.devices), len(tcpFound))
	return out, errors.Join(mdns.err, tcpErr)
}

type ippSourceResult struct {
	devices []DeviceInfo
	err     error
}

// mergeIPPSourceObservations preserves the single best observation per actual
// destination. A responding TCP/IPP probe must never be hidden by an earlier
// DNS-SD *advertisement* for the same endpoint. Ties retain DNS-SD metadata
// (notably the advertised rp path) rather than silently overriding it.
func mergeIPPSourceObservations(sources ...[]DeviceInfo) []DeviceInfo {
	out := make([]DeviceInfo, 0)
	indexes := make(map[string]int)
	for _, source := range sources {
		for _, di := range source {
			if di.Endpoint == "" {
				continue
			}
			if idx, ok := indexes[di.Endpoint]; ok {
				if isCapabilityVerified(di.Capabilities, "ipp_verified") &&
					!isCapabilityVerified(out[idx].Capabilities, "ipp_verified") {
					out[idx] = di
				}
				continue
			}
			indexes[di.Endpoint] = len(out)
			out = append(out, di)
		}
	}
	return out
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
					if attrs, probeErr := ippProbe.getPrinterAttributes(probeCtx); probeErr == nil && hasUsableIPPPrinterState(attrs) {
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
	return out, errors.Join(sourceErr, discoveryScanError("IPP TCP", dispatched, len(targets), ctx.Err()))
}

// maxMDNSDiscoveryResults bounds memory under a noisy or hostile LAN.
// Browse still drains announcements after this limit so the resolver can
// close cleanly; no unknown printer is promoted just because the cap is hit.
const maxMDNSDiscoveryResults = 256

// appendMDNSDiscoveryResult is called with the shared collector mutex held.
// Only accepted endpoint keys consume memory; duplicate announcements do not.
func appendMDNSDiscoveryResult(out *[]DeviceInfo, seen map[string]bool, di DeviceInfo, limit int) bool {
	if limit <= 0 || len(*out) >= limit || di.Endpoint == "" || seen[di.Endpoint] {
		return false
	}
	seen[di.Endpoint] = true
	*out = append(*out, di)
	return true
}

// discoverMDNSPrinters performs mDNS query for _ipp._tcp, _ipps._tcp, and _printer._tcp.
func discoverMDNSPrinters(ctx context.Context) ([]DeviceInfo, error) {

	browseCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	services := []string{"_ipp._tcp", "_ipps._tcp", "_printer._tcp"}
	var wg sync.WaitGroup
	var mu sync.Mutex
	out := make([]DeviceInfo, 0, 32)
	var diagnostics []error
	seen := make(map[string]bool)
	truncated := false

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
					mu.Lock()
					full := len(out) >= maxMDNSDiscoveryResults
					if full {
						truncated = true
					}
					mu.Unlock()
					if full {
						// Keep draining the resolver's channel without allocating
						// more parsed metadata or retaining another endpoint.
						continue
					}
					di, ok := parseMDNSServiceEntry(entry)
					if !ok {
						continue
					}
					mu.Lock()
					appendMDNSDiscoveryResult(&out, seen, di, maxMDNSDiscoveryResults)
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
	if truncated {
		diagnostics = append(diagnostics, fmt.Errorf("mDNS results reached limit %d; further advertisements were ignored", maxMDNSDiscoveryResults))
	}
	// TXT service records only advertise an address. A device is verified
	// only after a bounded Get-Printer-Attributes exchange, and candidates
	// remain visible if a firewall or sleepy printer prevents the probe.
	verifyMDNSIPPCandidates(ctx, out)
	if err := ctx.Err(); err != nil {
		diagnostics = append(diagnostics, fmt.Errorf("mDNS IPP verification incomplete: %w", err))
	}
	return out, errors.Join(diagnostics...)
}

const (
	maxMDNSVerificationWorkers = 12
	mdnsVerificationTimeout    = 1500 * time.Millisecond
)

// A complete IPP response without a usable printer-state proves only that
// something answered over HTTP. Both DNS-SD and port-scan discovery must
// require the same protocol-level state before declaring the IPP endpoint
// verified; 3/4/5 are the only defined printer-state values (RFC 8011).
func hasUsableIPPPrinterState(attrs map[string]string) bool {
	switch attrs["printer-state"] {
	case "3", "4", "5":
		return true
	default:
		return false
	}
}

// verifyMDNSIPPCandidates never sends a document. It has independent bounded
// read-only probes and never treats DNS-SD TXT claims as IPP protocol proof.
// Concurrent workers each own a distinct result row; the input slice is not
// shared with the mDNS collector once the browse has finished.
func verifyMDNSIPPCandidates(ctx context.Context, candidates []DeviceInfo) {
	verifyMDNSIPPCandidatesWithProbe(ctx, candidates, func(probeCtx context.Context, di DeviceInfo) (map[string]string, error) {
		p, err := NewIPPPrinter(di.Endpoint, di.Name)
		if err != nil {
			return nil, err
		}
		return p.getPrinterAttributes(probeCtx)
	})
}

// verifyMDNSIPPCandidatesWithProbe isolates the read-only network exchange for
// deterministic concurrency/cancellation testing. The endpoint destination
// policy is enforced here regardless of the supplied probe implementation.
func verifyMDNSIPPCandidatesWithProbe(ctx context.Context, candidates []DeviceInfo, probe func(context.Context, DeviceInfo) (map[string]string, error)) {
	jobs := make(chan int)
	workers := len(candidates)
	if workers > maxMDNSVerificationWorkers {
		workers = maxMDNSVerificationWorkers
	}
	var wg sync.WaitGroup
	for n := 0; n < workers; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				di := &candidates[idx]
				if di.Protocol != "ipp" && di.Protocol != "ipps" {
					continue
				}
				// Untrusted multicast records cannot bypass the same policy as a
				// configured printer, even for this read-only HTTP request.
				pc := config.PrinterConfig{ID: di.ID, Type: di.Type, ConnectionType: di.ConnectionType, Protocol: di.Protocol, Endpoint: di.Endpoint}
				if err := config.ValidatePrinterEndpoint(pc); err != nil {
					continue
				}
				probeCtx, cancel := context.WithTimeout(ctx, mdnsVerificationTimeout)
				attrs, err := probe(probeCtx, *di)
				if err == nil && hasUsableIPPPrinterState(attrs) {
					status, detail := interpretIPPPrinterStatus(attrs)
					di.Status = status
					if di.Capabilities == nil {
						di.Capabilities = make(map[string]interface{})
					}
					di.Capabilities["ipp_verified"] = true
					di.Capabilities["mdns_verified"] = true
					di.Capabilities["verification"] = "verified"
					di.Capabilities["ipp_status_detail"] = detail
				}
				cancel()
			}
		}()
	}
submit:
	for idx := range candidates {
		select {
		case jobs <- idx:
		case <-ctx.Done():
			break submit
		}
	}
	close(jobs)
	wg.Wait()
}

func parseMDNSServiceEntry(entry *zeroconf.ServiceEntry) (DeviceInfo, bool) {
	if entry == nil {
		return DeviceInfo{}, false
	}
	var address net.IP
	for _, candidate := range entry.AddrIPv4 {
		if config.IsAllowedPrinterIP(candidate) {
			address = candidate
			break
		}
	}
	if address == nil {
		for _, candidate := range entry.AddrIPv6 {
			// Link-local IPv6 requires an interface zone absent from ServiceEntry.
			if config.IsAllowedPrinterIP(candidate) && !candidate.IsLinkLocalUnicast() {
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
		// DNS-SD announcement is discovery evidence, NOT a verified IPP
		// protocol exchange. verifyMDNSIPPCandidates can promote later.
		"mdns_verified":  false,
		"ipp_verified":   false,
		"verification":   "candidate",
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
	} else if err := config.ValidatePrinterEndpoint(config.PrinterConfig{
		ID: di.ID, Type: di.ConnectionType, Protocol: di.Protocol, Endpoint: di.Endpoint,
	}); err != nil {
		// An mDNS packet is untrusted discovery evidence, not permission to
		// contact an otherwise forbidden destination. Keep LPR as its existing
		// non-executable candidate path; only supported IPP endpoints promote.
		return DeviceInfo{}, false
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
