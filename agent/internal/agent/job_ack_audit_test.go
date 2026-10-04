package agent

import (
	"context"
	"github.com/yaseir-agent/agent/internal/config"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestTerminalAcknowledgementRetainsOutboxTokenUntilValidated(t *testing.T) {
	for _, status := range []string{"success", "failed"} {
		for _, tc := range []struct {
			name, body string
			accepted   bool
		}{
			{"valid", `{"success":true,"status":"` + status + `"}`, true},
			{"missing_status", `{"success":true}`, false},
			{"wrong_status", `{"success":true,"status":"printing"}`, false},
			{"not_accepted", `{"success":false,"status":"` + status + `"}`, false},
			{"trailing_json", `{"success":true,"status":"` + status + `"}{}`, false},
			{"oversized", `{"success":true,"status":"` + status + `"}` + strings.Repeat(" ", maxGatewayErrorBodyBytes), false},
		} {
			t.Run(status+"/"+tc.name, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(tc.body)) }))
				defer server.Close()
				cfg := &config.Config{}
				cfg.Agent.ID = "agt_ack_test"
				cfg.Agent.Secret = "secret"
				cfg.Server.URL = server.URL
				a, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
				if err != nil {
					t.Fatal(err)
				}
				defer a.Close()
				if err := a.queue.BeginPrint("job_ack", "printer_ack", []byte(`{}`), "owned-token", false); err != nil {
					t.Fatal(err)
				}
				if err := a.queue.UpdateStatusWithError("job_ack", status, ""); err != nil {
					t.Fatal(err)
				}
				err = a.updateJobStatus(context.Background(), "job_ack", status, "", "owned-token", "")
				if (err == nil) != tc.accepted {
					t.Fatalf("ack accepted=%v error=%v", tc.accepted, err)
				}
				token := a.queue.ClaimTokenFor("job_ack")
				if tc.accepted && token != "" {
					t.Fatalf("acknowledged token retained: %q", token)
				}
				if !tc.accepted && token != "owned-token" {
					t.Fatalf("invalid acknowledgement lost durable token: %q", token)
				}
			})
		}
	}
}
