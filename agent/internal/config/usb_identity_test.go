package config

import "testing"

func TestUSBIdentifiersRequireActual16BitHexValues(t *testing.T) {
	for raw, want := range map[string]uint16{"1234": 0x1234, "0x04b8": 0x04b8, " 0XABCD ": 0xabcd, "0000": 0, "ffff": 65535} {
		if got, err := ParseUSBID(raw); err != nil || got != want {
			t.Fatalf("ParseUSBID(%q) = %x, %v; want %x", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", " ", "0x", "0x0X1234", "0X0x1234", "10000", "-1", "not-hex"} {
		if _, err := ParseUSBID(raw); err == nil {
			t.Fatalf("malformed USB identity %q became an identifier", raw)
		}
		p := PrinterConfig{ID: "usb", Name: "USB", Type: "usb", Protocol: "raw", Endpoint: `\\?\usb#interface`, USBVID: raw, USBPID: "5678"}
		if err := ValidatePrinterConfig(p); err == nil {
			t.Fatalf("malformed configured VID %q accepted", raw)
		}
		p.USBVID, p.USBPID = "1234", raw
		if err := ValidatePrinterConfig(p); err == nil {
			t.Fatalf("malformed configured PID %q accepted", raw)
		}
	}
}
