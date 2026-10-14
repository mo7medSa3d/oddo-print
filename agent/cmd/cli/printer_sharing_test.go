package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestPrinterSharingCLIRejectsInvalidArgumentsBeforeLocalMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	for _, args := range [][]string{
		{}, {"--id", "local"}, {"--shared", "false"},
		{"--id", "local", "--shared", "TRUE"}, {"--id", "local", "--shared", "1"},
		{"--id", "local", "--shared", "false", "extra"},
		{"--id", "local", "--shared", "false", "--unexpected"},
		{"--id", "-local", "--shared", "false"}, {"--id", " bad ", "--shared", "false"},
		{"--id", "bad\nID", "--shared", "false"}, {"--id", strings.Repeat("ق", 129), "--shared", "false"},
	} {
		var out bytes.Buffer
		if err := runPrinterSharing(args, path, &out); err == nil || out.Len() != 0 {
			t.Fatalf("invalid input acknowledged/mutated: %v %q", args, out.String())
		}
	}
	if _, err := os.Stat(config.PrinterSharingPath(path)); !os.IsNotExist(err) {
		t.Fatalf("invalid arguments created policy: %v", err)
	}
}

func TestPrinterSharingCLIWorksUnpairedOfflineWithExactDurableAck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	pc := config.PrinterConfig{ID: "local", Name: "Receipt", Type: "network", Protocol: "raw", Endpoint: "192.168.55.55:9100"}
	cfg := &config.Config{Printers: []config.PrinterConfig{pc}}
	if err := cfg.Save(path); err != nil {
		t.Fatal(err)
	}
	for _, shared := range []string{"false", "true"} {
		var out bytes.Buffer
		if err := runPrinterSharing([]string{"--id", "local", "--shared", shared, "-config", path}, "unused.yaml", &out); err != nil {
			t.Fatal(err)
		}
		var ack map[string]interface{}
		if err := json.Unmarshal(out.Bytes(), &ack); err != nil {
			t.Fatal(err)
		}
		if len(ack) != 2 || ack["printerId"] != "local" || ack["sharedWithGateway"] != (shared == "true") {
			t.Fatalf("invalid local sharing ACK: %s", out.String())
		}
		policy, err := config.LoadPrinterSharing(path)
		if err != nil {
			t.Fatal(err)
		}
		value, err := policy.Shared(pc, []config.PrinterConfig{pc})
		if err != nil || value != (shared == "true") {
			t.Fatalf("ACK preceded durable choice: %v %v", value, err)
		}
		loaded, err := config.Load(path)
		if err != nil || loaded.Agent.ID != "" || loaded.Agent.Secret != "" || loaded.Server.URL != "" {
			t.Fatalf("local sharing required/changed pairing: %+v %v", loaded, err)
		}
	}
}

func TestPrinterSharingCLIRejectsSetupCandidateAndCorruptPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := config.Ensure(path); err != nil {
		t.Fatal(err)
	}
	candidate := printer.DeviceInfo{ID: "candidate", Name: "POS80", SpoolerName: "POS80", ConnectionType: "spooler", Protocol: "spooler", Status: "unknown", Capabilities: map[string]interface{}{"verification": "candidate_only", "candidate_reason": "spooler_session_unverified"}}
	data, err := json.Marshal([]printer.DeviceInfo{candidate})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.RegistryPath(path), data, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runPrinterSharing([]string{"--id", "candidate", "--shared", "true"}, path, &out); err == nil || out.Len() != 0 {
		t.Fatalf("candidate became shared via local flag: %s %v", out.String(), err)
	}
	pc := config.PrinterConfig{ID: "local", Name: "Local", Type: "network", Protocol: "raw", Endpoint: "192.168.55.55:9100"}
	if err := (&config.Config{Printers: []config.PrinterConfig{pc}}).Save(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.PrinterSharingPath(path), []byte("malformed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runPrinterSharing([]string{"--id", "local", "--shared", "true"}, path, &out); err == nil || out.Len() != 0 {
		t.Fatal("corrupt policy silently replaced/acknowledged")
	}
}
