package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func prepareSharingTestAgent(t *testing.T, backend printer.Printer) (*Agent, config.PrinterConfig) {
	t.Helper()
	ag := newTestAgent(t, "local", backend)
	pc := config.PrinterConfig{ID: "local", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "192.168.10.10:9100", PrinterType: "thermal"}
	ag.cfg.Printers = []config.PrinterConfig{pc}
	ag.printerConfigs[pc.ID] = pc
	if err := ag.cfg.Save(ag.configPath); err != nil {
		t.Fatal(err)
	}
	return ag, pc
}

func TestAgentSharingFreshPolicyFencesIDsBindingsAndCorruption(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	alias := local
	alias.ID = "cloud-alias"
	other := local
	other.ID = "different"
	other.Endpoint = "192.168.10.11:9100"
	ag.printerConfigs[alias.ID], ag.printerConfigs[other.ID] = alias, other
	if !ag.isPrinterSharedWithGateway(local.ID) {
		t.Fatal("absent policy changed legacy behavior")
	}
	if err := config.SetPrinterSharing(ag.configPath, local, []config.PrinterConfig{local}, false); err != nil {
		t.Fatal(err)
	}
	if ag.isPrinterSharedWithGateway(local.ID) || ag.isPrinterSharedWithGateway(alias.ID) {
		t.Fatal("private destination admitted by ID/alias")
	}
	if !ag.isPrinterSharedWithGateway(other.ID) {
		t.Fatal("unrelated endpoint denied")
	}
	if err := config.SetPrinterSharing(ag.configPath, local, []config.PrinterConfig{local}, true); err != nil {
		t.Fatal(err)
	}
	if !ag.isPrinterSharedWithGateway(local.ID) || !ag.isPrinterSharedWithGateway(alias.ID) {
		t.Fatal("fresh reshare not observed")
	}
	if err := os.WriteFile(config.PrinterSharingPath(ag.configPath), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if ag.isPrinterSharedWithGateway(local.ID) || ag.isPrinterSharedWithGateway(other.ID) {
		t.Fatal("unreadable local policy defaulted shared")
	}
	snapshot := ag.loadLocalPrinterSharing()
	if rows := ag.printerStatusPayloadWithSharing(snapshot); len(rows) != 0 {
		t.Fatalf("corrupt policy exposed metadata: %+v", rows)
	}
	ids, complete := ag.privatePrinterIDs(snapshot)
	if complete || len(ids) != 3 {
		t.Fatalf("corrupt policy asserted complete snapshot: %+v %v", ids, complete)
	}
}

func TestAgentSharingFollowsFreshRegistryRenameAndKeepsDifferentNativeQueue(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	local.Type, local.Protocol, local.SpoolerName, local.Endpoint = "spooler", "spooler", "POS80 Printer", "POS80 Printer"
	// Use registry authority for this stable ID, independently of YAML.
	ag.cfg.Printers = nil
	if err := ag.cfg.Save(ag.configPath); err != nil {
		t.Fatal(err)
	}
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	renamed := printer.DeviceInfo{ID: local.ID, Name: "Receipt alias", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Renamed native POS80", Endpoint: "Renamed native POS80", PrinterType: "thermal", Enabled: true}
	separateNative := renamed
	separateNative.ID, separateNative.Name, separateNative.SpoolerName, separateNative.Endpoint = "separate", "Independent receipt queue", "Separate native POS80", "Separate native POS80"
	data, err := json.Marshal([]printer.DeviceInfo{renamed, separateNative})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ag.registryPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	alias := printer.SharingConfigForDevice(renamed)
	alias.ID = "new-gateway-id"
	other := alias
	other.ID, other.SpoolerName, other.Endpoint = "separate", "Separate native POS80", "Separate native POS80"
	alias.USBSerial, other.USBSerial = "same physical hardware", "same physical hardware"
	ag.printerConfigs[alias.ID], ag.printerConfigs[other.ID] = alias, other
	if ag.isPrinterSharedWithGateway(alias.ID) {
		t.Fatal("renamed stable ID bypassed by new Gateway ID")
	}
	if !ag.isPrinterSharedWithGateway(other.ID) {
		t.Fatal("different named native queue merged by hardware serial")
	}
}

func TestAgentSharingUnknownCloudNativeDestinationNeedsFreshLocalAcceptance(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	cloud := config.PrinterConfig{ID: "cloud-native", Name: "Remote receipt", Type: "spooler", Protocol: "spooler", SpoolerName: `\\host.example.test\NativeShare`, Endpoint: `\\host.example.test\NativeShare`, PrinterType: "thermal"}
	ag.printerConfigs[cloud.ID] = cloud
	ag.printers[cloud.ID] = &fakePrinter{}
	if !ag.isPrinterSharedWithGateway(cloud.ID) {
		t.Fatal("absent local opt-out changed legacy cloud-only native setup")
	}
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	// A constructed runtime backend/desired row is cloud execution intent,
	// never independent local permission, even if OpenPrinter would succeed.
	ag.desiredStates[cloud.ID] = desiredPrinterRecord{Desired: testDesiredPrinter(cloud.ID, 1, "active")}
	if ag.isPrinterSharedWithGateway(cloud.ID) {
		t.Fatal("cloud/runtime state authorized unobserved native destination during local privacy")
	}
	ids, complete := ag.privatePrinterIDs(ag.loadLocalPrinterSharing())
	if !complete || !strings.Contains(strings.Join(ids, ","), cloud.ID) {
		t.Fatalf("unaccepted native destination not withheld: %v complete=%v", ids, complete)
	}
	// Existing explicit local YAML remote setup remains operator-owned. Its
	// stale candidate metadata cannot remove that independent local intent.
	cloud.Capabilities = map[string]interface{}{"verification": "candidate_only"}
	ag.cfg.Printers = append(ag.cfg.Printers, cloud)
	if err := ag.cfg.Save(ag.configPath); err != nil {
		t.Fatal(err)
	}
	if !ag.isPrinterSharedWithGateway(cloud.ID) {
		t.Fatal("fresh explicit local remote registration not accepted")
	}
	if cloud.Capabilities["registration_source"] != nil {
		t.Fatal("local permission projection mutated caller capabilities")
	}
	// Withdraw the local setup, then remove the last opt-out. A valid empty
	// policy retains the previous supported cloud-only setup behavior.
	ag.cfg.Printers = []config.PrinterConfig{local}
	if err := ag.cfg.Save(ag.configPath); err != nil {
		t.Fatal(err)
	}
	if ag.isPrinterSharedWithGateway(cloud.ID) {
		t.Fatal("withdrawn local setup remained cached authority")
	}
	if err := config.SetPrinterSharing(ag.configPath, local, nil, true); err != nil {
		t.Fatal(err)
	}
	if !ag.isPrinterSharedWithGateway(cloud.ID) {
		t.Fatal("empty opt-out policy changed legacy native setup")
	}
}

func TestCloudDiscoverySharingUsesFreshNativeShareGroupsBeforeRegistryPersistence(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	private := printer.DeviceInfo{ID: "native-stable", Name: "Private receipt", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Old POS80", Endpoint: "Old POS80", SpoolerShare: "NativeShare", Capabilities: map[string]interface{}{"discovered_via": printer.SourceSpooler, "spooler_attributes": uint32(8)}}
	bindings, err := printer.SharingBindingsForDevice(private)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SetPrinterSharing(ag.configPath, bindings[0], bindings, false); err != nil {
		t.Fatal(err)
	}
	private.ID, private.SpoolerName, private.Endpoint = "rediscovered", "Renamed POS80", "Renamed POS80"
	separate := printer.DeviceInfo{ID: "separate", Name: "Independent queue", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Other POS80", Endpoint: "Other POS80", Capabilities: map[string]interface{}{"discovered_via": printer.SourceSpooler}}
	candidate := printer.DeviceInfo{ID: "candidate", Name: "Setup session", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Session POS80", Endpoint: "Session POS80", Capabilities: map[string]interface{}{"verification": "candidate_only"}}
	result := printer.DiscoveryResult{Printers: []printer.DeviceInfo{private, separate, candidate}}
	devices, sourceErrors := ag.cloudDiscoveryPayload(result)
	if len(sourceErrors) != 0 || len(devices) != 2 || devices[0]["stableId"] != separate.ID || devices[1]["stableId"] != candidate.ID {
		t.Fatalf("fresh local native group privacy projection: %+v %+v", devices, sourceErrors)
	}
	if ag.isPrinterSharedWithGateway(separate.ID) {
		t.Fatal("cloud scan projection itself installed local execution permission")
	}
	if _, err := os.Stat(ag.registryPath); !os.IsNotExist(err) {
		t.Fatalf("cloud privacy projection persisted local registry: %v", err)
	}
	private.SpoolerShare = `bad\share`
	result.Printers = []printer.DeviceInfo{separate, private}
	devices, sourceErrors = ag.cloudDiscoveryPayload(result)
	if len(devices) != 0 || len(sourceErrors) != 1 || strings.Contains(sourceErrors[0], "POS80") {
		t.Fatalf("malformed native group leaked partial metadata: %+v %+v", devices, sourceErrors)
	}
	if local.ID != "local" || result.Printers[1].SpoolerShare != `bad\share` {
		t.Fatal("privacy projection modified local source evidence")
	}
}

func TestAgentSharingPrivateInventoryIncludesRuntimeDesiredAndScopedAliases(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{status: "offline"})
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	alias := local
	alias.ID = "cloud-alias"
	other := local
	other.ID, other.Endpoint = "other", "192.168.10.11:9100"
	ag.printerConfigs[alias.ID], ag.printerConfigs[other.ID] = alias, other
	ag.printers[alias.ID], ag.printers[other.ID] = &fakePrinter{}, &fakePrinter{}
	ag.gatewayOwned["local~aaaaaaaa"] = struct{}{}
	ag.desiredStates["desired-alias"] = desiredPrinterRecord{Desired: testDesiredPrinter("desired-alias", 1, "active")}
	row := ag.desiredStates["desired-alias"]
	row.Desired.Config["ip"] = "192.168.10.10"
	ag.desiredStates["desired-alias"] = row
	snapshot := ag.loadLocalPrinterSharing()
	ids, complete := ag.privatePrinterIDs(snapshot)
	if !complete || strings.Join(ids, ",") != "cloud-alias,desired-alias,local,local~aaaaaaaa" {
		t.Fatalf("private alias IDs lost: %v complete=%v", ids, complete)
	}
	rows := ag.printerStatusPayloadWithSharing(snapshot)
	if len(rows) != 1 || rows[0]["id"] != "other" || rows[0]["sharedWithGateway"] != true {
		t.Fatalf("private metadata leaked or explicit shared field lost: %+v", rows)
	}
	// The runtime backend still exists for local status/diagnostics.
	if p, exists := ag.getPrinter("local"); !exists || p.Status() != "offline" {
		t.Fatal("unshare removed/forced health on local backend")
	}
}

func TestAgentSharingInvalidPrivateIDsCannotRejectWholeHeartbeat(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	invalid := local
	invalid.ID = strings.Repeat("x", 121)
	ag.printerConfigs[invalid.ID] = invalid
	ids, complete := ag.privatePrinterIDs(ag.loadLocalPrinterSharing())
	if complete || strings.Join(ids, ",") != "local" {
		t.Fatalf("overlong local ID made transport-invalid inventory: %v complete=%v", ids, complete)
	}
	for _, id := range []string{"", "bad\nID", strings.Repeat("😀", 61), " trailing "} {
		if validGatewaySharingID(id) {
			t.Fatalf("invalid published ID accepted: %q", id)
		}
	}
	if !validGatewaySharingID(strings.Repeat("😀", 60)) {
		t.Fatal("valid120 UTF-16 unit ID rejected")
	}
}

func TestCloudDiscoverySharingOmitsPrivateIdentityAndBindingWithoutChangingLocalScan(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	local.Type, local.Protocol, local.SpoolerName, local.Endpoint = "spooler", "spooler", "POS80 Private", "POS80 Private"
	ag.cfg.Printers = []config.PrinterConfig{local}
	if err := ag.cfg.Save(ag.configPath); err != nil {
		t.Fatal(err)
	}
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	private := printer.DeviceInfo{ID: local.ID, Name: "Private local name", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: local.SpoolerName, Endpoint: local.Endpoint}
	alias := private
	alias.ID = "new-cloud-id"
	alias.Protocol = "unknown"
	separate := private
	separate.Name = "Other local name"
	separate.ID, separate.SpoolerName, separate.Endpoint = "separate", "Other POS80", "Other POS80"
	separate.USBSerial, private.USBSerial = "same hardware", "same hardware"
	candidate := printer.DeviceInfo{ID: "unrelated-candidate", Name: "Unknown candidate", ConnectionType: "network", Protocol: "unknown", Endpoint: "192.168.10.99:9100", Capabilities: map[string]interface{}{"verification": "candidate_only"}}
	result := printer.DiscoveryResult{Printers: []printer.DeviceInfo{private, alias, separate, candidate}, Errors: []string{"POS80 Private native probe error"}}
	devices, sourceErrors := ag.cloudDiscoveryPayload(result)
	if len(devices) != 2 || devices[0]["stableId"] != "separate" || devices[1]["stableId"] != "unrelated-candidate" {
		t.Fatalf("discovery sharing leaked/removed wrong queues: %+v", devices)
	}
	encoded, err := json.Marshal(struct {
		Devices []map[string]interface{}
		Errors  []string
	}{devices, sourceErrors})
	if err != nil || strings.Contains(string(encoded), "POS80 Private") || strings.Contains(string(encoded), "Private local name") {
		t.Fatalf("private error/metadata leaked: %s %v", encoded, err)
	}
	if len(result.Printers) != 4 || result.Errors[0] != "POS80 Private native probe error" {
		t.Fatal("cloud privacy projection discarded local discovery evidence")
	}
	if err := os.WriteFile(config.PrinterSharingPath(ag.configPath), []byte("invalid policy containing private name"), 0600); err != nil {
		t.Fatal(err)
	}
	devices, sourceErrors = ag.cloudDiscoveryPayload(result)
	if len(devices) != 0 || len(sourceErrors) != 1 || strings.Contains(sourceErrors[0], "Private") {
		t.Fatalf("unreadable policy leaked scan: %+v %+v", devices, sourceErrors)
	}
}

func TestCloudDiscoverySharingInvalidCurrentDeniedBindingFailsClosed(t *testing.T) {
	ag, local := prepareSharingTestAgent(t, &fakePrinter{})
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	broken := local
	broken.Endpoint = ""
	ag.cfg.Printers = []config.PrinterConfig{broken}
	if err := ag.cfg.Save(ag.configPath); err != nil {
		t.Fatal(err)
	}
	result := printer.DiscoveryResult{Printers: []printer.DeviceInfo{{ID: "alias", Name: "Private address", ConnectionType: "network", Protocol: "raw", Endpoint: local.Endpoint}, {ID: "other", Name: "Setup observation", ConnectionType: "network", Protocol: "unknown"}}}
	snapshot := ag.loadLocalPrinterSharing()
	if snapshot.err == nil || ag.isPrinterSharedWithGateway(local.ID) {
		t.Fatal("invalid fresh denied binding did not fail physical admission closed")
	}
	devices, sourceErrors := ag.cloudDiscoveryPayload(result)
	if len(devices) != 0 || len(sourceErrors) != 1 || strings.Contains(sourceErrors[0], "Private address") {
		t.Fatalf("resolution failure leaked aliases: %+v %+v", devices, sourceErrors)
	}
}

func TestAgentSharingRejectsClaimBeforePrintingAndAllowsStoredResultReplay(t *testing.T) {
	p := &fakePrinter{}
	ag, local := prepareSharingTestAgent(t, p)
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	ag.processJob(context.Background(), dispatchTestJob("private-job", "local~aaaaaaaa"))
	if p.Calls() != 0 {
		t.Fatal("unshared alias reached printer")
	}
	_, status, found, err := ag.queue.Get("private-job")
	if err != nil || !found || status == "printing" || status == "success" || ag.queue.WasOutcomeUnknown("private-job") {
		t.Fatalf("zero-byte rejection became physical attempt: %q found=%v %v", status, found, err)
	}
	if err := ag.queue.BeginPrint("already-completed", "local", []byte("receipt"), "claim-already-completed", false); err != nil {
		t.Fatal(err)
	}
	if err := ag.queue.UpdateTerminalWithEvidence("already-completed", "success", "", "native-id"); err != nil {
		t.Fatal(err)
	}
	ag.processJob(context.Background(), dispatchTestJob("already-completed", "local"))
	if p.Calls() != 0 || !ag.queue.IsProcessed("already-completed") {
		t.Fatal("unshare changed success or replayed printer I/O")
	}
}

func TestAgentSharingUnshareAfterInitialClaimACKRefusesActualTCPBytes(t *testing.T) {
	for _, unshareACK := range []int32{1, 2} {
		t.Run(fmt.Sprintf("unshare-during-ACK-%d", unshareACK), func(t *testing.T) {
			t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			bytesRead := make(chan int, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					bytesRead <- -1
					return
				}
				defer conn.Close()
				_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				data, _ := io.ReadAll(conn)
				bytesRead <- len(data)
			}()
			var ag *Agent
			var agentRef atomic.Pointer[Agent]
			local := config.PrinterConfig{ID: "local", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "192.168.10.10:9100", PrinterType: "thermal"}
			var printingACKs atomic.Int32
			var policyError atomic.Pointer[error]
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]interface{}
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					http.Error(w, "invalid", 400)
					return
				}
				if body["status"] == "printing" && printingACKs.Add(1) == unshareACK {
					if err := config.SetPrinterSharing(agentRef.Load().configPath, local, nil, false); err != nil {
						policyError.Store(&err)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
			}))
			defer srv.Close()
			cfg := &config.Config{Printers: []config.PrinterConfig{local}}
			cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", srv.URL
			path := filepath.Join(t.TempDir(), "agent.yaml")
			if err := cfg.Save(path); err != nil {
				t.Fatal(err)
			}
			ag, err = New(cfg, path)
			if err != nil {
				t.Fatal(err)
			}
			defer ag.Close()
			agentRef.Store(ag)
			// Actual transport uses a local test server; config still declares the
			// selected private printer destination for the independent policy check.
			ag.printers = map[string]printer.Printer{"local": &printer.NetworkPrinter{Address: listener.Addr().String(), Protocol: "raw"}}
			ag.printerConfigs = map[string]config.PrinterConfig{"local": local}
			ag.processJob(context.Background(), dispatchTestJob("late-unshare", "local"))
			if err := policyError.Load(); err != nil {
				t.Fatal(*err)
			}
			select {
			case count := <-bytesRead:
				if count != 0 {
					t.Fatalf("late-unshared job transmitted %d physical bytes", count)
				}
			case <-time.After(6 * time.Second):
				t.Fatal("actual TCP boundary was not reached/closed")
			}
			if printingACKs.Load() != unshareACK || ag.queue.WasOutcomeUnknown("late-unshare") {
				t.Fatalf("late refusal changed zero-byte evidence/ACK fence: acks=%d", printingACKs.Load())
			}
		})
	}
}

func TestDesiredStateCannotOverrideLocallyDisabledIDOrBinding(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	disabled := false
	local := config.PrinterConfig{ID: "local", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "192.168.2.10:9100", Enabled: &disabled}
	a.cfg.Printers = []config.PrinterConfig{local}
	a.desiredStateSynced = true
	for _, id := range []string{"local", "new-cloud-alias"} {
		row := desiredPrinterRecord{Desired: testDesiredPrinter(id, 1, "active")}
		if err := a.applyDesiredPrinter(row); err == nil {
			t.Fatalf("cloud active overrode local disabled %s", id)
		}
		pc := desiredPrinterConfig(row)
		a.printerConfigs[id], a.printers[id] = pc, &fakePrinter{}
		if a.isPrinterExecutionAllowed(id) {
			t.Fatalf("disabled binding admitted under %s", id)
		}
	}
	row := desiredPrinterRecord{Desired: testDesiredPrinter("unrelated", 1, "active")}
	row.Desired.Config["ip"] = "192.168.2.11"
	if err := a.applyDesiredPrinter(row); err != nil {
		t.Fatalf("unrelated physical endpoint denied: %v", err)
	}
}

func TestAgentSharingAdmittedJobFinishesWhileMutexWaiterIsReturned(t *testing.T) {
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	p := &fakePrinter{blocked: release, startedCh: make(chan string, 1)}
	ag, local := prepareSharingTestAgent(t, p)
	ag.dispatchJob(context.Background(), dispatchTestJob("already-admitted", "local"))
	select {
	case <-p.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("initial physical attempt never admitted")
	}
	ag.dispatchJob(context.Background(), dispatchTestJob("waiting-private", "local~aaaaaaaa"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, status, found, err := ag.queue.Get("waiting-private")
		if err != nil {
			t.Fatal(err)
		}
		if found {
			if status != "queued" {
				t.Fatalf("mutex waiter prematurely admitted: %s", status)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("mutex waiter was not durably reserved")
		}
		time.Sleep(time.Millisecond)
	}
	if err := config.SetPrinterSharing(ag.configPath, local, nil, false); err != nil {
		t.Fatal(err)
	}
	close(release)
	released = true
	if !ag.waitForJobsFor(5 * time.Second) {
		t.Fatal("admitted job/waiter did not drain")
	}
	if p.Calls() != 1 || !ag.queue.IsProcessed("already-admitted") || ag.queue.WasOutcomeUnknown("waiting-private") {
		t.Fatalf("unshare cancelled admitted work or printed waiter: calls=%d", p.Calls())
	}
	if ag.queue.ClaimTokenFor("already-admitted") != "" || ag.queue.ClaimTokenFor("waiting-private") != "" {
		t.Fatal("exact result/queued ACK did not clear local tokens")
	}
}

func TestAgentSharingDurablePredispatchReturnRetainsPrivateReasonAndToken(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	var allowACK atomic.Bool
	var validRequests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["jobId"] != "private-outbox" || body["claimToken"] != "claim-private-outbox" || body["status"] != "queued" || body["reason"] != "printer_not_shared" {
			http.Error(w, "lost exact private refusal fence", http.StatusBadRequest)
			return
		}
		validRequests.Add(1)
		if !allowACK.Load() {
			http.Error(w, "temporary outage", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": "queued"})
	}))
	defer srv.Close()
	local := config.PrinterConfig{ID: "local", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "192.168.10.10:9100"}
	cfg := &config.Config{Printers: []config.PrinterConfig{local}}
	cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", srv.URL
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := cfg.Save(path); err != nil {
		t.Fatal(err)
	}
	ag, err := New(cfg, path)
	if err != nil {
		t.Fatal(err)
	}
	defer ag.Close()
	p := &fakePrinter{}
	ag.printers, ag.printerConfigs = map[string]printer.Printer{"local": p}, map[string]config.PrinterConfig{"local": local}
	if err := config.SetPrinterSharing(path, local, nil, false); err != nil {
		t.Fatal(err)
	}
	ag.processJob(context.Background(), dispatchTestJob("private-outbox", "local"))
	if ag.queue.ClaimTokenFor("private-outbox") != "claim-private-outbox" || validRequests.Load() == 0 {
		t.Fatal("failed private return lost durable original claim")
	}
	allowACK.Store(true)
	ag.reportPendingPreDispatchReturns(context.Background())
	if validRequests.Load() < 2 || ag.queue.ClaimTokenFor("private-outbox") != "" || p.Calls() != 0 {
		t.Fatalf("durable private hand-back mutated physical attempt/token: requests=%d calls=%d", validRequests.Load(), p.Calls())
	}
}

func TestHeartbeatPrivateIDsExpandPagesWithoutExposingMetadata(t *testing.T) {
	private := make([]string, 1201)
	for i := range private {
		private[i] = fmt.Sprintf("private-%04d", i)
	}
	keepAlive := []map[string]string{{"jobId": "already-inflight", "claimToken": "original-token"}}
	pages := buildHeartbeatPayloadPages(nil, nil, nil, private, keepAlive, true)
	if len(pages) != 3 {
		t.Fatalf("private-only fleet truncated pages: %d", len(pages))
	}
	seen := make(map[string]bool)
	for i, page := range pages {
		ids := page["privatePrinterIds"].([]string)
		if len(ids) > 500 || page["heartbeatPage"] != i+1 || page["heartbeatPageCount"] != 3 || page["inventoryComplete"] != true {
			t.Fatalf("invalid private page: %+v", page)
		}
		if len(page["printers"].([]map[string]interface{})) != 0 || len(page["gatewayOwnedPrinterIds"].([]string)) != 0 {
			t.Fatal("private page leaked metadata/ownership bypass")
		}
		if page["keepAliveJobIds"].([]map[string]string)[0]["claimToken"] != "original-token" {
			t.Fatal("unshare changed in-flight claim")
		}
		for _, id := range ids {
			if seen[id] {
				t.Fatal("duplicate private page ID")
			}
			seen[id] = true
		}
	}
	if len(seen) != len(private) {
		t.Fatalf("private IDs lost: %d", len(seen))
	}
}

func TestHeartbeatSharingWholeEnvelopeFitsGatewayWithEscapedAcceptedFields(t *testing.T) {
	printers := make([]map[string]interface{}, 500)
	owned, private := make([]string, 500), make([]string, 500)
	acks := make([]map[string]interface{}, 500)
	for i := range printers {
		id := strings.Repeat("<", 114) + fmt.Sprintf("%06d", i)
		owned[i], private[i] = id, strings.Repeat(">", 114)+fmt.Sprintf("%06d", i)
		printers[i] = map[string]interface{}{"id": id, "name": strings.Repeat("<", 100), "printerType": "physical", "deviceClass": "thermal", "connectionType": "network", "protocol": "raw", "status": "offline", "sharedWithGateway": true, "config": map[string]interface{}{"ip": "192.168.10.10", "port": 9100}}
		acks[i] = map[string]interface{}{"printerId": id, "appliedDesiredRevision": int64(9007199254740991), "observedDesiredRevision": int64(9007199254740991)}
	}
	// Individually accepted16KiB config/32KiB capability JSON may expand
	// almost6x under Go escaping; it must survive an auxiliary-page deferral.
	printers[0]["config"] = map[string]interface{}{"ip": "192.168.10.10", "port": 9100, "note": strings.Repeat("<", 16000)}
	printers[0]["capabilities"] = map[string]interface{}{"note": strings.Repeat("&", 32000)}
	keepAlive := make([]map[string]string, 64)
	for i := range keepAlive {
		keepAlive[i] = map[string]string{"jobId": strings.Repeat("<", 114) + fmt.Sprintf("%06d", i), "claimToken": strings.Repeat("&", 120)}
	}
	pages := buildHeartbeatPayloadPages(printers, acks, owned, private, keepAlive, true)
	seenPrinters, seenACKs, seenPrivate, seenOwned := make(map[string]bool), make(map[string]bool), make(map[string]bool), make(map[string]bool)
	for i, page := range pages {
		page["desiredStatePaging"] = true // actual caller's last envelope field
		encoded, err := json.Marshal(page)
		if err != nil || len(encoded) > 512*1024 {
			t.Fatalf("whole accepted heartbeat page %d exceeds Gateway: bytes=%d %v", i+1, len(encoded), err)
		}
		if page["heartbeatPage"] != i+1 || page["heartbeatPageCount"] != len(pages) || !page["inventoryComplete"].(bool) {
			t.Fatal("envelope splitting lost snapshot framing")
		}
		p := page["printers"].([]map[string]interface{})
		a := page["desiredStateAcks"].([]map[string]interface{})
		o := page["gatewayOwnedPrinterIds"].([]string)
		if len(p) > 500 || len(a) > 500 || len(o) > 500 {
			t.Fatal("byte split exceeded500-item contract")
		}
		for _, row := range p {
			id := row["id"].(string)
			if seenPrinters[id] {
				t.Fatal("duplicate printer row")
			}
			seenPrinters[id] = true
			if id == owned[0] && row["capabilities"].(map[string]interface{})["note"] != strings.Repeat("&", 32000) {
				t.Fatal("large capability metadata truncated")
			}
		}
		for _, row := range a {
			id := row["printerId"].(string)
			if seenACKs[id] {
				t.Fatal("duplicate ACK")
			}
			seenACKs[id] = true
		}
		for _, id := range o {
			if seenOwned[id] {
				t.Fatal("duplicate ownership ID")
			}
			seenOwned[id] = true
		}
		if ids, exists := page["privatePrinterIds"]; exists {
			for _, id := range ids.([]string) {
				if seenPrivate[id] {
					t.Fatal("duplicate private ID")
				}
				seenPrivate[id] = true
			}
		}
		if len(page["keepAliveJobIds"].([]map[string]string)) != 64 {
			t.Fatal("live claims truncated to fit metadata")
		}
	}
	if len(seenPrinters) != 500 || len(seenACKs) != 500 || len(seenPrivate) != 500 || len(seenOwned) != 500 {
		t.Fatalf("envelope budget lost data: printers%d ACKs%d private%d owned%d", len(seenPrinters), len(seenACKs), len(seenPrivate), len(seenOwned))
	}
}
