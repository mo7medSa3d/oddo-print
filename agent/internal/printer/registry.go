package printer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/yaseir-agent/agent/internal/config"
)

// registryMu serializes every read-modify-write of printers.json within this
// process. Async discovery, on-demand discovery, manual registration and the
// CLI helpers all mutate the file concurrently; without one authority, two
// overlapping saves interleave into a truncated registry or a lost update —
// and a lost update that later parses as valid JSON deletes working hardware.
var registryMu sync.Mutex

// ErrRegistryUntrusted distinguishes loss of saved operator authority from a
// failed write of a new observation. Discovery cannot reconstruct prior
// disablement or verified identity from a device that happens to answer now.
var ErrRegistryUntrusted = errors.New("printer registry requires explicit repair or restoration")

// registryMu covers goroutines; this stable sidecar lock covers the service,
// desktop CLI and other Agent processes through the complete read/write.
func lockRegistryFile(path string) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	unlock, err := config.LockLocalFile(path + ".lock")
	if err != nil {
		// A failed lock cannot discard existing (or unreadable) authority.
		// A definitely absent destination still allows callers to retain a new
		// observation with a write diagnostic, as before; it grants no proof.
		if _, statErr := os.Lstat(path); statErr == nil || (!os.IsNotExist(statErr) && !errors.Is(statErr, syscall.ENOTDIR)) {
			return nil, fmt.Errorf("%w: acquire registry lock: %w", ErrRegistryUntrusted, err)
		}
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
//   - virtual / redirected queues — those are never listed, and
//     saveRegistryLocked deliberately drops them on the next save (they are
//     rediscoverable via spooler enumeration, so no history is lost that
//     cannot be rebuilt); unclassified queues ARE preserved on disk in the
//     hidden partition but never listed, so a future classifier can
//     recover them.
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

const maxRegistryBytes = 16 << 20

func loadRegistryPartitionedLocked(registryPath string) (production, hidden []DeviceInfo, removed int, err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("%w: %w", ErrRegistryUntrusted, err)
		}
	}()
	info, err := os.Lstat(registryPath)
	if err != nil {
		// An absent registry is the normal first-run state. Do not turn
		// os.IsNotExist into a discovery error; the registry will be created
		// atomically on the first successful registration/discovery persist.
		if os.IsNotExist(err) {
			return nil, nil, 0, nil
		}
		return nil, nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxRegistryBytes {
		return nil, nil, 0, fmt.Errorf("registry %s is not a bounded regular file", registryPath)
	}
	if err := config.EnsureSecureDirectoryACL(filepath.Dir(registryPath)); err != nil {
		return nil, nil, 0, err
	}
	if err := config.EnsureSecureFileACL(registryPath); err != nil {
		return nil, nil, 0, err
	}
	f, err := os.Open(registryPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, 0, nil
		}
		return nil, nil, 0, err
	}
	openInfo, statErr := f.Stat()
	if statErr != nil {
		_ = f.Close()
		return nil, nil, 0, statErr
	}
	if !openInfo.Mode().IsRegular() || !os.SameFile(info, openInfo) || openInfo.Size() > maxRegistryBytes {
		_ = f.Close()
		return nil, nil, 0, fmt.Errorf("registry %s changed or exceeds size limit", registryPath)
	}
	data, readErr := io.ReadAll(io.LimitReader(f, maxRegistryBytes+1))
	closeErr := f.Close()
	if readErr != nil {
		return nil, nil, 0, readErr
	}
	if closeErr != nil {
		return nil, nil, 0, closeErr
	}
	if len(data) > maxRegistryBytes {
		return nil, nil, 0, fmt.Errorf("registry %s exceeds %d bytes", registryPath, maxRegistryBytes)
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, nil, 0, fmt.Errorf("registry %s must contain an inventory array", registryPath)
	}
	// Legacy registries may omit enabled. Preserve their historical enabled
	// default while retaining an explicitly persisted false as operator policy.
	var infos []struct {
		DeviceInfo
		Enabled json.RawMessage `json:"enabled"`
	}
	if err := json.Unmarshal(data, &infos); err != nil {
		return nil, nil, 0, fmt.Errorf("parse registry %s: %w", registryPath, err)
	}
	production = make([]DeviceInfo, 0, len(infos))
	for _, row := range infos {
		d := row.DeviceInfo
		switch string(bytes.TrimSpace(row.Enabled)) {
		case "", "true":
			d.Enabled = true
		case "false":
			d.Enabled = false
		default:
			return nil, nil, 0, fmt.Errorf("registry %s printer %s enabled must be a boolean when present", registryPath, d.ID)
		}
		d = discoveredDeviceNames(d)
		if d.ID == "" {
			log.Printf("[registry] refusing printer %q without distinct execution identity", d.Name)
			continue
		}
		if !isValidDiscoveredPrinter(d) {
			// Not a printer at all — drop the stale entry.
			removed++
			continue
		}
		if ClassifyDeviceInfo(d).IsVirtual {
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
		// Persisted evidence is history, never proof of current access.
		delete(d.Capabilities, "operational_verification")
		if !IsManagedPrinter(d) {
			hidden = append(hidden, d)
			continue
		}
		production = append(production, d)
	}
	// An imported or legacy registry can contain two saved records with the
	// same ID but different physical execution destinations. The mutation
	// index is keyed by ID; accepting duplicate authority would silently pick
	// the last record and could rebind a print job to the wrong printer. Fail
	// closed without rewriting or dropping either saved record. An operator
	// must explicitly reconcile the registry before discovery can mutate it.
	seenPrinterIDs := make(map[string]struct{}, len(production)+len(hidden))
	for _, saved := range concatDevices(production, hidden) {
		if _, exists := seenPrinterIDs[saved.ID]; exists {
			return nil, nil, 0, fmt.Errorf("registry %s contains duplicate printer ID %q; restore or reconcile the original file before dispatch", registryPath, saved.ID)
		}
		seenPrinterIDs[saved.ID] = struct{}{}
	}
	if removed > 0 {
		// Rewrite the registry and remove all obsolete software-printer rows.
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
	// Never persist even legacy virtual records passed by CLI or recovery.
	physical := make([]DeviceInfo, 0, len(printers))
	for _, entry := range printers {
		if !ClassifyDeviceInfo(entry).IsVirtual {
			physical = append(physical, entry)
		}
	}
	seenIDs := make(map[string]struct{}, len(physical))
	for _, entry := range physical {
		if entry.ID == "" {
			continue
		}
		if _, exists := seenIDs[entry.ID]; exists {
			return fmt.Errorf("registry contains duplicate printer ID %q", entry.ID)
		}
		seenIDs[entry.ID] = struct{}{}
	}
	data, err := json.MarshalIndent(physical, "", "  ")
	if err != nil {
		return err
	}
	if len(data) > maxRegistryBytes {
		return fmt.Errorf("serialized registry exceeds %d bytes", maxRegistryBytes)
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
	if err := config.ReplaceFile(tmpName, registryPath); err != nil {
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
	return mutateRegistry(registryPath, discovered, nil, "")
}

// ReconcileDiscoveryRegistry retains identity/history through absence. A
// complete Windows enumeration can make a queue unavailable, never delete its
// saved configuration or silently assign its jobs to a replacement queue.
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
	return mutateRegistry(registryPath, discovered, completeSources, "")
}

// networkBindingUncomparable reports whether two network/IPP rows cannot
// have their execution bindings compared because a digest errors. Used only
// on the registry continuity replacement path (see the v3 note there).
func networkBindingUncomparable(left, right DeviceInfo) bool {
	leftType, rightType := SharingConfigForDevice(left).NormalizedType(), SharingConfigForDevice(right).NormalizedType()
	if leftType != "network" && leftType != "ipp" && leftType != "ipps" {
		return false
	}
	if rightType != "network" && rightType != "ipp" && rightType != "ipps" {
		return false
	}
	if strings.TrimSpace(left.Endpoint) == "" || strings.TrimSpace(right.Endpoint) == "" {
		return false
	}
	_, leftError := config.PrinterBindingDigest(SharingConfigForDevice(left))
	_, rightError := config.PrinterBindingDigest(SharingConfigForDevice(right))
	return leftError != nil || rightError != nil
}

func mutateRegistry(registryPath string, discovered []DeviceInfo, completeSources map[string]bool, operatorTargetID string) ([]DeviceInfo, error) {
	registryMu.Lock()
	defer registryMu.Unlock()
	unlock, lockErr := lockRegistryFile(registryPath)
	if lockErr != nil {
		return nil, lockErr
	}
	defer unlock()

	existing, hidden, _, err := loadRegistryPartitionedLocked(registryPath)
	if err != nil {
		// Keep the original at its authoritative path. Moving it aside would
		// make the next scan look like a first install and silently replace
		// disabled decisions or a pinned IPP identity with current observations.
		return nil, err
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
		d = discoveredDeviceNames(d)
		if d.ID == "" {
			d.ID = StableIDForDevice(d)
		}
		if d.ID == "" {
			log.Printf("[registry] refusing printer %q without a distinct execution identity", d.Name)
			continue
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
		if _, found := byID[d.ID]; !found {
			continuityIndex := -1
			ambiguous := false
			for idx, prior := range existing {
				if prior.ID == "" || !sameSpoolerQueueDuringDetailLoss(prior, d) {
					continue
				}
				if continuityIndex != -1 {
					ambiguous = true
					break
				}
				continuityIndex = idx
			}
			if ambiguous {
				// Preserve every existing candidate for operator resolution.
				// The pruning predicate recognizes the same weak observation;
				// it must not invent a third binding or arbitrarily pick one.
				log.Printf("[registry] ambiguous detail-loss observation for Windows queue %q; retaining established bindings without rebinding", d.SpoolerName)
				continue
			}
			if continuityIndex != -1 {
				d.ID = existing[continuityIndex].ID
			}
		}
		if _, found := byID[d.ID]; !found {
			// URI spelling is not a new IPP execution destination. Reuse the
			// same canonical binding as local sharing policy so aliases keep
			// the established ID and the operator's enable/disable decision.
			// Do not rewrite historical IDs or guess between pre-existing
			// duplicates; jobs may still refer to either of those identities.
			if binding, ok := ippRegistryBinding(d); ok {
				continuityIndex := -1
				ambiguous := false
				for idx, prior := range existing {
					priorBinding, priorOK := ippRegistryBinding(prior)
					if prior.ID == "" || !priorOK || priorBinding != binding {
						continue
					}
					if continuityIndex != -1 {
						ambiguous = true
						break
					}
					continuityIndex = idx
				}
				if ambiguous {
					log.Printf("[registry] ambiguous IPP alias for printer %q; retaining established identities without rebinding", d.Name)
					continue
				}
				if continuityIndex != -1 {
					d.ID = existing[continuityIndex].ID
				}
			}
		}
		if _, found := byID[d.ID]; !found && !isSpoolerDevice(d) {
			// The exact configured interface/endpoint can preserve a registration
			// without trusting a caller-supplied hardware serial or UUID. This also
			// migrates legacy manual USB IDs while keeping distinct paths separate.
			if binding, bindingErr := config.PrinterBindingDigest(SharingConfigForDevice(d)); bindingErr == nil {
				matches := make([]int, 0, 1)
				for index, prior := range existing {
					priorBinding, err := config.PrinterBindingDigest(SharingConfigForDevice(prior))
					if err == nil && priorBinding == binding {
						matches = append(matches, index)
					}
				}
				if len(matches) > 1 {
					for _, index := range matches {
						existing[index] = withRegistryIdentityCollision(existing[index], "ambiguous_execution_endpoint")
					}
					continue
				}
				if len(matches) == 1 {
					d.ID = existing[matches[0]].ID
				}
			}
		}
		// Hidden unclassified rows are retained on disk. Promote a matching
		// observation only when its execution binding is unchanged (or an
		// operator explicitly targets that ID); otherwise do not persist a
		// second row that would make the registry unreadable on its next load.
		hiddenCollision := false
		for hiddenIndex, prior := range hidden {
			if prior.ID != d.ID {
				continue
			}
			if operatorTargetID != prior.ID {
				priorBinding, priorErr := config.PrinterBindingDigest(SharingConfigForDevice(prior))
				currentBinding, currentErr := config.PrinterBindingDigest(SharingConfigForDevice(d))
				if priorErr != nil || currentErr != nil || priorBinding != currentBinding {
					log.Printf("[registry] printer ID %q conflicts with a preserved unclassified record; retaining it without rebinding", d.ID)
					hiddenCollision = true
					break
				}
			}
			existing = append(existing, prior)
			byID[prior.ID] = len(existing) - 1
			hidden = append(hidden[:hiddenIndex], hidden[hiddenIndex+1:]...)
			break
		}
		if hiddenCollision {
			continue
		}
		if idx, ok := byID[d.ID]; ok {
			if operatorTargetID != existing[idx].ID && conflictingNetworkExecutionBinding(existing[idx], d) {
				existing[idx] = withRegistryIdentityCollision(existing[idx], "same_id_different_network_binding")
				log.Printf("[registry] conflicting network execution destinations share printer ID %q", d.ID)
				continue
			}
			if conflictingUSBExecutionInterface(existing[idx], d) && operatorTargetID != existing[idx].ID {
				// The legacy VID/PID-only ID is not a physical USB device identity.
				// Keep the original endpoint and operator policy; reject a second
				// distinct interface until an explicit manual reconciliation.
				existing[idx] = withRegistryIdentityCollision(existing[idx], "same_id_different_usb_interface")
				log.Printf("[registry] conflicting USB interfaces share persisted ID %q; operator reconciliation required", d.ID)
				continue
			}
			// Pre-upgrade auto-discovery could give HTTPS/IPPS and plaintext
			// /ipp/print on port 631 the same generated stable ID. An ID
			// collision is NOT permission to replace an established print
			// resource or downgrade its transport. Only a deliberate manual
			// update targeting this precise saved ID may rebind it.
			if priorBinding, priorOK := ippRegistryBinding(existing[idx]); priorOK {
				if incomingBinding, incomingOK := ippRegistryBinding(d); incomingOK &&
					incomingBinding != priorBinding && operatorTargetID != existing[idx].ID {
					existing[idx] = withRegistryIdentityCollision(existing[idx], "same_id_different_ipp_queue")
					log.Printf("[registry] conflicting IPP execution destinations share saved ID %q; operator reconciliation required", d.ID)
					continue
				}
			}
			if isSpoolerDevice(existing[idx]) && isSpoolerDevice(d) && !sameSpoolerQueueDuringDetailLoss(existing[idx], d) {
				oldGUID, newGUID := verifiedWindowsQueueGUID(existing[idx]), verifiedWindowsQueueGUID(d)
				source, _ := d.Capabilities["registration_source"].(string)
				if (oldGUID == "" || oldGUID != newGUID) && source != "manual" && source != "config" {
					existing[idx] = withRegistryIdentityCollision(existing[idx], "same_id_different_queue")
					log.Printf("[registry] conflicting native queues share persisted ID %q; explicit reconciliation required", d.ID)
					continue
				}
			}
			if conflictingVerifiedIPPUUID(existing[idx].Capabilities, d.Capabilities) {
				log.Printf("[registry] verified IPP identity changed for %q; retaining established binding", d.ID)
				existing[idx] = retainedIPPIdentityConflict(existing[idx])
				continue
			}
			d = preserveRegistryObservationEvidence(existing[idx], d)
			// Merge into the stored row so a bare rediscovery observation
			// never wipes previously observed capabilities/serials — but
			// the incoming observation is the freshest display truth (an
			// OS/spooler rename must win), while mergeDeviceInfo alone
			// conservatively keeps the stored name for the live-discovery
			// path where cross-transport flapping is noise.
			merged := mergeDeviceInfo(existing[idx], d)
			if operatorTargetID != "" && operatorTargetID == existing[idx].ID {
				// Only an explicit manual update of this established ID may
				// change policy. Alias/auto-ID continuity and discovery source
				// strings cannot silently enable a different saved registration.
				merged.Enabled = d.Enabled
				priorBinding, priorErr := config.PrinterBindingDigest(SharingConfigForDevice(existing[idx]))
				currentBinding, currentErr := config.PrinterBindingDigest(SharingConfigForDevice(d))
				if priorErr != nil || currentErr != nil || priorBinding != currentBinding {
					// Operator deliberately changed the execution destination.
					// Do not transfer measured geometry, supported document
					// languages or an old identity-collision fence to the newly
					// selected binding. Fresh native probe evidence is required.
					for _, key := range []string{"geometry", "operational_verification", "supported_protocols", "geometry_error", "identity_collision"} {
						delete(merged.Capabilities, key)
					}
				}
			}
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

		// Preserve the persisted ID when a stronger device or logical identity proves
		// that an observed printer is the same device/queue after an IP or
		// spooler-name change. This also migrates IDs created by older
		// name/IP-based implementations without destructive re-registration.
		if identity, ok := physicalIdentityKey(d); ok && registryMayUseObservedIdentity(d) {
			matches := make([]int, 0, 1)
			for idx, prior := range existing {
				if priorIdentity, priorOK := physicalIdentityKey(prior); priorOK && priorIdentity == identity {
					matches = append(matches, idx)
				}
			}
			if len(matches) > 1 {
				for _, idx := range matches {
					existing[idx] = withRegistryIdentityCollision(existing[idx], "ambiguous_persisted_queue")
				}
				log.Printf("[registry] multiple registrations match printer %q; explicit reconciliation required", d.Name)
				continue
			}
			if len(matches) == 1 {
				idx := matches[0]
				prior := existing[idx]
				if conflictingNetworkExecutionBinding(prior, d) {
					// A hardware identity cannot silently rebind a logical queue.
					// Retain its old ID and require explicit operator reconciliation.
					existing[idx] = withRegistryIdentityCollision(prior, "same_hardware_different_network_binding")
					continue
				}
				// v3: conflictingNetworkExecutionBinding returns false when a
				// binding digest errors (protocol-unknown rows, e.g. SNMP rows,
				// have no declared protocol to digest). Taking the continuity
				// replacement below in that case let a replacement device at a
				// recycled IP silently inherit the old row's registration and
				// gateway identity. Uncomparable network bindings quarantine
				// like any other conflict; an operator reconciles explicitly.
				// This is deliberately narrower than changing the shared
				// function: weak observations in the merge path may still be
				// refined by a later explicit discovery.
				if networkBindingUncomparable(prior, d) {
					existing[idx] = withRegistryIdentityCollision(prior, "same_hardware_uncomparable_network_binding")
					continue
				}
				d = preserveRegistryObservationEvidence(prior, d)
				d.ID, d.Enabled = prior.ID, prior.Enabled
				existing[idx] = d
				byID[d.ID] = idx
				goto persisted
			}
		}

		existing = append(existing, d)
		byID[d.ID] = len(existing) - 1
	persisted:
	}

	if len(completeSources) > 0 {
		for index, stored := range existing {
			if shouldPruneMissingDiscoveryRow(stored, discovered, completeSources) {
				stored.Capabilities = maps.Clone(stored.Capabilities)
				stored.Capabilities["inventory_present"] = false
				delete(stored.Capabilities, "operational_verification")
				delete(stored.Capabilities, "geometry")
				stored.Status = "unknown"
				existing[index] = stored
				log.Printf("[registry] retained absent Windows queue %s (%q) as unavailable history", stored.ID, stored.Name)
			}
		}
	}

	// Persist hidden records too: hiding a queue must never delete it.
	all := concatDevices(existing, hidden)
	if err := saveRegistryLocked(registryPath, all); err != nil {
		return nil, err
	}
	return existing, nil
}

func ippRegistryBinding(device DeviceInfo) (string, bool) {
	pc := SharingConfigForDevice(device)
	protocol, err := pc.NormalizedProtocol()
	if err != nil || (protocol != "ipp" && protocol != "ipps") {
		return "", false
	}
	binding, err := config.PrinterBindingDigest(pc)
	return binding, err == nil
}

// preserveRegistryObservationEvidence keeps operator intent and last-known
// identity evidence separate from a weaker live observation. Status remains the
// incoming observation's responsibility; retained details do not mean "online".
func preserveRegistryObservationEvidence(prior, incoming DeviceInfo) DeviceInfo {
	caps := make(map[string]interface{}, len(prior.Capabilities)+len(incoming.Capabilities))
	for key, value := range prior.Capabilities {
		caps[key] = value
	}
	for key, value := range incoming.Capabilities {
		caps[key] = value
	}
	// A newly observed queue is present again. Old absence is history only;
	// the operational probe still has to establish fresh dispatch eligibility.
	delete(caps, "inventory_present")
	delete(caps, "operational_verification")
	// Unverified discovery UUID hints cannot replace an identity obtained
	// from the execution endpoint's actual IPP response.
	if uuid := verifiedIPPUUIDFromCapabilities(prior.Capabilities); uuid != "" {
		preserveVerifiedIPPUUID(caps, uuid)
	}
	if sameSpoolerQueueDuringDetailLoss(prior, incoming) {
		for _, key := range []string{"port_name", "driver_name", "server_name", "share_name"} {
			if capabilityIdentityValue(incoming, key) == "" && capabilityIdentityValue(prior, key) != "" {
				caps[key] = prior.Capabilities[key]
			}
		}
	}
	// Rediscovery enriches an explicit row; it cannot turn manual/config
	// ownership into auto-discovery ownership eligible for absence deletion.
	if source, ok := prior.Capabilities["registration_source"].(string); ok {
		switch strings.ToLower(strings.TrimSpace(source)) {
		case "manual", "config":
			caps["registration_source"] = source
		}
	}
	incoming.Capabilities = caps
	return incoming
}

func shouldPruneMissingDiscoveryRow(stored DeviceInfo, observed []DeviceInfo, completeSources map[string]bool) bool {
	if !completeSources[SourceSpooler] || !isAutoDiscoveredSpoolerRow(stored) {
		return false
	}
	for _, current := range observed {
		if current.ID != "" && stored.ID != "" && current.ID == stored.ID {
			return false
		}
		if sameSpoolerQueueDuringDetailLoss(stored, current) {
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
	operatorTargetID := info.ID
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
		// A declared UUID/serial is an expected value, never an observed
		// identity. New manual IDs use the exact logical execution endpoint;
		// registry continuity above preserves an established ID for that same
		// endpoint, including older manual USB ID namespaces.
		binding, err := config.PrinterBindingDigest(SharingConfigForDevice(info))
		if err == nil {
			info.ID = stableIDFromIdentityKey("manual-execution-endpoint:" + binding)
		} else {
			if info.ConnectionType == "usb" {
				return nil, fmt.Errorf("manual USB registration needs a valid distinct interface: %w", err)
			}
			identity := info
			identity.Capabilities = nil
			identity.USBSerial = ""
			info.ID = StableIDForDevice(identity)
		}
	}
	info.Status = "unknown"
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
	} else {
		info.Capabilities = maps.Clone(info.Capabilities)
	}
	// Manual input is a configured destination, never a physical observation.
	// In particular, only Get-Printer-Attributes may establish an IPP service
	// UUID, and only a live driver/IPP probe may publish measured geometry.
	// Treat these incoming fields as untrusted even when a UI re-submits a
	// previously discovered candidate. Existing verified evidence is retained
	// separately by the registry merge when the saved binding is unchanged.
	for _, key := range []string{
		"operational_verification", "geometry", "verification",
		"ipp_verified", "ipp_printer_uuid", "printer_uuid", "uuid",
		"snmp_verified", "print_endpoint_verified",
		"windows_queue_guid", "windows_queue_guid_verified",
	} {
		delete(info.Capabilities, key)
	}
	if ippCaps, ok := info.Capabilities["ipp_capabilities"].(map[string]interface{}); ok {
		// Preserve helpful format hints while preventing a nested claimed UUID
		// from being interpreted as a verified transport identity. Clone before
		// editing so an API/CLI caller's map is not mutated.
		filtered := maps.Clone(ippCaps)
		delete(filtered, "printer_uuid")
		if len(filtered) == 0 {
			delete(info.Capabilities, "ipp_capabilities")
		} else {
			info.Capabilities["ipp_capabilities"] = filtered
		}
	}
	info.Capabilities["verification"] = "pending"
	info.Capabilities["registration_source"] = "manual"
	return mutateRegistry(registryPath, []DeviceInfo{info}, nil, operatorTargetID)
}

func registryMayUseObservedIdentity(device DeviceInfo) bool {
	source, _ := device.Capabilities["registration_source"].(string)
	return source != "manual" && source != "config"
}

func withRegistryIdentityCollision(device DeviceInfo, reason string) DeviceInfo {
	device.Capabilities = maps.Clone(device.Capabilities)
	if device.Capabilities == nil {
		device.Capabilities = map[string]interface{}{}
	}
	device.Capabilities["identity_collision"] = reason
	delete(device.Capabilities, "operational_verification")
	// Geometry belonged to one of the colliding destinations. Keeping it
	// would advertise stale dimensions for a queue we can no longer identify.
	delete(device.Capabilities, "geometry")
	device.Status = "unknown"
	return device
}

// RemoveFromRegistry removes a printer by ID.
func RemoveFromRegistry(registryPath, printerID string) error {
	return removeFromRegistry(registryPath, printerID, false)
}

// RemoveGatewayPrinterFromRegistry removes stale cloud-owned inventory, while
// preserving explicit local disablement. A remote delete/recreate must never
// erase the operator's saved denial. Test the flag under the mutation lock.
func RemoveGatewayPrinterFromRegistry(registryPath, printerID string) error {
	return removeFromRegistry(registryPath, printerID, true)
}

func removeFromRegistry(registryPath, printerID string, preserveDisabled bool) error {
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
		if p.ID != printerID || (preserveDisabled && !p.Enabled) {
			out = append(out, p)
		}
	}
	if preserveDisabled && len(out) == len(existing) {
		return nil
	}
	// Hidden records survive an unrelated removal.
	return saveRegistryLocked(registryPath, concatDevices(out, hidden))
}
