package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCaptureConfigRejectsUnexpectedArgumentsAndModes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	for _, args := range [][]string{
		{"-mode", "invalid"},
		{"-mode", "enable", "extra"},
		{"-mode", "enable", "-unexpected"},
	} {
		if err := handleCaptureConfig(args, path); err == nil {
			t.Fatalf("accepted invalid capture config args: %v", args)
		}
	}
	err := handleCaptureConfig([]string{"-mode", "enable"}, path)
	if err == nil || !strings.Contains(err.Error(), "must exist") {
		t.Fatalf("missing Agent config was not rejected safely: %v", err)
	}
}
