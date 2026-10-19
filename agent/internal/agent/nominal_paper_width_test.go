package agent

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestHeartbeatPreservesSelectedNominalPaperWidth(t *testing.T) {
	for _, width := range []int{80, 210} {
		a := newDesiredStateTestAgent(t)
		pc := config.PrinterConfig{
			ID: "nominal-media", Name: "Selected media", Type: "network",
			Endpoint: "192.168.2.10:9100", Protocol: "raw", PaperWidthMM: width,
			Capabilities: map[string]interface{}{"paper_width_mm": 58, "paper_widths": []interface{}{58}, "max_paper_width": 576},
		}
		a.printers[pc.ID] = &fakePrinter{}
		a.printerConfigs[pc.ID] = pc
		payload := a.printerStatusPayload()
		if len(payload) != 1 {
			t.Fatalf("selected media printer omitted: %#v", payload)
		}
		caps := payload[0]["capabilities"].(map[string]interface{})
		if caps["paper_width_mm"] != width {
			t.Fatalf("selected %dmm media replaced by capability hint: %#v", width, caps)
		}
		declared := payload[0]["config"].(map[string]interface{})
		if declared["paper_width_mm"] != width || desiredPaperWidthMM(declared) != width {
			t.Fatalf("selected %dmm media lost from desired-state roundtrip: %#v", width, declared)
		}
		if pc.Capabilities["paper_width_mm"] != 58 {
			t.Fatal("heartbeat mutated the configured capability bag")
		}
	}
}

func TestEndpointMetadataDoesNotInferNominalPaperFromDots(t *testing.T) {
	pc := config.PrinterConfig{Type: "network", Endpoint: "192.168.2.10:9100", Protocol: "raw", Capabilities: map[string]interface{}{"max_paper_width": 576}}
	declared := endpointToConfig(pc)
	if _, invented := declared["paper_width_mm"]; invented || desiredPaperWidthMM(declared) != 0 {
		t.Fatalf("printable dots invented nominal media width: %#v", declared)
	}
}
