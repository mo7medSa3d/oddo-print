package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/yaseir-agent/agent/internal/config"
)

// Read/write only the local E2E opt-in. Status never exposes the Agent secret.
// Changes use the protected, atomic, comment-preserving config editor.
func handleCaptureConfig(args []string, defaultPath string) error {
	fs := flag.NewFlagSet("capture-config", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	mode := fs.String("mode", "status", "status, enable or disable")
	configPath := fs.String("config", defaultPath, "protected Agent config")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("invalid capture-config arguments: %w", err)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected capture-config arguments")
	}
	switch *mode {
	case "status":
	case "enable":
		if err := config.SetE2ECaptureMode(*configPath, true); err != nil {
			return err
		}
	case "disable":
		if err := config.SetE2ECaptureMode(*configPath, false); err != nil {
			return err
		}
	default:
		return fmt.Errorf("capture-config mode must be status, enable or disable")
	}
	enabled, err := config.ReadE2ECaptureMode(*configPath)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Enabled bool `json:"enabled"`
	}{Enabled: enabled})
}
