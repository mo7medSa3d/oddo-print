package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestPrinterMutationsRejectMalformedArgumentsWithoutChangingRegistry(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "yaseir-agent-cli")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build actual CLI: %v\n%s", err, output)
	}
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"remove_extra_argument", []string{"remove", "existing", "--dry-run"}},
		{"remove_missing_config", []string{"remove", "existing", "--config"}},
		{"add_invalid_enabled", []string{"add", "--id", "new", "--name", "New", "--type", "network", "--endpoint", "10.0.0.11:9100", "--protocol", "raw", "--enabled", "flase"}},
		{"add_unexpected_positional", []string{"add", "--id", "new", "--name", "New", "--type", "network", "--endpoint", "10.0.0.11:9100", "--protocol", "raw", "unexpected"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			configPath := filepath.Join(t.TempDir(), "config.yaml")
			if err := config.Ensure(configPath); err != nil {
				t.Fatal(err)
			}
			registryPath := config.RegistryPath(configPath)
			if err := printer.SaveRegistry(registryPath, []printer.DeviceInfo{{ID: "existing", Name: "Existing", ConnectionType: "network", Protocol: "raw", Endpoint: "10.0.0.10:9100", Enabled: false}}); err != nil {
				t.Fatal(err)
			}
			original, err := os.ReadFile(registryPath)
			if err != nil {
				t.Fatal(err)
			}
			args := append([]string{"-config", configPath, "printers"}, tc.args...)
			output, runErr := exec.Command(binary, args...).CombinedOutput()
			current, readErr := os.ReadFile(registryPath)
			if runErr == nil || readErr != nil || !bytes.Equal(current, original) {
				t.Fatalf("malformed CLI changed printer authority or reported success: exit=%v read=%v unchanged=%t\n%s", runErr, readErr, bytes.Equal(current, original), output)
			}
		})
	}
}
