package printer

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

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

func TestLPRDiscoveryReadsQueueStatusWithoutSubmitting(t *testing.T) {
	for _, response := range []string{"no entries\n", "unknown printer raw\n", "\x00"} {
		t.Run(response, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			request := make(chan string, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					request <- err.Error()
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				buf := make([]byte, 5)
				_, err = io.ReadFull(conn, buf)
				if err != nil {
					request <- err.Error()
					return
				}
				request <- string(buf)
				_, _ = conn.Write([]byte(response))
			}()
			port := listener.Addr().(*net.TCPAddr).Port
			got := probeLPRHostWithPort(context.Background(), "127.0.0.1", port, time.Second)
			if req := <-request; req != "\x04raw\n" {
				t.Fatalf("unsafe/wrong request: %q", req)
			}
			if got == nil {
				t.Fatal("reachable candidate disappeared")
			}
			if got.Status != "unknown" || got.Capabilities["lpr_verified"] != false {
				t.Fatalf("candidate asserted printability: %+v", got)
			}
			if response != "\x00" && got.Capabilities["queue_status_response"] == nil {
				t.Fatal("text queue response was discarded")
			}
			if response == "\x00" && got.Capabilities["probe_error"] == nil {
				t.Fatal("binary ACK was accepted as queue status")
			}
		})
	}
}

func TestPrivateDiscoveryTargetsCoverLocalWideNetworksFairly(t *testing.T) {
	targets := privateDiscoveryTargets([]*net.IPNet{
		{IP: net.ParseIP("10.42.99.210"), Mask: net.CIDRMask(8, 32)},
		{IP: net.ParseIP("192.168.50.120"), Mask: net.CIDRMask(120, 128)},
		{IP: net.ParseIP("10.42.99.210"), Mask: net.CIDRMask(8, 32)},
	})
	if len(targets) != 506 {
		t.Fatalf("got %d targets, want 506", len(targets))
	}
	if targets[0] != "10.42.99.1" || targets[1] != "192.168.50.1" {
		t.Fatalf("interfaces were not interleaved: %v", targets[:2])
	}
	seen := map[string]bool{}
	for _, target := range targets {
		if seen[target] {
			t.Fatalf("duplicate %s", target)
		}
		seen[target] = true
	}
	if !seen["10.42.99.254"] || !seen["192.168.50.254"] {
		t.Fatal("tail of subnet disappeared")
	}
	if seen["10.42.99.210"] || seen["192.168.50.120"] || seen["10.0.0.1"] {
		t.Fatal("scanned self or wrong /24")
	}
}

func TestUSBStableIDsScopeSerialToDeviceModel(t *testing.T) {
	a := StableIDFromUSBFull("1234", "5678", "SN-42", "", "")
	b := StableIDFromUSBFull("1234", "9999", "SN-42", "", "")
	c := StableIDFromUSBFull("1234", "5678", "sn-42", "", "")
	if a == b {
		t.Fatal("different device models sharing serial collided")
	}
	if a != c {
		t.Fatal("serial case aliases changed identity")
	}
}
