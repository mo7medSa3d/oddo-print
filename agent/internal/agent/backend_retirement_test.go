package agent

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// retirementWorker models only the non-cancellable native boundary. The real
// desired-state, registry and backend-installation functions remain under test.
type retirementWorker struct {
	live    atomic.Bool
	release chan struct{}
	done    chan struct{}
	once    sync.Once
}

func (p *retirementWorker) Print(ctx context.Context, _ []byte) error {
	p.live.Store(true)
	go func() {
		defer close(p.done)
		defer p.live.Store(false)
		<-p.release
	}()
	<-ctx.Done()
	return printer.MarkUnknown("test native worker still owns transport after cancellation")
}
func (p *retirementWorker) Test(context.Context) error { return nil }
func (p *retirementWorker) Status() string             { return "online" }
func (p *retirementWorker) SessionMayBeLive() bool     { return p.live.Load() }
func (p *retirementWorker) finish() {
	p.once.Do(func() { close(p.release) })
	<-p.done
}

func startRetirementWorker(t *testing.T) *retirementWorker {
	t.Helper()
	p := &retirementWorker{release: make(chan struct{}), done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.Print(ctx, []byte("payload")); !printer.OutcomeUnknown(err) {
		t.Fatalf("boundary must return an uncertain outcome, got %v", err)
	}
	t.Cleanup(p.finish)
	if !p.SessionMayBeLive() {
		t.Fatal("native boundary must outlive its caller")
	}
	return p
}

func installRetirementFixture(t *testing.T) (*Agent, desiredPrinterWire, *retirementWorker) {
	t.Helper()
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	row := testDesiredPrinter("retirement-printer", 1, "active")
	if !a.reconcileGatewayDesiredState([]desiredPrinterWire{row}) {
		t.Fatal("initial desired state failed")
	}
	p := startRetirementWorker(t)
	a.printers[row.ID] = p
	return a, row, p
}

func assertRetiredNotExecutable(t *testing.T, a *Agent, id string) {
	t.Helper()
	if _, ok := a.getPrinter(id); ok {
		t.Fatal("retired backend remained executable inventory")
	}
	if _, ok := a.printerConfigs[id]; ok {
		t.Fatal("retired configuration remained advertised inventory")
	}
}

func TestRetirementDisableReenableWaitsForActualWorkerExit(t *testing.T) {
	a, row, worker := installRetirementFixture(t)
	for revision := int64(2); revision <= 6; revision += 2 {
		row.Lifecycle, row.DesiredRevision = "disabled", revision
		if !a.reconcileGatewayDesiredState([]desiredPrinterWire{row}) {
			t.Fatal("disable failed")
		}
		assertRetiredNotExecutable(t, a, row.ID)
		if a.isPrinterExecutionAllowed(row.ID) {
			t.Fatal("disabled printer admits new jobs")
		}
		if a.retiredPrinters[row.ID] != printer.Printer(worker) {
			t.Fatal("exact live generation was discarded")
		}

		row.Lifecycle, row.DesiredRevision = "active", revision+1
		if !a.reconcileGatewayDesiredState([]desiredPrinterWire{row}) {
			t.Fatal("fenced state must still persist")
		}
		assertRetiredNotExecutable(t, a, row.ID)
		pending := a.desiredStates[row.ID]
		if pending.ApplyError == "" || pending.AppliedDesiredRevision != revision {
			t.Fatalf("re-enable advanced past live retirement: %+v", pending)
		}
		if a.isPrinterExecutionAllowed(row.ID) {
			t.Fatal("re-enable admitted work before native completion")
		}
	}
	worker.finish()
	if !a.reconcileGatewayDesiredState([]desiredPrinterWire{row}) {
		t.Fatal("drained revision failed to apply")
	}
	backend, ok := a.getPrinter(row.ID)
	if !ok || backend == printer.Printer(worker) {
		t.Fatal("drained generation did not get a fresh backend")
	}
	if _, exists := a.retiredPrinters[row.ID]; exists {
		t.Fatal("drained backend reference leaked")
	}
	applied := a.desiredStates[row.ID]
	if applied.ApplyError != "" || applied.AppliedDesiredRevision != row.DesiredRevision || applied.ObservedDesiredRevision != 0 {
		t.Fatalf("new generation bypassed normal desired/observed handshake: %+v", applied)
	}
	if a.isPrinterExecutionAllowed(row.ID) {
		t.Fatal("unobserved new generation admits work")
	}
}

func TestRetirementDesiredDeletionAndRecreationRetainFence(t *testing.T) {
	a, row, worker := installRetirementFixture(t)
	for i := 0; i < 2; i++ {
		if !a.reconcileGatewayDesiredState(nil) {
			t.Fatal("deletion failed")
		}
		assertRetiredNotExecutable(t, a, row.ID)
		if !a.isGatewayOwned(row.ID) || a.isPrinterExecutionAllowed(row.ID) {
			t.Fatal("deletion tombstone was not effective")
		}
	}
	if !a.reconcileGatewayDesiredState([]desiredPrinterWire{row}) {
		t.Fatal("recreation failed to persist")
	}
	assertRetiredNotExecutable(t, a, row.ID)
	if a.desiredStates[row.ID].ApplyError == "" {
		t.Fatal("recreation replaced a live removed generation")
	}
	worker.finish()
	if !a.reconcileGatewayDesiredState([]desiredPrinterWire{row}) {
		t.Fatal("drained recreation failed")
	}
	if _, ok := a.getPrinter(row.ID); !ok {
		t.Fatal("drained recreation remained stuck")
	}
}

func TestRetirementRegistryRemovalAndRediscoveryRetainFence(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.desiredStateSynced = true
	worker := startRetirementWorker(t)
	di := printer.DeviceInfo{ID: "registry-live", Name: "Registry", ConnectionType: "network", Protocol: "raw", Endpoint: "192.168.2.10:9100", Enabled: true}
	a.printers[di.ID] = worker
	a.printerConfigs[di.ID] = printerConfigFromDeviceInfo(di)
	a.registryOwned[di.ID] = struct{}{}
	a.reconcileRegistryPrinters(nil)
	assertRetiredNotExecutable(t, a, di.ID)
	if a.retiredPrinters[di.ID] != printer.Printer(worker) {
		t.Fatal("registry removal lost the live generation")
	}
	for i := 0; i < 3; i++ {
		a.reconcileRegistryPrinters([]printer.DeviceInfo{di})
		assertRetiredNotExecutable(t, a, di.ID)
	}
	// A stuck printer must not globally fence unrelated devices.
	other := printer.DeviceInfo{ID: "other", Name: "Other", ConnectionType: "network", Protocol: "raw", Endpoint: "192.168.2.11:9100", Enabled: true}
	a.reconcileRegistryPrinters([]printer.DeviceInfo{di, other})
	if _, ok := a.getPrinter(other.ID); !ok {
		t.Fatal("retired printer blocked unrelated device")
	}
	worker.finish()
	a.reconcileRegistryPrinters([]printer.DeviceInfo{di, other})
	if _, ok := a.getPrinter(di.ID); !ok {
		t.Fatal("rediscovery did not recover after native exit")
	}
	if len(a.retiredPrinters) != 0 {
		t.Fatal("drained generation reference leaked")
	}
}

func TestRetirementReapsWithoutReenable(t *testing.T) {
	a, row, worker := installRetirementFixture(t)
	row.Lifecycle, row.DesiredRevision = "disabled", 2
	a.reconcileGatewayDesiredState([]desiredPrinterWire{row})
	worker.finish()
	a.reconcileRegistryPrinters(nil)
	if len(a.retiredPrinters) != 0 {
		t.Fatal("periodic registry reconciliation retained completed worker")
	}
	assertRetiredNotExecutable(t, a, row.ID)
}

func TestRetirementConcurrentRegistrationCannotDropFence(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	worker := startRetirementWorker(t)
	pc := config.PrinterConfig{ID: "race", Name: "Race", Type: "network", Endpoint: "192.168.2.10:9100", Protocol: "raw"}
	a.printers[pc.ID], a.printerConfigs[pc.ID] = worker, pc
	a.removeGatewayRuntime(pc.ID)
	stop := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				a.getPrinter(pc.ID)
				a.printersMu.Lock()
				a.reapRetiredPrintersLocked()
				a.printersMu.Unlock()
			}
		}()
	}
	for i := 0; i < 25; i++ {
		if a.addPrinter(pc.ID, worker, pc) {
			t.Error("registration bypassed live retirement")
		}
		a.removeGatewayRuntime(pc.ID)
	}
	close(stop)
	readers.Wait()
	assertRetiredNotExecutable(t, a, pc.ID)
	worker.finish()
	if !a.addPrinter(pc.ID, &retirementWorker{}, pc) {
		t.Fatal("drained retirement did not permit registration")
	}
}

func TestRetirementRemovalWaitsForSynchronousDispatchLock(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	id := "sync-worker"
	a.printers[id] = &retirementWorker{}
	a.printerConfigs[id] = config.PrinterConfig{ID: id}
	lock := a.getPrinterLock(id)
	lock.Lock()
	finished := make(chan struct{})
	go func() { a.removeGatewayRuntime(id); close(finished) }()
	select {
	case <-finished:
		lock.Unlock()
		t.Fatal("removal bypassed synchronous physical-execution lock")
	case <-time.After(10 * time.Millisecond):
	}
	lock.Unlock()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("removal did not finish after dispatch drained")
	}
	assertRetiredNotExecutable(t, a, id)
	if len(a.retiredPrinters) != 0 {
		t.Fatal("idle backend unnecessarily retained")
	}
}
