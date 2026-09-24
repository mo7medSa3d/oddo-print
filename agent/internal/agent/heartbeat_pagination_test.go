package agent

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/printer"
)

type boundedStatusPrinter struct {
	fakePrinter
	active    int32
	maxActive int32
	started   chan struct{}
	release   chan struct{}
}

func (p *boundedStatusPrinter) Status() string {
	active := atomic.AddInt32(&p.active, 1)
	defer atomic.AddInt32(&p.active, -1)

	for {
		previous := atomic.LoadInt32(&p.maxActive)
		if active <= previous || atomic.CompareAndSwapInt32(&p.maxActive, previous, active) {
			break
		}
	}

	select {
	case p.started <- struct{}{}:
	default:
	}
	<-p.release
	return "online"
}

func TestHeartbeatStatusProbesUseBoundedConcurrency(t *testing.T) {
	const printerCount = maxHeartbeatProbeConcurrency * 2
	ag := newTestAgent(t, "seed", &fakePrinter{})
	release := make(chan struct{})
	started := make(chan struct{}, printerCount)

	ag.printers = make(map[string]printer.Printer, printerCount)
	ag.printerConfigs = make(map[string]config.PrinterConfig, printerCount)
	probes := make([]*boundedStatusPrinter, 0, printerCount)
	for i := 0; i < printerCount; i++ {
		p := &boundedStatusPrinter{started: started, release: release}
		id := "probe-" + formatTestIndex(i)
		ag.printers[id] = p
		ag.printerConfigs[id] = config.PrinterConfig{
			ID: id, Name: id, Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw",
		}
		probes = append(probes, p)
	}

	done := make(chan struct{})
	go func() {
		_ = ag.printerStatusPayload()
		close(done)
	}()

	for i := 0; i < maxHeartbeatProbeConcurrency; i++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("bounded heartbeat probe pool did not start the expected worker count")
		}
	}

	select {
	case <-started:
		close(release)
		t.Fatal("heartbeat started more probes than the configured concurrency ceiling")
	case <-time.After(100 * time.Millisecond):
	}

	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("heartbeat status payload did not drain after probe release")
	}

	maxObserved := int32(0)
	for _, p := range probes {
		if got := atomic.LoadInt32(&p.maxActive); got > maxObserved {
			maxObserved = got
		}
	}
	if maxObserved > maxHeartbeatProbeConcurrency {
		t.Fatalf("heartbeat probe concurrency exceeded ceiling: got %d, want <= %d", maxObserved, maxHeartbeatProbeConcurrency)
	}
}

func TestHeartbeatPaginationPreservesFullInventoryAndOwnershipFence(t *testing.T) {
	var received []map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/heartbeat" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		received = append(received, body)
		page, _ := body["heartbeatPage"].(float64)
		pageCount, _ := body["heartbeatPageCount"].(float64)
		if page == pageCount {
			_, _ = w.Write([]byte(`{"success":true,"desiredState":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_heartbeat_pages"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()

	const printerCount = 1001
	ag.printers = make(map[string]printer.Printer, printerCount)
	ag.printerConfigs = make(map[string]config.PrinterConfig, printerCount)
	for i := 0; i < printerCount; i++ {
		id := "printer-" + formatTestIndex(i)
		ag.printers[id] = &fakePrinter{}
		ag.printerConfigs[id] = config.PrinterConfig{
			ID: id, Name: id, Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw",
		}
	}
	// A Gateway-owned stale local entry must remain fenced even when its
	// heartbeat page is not the first page of the inventory.
	gatewayOwnedID := "printer-" + formatTestIndex(printerCount-1)
	ag.gatewayOwned[gatewayOwnedID] = struct{}{}

	payload := ag.printerStatusPayload()
	if got := len(payload); got != printerCount {
		t.Fatalf("printerStatusPayload truncated the inventory: got %d, want %d", got, printerCount)
	}

	ag.sendHeartbeat()

	if got, want := len(received), 3; got != want {
		t.Fatalf("heartbeat should paginate %d printers into %d pages, got %d", printerCount, want, got)
	}

	seenPrinters := make(map[string]struct{}, printerCount)
	for i, page := range received {
		pageNo, ok := page["heartbeatPage"].(float64)
		if !ok || int(pageNo) != i+1 {
			t.Fatalf("page %d has invalid heartbeatPage: %#v", i+1, page["heartbeatPage"])
		}
		pageCount, ok := page["heartbeatPageCount"].(float64)
		if !ok || int(pageCount) != len(received) {
			t.Fatalf("page %d has invalid heartbeatPageCount: %#v", i+1, page["heartbeatPageCount"])
		}

		entries, ok := page["printers"].([]interface{})
		if !ok {
			t.Fatalf("page %d has invalid printers payload: %#v", i+1, page["printers"])
		}
		if len(entries) > maxHeartbeatPrintersPerPage {
			t.Fatalf("page %d exceeds the Gateway per-page printer ceiling: %d", i+1, len(entries))
		}
		for _, raw := range entries {
			entry, ok := raw.(map[string]interface{})
			if !ok {
				t.Fatalf("page %d contains malformed printer entry %#v", i+1, raw)
			}
			id, _ := entry["id"].(string)
			if id == "" {
				t.Fatalf("page %d contains printer without id", i+1)
			}
			if _, duplicate := seenPrinters[id]; duplicate {
				t.Fatalf("printer %s was sent on more than one heartbeat page", id)
			}
			seenPrinters[id] = struct{}{}
		}

		owned, ok := page["gatewayOwnedPrinterIds"].([]interface{})
		if !ok {
			t.Fatalf("page %d has invalid gatewayOwnedPrinterIds: %#v", i+1, page["gatewayOwnedPrinterIds"])
		}
		for _, raw := range owned {
			id, _ := raw.(string)
			if id != gatewayOwnedID {
				t.Fatalf("unexpected Gateway-owned ID on page %d: %q", i+1, id)
			}
			foundOnPage := false
			for _, rawPrinter := range entries {
				entry := rawPrinter.(map[string]interface{})
				if entry["id"] == id {
					foundOnPage = true
				}
			}
			if !foundOnPage {
				t.Fatalf("Gateway-owned fence ID %q was sent on a page without that printer", id)
			}
		}
	}

	if got := len(seenPrinters); got != printerCount {
		t.Fatalf("heartbeat lost printers during pagination: saw %d, want %d", got, printerCount)
	}
}

func TestHeartbeatPaginationSplitsLargeAuxiliaryState(t *testing.T) {
	printers := make([]map[string]interface{}, 0, maxHeartbeatPrintersPerPage+1)
	for i := 0; i < maxHeartbeatPrintersPerPage+1; i++ {
		printers = append(printers, map[string]interface{}{"id": "printer-" + formatTestIndex(i), "status": "online"})
	}

	acks := make([]map[string]interface{}, 0, maxHeartbeatAuxItemsPerPage*2+1)
	for i := 0; i < maxHeartbeatAuxItemsPerPage*2+1; i++ {
		acks = append(acks, map[string]interface{}{"printerId": "manager-" + formatTestIndex(i), "appliedDesiredRevision": 1, "observedDesiredRevision": 1})
	}

	pages := buildHeartbeatPayloadPages(printers, acks, nil, nil)
	if got, want := len(pages), 3; got != want {
		t.Fatalf("expected auxiliary heartbeat state to expand pages to %d, got %d", want, got)
	}

	ackCount := 0
	for i, page := range pages {
		pageNo := int(page["heartbeatPage"].(int))
		pageCount := int(page["heartbeatPageCount"].(int))
		if pageNo != i+1 || pageCount != len(pages) {
			t.Fatalf("invalid page metadata: page=%d count=%d", pageNo, pageCount)
		}
		ackPage := page["desiredStateAcks"].([]map[string]interface{})
		if len(ackPage) > maxHeartbeatAuxItemsPerPage {
			t.Fatalf("page %d exceeds auxiliary page ceiling: %d", i+1, len(ackPage))
		}
		ackCount += len(ackPage)
	}
	if ackCount != len(acks) {
		t.Fatalf("lost desired-state ACKs during pagination: got %d, want %d", ackCount, len(acks))
	}
}

// formatTestIndex is intentionally local to this file so the inventory tests
// do not depend on UUID generation or random ordering.
func formatTestIndex(i int) string {
	return fmt.Sprintf("%04d", i)
}
