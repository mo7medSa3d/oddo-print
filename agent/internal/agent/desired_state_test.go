package agent

import (
	"path/filepath"
	"testing"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/printer"
	"github.com/yasser-agent/agent/internal/queue"
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
		cfg: &config.Config{},
		configPath: filepath.Join(dir, "config.yaml"),
		registryPath: filepath.Join(dir, "printers.json"),
		printers: make(map[string]printer.Printer),
		printerConfigs: make(map[string]config.PrinterConfig),
		registryOwned: make(map[string]struct{}),
		gatewayOwned: make(map[string]struct{}),
		desiredStates: make(map[string]desiredPrinterRecord),
		desiredStatePath: filepath.Join(dir, "desired-state.json"),
		queue: q,
	}
}

func testDesiredPrinter(id string, revision int64, lifecycle string) desiredPrinterWire {
	return desiredPrinterWire{
		ID: id,
		Name: "Receipt " + id,
		PrinterType: "physical",
		DeviceClass: "thermal",
		ConnectionType: "network",
		Protocol: "raw",
		Lifecycle: lifecycle,
		Config: map[string]interface{}{"ip": "192.0.2.10", "port": 9100},
		DesiredRevision: revision,
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
	if row.AppliedDesiredRevision != 1 || row.ObservedDesiredRevision != 1 {
		t.Fatalf("expected revision 1 to converge, got applied=%d observed=%d", row.AppliedDesiredRevision, row.ObservedDesiredRevision)
	}
	if _, ok := a.printerConfigs["printer-1"]; !ok {
		t.Fatal("expected active desired printer in runtime registry")
	}
	if !a.isPrinterExecutionAllowed("printer-1") {
		t.Fatal("expected converged active printer to be executable")
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
	if a.isGatewayOwned("printer-2") {
		t.Fatal("removed desired printer remained Gateway-owned")
	}
}

func TestDesiredStateDeletionRemovesLocalRegistryEntry(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	p := testDesiredPrinter("printer-delete", 2, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{p})

	local := printer.DeviceInfo{
		ID: p.ID,
		Name: p.Name,
		PrinterType: "thermal",
		ConnectionType: "network",
		Protocol: "raw",
		Endpoint: "192.0.2.10:9100",
		Status: "online",
		Enabled: true,
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
		ID: "printer-stale",
		Name: "Stale Gateway printer",
		PrinterType: "thermal",
		ConnectionType: "network",
		Protocol: "raw",
		Endpoint: "192.0.2.30:9100",
		Status: "online",
		Enabled: true,
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
	if row.AppliedDesiredRevision != 7 || row.ObservedDesiredRevision != 7 {
		t.Fatalf("restart recovery lost convergence, got applied=%d observed=%d", row.AppliedDesiredRevision, row.ObservedDesiredRevision)
	}
	if _, ok := b.printerConfigs["printer-3"]; !ok {
		t.Fatal("restart recovery did not restore runtime printer")
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
