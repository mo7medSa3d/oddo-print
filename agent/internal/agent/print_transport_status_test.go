package agent

import (
	"context"
	"testing"

	"github.com/yaseir-agent/agent/internal/printer"
)

func TestPrintStatusTransportReflectsPhysicalRoute(t *testing.T) {
	cases := []struct {
		name  string
		facts printer.TransportFacts
		want  string
	}{
		{"driver backed Windows queue", printer.TransportFacts{Connection: "spooler", Protocol: "spooler"}, "windows_spooler"},
		{"legacy USB spooler alias", printer.TransportFacts{Connection: "usb", Protocol: "spooler"}, "windows_spooler"},
		{"network IPP", printer.TransportFacts{Connection: "network", Protocol: "ipp"}, "ipp"},
		{"IPPS", printer.TransportFacts{Connection: "ipps", Protocol: "ipps"}, "ipps"},
		{"escpos TCP", printer.TransportFacts{Connection: "network", Protocol: "escpos"}, "escpos_tcp"},
		{"raw USB", printer.TransportFacts{Connection: "usb", Protocol: "raw"}, "raw_usb"},
		{"mislabelled network spooler", printer.TransportFacts{Connection: "network", Protocol: "spooler"}, ""},
		{"unknown destination", printer.TransportFacts{Connection: "unknown", Protocol: "unknown"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := printStatusTransport(tc.facts); got != tc.want {
				t.Fatalf("transport %q; want %q", got, tc.want)
			}
		})
	}
}

func TestPrintingAdmissionStatusIncludesSelectedTransport(t *testing.T) {
	var bodies []map[string]interface{}
	agent := newCapturingAgent(t, &bodies)
	if err := agent.updateJobStatusWithTransport(context.Background(), "job_ipp", "printing", "", "claim", "", "ipp"); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 1 || bodies[0]["transport"] != "ipp" {
		t.Fatalf("selected IPP transport missing from printing status: %+v", bodies)
	}
	if err := agent.updateJobStatus(context.Background(), "job_legacy", "printing", "", "claim", ""); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 {
		t.Fatalf("expected 2 status reports, got %d", len(bodies))
	}
	if _, ok := bodies[1]["transport"]; ok {
		t.Fatal("unknown transport must be omitted, not declared as verified")
	}
}
