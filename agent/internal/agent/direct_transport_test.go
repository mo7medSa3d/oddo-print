package agent

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestDirectHeartbeatPayloadPages(t *testing.T) {
	printers := make([]map[string]interface{}, 205)
	for i := range printers {
		printers[i] = map[string]interface{}{"printerKey": fmt.Sprintf("printer-%03d", i)}
	}
	keepAlive := []map[string]string{
		{"jobId": "job-a", "claimToken": "tok-a"},
		{"jobId": "job-b", "claimToken": "tok-b"},
	}
	pages := buildDirectHeartbeatPayloadPages(printers, keepAlive)
	if len(pages) != 3 {
		t.Fatalf("expected 3 bounded heartbeat pages, got %d", len(pages))
	}
	seen := 0
	for index, page := range pages {
		rows, ok := page["printers"].([]map[string]interface{})
		if !ok || len(rows) > 100 {
			t.Fatalf("page %d has invalid printer batch: %#v", index, page["printers"])
		}
		seen += len(rows)
		if got, ok := page["keepAliveJobIds"].([]map[string]string); !ok || len(got) != len(keepAlive) || got[0]["claimToken"] != "tok-a" {
			t.Fatalf("page %d lost keepalive job/claimToken pairs", index)
		}
	}
	if seen != len(printers) {
		t.Fatalf("expected all %d printers to be included, got %d", len(printers), seen)
	}
}

func TestAgentUsesOnlyDirectOdooHTTPEndpoints(t *testing.T) {
	source, err := os.ReadFile("agent.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, endpoint := range []string{"/api/agent/heartbeat", "/api/agent/jobs", "/api/agent/ack"} {
		if !strings.Contains(text, endpoint) {
			t.Fatalf("missing direct Odoo endpoint %s", endpoint)
		}
	}
	for _, legacy := range []string{"web" + "socket.Dial", "gateway_job_id", "/api/agent/discovery"} {
		if strings.Contains(text, legacy) {
			t.Fatalf("legacy transport reference remains: %s", legacy)
		}
	}
}

func TestDispatchDoesNotRunOperationalCertification(t *testing.T) {
	source, err := os.ReadFile("runtime_verification.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, legacy := range []string{"ProbeOperationalVerification", "OperationalVerificationScore", "CertificationRequired"} {
		if strings.Contains(text, legacy) {
			t.Fatalf("dispatch gate still depends on operational certification: %s", legacy)
		}
	}
}
