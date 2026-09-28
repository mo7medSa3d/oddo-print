package agent

import (
	"testing"

	"github.com/yasser-agent/agent/internal/config"
)

func TestValidateServerURLAcceptsHTTPSByDefault(t *testing.T) {
	if err := config.ValidateServerURL("https://gateway.example.com"); err != nil {
		t.Fatalf("expected HTTPS URL to be accepted by default, got %v", err)
	}
}

func TestValidateServerURLAcceptsHTTPAndHTTPSOnStaging(t *testing.T) {
	// The isolated staging branch accepts HTTP directly; this must also work
	// for the Windows service because it does not inherit the Manager process env.
	t.Setenv("YASSER_AGENT_ALLOW_INSECURE_HTTP", "")
	for _, raw := range []string{
		"http://127.0.0.1:3000",
		"http://192.0.2.10:3000",
		"http://gateway.example.com:3000",
		"https://gateway.example.com",
		"https://192.168.1.50:3443",
	} {
		if err := config.ValidateServerURL(raw); err != nil {
			t.Fatalf("expected HTTP(S) staging URL %q to be accepted without opt-in, got %v", raw, err)
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
