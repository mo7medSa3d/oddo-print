package agent

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestValidateServerURLAcceptsHTTPS(t *testing.T) {
	if err := config.ValidateServerURL("https://gateway.example.com"); err != nil {
		t.Fatalf("expected HTTPS URL to be accepted, got %v", err)
	}
}

func TestValidateServerURLAcceptsHTTPDirectlyOnStaging(t *testing.T) {
	// Isolated staging branch: the shared validator accepts HTTP without a
	// process env flag (the Windows service cannot inherit shell env).
	for _, raw := range []string{"http://127.0.0.1:3000", "http://192.0.2.10:3000", "http://gateway.example.com"} {
		if err := config.ValidateServerURL(raw); err != nil {
			t.Fatalf("expected HTTP URL %q to be accepted on staging, got %v", raw, err)
		}
	}
}

func TestValidateServerURLRejectsNonHTTPSchemes(t *testing.T) {
	if err := config.ValidateServerURL("ftp://gateway.example.com/x"); err == nil {
		t.Fatal("expected non-HTTP(S) scheme to be rejected")
	}
}
func TestValidateServerURLRejectsCredentialsAndQuery(t *testing.T) {
	if err := config.ValidateServerURL("http://user:pass@gateway.example.com/"); err == nil {
		t.Fatal("expected embedded credentials to be rejected")
	}
	if err := config.ValidateServerURL("http://gateway.example.com/?x=1"); err == nil {
		t.Fatal("expected query strings to be rejected")
	}
}

func TestValidateServerURLRejectsEmptyHost(t *testing.T) {
	if err := config.ValidateServerURL("http:///no-host"); err == nil {
		t.Fatal("expected empty host to be rejected")
	}
}
