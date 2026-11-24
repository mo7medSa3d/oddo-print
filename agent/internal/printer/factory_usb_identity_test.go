package printer

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestFactoryRejectsMalformedUSBIdentityBeforeBackendCreation(t *testing.T) {
	for _, raw := range []string{"", "not-hex", "10000", "0x0X1234"} {
		for _, field := range []string{"vid", "pid"} {
			pc := config.PrinterConfig{ID: "usb", Name: "USB", Type: "usb", Protocol: "raw", Endpoint: `\\?\usb#interface`, USBVID: "1234", USBPID: "5678"}
			if field == "vid" {
				pc.USBVID = raw
			} else {
				pc.USBPID = raw
			}
			if backend, err := New(pc); err == nil || backend != nil {
				t.Fatalf("invalid %s %q constructed a writable backend: %T %v", field, raw, backend, err)
			}
		}
	}
}

func TestFactoryUSBRetainsExactInterfaceAndParsedIdentity(t *testing.T) {
	pc := config.PrinterConfig{ID: "usb", Name: "USB", Type: "usb", Protocol: "zpl", Endpoint: `  \\?\usb#Selected Interface 1  `, USBVID: " 0X1234 ", USBPID: "0x5678"}
	backend, err := New(pc)
	if err != nil {
		t.Fatal(err)
	}
	usb, ok := backend.(*USBPrinter)
	if !ok || usb.VID != 0x1234 || usb.PID != 0x5678 || usb.DevicePath != `\\?\usb#Selected Interface 1` {
		t.Fatalf("configured USB tuple changed: %#v", backend)
	}
}
