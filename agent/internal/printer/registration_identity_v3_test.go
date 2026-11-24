package printer

import (
	"maps"
	"path/filepath"
	"testing"
)

func withPublishedQueueGUID(d DeviceInfo) DeviceInfo {
	d.Capabilities = maps.Clone(d.Capabilities)
	if d.Capabilities == nil {
		d.Capabilities = map[string]interface{}{}
	}
	d.Capabilities["windows_queue_guid"] = "748a4a60-2bfd-4f21-9e75-937e7eeedc79"
	d.Capabilities["windows_queue_guid_verified"] = true
	return d
}

func TestV3UnpublishedQueueRenameNeedsExplicitReconciliation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	first := continuitySpooler("Original Queue", "USB001", "Office Driver")
	second := continuitySpooler("New Queue Name", "USB001", "Office Driver")
	if _, err := UpsertRegistry(path, []DeviceInfo{first}); err != nil {
		t.Fatal(err)
	}
	rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{second}, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 2 {
		t.Fatalf("unproven rename silently reassigned existing registration: %+v %v", rows, err)
	}
	for _, row := range rows {
		if row.ID == first.ID && IsRuntimeDiscoveryPrinter(row) {
			t.Fatal("missing original queue remained executable")
		}
	}
}

func TestV3LegacyIDCollisionCannotRebindToAnotherWindowsQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	first := continuitySpooler("Queue A", "USB001", "Office Driver")
	second := continuitySpooler("Queue_A", "USB001", "Office Driver")
	first.ID, second.ID = StableIDFromSpooler("Queue A"), StableIDFromSpooler("Queue_A")
	if first.ID != second.ID {
		t.Fatal("fixture no longer exercises legacy space/underscore collision")
	}
	if _, err := UpsertRegistry(path, []DeviceInfo{first}); err != nil {
		t.Fatal(err)
	}
	rows, err := UpsertRegistry(path, []DeviceInfo{second})
	if err != nil || len(rows) != 1 || rows[0].SpoolerName != first.SpoolerName || rows[0].Capabilities["identity_collision"] == nil || IsRuntimeDiscoveryPrinter(rows[0]) {
		t.Fatalf("colliding queue stole an established ID: %+v %v", rows, err)
	}
}

func TestV3DistinctWindowsQueuesSharingDriverAndPortKeepSeparateIdentities(t *testing.T) {
	first := continuitySpooler("Sales A4", "IP_192.168.50.20", "Office Driver")
	second := continuitySpooler("Kitchen A5", "IP_192.168.50.20", "Office Driver")
	if first.ID == second.ID {
		t.Fatal("distinct installed queues were collapsed merely because driver and port match")
	}
	path := filepath.Join(t.TempDir(), "printers.json")
	rows, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{first, second}, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 2 {
		t.Fatalf("two logical queues must remain distinct registrations: rows=%+v err=%v", rows, err)
	}
}

func TestV3AbsentWindowsQueueRetainsDurableIdentityAndConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	original := continuitySpooler("Sales A4", "IP_192.168.50.20", "Office Driver")
	original.Enabled = false
	original.Capabilities["operator_note"] = "keep this setup"
	if _, err := ReconcileDiscoveryRegistry(path, []DeviceInfo{original}, map[string]bool{SourceSpooler: true}); err != nil {
		t.Fatal(err)
	}
	rows, err := ReconcileDiscoveryRegistry(path, nil, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 1 || rows[0].ID != original.ID {
		t.Fatalf("temporary queue absence deleted persistent identity: rows=%+v err=%v", rows, err)
	}
	if rows[0].Enabled || rows[0].Capabilities["operator_note"] != "keep this setup" || IsRuntimeDiscoveryPrinter(rows[0]) {
		t.Fatalf("absent queue must retain disabled setup without becoming executable: %+v", rows[0])
	}
	rows, err = ReconcileDiscoveryRegistry(path, []DeviceInfo{original}, map[string]bool{SourceSpooler: true})
	if err != nil || len(rows) != 1 || rows[0].ID != original.ID || rows[0].Enabled {
		t.Fatalf("reconnection changed identity or operator intent: %+v %v", rows, err)
	}
}

func TestV3ManualRegistrationCannotSupplyOperationalEvidence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	rows, err := RegisterManual(path, DeviceInfo{
		ID: "fictional-queue", Name: "Fictional queue", ConnectionType: "spooler", Protocol: "spooler",
		Endpoint: "Fictional queue", SpoolerName: "Fictional queue", PrinterType: "laser", Enabled: true,
		Status: "online", Capabilities: map[string]interface{}{
			"operational_verification": map[string]interface{}{"version": 1, "method": "windows_queue"},
			"verification":             "verified", "ipp_verified": true,
		},
	})
	if err != nil || len(rows) != 1 {
		t.Fatalf("manual candidate should be retained for actual Agent verification: %+v %v", rows, err)
	}
	if rows[0].Status != "unknown" || rows[0].Capabilities["operational_verification"] != nil || rows[0].Capabilities["verification"] == "verified" {
		t.Fatalf("manual text was promoted to a live operational observation: %+v", rows[0])
	}
}

func TestV3ManualHardwareLabelsCannotTakeOverAnotherDestination(t *testing.T) {
	for _, transport := range []string{"ipp", "ipp-empty-id", "usb"} {
		t.Run(transport, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			var original, declared DeviceInfo
			if transport == "ipp" || transport == "ipp-empty-id" {
				original = DeviceInfo{ID: "established-ipp", Name: "Existing IPP", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://10.0.0.20/ipp/print", PrinterType: "physical", Enabled: true, Capabilities: map[string]interface{}{"uuid": ippIdentityFixtureUUID, "ipp_verified": true, "discovered_via": SourceIPP}}
				declared = original
				declared.ID = "manual-elsewhere"
				declared.Endpoint = "ipp://10.0.0.30/ipp/print"
				if transport == "ipp-empty-id" {
					declared.ID = ""
				}
			} else {
				original = DeviceInfo{ID: "established-usb", Name: "Existing USB printer", ConnectionType: "usb", Protocol: "raw", Endpoint: `\\?\usb#vid_1234&pid_5678#device-a#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}`, USBVID: "1234", USBPID: "5678", USBSerial: "same-serial", PrinterType: "physical", Enabled: true, Capabilities: map[string]interface{}{"discovered_via": SourceUSB}}
				declared = original
				declared.ID = ""
				declared.Endpoint = `\\?\usb#vid_1234&pid_5678#device-b#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}`
			}
			if err := SaveRegistry(path, []DeviceInfo{original}); err != nil {
				t.Fatal(err)
			}
			rows, err := RegisterManual(path, declared)
			if err != nil || len(rows) != 2 {
				t.Fatalf("manual hardware label reassigned existing registration: %+v %v", rows, err)
			}
			for _, row := range rows {
				if row.ID == original.ID && row.Endpoint != original.Endpoint {
					t.Fatal("manual declaration replaced a different observed destination")
				}
			}
		})
	}
}

func TestV3ExplicitEndpointChangeKeepsRegistrationAndUsesNewDestination(t *testing.T) {
	for _, transport := range []string{"network", "ipp"} {
		t.Run(transport, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			original := DeviceInfo{ID: "retained-registration", Name: "Operator printer", ConnectionType: transport, Protocol: "raw", Endpoint: "10.0.0.20:9100", PrinterType: "physical", Enabled: true}
			if transport == "ipp" {
				original.Protocol = "ipp"
				original.Endpoint = "ipp://10.0.0.20/ipp/print"
			}
			if _, err := RegisterManual(path, original); err != nil {
				t.Fatal(err)
			}
			changed := original
			changed.Endpoint = "10.0.0.30:9100"
			if transport == "ipp" {
				changed.Endpoint = "ipp://10.0.0.30/ipp/print"
			}
			rows, err := RegisterManual(path, changed)
			if err != nil || len(rows) != 1 || rows[0].ID != original.ID || rows[0].Endpoint != changed.Endpoint || rows[0].Capabilities["operational_verification"] != nil {
				t.Fatalf("explicit reconfiguration was lost or reused old proof: %+v %v", rows, err)
			}
		})
	}
}
