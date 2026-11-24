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

func TestManualRegistrationCannotInventObservedIPPIdentityOrGeometry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	const claimed = "urn:uuid:11111111-2222-3333-4444-555555555555"
	rows, err := RegisterManual(path, DeviceInfo{
		Name: "Unprobed IPP printer", ConnectionType: "ipp", Protocol: "ipp",
		Endpoint: "ipp://192.168.1.20/ipp/print", PrinterType: "physical",
		Enabled: true, Capabilities: map[string]interface{}{
			"ipp_printer_uuid": claimed,
			"uuid":             claimed,
			"printer_uuid":     claimed,
			"ipp_capabilities": map[string]interface{}{
				"printer_uuid":     claimed,
				"document_formats": []interface{}{"application/pdf"},
			},
			"geometry":                 map[string]interface{}{"printer_id": "injected", "source": "ipp"},
			"operational_verification": map[string]interface{}{"version": 1},
		},
	})
	if err != nil || len(rows) != 1 {
		t.Fatalf("manual registration failed: %v rows=%+v", err, rows)
	}
	caps := rows[0].Capabilities
	if uuid := verifiedIPPUUIDFromCapabilities(caps); uuid != "" {
		t.Fatalf("manual fields were accepted as a verified IPP printer UUID: %q", uuid)
	}
	if caps["uuid"] != nil || caps["printer_uuid"] != nil ||
		caps["geometry"] != nil || caps["operational_verification"] != nil {
		t.Fatalf("unverified identity/measurement became persisted physical proof: %+v", caps)
	}
	nested, ok := caps["ipp_capabilities"].(map[string]interface{})
	if !ok || nested["printer_uuid"] != nil || nested["document_formats"] == nil {
		t.Fatalf("real format hints should survive without a claimed service UUID: %+v", caps)
	}
	// Never mutate a caller-owned nested capability map in place.
}

func TestManualIPPCapabilityUpdateCannotReplacePreviouslyVerifiedUUID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := registryIPPIdentityFixture("established-ipp", "ipp://192.168.1.20/ipp/print", registryIPPUUIDA)
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	changed := DeviceInfo{
		ID: prior.ID, Name: "Updated display label", ConnectionType: "ipp",
		Protocol: "ipp", Endpoint: prior.Endpoint, PrinterType: "physical",
		Enabled: false, Capabilities: map[string]interface{}{
			"ipp_printer_uuid": registryIPPUUIDB,
			"ipp_capabilities": map[string]interface{}{"printer_uuid": registryIPPUUIDB},
		},
	}
	rows, err := RegisterManual(path, changed)
	if err != nil || len(rows) != 1 {
		t.Fatalf("manual label update failed: %v rows=%+v", err, rows)
	}
	if got := verifiedIPPUUIDFromCapabilities(rows[0].Capabilities); got != registryIPPUUIDA {
		t.Fatalf("untrusted update replaced saved verified identity: %q", got)
	}
	if rows[0].Capabilities["identity_collision"] != nil {
		t.Fatalf("unverified operator metadata falsely disabled verified printer: %+v", rows[0].Capabilities)
	}
}
