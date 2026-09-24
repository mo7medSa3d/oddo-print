package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/payload"
	"github.com/yasser-agent/agent/internal/printer"
)

const jobIDPrefix = "JOBID:"

func makeJobPayload(jobID string) map[string]interface{} {
	return map[string]interface{}{
		"type":     "raw",
		"protocol": "raw",
		"encoding": "base64",
		"data":     base64.StdEncoding.EncodeToString([]byte(jobIDPrefix + jobID)),
	}
}

func jobIDFromPayload(data []byte) string {
	text := string(data)
	if strings.HasPrefix(text, jobIDPrefix) {
		return strings.TrimPrefix(text, jobIDPrefix)
	}
	return ""
}

type fakePrinter struct {
	mu            sync.Mutex
	calls         int
	callsByJob    map[string]int
	attemptsByJob map[string]int
	spans         []printSpan
	failBefore    map[string]int
	blocked       chan struct{}
	startedCh     chan string
	allowReturn   chan struct{}
	status        string
}

type printSpan struct {
	start time.Time
	end   time.Time
}

func (f *fakePrinter) Spans() []printSpan {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]printSpan, len(f.spans))
	copy(out, f.spans)
	return out
}

func (f *fakePrinter) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func spansOverlap(a, b printSpan) bool {
	return a.start.Before(b.end) && b.start.Before(a.end)
}

func (f *fakePrinter) Print(ctx context.Context, data []byte) error {
	jobID := jobIDFromPayload(data)
	start := time.Now()
	f.mu.Lock()
	if f.callsByJob == nil {
		f.callsByJob = map[string]int{}
	}
	if f.attemptsByJob == nil {
		f.attemptsByJob = map[string]int{}
	}
	if f.failBefore == nil {
		f.failBefore = map[string]int{}
	}
	f.attemptsByJob[jobID]++
	if n := f.failBefore[jobID]; n > 0 {
		f.failBefore[jobID]--
		f.mu.Unlock()
		return context.DeadlineExceeded
	}
	f.calls++
	f.callsByJob[jobID]++
	if f.startedCh != nil {
		select {
		case f.startedCh <- jobID:
		default:
		}
	}
	f.mu.Unlock()
	if f.blocked != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-f.blocked:
		}
	}
	if f.allowReturn != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-f.allowReturn:
		}
	}
	f.mu.Lock()
	f.spans = append(f.spans, printSpan{start: start, end: time.Now()})
	f.mu.Unlock()
	return nil
}

func (f *fakePrinter) Test(ctx context.Context) error {
	return f.Print(ctx, []byte(jobIDPrefix+"test"))
}

func (f *fakePrinter) Status() string {
	if f.status != "" {
		return f.status
	}
	return "online"
}

func newStatusTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/jobs":
			switch r.Method {
			case http.MethodPatch:
				var body map[string]interface{}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, "invalid json", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"success":true}`))
				return
			case http.MethodGet:
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`[]`))
				return
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		default:
			http.NotFound(w, r)
		}
	}))
}

func newTestAgent(t *testing.T, printerID string, p printer.Printer) *Agent {
	t.Helper()
	server := newStatusTestServer(t)
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	cfg.Printers = append([]config.PrinterConfig{{ID: printerID, Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"}}, cfg.Printers...)
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")
	ag, err := New(cfg, cfgPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ag.printers = map[string]printer.Printer{printerID: p}
	ag.printerConfigs = map[string]config.PrinterConfig{printerID: {ID: printerID, Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"}}
	t.Cleanup(func() {
		server.Close()
		if err := ag.Close(); err != nil {
			t.Logf("Agent.Close() error: %v", err)
		}
	})
	return ag
}

func allowInjectedPrintersForTest(ag *Agent) {
	ag.printersMu.RLock()
	configs := make([]config.PrinterConfig, 0, len(ag.printerConfigs))
	for _, pc := range ag.printerConfigs {
		configs = append(configs, pc)
	}
	ag.printersMu.RUnlock()
	ag.cfg.Printers = append(ag.cfg.Printers, configs...)
}

func assertNoInFlight(t *testing.T, ag *Agent) {
	t.Helper()
	ag.inFlightMu.Lock()
	defer ag.inFlightMu.Unlock()
	if len(ag.inFlight) != 0 {
		t.Fatalf("jobs still in flight after completion: %v", ag.inFlight)
	}
}

func TestPerPrinterSerialization(t *testing.T) {
	p1 := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p1)
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        fmt.Sprintf("serial_%d", n),
				"printerId": "printer_1",
				"payload":   makeJobPayload(fmt.Sprintf("serial_%d", n)),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.processJob(ctx, job)
		}(i)
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if p1.calls != 2 {
		t.Fatalf("expected 2 calls, got %d", p1.calls)
	}
	spans := p1.Spans()
	if len(spans) != 2 {
		t.Fatalf("expected 2 recorded spans, got %d", len(spans))
	}
	if spansOverlap(spans[0], spans[1]) {
		t.Fatalf("expected serialized execution, print spans overlap: %+v", spans)
	}
}

func TestDifferentPrintersConcurrent(t *testing.T) {
	// Provably-concurrent cross-printer execution WITHOUT wall-clock assertions.
	//
	// Both printers park on the SAME `barrier` channel inside Print() — but only
	// AFTER each has signalled on its own `startedCh`. The moment both startedCh
	// signals have been received by this test, both Print calls are guaranteed
	// to be in flight at the same time: each is blocked inside `barrier` while
	// the other is printing. No time.Now() comparison is needed.
	//
	// (The previous implementation asserted span overlap via time.Now() deltas.
	// On 2-vCPU Windows runners Go can hand two goroutines the same wall-clock
	// tick, so two genuinely-concurrent prints recorded BIT-IDENTICAL spans and
	// spansOverlap()'s strict `Before` comparisons returned false — making the
	// build fail even though the behaviour under test was correct.)
	barrier := make(chan struct{})
	p1 := &fakePrinter{blocked: barrier, startedCh: make(chan string, 1)}
	p2 := &fakePrinter{blocked: barrier, startedCh: make(chan string, 1)}
	server := newStatusTestServer(t)
	defer server.Close()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	tmpDir := t.TempDir()
	ag, err := New(cfg, filepath.Join(tmpDir, "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	ag.printers = map[string]printer.Printer{"p1": p1, "p2": p2}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "P1", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
		"p2": {ID: "p2", Name: "P2", Type: "network", Endpoint: "127.0.0.1:9101", Protocol: "raw"},
	}
	allowInjectedPrintersForTest(ag)
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		ag.processJob(ctx, map[string]interface{}{"id": "j1", "printerId": "p1", "payload": makeJobPayload("j1"), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)})
	}()
	go func() {
		defer wg.Done()
		<-start
		ag.processJob(ctx, map[string]interface{}{"id": "j2", "printerId": "p2", "payload": makeJobPayload("j2"), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)})
	}()
	close(start)

	waitStarted := func(p *fakePrinter, name string) {
		t.Helper()
		select {
		case <-p.startedCh:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s never started printing", name)
		}
	}
	waitStarted(p1, "p1")
	waitStarted(p2, "p2")
	// Both prints are parked behind the barrier RIGHT NOW -> provably concurrent.
	close(barrier)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if len(p1.Spans()) != 1 || len(p2.Spans()) != 1 {
		t.Fatalf("expected one span per printer, got %d/%d", len(p1.Spans()), len(p2.Spans()))
	}
}

func TestSameJobIDAcrossTenConcurrentDispatches(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	const workers = 10
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        "same_job_10",
				"printerId": "printer_1",
				"payload":   makeJobPayload("same_job_10"),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}()
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p.callsByJob["same_job_10"]; got != 1 {
		t.Fatalf("expected exactly one physical print for same jobID across 10 goroutines, got %d", got)
	}
}

func TestSameJobIDAcrossHundredConcurrentDispatches(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	const workers = 100
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        "same_job_100",
				"printerId": "printer_1",
				"payload":   makeJobPayload("same_job_100"),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}()
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p.callsByJob["same_job_100"]; got != 1 {
		t.Fatalf("expected exactly one physical print for same jobID across 100 goroutines, got %d", got)
	}
}

func TestWSAndPollingDuplicateDeliverySameJobID(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        "ws_poll_same_job",
				"printerId": "printer_1",
				"payload":   makeJobPayload("ws_poll_same_job"),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}()
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p.callsByJob["ws_poll_same_job"]; got != 1 {
		t.Fatalf("expected exactly one print for WS+poll duplicate delivery, got %d", got)
	}
}

func TestDifferentJobsSamePrinterSerialized(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	const jobs = maxPendingJobsPerPrinter
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < jobs; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        fmt.Sprintf("same_printer_%d", i),
				"printerId": "printer_1",
				"payload":   makeJobPayload(fmt.Sprintf("same_printer_%d", i)),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}(i)
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if p.calls != jobs {
		t.Fatalf("expected %d calls, got %d", jobs, p.calls)
	}
	spans := p.Spans()
	for i := 1; i < len(spans); i++ {
		if spansOverlap(spans[i-1], spans[i]) {
			t.Fatalf("expected same-printer jobs to serialize; spans overlapped: %v vs %v", spans[i-1], spans[i])
		}
	}
}

func TestDifferentJobsAcrossThreePrintersConcurrent(t *testing.T) {
	p1 := &fakePrinter{}
	p2 := &fakePrinter{}
	p3 := &fakePrinter{}
	server := newStatusTestServer(t)
	defer server.Close()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	tmpDir := t.TempDir()
	ag, err := New(cfg, filepath.Join(tmpDir, "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	ag.printers = map[string]printer.Printer{"p1": p1, "p2": p2, "p3": p3}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "P1", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
		"p2": {ID: "p2", Name: "P2", Type: "network", Endpoint: "127.0.0.1:9101", Protocol: "raw"},
		"p3": {ID: "p3", Name: "P3", Type: "network", Endpoint: "127.0.0.1:9102", Protocol: "raw"},
	}
	allowInjectedPrintersForTest(ag)
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			printerID := "p1"
			switch i % 3 {
			case 1:
				printerID = "p2"
			case 2:
				printerID = "p3"
			}
			job := map[string]interface{}{
				"id":        fmt.Sprintf("multi_%d", i),
				"printerId": printerID,
				"payload":   makeJobPayload(fmt.Sprintf("multi_%d", i)),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}(i)
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p1.calls + p2.calls + p3.calls; got != 12 {
		t.Fatalf("expected 12 total prints across 3 printers, got %d (%d+%d+%d)", got, p1.calls, p2.calls, p3.calls)
	}
	if len(p1.Spans()) == 0 || len(p2.Spans()) == 0 || len(p3.Spans()) == 0 {
		t.Fatal("expected at least one span on each printer")
	}
}

func TestPrintFailureThenRetry(t *testing.T) {
	p := &fakePrinter{failBefore: map[string]int{"retry_job": 1}}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id":        "retry_job",
		"printerId": "printer_1",
		"payload":   makeJobPayload("retry_job"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	if got := p.attemptsByJob["retry_job"]; got != 1 {
		t.Fatalf("first attempt should be recorded once even when it fails, got %d attempts", got)
	}
	if got := p.callsByJob["retry_job"]; got != 0 {
		t.Fatalf("failed first attempt should not count as a successful print, got %d successful calls", got)
	}
	ag.processJob(ctx, job)
	if got := p.attemptsByJob["retry_job"]; got != 2 {
		t.Fatalf("retry after failure should create exactly one second attempt, got %d total attempts", got)
	}
	if got := p.callsByJob["retry_job"]; got != 1 {
		t.Fatalf("retry after failure should succeed exactly once, got %d successful calls", got)
	}
	assertNoInFlight(t, ag)
}

func TestGatewayOwnsJobExpiryEnforcement(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id": "gateway-expiry-job", "printerId": "p1",
		"payload":   makeJobPayload("gateway-expiry-job"),
		"expiresAt": time.Now().Add(-time.Minute).Format(time.RFC3339),
	}
	// The Agent deliberately does not enforce expiresAt using its local wall
	// clock. Gateway time is authoritative; the Agent only applies its local
	// claim-freshness fence when a printing transition cannot be acknowledged.
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("agent must not locally reject a Gateway-delivered job by wall-clock expiry, got %d calls", p.calls)
	}
}

func TestDuplicateSkippedAfterSuccess(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id": "dup_job", "printerId": "p1",
		"payload":   makeJobPayload("dup_job"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("first call expected 1, got %d", p.calls)
	}
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("duplicate should be skipped, got %d", p.calls)
	}
	assertNoInFlight(t, ag)
}

func TestSingleFlightProbeGuard(t *testing.T) {
	ag := &Agent{}
	state := ag.getProbeState("p1")
	if !state.running.CompareAndSwap(false, true) {
		t.Fatal("first CAS should succeed")
	}

	// While running, second CAS must fail (single-flight active)
	if state.running.CompareAndSwap(false, true) {
		t.Fatal("second CAS while running must fail")
	}

	// Release
	state.running.Store(false)
	if !state.running.CompareAndSwap(false, true) {
		t.Fatal("CAS after store(false) must succeed")
	}
}

func TestKeepAliveEchoesClaimTokens(t *testing.T) {
	// The heartbeat keep-alive must carry (jobId, claimToken) pairs so the
	// gateway can fence the lease refresh to the live claim. A bare job id
	// would let a stale worker extend a reclaimed lease.
	started := make(chan string, 1)
	release := make(chan struct{})
	p := &fakePrinter{blocked: release, startedCh: started}
	ag := newTestAgent(t, "p1", p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	job := map[string]interface{}{
		"id":         "job-ka-1",
		"printerId":  "p1",
		"payload":    makeJobPayload("job-ka-1"),
		"expiresAt":  time.Now().Add(time.Hour).Format(time.RFC3339),
		"claimToken": "tok-live-9",
	}
	go ag.dispatchJob(ctx, job)
	select {
	case got := <-started:
		if got != "job-ka-1" {
			t.Fatalf("unexpected job started: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("job never reached the printer")
	}
	pairs := ag.inFlightJobIDs(64)
	if len(pairs) != 1 || pairs[0]["jobId"] != "job-ka-1" || pairs[0]["claimToken"] != "tok-live-9" {
		t.Fatalf("keep-alive must echo the live claim token, got %v", pairs)
	}
	close(release)
	ag.waitForJobs()
	assertNoInFlight(t, ag)
}

func TestAuthorizeDispatchAfterReportFailure(t *testing.T) {
	now := time.Now()
	transportErr := errors.New("connection refused")
	cases := []struct {
		name      string
		received  time.Time
		expires   time.Time
		hasExpiry bool
		err       error
		want      bool
	}{
		{"fence rejection never proceeds", now, time.Time{}, false, ErrStaleClaim, false},
		{"explicit gateway rejection never proceeds", now, time.Time{}, false, ErrTransitionRejected, false},
		{"nil error proceeds (defensive: gate only runs on error)", now, time.Time{}, false, nil, true},
		{"transport failure with fresh receipt proceeds", now.Add(-10 * time.Second), time.Time{}, false, transportErr, true},
		{"transport failure with stale receipt refuses", now.Add(-time.Hour), time.Time{}, false, transportErr, false},
		{"transport failure with unknown receipt refuses", time.Time{}, time.Time{}, false, transportErr, false},
		{"transport failure ignores Gateway expiry timestamp when receipt is fresh", now.Add(-time.Second), now.Add(-time.Second), true, transportErr, true},
		{"transport failure before TTL proceeds when fresh", now.Add(-time.Second), now.Add(time.Hour), true, transportErr, true},
		{"boundary: exactly at the window refuses", now.Add(-staleClaimSafetyWindow), time.Time{}, false, transportErr, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := authorizeDispatchAfterReportFailure(tc.received, now, tc.err)
			if got != tc.want {
				t.Fatalf("proceed = %v, want %v (reason: %s)", got, tc.want, reason)
			}
			if got == tc.want && !got && reason == "" {
				t.Fatalf("refusals must carry a forensic reason")
			}
		})
	}
}

func TestStaleTransportFailureHaltsBeforeHardware(t *testing.T) {
	// Gateway unreachable AND the delivery is older than the claim-lease
	// window: a reclaim may already have completed, so the stale attempt
	// must not touch the printer even though the failure is "only" a
	// transport error.
	server := newStatusTestServer(t)
	defer server.Close()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = "http://127.0.0.1:1"
	tmpDir := t.TempDir()
	ag, err := New(cfg, filepath.Join(tmpDir, "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	p := &fakePrinter{}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{"p1": {ID: "p1", Name: "T", Type: "network", Protocol: "raw", Endpoint: "127.0.0.1:9100"}}
	allowInjectedPrintersForTest(ag)
	jobID := "job-stale-transport"
	// Simulate a delivery accepted long ago: dispatch acceptance stamped
	// the receipt time, then the gateway went dark.
	ag.inFlightMu.Lock()
	ag.inFlight[jobID] = struct{}{}
	ag.inFlightTokens[jobID] = "tok-old-1"
	ag.inFlightReceived[jobID] = time.Now().Add(-time.Hour)
	ag.inFlightMu.Unlock()
	ag.processJob(context.Background(), map[string]interface{}{
		"id":         jobID,
		"printerId":  "p1",
		"payload":    makeJobPayload(jobID),
		"expiresAt":  time.Now().Add(time.Hour).Format(time.RFC3339),
		"claimToken": "tok-old-1",
	})
	if p.calls != 0 {
		t.Fatalf("stale attempt with unreachable gateway must print nothing, got %d calls", p.calls)
	}
	_, status, found, err := ag.queue.Get(jobID)
	if err != nil || !found {
		t.Fatalf("expected an aborted ledger row, found=%v err=%v", found, err)
	}
	if status == "printing" || status == "success" {
		t.Fatalf("aborted attempt must not be left in %q", status)
	}
}

func TestFreshTransportFailureStillPrints(t *testing.T) {
	// The mirror case: gateway unreachable but the delivery is seconds old,
	// so no reclaim could have completed. Offline-tolerant printing is
	// preserved: the job prints and the ledger tracks it.
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = "http://127.0.0.1:1"
	tmpDir := t.TempDir()
	ag, err := New(cfg, filepath.Join(tmpDir, "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	p := &fakePrinter{}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{"p1": {ID: "p1", Name: "T", Type: "network", Protocol: "raw", Endpoint: "127.0.0.1:9100"}}
	allowInjectedPrintersForTest(ag)
	jobID := "job-fresh-transport"
	ag.dispatchJob(context.Background(), map[string]interface{}{
		"id":         jobID,
		"printerId":  "p1",
		"payload":    makeJobPayload(jobID),
		"expiresAt":  time.Now().Add(time.Hour).Format(time.RFC3339),
		"claimToken": "tok-fresh-1",
	})
	ag.waitForJobs()
	if p.calls != 1 {
		t.Fatalf("fresh delivery with unreachable gateway must still print once, got %d calls", p.calls)
	}
}

func productionNetworkDevice(id, endpoint string) printer.DeviceInfo {
	return printer.DeviceInfo{
		ID:             id,
		Name:           "Test Printer",
		PrinterType:    "thermal",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       endpoint,
		Enabled:        true,
	}
}

func TestReloadRegistryPrintersFeedsRuntimeAndHeartbeat(t *testing.T) {
	var heartbeat map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/heartbeat" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&heartbeat); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_registry_reload"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	ag, err := New(cfg, configPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()

	device := productionNetworkDevice("prt-desktop", "127.0.0.1:1")
	if err := printer.SaveRegistry(ag.registryPath, []printer.DeviceInfo{device}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}

	ag.sendHeartbeat()
	if _, ok := ag.getPrinter(device.ID); !ok {
		t.Fatal("registry reload must add the printer backend to the runtime map")
	}
	ag.printersMu.RLock()
	pc, ok := ag.printerConfigs[device.ID]
	ag.printersMu.RUnlock()
	if !ok || pc.Endpoint != device.Endpoint {
		t.Fatalf("registry reload must add printer config to the runtime map, got %+v", pc)
	}
	entries, ok := heartbeat["printers"].([]interface{})
	if !ok || len(entries) != 1 {
		t.Fatalf("heartbeat must contain the reloaded printer, got %#v", heartbeat["printers"])
	}
	entry, ok := entries[0].(map[string]interface{})
	if !ok || entry["id"] != device.ID || entry["endpoint"] != device.Endpoint {
		t.Fatalf("unexpected heartbeat printer payload: %#v", entries[0])
	}
}

func TestReloadRegistryPrintersRemovesDeletedRuntimeAndHeartbeatEntry(t *testing.T) {
	ag := newTestAgent(t, "seed", &fakePrinter{})
	device := productionNetworkDevice("prt-deleted", "127.0.0.1:9100")
	if err := printer.SaveRegistry(ag.registryPath, []printer.DeviceInfo{device}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}
	ag.reloadRegistryPrinters()
	if _, ok := ag.getPrinter(device.ID); !ok {
		t.Fatal("registry printer was not added")
	}

	if err := printer.SaveRegistry(ag.registryPath, nil); err != nil {
		t.Fatalf("clear registry: %v", err)
	}
	ag.reloadRegistryPrinters()
	if _, ok := ag.getPrinter(device.ID); ok {
		t.Fatal("deleted registry printer remains in runtime")
	}
	for _, entry := range ag.printerStatusPayload() {
		if entry["id"] == device.ID {
			t.Fatal("deleted registry printer remains heartbeat-reported")
		}
	}
}

func TestReloadRegistryPrintersPreservesYAMLOwnedPrinter(t *testing.T) {
	ag := newTestAgent(t, "yaml-printer", &fakePrinter{})
	ag.cfg.Printers = []config.PrinterConfig{{ID: "yaml-printer"}}
	device := productionNetworkDevice("yaml-printer", "127.0.0.1:9100")
	if err := printer.SaveRegistry(ag.registryPath, []printer.DeviceInfo{device}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}
	ag.reloadRegistryPrinters()
	if err := printer.SaveRegistry(ag.registryPath, nil); err != nil {
		t.Fatalf("clear registry: %v", err)
	}

	ag.reloadRegistryPrinters()
	if _, ok := ag.getPrinter("yaml-printer"); !ok {
		t.Fatal("YAML-owned printer was removed by registry reconciliation")
	}
}

func TestReloadRegistryPrintersDoesNotMutateResolvedBackend(t *testing.T) {
	ag := newTestAgent(t, "seed", &fakePrinter{})
	device := productionNetworkDevice("prt-in-flight", "127.0.0.1:9100")
	if err := printer.SaveRegistry(ag.registryPath, []printer.DeviceInfo{device}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}
	ag.reloadRegistryPrinters()
	resolved, ok := ag.getPrinter(device.ID)
	if !ok {
		t.Fatal("registry printer was not added")
	}

	if err := printer.SaveRegistry(ag.registryPath, nil); err != nil {
		t.Fatalf("clear registry: %v", err)
	}
	ag.reloadRegistryPrinters()
	if got := resolved.Status(); got == "" {
		t.Fatal("previously resolved backend was mutated or invalidated")
	}
}

func TestReloadRegistryPrintersReadFailureDoesNotRemove(t *testing.T) {
	ag := newTestAgent(t, "seed", &fakePrinter{})
	device := productionNetworkDevice("prt-preserved", "127.0.0.1:9100")
	if err := printer.SaveRegistry(ag.registryPath, []printer.DeviceInfo{device}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}
	ag.reloadRegistryPrinters()
	if err := os.WriteFile(ag.registryPath, []byte(`{"malformed"`), 0o600); err != nil {
		t.Fatalf("write malformed registry: %v", err)
	}

	ag.reloadRegistryPrinters()
	if _, ok := ag.getPrinter(device.ID); !ok {
		t.Fatal("failed registry read removed a runtime printer")
	}
}

func TestMergeDiscoveredPrinterRefreshesSameIDConfiguration(t *testing.T) {
	ag := newTestAgent(t, "seed", &fakePrinter{})
	device := productionNetworkDevice("prt-refresh", "127.0.0.1:9100")
	if changed, err := ag.mergeDiscoveredPrinter(device); err != nil || !changed {
		t.Fatalf("initial merge: changed=%v err=%v", changed, err)
	}
	oldBackend, _ := ag.getPrinter(device.ID)

	device.Endpoint = "192.0.2.99:9100"
	if changed, err := ag.mergeDiscoveredPrinter(device); err != nil || !changed {
		t.Fatalf("changed same-ID merge: changed=%v err=%v", changed, err)
	}
	newBackend, ok := ag.getPrinter(device.ID)
	if !ok || newBackend == oldBackend {
		t.Fatal("changed same-ID discovery must replace the runtime backend")
	}
	ag.printersMu.RLock()
	pc := ag.printerConfigs[device.ID]
	ag.printersMu.RUnlock()
	if pc.Endpoint != device.Endpoint {
		t.Fatalf("changed same-ID discovery must refresh runtime config, got %+v", pc)
	}
}

func TestMergeDiscoveredPrinterIdenticalIsNoOp(t *testing.T) {
	ag := newTestAgent(t, "seed", &fakePrinter{})
	device := productionNetworkDevice("prt-stable", "127.0.0.1:9100")
	if changed, err := ag.mergeDiscoveredPrinter(device); err != nil || !changed {
		t.Fatalf("initial merge: changed=%v err=%v", changed, err)
	}
	backend, _ := ag.getPrinter(device.ID)

	if changed, err := ag.mergeDiscoveredPrinter(device); err != nil || changed {
		t.Fatalf("identical rediscovery must be an addPrinter no-op: changed=%v err=%v", changed, err)
	}
	if got, ok := ag.getPrinter(device.ID); !ok || got != backend {
		t.Fatal("identical rediscovery must retain the existing backend")
	}
}

// TestPollJobsBoundsOversizedBatch pins the poll read to the documented
// contract ceiling and proves an oversized response terminates instead of
// being absorbed: the batch bound is exactly maxClaimBatch jobs times the
// per-payload ceiling dispatch itself enforces, and a response past it never
// reaches dispatch.
func TestPollJobsBoundsOversizedBatch(t *testing.T) {
	if got, want := maxPollJobsBytes(), int64(maxClaimBatch)*int64(payload.MaxPayloadBytes); got != want {
		t.Fatalf("poll ceiling = %d, want the documented batch product %d", got, want)
	}

	original := pollJobsByteLimit
	defer func() { pollJobsByteLimit = original }()
	pollJobsByteLimit = 4 << 10

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/jobs" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// Invalid JSON comfortably past the test ceiling: the read must stop
		// and the truncated decode must fail closed rather than buffering
		// the whole body first.
		_, _ = w.Write(make([]byte, pollJobsByteLimit*2))
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_poll_bound"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	ag, err := New(cfg, configPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()

	ag.pollJobs(context.Background())

	ag.inFlightMu.Lock()
	dispatched := len(ag.inFlight)
	ag.inFlightMu.Unlock()
	if dispatched != 0 {
		t.Fatalf("oversized poll response must not dispatch jobs, got %d in flight", dispatched)
	}
}

// TestPollJobsDispatchesBoundedBatch proves the ceiling does not reject a
// legitimate response: a valid batch inside the limit is decoded and dispatched.
func TestPollJobsDispatchesBoundedBatch(t *testing.T) {
	original := pollJobsByteLimit
	defer func() { pollJobsByteLimit = original }()
	pollJobsByteLimit = 1 << 20

	started := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/jobs" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPatch {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// The fake printer reads the job id out of the payload data itself.
		job, _ := json.Marshal([]interface{}{map[string]interface{}{
			"id":         "job-bounded-1",
			"printerId":  "prt-bounded",
			"claimToken": "tok",
			"payload":    makeJobPayload("job-bounded-1"),
		}})
		_, _ = w.Write(job)
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_poll_dispatch"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	ag, err := New(cfg, configPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()

	ag.printers = map[string]printer.Printer{"prt-bounded": &fakePrinter{startedCh: started}}
	ag.printerConfigs = map[string]config.PrinterConfig{"prt-bounded": {ID: "prt-bounded", Name: "Bounded", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"}}
	allowInjectedPrintersForTest(ag)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ag.pollJobs(ctx)

	select {
	case jobID := <-started:
		if jobID != "job-bounded-1" {
			t.Fatalf("unexpected dispatched job %q", jobID)
		}
	case <-ctx.Done():
		t.Fatal("a valid in-limit batch must be dispatched")
	}

	// The started notification proves admission, not completion. Wait for the
	// tracked execution to leave the in-flight set before the test's TempDir
	// cleanup closes queue.db; otherwise the background job can still write its
	// SQLite ledger while testing.TearDown removes the temporary directory.
	if !ag.waitForJobs() {
		t.Fatal("a valid in-limit batch did not drain before test cleanup")
	}

}

func TestProcessJobCancellationBeforePrintingRefusesHardware(t *testing.T) {
	printingStarted := make(chan struct{})
	var printingOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/jobs" || r.Method != http.MethodPatch {
			http.NotFound(w, r)
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["status"] == "printing" {
			printingOnce.Do(func() { close(printingStarted) })
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer ag.Close()

	p := &fakePrinter{}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
	}
	allowInjectedPrintersForTest(ag)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		ag.processJob(ctx, map[string]interface{}{
			"id":         "job_cancel_before_print",
			"printerId":  "p1",
			"payload":    makeJobPayload("job_cancel_before_print"),
			"expiresAt":  time.Now().Add(time.Hour).Format(time.RFC3339),
			"claimToken": "claim-cancel-1",
		})
		close(done)
	}()

	select {
	case <-printingStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("processJob never reached the claimed->printing report")
	}

	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("processJob did not terminate promptly after context cancellation")
	}

	if p.calls != 0 {
		t.Fatalf("cancelled claimed job must not reach hardware, got %d print calls", p.calls)
	}
	_, status, found, err := ag.queue.Get("job_cancel_before_print")
	if err != nil || !found {
		t.Fatalf("expected local ledger row after cancellation, found=%v err=%v", found, err)
	}
	if status == "printing" {
		t.Fatal("cancelled pre-dispatch attempt must be rolled back from local printing state")
	}
}

func TestHeartbeatStopsWhenAgentContextIsCancelled(t *testing.T) {
	heartbeatStarted := make(chan struct{})
	handlerRelease := make(chan struct{})
	handlerDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/heartbeat" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		close(heartbeatStarted)
		<-handlerRelease
		close(handlerDone)
	}))
	defer server.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_heartbeat_cancel"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer ag.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		ag.sendHeartbeatGuardedContext(ctx)
		close(done)
	}()

	select {
	case <-heartbeatStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("heartbeat request never started")
	}

	cancel()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("heartbeat did not stop promptly after agent context cancellation")
	}

	close(handlerRelease)
	select {
	case <-handlerDone:
	case <-time.After(1 * time.Second):
		t.Fatal("heartbeat HTTP test handler did not release cleanly")
	}
}
