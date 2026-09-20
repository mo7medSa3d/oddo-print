package config

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestValidatePrinterConfigRejectsUnsafePrinterDestinations(t *testing.T) {
	cases := []PrinterConfig{
		{ID: "public", Name: "Public", Type: "network", Endpoint: "8.8.8.8:9100", Protocol: "raw"},
		{ID: "loopback", Name: "Loopback", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
		{ID: "hostname", Name: "Hostname", Type: "network", Endpoint: "printer.local:9100", Protocol: "raw"},
		{ID: "public-ipp", Name: "Public IPP", Type: "ipp", Endpoint: "https://8.8.8.8:631/ipp/print", Protocol: "ipp"},
		{ID: "loopback-ipp", Name: "Loopback IPP", Type: "ipp", Endpoint: "http://127.0.0.1:631/ipp/print", Protocol: "ipp"},
	}
	for _, c := range cases {
		if err := ValidatePrinterConfig(c); err == nil {
			t.Fatalf("expected unsafe destination rejection for %+v", c)
		}
	}
}

func TestValidatePrinterConfig(t *testing.T) {
	ok := PrinterConfig{ID: "printer_kitchen", Name: "Kitchen", Type: "network", Endpoint: "192.168.1.50:9100", Protocol: "escpos"}
	if err := ValidatePrinterConfig(ok); err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
	bad := []PrinterConfig{
		{ID: "", Name: "x", Type: "network", Endpoint: "1.1.1.1:9100"},
		{ID: "bad id", Name: "x", Type: "network", Endpoint: "1.1.1.1:9100"},
		{ID: "p1", Name: "", Type: "network", Endpoint: "1.1.1.1:9100"},
		{ID: "p1", Name: "x", Type: "serial", Endpoint: "1.1.1.1:9100"},
		{ID: "p1", Name: "x", Type: "network", Endpoint: "notanipport"},
		{ID: "p1", Name: "x", Type: "network", Endpoint: "192.168.1.50:9101", Protocol: "raw"},
	}
	for i, c := range bad {
		if err := ValidatePrinterConfig(c); err == nil {
			t.Fatalf("case %d expected error for %+v", i, c)
		}
	}
}

func TestValidatePrinterConfigRejectsContradictoryTransportProtocols(t *testing.T) {
	cases := []PrinterConfig{
		{ID: "ipp-raw", Name: "IPP", Type: "ipp", Endpoint: "ipp://192.168.1.60/ipp/print", Protocol: "raw"},
		{ID: "ipps-ipp", Name: "IPPS", Type: "ipps", Endpoint: "ipps://192.168.1.60/ipp/print", Protocol: "ipp"},
		{ID: "spooler-raw", Name: "Spooler", Type: "spooler", SpoolerName: "HP", Protocol: "raw"},
		{ID: "network-ipps", Name: "Network", Type: "network", Endpoint: "192.168.1.60:9100", Protocol: "ipps"},
		{ID: "usb-ipp", Name: "USB IPP", Type: "usb", Protocol: "ipp", USBVID: "1234", USBPID: "5678", Endpoint: `\\\\?\\usb#device`},
		{ID: "usb-ipps", Name: "USB IPPS", Type: "usb", Protocol: "ipps", USBVID: "1234", USBPID: "5678", Endpoint: `\\\\?\\usb#device`},
		{ID: "usb-spooler", Name: "USB Spooler", Type: "usb", Protocol: "spooler", USBVID: "1234", USBPID: "5678", Endpoint: `\\\\?\\usb#device`},
		{ID: "ipps-http", Name: "IPPS HTTP", Type: "ipps", Endpoint: "http://192.168.1.60:631/ipp/print", Protocol: "ipps"},
		{ID: "ipp-creds", Name: "IPP Credentials", Type: "ipp", Endpoint: "http://user:pass@192.168.1.60:631/ipp/print", Protocol: "ipp"},
	}
	for _, tc := range cases {
		if err := ValidatePrinterConfig(tc); err == nil {
			t.Fatalf("expected contradictory transport/protocol rejection for %+v", tc)
		}
	}
}

func TestValidatePrinterConfigRejectsNonDeviceUSBEndpoint(t *testing.T) {
	p := PrinterConfig{
		ID:       "usb-bad-path",
		Name:     "USB Bad Path",
		Type:     "usb",
		Protocol: "raw",
		USBVID:   "1234",
		USBPID:   "5678",
		Endpoint: "HP LaserJet",
	}
	if err := ValidatePrinterConfig(p); err == nil {
		t.Fatal("expected direct USB endpoint to require a Windows device path")
	}
}

func TestValidatePrinterConfigAllowsUSBSpoolerWithoutVIDPID(t *testing.T) {
	p := PrinterConfig{
		ID:          "usb-spooler",
		Name:        "USB Queue",
		Type:        "usb",
		Protocol:    "spooler",
		SpoolerName: "Receipt Printer",
	}
	if err := ValidatePrinterConfig(p); err != nil {
		t.Fatalf("USB printer backed by a Windows spooler should not require VID/PID: %v", err)
	}
}

func TestValidatePrinterConfigAllowsCompatibleTransportProtocols(t *testing.T) {
	cases := []PrinterConfig{
		{ID: "network-raw", Name: "RAW", Type: "network", Endpoint: "192.168.1.60:9100", Protocol: "raw"},
		{ID: "network-ipp", Name: "Network IPP", Type: "network", Endpoint: "192.168.1.60:631", Protocol: "ipp"},
		{ID: "ipp", Name: "IPP", Type: "ipp", Endpoint: "ipp://192.168.1.60/ipp/print", Protocol: "ipp"},
		{ID: "ipps", Name: "IPPS", Type: "ipps", Endpoint: "ipps://192.168.1.60/ipp/print", Protocol: "ipps"},
		{ID: "spooler", Name: "Spooler", Type: "spooler", SpoolerName: "HP", Protocol: "spooler"},
	}
	for _, tc := range cases {
		if err := ValidatePrinterConfig(tc); err != nil {
			t.Fatalf("expected compatible transport/protocol pair for %+v, got %v", tc, err)
		}
	}
}

func TestUSBSpoolerConfigUsesSpoolerTransport(t *testing.T) {
	p := PrinterConfig{ID: "usb-spooler", Name: "HP", Type: "usb", SpoolerName: "HP LaserJet"}
	if got := p.NormalizedType(); got != "spooler" {
		t.Fatalf("expected USB printer with spooler queue to normalize to spooler, got %q", got)
	}
	if got, err := p.NormalizedProtocol(); err != nil || got != "spooler" {
		t.Fatalf("expected USB spooler config to normalize protocol to spooler, got %q err=%v", got, err)
	}
	if err := ValidatePrinterConfig(p); err != nil {
		t.Fatalf("expected USB spooler config to validate, got %v", err)
	}
}

func TestDefaultConfigPathProgramData(t *testing.T) {
	orig := os.Getenv("PROGRAMDATA")
	t.Setenv("PROGRAMDATA", `C:\ProgramData`)
	got := DefaultConfigPath()
	expected := filepath.Join(`C:\ProgramData`, "OdooPrintAgent", "config.yaml")
	if got != expected {
		if filepath.Base(got) != "config.yaml" {
			t.Fatalf("expected config.yaml suffix, got %q", got)
		}
	}
	_ = orig
}

func TestConfigValidate(t *testing.T) {
	c := &Config{}
	c.Server.URL = "https://example.com"
	c.Printers = []PrinterConfig{{ID: "p1", Name: "P1", Type: "network", Protocol: "raw", Endpoint: "10.0.0.1:9100"}}
	if err := c.Validate(); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
	// An undeclared protocol on a network printer is a validation error:
	// the agent must never invent "raw" for an unconfigured device.
	cNoProto := &Config{}
	cNoProto.Server.URL = "https://example.com"
	cNoProto.Printers = []PrinterConfig{{ID: "p2", Name: "P2", Type: "network", Endpoint: "10.0.0.1:9100"}}
	if err := cNoProto.Validate(); err == nil {
		t.Fatalf("expected error for undeclared protocol")
	}
	c.Server.URL = "htp://bad"
	if err := c.Validate(); err == nil {
		t.Fatalf("expected invalid url")
	}
}

func TestConfigValidateRequiresHTTPSByDefault(t *testing.T) {
	// Production/default behavior is fail-closed: HTTP is rejected unless
	// explicitly opted into for isolated development/test environments.
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "")
	for _, raw := range []string{
		"http://127.0.0.1:3000",
		"http://192.168.1.50:3000",
		"http://10.0.0.5:3000",
		"http://gateway.example.com",
	} {
		c := &Config{}
		c.Server.URL = raw
		if err := c.Validate(); err == nil {
			t.Fatalf("expected HTTP URL %q to be rejected without explicit opt-in", raw)
		}
	}
}

func TestConfigValidateAcceptsHTTPWithExplicitDevelopmentOptIn(t *testing.T) {
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "1")
	for _, raw := range []string{
		"http://127.0.0.1:3000",
		"http://192.168.1.50:3000",
		"http://10.0.0.5:3000",
		"http://gateway.example.com",
	} {
		c := &Config{}
		c.Server.URL = raw
		if err := c.Validate(); err != nil {
			t.Fatalf("expected explicit development opt-in to permit %q, got %v", raw, err)
		}
	}
}

func TestConfigValidateAcceptsHTTPSByDefault(t *testing.T) {
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "")
	for _, raw := range []string{
		"https://127.0.0.1:3000",
		"https://192.168.1.50:3000",
		"https://gateway.example.com",
	} {
		c := &Config{}
		c.Server.URL = raw
		if err := c.Validate(); err != nil {
			t.Fatalf("expected HTTPS URL %q to be valid, got %v", raw, err)
		}
	}
}

func TestConfigSaveSealsSecretOutsideYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	c := &Config{}
	c.Server.URL = "https://example.com"
	c.Agent.ID = "agent_1"
	c.Agent.Secret = "super-secret-value"
	c.Agent.Name = "test"
	if err := c.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read yaml: %v", err)
	}
	if bytes.Contains(raw, []byte("super-secret-value")) {
		t.Fatalf("secret must not be persisted in plaintext YAML")
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Agent.Secret != "super-secret-value" {
		t.Fatalf("expected secret to be restored from the sealed store, got %q", loaded.Agent.Secret)
	}
}

func TestConfigLoadMigratesLegacyPlaintextSecret(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	legacy := "server:\n  url: https://example.com\nagent:\n  id: agent_1\n  secret: legacy-plaintext\n  name: test\n"
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Agent.Secret != "legacy-plaintext" {
		t.Fatalf("secret not loaded: %q", loaded.Agent.Secret)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-read yaml: %v", err)
	}
	if bytes.Contains(raw, []byte("legacy-plaintext")) {
		t.Fatalf("legacy plaintext secret should have been migrated out of the YAML")
	}

	again, err := Load(path)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if again.Agent.Secret != "legacy-plaintext" {
		t.Fatalf("secret not restored after migration: %q", again.Agent.Secret)
	}
}

func TestConfigValidateAllowsHTTPWhenPersistedOptInIsSet(t *testing.T) {
	t.Setenv("YASSER_AGENT_ALLOW_INSECURE_HTTP", "")
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "")

	cfg := defaultConfig()
	cfg.Server.URL = "http://192.0.2.10:8080"
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected HTTP without an explicit opt-in to be rejected")
	}

	cfg.Server.AllowInsecureHTTP = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected persisted HTTP opt-in to allow the isolated test URL, got %v", err)
	}
}

func TestConfigSaveLoadPreservesHTTPOptIn(t *testing.T) {
	cfg := defaultConfig()
	cfg.Server.URL = "http://192.0.2.10:8080"
	cfg.Server.AllowInsecureHTTP = true
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := cfg.Save(path); err != nil {
		t.Fatalf("save config: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if loaded.Server.URL != cfg.Server.URL {
		t.Fatalf("server URL mismatch after round-trip: got %q want %q", loaded.Server.URL, cfg.Server.URL)
	}
	if !loaded.Server.AllowInsecureHTTP {
		t.Fatal("HTTP opt-in must survive config round-trip for service restarts")
	}
}
