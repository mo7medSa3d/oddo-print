package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestPrinterWaiterRequestsFreshAdmissionBeforeHardware(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	var secondAdmissions atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if r.Method != http.MethodPatch || json.NewDecoder(r.Body).Decode(&body) != nil {
			http.NotFound(w, r)
			return
		}
		if body["status"] == "printing" && body["jobId"] == "waiter" {
			secondAdmissions.Add(1)
			http.Error(w, "claim expired or printer disabled while waiting", http.StatusConflict)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
	}))
	defer srv.Close()
	cfg := &config.Config{}
	cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer ag.Close()
	p := &fakePrinter{blocked: make(chan struct{}), startedCh: make(chan string, 2)}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{"p1": {ID: "p1", Type: "network", Protocol: "raw", Endpoint: "127.0.0.1:9100"}}
	allowInjectedPrintersForTest(ag)
	ag.dispatchJob(context.Background(), dispatchTestJob("first", "p1"))
	select {
	case <-p.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("first print did not start")
	}
	// The alias names the same local backend and must share its mutex.
	ag.dispatchJob(context.Background(), dispatchTestJob("waiter", "p1~aaaaaaaa"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		count, err := ag.queue.CountByStatus("printing")
		if err != nil {
			t.Fatal(err)
		}
		if count == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiter was not reserved")
		}
		time.Sleep(time.Millisecond)
	}
	if secondAdmissions.Load() != 0 {
		t.Fatal("waiter requested admission before the printer was free")
	}
	close(p.blocked)
	if !ag.waitForJobsFor(5 * time.Second) {
		t.Fatal("jobs did not drain")
	}
	if secondAdmissions.Load() != 1 {
		t.Fatal("waiter did not request fresh Gateway admission")
	}
	if p.Calls() != 1 {
		t.Fatalf("refused waiter reached hardware: %d calls", p.Calls())
	}
}
