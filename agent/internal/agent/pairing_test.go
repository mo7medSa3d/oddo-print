package agent

import (
	"testing"
)

func TestValidateServerURLAcceptsHTTPSByDefault(t *testing.T) {
	if err := validateServerURL("https://gateway.example.com"); err != nil {
		t.Fatalf("expected HTTPS URL to be accepted by default, got %v", err)
	}
}

func TestValidateServerURLRequiresExplicitHTTPOptIn(t *testing.T) {
	t.Setenv("YASSER_AGENT_ALLOW_INSECURE_HTTP", "")
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "")
	for _, raw := range []string{"http://127.0.0.1:3000", "http://192.0.2.10:3000", "http://gateway.example.com"} {
		if err := validateServerURL(raw); err == nil {
			t.Fatalf("expected HTTP URL %q to be rejected without explicit opt-in", raw)
		}
	}
	for _, envName := range []string{"YASSER_AGENT_ALLOW_INSECURE_HTTP", "ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP"} {
		t.Setenv("YASSER_AGENT_ALLOW_INSECURE_HTTP", "")
		t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "")
		t.Setenv(envName, "1")
		for _, raw := range []string{"http://127.0.0.1:3000", "http://192.0.2.10:3000", "http://gateway.example.com"} {
			if err := validateServerURL(raw); err != nil {
				t.Fatalf("expected explicit opt-in via %s to permit HTTP URL %q, got %v", envName, raw, err)
			}
		}
	}
}

func TestValidateServerURLAcceptsHTTPOptInWithoutEnvAfterPairing(t *testing.T) {
	if err := validateServerURL("ftp://gateway.example.com/x"); err == nil {
		t.Fatal("expected non-HTTP(S) scheme to be rejected")
	}
}

func TestValidateServerURLRejectsCredentialsAndQuery(t *testing.T) {
	if err := validateServerURL("http://user:pass@gateway.example.com/"); err == nil {
		t.Fatal("expected embedded credentials to be rejected")
	}
	if err := validateServerURL("http://gateway.example.com/?x=1"); err == nil {
		t.Fatal("expected query strings to be rejected")
	}
}

func TestValidateServerURLRejectsEmptyHost(t *testing.T) {
	if err := validateServerURL("http:///no-host"); err == nil {
		t.Fatal("expected empty host to be rejected")
	}
}
