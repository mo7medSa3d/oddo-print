package agent

import (
	"net/http"
	"testing"
)

// Direct Odoo Agent client carries Bearer id:secret and print payloads.
// By default it must not inherit HTTP_PROXY/HTTPS_PROXY; proxy-required
// egress networks opt in explicitly with YASEIR_AGENT_ALLOW_PROXY=1.
func TestOdooTransportUsesDirectDial(t *testing.T) {
	if odooDirectTransport.Proxy == nil {
		t.Fatal("Odoo transport must gate proxy env through odooProxyFunc")
	}
	if odooDirectTransport.DialContext == nil || odooDirectTransport.TLSHandshakeTimeout <= 0 {
		t.Fatal("Odoo transport needs bounded dial and TLS handshake")
	}
	req, _ := http.NewRequest("GET", "https://print.example.com/api/agent/jobs", nil)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("YASEIR_AGENT_ALLOW_PROXY", "")
	got, err := odooDirectTransport.Proxy(req)
	if err != nil || got != nil {
		t.Fatalf("default transport must bypass proxy env (got %v, err %v)", got, err)
	}
	t.Setenv("YASEIR_AGENT_ALLOW_PROXY", "1")
	got, err = odooDirectTransport.Proxy(req)
	if err != nil || got == nil {
		t.Fatalf("opt-in transport must honor proxy env (got %v, err %v)", got, err)
	}
}
