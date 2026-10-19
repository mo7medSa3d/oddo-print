package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/queue"
)

func newDesiredStateTestAgent(t *testing.T) *Agent {
	t.Helper()
	dir := t.TempDir()
	q, err := queue.New(filepath.Join(dir, "queue.db"))
	if err != nil {
		t.Fatalf("queue.New: %v", err)
	}
	t.Cleanup(func() { _ = q.Close() })

	return &Agent{
		cfg:               &config.Config{},
		configPath:        filepath.Join(dir, "config.yaml"),
		registryPath:      filepath.Join(dir, "printers.json"),
		printers:          make(map[string]printer.Printer),
		printerConfigs:    make(map[string]config.PrinterConfig),
		registryOwned:     make(map[string]struct{}),
		gatewayOwned:      make(map[string]struct{}),
		gatewayTombstones: make(map[string]struct{}),
		desiredStates:     make(map[string]desiredPrinterRecord),
		desiredStatePath:  filepath.Join(dir, "desired-state.json"),
		queue:             q,
	}
}

func testDesiredPrinter(id string, revision int64, lifecycle string) desiredPrinterWire {
	return desiredPrinterWire{
		ID:              id,
		Name:            "Receipt " + id,
		PrinterType:     "physical",
		DeviceClass:     "thermal",
		ConnectionType:  "network",
		Protocol:        "raw",
		Lifecycle:       lifecycle,
		Config:          map[string]interface{}{"ip": "192.168.2.10", "port": 9100},
		DesiredRevision: revision,
	}
}

func TestDesiredStatePassesExplicit80mmPaperWidthSeparatelyFromObservedCapabilities(t *testing.T) {
	row := desiredPrinterRecord{Desired: testDesiredPrinter("paper-80", 1, "active")}
	row.Desired.Config["paper_widths"] = []interface{}{80.0}
	row.ObservedSupportedProtocolsKnown = true
	row.ObservedSupportedProtocols = []string{"escpos"}
	cfg := desiredPrinterConfig(row)
	if cfg.PaperWidthMM != 80 {
		t.Fatalf("desired paper width = %d, want 80", cfg.PaperWidthMM)
	}
	if _, mixed := cfg.Capabilities["paper_widths"]; mixed {
		t.Fatal("desired paper width must not be mixed into observed capabilities")
	}
	backend, err := printer.New(cfg)
	if err != nil {
		t.Fatalf("create backend: %v", err)
	}
	network, ok := backend.(*printer.NetworkPrinter)
	if !ok || network.RasterMaxWidth != 512 {
		t.Fatalf("80mm roll without verified DPI must use safe 512 dots, not assume 576: %#v", backend)
	}
	// The manager can provide a device's measured 203dpi printable width;
	// observed protocols must not discard this explicit print geometry.
	row.Desired.Config["print_dpi"] = 203
	row.Desired.Config["max_paper_width"] = 576
	cfg = desiredPrinterConfig(row)
	if cfg.Capabilities["max_paper_width"] != 576 || cfg.Capabilities["print_dpi"] != 203 {
		t.Fatalf("configured 203dpi/576-dot profile was lost: %#v", cfg.Capabilities)
	}
	backend, err = printer.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	network, ok = backend.(*printer.NetworkPrinter)
	if !ok || network.RasterMaxWidth != 576 {
		t.Fatalf("explicit 203dpi/576-dot width must reach actual transport: %#v", backend)
	}
}

func TestDesiredStateRejectsConflictingAndPublicNetworkDestinations(t *testing.T) {
	for name, cfg := range map[string]map[string]interface{}{
		"conflicting address": {"ip": "192.168.2.10", "port": 9100, "address": "8.8.8.8:9100"},
		"public ip":           {"ip": "8.8.8.8", "port": 9100},
	} {
		t.Run(name, func(t *testing.T) {
			a := newDesiredStateTestAgent(t)
			row := desiredPrinterRecord{Desired: testDesiredPrinter("unsafe", 1, "active")}
			row.Desired.Config = cfg
			if err := a.applyDesiredPrinter(row); err == nil {
				t.Fatal("expected destination to be rejected before backend creation")
			}
		})
	}
}

func TestDesiredStateReconciliationConvergesAndRejectsStale(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true

	first := testDesiredPrinter("printer-1", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{first})

	row, ok := a.desiredStates["printer-1"]
	if !ok {
		t.Fatal("expected desired printer after reconciliation")
	}
	if row.AppliedDesiredRevision != 1 || row.ObservedDesiredRevision != 0 {
		t.Fatalf("expected revision 1 to be applied but not physically observed, got applied=%d observed=%d", row.AppliedDesiredRevision, row.ObservedDesiredRevision)
	}
	if _, ok := a.printerConfigs["printer-1"]; !ok {
		t.Fatal("expected active desired printer in runtime registry")
	}
	if a.isPrinterExecutionAllowed("printer-1") {
		t.Fatal("active printer must remain fenced until a real status probe observes it")
	}
	a.observeDesiredRevision("printer-1", "unknown")
	if !a.isPrinterExecutionAllowed("printer-1") {
		t.Fatal("connected unidirectional network printer with unknown health should be executable")
	}

	updated := first
	updated.Name = "Receipt Updated"
	updated.DesiredRevision = 2
	a.reconcileGatewayDesiredState([]desiredPrinterWire{updated})
	if a.desiredStates["printer-1"].Desired.Name != "Receipt Updated" {
		t.Fatal("expected revision 2 desired state to replace revision 1")
	}

	stale := updated
	stale.Name = "Stale"
	stale.DesiredRevision = 1
	a.reconcileGatewayDesiredState([]desiredPrinterWire{stale})
	if a.desiredStates["printer-1"].Desired.Name != "Receipt Updated" {
		t.Fatal("stale revision overwrote newer desired state")
	}
	if a.desiredStates["printer-1"].Desired.DesiredRevision != 2 {
		t.Fatal("stale revision changed stored revision")
	}
}

func TestDesiredStateDisablesAndRemovesRuntime(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true

	active := testDesiredPrinter("printer-2", 4, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{active})
	if _, ok := a.printerConfigs["printer-2"]; !ok {
		t.Fatal("expected active printer")
	}

	disabled := active
	disabled.Lifecycle = "disabled"
	disabled.DesiredRevision = 5
	a.reconcileGatewayDesiredState([]desiredPrinterWire{disabled})
	if _, ok := a.printerConfigs["printer-2"]; ok {
		t.Fatal("disabled printer remained in runtime registry")
	}
	row := a.desiredStates["printer-2"]
	if row.AppliedDesiredRevision != 5 || row.ObservedDesiredRevision != 5 {
		t.Fatalf("disable should converge revision 5, got applied=%d observed=%d", row.AppliedDesiredRevision, row.ObservedDesiredRevision)
	}
	if a.isPrinterExecutionAllowed("printer-2") {
		t.Fatal("disabled printer must not be executable")
	}

	a.reconcileGatewayDesiredState(nil)
	if _, ok := a.desiredStates["printer-2"]; ok {
		t.Fatal("missing desired snapshot did not delete cached state")
	}
	if _, ok := a.gatewayOwned["printer-2"]; ok {
		t.Fatal("removed desired printer retained live Gateway ownership")
	}
	if !a.isGatewayOwned("printer-2") {
		t.Fatal("removed desired printer lost its durable Gateway deletion fence")
	}
}

func TestDesiredStateDeletionRemovesLocalRegistryEntry(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-delete", 2, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})

	local := printer.DeviceInfo{
		ID:             p.ID,
		Name:           p.Name,
		PrinterType:    "thermal",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       "192.168.2.10:9100",
		Status:         "online",
		Enabled:        true,
	}
	if _, err := printer.RegisterManual(a.registryPath, local); err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}

	a.reconcileGatewayDesiredState(nil)

	infos, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil {
		t.Fatalf("LoadRegistryPrinters: %v", err)
	}
	for _, info := range infos {
		if info.ID == p.ID {
			t.Fatalf("deleted Gateway printer was resurrected in local registry")
		}
	}
}

func TestGatewayOwnedPrinterIsNotReintroducedFromStaleRegistry(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.markGatewayOwned("printer-stale")

	local := printer.DeviceInfo{
		ID:             "printer-stale",
		Name:           "Stale Gateway printer",
		PrinterType:    "thermal",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       "192.168.2.30:9100",
		Status:         "online",
		Enabled:        true,
	}
	if _, err := printer.RegisterManual(a.registryPath, local); err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}

	a.reloadRegistryPrinters()

	if _, ok := a.printerConfigs["printer-stale"]; ok {
		t.Fatal("Gateway-owned printer was reintroduced from stale local registry")
	}
	if _, ok := a.printers["printer-stale"]; ok {
		t.Fatal("Gateway-owned printer was reintroduced into runtime registry")
	}
}

func TestDesiredStateDeletionTombstoneSurvivesRestart(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-tombstone", 2, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})
	a.reconcileGatewayDesiredState(nil)

	if !a.isGatewayOwned(p.ID) {
		t.Fatal("deleted Gateway printer must remain fenced by a tombstone")
	}

	// Simulate a stale registry entry reappearing after local cleanup failed.
	local := printer.DeviceInfo{
		ID:             p.ID,
		Name:           p.Name,
		PrinterType:    "thermal",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       "192.168.2.40:9100",
		Status:         "online",
		Enabled:        true,
	}
	if _, err := printer.RegisterManual(a.registryPath, local); err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}

	b := newDesiredStateTestAgent(t)
	b.desiredStatePath = a.desiredStatePath
	b.registryPath = a.registryPath
	if err := b.loadDesiredState(); err != nil {
		t.Fatalf("loadDesiredState: %v", err)
	}
	b.reloadRegistryPrinters()

	if _, ok := b.printerConfigs[p.ID]; ok {
		t.Fatal("persisted Gateway deletion tombstone was ignored after restart")
	}
	if !b.isGatewayOwned(p.ID) {
		t.Fatal("restart lost persisted Gateway printer deletion fence")
	}
}

func TestDesiredStateRestartRecovery(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-3", 7, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})

	b := newDesiredStateTestAgent(t)
	b.desiredStatePath = a.desiredStatePath
	if err := b.loadDesiredState(); err != nil {
		t.Fatalf("loadDesiredState: %v", err)
	}
	row, ok := b.desiredStates["printer-3"]
	if !ok {
		t.Fatal("expected persisted desired state")
	}
	if row.AppliedDesiredRevision != 7 || row.ObservedDesiredRevision != 0 {
		t.Fatalf("restart recovery must require a fresh physical observation, got applied=%d observed=%d", row.AppliedDesiredRevision, row.ObservedDesiredRevision)
	}
	if _, ok := b.printerConfigs["printer-3"]; !ok {
		t.Fatal("restart recovery did not restore runtime printer")
	}
}

func TestNonYAMLLocalPrinterRemainsFencedBeforeDesiredStateSync(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	device := productionNetworkDevice("printer-pre-sync", "192.168.2.50:9100")
	if _, err := printer.RegisterManual(a.registryPath, device); err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}
	a.reloadRegistryPrinters()

	if _, ok := a.printerConfigs[device.ID]; !ok {
		t.Fatal("expected registry printer to load into runtime")
	}
	if a.isPrinterExecutionAllowed(device.ID) {
		t.Fatal("non-YAML local printer must remain fenced until the first successful Gateway desired-state sync")
	}

	a.desiredStateMu.Lock()
	a.desiredStateSynced = true
	a.desiredStateMu.Unlock()
	if !a.isPrinterExecutionAllowed(device.ID) {
		t.Fatal("unmanaged local printer should be executable again after desired-state sync")
	}
}

func TestYAMLOwnedPrinterRemainsAvailableBeforeDesiredStateSync(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	const id = "yaml-local"
	a.cfg.Printers = []config.PrinterConfig{{
		ID: id, Name: "YAML Local", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw",
	}}
	a.printerConfigs[id] = a.cfg.Printers[0]
	a.printers[id] = &fakePrinter{status: "online"}

	if !a.isPrinterExecutionAllowed(id) {
		t.Fatal("explicit YAML-owned printer must retain local startup behavior before Gateway desired-state sync")
	}
}

func TestDesiredStateSameRevisionConflictIsRejected(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-4", 3, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})

	conflict := p
	conflict.Name = "Conflicting Same Revision"
	a.reconcileGatewayDesiredState([]desiredPrinterWire{conflict})
	if a.desiredStates["printer-4"].Desired.Name != p.Name {
		t.Fatal("same-revision conflicting desired state was accepted")
	}
}

func TestTombstonedPrinterRemainsExecutionFenced(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-fenced", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})
	a.observeDesiredRevision(p.ID, "online")
	if !a.isPrinterExecutionAllowed(p.ID) {
		t.Fatal("expected printer to be executable before deletion")
	}

	a.printersMu.Lock()
	a.gatewayTombstones[p.ID] = struct{}{}
	a.printersMu.Unlock()
	a.desiredStateMu.Lock()
	delete(a.desiredStates, p.ID)
	a.desiredStateMu.Unlock()

	if a.isPrinterExecutionAllowed(p.ID) {
		t.Fatal("tombstoned printer must remain fenced after desired-state cache removal")
	}
}

func TestDesiredStatePersistenceFailureKeepsDeletionFence(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-persist-fence", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})
	a.observeDesiredRevision(p.ID, "online")
	if !a.isPrinterExecutionAllowed(p.ID) {
		t.Fatal("expected printer to be executable before simulated persistence failure")
	}

	// A directory at the destination makes the atomic rename fail after the
	// deletion fence has been prepared, exercising the fail-closed path.
	a.desiredStatePath = filepath.Join(t.TempDir(), "desired-state-target")
	if err := os.MkdirAll(a.desiredStatePath, 0700); err != nil {
		t.Fatalf("mkdir persistence target: %v", err)
	}
	a.reconcileGatewayDesiredState(nil)

	if a.isPrinterExecutionAllowed(p.ID) {
		t.Fatal("printer must remain execution-fenced when tombstone persistence fails")
	}
	if _, ok := a.gatewayOwned[p.ID]; ok {
		t.Fatal("Gateway ownership must be removed in memory after deletion")
	}
	if _, ok := a.gatewayTombstones[p.ID]; !ok {
		t.Fatal("in-memory tombstone must survive persistence failure")
	}
	if _, ok := a.printerConfigs[p.ID]; !ok {
		t.Fatal("runtime cleanup must wait until the deletion fence is durable")
	}

	// A later successful reconciliation must retry and complete the pending
	// local cleanup without requiring a process restart.
	a.desiredStatePath = filepath.Join(t.TempDir(), "desired-state.json")
	a.reconcileGatewayDesiredState(nil)
	if _, ok := a.printerConfigs[p.ID]; ok {
		t.Fatal("pending tombstone cleanup did not remove the stale runtime")
	}
	if _, ok := a.printers[p.ID]; ok {
		t.Fatal("pending tombstone cleanup did not remove the stale backend")
	}
}

func TestDesiredStateLoaderRejectsOversizedFile(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	if err := os.WriteFile(a.desiredStatePath, make([]byte, maxDesiredStateBytes+1), 0600); err != nil {
		t.Fatalf("write oversized desired state: %v", err)
	}
	if err := a.loadDesiredState(); err == nil {
		t.Fatal("expected oversized desired-state file to be rejected")
	}
}

func TestDesiredStatePreservesObservedProtocolCapabilitiesAcrossRestart(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	row := desiredPrinterRecord{
		Desired:                         testDesiredPrinter("printer-capabilities", 3, "active"),
		AppliedDesiredRevision:          3,
		ObservedDesiredRevision:         3,
		ObservedSupportedProtocols:      []string{"escpos"},
		ObservedSupportedProtocolsKnown: true,
	}
	a.desiredStates[row.Desired.ID] = row
	if err := a.persistDesiredState(); err != nil {
		t.Fatalf("persistDesiredState: %v", err)
	}

	b := newDesiredStateTestAgent(t)
	b.desiredStatePath = a.desiredStatePath
	if err := b.loadDesiredState(); err != nil {
		t.Fatalf("loadDesiredState: %v", err)
	}
	pc, ok := b.printerConfigs[row.Desired.ID]
	if !ok {
		t.Fatal("expected persisted desired printer to be restored")
	}
	caps, ok := pc.Capabilities["supported_protocols"].([]string)
	if !ok {
		t.Fatalf("expected supported_protocols capability to be restored, got %#v", pc.Capabilities)
	}
	if len(caps) != 1 || caps[0] != "escpos" {
		t.Fatalf("expected observed capability list to survive restart, got %#v", caps)
	}
}

func TestDesiredStateUpdatePreservesObservedProtocolCapabilities(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-capability-update", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})

	a.desiredStateMu.Lock()
	row := a.desiredStates[p.ID]
	row.ObservedSupportedProtocols = []string{"escpos"}
	row.ObservedSupportedProtocolsKnown = true
	a.desiredStates[p.ID] = row
	a.desiredStateMu.Unlock()
	if err := a.applyDesiredPrinter(row); err != nil {
		t.Fatalf("applyDesiredPrinter: %v", err)
	}

	updated := p
	updated.Name = "Updated"
	updated.DesiredRevision = 2
	a.reconcileGatewayDesiredState([]desiredPrinterWire{updated})

	pc := a.printerConfigs[p.ID]
	caps, ok := pc.Capabilities["supported_protocols"].([]string)
	if !ok || len(caps) != 1 || caps[0] != "escpos" {
		t.Fatalf("desired-state update dropped observed capabilities, got %#v", pc.Capabilities)
	}
}

func TestPrinterStatusPayloadPersistsObservedCapabilities(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	const id = "printer-heartbeat-capabilities"
	desired := testDesiredPrinter(id, 1, "active")
	a.desiredStates[id] = desiredPrinterRecord{Desired: desired}
	a.printers[id] = &fakePrinter{status: "online"}
	a.printerConfigs[id] = config.PrinterConfig{
		ID: id, Name: "Receipt", Type: "network", Endpoint: "192.168.2.10:9100", Protocol: "raw",
		Capabilities: map[string]interface{}{"supported_protocols": []string{"zpl"}},
	}
	a.gatewayOwned[id] = struct{}{}

	_ = a.printerStatusPayload()

	row := a.desiredStates[id]
	if !row.ObservedSupportedProtocolsKnown {
		t.Fatal("heartbeat did not record observed supported_protocols")
	}
	if len(row.ObservedSupportedProtocols) != 1 || row.ObservedSupportedProtocols[0] != "zpl" {
		t.Fatalf("unexpected observed capabilities: %#v", row.ObservedSupportedProtocols)
	}

	b := newDesiredStateTestAgent(t)
	b.desiredStatePath = a.desiredStatePath
	if err := b.loadDesiredState(); err != nil {
		t.Fatalf("loadDesiredState: %v", err)
	}
	persisted := b.desiredStates[id]
	if !persisted.ObservedSupportedProtocolsKnown || len(persisted.ObservedSupportedProtocols) != 1 || persisted.ObservedSupportedProtocols[0] != "zpl" {
		t.Fatalf("heartbeat capability observation was not persisted: %#v", persisted)
	}
}

func TestUnobservedUnchangedDesiredStateRetainsBackend(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	desired := testDesiredPrinter("same-backend", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{desired})
	first, ok := a.getPrinter(desired.ID)
	if !ok {
		t.Fatal("initial backend not initialized")
	}
	if a.desiredStates[desired.ID].ObservedDesiredRevision != 0 {
		t.Fatal("configuration alone claimed observation")
	}
	a.reconcileGatewayDesiredState([]desiredPrinterWire{desired})
	second, ok := a.getPrinter(desired.ID)
	if !ok || first != second {
		t.Fatal("unobserved configuration replaced backend and its safety gates")
	}
	a.printersMu.Lock()
	delete(a.printers, desired.ID)
	a.printersMu.Unlock()
	a.reconcileGatewayDesiredState([]desiredPrinterWire{desired})
	if recovered, ok := a.getPrinter(desired.ID); !ok || recovered == nil {
		t.Fatal("missing backend was not recovered")
	}
}

func TestDesiredNumericUSBIdentifiersReachBackendAsCorrectNumbers(t *testing.T) {
	row := desiredPrinterRecord{Desired: desiredPrinterWire{ID: "usb-numeric", Name: "USB Printer", ConnectionType: "usb", Protocol: "raw", Lifecycle: "active", Config: map[string]interface{}{"vid": float64(1208), "pid": float64(514), "address": `\\?\usb#printer`}}}
	pc := desiredPrinterConfig(row)
	if pc.USBVID != "04b8" || pc.USBPID != "0202" {
		t.Fatalf("numeric identifiers misencoded: %+v", pc)
	}
	backend, err := printer.New(pc)
	if err != nil {
		t.Fatal(err)
	}
	usb, ok := backend.(*printer.USBPrinter)
	if !ok || usb.VID != 1208 || usb.PID != 514 {
		t.Fatalf("USB backend opened wrong identity: %+v", backend)
	}
	row.Desired.Config["vid"] = "04B8"
	if desiredPrinterConfig(row).USBVID != "04B8" {
		t.Fatal("legacy hexadecimal identity changed")
	}
}

func TestDesiredULAValidationMatchesGatewayPrivateNetworkPolicy(t *testing.T) {
	for _, host := range []string{"fd12:3456::10", "fc00::10"} {
		if err := validateDesiredNetworkDestination(map[string]interface{}{"ip": host, "port": 9100}); err != nil {
			t.Fatalf("private IPv6 printer rejected: %v", err)
		}
	}
	if err := validateDesiredNetworkDestination(map[string]interface{}{"ip": "fd00:0ec2:0000:0000:0000:0000:0000:0254", "port": 9100}); err == nil {
		t.Fatal("metadata endpoint accepted via alternate spelling")
	}
}

func TestDesiredSpoolerPassthroughIsExplicitAndAdditive(t *testing.T) {
	row := desiredPrinterRecord{Desired: desiredPrinterWire{
		ID: "spool-pass", Name: "Thermal queue", PrinterType: "physical", DeviceClass: "thermal",
		ConnectionType: "spooler", Protocol: "spooler", Lifecycle: "active",
		Config: map[string]interface{}{"spooler_name": "Thermal queue", "passthrough_protocols": []interface{}{"escpos"}},
	}}
	row.ObservedSupportedProtocolsKnown = true
	row.ObservedSupportedProtocols = []string{"raw"} // stale observed data must not override desired config.
	cfg := desiredPrinterConfig(row)
	got, ok := cfg.Capabilities["supported_protocols"].([]string)
	if !ok {
		t.Fatalf("supported_protocols type = %T, want []string", cfg.Capabilities["supported_protocols"])
	}
	seen := map[string]bool{}
	for _, value := range got {
		seen[value] = true
	}
	for _, want := range []string{"pdf", "image", "escpos"} {
		if !seen[want] {
			t.Fatalf("missing %s in %v", want, got)
		}
	}
	if seen["raw"] {
		t.Fatalf("stale RAW capability leaked into desired config: %v", got)
	}
}
