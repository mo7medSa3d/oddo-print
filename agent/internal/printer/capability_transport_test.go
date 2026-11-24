package printer

import "testing"

func TestByteLanguageCannotCreateAnUnsupportedTransport(t *testing.T) {
	for _, conn := range []string{"", "unknown", "ipp", "ipps", "lpr", "serial", "bluetooth"} {
		for _, proto := range []string{"raw", "escpos", "zpl", "tspl"} {
			facts := TransportFacts{Connection: conn, Protocol: proto}
			if ok, _ := PayloadCompatibleForDevice("raw", proto, facts); ok {
				t.Fatalf("%s protocol invented a %s byte backend", proto, conn)
			}
			if proto == "escpos" {
				if ok, _ := PayloadCompatibleForDevice("escpos", proto, facts); ok {
					t.Fatalf("ESC/POS invented %s transport", conn)
				}
			}
			if got := SupportedProtocolsForDevice(facts); len(got) != 0 {
				t.Fatalf("unsupported %s/%s advertised %v", conn, proto, got)
			}
		}
	}
}

func TestCapabilityTokensUseTheSameWhitespaceRulesAsBindings(t *testing.T) {
	facts := TransportFacts{Connection: "network", Protocol: "escpos", SupportedProtocol: []string{" ESCPOS "}}
	if ok, why := PayloadCompatibleForDevice("escpos", "escpos", facts); !ok {
		t.Fatalf("declared capability differed from Odoo/Gateway: %s", why)
	}
	facts.Protocol = "raw"
	if ok, _ := PayloadCompatibleForDevice("escpos", "escpos", facts); ok {
		t.Fatal("normalized capability changed physical byte language")
	}
}

// Derived protocol claims are an authorization hint in the Gateway and Odoo
// UI. Never advertise a format that the actual execution matrix denies.
func TestDerivedProtocolsNeverOutrunPhysicalAdmission(t *testing.T) {
	connections := []string{"", "unknown", "network", "usb", "ipp", "ipps", "spooler", "windows_spooler", "pdf_output", "lpr", "serial", "bluetooth"}
	protocols := []string{"", "unknown", "raw", "escpos", "zpl", "tspl", "ipp", "ipps", "spooler", "windows_spooler", "pdf"}
	for _, conn := range connections {
		for _, proto := range protocols {
			facts := TransportFacts{Connection: conn, Protocol: proto}
			for _, advertised := range SupportedProtocolsForDevice(facts) {
				plType, plProtocol := advertised, ""
				switch advertised {
				case "raw", "zpl", "tspl":
					plType, plProtocol = "raw", advertised
				case "escpos":
					plProtocol = "escpos"
				}
				if allowed, why := PayloadCompatibleForDevice(plType, plProtocol, facts); !allowed {
					t.Fatalf("advertised %s for unsupported %q/%q backend: %s", advertised, conn, proto, why)
				}
			}
		}
	}
}

func TestIPPLabelCannotManufactureDocumentBackend(t *testing.T) {
	for _, conn := range []string{"", "unknown", "usb", "lpr", "serial", "bluetooth", "pdf_output"} {
		for _, proto := range []string{"ipp", "ipps"} {
			facts := TransportFacts{Connection: conn, Protocol: proto}
			if got := SupportedProtocolsForDevice(facts); len(got) != 0 {
				t.Fatalf("unroutable %q/%q claimed PDF: %v", conn, proto, got)
			}
		}
	}
	for _, facts := range []TransportFacts{
		{Connection: "network", Protocol: "ipp"},
		{Connection: "network", Protocol: "ipps"},
		{Connection: "ipp", Protocol: "unknown"},
		{Connection: "ipps", Protocol: "ipps"},
	} {
		got := SupportedProtocolsForDevice(facts)
		if len(got) != 1 || got[0] != "pdf" {
			t.Fatalf("valid IPP document transport lost PDF support: %+v -> %v", facts, got)
		}
	}
}
