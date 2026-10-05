package printer

import (
	"path/filepath"
	"testing"
)

func TestLoadRegistryPrintersMissingFileIsFirstRunState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	got, err := LoadRegistryPrinters(path)
	if err != nil {
		t.Fatalf("missing registry should not be an error, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil printer slice for missing registry, got %#v", got)
	}
}

func TestRegisterManualUSBWithSpoolerQueueDerivesSpoolerProtocol(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	info := DeviceInfo{
		ID:             "usb_spooler_1",
		Name:           "USB Receipt",
		PrinterType:    "thermal",
		ConnectionType: "usb",
		SpoolerName:    "Receipt Printer",
		Endpoint:       `\\?\usb#device`,
		Status:         "unknown",
		Enabled:        true,
	}
	rows, err := RegisterManual(path, info)
	if err != nil {
		t.Fatalf("USB printer with an explicit spooler queue should register without an explicit protocol: %v", err)
	}
	if len(rows) != 1 || rows[0].Protocol != "spooler" {
		t.Fatalf("expected derived spooler protocol, got %#v", rows)
	}
}

func TestRegisterManualUSBWithoutSpoolerStillRequiresProtocol(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	_, err := RegisterManual(path, DeviceInfo{
		ID:             "usb_direct_1",
		Name:           "USB Receipt",
		PrinterType:    "thermal",
		ConnectionType: "usb",
		USBVID:         "1234",
		USBPID:         "5678",
		Status:         "unknown",
		Enabled:        true,
	})
	if err == nil {
		t.Fatal("direct USB without spooler queue must require an explicit protocol")
	}
}

func TestLoadRegistryPrintersDoesNotReplayStaleStatus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	if err := SaveRegistry(path, []DeviceInfo{{
		ID:             "stale_status",
		Name:           "Office Printer",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		SpoolerName:    "Office Printer",
		Endpoint:       "Office Printer",
		Status:         "offline",
		Enabled:        true,
	}}); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}

	rows, err := LoadRegistryPrinters(path)
	if err != nil {
		t.Fatalf("LoadRegistryPrinters: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one persisted printer, got %#v", rows)
	}
	if rows[0].Status != "unknown" {
		t.Fatalf("persisted status has no freshness evidence and must reload as unknown, got %q", rows[0].Status)
	}
	if rows[0].SpoolerName != "Office Printer" || rows[0].Protocol != "spooler" {
		t.Fatalf("status normalization must preserve inventory/configuration fields, got %#v", rows[0])
	}
}
