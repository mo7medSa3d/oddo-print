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
