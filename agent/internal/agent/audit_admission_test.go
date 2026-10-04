package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestPrintingAdmissionRequiresExplicitGatewayAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want int
	}{
		{"empty response", "", 0},
		{"missing status", `{"success":true}`, 0},
		{"unsuccessful response", `{"success":false,"status":"printing"}`, 0},
		{"expired claim", `{"success":true,"status":"expired"}`, 0},
		{"truncated response", `{"success":true,"status":`, 0},
		{"accepted printing claim", `{"success":true,"status":"printing"}`, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			cfg := &config.Config{}
			cfg.Agent.ID, cfg.Agent.Secret, cfg.Server.URL = "agt_test", "secret", server.URL
			ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			defer ag.Close()
			device := &fakePrinter{}
			ag.printers = map[string]printer.Printer{"p1": device}
			ag.printerConfigs = map[string]config.PrinterConfig{
				"p1": {ID: "p1", Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
			}
			allowInjectedPrintersForTest(ag)
			ag.dispatchJob(context.Background(), dispatchTestJob("admission", "p1"))
			ag.waitForJobs()
			if got := device.Calls(); got != tc.want {
				t.Fatalf("hardware writes = %d, want %d", got, tc.want)
			}
			_, status, found, err := ag.queue.Get("admission")
			if err != nil || !found {
				t.Fatalf("durable admission state missing: found=%v error=%v", found, err)
			}
			if tc.want == 0 && (status == "printing" || status == "success") {
				t.Fatalf("refused hardware admission must not retain %q", status)
			}
		})
	}
}
