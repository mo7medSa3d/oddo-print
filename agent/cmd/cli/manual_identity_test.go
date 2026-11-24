package main

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func TestAddPrinterHelperCannotRebindGeneratedHardwareID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := printer.DeviceInfo{Name: "First USB printer", PrinterType: "physical", ConnectionType: "usb", Protocol: "raw",
		Endpoint: `\\?\usb#vid_1234&pid_5678#device-a`, USBVID: "1234", USBPID: "5678", USBSerial: "same-serial", Enabled: false}
	prior.ID = printer.StableIDForDevice(prior)
	if err := printer.SaveRegistry(path, []printer.DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	info := struct {
		ID             string
		Name           string
		ConnectionType string
		PrinterType    string
		Endpoint       string
		Protocol       string
		SpoolerName    string
		USBVID         string
		USBPID         string
		USBSerial      string
		Enabled        bool
		Capabilities   map[string]interface{}
	}{Name: "Second USB printer", ConnectionType: "usb", PrinterType: "physical", Protocol: "raw",
		Endpoint: `\\?\usb#vid_1234&pid_5678#device-b`, USBVID: "1234", USBPID: "5678", USBSerial: "same-serial", Enabled: true}
	if err := addPrinterHelper(&config.Config{}, path, info); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(path)
	if err != nil || len(rows) != 2 {
		t.Fatalf("distinct selected endpoint replaced existing registration: %+v, %v", rows, err)
	}
	for _, row := range rows {
		if row.ID == prior.ID && (row.Endpoint != prior.Endpoint || row.Enabled) {
			t.Fatalf("existing ID or disablement was reassigned: %+v", row)
		}
	}
}
