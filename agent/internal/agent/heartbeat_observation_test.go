package agent

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

type heartbeatEvidencePrinter struct {
	fakePrinter
	statusCalls atomic.Int32
	detailCalls atomic.Int32
	statusRead  func() string
	detailRead  func() string
}

func (p *heartbeatEvidencePrinter) Status() string {
	p.statusCalls.Add(1)
	if p.statusRead != nil {
		return p.statusRead()
	}
	return "online"
}

func (p *heartbeatEvidencePrinter) StatusDetail() string {
	p.detailCalls.Add(1)
	if p.detailRead != nil {
		return p.detailRead()
	}
	return ""
}

func heartbeatEvidenceAgent(backends map[string]printer.Printer) *Agent {
	a := &Agent{cfg: &config.Config{}, printers: backends, printerConfigs: make(map[string]config.PrinterConfig)}
	for id := range backends {
		a.printerConfigs[id] = config.PrinterConfig{
			ID: id, Name: "Physical receipt queue", Type: "network", Protocol: "raw", Endpoint: "10.0.0.20:9100",
			Capabilities: map[string]interface{}{"status_detail": "windows_offline", "dpi": 203},
		}
	}
	return a
}

func heartbeatEntry(t *testing.T, payload []map[string]interface{}, id string) map[string]interface{} {
	t.Helper()
	for _, entry := range payload {
		if entry["id"] == id {
			return entry
		}
	}
	t.Fatalf("heartbeat omitted %s", id)
	return nil
}

func assertCurrentHeartbeat(t *testing.T, entry map[string]interface{}, status, detail string) {
	t.Helper()
	if entry["status"] != status {
		t.Fatalf("status=%v want %s", entry["status"], status)
	}
	caps := entry["capabilities"].(map[string]interface{})
	if caps["dpi"] != 203 {
		t.Fatalf("current health projection discarded unrelated metadata: %#v", caps)
	}
	if detail == "" {
		if _, exists := caps["status_detail"]; exists {
			t.Fatalf("unobserved/carried reason became current heartbeat evidence: %#v", caps)
		}
	} else if caps["status_detail"] != detail {
		t.Fatalf("detail=%v want %s", caps["status_detail"], detail)
	}
}

func TestHeartbeatClearsCarriedDetailsWithoutMutatingConfig(t *testing.T) {
	for _, backend := range []printer.Printer{&fakePrinter{}, &heartbeatEvidencePrinter{}} {
		a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": backend})
		assertCurrentHeartbeat(t, heartbeatEntry(t, a.printerStatusPayload(), "p"), "online", "")
		if a.printerConfigs["p"].Capabilities["status_detail"] != "windows_offline" {
			t.Fatal("heartbeat mutated durable config metadata instead of projecting a current frame")
		}
	}
}

func TestHeartbeatRunningProbeDoesNotRefreshCachedHealthOrDetails(t *testing.T) {
	for _, cached := range []string{"online", "offline", "error", "busy"} {
		t.Run(cached, func(t *testing.T) {
			p := &heartbeatEvidencePrinter{statusRead: func() string { panic("a running probe must not be reentered") },
				detailRead: func() string { panic("an uncompleted read cannot publish a detail") }}
			a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": p})
			state := a.getProbeState("p")
			state.set(cached)
			state.running.Store(true)
			defer state.running.Store(false)
			assertCurrentHeartbeat(t, heartbeatEntry(t, a.printerStatusPayload(), "p"), "unknown", "")
			if !state.running.Load() || state.get() != cached || p.statusCalls.Load() != 0 || p.detailCalls.Load() != 0 {
				t.Fatal("pending projection broke single-flight ownership or diagnostic cache")
			}
		})
	}
}

func TestHeartbeatProbePanicIsUnknownWithoutAdvancingCachedEvidence(t *testing.T) {
	p := &heartbeatEvidencePrinter{statusRead: func() string { panic("failed status adapter") }}
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": p})
	a.setProbeLastStatus("p", "offline")
	assertCurrentHeartbeat(t, heartbeatEntry(t, a.printerStatusPayload(), "p"), "unknown", "")
	if a.probeLastStatus("p") != "offline" || p.detailCalls.Load() != 0 {
		t.Fatal("panic overwrote the last diagnostic observation or read an unverified detail")
	}
}

func TestHeartbeatEndpointOnlySpoolerAliasKeepsNativeClassification(t *testing.T) {
	for _, selected := range []struct {
		queue   string
		visible bool
	}{
		{"Microsoft Print to PDF", false}, {"Microsoft XPS Document Writer", false},
		{"HP LaserJet (redirected 3)", false}, {"Canon G4070", true},
	} {
		t.Run(selected.queue, func(t *testing.T) {
			p := &heartbeatEvidencePrinter{}
			a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": p})
			pc := a.printerConfigs["p"]
			pc.Name, pc.Type, pc.Protocol, pc.Endpoint = "Chosen office label", "spooler", "spooler", selected.queue
			a.printerConfigs["p"] = pc
			payload := a.printerStatusPayload()
			if selected.visible {
				assertCurrentHeartbeat(t, heartbeatEntry(t, payload, "p"), "online", "")
			} else if len(payload) != 0 || p.statusCalls.Load() != 0 {
				t.Fatalf("native software/session queue escaped behind its friendly alias: %#v", payload)
			}
		})
	}
}

func TestHeartbeatRejectedConfigProbeCannotPublishOldReason(t *testing.T) {
	var a *Agent
	p := &heartbeatEvidencePrinter{detailRead: func() string { return "windows_paper_out" }}
	p.statusRead = func() string {
		a.printersMu.Lock()
		changed := a.printerConfigs["p"]
		changed.Endpoint = "10.0.0.21:9100"
		a.printerConfigs["p"] = changed
		a.printersMu.Unlock()
		return "error"
	}
	a = heartbeatEvidenceAgent(map[string]printer.Printer{"p": p})
	assertCurrentHeartbeat(t, heartbeatEntry(t, a.printerStatusPayload(), "p"), "unknown", "")
	if p.detailCalls.Load() != 0 || a.probeLastStatus("p") != "unknown" {
		t.Fatal("an old-config result read details or poisoned current diagnostic cache")
	}
}

func TestHeartbeatDetailIsCapturedWithCompletedProbeBeforeOtherWorkersFinish(t *testing.T) {
	var currentDetail atomic.Value
	currentDetail.Store("windows_paper_out")
	detailRead, slowStarted, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	fast := &heartbeatEvidencePrinter{statusRead: func() string { return "error" }, detailRead: func() string {
		value := currentDetail.Load().(string)
		close(detailRead)
		return value
	}}
	slow := &heartbeatEvidencePrinter{statusRead: func() string { close(slowStarted); <-release; return "online" }}
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"fast": fast, "slow": slow})
	done := make(chan []map[string]interface{}, 1)
	go func() { done <- a.printerStatusPayload() }()
	for _, ready := range []chan struct{}{slowStarted, detailRead} {
		select {
		case <-ready:
		case <-time.After(5 * time.Second):
			unblock()
			t.Fatal("completed detail was not captured independently of the blocked worker")
		}
	}
	currentDetail.Store("windows_offline")
	unblock()
	select {
	case payload := <-done:
		assertCurrentHeartbeat(t, heartbeatEntry(t, payload, "fast"), "error", "windows_paper_out")
		if fast.detailCalls.Load() != 1 {
			t.Fatal("payload assembly reread changing backend detail outside the accepted snapshot")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("payload did not finish after blocked status was released")
	}
}

func TestHeartbeatRealBudgetReportsDeferredAndUnstartedProbesAsUnknown(t *testing.T) {
	const count = maxHeartbeatProbeConcurrency + 1
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	backends := make(map[string]printer.Printer, count)
	probes := make(map[string]*heartbeatEvidencePrinter, count)
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("probe-%03d", i)
		p := &heartbeatEvidencePrinter{statusRead: func() string { <-release; return "online" },
			detailRead: func() string { return "windows_power_save" }}
		backends[id], probes[id] = p, p
	}
	a := heartbeatEvidenceAgent(backends)
	for id := range backends {
		a.setProbeLastStatus(id, "online")
	}
	deferred := a.printerStatusPayload() // Exercise the unchanged production 10s bound.
	if len(deferred) != count {
		unblock()
		t.Fatalf("bounded frame lost inventory: %d", len(deferred))
	}
	started := int32(0)
	for id, p := range probes {
		assertCurrentHeartbeat(t, heartbeatEntry(t, deferred, id), "unknown", "")
		started += p.statusCalls.Load()
		if p.detailCalls.Load() != 0 || !a.getProbeState(id).running.Load() {
			unblock()
			t.Fatal("deferred projection read unfinished details or released background ownership")
		}
	}
	if started != maxHeartbeatProbeConcurrency {
		unblock()
		t.Fatalf("pool started %d probes, want %d with one still queued", started, maxHeartbeatProbeConcurrency)
	}
	unblock()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		running := false
		for id := range probes {
			running = running || a.getProbeState(id).running.Load()
		}
		if !running {
			break
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatal("background probe ownership did not drain after release")
		}
	}
	fresh := a.printerStatusPayload()
	for id, p := range probes {
		assertCurrentHeartbeat(t, heartbeatEntry(t, deferred, id), "unknown", "")
		assertCurrentHeartbeat(t, heartbeatEntry(t, fresh, id), "online", "windows_power_save")
		if p.statusCalls.Load() != 2 || p.detailCalls.Load() != 2 {
			t.Fatal("late completion was reused as current readiness instead of a fresh completed read")
		}
	}
}
