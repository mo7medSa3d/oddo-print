package agent

import (
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestInventoryCapabilitiesCannotReplaceExecutionIdentity(t *testing.T) {
	for _, transport := range []string{"usb", "spooler"} {
		pc := config.PrinterConfig{ID: "p", Name: "P", Type: transport, Protocol: "raw", Endpoint: ` \\?\usb#Selected Interface `, USBVID: " 0x1234 ", USBPID: " 0X5678 ", USBSerial: "selected-serial", Capabilities: map[string]interface{}{"vid": 1, "pid": "bad", "serial": "other", "usb_vid": "FFFF", "usb_pid": "FFFF", "usb_serial": "other", "spooler_name": "Other Queue", "ipp_url": "ipp://192.168.1.20/other", "host": "other", "supports_color": true}}
		if transport == "spooler" {
			pc.Protocol, pc.SpoolerName = "spooler", "Selected Queue"
		}
		got := endpointToConfig(pc)
		if got["vid"] != 0x1234 || got["pid"] != 0x5678 || got["serial"] != "selected-serial" || got["usb_vid"] != pc.USBVID || got["usb_pid"] != pc.USBPID || got["usb_serial"] != pc.USBSerial {
			t.Fatalf("capability metadata replaced %s USB identity: %v", transport, got)
		}
		if got["supports_color"] != true {
			t.Fatal("nonidentity capabilities were lost")
		}
		if _, present := got["ipp_url"]; present {
			t.Fatal("capability injected another protocol endpoint")
		}
		if transport == "spooler" && got["spooler_name"] != "Selected Queue" {
			t.Fatal("capability replaced installed queue")
		}
		if transport == "usb" && got["address"] != `\\?\usb#Selected Interface` {
			t.Fatal("inventory differs from actual selected interface")
		}
	}
}
