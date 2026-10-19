package config

import (
	"strings"
	"testing"
)

// A malformed IPP URL may contain userinfo; errors can surface in logs and
// desktop diagnostics and must never echo it, even though credentials in
// printer config are deliberately unsupported.
func TestValidatePrinterEndpointRedactsMalformedIPPUserinfo(t *testing.T) {
	for _, endpoint := range []string{
		"ipp://operator:shouldNeverAppear123@[invalid",
		"ipps://operator:shouldNeverAppear123@%zz/ipp/print",
		"ipp://operator:shouldNeverAppear123@192.168.1.55/ipp/print",
	} {
		cfg := PrinterConfig{ID: "printer-1", Type: "ipp", Protocol: "ipp", Endpoint: endpoint}
		err := ValidatePrinterEndpoint(cfg)
		if err == nil {
			t.Fatalf("invalid credential-bearing endpoint accepted")
		}
		if strings.Contains(err.Error(), "shouldNeverAppear123") || strings.Contains(err.Error(), "operator") {
			t.Fatalf("validation error revealed credentials: %v", err)
		}
	}
}
