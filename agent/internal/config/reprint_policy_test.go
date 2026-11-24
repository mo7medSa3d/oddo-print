package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultConfigDisablesCrashReprint(t *testing.T) {
	cfg := defaultConfig()
	if cfg.ReprintAfterCrashEnabled() {
		t.Fatal("crash reprint must be opt-in by default")
	}
}

func TestLoadMissingConfigUsesSafeCrashPolicy(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ReprintAfterCrashEnabled() {
		t.Fatal("missing config must use the safe no-reprint default")
	}
}

func TestLegacyCrashReprintFlagCannotEnableUnknownReprint(t *testing.T) {
	cfg := defaultConfig()
	yes := true
	cfg.Agent.ReprintAfterCrash = &yes
	if cfg.ReprintAfterCrashEnabled() {
		t.Fatal("legacy true must never authorize another uncertain physical attempt")
	}
}

func TestLegacyCrashReprintYAMLStillLoadsWithoutAuthorizingReprint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  url: https://gateway.example.test\nagent:\n  reprint_after_crash: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("legacy configuration must remain readable: %v", err)
	}
	if cfg.Agent.ReprintAfterCrash == nil || !*cfg.Agent.ReprintAfterCrash {
		t.Fatal("legacy parsed value was silently rewritten")
	}
	if cfg.ReprintAfterCrashEnabled() {
		t.Fatal("legacy YAML must not authorize reprinting unknown output")
	}
}
