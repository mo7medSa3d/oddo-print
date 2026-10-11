package agent

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type desiredPrinterWire struct {
	ID              string                 `json:"id"`
	Name            string                 `json:"name"`
	PrinterType     string                 `json:"printerType"`
	DeviceClass     string                 `json:"deviceClass"`
	ConnectionType  string                 `json:"connectionType"`
	Protocol        string                 `json:"protocol"`
	Lifecycle       string                 `json:"lifecycle"`
	Config          map[string]interface{} `json:"config"`
	DesiredRevision int64                  `json:"desiredRevision"`
}

type desiredPrinterRecord struct {
	Desired                         desiredPrinterWire `json:"desired"`
	AppliedDesiredRevision          int64              `json:"appliedDesiredRevision"`
	ObservedDesiredRevision         int64              `json:"observedDesiredRevision"`
	ObservedSupportedProtocols      []string           `json:"observedSupportedProtocols,omitempty"`
	ObservedSupportedProtocolsKnown bool               `json:"observedSupportedProtocolsKnown,omitempty"`
	ApplyError                      string             `json:"applyError,omitempty"`
}

type desiredStateDisk struct {
	Printers                 []desiredPrinterRecord `json:"printers"`
	DeletedGatewayPrinterIds []string               `json:"deletedGatewayPrinterIds,omitempty"`
}

func desiredStatePath(configPath string) string {
	// Resolve exactly like RegistryPath/QueueDBPath (config/paths.go): a
	// bare "agent.yaml" lives in the working directory, not beside the
	// executable. Splitting desired-state.json away from queue.db/printers.json
	// strands tombstones and applied revisions — and under Program Files the
	// exe-dir write fails, fencing execution forever.
	dir := filepath.Dir(configPath)
	if absolute, err := filepath.Abs(configPath); err == nil {
		dir = filepath.Dir(absolute)
	}
	if configPath == "" || dir == "." {
		if exe, err := os.Executable(); err == nil {
			dir = filepath.Dir(exe)
		}
	}
	return filepath.Join(dir, "desired-state.json")
}

const maxDesiredStateBytes = 16 << 20

func (a *Agent) loadDesiredState() error {
	f, err := os.Open(a.desiredStatePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > maxDesiredStateBytes {
		return fmt.Errorf("desired state file exceeds %d bytes", maxDesiredStateBytes)
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxDesiredStateBytes+1))
	if err != nil {
		return err
	}
	if int64(len(raw)) > maxDesiredStateBytes {
		return fmt.Errorf("desired state file exceeds %d bytes", maxDesiredStateBytes)
	}

	var disk desiredStateDisk
	if err := json.Unmarshal(raw, &disk); err != nil || disk.Printers == nil {
		var legacy []desiredPrinterRecord
		if legacyErr := json.Unmarshal(raw, &legacy); legacyErr != nil {
			if err != nil {
				return fmt.Errorf("parse %s: %w", a.desiredStatePath, err)
			}
			return fmt.Errorf("parse %s: desired-state printers must be an array", a.desiredStatePath)
		}
		disk.Printers = legacy
	}
	a.printersMu.Lock()
	if a.gatewayTombstones == nil {
		a.gatewayTombstones = make(map[string]struct{})
	}
	for _, id := range disk.DeletedGatewayPrinterIds {
		id = strings.TrimSpace(id)
		if id != "" {
			a.gatewayTombstones[id] = struct{}{}
		}
	}
	a.printersMu.Unlock()

	for _, row := range disk.Printers {
		if row.Desired.ID == "" || row.Desired.DesiredRevision < 0 {
			continue
		}
		a.desiredStateMu.Lock()
		a.desiredStates[row.Desired.ID] = row
		a.desiredStateMu.Unlock()
		a.markGatewayOwned(row.Desired.ID)

		if row.Desired.Lifecycle == "active" && row.ApplyError == "" {
			if err := a.applyDesiredPrinter(row); err != nil {
				if recordErr := a.recordDesiredError(row.Desired.ID, err); recordErr != nil {
					log.Printf("failed to persist desired-state error for %s: %v", row.Desired.ID, recordErr)
				}
			} else {
				row.AppliedDesiredRevision = row.Desired.DesiredRevision
				row.ObservedDesiredRevision = 0
				a.desiredStateMu.Lock()
				a.desiredStates[row.Desired.ID] = row
				a.desiredStateMu.Unlock()
			}
		} else {
			a.removeGatewayRuntime(row.Desired.ID)
			if row.ApplyError == "" {
				row.AppliedDesiredRevision = row.Desired.DesiredRevision
				row.ObservedDesiredRevision = row.Desired.DesiredRevision
				a.desiredStateMu.Lock()
				a.desiredStates[row.Desired.ID] = row
				a.desiredStateMu.Unlock()
			}
		}
	}
	return nil
}

func (a *Agent) markGatewayOwned(id string) {
	a.printersMu.Lock()
	if a.gatewayOwned == nil {
		a.gatewayOwned = make(map[string]struct{})
	}
	if a.gatewayTombstones == nil {
		a.gatewayTombstones = make(map[string]struct{})
	}
	delete(a.gatewayTombstones, id)
	a.gatewayOwned[id] = struct{}{}
	a.printersMu.Unlock()
}

func (a *Agent) persistDesiredState() error {
	a.desiredStatePersistMu.Lock()
	defer a.desiredStatePersistMu.Unlock()

	a.desiredStateMu.Lock()
	rows := make([]desiredPrinterRecord, 0, len(a.desiredStates))
	for _, row := range a.desiredStates {
		rows = append(rows, row)
	}
	a.desiredStateMu.Unlock()

	a.printersMu.RLock()
	tombstones := make([]string, 0, len(a.gatewayTombstones))
	for id := range a.gatewayTombstones {
		tombstones = append(tombstones, id)
	}
	a.printersMu.RUnlock()
	sort.Strings(tombstones)

	data, err := json.MarshalIndent(desiredStateDisk{
		Printers:                 rows,
		DeletedGatewayPrinterIds: tombstones,
	}, "", "  ")
	if err != nil {
		return err
	}
	if len(data) > maxDesiredStateBytes {
		return fmt.Errorf("serialized desired state exceeds %d bytes", maxDesiredStateBytes)
	}

	dir := filepath.Dir(a.desiredStatePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Mode bits are ignored on Windows: harden the directory itself, or
	// printer inventory (internal IPs, spooler names, USB serials) is
	// world-readable on a fresh machine. Same pattern as config.Save.
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".desired-state-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := config.EnsureSecureFileACL(tmpName); err != nil {
		return err
	}
	if err := os.Rename(tmpName, a.desiredStatePath); err != nil {
		return err
	}
	if err := config.EnsureSecureFileACL(a.desiredStatePath); err != nil {
		return err
	}
	return nil
}

func (a *Agent) recordDesiredError(id string, err error) error {
	a.desiredStateMu.Lock()
	row, ok := a.desiredStates[id]
	if !ok {
		a.desiredStateMu.Unlock()
		return nil
	}
	row.ApplyError = err.Error()
	a.desiredStates[id] = row
	a.desiredStateMu.Unlock()
	return a.persistDesiredState()
}

func (a *Agent) isPrinterExecutionAllowed(id string) bool {
	// A tombstoned Gateway-owned printer is always fenced, even after its
	// desired-state cache entry has been removed. This is the fail-closed
	// boundary used when durable tombstone persistence temporarily fails.
	a.printersMu.RLock()
	_, tombstoned := a.gatewayTombstones[id]
	a.printersMu.RUnlock()
	if tombstoned {
		return false
	}

	a.desiredStateMu.Lock()
	row, managed := a.desiredStates[id]
	synced := a.desiredStateSynced
	a.desiredStateMu.Unlock()

	// Before the first successful full Gateway desired-state snapshot, every
	// non-YAML runtime printer is ambiguous: it may be a stale/tampered local
	// registry entry for a Gateway-managed printer whose ownership/configuration
	// has not yet been restored. Fail closed for that class. YAML printers are
	// explicitly local operator configuration and retain their existing startup
	// behavior for backward compatibility.
	if !a.isYAMLOwnedPrinter(id) && !synced {
		return false
	}

	if !managed {
		return true
	}
	return synced &&
		row.ApplyError == "" &&
		row.Desired.Lifecycle == "active" &&
		row.AppliedDesiredRevision >= row.Desired.DesiredRevision &&
		row.ObservedDesiredRevision >= row.Desired.DesiredRevision
}

func (a *Agent) isYAMLOwnedPrinter(id string) bool {
	if a.cfg == nil {
		return false
	}
	for _, pc := range a.cfg.Printers {
		if pc.ID == id {
			return true
		}
	}
	return false
}

func (a *Agent) desiredStateAcksPayload() []map[string]interface{} {
	a.desiredStateMu.Lock()
	defer a.desiredStateMu.Unlock()

	out := make([]map[string]interface{}, 0, len(a.desiredStates))
	for id, row := range a.desiredStates {
		out = append(out, map[string]interface{}{
			"printerId":               id,
			"appliedDesiredRevision":  row.AppliedDesiredRevision,
			"observedDesiredRevision": row.ObservedDesiredRevision,
		})
	}
	return out
}

func desiredStringValue(m map[string]interface{}, key string) string {
	switch v := m[key].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case json.Number:
		return v.String()
	default:
		return ""
	}
}

// Gateway numeric USB identifiers are decimal numbers; the backend expects
// hexadecimal strings. Legacy/operator strings already use hexadecimal.
func desiredUSBIdentity(m map[string]interface{}, key string) string {
	if value, ok := m[key].(string); ok {
		return strings.TrimSpace(value)
	}
	decimal := desiredStringValue(m, key)
	value, err := strconv.ParseUint(decimal, 10, 16)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%04x", value)
}

func desiredNumberValue(m map[string]interface{}, key string) int {
	v, err := strconv.Atoi(desiredStringValue(m, key))
	if err != nil || v < 0 {
		return 0
	}
	return v
}

func desiredPaperWidthMM(config map[string]interface{}) int {
	widths, ok := config["paper_widths"].([]interface{})
	if !ok || len(widths) != 1 {
		return 0
	}
	width := desiredNumberValue(map[string]interface{}{"width": widths[0]}, "width")
	if width <= 0 || width > 1000 {
		return 0
	}
	return width
}

func desiredEndpoint(c map[string]interface{}, connectionType string) string {
	if connectionType == "network" {
		if ip := desiredStringValue(c, "ip"); ip != "" {
			port := desiredNumberValue(c, "port")
			if port > 0 {
				return net.JoinHostPort(strings.Trim(ip, "[]"), strconv.Itoa(port))
			}
			return ip
		}
		return ""
	}
	if value := desiredStringValue(c, "address"); value != "" {
		return value
	}
	if value := desiredStringValue(c, "spooler_name"); value != "" && connectionType == "spooler" {
		return value
	}
	return ""
}

func validateDesiredNetworkDestination(c map[string]interface{}) error {
	host := strings.Trim(desiredStringValue(c, "ip"), "[]")
	port := desiredNumberValue(c, "port")
	if host == "" || port == 0 {
		return fmt.Errorf("network printer requires config.ip and config.port")
	}
	ip := net.ParseIP(host)
	if ip == nil || !config.IsAllowedPrinterIP(ip) {
		return fmt.Errorf("network printer destination must be a private or link-local IP address")
	}
	canonical := net.JoinHostPort(host, strconv.Itoa(port))
	if supplied := desiredStringValue(c, "address"); supplied != "" {
		suppliedHost, suppliedPort, err := net.SplitHostPort(supplied)
		if err != nil || net.JoinHostPort(strings.Trim(suppliedHost, "[]"), suppliedPort) != canonical {
			return fmt.Errorf("network printer config.address conflicts with config.ip/config.port")
		}
	}
	return nil
}

func desiredSpoolerPassthrough(config map[string]interface{}) ([]string, bool) {
	raw, present := config["passthrough_protocols"]
	if !present {
		return nil, false
	}
	values := make([]string, 0, 2)
	seen := map[string]bool{}
	appendValue := func(value string) {
		value = strings.ToLower(strings.TrimSpace(value))
		if (value == "raw" || value == "escpos") && !seen[value] {
			seen[value] = true
			values = append(values, value)
		}
	}
	switch list := raw.(type) {
	case []interface{}:
		for _, value := range list {
			if text, ok := value.(string); ok {
				appendValue(text)
			}
		}
	case []string:
		for _, value := range list {
			appendValue(value)
		}
	}
	return values, true
}

func desiredPrinterConfig(row desiredPrinterRecord) config.PrinterConfig {
	p := row.Desired
	enabled := p.Lifecycle == "active"
	var capabilities map[string]interface{}
	// Manager-owned spooler byte passthrough is explicit desired state. Build
	// the capability list from the immutable document baseline plus those
	// opt-ins, so an old observed capability snapshot can never erase or keep
	// stale RAW/ESC-POS permissions after a configuration change.
	if passthrough, present := desiredSpoolerPassthrough(p.Config); present && p.ConnectionType == "spooler" {
		protocols := printer.SupportedProtocolsForDevice(printer.TransportFacts{Protocol: p.Protocol, Connection: p.ConnectionType})
		seen := make(map[string]bool, len(protocols)+len(passthrough))
		for _, value := range protocols {
			seen[value] = true
		}
		for _, value := range passthrough {
			if !seen[value] {
				protocols = append(protocols, value)
				seen[value] = true
			}
		}
		capabilities = map[string]interface{}{"supported_protocols": protocols}
	} else if row.ObservedSupportedProtocolsKnown {
		// Backward compatibility for desired-state files written before explicit
		// passthrough configuration existed.
		capabilities = map[string]interface{}{
			"supported_protocols": append([]string(nil), row.ObservedSupportedProtocols...),
		}
	}
	// This flag originates only from Manager desired state, not Agent discovery.
	// Observed status cannot enable printing to a software destination alone.
	if p.PrinterType == "virtual" && p.ConnectionType == "spooler" &&
		p.Config["virtual_spooler_test"] == true {
		if capabilities == nil {
			capabilities = make(map[string]interface{})
		}
		capabilities["virtual_spooler_test"] = true
	}
	// Observed capabilities must not override configured paper geometry.
	// Conversely, a nominal 80mm roll does not establish 576 printable dots:
	// 180dpi devices can have 512. Apply only explicitly configured hardware
	// dot width/DPI, independent of discovered or inferred protocols.
	if dots := desiredNumberValue(p.Config, "max_paper_width"); dots >= 288 && dots <= 576 {
		if capabilities == nil {
			capabilities = make(map[string]interface{})
		}
		capabilities["max_paper_width"] = dots
	}
	if dpi := desiredNumberValue(p.Config, "print_dpi"); dpi == 180 || dpi == 203 {
		if capabilities == nil {
			capabilities = make(map[string]interface{})
		}
		capabilities["print_dpi"] = dpi
	}
	return config.PrinterConfig{
		ID:             p.ID,
		Name:           p.Name,
		Type:           p.ConnectionType,
		Endpoint:       desiredEndpoint(p.Config, p.ConnectionType),
		Protocol:       p.Protocol,
		SpoolerName:    desiredStringValue(p.Config, "spooler_name"),
		ConnectionType: p.ConnectionType,
		PrinterType:    p.PrinterType,
		USBVID:         desiredUSBIdentity(p.Config, "vid"),
		USBPID:         desiredUSBIdentity(p.Config, "pid"),
		USBSerial:      desiredStringValue(p.Config, "serial"),
		Capabilities:   capabilities,
		PaperWidthMM:   desiredPaperWidthMM(p.Config),
		Enabled:        &enabled,
	}
}

func (a *Agent) removeGatewayRuntime(id string) {
	lock := a.getPrinterLock(id)
	lock.Lock()
	defer lock.Unlock()

	a.printersMu.Lock()
	a.retirePrinterLocked(id)
	a.printersMu.Unlock()
	a.deleteProbeState(id)
}

func (a *Agent) applyDesiredPrinter(row desiredPrinterRecord) error {
	a.markGatewayOwned(row.Desired.ID)
	if row.Desired.Lifecycle != "active" {
		a.removeGatewayRuntime(row.Desired.ID)
		return nil
	}

	if row.Desired.ConnectionType == "network" {
		if err := validateDesiredNetworkDestination(row.Desired.Config); err != nil {
			return fmt.Errorf("initialize printer %s at desired revision %d: %w", row.Desired.ID, row.Desired.DesiredRevision, err)
		}
	}
	pc := desiredPrinterConfig(row)
	lock := a.getPrinterLock(pc.ID)
	lock.Lock()
	defer lock.Unlock()
	a.printersMu.Lock()
	if a.retiredSessionMayBeLiveLocked(pc.ID) {
		a.printersMu.Unlock()
		return fmt.Errorf("defer printer %s desired revision %d: a retired print session may still own the transport", pc.ID, row.Desired.DesiredRevision)
	}
	_, initialized := a.printers[pc.ID]
	unchanged := initialized && reflect.DeepEqual(a.printerConfigs[pc.ID], pc)
	a.printersMu.Unlock()
	if unchanged {
		return nil
	}
	backend, err := printer.New(pc)
	if err != nil {
		return fmt.Errorf("initialize printer %s at desired revision %d: %w", pc.ID, row.Desired.DesiredRevision, err)
	}

	a.printersMu.Lock()
	if priorSessionMayBeLive(a.printers[pc.ID]) {
		// Same fence as addPrinter: a detached prior session may still own
		// the transport, and the new backend carries a fresh mutex/latch.
		// Fail the apply (recorded by the caller) so the reconciler retries
		// on a later sweep without advancing the applied revision.
		a.printersMu.Unlock()
		return fmt.Errorf("defer printer %s desired revision %d: a prior print session may still own the transport", pc.ID, row.Desired.DesiredRevision)
	}
	a.printers[pc.ID] = backend
	a.printerConfigs[pc.ID] = pc
	a.printersMu.Unlock()
	return nil
}

func (a *Agent) reconcileGatewayDesiredState(rows []desiredPrinterWire) bool {
	incoming := make(map[string]desiredPrinterWire, len(rows))
	for _, desired := range rows {
		if desired.ID == "" || desired.DesiredRevision < 0 {
			continue
		}
		current, ok := incoming[desired.ID]
		if !ok || desired.DesiredRevision > current.DesiredRevision {
			incoming[desired.ID] = desired
		}
	}

	var missing []string

	for id, desired := range incoming {
		a.desiredStateMu.Lock()
		current, exists := a.desiredStates[id]
		if exists && desired.DesiredRevision < current.Desired.DesiredRevision {
			a.desiredStateMu.Unlock()
			continue
		}
		if exists && desired.DesiredRevision == current.Desired.DesiredRevision && !reflect.DeepEqual(desired, current.Desired) {
			a.desiredStateMu.Unlock()
			log.Printf("[desired-state] rejecting conflicting snapshot for printer %s at revision %d", id, desired.DesiredRevision)
			if recordErr := a.recordDesiredError(id, fmt.Errorf("conflicting desired-state snapshot at revision %d", desired.DesiredRevision)); recordErr != nil {
				log.Printf("failed to persist desired-state conflict for %s: %v", id, recordErr)
			}
			continue
		}

		row := current
		row.Desired = desired
		row.ApplyError = ""
		a.desiredStates[id] = row
		a.desiredStateMu.Unlock()

		a.markGatewayOwned(id)

		a.printersMu.RLock()
		_, initialized := a.printers[id]
		runtimeUnchanged := initialized && reflect.DeepEqual(a.printerConfigs[id], desiredPrinterConfig(row))
		a.printersMu.RUnlock()
		if desired.Lifecycle == "active" &&
			runtimeUnchanged && exists &&
			current.AppliedDesiredRevision >= desired.DesiredRevision &&
			current.ApplyError == "" {
			continue
		}

		if err := a.applyDesiredPrinter(row); err != nil {
			if recordErr := a.recordDesiredError(id, err); recordErr != nil {
				log.Printf("failed to persist desired-state error for %s: %v", id, recordErr)
			}
			continue
		}

		a.desiredStateMu.Lock()
		applied := a.desiredStates[id]
		applied.AppliedDesiredRevision = desired.DesiredRevision
		// Applying a configuration is not proof that the physical device has
		// observed it. Heartbeat probing advances this independently.
		if desired.Lifecycle == "active" {
			applied.ObservedDesiredRevision = 0
		} else {
			applied.ObservedDesiredRevision = desired.DesiredRevision
		}
		applied.ApplyError = ""
		a.desiredStates[id] = applied
		a.desiredStateMu.Unlock()
	}

	a.desiredStateMu.Lock()
	for id := range a.desiredStates {
		if _, ok := incoming[id]; !ok {
			missing = append(missing, id)
		}
	}
	a.desiredStateMu.Unlock()

	if len(missing) > 0 {
		// Establish the in-memory deletion fences before removing cached desired
		// state. The fence blocks execution immediately. Durability is checked
		// below before any destructive local cleanup is allowed.
		a.printersMu.Lock()
		if a.gatewayTombstones == nil {
			a.gatewayTombstones = make(map[string]struct{})
		}
		for _, id := range missing {
			a.gatewayTombstones[id] = struct{}{}
			delete(a.gatewayOwned, id)
		}
		a.printersMu.Unlock()

		a.desiredStateMu.Lock()
		for _, id := range missing {
			delete(a.desiredStates, id)
		}
		a.desiredStateMu.Unlock()
	}

	// Persist first. Cleanup is intentionally retried on every subsequent
	// reconciliation while the tombstone remains, so a transient filesystem
	// failure cannot leave an inert runtime behind forever. A failed write
	// never triggers destructive cleanup in the same pass.
	if err := a.persistDesiredState(); err != nil {
		if len(missing) > 0 {
			log.Printf("ERROR: Gateway deletion fences are not durable; refusing local cleanup: %v", err)
		} else {
			log.Printf("WARNING: failed to persist Gateway desired state: %v", err)
		}
		return false
	}

	// Once the snapshot containing the tombstones is durable, remove any
	// remaining local runtime/registry entries for all tombstones. This also
	// handles a previous pass that failed after fencing but before cleanup.
	a.printersMu.RLock()
	tombstones := make([]string, 0, len(a.gatewayTombstones))
	for id := range a.gatewayTombstones {
		tombstones = append(tombstones, id)
	}
	a.printersMu.RUnlock()
	sort.Strings(tombstones)
	cleanedRuntime := false
	for _, id := range tombstones {
		if err := printer.RemoveFromRegistry(a.registryPath, id); err != nil {
			log.Printf("[desired-state] warning: failed to remove deleted Gateway printer %s from local registry: %v", id, err)
			continue
		}
		a.printersMu.RLock()
		_, runtimePresent := a.printerConfigs[id]
		a.printersMu.RUnlock()
		if runtimePresent {
			cleanedRuntime = true
		}
		a.removeGatewayRuntime(id)
	}
	if cleanedRuntime || len(tombstones) > 0 {
		a.reloadRegistryPrinters()
	}
	return true
}
