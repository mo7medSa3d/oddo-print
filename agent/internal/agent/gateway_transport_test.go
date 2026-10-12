package agent

import (
	"net/http"
	"testing"
)

// Gateway control-plane client carries Bearer id:secret and print payloads.
// By default it must not inherit HTTP_PROXY/HTTPS_PROXY; proxy-required
// egress networks opt in explicitly with YASEIR_AGENT_ALLOW_PROXY=1.
func TestGatewayTransportUsesDirectDial(t *testing.T) {
	if gatewayDirectTransport.Proxy == nil {
		t.Fatal("gateway transport must gate proxy env through gatewayProxyFunc")
	}
	if gatewayDirectTransport.DialContext == nil || gatewayDirectTransport.TLSHandshakeTimeout <= 0 {
		t.Fatal("gateway transport needs bounded dial and TLS handshake")
	}
	req, _ := http.NewRequest("GET", "https://print.example.com/api/agent/jobs", nil)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("YASEIR_AGENT_ALLOW_PROXY", "")
	got, err := gatewayDirectTransport.Proxy(req)
	if err != nil || got != nil {
		t.Fatalf("default transport must bypass proxy env (got %v, err %v)", got, err)
	}
	t.Setenv("YASEIR_AGENT_ALLOW_PROXY", "1")
	got, err = gatewayDirectTransport.Proxy(req)
	if err != nil || got == nil {
		t.Fatalf("opt-in transport must honor proxy env (got %v, err %v)", got, err)
	}
	if gatewayWSDialer.Proxy == nil {
		t.Fatal("websocket dialer must gate proxy env too")
	}
	got, err = gatewayWSDialer.Proxy(req)
	if err != nil || got == nil {
		t.Fatalf("opt-in websocket dialer must honor proxy env (got %v, err %v)", got, err)
	}
	t.Setenv("YASEIR_AGENT_ALLOW_PROXY", "")
	got, err = gatewayWSDialer.Proxy(req)
	if err != nil || got != nil {
		t.Fatalf("default websocket dialer must bypass proxy env (got %v, err %v)", got, err)
	}
}
