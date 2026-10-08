package printer

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

// registryMu serializes every read-modify-write of printers.json within this
// process. Async discovery, on-demand discovery, manual registration and the
// CLI helpers all mutate the file concurrently; without one authority, two
// overlapping saves interleave into a truncated registry or a lost update —
// and a lost update that later parses as valid JSON deletes working hardware.
var registryMu sync.Mutex

// registryMu covers goroutines; this stable sidecar lock covers the service,
// desktop CLI and other Agent processes through the complete read/write.
func lockRegistryFile(path string) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	unlock, err := config.LockLocalFile(path + ".lock")
	if err != nil {
		return nil, err
	}
	return func() {
		if err := unlock(); err != nil {
			log.Printf("registry lock release failed: %v", err)
		}
	}, nil
}

// loadRegistryPrinters reads the registry file and returns the printers that
// may be surfaced as managed production printers.
//
// Two categories are kept out of the returned slice:
//   - stale generic PnP entries persisted by old buggy discovery (USB Input
//     Device, HID mice, cameras …) — those are junk and get cleaned up;
//   - virtual / redirected / unclassified queues — those are PRESERVED on disk
//     (never deleted) but never listed, so an operator can still inspect what
//     this machine reports and a future classifier can recover them.
//
// If the file does not exist, a nil slice is returned (not an error).
// LoadRegistryPrinters exports loadRegistryPrinters for external callers.
func LoadRegistryPrinters(registryPath string) ([]DeviceInfo, error) {
	return loadRegistryPrinters(registryPath)
}

func loadRegistryPrinters(registryPath string) ([]DeviceInfo, error) {
	production, _, _, err := loadRegistryPartitioned(registryPath)
	return production, err
}

// loadRegistryPartitioned splits the persisted registry into the printers that
// may be surfaced, the records that must be kept but hidden, and the number of
// junk entries that were dropped.
func loadRegistryPartitioned(registryPath string) (production, hidden []DeviceInfo, removed int, err error) {
	if registryPath == "" {
		return nil, nil, 0, nil
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	unlock, lockErr := lockRegistryFile(registryPath)
	if lockErr != nil {
		return nil, nil, 0, lockErr
	}
	defer unlock()
	return loadRegistryPartitionedLocked(registryPath)
}

func loadRegistryPartitionedLocked(registryPath string) (production, hidden []DeviceInfo, removed int, err error) {
	data, err := os.ReadFile(registryPath)
	if err != nil {
		// An absent registry is the normal first-run state. Do not turn
		// os.IsNotExist into a discovery error; the registry will be created
		// atomically on the first successful registration/discovery persist.
		if os.IsNotExist(err) {
			return nil, nil, 0, nil
		}
		return nil, nil, 0, err
	}
	if len(data) == 0 {
		return nil, nil, 0, nil
	}
	var infos []DeviceInfo
	if err := json.Unmarshal(data, &infos); err != nil {
		return nil, nil, 0, fmt.Errorf("parse registry %s: %w", registryPath, err)
	}
	production = make([]DeviceInfo, 0, len(infos))
	for _, d := range infos {
		if !isValidDiscoveredPrinter(d) {
			// Not a printer at all — drop the stale entry.
			removed++
			continue
		}
		// A record persisted by this agent (or an earlier version) is
		// deliberate operator state. Mark it so that a queue whose metadata is
		// simply too thin to classify is kept instead of silently dropping
		// working hardware. Virtual / redirected evidence still outranks this
		// — see IsProductionPrinter.
		d = withRegistrationSource(d, "registry")
		// The registry is durable inventory/configuration, not live status. It
		// has no observation timestamp, so replaying a persisted online/offline
		// value during concurrent quick discovery makes status depend on source
		// completion order and can overwrite a fresher Windows spooler result.
		// Force registry status to unknown; live OS/backend probes repopulate it.
		d.Status = "unknown"
		if !IsManagedPrinter(d) {
			hidden = append(hidden, d)
			continue
		}
		production = append(production, d)
	}
	if removed > 0 {
		// Rewrite the cleaned registry (best effort, not fatal). Hidden
		// records are written back so nothing is destroyed.
		if err := saveRegistryLocked(registryPath, concatDevices(production, hidden)); err != nil {
			log.Printf("printer registry cleanup rewrite failed: %v", err)
		}
	}
	return production, hidden, removed, nil
}

// withRegistrationSource records where a device came from, without overwriting
// an existing (more specific) source such as "manual" or "config".
func withRegistrationSource(d DeviceInfo, source string) DeviceInfo {
	if d.Capabilities == nil {
		d.Capabilities = map[string]interface{}{}
	}
	if _, ok := d.Capabilities["registration_source"]; !ok {
		d.Capabilities["registration_source"] = source
	}
	return d
}

func concatDevices(a, b []DeviceInfo) []DeviceInfo {
	out := make([]DeviceInfo, 0, len(a)+len(b))
	out = append(out, a...)
	out = append(out, b...)
	return out
}

// Save persists the given DeviceInfos atomically to the registry path under
// the process-wide registry lock, with a unique temp name (two concurrent
// saves sharing one ".tmp" path can interleave) and 0600 file mode (the
// registry describes locally attached hardware endpoints).
func SaveRegistry(registryPath string, printers []DeviceInfo) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	unlock, lockErr := lockRegistryFile(registryPath)
	if lockErr != nil {
		return lockErr
	}
	defer unlock()
	return saveRegistryLocked(registryPath, printers)
}

func saveRegistryLocked(registryPath string, printers []DeviceInfo) error {
	if registryPath == "" {
		return fmt.Errorf("registry path empty")
	}
	dir := filepath.Dir(registryPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		return fmt.Errorf("secure registry dir: %w", err)
	}
	data, err := json.MarshalIndent(printers, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".printers-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		log.Printf("[registry] could not restrict permissions on %s: %v", tmpName, err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := config.EnsureSecureFileACL(tmpName); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("secure registry temp file: %w", err)
	}
	if err := os.Rename(tmpName, registryPath); err != nil {
		return err
	}
	if err := config.EnsureSecureFileACL(registryPath); err != nil {
		return fmt.Errorf("secure registry file: %w", err)
	}
	return nil
}

// Upsert merges discovered printers into the registry idempotently:
//   - If ID already exists, update the record.
//   - Otherwise append.
//
// It is deliberately additive. Partial discovery and manual/config mutation
// paths use this function because absence from an incomplete probe must never
// delete a healthy printer.
func UpsertRegistry(registryPath string, discovered []DeviceInfo) ([]DeviceInfo, error) {
	return mutateRegistryFromDiscovery(registryPath, discovered, nil)
}

// ReconcileDiscoveryRegistry merges a live discovery snapshot and, only for
// discovery sources whose absence semantics are authoritative, removes stale
// automatically-discovered rows that the completed source no longer reports.
//
// Today only the Windows spooler queue inventory is absence-authoritative:
// EnumPrintersW enumerates configured queues, so a queue missing from a
// completed enumeration can be retired locally. A silent/offline USB or
// network device is NOT absence evidence and remains registered until an
// explicit operator/config lifecycle action removes it.
//
// completeSources comes from the same live scan as discovered. If a source
// failed, timed out, or returned a hard partial error, that source is false or
// absent and no row owned by it can be pruned.
func ReconcileDiscoveryRegistry(registryPath string, discovered []DeviceInfo, completeSources map[string]bool) ([]DeviceInfo, error) {
	return mutateRegistryFromDiscovery(registryPath, discovered, completeSources)
}

func mutateRegistryFromDiscovery(registryPath string, discovered []DeviceInfo, completeSources map[string]bool) ([]DeviceInfo, error) {
	registryMu.Lock()
	defer registryMu.Unlock()
	unlock, lockErr := lockRegistryFile(registryPath)
	if lockErr != nil {
		return nil, lockErr
	}
	defer unlock()

	existing, hidden, _, err := loadRegistryPartitionedLocked(registryPath)
	if err != nil {
		if os.IsNotExist(err) {
			existing, hidden = nil, nil
		} else {
			// A corrupt registry must never be silently replaced by an empty
			// one: quarantine the file first so the data is recoverable.
			quarantine := fmt.Sprintf("%s.corrupt-%d", registryPath, time.Now().Unix())
			if rerr := os.Rename(registryPath, quarantine); rerr == nil {
				log.Printf("[registry] WARNING: %s failed to parse; the damaged file was preserved at %s", registryPath, quarantine)
			} else {
				return nil, fmt.Errorf("refusing to overwrite unreadable registry: %v; quarantine failed: %w", err, rerr)
			}
			existing, hidden = nil, nil
		}
	}

	byID := make(map[string]int)
	for i, p := range existing {
		if p.ID != "" {
			byID[p.ID] = i
		}
	}
	for index := range discovered {
		discovered[index] = markAutomaticDiscoveryRegistration(discovered[index])
	}
	for _, d := range discovered {
		if d.ID == "" {
			d.ID = StableIDForDevice(d)
		}
		if !isValidDiscoveredPrinter(d) {
			continue
		}
		// A virtual, redirected or unclassified queue is never promoted into
		// the managed printer set, whatever source reported it.
		if !IsManagedPrinter(d) {
			log.Printf("[registry] refusing to register non-physical printer %q class=%s", d.Name, ClassifyDeviceInfo(d).Class)
			continue
		}
		if idx, ok := byID[d.ID]; ok {
			// Merge into the stored row so a bare rediscovery observation
			// never wipes previously observed capabilities/serials — but
			// the incoming observation is the freshest display truth (an
			// OS/spooler rename must win), while mergeDeviceInfo alone
			// conservatively keeps the stored name for the live-discovery
			// path where cross-transport flapping is noise.
			merged := mergeDeviceInfo(existing[idx], d)
			if d.Name != "" {
				merged.Name = d.Name
			}
			if d.DisplayName != "" {
				merged.DisplayName = d.DisplayName
			}
			// For a spooler row, queue name/endpoint and queue identity are
			// one transport tuple. Once physical identity keeps the stable ID
			// unchanged across a Windows queue rename, retaining the old
			// SpoolerName would rebuild the backend against a queue that no
			// longer exists. The current spooler observation is authoritative.
			if d.ConnectionType == "spooler" || d.Protocol == "spooler" {
				if d.Endpoint != "" {
					merged.Endpoint = d.Endpoint
				}
				if d.SpoolerName != "" {
					merged.SpoolerName = d.SpoolerName
				}
				if d.SpoolerPort != "" {
					merged.SpoolerPort = d.SpoolerPort
				}
				if d.SpoolerDriver != "" {
					merged.SpoolerDriver = d.SpoolerDriver
				}
				if d.SpoolerServer != "" {
					merged.SpoolerServer = d.SpoolerServer
				}
				if d.SpoolerShare != "" {
					merged.SpoolerShare = d.SpoolerShare
				}
				if d.ConnectionType != "" {
					merged.ConnectionType = d.ConnectionType
				}
				if d.Protocol != "" {
					merged.Protocol = d.Protocol
				}
			}
			existing[idx] = merged
			continue
		}

		// Preserve the persisted ID when a stronger physical identity proves
		// that an observed printer is the same device/queue after an IP or
		// spooler-name change. This also migrates IDs created by older
		// name/IP-based implementations without destructive re-registration.
		if identity, ok := physicalIdentityKey(d); ok {
			for idx, prior := range existing {
				if priorIdentity, priorOK := physicalIdentityKey(prior); priorOK && priorIdentity == identity {
					oldID := prior.ID
					d.ID = oldID
					existing[idx] = d
					byID[oldID] = idx
					log.Printf("[registry] preserved printer ID %s across identity-preserving endpoint/name change", oldID)
					goto persisted
				}
			}
		}

		existing = append(existing, d)
		byID[d.ID] = len(existing) - 1
	persisted:
	}

	if len(completeSources) > 0 {
		kept := existing[:0]
		for _, stored := range existing {
			if shouldPruneMissingDiscoveryRow(stored, discovered, completeSources) {
				log.Printf("[registry] removing absent auto-discovered Windows queue %s (%q) after complete spooler inventory", stored.ID, stored.Name)
				continue
			}
			kept = append(kept, stored)
		}
		existing = kept
	}

	// Persist hidden records too: hiding a queue must never delete it.
	all := concatDevices(existing, hidden)
	if err := saveRegistryLocked(registryPath, all); err != nil {
		return nil, err
	}
	return existing, nil
}

func shouldPruneMissingDiscoveryRow(stored DeviceInfo, observed []DeviceInfo, completeSources map[string]bool) bool {
	if !completeSources[SourceSpooler] || !isAutoDiscoveredSpoolerRow(stored) {
		return false
	}
	for _, current := range observed {
		if current.ID != "" && stored.ID != "" && current.ID == stored.ID {
			return false
		}
		storedIdentity, storedOK := physicalIdentityKey(stored)
		currentIdentity, currentOK := physicalIdentityKey(current)
		if storedOK && currentOK && storedIdentity == currentIdentity {
			return false
		}
	}
	return true
}

func isAutoDiscoveredSpoolerRow(d DeviceInfo) bool {
	if d.Capabilities == nil {
		return false
	}
	if source, ok := d.Capabilities["registration_source"].(string); ok {
		switch strings.ToLower(strings.TrimSpace(source)) {
		case "manual", "config":
			return false
		case "discovery":
			if discoveredVia, _ := d.Capabilities["discovered_via"].(string); discoveredVia == SourceSpooler {
				return true
			}
		}
	}
	if discoveredVia, _ := d.Capabilities["discovered_via"].(string); discoveredVia == SourceSpooler {
		return true
	}
	// Legacy rows created before explicit discovery provenance was persisted
	// can still be identified conservatively by EnumPrinters-only metadata.
	// Manual spooler registration never synthesizes these keys.
	if _, ok := d.Capabilities["spooler_scope"]; ok {
		return true
	}
	if _, ok := d.Capabilities["spooler_attributes"]; ok {
		return true
	}
	return false
}

// RegisterManual adds or updates a manually configured printer.
// Manual registration is the operator's EXPLICIT statement of intent, so it
// must never be repaired with invented values: network and USB devices
// require an explicit protocol; only transports with their own identity
// (spooler queues, IPP URLs) may derive it.
func RegisterManual(registryPath string, info DeviceInfo) ([]DeviceInfo, error) {
	// Manual registration is an executable configuration boundary, not merely
	// an inventory hint. Canonicalize aliases here so the local registry,
	// runtime factory, heartbeat contract and Gateway all see the same
	// transport vocabulary.
	connectionType := strings.ToLower(strings.TrimSpace(info.ConnectionType))
	if connectionType == "" {
		connectionType = strings.ToLower(strings.TrimSpace(info.Type))
	}
	switch connectionType {
	case "", "network":
		connectionType = "network"
	case "tcp":
		connectionType = "network"
	case "windows_spooler":
		connectionType = "spooler"
	}
	info.ConnectionType = connectionType
	info.Type = connectionType

	info.Protocol = strings.ToLower(strings.TrimSpace(info.Protocol))
	if info.Protocol == "windows_spooler" {
		info.Protocol = "spooler"
	}

	// A Windows queue discovered/configured through a USB-facing UI is still a
	// spooler transport. Persist it canonically so it never reaches heartbeat
	// as direct USB with a document-spool protocol.
	if info.ConnectionType == "usb" && strings.TrimSpace(info.SpoolerName) != "" {
		info.ConnectionType = "spooler"
		info.Type = "spooler"
		info.Protocol = "spooler"
	}
	if info.ConnectionType == "spooler" {
		if strings.TrimSpace(info.SpoolerName) == "" {
			info.SpoolerName = strings.TrimSpace(info.Endpoint)
		}
		if strings.TrimSpace(info.Endpoint) == "" {
			info.Endpoint = info.SpoolerName
		}
	}

	if info.ID == "" {
		// Preserve the established manual USB ID namespace so existing operator
		// registrations remain stable. Automatic discovery can still use the
		// stronger source-independent identity and UpsertRegistry will migrate
		// to an existing persisted ID when the physical identity matches.
		if info.ConnectionType == "usb" && (info.USBVID != "" || info.USBPID != "" || info.USBSerial != "") {
			location := capabilityIdentityValue(info, "location", "usb_location", "usbLocation")
			info.ID = StableIDFromUSB(info.USBVID, info.USBPID, info.USBSerial, location)
		} else {
			info.ID = StableIDForDevice(info)
		}
	}
	if info.Status == "" {
		info.Status = "unknown"
	}
	if info.Protocol == "" {
		switch info.ConnectionType {
		case "spooler":
			info.Protocol = "spooler"
		case "ipp", "ipps":
			info.Protocol = info.ConnectionType
		case "usb":
			return nil, fmt.Errorf("printer %q: --protocol is required for direct USB printers (raw, escpos, zpl, tspl); no default is guessed", info.ID)
		default:
			return nil, fmt.Errorf("printer %q: --protocol is required for %s printers (raw, escpos, zpl, tspl, ipp, or unknown); no default is guessed", info.ID, info.ConnectionType)
		}
	}

	// Reuse the same executable transport validator as agent.yaml. This keeps
	// the manual registry from accepting a row that can never survive runtime
	// construction or Gateway heartbeat validation.
	enabled := info.Enabled
	cfg := config.PrinterConfig{
		ID:             info.ID,
		Name:           info.Name,
		Type:           info.ConnectionType,
		ConnectionType: info.ConnectionType,
		Endpoint:       info.Endpoint,
		Protocol:       info.Protocol,
		SpoolerName:    info.SpoolerName,
		PrinterType:    info.PrinterType,
		USBVID:         info.USBVID,
		USBPID:         info.USBPID,
		USBSerial:      info.USBSerial,
		Capabilities:   info.Capabilities,
		Enabled:        &enabled,
	}
	if err := config.ValidatePrinterConfig(cfg); err != nil {
		return nil, fmt.Errorf("printer %q: invalid manual configuration: %w", info.ID, err)
	}

	// Explicit operator intent: a manually registered queue stays visible even
	// when its declared protocol is "unknown"; it remains non-routable until
	// the protocol is configured.
	if info.Capabilities == nil {
		info.Capabilities = map[string]interface{}{}
	}
	if _, ok := info.Capabilities["registration_source"]; !ok {
		info.Capabilities["registration_source"] = "manual"
	}
	return UpsertRegistry(registryPath, []DeviceInfo{info})
}

// RemoveFromRegistry removes a printer by ID.
func RemoveFromRegistry(registryPath, printerID string) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	unlock, lockErr := lockRegistryFile(registryPath)
	if lockErr != nil {
		return lockErr
	}
	defer unlock()
	existing, hidden, _, err := loadRegistryPartitionedLocked(registryPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	out := make([]DeviceInfo, 0, len(existing))
	for _, p := range existing {
		if p.ID != printerID {
			out = append(out, p)
		}
	}
	// Hidden records survive an unrelated removal.
	return saveRegistryLocked(registryPath, concatDevices(out, hidden))
}
