package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

const agentIPPUUID = "urn:uuid:11111111-2222-3333-4444-555555555555"
const agentIPPReplacementUUID = "urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

// The backend's actual HTTP identity matching is exercised in printer tests.
// This adapter exposes the persistence hook so the Agent's real disk writes,
// restart recovery and backend-generation fences can be exercised separately.
type identityPersistencePrinter struct {
	fakePrinter
	persist     func(string) error
	observeUUID string
}

func (p *identityPersistencePrinter) SetIdentityPersistence(fn func(string) error) { p.persist = fn }

func (p *identityPersistencePrinter) Status() string {
	if p.observeUUID != "" && p.persist != nil {
		if err := p.persist(p.observeUUID); err != nil {
			return "unknown"
		}
	}
	return "online"
}

func TestAgentIPPFirstIdentityKeepsCurrentHeartbeatObservation(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("heartbeat")
	backend := &identityPersistencePrinter{observeUUID: agentIPPUUID}
	if !a.addPrinter(pc.ID, backend, pc) {
		t.Fatal("registration failed")
	}
	entry := heartbeatEntry(t, a.printerStatusPayload(), pc.ID)
	if entry["status"] != "online" {
		t.Fatalf("a successfully persisted identity discarded its own current probe: %+v", entry)
	}
}

func TestAgentIPPHeartbeatUsesURLHostAndPort(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("url-host")
	if !a.addPrinter(pc.ID, &identityPersistencePrinter{}, pc) {
		t.Fatal("registration failed")
	}
	entry := heartbeatEntry(t, a.printerStatusPayload(), pc.ID)
	if entry["networkAddress"] != "192.168.1.20" || entry["port"] != 631 {
		t.Fatalf("IPP URI was projected as a host: %+v", entry)
	}
}

func TestAgentIPPIdentityDiskFailureDoesNotPublishPin(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("disk-failure")
	backend := &identityPersistencePrinter{}
	if !a.addPrinter(pc.ID, backend, pc) {
		t.Fatal("registration failed")
	}
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	validPath := a.registryPath
	a.registryPath = filepath.Join(file, "printers.json")
	if err := backend.persist(agentIPPUUID); err == nil {
		t.Fatal("failed durable write was treated as a bound printer")
	}
	if a.printerConfigs[pc.ID].Capabilities["ipp_printer_uuid"] != nil {
		t.Fatal("failed write published a supposedly durable identity")
	}
	a.registryPath = validPath
	if err := backend.persist(agentIPPUUID); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(validPath)
	if err != nil || len(rows) != 1 || rows[0].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
		t.Fatalf("safe persistence retry failed: %+v %v", rows, err)
	}
}

func agentIPPConfig(id string) config.PrinterConfig {
	return config.PrinterConfig{ID: id, Name: "Office printer", Type: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/ipp/print", PrinterType: "physical"}
}

func TestAgentIPPFirstObservationPersistsBeforePrintingAndSurvivesRestart(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("manual-printer")
	backend := &identityPersistencePrinter{}
	if !a.addPrinter(pc.ID, backend, pc) {
		t.Fatal("registration failed")
	}
	if backend.persist == nil {
		t.Fatal("published backend has no identity persistence fence")
	}
	if err := backend.persist(agentIPPUUID); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil || len(rows) != 1 || rows[0].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
		t.Fatalf("first verified identity not durable: rows=%+v error=%v", rows, err)
	}
	if a.printerConfigs[pc.ID].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
		t.Fatal("runtime facts lost the durable identity")
	}
	restarted := newDesiredStateTestAgent(t)
	if _, err := restarted.mergeDiscoveredPrinter(rows[0]); err != nil {
		t.Fatal(err)
	}
	if restarted.printerConfigs[pc.ID].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
		t.Fatal("restart did not carry identity into backend configuration")
	}
	if err := backend.persist(agentIPPReplacementUUID); err == nil {
		t.Fatal("persistence callback rebound the same ID to different physical hardware")
	}
}

func TestAgentIPPRetiredGenerationCannotPersistIdentity(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("generation")
	old := &identityPersistencePrinter{}
	a.addPrinter(pc.ID, old, pc)
	if old.persist == nil {
		t.Fatal("published backend has no persistence fence")
	}
	replacement := &identityPersistencePrinter{}
	updated := pc
	updated.Endpoint = "ipp://192.168.1.21/ipp/print"
	if !a.addPrinter(pc.ID, replacement, updated) {
		t.Fatal("explicit unbound endpoint update failed")
	}
	if err := old.persist(agentIPPUUID); err == nil {
		t.Fatal("late retired backend bound the replacement configuration")
	}
	if err := replacement.persist(agentIPPReplacementUUID); err != nil {
		t.Fatal(err)
	}
}

func TestAgentIPPRuntimeRediscoveryCannotReplaceVerifiedIdentity(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("pinned")
	pc.Capabilities = map[string]interface{}{"ipp_printer_uuid": agentIPPUUID}
	if !a.addPrinter(pc.ID, &identityPersistencePrinter{}, pc) {
		t.Fatal("registration failed")
	}
	incoming := printer.DeviceInfo{ID: pc.ID, Name: pc.Name, ConnectionType: "ipp", Protocol: "ipp", Endpoint: pc.Endpoint, PrinterType: "physical",
		Capabilities: map[string]interface{}{"ipp_printer_uuid": agentIPPReplacementUUID}}
	changed, err := a.mergeDiscoveredPrinter(incoming)
	if changed || a.printerConfigs[pc.ID].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
		t.Fatalf("runtime silently rebound pinned identity: changed=%v error=%v", changed, err)
	}
}

func TestAgentIPPUnpersistedDiscoveryUUIDBlocksIdentityAdmission(t *testing.T) {
	for _, dropErrorMarker := range []bool{false, true} {
		t.Run(fmt.Sprintf("error_marker_removed_%t", dropErrorMarker), func(t *testing.T) {
			a := newDesiredStateTestAgent(t)
			validPath := a.registryPath
			blocked := filepath.Join(t.TempDir(), "not-a-directory")
			if err := os.WriteFile(blocked, []byte("occupied"), 0600); err != nil {
				t.Fatal(err)
			}
			a.registryPath = filepath.Join(blocked, "printers.json")
			pc := agentIPPConfig("observed-but-not-persisted")
			observations := []printer.DeviceInfo{{
				ID: pc.ID, Name: pc.Name, Type: "ipp", ConnectionType: "ipp", Protocol: "ipp",
				Endpoint: pc.Endpoint, PrinterType: "physical", Enabled: true, Status: "online",
				Capabilities: map[string]interface{}{"ipp_printer_uuid": agentIPPUUID, "registration_source": "manual"},
			}}
			retained, err := a.persistDiscoveredPrinters(observations)
			if err == nil || len(retained) != 1 {
				t.Fatalf("expected retained discovery after disk failure: rows=%+v error=%v", retained, err)
			}
			if dropErrorMarker {
				// Absence of a diagnostic flag cannot prove that disk accepted
				// an observed UUID; weaker rediscovery can lose that flag.
				delete(retained[0].Capabilities, "registry_persistence_error")
			}
			if _, err := a.mergeDiscoveredPrinter(retained[0]); err != nil {
				t.Fatal(err)
			}
			store := a.printers[pc.ID].(interface{ PersistVerifiedIdentity(string) error })
			if err := store.PersistVerifiedIdentity(agentIPPUUID); err == nil {
				t.Fatal("unpersisted discovery UUID passed the first-print identity fence")
			}
			// A repaired disk can admit this same backend only after the
			// established UUID is actually present in durable inventory.
			a.registryPath = validPath
			if err := store.PersistVerifiedIdentity(agentIPPUUID); err != nil {
				t.Fatal(err)
			}
			rows, err := printer.LoadRegistryPrinters(validPath)
			if err != nil || len(rows) != 1 || rows[0].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
				t.Fatalf("identity admission was not durable after recovery: rows=%+v error=%v", rows, err)
			}
		})
	}
}

func TestAgentIPPConfiguredUUIDPersistsBeforeCachedSuccess(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	pc := agentIPPConfig("configured-identity")
	pc.Capabilities = map[string]interface{}{"ipp_printer_uuid": agentIPPUUID}
	backend := &identityPersistencePrinter{}
	if !a.addPrinter(pc.ID, backend, pc) {
		t.Fatal("registration failed")
	}
	if err := backend.persist(agentIPPUUID); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil || len(rows) != 1 || rows[0].Capabilities["ipp_printer_uuid"] != agentIPPUUID {
		t.Fatalf("configured UUID skipped its first durable registry boundary: rows=%+v error=%v", rows, err)
	}
	// Repeated concurrent observations of this exact backend are idempotent
	// after the successful write, without a full registry rewrite per probe.
	stamp := time.Unix(946684800, 0)
	if err := os.Chtimes(a.registryPath, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for range 8 {
		wait.Go(func() {
			if err := backend.persist(agentIPPUUID); err != nil {
				t.Errorf("idempotent observation rejected: %v", err)
			}
		})
	}
	wait.Wait()
	info, err := os.Stat(a.registryPath)
	if err != nil || !info.ModTime().Equal(stamp) {
		t.Fatalf("unchanged verified identity rewrote durable inventory: info=%v error=%v", info, err)
	}

	// A replaced backend has no right to reuse its predecessor's success
	// marker, and the old callback must still fail its generation check.
	replacement := &identityPersistencePrinter{}
	updated := pc
	updated.Name = "Renamed configured printer"
	if !a.addPrinter(pc.ID, replacement, updated) {
		t.Fatal("backend update failed")
	}
	if err := backend.persist(agentIPPUUID); err == nil {
		t.Fatal("cached identity bypassed the retired-generation fence")
	}
	if err := replacement.persist(agentIPPUUID); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(a.registryPath)
	if err != nil || info.ModTime().Equal(stamp) {
		t.Fatalf("replacement backend reused another generation's persistence marker: info=%v error=%v", info, err)
	}
}
