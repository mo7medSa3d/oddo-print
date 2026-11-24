package printer

import (
	"context"
	"fmt"
	"log"
	"maps"
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
	if d.Capabilities["inventory_present"] == false || d.Capabilities["identity_collision"] != nil {
		return false
	}
	// Exclude only redirected, fax, and blackhole stubs. Printable virtual
	// printers (PDF/XPS/Print-to-File) are first-class executable printers.
	if cls := ClassifyDeviceInfo(d); cls.IsRedirected || cls.IsUnusable {
		return false
	}
	// Validate the actual execution endpoint, including historical registry
	// rows and legacy Type-only records. A claimed verification/source or a
	// different NetworkAddress field must never waive this destination policy.
	pc := config.PrinterConfig{
		ID: d.ID, Type: d.Type, ConnectionType: d.ConnectionType,
		Protocol: d.Protocol, Endpoint: d.Endpoint, SpoolerName: d.SpoolerName,
		PrinterType: d.PrinterType,
	}
	if err := config.ValidatePrinterEndpoint(pc); err != nil {
		return false
	}
	protocol := strings.ToLower(strings.TrimSpace(d.Protocol))
	if protocol == "lpr" {
		return false
	}
	// A discovered IPP URL is only a candidate, irrespective of whether it
	// originated from mDNS, SNMP enrichment, WSD or an IP/port scan. A valid
	// address, a responding SNMP agent and a service TXT announcement do NOT
	// prove that the IPP endpoint speaks the printing protocol. Require an
	// actual successful IPP Get-Printer-Attributes probe for executable
	// auto-discovery. Manually configured IPP printers remain operator-owned
	// and still undergo format negotiation at print time.
	if !isOperatorRegisteredDevice(d) && d.Capabilities != nil && (protocol == "ipp" || protocol == "ipps") {
		if _, discovered := d.Capabilities["discovered_via"]; discovered &&
			!isCapabilityVerified(d.Capabilities, "ipp_verified") {
			return false
		}
	}
	if !isOperatorRegisteredDevice(d) && d.Capabilities != nil {
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
	// Exclude only redirected, fax, and blackhole stubs; printable virtual
	// printers remain first-class managed printers with is_virtual metadata.
	if cls := ClassifyDeviceInfo(d); cls.IsRedirected || cls.IsUnusable {
		return false
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
		if !usableIdentityValue(value) || value == "00000000" {
			return ""
		}
		return value
	}
	capValue := func(d DeviceInfo, key string) string {
		if d.Capabilities == nil {
			return ""
		}
		if value, ok := d.Capabilities[key].(string); ok {
			return normalize(value)
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
	// Truncated marks a result cut short by an orchestration bound rather than
	// by the sources themselves. The devices present are real observations, but
	// sources that had not finished are absent, so absence must never be
	// reconciled as removal.
	Truncated bool `json:"-"`
	// CompleteSources records which live discovery sources completed an
	// authoritative inventory pass. It is intentionally transport-local and
	// excluded from JSON: callers use it only to decide whether absence from a
	// source is safe to reconcile into the durable local registry. A warning or
	// failure in one source must never authorize deletion of printers owned by
	// another source.
	CompleteSources map[string]bool `json:"-"`
}

// DiscoveryProgressFunc receives a snapshot of the discovery results
// accumulated so far.
//
// It is invoked with the discovery mutex still held, so implementations must
// return immediately, must not block, and must not call back into discovery.
// Snapshots exist so an orchestration bound can preserve the work of the
// sources that did finish instead of discarding every observation.
type DiscoveryProgressFunc func(DiscoveryResult)

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
//
// The spooler source is enumerated LIVE (EnumPrintersW), and when that
// enumeration succeeds the result is authoritative for spooler queues:
// auto-discovered spooler rows that the live enumeration no longer
// returns are dropped from the result even though the registry still
// holds them (a registry row is history, never evidence of its own
// continued presence), and CompleteSources marks the spooler source
// complete so registry reconciliation may retire the absent rows.
// Config-defined and manually registered printers are always kept.
// When the live enumeration fails, the result falls back to the full
// registry replay with no completeness claim (fail-safe: nothing is
// pruned on a failed scan).
func DiscoverQuick(cfg *config.Config, registryPath string) DiscoveryResult {
	var (
		mu             sync.Mutex
		all            []DeviceInfo
		errors         []string
		wg             sync.WaitGroup
		seen           = make(map[string]int)
		liveSpoolerIDs = make(map[string]bool)
		spoolerLiveOK  bool
	)
	add := func(infos []DeviceInfo) {
		mu.Lock()
		defer mu.Unlock()
		for _, d := range infos {
			d = markAutomaticDiscoveryRegistration(d)
			d = discoveredDeviceNames(d)
			if d.ID == "" {
				d.ID = StableIDForDevice(d)
			}
			if d.ID == "" {
				log.Printf("[discovery] refusing printer %q without distinct execution identity", d.Name)
				continue
			}
			if !isValidDiscoveredPrinter(d) {
				log.Printf("[discovery] filtered non-printer device: %q type=%q conn=%q", d.Name, d.PrinterType, d.ConnectionType)
				continue
			}
			// Only real printing hardware becomes a managed printer. Virtual,
			// software and redirected queues never reach the registry, the
			// heartbeat or the Gateway.
			if !IsManagedPrinter(d) {
				cls := ClassifyDeviceInfo(d)
				log.Printf("[discovery] hiding non-physical printer: %q class=%s reasons=%v", d.Name, cls.Class, cls.Reasons)
				continue
			}
			if index, ok := seen[d.ID]; ok {
				all[index] = mergeDiscoveredSameID(all[index], d)
				continue
			}
			duplicate := false
			for i, existing := range all {
				if sameNetworkEndpoint(existing, d) {
					all[i] = mergeDiscoveredSameID(existing, d)
					seen[d.ID] = i
					duplicate = true
					break
				}
			}
			if duplicate {
				continue
			}
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
		} else {
			mu.Lock()
			spoolerLiveOK = true
			for _, d := range infos {
				// Compute the ID exactly as add() will, including the
				// registration marking and name normalization that run
				// before its stable-ID assignment.
				d = markAutomaticDiscoveryRegistration(d)
				d = discoveredDeviceNames(d)
				id := d.ID
				if id == "" {
					id = StableIDForDevice(d)
				}
				if id != "" {
					liveSpoolerIDs[id] = true
				}
			}
			mu.Unlock()
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
	completeSources := map[string]bool(nil)
	if spoolerLiveOK {
		// The live spooler enumeration is authoritative: an
		// auto-discovered spooler row it did not return is a deleted or
		// renamed queue whose registry entry must not resurrect it in
		// the observed set (reconciliation below retires it instead).
		kept := all[:0]
		for _, d := range all {
			// A quarantined identity (two distinct queues colliding on
			// one ID) is a safety fence, not a presence claim: it must
			// survive every path so nothing can execute against the
			// ambiguous ID and the operator can see the collision.
			if isAutoDiscoveredSpoolerRow(d) && !liveSpoolerIDs[d.ID] && d.Capabilities["identity_collision"] == nil {
				continue
			}
			kept = append(kept, d)
		}
		all = kept
		completeSources = map[string]bool{SourceSpooler: true}
	}
	for i := range all {
		all[i] = finalizeDiscoveredDevice(all[i])
	}
	return DiscoveryResult{Printers: all, Errors: errors, CompleteSources: completeSources}
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
	return discoverWithContext(ctx, cfg, registryPath, true, nil)
}

// DiscoverLiveWithContext enumerates live/configured sources without replaying
// printers.json as discovery evidence. This is the only safe input for durable
// absence reconciliation: a historical registry row must not prove its own
// continued presence.
func DiscoverLiveWithContext(ctx context.Context, cfg *config.Config, registryPath string) DiscoveryResult {
	return discoverWithContext(ctx, cfg, registryPath, false, nil)
}

// DiscoverLiveWithProgress is DiscoverLiveWithContext with incremental
// progress snapshots. The callback is invoked while the discovery mutex is
// held, so it must return immediately. Orchestration uses it to keep the
// observations of sources that finished when an outer bound expires, instead
// of discarding the whole scan.
func DiscoverLiveWithProgress(ctx context.Context, cfg *config.Config, registryPath string, onProgress DiscoveryProgressFunc) DiscoveryResult {
	return discoverWithContext(ctx, cfg, registryPath, false, onProgress)
}

func DiscoverLive(cfg *config.Config, registryPath string) DiscoveryResult {
	return DiscoverLiveWithContext(context.Background(), cfg, registryPath)
}

func discoverWithContext(ctx context.Context, cfg *config.Config, registryPath string, includeRegistry bool, onProgress DiscoveryProgressFunc) DiscoveryResult {
	var (
		mu              sync.Mutex
		all             []DeviceInfo
		errors          []string
		wg              sync.WaitGroup
		seen            = make(map[string]int)
		completeSources = make(map[string]bool)
	)

	// snapshotLocked copies the accumulated state. Callers must hold mu, and
	// the copy is required because the live slices/maps keep being appended to
	// by sources that have not finished yet.
	snapshotLocked := func() DiscoveryResult {
		printers := make([]DeviceInfo, len(all))
		for i, d := range all {
			printers[i] = finalizeDiscoveredDevice(d)
		}
		errs := append([]string(nil), errors...)
		sources := make(map[string]bool, len(completeSources))
		for source, complete := range completeSources {
			sources[source] = complete
		}
		return DiscoveryResult{Printers: printers, Errors: errs, CompleteSources: sources}
	}
	// notifyProgressLocked must be called with mu held, so the snapshot is a
	// consistent copy of the accumulated state. Releasing the lock first would
	// race with the source goroutines still appending to it.
	notifyProgressLocked := func() {
		if onProgress != nil {
			onProgress(snapshotLocked())
		}
	}

	add := func(infos []DeviceInfo) {
		mu.Lock()
		defer mu.Unlock()
		for _, d := range infos {
			d = markAutomaticDiscoveryRegistration(d)
			d = discoveredDeviceNames(d)
			if d.ID == "" {
				d.ID = StableIDForDevice(d)
			}
			if d.ID == "" {
				log.Printf("[discovery] refusing printer %q without distinct execution identity", d.Name)
				continue
			}
			if !isValidDiscoveredPrinter(d) {
				log.Printf("[discovery] filtered non-printer device: %q type=%q conn=%q", d.Name, d.PrinterType, d.ConnectionType)
				continue
			}
			// Only real printing hardware becomes a managed printer. Virtual,
			// software and redirected queues never reach the registry, the
			// heartbeat or the Gateway.
			if !IsManagedPrinter(d) {
				cls := ClassifyDeviceInfo(d)
				log.Printf("[discovery] hiding non-physical printer: %q class=%s reasons=%v", d.Name, cls.Class, cls.Reasons)
				continue
			}
			// Aliases retain the index of the merged record, so later updates
			// from either source reach that record instead of being discarded.
			if index, ok := seen[d.ID]; ok {
				all[index] = mergeDiscoveredSameID(all[index], d)
				continue
			}
			duplicate := false
			for i, existing := range all {
				if sameNetworkEndpoint(existing, d) {
					all[i] = mergeDiscoveredSameID(existing, d)
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
		// Publish the newly accumulated devices immediately, so a source that
		// is still running cannot hide work that another source already
		// finished. Held under mu by the caller.
		notifyProgressLocked()
	}
	addErr := func(msg string) {
		mu.Lock()
		errors = append(errors, msg)
		log.Printf("[discovery] %s", msg)
		notifyProgressLocked()
		mu.Unlock()
	}
	setComplete := func(source string, complete bool) {
		mu.Lock()
		completeSources[source] = complete
		notifyProgressLocked()
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
		if subCtx.Err() != nil {
			addErr(fmt.Sprintf("lpr discovery incomplete: %v", subCtx.Err()))
		}
		setComplete(SourceLPR, len(diagnostics) == 0 && subCtx.Err() == nil)
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
		if subCtx.Err() != nil {
			addErr(fmt.Sprintf("snmp discovery incomplete: %v", subCtx.Err()))
		}
		setComplete(SourceSNMP, len(diagnostics) == 0 && subCtx.Err() == nil)
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

	// Ensure every entry has a stable ID and default status. Progress
	// snapshots use the same finalization so a partially-discovered device is
	// never reported without an identity.
	for i := range all {
		all[i] = finalizeDiscoveredDevice(all[i])
	}

	result := DiscoveryResult{Printers: all, Errors: errors, CompleteSources: completeSources}
	mu.Lock()
	notifyProgressLocked()
	mu.Unlock()
	return result
}

// discoveredDeviceNames uses observed names only, never an ID/guessed model.
func discoveredDeviceNames(d DeviceInfo) DeviceInfo {
	if !isOperatorRegisteredDevice(d) && isGenericPrinterName(d.Name) && !isGenericPrinterName(d.DisplayName) {
		d.Name = strings.TrimSpace(d.DisplayName)
	}
	if strings.TrimSpace(d.Name) == "" {
		d.Name = strings.TrimSpace(d.SpoolerName)
		if d.Name == "" {
			d.Name = strings.TrimSpace(d.DisplayName)
		}
	}
	if strings.TrimSpace(d.DisplayName) == "" {
		d.DisplayName = d.Name
	}
	return d
}

// finalizeDiscoveredDevice applies common identity and inventory defaults.
func finalizeDiscoveredDevice(d DeviceInfo) DeviceInfo {
	d = discoveredDeviceNames(d)
	if d.ID == "" {
		d.ID = StableIDForDevice(d)
	}
	if d.Status == "" {
		d.Status = "unknown"
	}
	if d.ConnectionType == "" {
		d.ConnectionType = strings.ToLower(d.Type)
		if d.ConnectionType == "" {
			d.ConnectionType = "network"
		}
	}
	// Protocol stays EMPTY (undeclared) when discovery could not prove
	// one. Empty is reported as "unknown" upstream and the gateway never
	// routes to it — inventing "raw" here was the wildcard bug.
	if d.Type == "" {
		d.Type = d.ConnectionType
	}
	cls := ClassifyDeviceInfo(d)
	if cls.IsVirtual {
		d.IsVirtual = true
		if d.Capabilities == nil {
			d.Capabilities = map[string]interface{}{}
		}
		d.Capabilities["is_virtual"] = true
		d.Capabilities["printer_class"] = string(cls.Class)
	}
	return d
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
		// Config entries are inventory declarations, not active discovery probes.
		// Propagate the complete declared backend configuration into the
		// inventory row: USB transport identity, operator capabilities
		// (including supported_protocols passthrough evidence) and paper
		// width. The runtime factory consumes PrinterConfig directly, but
		// heartbeat/Gateway/UI only see this DeviceInfo — dropping fields
		// here loses transport identity and capability evidence between
		// configuration and discovery.
		caps := map[string]interface{}{}
		for k, v := range pc.Capabilities {
			caps[k] = v
		}
		if pc.PaperWidthMM > 0 && pc.PaperWidthMM <= 1000 {
			// Preserve nominal media without inferring millimetres from dots.
			// Top-level office widths also override conflicting thermal hints.
			caps["paper_width_mm"] = pc.PaperWidthMM
		}
		delete(caps, "geometry")
		if geometry, err := ConfiguredGeometry(pc); err == nil {
			caps["geometry"] = geometry
		}
		caps["registration_source"] = "config"
		di := DeviceInfo{
			ID:             pc.ID,
			Name:           pc.Name,
			DisplayName:    pc.Name,
			PrinterType:    declaredType,
			ConnectionType: pc.NormalizedType(),
			Protocol:       pc.NormalizedProtocolOrUnknown(),
			Endpoint:       pc.Endpoint,
			SpoolerName:    pc.SpoolerName,
			USBVID:         pc.USBVID,
			USBPID:         pc.USBPID,
			USBSerial:      pc.USBSerial,
			Status:         "unknown",
			Enabled:        pc.IsEnabled(),
			Type:           pc.NormalizedType(),
			// Printers declared in config.yaml are explicit operator intent:
			// they stay visible even when no transport can be proven, because
			// the operator typed the endpoint by hand.
			Capabilities: caps,
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
			// Queue identity is independent of driver/port association. Multiple
			// legitimate queues may target the same physical output device.
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
	// Listing installed/registered printers is not a request to scan the LAN.
	// Full bounded scans remain available through Discover and setup sessions.
	result := DiscoverQuick(cfg, registryPath)
	if len(result.Errors) > 0 {
		for _, e := range result.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}
	return RuntimeInventoryPrinters(result.Printers), nil
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

// A discovered IPP queue is an HTTP resource bound to a specific transport,
// host and *effective* port. It is not merely the IP address reported by
// network discovery. Map ipp/http and ipps/https to the same transport only
// when the URI's port agrees with the independently observed port. Retain the
// case-sensitive resource path to avoid merging queues on multi-queue servers.
func normalizedDiscoveryIPPQueue(d DeviceInfo) (string, bool) {
	u, err := url.Parse(d.Endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery ||
		u.Fragment != "" || u.RawFragment != "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	effectivePort := 631
	transport := "http"
	switch scheme {
	case "ipp":
	case "http":
		effectivePort = 80
	case "ipps":
		transport = "https"
	case "https":
		effectivePort = 443
		transport = "https"
	default:
		return "", false
	}
	if u.Port() != "" {
		p, err := strconv.Atoi(u.Port())
		if err != nil || p < 1 || p > 65535 {
			return "", false
		}
		effectivePort = p
	}
	if effectivePort != d.Port {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	}
	resource := u.EscapedPath()
	if resource == "" {
		resource = "/"
	}
	return transport + "://" + net.JoinHostPort(host, strconv.Itoa(effectivePort)) + resource, true
}

func sameNetworkEndpoint(a, b DeviceInfo) bool {
	// An installed queue is a distinct execution destination, even when its
	// port references the same host as a directly discovered byte endpoint.
	// Queue/physical identities are reconciled separately, never by IP alone.
	if isSpoolerDevice(a) || isSpoolerDevice(b) {
		return false
	}
	if a.NetworkAddress == "" || b.NetworkAddress == "" || a.Port <= 0 || b.Port <= 0 {
		return false
	}
	// The same IPv6 address has multiple valid textual spellings. Normalize
	// only the independently reported host identity; URI path, effective
	// port and security scheme are still checked below for IPP transports.
	normalizedHost := func(value string) string {
		host := strings.ToLower(strings.Trim(strings.TrimSpace(value), "[]"))
		if ip := net.ParseIP(host); ip != nil {
			return ip.String()
		}
		return host
	}
	if normalizedHost(a.NetworkAddress) != normalizedHost(b.NetworkAddress) || a.Port != b.Port {
		return false
	}
	ipp := func(d DeviceInfo) bool {
		return strings.EqualFold(d.Protocol, "ipp") || strings.EqualFold(d.Protocol, "ipps") ||
			strings.EqualFold(d.ConnectionType, "ipp") || strings.EqualFold(d.ConnectionType, "ipps")
	}
	aIPP, bIPP := ipp(a), ipp(b)
	if aIPP || bIPP {
		if !aIPP || !bIPP || !strings.EqualFold(a.Protocol, b.Protocol) {
			return false
		}
		aResource, aOK := normalizedDiscoveryIPPQueue(a)
		bResource, bOK := normalizedDiscoveryIPPQueue(b)
		return aOK && bOK && aResource == bResource
	}
	return true
}

// mergeDiscoveredSameID is used before registry reconciliation, when config,
// saved registry and live Windows enumeration can complete in any order.
// A legacy ID collision between distinct installed queues is NOT permission to
// choose whichever observation won the race. Quarantine the identity until an
// operator can reconcile the two actual Windows execution destinations.
// A known raw/TCP printer language is part of the selected execution
// contract, not a generic host capability. Two declared languages at the
// same physical socket cannot be merged by arrival order. Unknown probe
// observations remain eligible for a later explicit protocol declaration.
func conflictingNetworkPrintLanguage(left, right DeviceInfo) bool {
	// Some older and manual registry rows carry only the exact endpoint
	// without the optional NetworkAddress and Port enrichment. They still
	// identify the same local socket and must not bypass the language fence.
	if !sameNetworkEndpoint(left, right) &&
		(strings.TrimSpace(left.Endpoint) == "" ||
			strings.TrimSpace(right.Endpoint) == "" ||
			!strings.EqualFold(strings.TrimSpace(left.Endpoint), strings.TrimSpace(right.Endpoint))) {
		return false
	}
	byteStream := func(raw string) bool {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "raw", "escpos", "zpl", "tspl":
			return true
		default:
			return false
		}
	}
	a, b := strings.ToLower(strings.TrimSpace(left.Protocol)), strings.ToLower(strings.TrimSpace(right.Protocol))
	return a != b && byteStream(a) && byteStream(b)
}

// A legacy VID/PID-only USB ID may describe two different physical
// interfaces of the same model. Matching that old ID must not bypass the
// stronger instance/serial/location proof required by sameUSBDevice.
func conflictingUSBExecutionInterface(left, right DeviceInfo) bool {
	isDirectUSB := func(d DeviceInfo) bool {
		connection := d.ConnectionType
		if strings.TrimSpace(connection) == "" {
			connection = d.Type
		}
		return strings.EqualFold(connection, "usb") && !isSpoolerDevice(d)
	}
	if !isDirectUSB(left) || !isDirectUSB(right) ||
		strings.TrimSpace(left.Endpoint) == "" ||
		strings.TrimSpace(right.Endpoint) == "" ||
		strings.EqualFold(left.Endpoint, right.Endpoint) {
		return false
	}
	return !sameUSBDevice(left, right)
}

// An ID generated from legacy IP/serial metadata is not authority to select
// one of two different network execution bindings. In particular, an IPP
// HTTP-to-HTTPS change, IPP resource change, or TCP port move may address a
// different logical queue even when a chassis UUID or MAC is identical.
func conflictingNetworkExecutionBinding(left, right DeviceInfo) bool {
	leftType, rightType := SharingConfigForDevice(left).NormalizedType(), SharingConfigForDevice(right).NormalizedType()
	if leftType != "network" && leftType != "ipp" && leftType != "ipps" {
		return false
	}
	if rightType != "network" && rightType != "ipp" && rightType != "ipps" {
		return false
	}
	if strings.TrimSpace(left.Endpoint) == "" || strings.TrimSpace(right.Endpoint) == "" {
		return false // a weak observation cannot assert a replacement transport
	}
	leftBinding, leftError := config.PrinterBindingDigest(SharingConfigForDevice(left))
	rightBinding, rightError := config.PrinterBindingDigest(SharingConfigForDevice(right))
	if leftError == nil && rightError == nil {
		return leftBinding != rightBinding
	}
	// Unknown or undeclared execution evidence is a weak observation on BOTH
	// call sites: it can neither assert a replacement transport nor veto an
	// explicit one (an agent that never proved a byte language must accept the
	// later escpos/zpl discovery). Known-binding conflicts are still covered
	// by conflictingNetworkPrintLanguage for identical endpoints.
	return false
}

func mergeDiscoveredSameID(existing, incoming DeviceInfo) DeviceInfo {
	if conflictingNetworkExecutionBinding(existing, incoming) {
		log.Printf("[discovery] distinct network execution destinations collide on printer ID %q", existing.ID)
		return withRegistryIdentityCollision(existing, "same_id_different_network_binding")
	}
	if conflictingUSBExecutionInterface(existing, incoming) {
		log.Printf("[discovery] distinct USB interfaces collide on printer ID %q; explicit reconciliation required", existing.ID)
		return withRegistryIdentityCollision(existing, "same_id_different_usb_interface")
	}
	if conflictingNetworkPrintLanguage(existing, incoming) {
		log.Printf("[discovery] conflicting byte languages for printer endpoint %q; explicit reconciliation required", existing.ID)
		return withRegistryIdentityCollision(existing, "same_endpoint_different_print_language")
	}
	if isSpoolerDevice(existing) && isSpoolerDevice(incoming) &&
		strings.TrimSpace(existing.SpoolerName) != "" &&
		strings.TrimSpace(incoming.SpoolerName) != "" &&
		!sameSpoolerQueueDuringDetailLoss(existing, incoming) {
		log.Printf("[discovery] distinct Windows queues collide on printer ID %q; refusing to select a live destination", existing.ID)
		return withRegistryIdentityCollision(existing, "same_id_different_queue")
	}
	return mergeDeviceInfo(existing, incoming)
}

func mergeDeviceInfo(existing, incoming DeviceInfo) DeviceInfo {
	if conflictingVerifiedIPPUUID(existing.Capabilities, incoming.Capabilities) {
		return retainedIPPIdentityConflict(existing)
	}
	merged := existing
	// Earlier progress snapshots may still be consumed after the scan times out.
	merged.Capabilities = maps.Clone(existing.Capabilities)
	registrationSource, _ := existing.Capabilities["registration_source"].(string)
	operatorNamed := isOperatorRegisteredDevice(existing)
	if strings.TrimSpace(incoming.Name) != "" &&
		(strings.TrimSpace(existing.Name) == "" ||
			(!operatorNamed && existing.SpoolerName == "" && incoming.SpoolerName != "") ||
			(!operatorNamed && isGenericPrinterName(existing.Name) && !isGenericPrinterName(incoming.Name))) {
		merged.Name = incoming.Name
		merged.DisplayName = incoming.DisplayName
	}
	if strings.TrimSpace(merged.DisplayName) == "" && strings.TrimSpace(incoming.DisplayName) != "" {
		merged.DisplayName = incoming.DisplayName
	}
	// Select the complete transport tuple together. Metadata from another
	// source must never replace just the port while retaining an old URI.
	preferIncoming := merged.Endpoint == "" || merged.Protocol == "" || merged.Protocol == "unknown" ||
		(incoming.ConnectionType == "spooler" && merged.ConnectionType != "spooler") || isOperatorRegisteredDevice(incoming)
	if operatorNamed && !isOperatorRegisteredDevice(incoming) && merged.Endpoint != "" {
		// Discovery may enrich a selected direct transport, but cannot replace
		// the operator's backend/protocol with an automatic Windows queue.
		preferIncoming = false
	}
	selectedIncoming := preferIncoming && incoming.Endpoint != ""
	if selectedIncoming {
		merged.Endpoint, merged.ConnectionType, merged.Protocol, merged.Type = incoming.Endpoint, incoming.ConnectionType, incoming.Protocol, incoming.Type
		merged.NetworkAddress, merged.Port = incoming.NetworkAddress, incoming.Port
		if isSpoolerDevice(incoming) {
			merged.SpoolerName = incoming.SpoolerName
			merged.SpoolerPort, merged.SpoolerDriver = incoming.SpoolerPort, incoming.SpoolerDriver
			merged.SpoolerServer, merged.SpoolerShare = incoming.SpoolerServer, incoming.SpoolerShare
		}
	}
	if incoming.SpoolerName != "" && merged.SpoolerName == "" && isSpoolerDevice(merged) {
		merged.SpoolerName = incoming.SpoolerName
	}
	if incoming.USBVID != "" && merged.USBVID == "" {
		merged.USBVID = incoming.USBVID
	}
	if incoming.USBPID != "" && merged.USBPID == "" {
		merged.USBPID = incoming.USBPID
	}
	if refreshNativeUSBDiscoveryIDs(existing, incoming) {
		merged.USBVID, merged.USBPID = incoming.USBVID, incoming.USBPID
	}
	if incoming.USBSerial != "" && merged.USBSerial == "" {
		merged.USBSerial = incoming.USBSerial
	}
	sameTransport := strings.EqualFold(existing.ConnectionType, incoming.ConnectionType) &&
		strings.EqualFold(existing.Protocol, incoming.Protocol) && existing.Endpoint == incoming.Endpoint
	if isSpoolerDevice(existing) && isSpoolerDevice(incoming) {
		sameTransport = strings.EqualFold(strings.TrimSpace(existing.Endpoint), strings.TrimSpace(incoming.Endpoint))
	}
	if incoming.Status != "" && (selectedIncoming || (sameTransport && incoming.Status != "unknown")) {
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
			if !selectedIncoming && ((isSpoolerDevice(existing) && !isSpoolerDevice(incoming)) ||
				(operatorNamed && !isOperatorRegisteredDevice(incoming) && !sameTransport)) {
				// Other transport observations may enrich a selected printer, but their
				// admission/readiness/protocol evidence cannot govern it.
				switch k {
				case "discovered_via", "verification", "runtime_scope", "candidate_reason", "supported_protocols", "requires_spooler":
					continue
				}
				if _, present := merged.Capabilities[k]; present {
					continue
				}
			}
			merged.Capabilities[k] = v
		}
	}
	if operatorNamed {
		if merged.Capabilities == nil {
			merged.Capabilities = make(map[string]interface{})
		}
		merged.Capabilities["registration_source"] = registrationSource
	}
	if uuid := verifiedIPPUUIDFromCapabilities(existing.Capabilities); uuid != "" {
		if merged.Capabilities == nil {
			merged.Capabilities = make(map[string]interface{})
		}
		preserveVerifiedIPPUUID(merged.Capabilities, uuid)
	}
	if incoming.Endpoint != "" && merged.Endpoint == "" {
		merged.Endpoint = incoming.Endpoint
	}
	return merged
}

// TestPrinter submits an explicit diagnostic using the selected local backend.
// Successful submission still requires checking actual paper output.
func TestPrinter(cfg *config.Config, registryPath, printerID string) error {
	// A printer test is an explicit operation against an already selected
	// inventory record. Never invoke network discovery here: discovery has
	// intentionally bounded LAN probes and their timeout budget must not leak
	// into an interactive test-print action.
	registered, err := LoadRegistryPrinters(registryPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("load printer registry: %w", err)
	}
	var configured []DeviceInfo
	if cfg != nil {
		configured = discoverFromConfig(cfg)
	}
	target, err := selectLocalTestTarget(registered, configured, printerID)
	if err != nil {
		return err
	}
	if target == nil {
		return fmt.Errorf("printer %q not found in local printer inventory", printerID)
	}

	pc := printerConfigForTest(cfg, target)
	if NewLocalPrinterDisablement(cfg, registered).Disabled(pc) {
		return fmt.Errorf("printer %s is disabled by local operator configuration", printerID)
	}
	prt, err := New(pc)
	if err != nil {
		return fmt.Errorf("printer %s backend not available: %w", printerID, err)
	}
	if ipp, ok := prt.(*IPPPrinter); ok {
		ipp.SetIdentityPersistence(func(uuid string) error { return PersistVerifiedIPPIdentity(registryPath, pc, uuid) })
	}
	timeout := 15 * time.Second
	if _, physical := prt.(interface{ PrintTestPage(context.Context) error }); physical {
		timeout = defaultPDFPrintTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	ctx = WithDispatchAdmission(ctx, func(admissionCtx context.Context) error {
		disabled, err := LoadLocalPrinterDisablement(cfg, registryPath)
		if err != nil {
			return fmt.Errorf("read local printer disablement before diagnostic output: %w", err)
		}
		if disabled.Disabled(pc) {
			return fmt.Errorf("printer %s is disabled by local operator configuration", printerID)
		}
		// A local diagnostic transmits a real payload to the selected endpoint.
		// Unlike routine job admission (where verification is advisory), this
		// explicit test action requires current identity evidence: a reachable
		// TCP/9100 listener is not proof of a printer and must not receive bytes.
		_, err = ProbeOperationalVerification(admissionCtx, prt, pc)
		return err
	})
	return runLocalPrinterTest(ctx, prt)
}

// printerConfigForTest resolves the backend configuration for an explicit
// diagnostic test against an already-selected inventory record. Configured
// records use the authoritative PrinterConfig verbatim; discovered
// (registry-only) records rebuild from the inventory row preserving USB
// identity, capability evidence and paper-width caps.
func printerConfigForTest(cfg *config.Config, target *DeviceInfo) config.PrinterConfig {
	pc := config.PrinterConfig{}
	if cfg != nil {
		// Prefer the authoritative configured record: it carries the
		// complete declared backend configuration (USB identity,
		// capabilities, paper width) that inventory rows may only
		// approximate.
		for _, p := range cfg.Printers {
			if p.ID == target.ID {
				pc = p
				break
			}
		}
	}
	if pc.ID == "" {
		// Discovered (non-configured) printer: rebuild from the selected
		// inventory row, preserving USB identity, capability evidence
		// and paper-width caps so the diagnostic exercises the same
		// backend configuration the operator selected.
		caps := map[string]interface{}{}
		for k, v := range target.Capabilities {
			caps[k] = v
		}
		enabled := target.Enabled
		pc = config.PrinterConfig{
			ID:           target.ID,
			Name:         target.Name,
			Type:         target.ConnectionType,
			Endpoint:     target.Endpoint,
			Protocol:     target.Protocol,
			SpoolerName:  target.SpoolerName,
			PrinterType:  target.PrinterType,
			USBVID:       target.USBVID,
			USBPID:       target.USBPID,
			USBSerial:    target.USBSerial,
			Capabilities: caps,
			Enabled:      &enabled,
		}
	}
	if target.ConnectionType == "spooler" && pc.SpoolerName == "" {
		pc.SpoolerName = target.SpoolerName
		if pc.Endpoint == "" {
			pc.Endpoint = target.SpoolerName
		}
	}
	if uuid := verifiedIPPUUIDFromCapabilities(target.Capabilities); uuid != "" && verifiedIPPUUIDFromCapabilities(pc.Capabilities) == "" {
		pc.Capabilities = maps.Clone(pc.Capabilities)
		if pc.Capabilities == nil {
			pc.Capabilities = make(map[string]interface{})
		}
		pc.Capabilities["ipp_printer_uuid"] = uuid
	}
	return pc
}
