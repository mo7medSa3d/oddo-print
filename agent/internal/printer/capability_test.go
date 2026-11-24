package printer

import "testing"

// Cross-layer contract test: this table MUST stay behaviorally identical to
// validatePayloadForPrinter in src/lib/routing.ts and the unknown-protocol
// rule documented in both files. One row per rule; a drift here means a
// payload rejected by one layer and printed by another.
func TestCapabilityTableParity(t *testing.T) {
	cases := []struct {
		name     string
		plType   string
		plProto  string
		devProto string
		conn     string
		caps     []string
		wantOK   bool
	}{
		{"raw device is not a zpl device", "raw", "zpl", "raw", "network", nil, false},
		{"zpl device prints zpl", "raw", "zpl", "zpl", "network", nil, true},
		{"raw device is not an escpos device", "raw", "escpos", "raw", "network", nil, false},
		{"escpos needs escpos declared", "escpos", "escpos", "raw", "network", nil, false},
		{"escpos device prints escpos", "escpos", "escpos", "escpos", "network", nil, true},
		{"tspl device rejects zpl", "raw", "zpl", "tspl", "network", nil, false},
		{"raw payload without protocol is malformed", "raw", "", "zpl", "network", nil, false},
		{"spooler raw passthrough requires explicit declaration", "raw", "raw", "spooler", "spooler", nil, false},
		{"spooler raw passthrough with explicit caps", "raw", "raw", "spooler", "spooler", []string{"raw", "pdf", "image"}, true},
		{"spooler escpos passthrough requires explicit declaration", "escpos", "escpos", "spooler", "spooler", nil, false},
		{"spooler escpos passthrough with explicit caps", "escpos", "escpos", "spooler", "spooler", []string{"escpos", "pdf", "image"}, true},
		{"spooler escpos-only declaration keeps pdf baseline", "pdf", "", "spooler", "spooler", []string{"escpos"}, true},
		{"spooler escpos-only declaration keeps image still needs geometry", "image", "", "spooler", "spooler", []string{"escpos"}, false},
		{"spooler does not imply zpl language", "raw", "zpl", "spooler", "spooler", nil, false},
		{"pdf needs a document transport", "pdf", "", "raw", "network", nil, false},
		{"pdf never carries a protocol", "pdf", "raw", "spooler", "spooler", nil, false},
		{"image never carries a protocol", "image", "escpos", "escpos", "network", nil, false},
		{"image needs geometry on escpos", "image", "", "escpos", "network", nil, false},
		{"image is not printable by ipp without caps", "image", "", "ipp", "ipp", nil, false},
		{"image needs geometry on network escpos", "image", "", "escpos", "network", nil, false},
		// Authoritative unknown rule.
		{"unknown+network routes nothing", "raw", "raw", "unknown", "network", nil, false},
		{"unknown+network escpos rejected", "escpos", "escpos", "unknown", "network", nil, false},
		{"unknown+usb escpos rejected", "escpos", "escpos", "unknown", "usb", nil, false},
		{"unknown+network pdf rejected", "pdf", "", "unknown", "network", nil, false},
		{"unknown+network image rejected", "image", "", "unknown", "network", nil, false},
		{"unknown+spooler pdf accepted", "pdf", "", "unknown", "spooler", nil, true},
		{"unknown+spooler image needs geometry", "image", "", "unknown", "spooler", nil, false},
		{"unknown+ipp pdf accepted", "pdf", "", "unknown", "ipp", nil, true},
		{"unknown+spooler escpos requires explicit declaration", "escpos", "escpos", "unknown", "spooler", nil, false},
		// Explicit capability lists cannot override the concrete transport protocol;\n\t\t// they can only narrow/confirm what that backend actually speaks.
		{"declared escpos caps cannot override raw device protocol", "escpos", "escpos", "raw", "network", []string{"escpos"}, false},
		{"declared zpl caps cannot override raw USB device protocol", "raw", "zpl", "raw", "usb", []string{"zpl"}, false},
		{"declared tspl caps cannot override raw TCP device protocol", "raw", "tspl", "raw", "network", []string{"tspl"}, false},
		{"declared empty caps deny escpos even on escpos transport", "escpos", "escpos", "escpos", "network", []string{}, false},
		{"declared pdf caps cannot add renderer to raw pipe", "pdf", "", "raw", "network", []string{"pdf"}, false},
		{"declared caps cannot smuggle a protocol", "pdf", "raw", "spooler", "spooler", []string{"pdf"}, false},
		// ipp and ipps are the same document transport everywhere checked.
		{"USB-backed spooler prints pdf", "pdf", "", "spooler", "usb", nil, true},
		{"USB-backed spooler image needs geometry", "image", "", "spooler", "usb", nil, false},
		{"USB-backed spooler escpos requires explicit declaration", "escpos", "escpos", "spooler", "usb", nil, false},
		{"ipps transport prints pdf like ipp", "pdf", "", "ipps", "ipps", nil, true},
		{"network IPPS alias prints pdf like IPP", "pdf", "", "ipps", "network", nil, true},
		{"windows_spooler alias prints pdf on spooler transport", "pdf", "", "windows_spooler", "spooler", nil, true},
		{"windows_spooler alias image needs geometry on spooler transport", "image", "", "windows_spooler", "spooler", nil, false},
		{"windows_spooler token does not turn network into spooler", "pdf", "", "windows_spooler", "network", nil, false},
		{"spooler token does not turn network into driver", "pdf", "", "spooler", "network", nil, false},
		{"spooler token does not rasterize image on network", "image", "", "spooler", "network", nil, false},
		{"spooler token and claimed passthrough cannot inject RAW on TCP", "raw", "raw", "spooler", "network", []string{"raw"}, false},
		{"declared ipps caps cannot turn raw pipe into IPPS renderer", "pdf", "", "raw", "network", []string{"ipps"}, false},
		{"declared ipps caps cannot add renderer to raw pipe", "image", "", "raw", "network", []string{"ipps"}, false},
		{"declared ipp caps cannot add renderer to raw pipe", "image", "", "raw", "network", []string{"ipp"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := PayloadCompatibleForDevice(tc.plType, tc.plProto, TransportFacts{
				Protocol:          tc.devProto,
				Connection:        tc.conn,
				SupportedProtocol: tc.caps,
			})
			if ok != tc.wantOK {
				t.Fatalf("PayloadCompatibleForDevice(%q,%q on %s/%s caps=%v) = %v (%s), want %v",
					tc.plType, tc.plProto, tc.devProto, tc.conn, tc.caps, ok, reason, tc.wantOK)
			}
		})
	}
}

func TestSupportedProtocolsForUSBESCPos(t *testing.T) {
	for _, connection := range []string{"usb", "network"} {
		got := SupportedProtocolsForDevice(TransportFacts{Protocol: "escpos", Connection: connection})
		if len(got) != 1 || got[0] != "escpos" {
			t.Fatalf("unknown raster geometry advertised image: %v", got)
		}
		got = SupportedProtocolsForDevice(TransportFacts{Protocol: "escpos", Connection: connection, Geometry: testRasterGeometry(576)})
		if len(got) != 2 || got[1] != "image" {
			t.Fatalf("verified %s raster geometry missing: %v", connection, got)
		}
	}
}

func TestSupportedProtocolsForUnknownDevices(t *testing.T) {
	if got := SupportedProtocolsForDevice(TransportFacts{Protocol: "unknown", Connection: "network"}); len(got) != 0 {
		t.Fatalf("unknown+network must derive no protocols, got %v", got)
	}
	mustContain := func(facts TransportFacts, want string) {
		t.Helper()
		for _, p := range SupportedProtocolsForDevice(facts) {
			if p == want {
				return
			}
		}
		t.Fatalf("expected %q in %v", want, SupportedProtocolsForDevice(facts))
	}
	mustContain(TransportFacts{Protocol: "unknown", Connection: "spooler"}, "pdf")
	mustContain(TransportFacts{Protocol: "unknown", Connection: "ipp"}, "pdf")
}

func TestSupportedProtocolsForWindowsSpoolerAlias(t *testing.T) {
	got := SupportedProtocolsForDevice(TransportFacts{Protocol: "windows_spooler", Connection: "spooler"})
	if len(got) != 1 || got[0] != "pdf" {
		t.Fatalf("unmeasured windows_spooler alias must retain PDF, got %v", got)
	}
	if got := SupportedProtocolsForDevice(TransportFacts{Protocol: "windows_spooler", Connection: "network"}); len(got) != 0 {
		t.Fatalf("windows_spooler token must not turn a network transport into a spooler, got %v", got)
	}
}

func TestSpoolerProtocolTokenOnTCPDoesNotAdvertiseDocumentRenderer(t *testing.T) {
	got := SupportedProtocolsForDevice(TransportFacts{Protocol: "spooler", Connection: "network"})
	if len(got) != 0 {
		t.Fatalf("a network byte pipe does not acquire Windows document rendering from a protocol label: %v", got)
	}
}

func TestSupportedProtocolsForSpoolerIsDocumentOnly(t *testing.T) {
	got := SupportedProtocolsForDevice(TransportFacts{Protocol: "spooler", Connection: "spooler"})
	want := map[string]bool{"pdf": true}
	if len(got) != 1 {
		t.Fatalf("unmeasured spooler must derive PDF only, got %v", got)
	}
	for _, p := range got {
		if !want[p] {
			t.Fatalf("spooler must not derive raw passthrough %q (got %v)", p, got)
		}
	}
}
