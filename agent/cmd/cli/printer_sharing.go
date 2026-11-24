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

func handlePrinterVisibility(args []string, defaultPath string) error {
	return runPrinterVisibility(args, defaultPath, os.Stdout)
}

func runPrinterVisibility(args []string, defaultPath string, output io.Writer) error {
	fs := flag.NewFlagSet("printers-share", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	id := fs.String("id", "", "actual local printer ID")
	sharedValue := fs.String("shared", "", "true or false")
	path := fs.String("config", defaultPath, "protected Agent config")
	allowVirtual := fs.Bool("allow-virtual", false, "allow sharing explicitly selected virtual/software queues")
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
	shared := *sharedValue == "true"
	// Always allow unsharing (--shared false) a printable virtual printer in
	// inventory so operators are never trapped unable to hide one; sharing a
	// virtual queue (--shared true) still requires explicit --allow-virtual.
	selected, err := printer.SelectSharingPrinterWithOptions(*id, devices, *allowVirtual || !shared, cfg)
	if err != nil {
		// The reason (candidate, virtual, redirected, not-runtime) is
		// part of the error now: a greyed-out Desktop Share button used
		// to leave operators retrying a toggle that can never succeed
		// for this row. The refusal itself is unchanged — only the
		// explanation travels with it, and nothing is written.
		return fmt.Errorf("cannot change sharing for printer %q: %w", *id, err)
	}
	known, err := printer.LocalSharingBindings(cfg, registryPath)
	if err != nil {
		return err
	}
	// Fast local enumeration is read-only: actual INFO2 share pairs may
	// not yet exist in printers.json when an offline/unpaired user chooses.
	// Require valid bindings for the selected printer and collect other
	// fresh device bindings best-effort so share-group aliases stay in sync.
	for _, device := range devices {
		bindings, err := printer.SharingBindingsForDevice(device, cfg)
		if err != nil {
			if device.ID == selected.ID {
				return err
			}
			continue
		}
		known = append(known, bindings...)
	}
	if err := config.SetPrinterVisibility(*path, selected, known, shared); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(struct {
		PrinterID         string `json:"printerId"`
		SharedWithGateway bool   `json:"availableToOdoo"`
	}{selected.ID, shared})
}
