package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
)

type ippResolution struct {
	X, Y  int
	Units byte
}

func (r ippResolution) dpi() (int, int) {
	if r.Units == 4 {
		return (r.X*254 + 50) / 100, (r.Y*254 + 50) / 100
	}
	return r.X, r.Y
}
func ippResolutions(raw string) []ippResolution {
	var out []ippResolution
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(strings.ToLower(item))
		unit, suffix := byte(3), "dpi"
		if strings.HasSuffix(item, "dpcm") {
			unit, suffix = 4, "dpcm"
		}
		if !strings.HasSuffix(item, suffix) {
			continue
		}
		parts := strings.Split(strings.TrimSuffix(item, suffix), "x")
		if len(parts) != 2 {
			continue
		}
		x, ex := strconv.Atoi(parts[0])
		y, ey := strconv.Atoi(parts[1])
		if ex != nil || ey != nil || x < 1 || y < 1 || x > 9600 || y > 9600 {
			continue
		}
		r := ippResolution{x, y, unit}
		dx, dy := r.dpi()
		if dx > 9600 || dy > 9600 {
			continue
		}
		out = append(out, r)
	}
	return out
}
func ippSelectedResolution(attrs map[string]string) *ippResolution {
	values := ippResolutions(attrs["printer-resolution-supported"])
	defaults := ippResolutions(attrs["printer-resolution-default"])
	for _, d := range defaults {
		for _, r := range values {
			if r == d {
				selected := r
				return &selected
			}
		}
	}
	if len(values) == 0 {
		return nil
	}
	best := values[0]
	for _, r := range values[1:] {
		x, _ := r.dpi()
		b, _ := best.dpi()
		if (x <= 300 && (b > 300 || x > b)) || (b > 300 && x < b) {
			best = r
		}
	}
	return &best
}

var ippMediaKeywordSize = regexp.MustCompile(`(?:^|_)([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)(mm|in)$`)

func ippMediaFromKeyword(keyword string) (ippMedia, bool) {
	match := ippMediaKeywordSize.FindStringSubmatch(keyword)
	if match == nil {
		return ippMedia{}, false
	}
	w, ew := strconv.ParseFloat(match[1], 64)
	h, eh := strconv.ParseFloat(match[2], 64)
	if match[3] == "in" {
		w *= 25.4
		h *= 25.4
	}
	if ew != nil || eh != nil || w <= 0 || h <= 0 || w > 10000 || h > 10000 {
		return ippMedia{}, false
	}
	x, y := int(math.Round(w*100)), int(math.Round(h*100))
	if x < 1 || y < 1 {
		return ippMedia{}, false
	}
	return ippMedia{Width: ippMediaDimension{x, x}, Height: ippMediaDimension{y, y}, Keyword: keyword}, true
}
func ippAdvertisedMedia(attrs map[string]string, selectedOnly bool) ([]ippMedia, error) {
	var out []ippMedia
	names := []string{"media-col-ready", "media-col-default"}
	if !selectedOnly {
		names = append(names, "media-col-database")
	}
	for _, name := range names {
		if raw := attrs[name]; raw != "" {
			var values []ippMedia
			if err := json.Unmarshal([]byte(raw), &values); err != nil || len(values) > 256 {
				return nil, fmt.Errorf("invalid parsed IPP %s", name)
			}
			out = append(out, values...)
		}
	}
	keywords := []string{"media-ready", "media-default"}
	if !selectedOnly {
		keywords = append(keywords, "media-supported")
	}
	for _, name := range keywords {
		for _, keyword := range strings.Split(attrs[name], ",") {
			if m, ok := ippMediaFromKeyword(keyword); ok {
				out = append(out, m)
			}
		}
	}
	return out, nil
}
func ippMediaMatches(m ippMedia, w, h int) bool {
	// PDF producers commonly round points to whole numbers; a quarter mm
	// accepts that representation error without treating another stock as equal.
	const tolerance = 25
	axis := func(d ippMediaDimension, n int) bool {
		if d.Min == d.Max {
			return n >= d.Min-tolerance && n <= d.Max+tolerance
		}
		return n >= d.Min && n <= d.Max
	}
	return axis(m.Width, w) && axis(m.Height, h)
}

type ippJobOptions struct {
	Media       ippMedia
	Resolution  *ippResolution
	ScalingNone bool
	Orientation int
}

func selectIPPMedia(attrs map[string]string, pages []ippPDFPage) (*ippJobOptions, error) {
	if len(pages) == 0 {
		return nil, fmt.Errorf("IPP document has no measured pages")
	}
	for _, page := range pages {
		if page.WidthPoints <= 0 || page.HeightPoints <= 0 || math.IsNaN(page.WidthPoints) || math.IsNaN(page.HeightPoints) || math.IsInf(page.WidthPoints, 0) || math.IsInf(page.HeightPoints, 0) || page.WidthPoints > 10000*72/25.4 || page.HeightPoints > 10000*72/25.4 {
			return nil, fmt.Errorf("invalid PDF media dimensions")
		}
	}
	media, err := ippAdvertisedMedia(attrs, false)
	if err != nil {
		return nil, err
	}
	if len(media) == 0 {
		return nil, fmt.Errorf("IPP printer did not advertise usable media dimensions; configure an installed Windows driver with the correct paper")
	}
	w, h := int(math.Round(pages[0].WidthPoints*25.4/72*100)), int(math.Round(pages[0].HeightPoints*25.4/72*100))
	if w < 1 || h < 1 {
		return nil, fmt.Errorf("PDF media is below IPP dimension precision")
	}
	for _, page := range pages[1:] {
		if math.Abs(page.WidthPoints-pages[0].WidthPoints) > 0.5 || math.Abs(page.HeightPoints-pages[0].HeightPoints) > 0.5 {
			return nil, fmt.Errorf("mixed-size PDF requires a verified Windows driver; one IPP job cannot silently substitute media per page")
		}
	}
	for _, m := range media {
		orientation := 0
		mw, mh := w, h
		if !ippMediaMatches(m, mw, mh) {
			if !ippContainsValue(attrs["orientation-requested-supported"], "4") || !ippMediaMatches(m, h, w) {
				continue
			}
			mw, mh, orientation = h, w, 4
		}
		if m.Width.Min != m.Width.Max {
			m.Width = ippMediaDimension{mw, mw}
		}
		if m.Height.Min != m.Height.Max {
			m.Height = ippMediaDimension{mh, mh}
		}
		return &ippJobOptions{Media: m, Resolution: ippSelectedResolution(attrs), ScalingNone: ippContainsValue(attrs["print-scaling-supported"], "none"), Orientation: orientation}, nil
	}
	return nil, fmt.Errorf("PDF media %.2fx%.2f mm does not match advertised IPP media; no document was submitted", float64(w)/100, float64(h)/100)
}
func ippContainsValue(raw, want string) bool {
	for _, v := range strings.Split(raw, ",") {
		if strings.TrimSpace(v) == want {
			return true
		}
	}
	return false
}

func writeIPPBinary(buf *bytes.Buffer, tag byte, name string, value []byte) {
	buf.WriteByte(tag)
	_ = binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	_ = binary.Write(buf, binary.BigEndian, uint16(len(value)))
	buf.Write(value)
}
func writeIPPInteger(buf *bytes.Buffer, name string, value int) {
	var raw [4]byte
	binary.BigEndian.PutUint32(raw[:], uint32(value))
	writeIPPBinary(buf, 0x21, name, raw[:])
}
func writeIPPMediaMember(buf *bytes.Buffer, name string, value int) {
	writeIPPAttribute(buf, 0x4a, "", name)
	writeIPPInteger(buf, "", value)
}
func writeIPPJobOptions(buf *bytes.Buffer, o *ippJobOptions) {
	buf.WriteByte(2)
	m := o.Media
	if m.Collection {
		writeIPPAttribute(buf, 0x34, "media-col", "")
		writeIPPAttribute(buf, 0x4a, "", "media-size")
		writeIPPAttribute(buf, 0x34, "", "")
		writeIPPMediaMember(buf, "x-dimension", m.Width.Min)
		writeIPPMediaMember(buf, "y-dimension", m.Height.Min)
		writeIPPAttribute(buf, 0x37, "", "")
		for _, f := range []struct {
			name  string
			value *int
		}{{"media-left-margin", m.Left}, {"media-right-margin", m.Right}, {"media-top-margin", m.Top}, {"media-bottom-margin", m.Bottom}} {
			if f.value != nil {
				writeIPPMediaMember(buf, f.name, *f.value)
			}
		}
		for _, f := range []struct{ name, value string }{{"media-source", m.Source}, {"media-type", m.Type}} {
			if f.value != "" {
				writeIPPAttribute(buf, 0x4a, "", f.name)
				writeIPPAttribute(buf, 0x44, "", f.value)
			}
		}
		writeIPPAttribute(buf, 0x37, "", "")
	} else {
		writeIPPAttribute(buf, 0x44, "media", m.Keyword)
	}
	if o.Resolution != nil {
		var raw [9]byte
		binary.BigEndian.PutUint32(raw[:4], uint32(o.Resolution.X))
		binary.BigEndian.PutUint32(raw[4:8], uint32(o.Resolution.Y))
		raw[8] = o.Resolution.Units
		writeIPPBinary(buf, 0x32, "printer-resolution", raw[:])
	}
	if o.ScalingNone {
		writeIPPAttribute(buf, 0x44, "print-scaling", "none")
	}
	if o.Orientation != 0 {
		var raw [4]byte
		binary.BigEndian.PutUint32(raw[:], uint32(o.Orientation))
		writeIPPBinary(buf, 0x23, "orientation-requested", raw[:])
	}
}

// PrinterGeometry reports only an unambiguous selected media with all four
// real margins and a supported device resolution. Unknown fields stay unknown.
func (p *IPPPrinter) PrinterGeometry(ctx context.Context) (*Geometry, error) {
	attrs, err := p.getPrinterAttributes(ctx)
	if err != nil {
		return nil, err
	}
	return ippGeometryFromAttributes(p.geometryConfig, attrs)
}
func ippGeometryFromAttributes(cfg config.PrinterConfig, attrs map[string]string) (*Geometry, error) {
	media, err := ippAdvertisedMedia(attrs, true)
	if err != nil {
		return nil, err
	}
	resolution := ippSelectedResolution(attrs)
	if resolution == nil {
		return nil, fmt.Errorf("IPP geometry requires an advertised supported resolution")
	}
	// The configured default is deterministic when several trays are ready.
	if raw := attrs["media-col-default"]; raw != "" {
		if err = json.Unmarshal([]byte(raw), &media); err != nil {
			return nil, err
		}
	}
	var chosen *ippMedia
	for _, m := range media {
		if !m.Collection || m.Width.Min != m.Width.Max || m.Height.Min != m.Height.Max || m.Left == nil || m.Right == nil || m.Top == nil || m.Bottom == nil {
			continue
		}
		if chosen != nil && (chosen.Width != m.Width || chosen.Height != m.Height || *chosen.Left != *m.Left || *chosen.Right != *m.Right || *chosen.Top != *m.Top || *chosen.Bottom != *m.Bottom) {
			return nil, fmt.Errorf("IPP selected media is ambiguous; choose a default paper profile on the printer")
		}
		copy := m
		chosen = &copy
	}
	if chosen == nil {
		return nil, fmt.Errorf("IPP geometry requires actual selected media dimensions and margins")
	}
	m := *chosen
	dx, dy := resolution.dpi()
	physicalDX, physicalDY := float64(resolution.X), float64(resolution.Y)
	if resolution.Units == 4 {
		physicalDX *= 2.54
		physicalDY *= 2.54
	}
	pw, ph := float64(m.Width.Min)/100, float64(m.Height.Min)/100
	width := int(math.Floor(float64(m.Width.Min-*m.Left-*m.Right) * physicalDX / 2540))
	height := int(math.Floor(float64(m.Height.Min-*m.Top-*m.Bottom) * physicalDY / 2540))
	ox, oy := int(math.Round(float64(*m.Left)*physicalDX/2540)), int(math.Round(float64(*m.Top)*physicalDY/2540))
	profile := config.GeometryProfile{PrintableWidthDots: width, PrintableHeightDots: &height, PaperWidthMM: &pw, PaperHeightMM: &ph, OffsetXDots: &ox, OffsetYDots: &oy}
	// The v1 shared contract has integral DPI. Preserve exact dots from dpcm,
	// but omit an axis that cannot be represented exactly instead of claiming
	// e.g.118 dpcm is an observed300dpi. Native IPP retains original units.
	if resolution.Units == 3 || resolution.X*254%100 == 0 {
		profile.DPIX = &dx
	}
	if resolution.Units == 3 || resolution.Y*254%100 == 0 {
		profile.DPIY = &dy
	}
	key, _ := json.Marshal(struct {
		Media       ippMedia
		Resolution  ippResolution
		Formats     string
		PrinterUUID string
	}{m, *resolution, attrs["document-format-supported"], attrs["printer-uuid"]})
	return NewGeometry(cfg, profile, "ipp", "observed", string(key))
}

func ippObservedCapabilities(attrs map[string]string) map[string]interface{} {
	if len(attrs) == 0 {
		return nil
	}
	media, err := ippAdvertisedMedia(attrs, false)
	if err != nil {
		return nil
	}
	truncated := len(media) > 64
	if truncated {
		media = media[:64]
	}
	return map[string]interface{}{"ipp_capabilities": map[string]interface{}{
		"printer_uuid":     normalizedIPPPrinterUUID(attrs["printer-uuid"]),
		"document_formats": parseIPPSupportedFormats(attrs),
		"media":            media, "media_truncated": truncated,
		"resolution_supported":     attrs["printer-resolution-supported"],
		"resolution_default":       attrs["printer-resolution-default"],
		"pwg_resolution_supported": attrs["pwg-raster-document-resolution-supported"],
		"pwg_type_supported":       attrs["pwg-raster-document-type-supported"],
		"print_scaling_supported":  attrs["print-scaling-supported"],
	}}
}

func (p *IPPPrinter) ObservedCapabilities() map[string]interface{} {
	p.statusMu.RLock()
	attrs := maps.Clone(p.lastAttributes)
	p.statusMu.RUnlock()
	return ippObservedCapabilities(attrs)
}

func addIPPDiscoveryCapabilities(di *DeviceInfo, attrs map[string]string) {
	if di.Capabilities == nil {
		di.Capabilities = make(map[string]interface{})
	}
	for key, value := range ippObservedCapabilities(attrs) {
		di.Capabilities[key] = value
	}
	if uuid := normalizedIPPPrinterUUID(attrs["printer-uuid"]); uuid != "" {
		di.Capabilities["ipp_printer_uuid"] = uuid
		di.Capabilities["printer_uuid"] = uuid
		di.Capabilities["uuid"] = uuid
	}
	cfg := config.PrinterConfig{ID: di.ID, Type: di.Type, ConnectionType: di.ConnectionType, Protocol: di.Protocol, Endpoint: di.Endpoint}
	delete(di.Capabilities, "geometry")
	if geometry, err := ippGeometryFromAttributes(cfg, attrs); err == nil {
		di.Capabilities["geometry"] = geometry
	}
	// Unified identification: printer-make-and-model is the strongest
	// device-reported evidence there is; the mDNS manufacturer/model
	// already on the row are the fallback when the device omits it.
	enrichIdentity(di, IdentityEvidence{
		IPPMakeModel:     attrs["printer-make-and-model"],
		MDNSManufacturer: capString(di.Capabilities, "manufacturer"),
		MDNSModel:        capString(di.Capabilities, "model"),
	})
}
