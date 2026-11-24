package agent

import (
	"context"
	"fmt"
	"testing"

	"github.com/yaseir-agent/agent/internal/printer"
)

type failedGeometryPrinter struct{ fakePrinter }

func (p *failedGeometryPrinter) PrinterGeometry(context.Context) (*printer.Geometry, error) {
	return nil, fmt.Errorf("measurement unavailable")
}
func (p *failedGeometryPrinter) ObservedCapabilities() map[string]interface{} { return nil }

func TestHeartbeatClearsUnobservedGeometryAndIPPMedia(t *testing.T) {
	a := heartbeatEvidenceAgent(map[string]printer.Printer{"p": &failedGeometryPrinter{}})
	pc := a.printerConfigs["p"]
	pc.Capabilities["geometry"] = map[string]interface{}{"printable_width_dots": 512}
	pc.Capabilities["ipp_capabilities"] = map[string]interface{}{"old": true}
	a.printerConfigs["p"] = pc
	entry := heartbeatEntry(t, a.printerStatusPayload(), "p")
	caps := entry["capabilities"].(map[string]interface{})
	if caps["geometry"] != nil || caps["ipp_capabilities"] != nil {
		t.Fatal("failed measurement refreshed stale printer capabilities")
	}
	if pc.Capabilities["geometry"] == nil || pc.Capabilities["ipp_capabilities"] == nil {
		t.Fatal("projection mutated durable config")
	}
}
