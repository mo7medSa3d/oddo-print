package printer

import "testing"

func TestDedupeKeyPriority(t *testing.T) {
	di1 := DeviceInfo{ID: "a", Capabilities: map[string]interface{}{"uuid": "ABC-123"}}
	di2 := DeviceInfo{ID: "b", NetworkAddress: "192.168.1.50", Port: 631}
	if dedupeKey(di1) != "uuid:abc-123" {
		t.Fatalf("uuid priority failed %q", dedupeKey(di1))
	}
	if dedupeKey(di2) != "ip:192.168.1.50:631" {
		t.Fatalf("ip fallback failed %q", dedupeKey(di2))
	}
}

func TestNoFalsePositives(t *testing.T) {
	// A generic USB/PnP device must never enter the printer inventory.
	di := DeviceInfo{
		Name:           "USB Input Device",
		DisplayName:    "USB Input Device",
		ConnectionType: "usb",
		Protocol:       "raw",
	}
	if isValidDiscoveredPrinter(di) {
		t.Fatal("generic USB input devices must be rejected as printers")
	}

}

func TestSameUSBDeviceRequiresStrongPhysicalIdentity(t *testing.T) {
	base := DeviceInfo{USBVID: "1234", USBPID: "5678"}
	if sameUSBDevice(base, DeviceInfo{USBVID: "1234", USBPID: "5678"}) {
		t.Fatal("VID/PID alone must not merge potentially distinct USB printers")
	}
	if !sameUSBDevice(
		DeviceInfo{USBVID: "1234", USBPID: "5678", Capabilities: map[string]interface{}{"location": "Port_#0001.Hub_#0002"}},
		DeviceInfo{USBVID: "1234", USBPID: "5678", Capabilities: map[string]interface{}{"location": "Port_#0001.Hub_#0002"}},
	) {
		t.Fatal("matching USB locations should identify the same physical printer")
	}
	if sameUSBDevice(
		DeviceInfo{USBVID: "1234", USBPID: "5678", Capabilities: map[string]interface{}{"location": "Port_#0001.Hub_#0002"}},
		DeviceInfo{USBVID: "1234", USBPID: "5678", Capabilities: map[string]interface{}{"location": "Port_#0003.Hub_#0002"}},
	) {
		t.Fatal("different USB locations must remain distinct")
	}
	if !sameUSBDevice(
		DeviceInfo{USBVID: "1234", USBPID: "5678", USBSerial: "SN-42"},
		DeviceInfo{USBVID: "1234", USBPID: "5678", USBSerial: "sn-42"},
	) {
		t.Fatal("matching USB serials should identify the same physical printer")
	}
	if sameUSBDevice(
		DeviceInfo{USBVID: "1234", USBPID: "5678", USBSerial: "SN-42"},
		DeviceInfo{USBVID: "1234", USBPID: "5678", USBSerial: "SN-43"},
	) {
		t.Fatal("different USB serials must remain distinct")
	}
	if !sameUSBDevice(
		DeviceInfo{USBVID: "1234", USBPID: "5678", Capabilities: map[string]interface{}{"device_instance_id": "USB\\VID_1234&PID_5678\\A"}},
		DeviceInfo{USBVID: "1234", USBPID: "5678", Capabilities: map[string]interface{}{"device_instance_id": "usb\\vid_1234&pid_5678\\a"}},
	) {
		t.Fatal("matching device instance IDs should identify the same physical printer")
	}
}

func TestDedupeKeyUSBSerialIsModelScoped(t *testing.T) {
	a := DeviceInfo{USBVID: "1234", USBPID: "5678", USBSerial: "SN-42"}
	b := DeviceInfo{USBVID: "1234", USBPID: "9999", USBSerial: "SN-42"}
	if dedupeKey(a) == dedupeKey(b) {
		t.Fatal("same USB serial across different VID/PID must not collide")
	}
	c := DeviceInfo{USBVID: "1234", USBPID: "5678", USBSerial: "sn-42"}
	if dedupeKey(a) != dedupeKey(c) {
		t.Fatal("same USB VID/PID/serial should dedupe case-insensitively")
	}
}
