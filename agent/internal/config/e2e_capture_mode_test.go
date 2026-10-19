package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpdateE2ECaptureModePreservesOtherYAMLAndSealedSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	cfg := defaultConfig()
	cfg.Server.URL = "https://print.example.com"
	cfg.Agent.ID = "agt_ABCDEFGH"
	cfg.Agent.Name = "Test Windows Agent"
	cfg.Agent.Secret = "capture-only-test-secret"
	if err := cfg.Save(path); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	original := string(raw) + "\n# keep this setting untouched\ncustom_future_setting:\n  present: true\n"
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := SetE2ECaptureMode(path, true); err != nil {
		t.Fatal(err)
	}
	enabled, err := ReadE2ECaptureMode(path)
	if err != nil || !enabled {
		t.Fatalf("enabled=%t err=%v", enabled, err)
	}
	raw, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "custom_future_setting:") ||
		!strings.Contains(string(raw), "# keep this setting untouched") {
		t.Fatal("capture mode edit discarded unrelated YAML")
	}
	if strings.Contains(string(raw), "capture-only-test-secret") {
		t.Fatal("agent secret leaked into plaintext config")
	}
	readBack, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if readBack.Agent.Secret != "capture-only-test-secret" ||
		readBack.Agent.ID != cfg.Agent.ID || readBack.Server.URL != cfg.Server.URL {
		t.Fatal("Agent pairing metadata changed")
	}
	if err := SetE2ECaptureMode(path, false); err != nil {
		t.Fatal(err)
	}
	enabled, err = ReadE2ECaptureMode(path)
	if err != nil || enabled {
		t.Fatalf("enabled=%t err=%v", enabled, err)
	}
}

func TestUpdateE2ECaptureModeRefusesMissingAndUnpairedConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := SetE2ECaptureMode(path, true); err == nil {
		t.Fatal("missing config accepted")
	}
	if err := Ensure(path); err != nil {
		t.Fatal(err)
	}
	if err := SetE2ECaptureMode(path, true); err == nil {
		t.Fatal("unpaired config accepted")
	}
}
