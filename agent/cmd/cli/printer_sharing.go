package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func handlePrinterSharing(args []string, defaultPath string) error {
	return runPrinterSharing(args, defaultPath, os.Stdout)
}

func runPrinterSharing(args []string, defaultPath string, output io.Writer) error {
	fs := flag.NewFlagSet("printers-share", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	id := fs.String("id", "", "actual local printer ID")
	sharedValue := fs.String("shared", "", "true or false")
	path := fs.String("config", defaultPath, "protected Agent config")
	_ = fs.Bool("json", true, "JSON output (always enabled)")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("invalid printers-share arguments: %w", err)
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected printers-share arguments")
	}
	if *id == "" || len(*id) > 256 || !utf8.ValidString(*id) || strings.TrimSpace(*id) != *id || strings.HasPrefix(*id, "-") || strings.ContainsFunc(*id, unicode.IsControl) {
		return fmt.Errorf("printers-share requires a valid local --id")
	}
	if *sharedValue != "true" && *sharedValue != "false" {
		return fmt.Errorf("printers-share --shared must be exactly true or false")
	}
	// This local choice deliberately needs neither pairing nor a reachable
	// Gateway. Existing protected filesystem ACLs require local Admin writes.
	if err := config.Ensure(*path); err != nil {
		return err
	}
	cfg, err := config.Load(*path)
	if err != nil {
		return err
	}
	registryPath := config.RegistryPath(*path)
	devices, err := printer.ListPrinters(cfg, registryPath)
	if err != nil {
		return err
	}
	selected, err := printer.SelectSharingPrinter(*id, devices)
	if err != nil {
		return err
	}
	known, err := printer.LocalSharingBindings(cfg, registryPath)
	if err != nil {
		return err
	}
	// Fast local enumeration is read-only: its actual INFO2 share pair may
	// not yet exist in printers.json when an offline/unpaired user chooses.
	for _, device := range devices {
		if device.ID != selected.ID {
			continue
		}
		bindings, err := printer.SharingBindingsForDevice(device)
		if err != nil {
			return err
		}
		known = append(known, bindings...)
	}
	shared := *sharedValue == "true"
	if err := config.SetPrinterSharing(*path, selected, known, shared); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(struct {
		PrinterID         string `json:"printerId"`
		SharedWithGateway bool   `json:"sharedWithGateway"`
	}{selected.ID, shared})
}
