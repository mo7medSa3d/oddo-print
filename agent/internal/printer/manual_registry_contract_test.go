package printer

import (
	"path/filepath"
	"testing"
)

func TestRegisterManualCanonicalizesExecutableAliases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	rows, err := RegisterManual(path, DeviceInfo{
		Name:           "Kitchen TCP",
		ConnectionType: "tcp",
		Protocol:       "raw",
		Endpoint:       "10.20.30.40:9100",
		Enabled:        true,
	})
	if err != nil {
		t.Fatalf("register tcp alias: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one row, got %d", len(rows))
	}
	if rows[0].ConnectionType != "network" || rows[0].Type != "network" {
		t.Fatalf("tcp alias must persist as network, got connection=%q type=%q", rows[0].ConnectionType, rows[0].Type)
	}

	rows, err = RegisterManual(path, DeviceInfo{
		Name:           "Office Queue",
		ConnectionType: "windows_spooler",
		Protocol:       "windows_spooler",
		Endpoint:       "Office Queue",
		Enabled:        true,
	})
	if err != nil {
		t.Fatalf("register windows_spooler alias: %v", err)
	}
	var found *DeviceInfo
	for i := range rows {
		if rows[i].Name == "Office Queue" {
			found = &rows[i]
			break
		}
	}
	if found == nil {
		t.Fatal("canonical spooler row missing")
	}
	if found.ConnectionType != "spooler" || found.Protocol != "spooler" || found.SpoolerName != "Office Queue" {
		t.Fatalf("unexpected canonical spooler row: %+v", *found)
	}
}

func TestRegisterManualRejectsNonExecutableTransportContracts(t *testing.T) {
	cases := []DeviceInfo{
		{Name: "Unknown transport", ConnectionType: "bluetooth", Protocol: "raw", Endpoint: "10.0.0.2:9100", Enabled: true},
		{Name: "Wrong spooler protocol", ConnectionType: "spooler", Protocol: "raw", SpoolerName: "Office", Enabled: true},
		{Name: "IPPS without URL transport", ConnectionType: "network", Protocol: "ipps", Endpoint: "10.0.0.3:631", Enabled: true},
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			if _, err := RegisterManual(path, tc); err == nil {
				t.Fatalf("expected manual registration to reject %+v", tc)
			}
		})
	}
}

func TestRegisterManualNormalizesUSBSpoolerToDocumentTransport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	rows, err := RegisterManual(path, DeviceInfo{
		Name:           "USB Driver Queue",
		ConnectionType: "usb",
		SpoolerName:    "USB Driver Queue",
		Enabled:        true,
	})
	if err != nil {
		t.Fatalf("register USB spooler: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one row, got %d", len(rows))
	}
	if rows[0].ConnectionType != "spooler" || rows[0].Protocol != "spooler" {
		t.Fatalf("USB driver queue must use spooler transport, got %+v", rows[0])
	}
}
