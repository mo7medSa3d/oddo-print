package printer

import (
	"net"
	"testing"
)

// An open TCP 9100 socket does not establish that a RAW/ZPL/TSPL device is
// ready or that paper output is possible. Status evidence must not invent it.
func TestUnidirectionalNetworkPrinterStatusDoesNotInventHardwareReadiness(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	for _, protocol := range []string{"raw", "zpl", "tspl", "unknown"} {
		p := &NetworkPrinter{Address: ln.Addr().String(), Protocol: protocol}
		if got := p.Status(); got != "unknown" {
			t.Errorf("%s: bare TCP listener yielded %q, want unknown", protocol, got)
		}
	}
	ln.Close()
	p := &NetworkPrinter{Address: ln.Addr().String(), Protocol: "zpl"}
	if got := p.Status(); got != "offline" {
		t.Errorf("refused TCP endpoint yielded %q, want offline", got)
	}
}
