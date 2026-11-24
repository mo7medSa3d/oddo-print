package printer

import (
	"path/filepath"
	"testing"
)

func legacyUSBPrinterForCollision(instance, endpoint string) DeviceInfo {
	return DeviceInfo{
		ID:   StableIDFromUSB("1234", "5678", "", ""),
		Name: "USB receipt printer", PrinterType: "physical",
		ConnectionType: "usb", Type: "usb", Protocol: "raw",
		Endpoint: endpoint, USBVID: "1234", USBPID: "5678",
		Enabled: true, Status: "online",
		Capabilities: map[string]interface{}{
			"device_instance_id": instance,
			"geometry":           map[string]interface{}{"source": "windows_driver"},
		},
	}
}

// Historical fallback IDs based only on VID:PID can collide for two physical
// USB printers of the same model. The native discovery merge must not bypass
// sameUSBDevice's stronger instance/serial/location identity checks.
func TestLegacyUSBFallbackIDCollisionCannotSelectAnotherInterface(t *testing.T) {
	first := legacyUSBPrinterForCollision("USBPRINT\\VID_1234&PID_5678\\INSTANCE_A", `\\?\usb#vid_1234&pid_5678#instance-a`)
	second := legacyUSBPrinterForCollision("USBPRINT\\VID_1234&PID_5678\\INSTANCE_B", `\\?\usb#vid_1234&pid_5678#instance-b`)
	if first.ID != second.ID || sameUSBDevice(first, second) {
		t.Fatal("fixture requires an old model-only ID collision and two distinct USB instances")
	}
	merged := mergeDiscoveredSameID(first, second)
	if merged.Endpoint != first.Endpoint ||
		merged.Capabilities["identity_collision"] != "same_id_different_usb_interface" ||
		merged.Capabilities["geometry"] != nil || IsRuntimeDiscoveryPrinter(merged) {
		t.Fatalf("discovery merged different physical USB interfaces under one ID: %+v", merged)
	}

	path := filepath.Join(t.TempDir(), "printers.json")
	if _, err := UpsertRegistry(path, []DeviceInfo{first}); err != nil {
		t.Fatal(err)
	}
	rows, err := UpsertRegistry(path, []DeviceInfo{second})
	if err != nil || len(rows) != 1 {
		t.Fatalf("registry returned ambiguous physical USB binding: %+v err=%v", rows, err)
	}
	if rows[0].Endpoint != first.Endpoint ||
		rows[0].Capabilities["identity_collision"] != "same_id_different_usb_interface" ||
		rows[0].Capabilities["geometry"] != nil || IsRuntimeDiscoveryPrinter(rows[0]) {
		t.Fatalf("registry silently replaced an old USB interface under the same ID: %+v", rows[0])
	}
}

func TestExplicitManualUSBInterfaceChangeRevokesOldGeometryEvidence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	prior := legacyUSBPrinterForCollision("USBPRINT\\VID_1234&PID_5678\\INSTANCE_A", `\\?\usb#vid_1234&pid_5678#instance-a`)
	prior.ID = "operator-usb"
	prior.Capabilities["registration_source"] = "manual"
	if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
		t.Fatal(err)
	}
	updated := prior
	updated.Endpoint = `\\?\usb#vid_1234&pid_5678#instance-b`
	updated.Capabilities = map[string]interface{}{}
	rows, err := RegisterManual(path, updated)
	if err != nil || len(rows) != 1 {
		t.Fatalf("manual USB interface change failed: %+v %v", rows, err)
	}
	if rows[0].Endpoint != updated.Endpoint || rows[0].Capabilities["geometry"] != nil ||
		rows[0].Capabilities["operational_verification"] != nil {
		t.Fatalf("manual interface change retained old physical measurement or route: %+v", rows[0])
	}
}
