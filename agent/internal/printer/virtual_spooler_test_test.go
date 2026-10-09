package printer

import (
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestVirtualSpoolerRequiresManagerDesiredFlagAndMatchingOSQueue(t *testing.T) {
	pc := config.PrinterConfig{ID: "printer-virtual", Type: "spooler", Protocol: "spooler", PrinterType: "virtual", SpoolerName: "Microsoft Print to PDF", Capabilities: map[string]interface{}{"virtual_spooler_test": true}}
	installed := []DeviceInfo{{Name: "Microsoft Print to PDF", SpoolerName: "Microsoft Print to PDF", PrinterType: "virtual", ConnectionType: "spooler", Protocol: "spooler", Capabilities: map[string]interface{}{"port_name": "PORTPROMPT:"}}}
	if err := virtualSpoolerTestQueue(pc, installed); err != nil {
		t.Fatalf("approved installed PDF queue: %v", err)
	}
	pc.Capabilities["virtual_spooler_test"] = false
	if virtualSpoolerTestQueue(pc, installed) == nil {
		t.Fatal("unapproved queue must be rejected")
	}
	pc.Capabilities["virtual_spooler_test"] = true
	if err := virtualSpoolerTestQueue(pc, nil); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("not installed: %v", err)
	}
	pc.SpoolerName = "Fax"
	if virtualSpoolerTestQueue(pc, installed) == nil {
		t.Fatal("fax queue must be refused")
	}
	pc.SpoolerName = "HP Laser (redirected 3)"
	if virtualSpoolerTestQueue(pc, installed) == nil {
		t.Fatal("redirected queue must be refused")
	}
	pc.SpoolerName = "Microsoft Print to PDF"
	installed[0].PrinterType = "redirected"
	if virtualSpoolerTestQueue(pc, installed) == nil {
		t.Fatal("OS classification must reject redirected queue")
	}
}
