package printer

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

// IsRuntimeDiscoveryPrinter reports whether a discovery observation can be
// promoted into the production inventory. Some discovery sources deliberately
// return candidates that prove only that a service answered; those candidates
// remain useful to manager discovery but must not be persisted/count as local
// runnable printers until an execution backend exists.
func IsRuntimeDiscoveryPrinter(d DeviceInfo) bool {
	protocol := strings.ToLower(strings.TrimSpace(d.Protocol))
	if protocol == "lpr" {
		return false
	}
	if d.Capabilities != nil {
		if verification, ok := d.Capabilities["verification"].(string); ok {
			switch strings.ToLower(strings.TrimSpace(verification)) {
			case "candidate_only", "device_detected_only":
				return false
			}
		}
	}

	connection := strings.ToLower(strings.TrimSpace(d.ConnectionType))
	if (connection == "network" || connection == "tcp") && (protocol == "" || protocol == "unknown") {
		// Automatic WSD/SNMP/TCP observations can prove that a printer-like
		// host or print socket exists without proving its byte/document
		// language. Keep those observations as discovery candidates; do not
		// count/persist them as runnable printers because printer.New rejects
		// an undeclared network protocol. Explicit manual/config registrations
		// remain visible so operator intent is not silently destroyed.
		if d.Capabilities != nil {
			if source, ok := d.Capabilities["registration_source"].(string); ok {
				switch strings.ToLower(strings.TrimSpace(source)) {
				case "manual", "config":
					return true
				}
			}
			if _, discovered := d.Capabilities["discovered_via"]; discovered {
				return false
			}
		}
	}
	return true
}

// RuntimeDiscoveryPrinters returns only observations for which this Agent has
// a production execution path. It never mutates the input slice.
func RuntimeDiscoveryPrinters(printers []DeviceInfo) []DeviceInfo {
	filtered := make([]DeviceInfo, 0, len(printers))
	for _, di := range printers {
		if IsRuntimeDiscoveryPrinter(di) {
			filtered = append(filtered, di)
		}
	}
	return filtered
}

func isValidDiscoveredPrinter(d DeviceInfo) bool {
	// Virtual printers are always valid where they are expected
	if d.IsVirtual {
		return true
	}
	nameLower := strings.ToLower(d.Name + " " + d.DisplayName)
	// Generic PnP / system devices must never be surfaced as printers
	genericSubstrings := []string{
		"usb input device",
		"usb composite device",
		"hid-compliant",
		"hid compliant",
		"standard system devices",
		"standard usb host controller",
		"intel(r) wireless bluetooth",
		"wireless bluetooth",
		"bluetooth adapter",
		"fingerprint sensor",
		"touch fingerprint",
		"synaptics",
		"vfs7552",
		"hd camera",
		"hp hd camera",
		"camera",
		"usb hub",
		"generic usb hub",
	}
	for _, g := range genericSubstrings {
		if strings.Contains(nameLower, g) {
			// If driver or name explicitly says printer, keep it (check "printer" not "print" to avoid fingerprint false positive)
			capsLower := ""
			if d.Capabilities != nil {
				if v, ok := d.Capabilities["driver_name"]; ok {
					capsLower += strings.ToLower(fmt.Sprint(v)) + " "
				}
				if v, ok := d.Capabilities["port_name"]; ok {
					capsLower += strings.ToLower(fmt.Sprint(v)) + " "
				}
			}
			combined := nameLower + " " + capsLower + strings.ToLower(d.PrinterType)
			if strings.Contains(combined, "printer") || strings.Contains(combined, "laser") || strings.Contains(combined, "inkjet") || strings.Contains(combined, "thermal") || strings.Contains(combined, "label") || strings.Contains(combined, "zebra") {
				continue
			}
			return false
		}
	}
	// For spooler-discovered devices, apply strict spooler validation if we have port/driver caps
	if d.ConnectionType == "spooler" || d.Protocol == "spooler" {
		portName := ""
		driverName := ""
		if d.Capabilities != nil {
			if v, ok := d.Capabilities["port_name"]; ok {
				portName = fmt.Sprint(v)
			}
			if v, ok := d.Capabilities["driver_name"]; ok {
				driverName = fmt.Sprint(v)
			}
		}
		// If we have port/driver, validate; if not, rely on name check above
		if portName != "" || driverName != "" {
			if !isValidSpoolerPrinter(portName, driverName, d.Name) {
				return false
			}
		}
	}
	// For USB, require printer evidence if we have hardware_ids in caps
	if d.ConnectionType == "usb" {
		if d.Capabilities != nil {
			var hwIDs, compatIDs []string
			if v, ok := d.Capabilities["hardware_ids"]; ok {
				switch vv := v.(type) {
				case []string:
					hwIDs = vv
				case []interface{}:
					for _, x := range vv {
						hwIDs = append(hwIDs, fmt.Sprint(x))
					}
				}
			}
			if v, ok := d.Capabilities["compatible_ids"]; ok {
				switch vv := v.(type) {
				case []string:
					compatIDs = vv
				case []interface{}:
					for _, x := range vv {
						compatIDs = append(compatIDs, fmt.Sprint(x))
					}
				}
			}
			classVal := ""
			if v, ok := d.Capabilities["class"]; ok {
				classVal = fmt.Sprint(v)
			}
			// If we have hardware IDs, enforce printer check; if no IDs (e.g., manual USB), allow
			if len(hwIDs) > 0 || len(compatIDs) > 0 {
				if !isPrinterUSBDevice(hwIDs, compatIDs, classVal) {
					return false
				}
			}
		}
	}
	return true
}

// sameUSBDevice reports whether two discovered USB records have enough
// identity evidence to represent the same physical printer. VID/PID is only
// model-level evidence, so it is intentionally insufficient by itself.
func sameUSBDevice(a, b DeviceInfo) bool {
	if a.USBVID == "" || b.USBVID == "" ||
		!strings.EqualFold(strings.TrimSpace(a.USBVID), strings.TrimSpace(b.USBVID)) ||
		!strings.EqualFold(strings.TrimSpace(a.USBPID), strings.TrimSpace(b.USBPID)) {
		return false
	}
	normalize := func(value string) string {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || value == "0" || value == "00000000" {
			return ""
		}
		return value
	}
	capValue := func(d DeviceInfo, key string) string {
		if d.Capabilities == nil {
			return ""
		}
		if value, ok := d.Capabilities[key]; ok {
			return normalize(fmt.Sprint(value))
		}
		return ""
	}
	aInstance, bInstance := capValue(a, "device_instance_id"), capValue(b, "device_instance_id")
	if aInstance != "" && bInstance != "" {
		return aInstance == bInstance
	}
	aSerial, bSerial := normalize(a.USBSerial), normalize(b.USBSerial)
	if aSerial != "" && bSerial != "" {
		return aSerial == bSerial
	}
	aLocation, bLocation := capValue(a, "location"), capValue(b, "location")
	if aLocation != "" && bLocation != "" {
		return aLocation == bLocation
	}
	return false
}

// DiscoveryResult is the outcome of enumerating all sources.
type DiscoveryResult struct {
	Printers []DeviceInfo `json:"printers"`
	Errors   []string     `json:"errors,omitempty"`
	// CompleteSources records which live discovery sources completed an
	// authoritative inventory pass. It is intentionally transport-local and
	// excluded from JSON: callers use it only to decide whether absence from a
	// source is safe to reconcile into the durable local registry. A warning or
	// failure in one source must never authorize deletion of printers owned by
	// another source.
	CompleteSources map[string]bool `json:"-"`
}

// discoveryDiagnosticError is a non-fatal discovery warning. The source may
// still have produced an authoritative inventory even though enrichment or
// execution-scope diagnostics need to be surfaced to the operator.
//
// Example: EnumPrintersW can enumerate the complete queue list while one
// GetPrinterW status-enrichment call fails. That is a warning, not evidence
// that the queue list itself was partial.
type discoveryDiagnosticError struct {
	message string
}

func (e discoveryDiagnosticError) Error() string { return e.message }

func discoveryDiagnosticf(format string, args ...interface{}) error {
	return discoveryDiagnosticError{message: fmt.Sprintf(format, args...)}
}

// discoveryErrorIncomplete reports whether err contains at least one hard
// source failure. errors.Join is traversed recursively so diagnostic-only
// warnings do not make an otherwise authoritative source look incomplete.
func discoveryErrorIncomplete(err error) bool {
	if err == nil {
		return false
	}
	if _, ok := err.(discoveryDiagnosticError); ok {
		return false
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			if discoveryErrorIncomplete(child) {
				return true
			}
		}
		return false
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return discoveryErrorIncomplete(wrapped.Unwrap())
	}
	return true
}

func markAutomaticDiscoveryRegistration(d DeviceInfo) DeviceInfo {
	if d.Capabilities == nil {
		return d
	}
	if _, exists := d.Capabilities["registration_source"]; exists {
		return d
	}
	if _, observed := d.Capabilities["discovered_via"]; observed {
		return withRegistrationSource(d, "discovery")
	}
	return d
}

// DiscoverQuick enumerates only fast local sources (config, spooler, registry)
// without network/USB active scanning. Used for synchronous agent startup
// to avoid blocking on 8s LAN scan.
func DiscoverQuick(cfg *config.Config, registryPath string) DiscoveryResult {
	var (
		mu     sync.Mutex
		all    []DeviceInfo
		errors []string
		wg     sync.WaitGroup
		seen   = make(map[string]bool)
	)
	add := func(infos []DeviceInfo) {
		mu.Lock()
		defer mu.Unlock()
		for _, d := range infos {
			d = markAutomaticDiscoveryRegistration(d)
			if d.ID == "" {
				d.ID = StableIDForDevice(d)
			}
			if !isValidDiscoveredPrinter(d) {
				log.Printf("[discovery] filtered non-printer device: %q type=%q conn=%q", d.Name, d.PrinterType, d.ConnectionType)
				continue
			}
			// Only real printing hardware becomes a managed printer. Virtual,
			// software and redirected queues never reach the registry, the
			// heartbeat or the Gateway.
			if !IsProductionPrinter(d) {
				cls := ClassifyDeviceInfo(d)
				log.Printf("[discovery] hiding non-physical printer: %q class=%s reasons=%v", d.Name, cls.Class, cls.Reasons)
				continue
			}
			if seen[d.ID] {
				for i, existing := range all {
					if existing.ID == d.ID {
						all[i] = mergeDeviceInfo(existing, d)
						break
					}
				}
				continue
			}
			seen[d.ID] = true
			all = append(all, d)
		}
	}
	addErr := func(msg string) {
		mu.Lock()
		errors = append(errors, msg)
		log.Printf("[discovery] %s", msg)
		mu.Unlock()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("config discovery panic: %v", r))
			}
		}()
		add(discoverFromConfig(cfg))
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("spooler discovery panic: %v", r))
			}
		}()
		infos, err := discoverSpoolerPrinters()
		if err != nil {
			addErr(fmt.Sprintf("spooler discovery: %v", err))
		}
		add(infos)
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("registry discovery panic: %v", r))
			}
		}()
		infos, err := loadRegistryPrinters(registryPath)
		if err != nil {
			if !strings.Contains(err.Error(), "no such file") {
				addErr(fmt.Sprintf("registry load: %v", err))
			}
			return
		}
		add(infos)
	}()
	wg.Wait()
	for i := range all {
		if all[i].ID == "" {
			all[i].ID = StableIDForDevice(all[i])
		}
		if all[i].Status == "" {
			all[i].Status = "unknown"
		}
		if all[i].ConnectionType == "" {
			all[i].ConnectionType = strings.ToLower(all[i].Type)
			if all[i].ConnectionType == "" {
				all[i].ConnectionType = "network"
			}
		}
		// Protocol stays EMPTY (undeclared) when discovery could not prove
		// one. Empty is reported as "unknown" upstream and the gateway never
		// routes to it — inventing "raw" here was the wildcard bug.
		if all[i].Type == "" {
			all[i].Type = all[i].ConnectionType
		}
	}
	return DiscoveryResult{Printers: all, Errors: errors}
}

// Discover enumerates printers from all available sources without crashing
// if a single source fails. Sources:
//   - Config printers (YAML legacy)
//   - Spooler printers (Windows EnumPrintersW, stub on non-Windows)
//   - Registry (printers.json)
//   - Network (active TCP 9100 scan, bounded, additive)
//   - USB (SetupDi enumeration, Windows only)
//
// It deduplicates by stable ID and returns idempotent results.
func Discover(cfg *config.Config, registryPath string) DiscoveryResult {
	return DiscoverWithContext(context.Background(), cfg, registryPath)
}

func DiscoverWithContext(ctx context.Context, cfg *config.Config, registryPath string) DiscoveryResult {
	return discoverWithContext(ctx, cfg, registryPath, true)
}

// DiscoverLiveWithContext enumerates live/configured sources without replaying
// printers.json as discovery evidence. This is the only safe input for durable
// absence reconciliation: a historical registry row must not prove its own
// continued presence.
func DiscoverLiveWithContext(ctx context.Context, cfg *config.Config, registryPath string) DiscoveryResult {
	return discoverWithContext(ctx, cfg, registryPath, false)
}

func DiscoverLive(cfg *config.Config, registryPath string) DiscoveryResult {
	return DiscoverLiveWithContext(context.Background(), cfg, registryPath)
}

func discoverWithContext(ctx context.Context, cfg *config.Config, registryPath string, includeRegistry bool) DiscoveryResult {
	var (
		mu              sync.Mutex
		all             []DeviceInfo
		errors          []string
		wg              sync.WaitGroup
		seen            = make(map[string]int)
		completeSources = make(map[string]bool)
	)

	add := func(infos []DeviceInfo) {
		mu.Lock()
		defer mu.Unlock()
		for _, d := range infos {
			d = markAutomaticDiscoveryRegistration(d)
			if d.ID == "" {
				d.ID = StableIDForDevice(d)
			}
			if !isValidDiscoveredPrinter(d) {
				log.Printf("[discovery] filtered non-printer device: %q type=%q conn=%q", d.Name, d.PrinterType, d.ConnectionType)
				continue
			}
			// Only real printing hardware becomes a managed printer. Virtual,
			// software and redirected queues never reach the registry, the
			// heartbeat or the Gateway.
			if !IsProductionPrinter(d) {
				cls := ClassifyDeviceInfo(d)
				log.Printf("[discovery] hiding non-physical printer: %q class=%s reasons=%v", d.Name, cls.Class, cls.Reasons)
				continue
			}
			// Aliases retain the index of the merged record, so later updates
			// from either source reach that record instead of being discarded.
			if index, ok := seen[d.ID]; ok {
				all[index] = mergeDeviceInfo(all[index], d)
				continue
			}
			duplicate := false
			for i, existing := range all {
				if sameNetworkEndpoint(existing, d) {
					all[i] = mergeDeviceInfo(existing, d)
					seen[d.ID] = i
					duplicate = true
					break
				}
			}
			if duplicate {
				continue
			}
			// USB dedup requires a strong physical identity. VID/PID only identifies a
			// device model, not a physical unit; merging two identical USB printers
			// with no serial/location evidence would hide one device and make routing
			// nondeterministic.
			if d.USBVID != "" || d.USBSerial != "" {
				duplicate := false
				for i, existing := range all {
					if sameUSBDevice(existing, d) {
						log.Printf("[discovery] duplicate USB printer merged %s:%s", d.USBVID, d.USBPID)
						all[i] = mergeDeviceInfo(existing, d)
						seen[d.ID] = i
						duplicate = true
						break
					}
				}
				if duplicate {
					continue
				}
			}
			seen[d.ID] = len(all)
			all = append(all, d)
		}
	}
	addErr := func(msg string) {
		mu.Lock()
		errors = append(errors, msg)
		log.Printf("[discovery] %s", msg)
		mu.Unlock()
	}
	setComplete := func(source string, complete bool) {
		mu.Lock()
		completeSources[source] = complete
		mu.Unlock()
	}

	// 1. Config-file printers (legacy YAML) — always available
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceConfig, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("config discovery panic: %v", r))
				setComplete(SourceConfig, false)
			}
		}()
		infos := discoverFromConfig(cfg)
		add(infos)
		setComplete(SourceConfig, true)
	}()

	// 2. Spooler printers (Windows or stub)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceSpooler, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("spooler discovery panic: %v", r))
				setComplete(SourceSpooler, false)
			}
		}()
		infos, err := discoverSpoolerPrinters()
		if err != nil {
			addErr(fmt.Sprintf("spooler discovery: %v", err))
		}
		add(infos)
		setComplete(SourceSpooler, !discoveryErrorIncomplete(err))
	}()

	// 3. Registry file printers (previously discovered / manually registered)
	if includeRegistry {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ctx.Err() != nil {
				setComplete(SourceRegistry, false)
				return
			}
			defer func() {
				if r := recover(); r != nil {
					addErr(fmt.Sprintf("registry discovery panic: %v", r))
					setComplete(SourceRegistry, false)
				}
			}()
			infos, err := loadRegistryPrinters(registryPath)
			if err != nil {
				if !strings.Contains(err.Error(), "no such file") {
					addErr(fmt.Sprintf("registry load: %v", err))
				}
				setComplete(SourceRegistry, false)
				return
			}
			add(infos)
			setComplete(SourceRegistry, true)
		}()
	}

	// 4. Network printers (active TCP 9100 scan) — additive, bounded, not replacing spooler
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceRAW, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("network discovery panic: %v", r))
				setComplete(SourceRAW, false)
			}
		}()
		log.Printf("[discovery] starting network discovery (TCP 9100 scan)")
		subCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		infos, err := discoverNetworkPrinters(subCtx)
		if err != nil {
			addErr(fmt.Sprintf("network discovery: %v", err))
		}
		if len(infos) > 0 {
			log.Printf("[discovery] network discovery found %d TCP printers", len(infos))
		}
		add(infos)
		setComplete(SourceRAW, err == nil)
	}()

	// 5. USB printers (SetupDi enumeration) — additive, Windows only
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceUSB, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("usb discovery panic: %v", r))
				setComplete(SourceUSB, false)
			}
		}()
		log.Printf("[discovery] starting USB discovery")
		infos, err := discoverUSBPrinters()
		if err != nil {
			addErr(fmt.Sprintf("usb discovery: %v", err))
		}
		if len(infos) > 0 {
			log.Printf("[discovery] USB discovery found %d devices", len(infos))
		} else {
			log.Printf("[discovery] USB discovery: no devices found (or not on Windows)")
		}
		add(infos)
		setComplete(SourceUSB, err == nil)
	}()

	// 6. IPP printers (mDNS + TCP 631 scan) — additive
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceIPP, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("ipp discovery panic: %v", r))
				setComplete(SourceIPP, false)
			}
		}()
		log.Printf("[discovery] starting IPP discovery")
		subCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		infos, err := discoverIPPPrinters(subCtx)
		if err != nil {
			addErr(fmt.Sprintf("ipp discovery: %v", err))
		}
		if len(infos) > 0 {
			log.Printf("[discovery] IPP discovery found %d printers", len(infos))
		} else {
			log.Printf("[discovery] IPP discovery: no printers found")
		}
		add(infos)
		setComplete(SourceIPP, err == nil)
	}()

	// 7. LPR/LPD (515) — bounded, safe probe
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceLPR, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("lpr discovery panic: %v", r))
				setComplete(SourceLPR, false)
			}
		}()
		log.Printf("[discovery] starting LPR discovery")
		subCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		lprTargets, diagnostics := localPrivateDiscoveryTargets()
		for _, diagnostic := range diagnostics {
			addErr("lpr discovery: " + diagnostic)
		}
		infos := discoverLPRPrinters(subCtx, lprTargets)
		if len(infos) > 0 {
			// LPR/LPD probing is discovery-only until a real LPR execution
			// backend is implemented. Never promote protocol=lpr into the
			// production printer inventory because Gateway/Agent routing
			// intentionally supports only the implemented protocol vocabulary.
			add(infos)
			log.Printf("[discovery] lpr discovery: found %d LPR/LPD endpoint(s); candidates are visible but execution is unsupported", len(infos))
		}
		setComplete(SourceLPR, len(diagnostics) == 0)
	}()

	// 8. SNMP (161) — read-only, public community
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceSNMP, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("snmp discovery panic: %v", r))
				setComplete(SourceSNMP, false)
			}
		}()
		log.Printf("[discovery] starting SNMP discovery")
		subCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		snmpTargets, diagnostics := localPrivateDiscoveryTargets()
		for _, diagnostic := range diagnostics {
			addErr("snmp discovery: " + diagnostic)
		}
		infos := discoverSNMPPrinters(subCtx, snmpTargets)
		if len(infos) > 0 {
			log.Printf("[discovery] SNMP found %d printers", len(infos))
		}
		add(infos)
		setComplete(SourceSNMP, len(diagnostics) == 0)
	}()

	// 9. WSD (WS-Discovery multicast) — platform independent probe
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			setComplete(SourceWSD, false)
			return
		}
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("wsd discovery panic: %v", r))
				setComplete(SourceWSD, false)
			}
		}()
		log.Printf("[discovery] starting WSD discovery")
		subCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()
		infos, err := discoverWSDPrinters(subCtx)
		if err != nil {
			addErr(fmt.Sprintf("wsd discovery: %v", err))
		}
		add(infos)
		setComplete(SourceWSD, err == nil)
	}()

	wg.Wait()
	log.Printf("[discovery] discovery completed: %d printers (errors: %d)", len(all), len(errors))

	// Ensure every entry has a stable ID and default status
	for i := range all {
		if all[i].ID == "" {
			all[i].ID = StableIDForDevice(all[i])
		}
		if all[i].Status == "" {
			all[i].Status = "unknown"
		}
		if all[i].ConnectionType == "" {
			all[i].ConnectionType = strings.ToLower(all[i].Type)
			if all[i].ConnectionType == "" {
				all[i].ConnectionType = "network"
			}
		}
		// Protocol stays EMPTY (undeclared) when discovery could not prove
		// one. Empty is reported as "unknown" upstream and the gateway never
		// routes to it — inventing "raw" here was the wildcard bug.
		if all[i].Type == "" {
			all[i].Type = all[i].ConnectionType
		}
	}

	return DiscoveryResult{Printers: all, Errors: errors, CompleteSources: completeSources}
}

func discoverFromConfig(cfg *config.Config) []DeviceInfo {
	var out []DeviceInfo
	if cfg == nil {
		return out
	}
	for _, pc := range cfg.Printers {
		// Propagate the declared class (heartbeat normalizes it for the
		// Gateway); fall back to "unknown" exactly as before when unset.
		declaredType := pc.PrinterType
		if declaredType == "" {
			declaredType = "unknown"
		}
		di := DeviceInfo{
			ID:             pc.ID,
			Name:           pc.Name,
			DisplayName:    pc.Name,
			PrinterType:    declaredType,
			ConnectionType: pc.NormalizedType(),
			Protocol:       pc.NormalizedProtocolOrUnknown(),
			Endpoint:       pc.Endpoint,
			SpoolerName:    pc.SpoolerName,
			Status:         "unknown",
			Enabled:        pc.IsEnabled(),
			Type:           pc.NormalizedType(),
			// Printers declared in config.yaml are explicit operator intent:
			// they stay visible even when no transport can be proven, because
			// the operator typed the endpoint by hand.
			Capabilities: map[string]interface{}{"registration_source": "config"},
		}
		if di.ConnectionType == "spooler" {
			if di.SpoolerName == "" {
				di.SpoolerName = pc.Endpoint
			}
			if di.SpoolerName == "" {
				di.SpoolerName = pc.SpoolerName
			}
		}
		if di.ConnectionType == "network" {
			if host, portStr, err := net.SplitHostPort(pc.Endpoint); err == nil {
				di.NetworkAddress = host
				if p, err := strconv.Atoi(portStr); err == nil {
					di.Port = p
				}
			}
		}
		if di.ID == "" {
			di.ID = StableIDForDevice(di)
		}
		// Config entries are inventory declarations, not active discovery probes.
		// Agent heartbeat probes own bounded concurrency and status caching; doing
		// serial Status calls here multiplies startup time and leaks stalled RPCs.
		if _, err := New(pc); err != nil {
			di.Status = "error"
		}
		out = append(out, di)
	}
	return out
}

func discoverSpoolerPrinters() ([]DeviceInfo, error) {
	infos, err := enumSpoolerImpl()
	for i := range infos {
		if infos[i].Capabilities == nil {
			infos[i].Capabilities = map[string]interface{}{}
		}
		if _, ok := infos[i].Capabilities["discovered_via"]; !ok {
			infos[i].Capabilities["discovered_via"] = SourceSpooler
		}
		infos[i] = markAutomaticDiscoveryRegistration(infos[i])
		if infos[i].ID == "" {
			// Prefer the strongest physical queue identity (port + driver, with
			// server/share when available) before falling back to the queue name.
			// StableIDForDevice retains the legacy name fallback when stronger
			// identity is unavailable.
			infos[i].ID = StableIDForDevice(infos[i])
		}
		// Enumeration already provides a bounded status snapshot. Reopening
		// every remote queue here would add a serial timeout per printer.
		if infos[i].Status == "" {
			infos[i].Status = "unknown"
		}
	}
	return infos, err
}

// enumSpoolerImpl delegates to platform-specific implementation.
func enumSpoolerImpl() ([]DeviceInfo, error) {
	return enumSpoolerPrintersPlatform()
}

// ListPrinters returns the current registry + config view suitable for CLI "printers list".
func ListPrinters(cfg *config.Config, registryPath string) ([]DeviceInfo, error) {
	result := Discover(cfg, registryPath)
	if len(result.Errors) > 0 {
		for _, e := range result.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}
	return result.Printers, nil
}

func endpointHasNetworkAddress(endpoint, networkAddress string) bool {
	endpoint = strings.TrimSpace(endpoint)
	networkAddress = strings.TrimSpace(networkAddress)
	if endpoint == "" || networkAddress == "" {
		return false
	}
	if host, _, err := net.SplitHostPort(endpoint); err == nil {
		return strings.EqualFold(strings.Trim(host, "[]"), networkAddress)
	}
	if strings.Contains(endpoint, "://") {
		if u, err := url.Parse(endpoint); err == nil && u.Hostname() != "" {
			return strings.EqualFold(u.Hostname(), networkAddress)
		}
	}
	return false
}

func sameNetworkEndpoint(a, b DeviceInfo) bool {
	if a.NetworkAddress == "" || b.NetworkAddress == "" || a.Port <= 0 || b.Port <= 0 {
		return false
	}
	if !strings.EqualFold(a.NetworkAddress, b.NetworkAddress) || a.Port != b.Port {
		return false
	}
	aIPP := a.Protocol == "ipp" || a.Protocol == "ipps"
	bIPP := b.Protocol == "ipp" || b.Protocol == "ipps"
	if aIPP || bIPP {
		return aIPP && bIPP && a.Protocol == b.Protocol && a.Endpoint == b.Endpoint
	}
	return true
}

func mergeDeviceInfo(existing, incoming DeviceInfo) DeviceInfo {
	merged := existing
	if incoming.Name != "" && incoming.Name != existing.Name {
		if existing.SpoolerName == "" && incoming.SpoolerName != "" {
			merged.Name = incoming.Name
			merged.DisplayName = incoming.DisplayName
		}
	}
	// Select the complete transport tuple together. Metadata from another
	// source must never replace just the port while retaining an old URI.
	preferIncoming := merged.Endpoint == "" || merged.Protocol == "" || merged.Protocol == "unknown" ||
		(incoming.ConnectionType == "spooler" && merged.ConnectionType != "spooler")
	if preferIncoming && incoming.Endpoint != "" {
		merged.Endpoint, merged.ConnectionType, merged.Protocol, merged.Type = incoming.Endpoint, incoming.ConnectionType, incoming.Protocol, incoming.Type
		merged.NetworkAddress, merged.Port = incoming.NetworkAddress, incoming.Port
	}
	if incoming.SpoolerName != "" && merged.SpoolerName == "" {
		merged.SpoolerName = incoming.SpoolerName
	}
	if incoming.USBVID != "" && merged.USBVID == "" {
		merged.USBVID = incoming.USBVID
	}
	if incoming.USBPID != "" && merged.USBPID == "" {
		merged.USBPID = incoming.USBPID
	}
	if incoming.USBSerial != "" && merged.USBSerial == "" {
		merged.USBSerial = incoming.USBSerial
	}
	// USB and spooler same physical printer: if USB serial matches spooler printer's location/port, merge
	if incoming.ConnectionType == "usb" && existing.ConnectionType == "spooler" && incoming.USBVID != "" && existing.USBVID == "" {
		merged.USBVID = incoming.USBVID
		merged.USBPID = incoming.USBPID
		merged.USBSerial = incoming.USBSerial
		if merged.Capabilities == nil {
			merged.Capabilities = make(map[string]interface{})
		}
		for k, v := range incoming.Capabilities {
			if _, exists := merged.Capabilities[k]; !exists {
				merged.Capabilities[k] = v
			}
		}
		return merged
	}
	if incoming.Status != "" && incoming.Status != "unknown" {
		merged.Status = incoming.Status
	}
	if incoming.PrinterType != "" && incoming.PrinterType != "unknown" && merged.PrinterType == "unknown" {
		merged.PrinterType = incoming.PrinterType
	}

	if incoming.Capabilities != nil {
		if merged.Capabilities == nil {
			merged.Capabilities = make(map[string]interface{})
		}
		for k, v := range incoming.Capabilities {
			merged.Capabilities[k] = v
		}
	}
	if incoming.Endpoint != "" && merged.Endpoint == "" {
		merged.Endpoint = incoming.Endpoint
	}
	return merged
}

// TestPrinter executes a real test print against the given printer ID and returns
// success/failure with meaningful error. It resolves the printer via fast local discovery
// first (registry, spooler, config), falling back to full network discovery only if needed.
func TestPrinter(cfg *config.Config, registryPath, printerID string) error {
	var target *DeviceInfo

	// A printer test is an explicit operation against an already selected
	// inventory record. Never invoke network discovery here: discovery has
	// intentionally bounded LAN probes and their timeout budget must not leak
	// into an interactive test-print action.
	if infos, err := LoadRegistryPrinters(registryPath); err == nil {
		for _, p := range infos {
			if p.ID == printerID || p.SpoolerName == printerID || p.Name == printerID {
				cp := p
				target = &cp
				break
			}
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("load printer registry: %w", err)
	}

	if target == nil {
		for _, p := range discoverFromConfig(cfg) {
			if p.ID == printerID || p.SpoolerName == printerID || p.Name == printerID {
				cp := p
				target = &cp
				break
			}
		}
	}
	if target == nil {
		return fmt.Errorf("printer %q not found in local printer inventory", printerID)
	}

	pc := config.PrinterConfig{
		ID:          target.ID,
		Name:        target.Name,
		Type:        target.ConnectionType,
		Endpoint:    target.Endpoint,
		Protocol:    target.Protocol,
		SpoolerName: target.SpoolerName,
	}
	if target.ConnectionType == "spooler" && pc.SpoolerName == "" {
		pc.SpoolerName = target.SpoolerName
		if pc.Endpoint == "" {
			pc.Endpoint = target.SpoolerName
		}
	}
	prt, err := New(pc)
	if err != nil {
		return fmt.Errorf("printer %s backend not available: %w", printerID, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return prt.Test(ctx)
}
