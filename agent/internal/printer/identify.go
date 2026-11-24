package printer

import (
	"strings"
)

// PrinterIdentity is the normalized make/model/class verdict for one
// device, fused from every identification source the Agent can observe
// (IPP make-and-model, SNMP sysDescr, mDNS metadata, USB strings, the
// Windows driver name, the queue name, the USB vendor ID). Before this
// layer existed, three separate keyword lists (spooler classification,
// USB enrichment, the SNMP printer heuristic) each recognized a handful
// of brands, so the same physical printer identified differently — or
// not at all — depending on how it was discovered.
type PrinterIdentity struct {
	Manufacturer string // canonical vendor name ("Epson"), "" when unrecognized
	Model        string // normalized model ("TM-T20III"), "" when unrecognized
	Class        string // thermal | label | laser | inkjet | other | unknown
	Confidence   string // high | medium | low | "" (no identification)
	Source       string // evidence that decided the verdict
}

// IdentityEvidence carries the raw identification strings from every
// source. Empty fields are simply absent evidence.
type IdentityEvidence struct {
	QueueName        string
	DriverName       string
	SysDescr         string // SNMP sysDescr / hrDeviceDescr
	MDNSManufacturer string
	MDNSModel        string
	IPPMakeModel     string // IPP printer-make-and-model, device-reported
	USBManufacturer  string
	USBProduct       string
	USBVID           string // 4 hex digits, any case, optional 0x prefix
}

// printerVendor is one canonical manufacturer and its recognized aliases.
type printerVendor struct {
	Canonical string
	Aliases   []string
}

// printerVendors is ordered: more specific aliases are matched before
// shorter ones within the same text scan (the scanner prefers the
// longest alias at the earliest position, so ordering here is only a
// tie-breaker for readability).
var printerVendors = []printerVendor{
	{"Epson", []string{"seiko epson", "epson"}},
	{"Bixolon", []string{"bixolon"}},
	{"Xprinter", []string{"xprinter"}},
	{"Zebra", []string{"zebra technologies", "zdesigner", "zebra"}},
	{"TSC", []string{"tsc auto id", "tsc"}},
	{"Citizen", []string{"citizen systems", "citizen"}},
	{"Star Micronics", []string{"star micronics", "star"}},
	{"SNBC", []string{"snbc"}},
	{"Rongta", []string{"rongta"}},
	{"POSBANK", []string{"posbank"}},
	{"HPRT", []string{"hprt"}},
	{"Godex", []string{"godex"}},
	{"SATO", []string{"sato"}},
	{"Argox", []string{"argox"}},
	{"DYMO", []string{"dymo"}},
	{"Brother", []string{"brother"}},
	{"HP", []string{"hewlett-packard", "hewlett packard", "hp"}},
	{"Canon", []string{"canon"}},
	{"Samsung", []string{"samsung"}},
	{"Xerox", []string{"xerox", "fuji xerox"}},
	{"Lexmark", []string{"lexmark"}},
	{"Ricoh", []string{"ricoh"}},
	{"Kyocera", []string{"kyocera"}},
	{"Konica Minolta", []string{"konica minolta", "konica", "bizhub"}},
	{"Sharp", []string{"sharp"}},
	{"Toshiba", []string{"toshiba tec", "toshiba"}},
	{"OKI", []string{"oki data", "okidata", "oki"}},
	{"Pantum", []string{"pantum"}},
	{"Honeywell", []string{"honeywell", "intermec", "datamax"}},
	{"Sewoo", []string{"sewoo"}},
	{"Munbyn", []string{"munbyn"}},
	{"Fujitsu", []string{"fujitsu"}},
	{"Panasonic", []string{"panasonic"}},
	{"Casio", []string{"casio"}},
	{"NCR", []string{"ncr"}},
	{"Posiflex", []string{"posiflex"}},
	{"CUSTOM", []string{"custom engineering"}},
	{"Sunmi", []string{"sunmi"}},
}

// usbVendorIDs maps well-known USB vendor IDs (lowercase hex, no prefix)
// to canonical manufacturers. Only IDs that are certain are listed; an
// unknown VID yields no identification rather than a guess.
var usbVendorIDs = map[string]string{
	"04b8": "Epson",
	"04f9": "Brother",
	"03f0": "HP",
	"04a9": "Canon",
	"0a5f": "Zebra",
	"043d": "Lexmark",
	"04e8": "Samsung",
	"0924": "Xerox",
	"0482": "Kyocera",
	"05ca": "Ricoh",
	"0922": "DYMO",
	"0519": "Star Micronics",
	"1504": "Bixolon",
	"0c2e": "Honeywell",
}

// classByModelPrefix gives the device class for well-known model
// families, keyed by canonical vendor. Prefixes are matched against the
// normalized (uppercased, separator-stripped) model start.
var classByModelPrefix = []struct {
	Vendor string
	Prefix string
	Class  string
}{
	// Epson: TM/CT/EU receipt = thermal; WF/ET/XP/Expression inkjet;
	// AcuLaser/AL laser. LQ/FX impact models intentionally absent:
	// dot-matrix has no word in the wire class vocabulary, so those
	// stay class-unknown while make/model still identify.
	{"Epson", "TM", "thermal"}, {"Epson", "CT", "thermal"}, {"Epson", "EU", "thermal"},
	{"Epson", "UB", "thermal"}, {"Epson", "WF", "inkjet"}, {"Epson", "ET", "inkjet"},
	{"Epson", "XP", "inkjet"}, {"Epson", "SC", "inkjet"}, {"Epson", "AL", "laser"},
	{"Epson", "ACULASER", "laser"},
	// Bixolon: SRP/SPP receipt-mobile thermal; SLP/XQ label.
	{"Bixolon", "SRP", "thermal"}, {"Bixolon", "SPP", "thermal"}, {"Bixolon", "SRH", "thermal"},
	{"Bixolon", "SLP", "label"}, {"Bixolon", "XQ", "label"}, {"Bixolon", "XM", "label"},
	// Zebra: the desktop/mobile/industrial families are label printers.
	{"Zebra", "ZD", "label"}, {"Zebra", "ZT", "label"}, {"Zebra", "GK", "label"},
	{"Zebra", "GX", "label"}, {"Zebra", "GC", "label"}, {"Zebra", "ZQ", "label"},
	{"Zebra", "ZP", "label"}, {"Zebra", "LP", "label"}, {"Zebra", "TLP", "label"},
	// TSC / Godex / SATO / Argox: label houses.
	{"TSC", "TTP", "label"}, {"TSC", "TDP", "label"}, {"TSC", "ME", "label"}, {"TSC", "DA", "label"}, {"TSC", "TE", "label"},
	{"Godex", "DT", "label"}, {"Godex", "RT", "label"}, {"Godex", "EZ", "label"}, {"Godex", "G", "label"},
	{"SATO", "CL", "label"}, {"SATO", "WS", "label"}, {"SATO", "CG", "label"}, {"SATO", "PW", "label"},
	{"Argox", "CP", "label"}, {"Argox", "OS", "label"}, {"Argox", "X", "label"},
	// Citizen: CL label; CT/CMP receipt thermal.
	{"Citizen", "CL", "label"}, {"Citizen", "CT", "thermal"}, {"Citizen", "CMP", "thermal"}, {"Citizen", "PPU", "thermal"},
	// Star: TSP/mC receipt thermal.
	{"Star Micronics", "TSP", "thermal"}, {"Star Micronics", "MC", "thermal"}, {"Star Micronics", "MPOP", "thermal"}, {"Star Micronics", "BSC", "thermal"},
	// Brother: QL/TD label; PJ/RJ mobile thermal; HL laser; J ink tanks.
	{"Brother", "QL", "label"}, {"Brother", "TD", "label"}, {"Brother", "PJ", "thermal"},
	{"Brother", "RJ", "thermal"}, {"Brother", "HL", "laser"}, {"Brother", "DCP-L", "laser"},
	{"Brother", "MFC-L", "laser"}, {"Brother", "MFC-J", "inkjet"}, {"Brother", "DCP-J", "inkjet"},
	{"Brother", "DCP-T", "inkjet"}, {"Brother", "MFC-T", "inkjet"},
	// Ricoh office families are laser (SP printers, MP/IM MFPs);
	// Lexmark MS/MX mono and CS/CX color families are laser.
	{"Ricoh", "SP", "laser"}, {"Ricoh", "MP", "laser"}, {"Ricoh", "IM", "laser"},
	{"Lexmark", "MS", "laser"}, {"Lexmark", "MX", "laser"}, {"Lexmark", "CS", "laser"}, {"Lexmark", "CX", "laser"},
	// HP: PageWide is ink; DesignJet plotters stay unclassified by class.
	{"HP", "PAGEWIDE", "inkjet"},
	// Sewoo / SNBC / Rongta / POSBANK / HPRT receipt families.
	{"Sewoo", "SLK", "thermal"}, {"Sewoo", "LK", "thermal"},
	{"SNBC", "BTP", "thermal"},
	{"Rongta", "RP", "thermal"},
	{"POSBANK", "A", "thermal"}, {"POSBANK", "TP", "thermal"},
	{"HPRT", "TP", "thermal"}, {"HPRT", "POS", "thermal"}, {"HPRT", "LP", "label"},
	// DYMO: LabelWriter family.
	{"DYMO", "LABELWRITER", "label"}, {"DYMO", "LW", "label"},
	// Xprinter: XP receipt/kitchen thermal by default family.
	{"Xprinter", "XP", "thermal"},
}

// vendorDefaultClass applies when a vendor is known but no model rule
// or keyword matched: vendors that (almost) only build one class.
var vendorDefaultClass = map[string]string{
	"Zebra": "label", "Godex": "label", "SATO": "label", "TSC": "label", "DYMO": "label",
	"Bixolon": "thermal", "Xprinter": "thermal", "Star Micronics": "thermal",
	"Sewoo": "thermal", "SNBC": "thermal", "Rongta": "thermal", "POSBANK": "thermal",
	"Pantum": "laser",
}

// modelStopTokens are dropped when extracting a model name from free
// text: transport/driver/packaging noise, never model content.
var modelStopTokens = map[string]bool{
	"series": true, "driver": true, "pcl": true, "pcl6": true, "ps": true,
	"usb": true, "lan": true, "wifi": true, "wireless": true, "network": true,
	"printer": true, "printing": true, "support": true, "class": true,
	"generic": true, "windows": true, "for": true, "the": true, "and": true,
	"receipt": true, "thermal": true, "barcode": true, "label": true,
	"color": true, "colour": true, "mono": true, "monochrome": true,
	"pos": true, "corporation": true, "corp": true, "inc": true,
	"ltd": true, "gmbh": true, "technologies": true,
}

// IdentifyPrinter fuses all available evidence into one identity
// verdict. Device-reported sources (IPP make-and-model, SNMP sysDescr,
// mDNS, USB strings) outrank operator/driver text (driver name, then
// queue name): what the device says about itself is the strongest
// evidence of what it is.
func IdentifyPrinter(ev IdentityEvidence) PrinterIdentity {
	type source struct {
		text       string
		name       string
		confidence string
	}
	mdns := strings.TrimSpace(strings.Join([]string{ev.MDNSManufacturer, ev.MDNSModel}, " "))
	usb := strings.TrimSpace(strings.Join([]string{ev.USBManufacturer, ev.USBProduct}, " "))
	sources := []source{
		{ev.IPPMakeModel, "ipp_make_model", "high"},
		{ev.SysDescr, "snmp_sysdescr", "high"},
		{mdns, "mdns", "high"},
		{usb, "usb_string", "high"},
		{ev.DriverName, "driver_name", "medium"},
		{ev.QueueName, "queue_name", "low"},
	}
	var (
		vendor     string
		vendorText string
		vendorSrc  source
	)
	for _, s := range sources {
		if strings.TrimSpace(s.text) == "" {
			continue
		}
		if v := findVendor(s.text); v != "" {
			vendor, vendorText, vendorSrc = v, s.text, s
			break
		}
	}
	// Class evidence may come from a different (even weaker) source
	// than the vendor evidence, so every text participates in the
	// class scan in the same priority order.
	allText := make([]string, 0, len(sources))
	for _, s := range sources {
		if strings.TrimSpace(s.text) != "" {
			allText = append(allText, s.text)
		}
	}
	id := PrinterIdentity{Class: "unknown"}
	if vendor != "" {
		id.Manufacturer = vendor
		id.Source = vendorSrc.name
		id.Confidence = vendorSrc.confidence
		id.Model = extractModel(vendorText, vendor)
		if id.Model == "" {
			// The source that named the vendor may carry no model
			// ("Zebra Label" driver) while a weaker source does
			// ("Zebra GK420" queue name). Model evidence is better
			// than none, so keep scanning in priority order.
			for _, s := range sources {
				if strings.TrimSpace(s.text) == "" || s.text == vendorText {
					continue
				}
				if findVendor(s.text) == vendor {
					if m := extractModel(s.text, vendor); m != "" {
						id.Model = m
						break
					}
				}
			}
		}
	} else if v := vendorFromVID(ev.USBVID); v != "" {
		id.Manufacturer = v
		id.Source = "usb_vid"
		id.Confidence = "medium"
		id.Model = extractModel(usb, "")
	}
	if cls := identifyClass(id.Manufacturer, id.Model, allText); cls != "" {
		id.Class = cls
		if id.Source == "" {
			id.Source = "class_keywords"
			id.Confidence = "low"
		}
	}
	if id.Manufacturer == "" && id.Class == "unknown" {
		return PrinterIdentity{Class: "unknown"}
	}
	return id
}

// findVendor returns the canonical vendor whose alias appears in text.
// The longest alias wins; ties break toward the earliest position.
func findVendor(text string) string {
	lower := strings.ToLower(text)
	best, bestLen, bestPos := "", 0, len(lower)+1
	for _, v := range printerVendors {
		for _, alias := range v.Aliases {
			if pos := strings.Index(lower, alias); pos >= 0 {
				if len(alias) > bestLen || (len(alias) == bestLen && pos < bestPos) {
					best, bestLen, bestPos = v.Canonical, len(alias), pos
				}
			}
		}
	}
	return best
}

func vendorFromVID(vid string) string {
	v := strings.ToLower(strings.TrimSpace(vid))
	v = strings.TrimPrefix(v, "0x")
	if len(v) > 4 {
		v = v[len(v)-4:]
	}
	return usbVendorIDs[v]
}

// extractModel pulls a normalized model designation out of the text
// that named the vendor: the vendor alias is removed and the remaining
// leading tokens are kept (minus noise tokens), e.g.
// "EPSON TM-T20III Series" -> "TM-T20III",
// "HP LaserJet Pro M404dn" -> "LaserJet Pro M404dn".
func extractModel(text, vendor string) string {
	lower := strings.ToLower(text)
	rest := text
	removedAlias := ""
	if vendor != "" {
		for _, v := range printerVendors {
			if v.Canonical != vendor {
				continue
			}
			bestPos, bestLen := -1, 0
			for _, alias := range v.Aliases {
				if pos := strings.Index(lower, alias); pos >= 0 && (bestPos < 0 || pos < bestPos || (pos == bestPos && len(alias) > bestLen)) {
					bestPos, bestLen = pos, len(alias)
					removedAlias = alias
				}
			}
			if bestPos >= 0 {
				rest = strings.TrimSpace(text[bestPos+bestLen:])
			}
			break
		}
	}
	if removedAlias != "" {
		// Device strings often repeat the brand ("Pantum" as the USB
		// manufacturer and "Pantum M6200W" as the product). Strip a
		// repeated LEADING mention of the SAME alias that was just
		// removed, so the model does not double-count it. Only the
		// same alias: a different alias leading the remainder is a
		// product line that belongs to the model ("KONICA MINOLTA
		// bizhub C250i" must keep "bizhub"). Each strip shortens the
		// string, so the loop always terminates.
		for {
			trimmed := strings.TrimSpace(rest)
			lowerTrim := strings.ToLower(trimmed)
			if lowerTrim == removedAlias {
				rest = ""
				break
			}
			if strings.HasPrefix(lowerTrim, removedAlias+" ") {
				rest = trimmed[len(removedAlias):]
				continue
			}
			rest = trimmed
			break
		}
	}
	fields := strings.Fields(rest)
	kept := make([]string, 0, 4)
	for _, f := range fields {
		tok := strings.Trim(f, "®™()[]{}<>\"'")
		if tok == "" || modelStopTokens[strings.ToLower(tok)] {
			continue
		}
		kept = append(kept, tok)
		if len(kept) == 4 {
			break
		}
	}
	return strings.Join(kept, " ")
}

// identifyClass decides the device class from the vendor's model
// families first, then generic technology keywords, then the vendor
// default. "" means no class evidence (caller renders "unknown").
func identifyClass(vendor, model string, texts []string) string {
	joined := strings.ToLower(strings.Join(texts, " "))
	compactModel := strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "_", "").Replace(model))
	if vendor != "" && compactModel != "" {
		best := ""
		bestLen := 0
		for _, rule := range classByModelPrefix {
			// Prefixes are written readably ("MFC-J") but matched
			// against the separator-stripped model ("MFCJ995DW").
			compactPrefix := strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "_", "").Replace(rule.Prefix))
			if rule.Vendor == vendor && strings.HasPrefix(compactModel, compactPrefix) && len(compactPrefix) > bestLen {
				best, bestLen = rule.Class, len(compactPrefix)
			}
		}
		if best != "" {
			return best
		}
	}
	switch {
	case strings.Contains(joined, "labelwriter") || strings.Contains(joined, "label printer") || strings.Contains(joined, "barcode printer") || strings.Contains(joined, "label)"):
		return "label"
	case strings.Contains(joined, "laserjet") || strings.Contains(joined, "laser") || strings.Contains(joined, "imageclass") || strings.Contains(joined, "ecosys") || strings.Contains(joined, "versalink") || strings.Contains(joined, "altalink") || strings.Contains(joined, "workcentre") || strings.Contains(joined, "bizhub") || strings.Contains(joined, "xpress") || strings.Contains(joined, "phaser") || strings.Contains(joined, "i-sensys"):
		return "laser"
	case strings.Contains(joined, "inkjet") || strings.Contains(joined, "deskjet") || strings.Contains(joined, "officejet") || strings.Contains(joined, "pixma") || strings.Contains(joined, "ecotank") || strings.Contains(joined, "envy") || strings.Contains(joined, "pagewide") || strings.Contains(joined, "workforce") || strings.Contains(joined, "supertank") || strings.Contains(joined, "ink tank"):
		return "inkjet"
	case strings.Contains(joined, "thermal") || strings.Contains(joined, "receipt printer") || strings.Contains(joined, "pos printer") || strings.Contains(joined, "pos80") || strings.Contains(joined, "pos58"):
		return "thermal"
	case strings.Contains(joined, "label"):
		return "label"
	}
	if vendor != "" {
		if cls, ok := vendorDefaultClass[vendor]; ok {
			return cls
		}
	}
	return ""
}

// enrichIdentity stamps the unified identification verdict onto a
// DeviceInfo and upgrades PrinterType when it is still "unknown" and
// the verdict carries a class.
//
// The make/model land in NAMESPACED capability keys
// (identified_manufacturer / identified_model) on purpose: the plain
// "manufacturer" / "model" capability keys are inputs to the durable
// serial-based stable ID (stable_id.go), so writing normalized values
// into them — or filling them where a producer previously left them
// empty — would silently rebind printers that are already registered
// under the old key. Identification is display and classification
// evidence; it must never rewrite identity.
func enrichIdentity(di *DeviceInfo, ev IdentityEvidence) PrinterIdentity {
	id := IdentifyPrinter(ev)
	if di.Capabilities == nil {
		di.Capabilities = map[string]interface{}{}
	}
	if id.Manufacturer != "" {
		di.Capabilities["identified_manufacturer"] = id.Manufacturer
	}
	if id.Model != "" {
		di.Capabilities["identified_model"] = id.Model
	}
	if id.Source != "" {
		di.Capabilities["identity_source"] = id.Source
		di.Capabilities["identity_confidence"] = id.Confidence
	}
	if (di.PrinterType == "" || di.PrinterType == "unknown") && id.Class != "" && id.Class != "unknown" {
		di.PrinterType = id.Class
	}
	return id
}
