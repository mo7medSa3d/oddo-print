package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/printer"
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
	Desired                 desiredPrinterWire `json:"desired"`
	AppliedDesiredRevision  int64              `json:"appliedDesiredRevision"`
	ObservedDesiredRevision int64              `json:"observedDesiredRevision"`
	ApplyError              string             `json:"applyError,omitempty"`
}

type desiredStateDisk struct {
	Printers                 []desiredPrinterRecord `json:"printers"`
	DeletedGatewayPrinterIds []string               `json:"deletedGatewayPrinterIds,omitempty"`
}

func desiredStatePath(configPath string) string {
	dir := filepath.Dir(configPath)
	if configPath == "" || dir == "." {
		if exe, err := os.Executable(); err == nil {
			dir = filepath.Dir(exe)
		}
	}
	return filepath.Join(dir, "desired-state.json")
}

func (a *Agent) loadDesiredState() error {
	raw, err := os.ReadFile(a.desiredStatePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
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
				_ = a.recordDesiredError(row.Desired.ID, err)
			} else {
				row.AppliedDesiredRevision = row.Desired.DesiredRevision
				row.ObservedDesiredRevision = row.Desired.DesiredRevision
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

	dir := filepath.Dir(a.desiredStatePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
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
	a.desiredStateMu.Lock()
	row, managed := a.desiredStates[id]
	synced := a.desiredStateSynced
	a.desiredStateMu.Unlock()
	if !managed {
		return true
	}
	return synced &&
		row.ApplyError == "" &&
		row.Desired.Lifecycle == "active" &&
		row.AppliedDesiredRevision >= row.Desired.DesiredRevision &&
		row.ObservedDesiredRevision >= row.Desired.DesiredRevision
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

func desiredNumberValue(m map[string]interface{}, key string) int {
	v, err := strconv.Atoi(desiredStringValue(m, key))
	if err != nil || v < 0 {
		return 0
	}
	return v
}

func desiredEndpoint(c map[string]interface{}, connectionType string) string {
	if value := desiredStringValue(c, "address"); value != "" {
		return value
	}
	if value := desiredStringValue(c, "spooler_name"); value != "" && connectionType == "spooler" {
		return value
	}
	if ip := desiredStringValue(c, "ip"); ip != "" {
		port := desiredNumberValue(c, "port")
		if port > 0 {
			return net.JoinHostPort(strings.Trim(ip, "[]"), strconv.Itoa(port))
		}
		return ip
	}
	return ""
}

func desiredPrinterConfig(p desiredPrinterWire) config.PrinterConfig {
	enabled := p.Lifecycle == "active"
	return config.PrinterConfig{
		ID:             p.ID,
		Name:           p.Name,
		Type:           p.ConnectionType,
		Endpoint:       desiredEndpoint(p.Config, p.ConnectionType),
		Protocol:       p.Protocol,
		SpoolerName:    desiredStringValue(p.Config, "spooler_name"),
		ConnectionType: p.ConnectionType,
		PrinterType:    p.PrinterType,
		USBVID:         desiredStringValue(p.Config, "vid"),
		USBPID:         desiredStringValue(p.Config, "pid"),
		USBSerial:      desiredStringValue(p.Config, "serial"),
		Enabled:        &enabled,
	}
}

func (a *Agent) removeGatewayRuntime(id string) {
	a.printersMu.Lock()
	delete(a.printers, id)
	delete(a.printerConfigs, id)
	a.printersMu.Unlock()
}

func (a *Agent) applyDesiredPrinter(row desiredPrinterRecord) error {
	a.markGatewayOwned(row.Desired.ID)
	if row.Desired.Lifecycle != "active" {
		a.removeGatewayRuntime(row.Desired.ID)
		return nil
	}

	pc := desiredPrinterConfig(row.Desired)
	backend, err := printer.New(pc)
	if err != nil {
		return fmt.Errorf("initialize printer %s at desired revision %d: %w", pc.ID, row.Desired.DesiredRevision, err)
	}

	a.printersMu.Lock()
	a.printers[pc.ID] = backend
	a.printerConfigs[pc.ID] = pc
	a.printersMu.Unlock()
	return nil
}

func (a *Agent) reconcileGatewayDesiredState(rows []desiredPrinterWire) {
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
			continue
		}

		row := current
		row.Desired = desired
		row.ApplyError = ""
		a.desiredStates[id] = row
		a.desiredStateMu.Unlock()

		a.markGatewayOwned(id)

		if desired.Lifecycle == "active" &&
			exists &&
			current.AppliedDesiredRevision >= desired.DesiredRevision &&
			current.ObservedDesiredRevision >= desired.DesiredRevision &&
			current.ApplyError == "" {
			continue
		}

		if err := a.applyDesiredPrinter(row); err != nil {
			_ = a.recordDesiredError(id, err)
			continue
		}

		a.desiredStateMu.Lock()
		applied := a.desiredStates[id]
		applied.AppliedDesiredRevision = desired.DesiredRevision
		applied.ObservedDesiredRevision = desired.DesiredRevision
		applied.ApplyError = ""
		a.desiredStates[id] = applied
		a.desiredStateMu.Unlock()
	}

	a.desiredStateMu.Lock()
	for id := range a.desiredStates {
		if _, ok := incoming[id]; !ok {
			delete(a.desiredStates, id)
			missing = append(missing, id)
		}
	}
	a.desiredStateMu.Unlock()

	for _, id := range missing {
		// Persist a durable deletion fence BEFORE attempting local registry
		// cleanup. A transient filesystem failure, process restart, or stale
		// printers.json must not turn a Gateway deletion into a new Agent-owned
		// printer.
		a.printersMu.Lock()
		if a.gatewayTombstones == nil {
			a.gatewayTombstones = make(map[string]struct{})
		}
		a.gatewayTombstones[id] = struct{}{}
		delete(a.gatewayOwned, id)
		a.printersMu.Unlock()

		// Remove only the deleted Gateway-owned record. Keeping an old entry in
		// printers.json would otherwise let the next registry reload recreate it.
		if err := printer.RemoveFromRegistry(a.registryPath, id); err != nil {
			log.Printf("[desired-state] warning: failed to remove deleted Gateway printer %s from local registry: %v", id, err)
		}
		a.removeGatewayRuntime(id)
	}

	if len(missing) > 0 {
		a.reloadRegistryPrinters()
	}
	if err := a.persistDesiredState(); err != nil {
		log.Printf("WARNING: failed to persist Gateway desired state: %v", err)
	}
}
