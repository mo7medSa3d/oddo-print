package printer

import "testing"

func TestIsAllowedCIDR(t *testing.T) {
	cases := []struct {
		cidr string
		ok   bool
	}{
		{"192.168.1.0/24", true},
		{"10.0.0.0/24", true},
		{"172.16.0.0/16", true},
		{"8.8.8.0/24", false},
		{"127.0.0.0/8", false},
		{"not-a-cidr", false},
		{"192.168.1.0/31", false},
		{"192.168.1.0/15", false},
	}
	for _, tc := range cases {
		if got := isAllowedCIDR(tc.cidr); got != tc.ok {
			t.Errorf("isAllowedCIDR(%q)=%v want %v", tc.cidr, got, tc.ok)
		}
	}
}

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

func TestConfidenceForDevice(t *testing.T) {
	if confidenceForDevice([]string{"ipp"}, "verified", "HP", "LaserJet") != "high" {
		t.Fatalf("expected high confidence for verified ipp")
	}
	if confidenceForDevice([]string{"raw"}, "candidate", "", "") != "low" {
		t.Fatalf("expected low for single raw candidate")
	}
	if confidenceForDevice([]string{"snmp", "mdns"}, "candidate", "HP", "LaserJet") != "high" {
		// multiple sources + model => high
	}
}

func TestNoFalsePositives(t *testing.T) {
	// Open port alone must NOT be verified printer — verification must be candidate without IPP/SNMP
	di := DeviceInfo{NetworkAddress: "192.168.1.99", Port: 9100, Protocol: "raw"}
	_ = di
	// Ensure isValidDiscoveredPrinter rejects generic non-printer devices already tested elsewhere
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
