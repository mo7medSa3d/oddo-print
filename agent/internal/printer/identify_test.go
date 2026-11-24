package printer

import "testing"

// TestIdentifyPrinter pins the unified identification verdicts for
// realistic evidence strings from every discovery source. The class
// vocabulary is the wire vocabulary (thermal/label/laser/inkjet/
// unknown): dot-matrix models identify make/model but deliberately
// stay class-unknown, because no dot-matrix word exists downstream.
func TestIdentifyPrinter(t *testing.T) {
	cases := []struct {
		name       string
		ev         IdentityEvidence
		wantVendor string
		wantModel  string
		wantClass  string
	}{
		{"epson tm via driver", IdentityEvidence{DriverName: "EPSON TM-T20III Series"}, "Epson", "TM-T20III", "thermal"},
		{"epson tm via queue name", IdentityEvidence{QueueName: "Epson TM-T20"}, "Epson", "TM-T20", "thermal"},
		{"epson sysdescr full legal name", IdentityEvidence{SysDescr: "SEIKO EPSON CORPORATION TM-T88VI"}, "Epson", "TM-T88VI", "thermal"},
		{"epson dot matrix stays class-unknown", IdentityEvidence{DriverName: "EPSON LQ-350"}, "Epson", "LQ-350", "unknown"},
		{"epson workforce inkjet", IdentityEvidence{IPPMakeModel: "EPSON WF-7720 Series"}, "Epson", "WF-7720", "inkjet"},
		{"zebra zdesigner driver", IdentityEvidence{DriverName: "ZDesigner ZD421"}, "Zebra", "ZD421", "label"},
		{"zebra model from queue when driver lacks it", IdentityEvidence{DriverName: "Zebra Label", QueueName: "Zebra GK420"}, "Zebra", "GK420", "label"},
		{"zebra sysdescr", IdentityEvidence{SysDescr: "Zebra Technologies ZTC ZD420-203dpi ZPL"}, "Zebra", "ZTC ZD420-203dpi ZPL", "label"},
		{"hp laserjet via ipp", IdentityEvidence{IPPMakeModel: "HP LaserJet Pro M404dn"}, "HP", "LaserJet Pro M404dn", "laser"},
		{"hp deskjet via sysdescr", IdentityEvidence{SysDescr: "HP DeskJet 2776"}, "HP", "DeskJet 2776", "inkjet"},
		{"hp officejet inkjet", IdentityEvidence{DriverName: "HP OfficeJet Pro 9020"}, "HP", "OfficeJet Pro 9020", "inkjet"},
		{"brother laser", IdentityEvidence{DriverName: "Brother HL-L2370DW series"}, "Brother", "HL-L2370DW", "laser"},
		{"brother inkjet mfc-j", IdentityEvidence{QueueName: "Brother MFC-J995DW"}, "Brother", "MFC-J995DW", "inkjet"},
		{"brother label ql", IdentityEvidence{USBManufacturer: "Brother", USBProduct: "QL-820NWB"}, "Brother", "QL-820NWB", "label"},
		{"canon pixma via mdns", IdentityEvidence{MDNSManufacturer: "Canon", MDNSModel: "PIXMA TS6420"}, "Canon", "PIXMA TS6420", "inkjet"},
		{"bixolon sysdescr", IdentityEvidence{SysDescr: "BIXOLON SRP-350plusIII"}, "Bixolon", "SRP-350plusIII", "thermal"},
		{"xprinter via driver", IdentityEvidence{DriverName: "Xprinter XP-80C"}, "Xprinter", "XP-80C", "thermal"},
		{"tsc label", IdentityEvidence{DriverName: "TSC TTP-244 Pro"}, "TSC", "TTP-244 Pro", "label"},
		{"dymo labelwriter via usb", IdentityEvidence{USBManufacturer: "DYMO", USBProduct: "LabelWriter 450"}, "DYMO", "LabelWriter 450", "label"},
		{"star tsp via sysdescr", IdentityEvidence{SysDescr: "Star Micronics TSP143IIIU"}, "Star Micronics", "TSP143IIIU", "thermal"},
		{"snbc thermal", IdentityEvidence{DriverName: "SNBC BTP-R880NP"}, "SNBC", "BTP-R880NP", "thermal"},
		{"citizen label", IdentityEvidence{DriverName: "Citizen CL-S621"}, "Citizen", "CL-S621", "label"},
		{"citizen thermal ct", IdentityEvidence{QueueName: "Citizen CT-S310II"}, "Citizen", "CT-S310II", "thermal"},
		{"kyocera ecosys laser", IdentityEvidence{IPPMakeModel: "Kyocera ECOSYS M5526cdw"}, "Kyocera", "ECOSYS M5526cdw", "laser"},
		{"konica bizhub laser", IdentityEvidence{DriverName: "KONICA MINOLTA bizhub C250i"}, "Konica Minolta", "bizhub C250i", "laser"},
		{"samsung xpress laser", IdentityEvidence{DriverName: "Samsung Xpress M283x Series"}, "Samsung", "Xpress M283x", "laser"},
		{"vid-only epson with model string", IdentityEvidence{USBVID: "04B8", USBProduct: "TM-T20"}, "Epson", "TM-T20", "thermal"},
		{"vid-only hp no model", IdentityEvidence{USBVID: "0x03f0"}, "HP", "", "unknown"},
		{"generic queue stays unidentified", IdentityEvidence{QueueName: "My Printer", DriverName: "Generic / Text Only"}, "", "", "unknown"},
		{"hprt is not hp", IdentityEvidence{DriverName: "HPRT TP808"}, "HPRT", "TP808", "thermal"},
		{"brother ink tank dcp-t", IdentityEvidence{DriverName: "Brother DCP-T420W"}, "Brother", "DCP-T420W", "inkjet"},
		{"brother ink tank mfc-t", IdentityEvidence{DriverName: "Brother MFC-T920DW"}, "Brother", "MFC-T920DW", "inkjet"},
		{"hp ink tank family", IdentityEvidence{QueueName: "HP Ink Tank Wireless 415"}, "HP", "Ink Tank 415", "inkjet"},
		{"hp envy bare name", IdentityEvidence{QueueName: "HP ENVY"}, "HP", "ENVY", "inkjet"},
		{"xerox phaser laser", IdentityEvidence{SysDescr: "Xerox Phaser 6510DN"}, "Xerox", "Phaser 6510DN", "laser"},
		{"ricoh sp laser", IdentityEvidence{DriverName: "RICOH SP 3710DN"}, "Ricoh", "SP 3710DN", "laser"},
		{"ricoh mp laser", IdentityEvidence{DriverName: "RICOH MP C3004"}, "Ricoh", "MP C3004", "laser"},
		{"ricoh im laser", IdentityEvidence{DriverName: "Ricoh IM C3000"}, "Ricoh", "IM C3000", "laser"},
		{"lexmark mx laser", IdentityEvidence{QueueName: "Lexmark MX622ade"}, "Lexmark", "MX622ade", "laser"},
		{"canon i-sensys laser", IdentityEvidence{DriverName: "Canon i-SENSYS MF752Cdw"}, "Canon", "i-SENSYS MF752Cdw", "laser"},
		{"pantum laser via driver", IdentityEvidence{DriverName: "Pantum P2500W Series"}, "Pantum", "P2500W", "laser"},
		{"pantum laser via usb", IdentityEvidence{USBManufacturer: "Pantum", USBProduct: "Pantum M6200W"}, "Pantum", "M6200W", "laser"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := IdentifyPrinter(tc.ev)
			if id.Manufacturer != tc.wantVendor {
				t.Errorf("manufacturer: want %q got %q", tc.wantVendor, id.Manufacturer)
			}
			if id.Model != tc.wantModel {
				t.Errorf("model: want %q got %q", tc.wantModel, id.Model)
			}
			if id.Class != tc.wantClass {
				t.Errorf("class: want %q got %q", tc.wantClass, id.Class)
			}
		})
	}
}

// TestIdentifyPrinterSourcePriority pins that device-reported evidence
// outranks driver/queue text when sources disagree.
func TestIdentifyPrinterSourcePriority(t *testing.T) {
	id := IdentifyPrinter(IdentityEvidence{
		IPPMakeModel: "HP LaserJet Pro M404dn",
		DriverName:   "Generic / Text Only",
		QueueName:    "Front Desk",
	})
	if id.Source != "ipp_make_model" || id.Confidence != "high" {
		t.Fatalf("want ipp_make_model/high, got %q/%q", id.Source, id.Confidence)
	}
	id = IdentifyPrinter(IdentityEvidence{QueueName: "Epson TM-T20"})
	if id.Source != "queue_name" || id.Confidence != "low" {
		t.Fatalf("want queue_name/low, got %q/%q", id.Source, id.Confidence)
	}
}

// TestEnrichIdentityNeverTouchesIdentityKeys pins the stable-ID safety
// contract: identification writes only namespaced capability keys and
// never the plain manufacturer/model keys that feed serial-based
// stable IDs (stable_id.go).
func TestEnrichIdentityNeverTouchesIdentityKeys(t *testing.T) {
	di := DeviceInfo{
		PrinterType:  "unknown",
		Capabilities: map[string]interface{}{"manufacturer": "Hewlett-Packard", "serial": "ABC123"},
	}
	enrichIdentity(&di, IdentityEvidence{IPPMakeModel: "HP LaserJet Pro M404dn"})
	if got := di.Capabilities["manufacturer"]; got != "Hewlett-Packard" {
		t.Fatalf("manufacturer capability must stay untouched, got %v", got)
	}
	if _, ok := di.Capabilities["model"]; ok {
		t.Fatal("model capability must not be created by identification")
	}
	if got := di.Capabilities["identified_manufacturer"]; got != "HP" {
		t.Fatalf("identified_manufacturer: want HP got %v", got)
	}
	if got := di.Capabilities["identified_model"]; got != "LaserJet Pro M404dn" {
		t.Fatalf("identified_model: want 'LaserJet Pro M404dn' got %v", got)
	}
	if di.PrinterType != "laser" {
		t.Fatalf("PrinterType should upgrade to laser, got %q", di.PrinterType)
	}
	// An explicit non-unknown type is never overridden.
	di2 := DeviceInfo{PrinterType: "thermal", Capabilities: map[string]interface{}{}}
	enrichIdentity(&di2, IdentityEvidence{IPPMakeModel: "HP LaserJet Pro M404dn"})
	if di2.PrinterType != "thermal" {
		t.Fatalf("explicit PrinterType must win, got %q", di2.PrinterType)
	}
}
