package agent

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestValidateServerURLAcceptsHTTPSByDefault(t *testing.T) {
	if err := config.ValidateServerURL("https://gateway.example.com"); err != nil {
		t.Fatalf("expected HTTPS URL to be accepted by default, got %v", err)
	}
}

func TestValidateServerURLRequiresExplicitHTTPOptIn(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "")
	for _, raw := range []string{"http://127.0.0.1:3000", "http://192.0.2.10:3000", "http://gateway.example.com"} {
		if err := config.ValidateServerURL(raw); err == nil {
			t.Fatalf("expected HTTP URL %q to be rejected without explicit opt-in", raw)
		}
	}
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	for _, raw := range []string{"http://127.0.0.1:3000", "http://192.0.2.10:3000", "http://gateway.example.com"} {
		if err := config.ValidateServerURL(raw); err != nil {
			t.Fatalf("expected explicit opt-in to permit HTTP URL %q, got %v", raw, err)
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

// A pairing-code response must be one complete bounded JSON object BEFORE the
// Agent persists the returned long-lived credential to its secure store.
func TestRegisterRejectsUntrustedGatewayResponseBeforeSavingCredentials(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	for name, body := range map[string]string{
		"trailing garbage":  `{"agentId":"agent-one","secret":"secret-value"}BROKEN`,
		"second JSON value": `{"agentId":"agent-one","secret":"secret-value"}{"agentId":"agent-two"}`,
		"over byte limit":   `{"agentId":"agent-one","secret":"secret-value"}` + strings.Repeat(" ", (1<<20)+1),
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/agent/register" {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, body)
			}))
			defer server.Close()
			cfgPath := filepath.Join(t.TempDir(), "config.yaml")
			if err := Register(server.URL, "ABCDEF", cfgPath); err == nil {
				t.Fatal("untrusted registration response persisted Agent credentials")
			}
			if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
				t.Fatalf("untrusted registration response created config: stat error=%v", err)
			}
		})
	}
}

// Complete, bounded registration must still initialize the canonical sealed
// configuration successfully (accepting trailing RFC 8259 JSON whitespace).
func TestRegisterAcceptsCompleteGatewayResponse(t *testing.T) {
	t.Setenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"agentId\":\"agent-one\",\"secret\":\"secret-value\"} \n")
	}))
	defer server.Close()
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := Register(server.URL, "ABCDEF", cfgPath); err != nil {
		t.Fatalf("valid Gateway response failed pairing: %v", err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil || cfg.Agent.ID != "agent-one" || cfg.Agent.Secret != "secret-value" {
		t.Fatalf("valid registration did not persist sealed credentials: err=%v", err)
	}
}
