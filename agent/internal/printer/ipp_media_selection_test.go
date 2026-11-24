package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func ippPageMM(w, h float64) ippPDFPage { return ippPDFPage{w * 72 / 25.4, h * 72 / 25.4} }

func TestIPPMediaSelectionUsesAdvertisedA4A5AndCustomRanges(t *testing.T) {
	for _, tc := range []struct {
		keyword string
		w, h    float64
	}{{"iso_a4_210x297mm", 210, 297}, {"iso_a5_148x210mm", 148, 210}, {"custom_roll_58x150mm", 58, 150}, {"custom_roll_80x4000mm", 80, 4000}, {"custom_roll_104x250mm", 104, 250}, {"na_letter_8.5x11in", 215.9, 279.4}} {
		attrs := map[string]string{"media-supported": tc.keyword, "printer-resolution-supported": "203x203dpi,300x300dpi,600x600dpi", "print-scaling-supported": "none"}
		o, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(tc.w, tc.h)})
		if err != nil || o.Media.Keyword != tc.keyword || !o.ScalingNone {
			t.Fatalf("%s: %+v %v", tc.keyword, o, err)
		}
		if _, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(tc.w+2, tc.h)}); err == nil {
			t.Fatalf("substituted mismatched width for %s", tc.keyword)
		}
	}
	m := ippMedia{Width: ippMediaDimension{8500, 8500}, Height: ippMediaDimension{5000, 90000}, Collection: true}
	encoded, _ := json.Marshal([]ippMedia{m})
	attrs := map[string]string{"media-col-database": string(encoded)}
	if o, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(85, 600)}); err != nil || o.Media.Height.Min != 60000 || o.Media.Height.Max != 60000 {
		t.Fatalf("advertised custom size range: %+v %v", o, err)
	}
	if _, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(85, 901)}); err == nil {
		t.Fatal("accepted beyond advertised custom length")
	}
	if _, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(85, 900.01)}); err == nil {
		t.Fatal("rounding tolerance escaped exact custom size range")
	}
}

func TestIPPMediaRejectsMixedSizesAndUnadvertisedRotation(t *testing.T) {
	attrs := map[string]string{"media-supported": "iso_a4_210x297mm,iso_a5_148x210mm"}
	if _, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(210, 297), ippPageMM(148, 210)}); err == nil {
		t.Fatal("mixed pages silently assigned one media")
	}
	if _, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(297, 210)}); err == nil {
		t.Fatal("invented rotation support")
	}
	attrs["orientation-requested-supported"] = "3,4"
	if o, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(297, 210)}); err != nil || o.Orientation != 4 {
		t.Fatalf("advertised landscape: %+v %v", o, err)
	}
}

func TestIPPMediaCollectionsRejectMalformedAndOverflow(t *testing.T) {
	base := ippMeasuredMediaFixture()
	member := func(name string) []byte { var b bytes.Buffer; writeIPPAttribute(&b, 0x4a, "", name); return b.Bytes() }
	integer := func(n int32) []byte { var b bytes.Buffer; writeIPPIntAttr(&b, 0x21, "", n); return b.Bytes() }
	for name, data := range map[string][]byte{
		"duplicate_member":      bytes.Replace(base, member("media-right-margin"), member("media-left-margin"), 1),
		"zero_dimension":        bytes.Replace(base, integer(8000), integer(0), 1),
		"negative_dimension":    bytes.Replace(base, integer(8000), integer(-1), 1),
		"excessive_dimension":   bytes.Replace(base, integer(8000), integer(math.MaxInt32), 1),
		"negative_margin":       bytes.Replace(base, integer(400), integer(-1), 1),
		"margin_consumes_paper": bytes.Replace(base, integer(400), integer(8000), 1),
		"truncated_collection":  base[:len(base)-6],
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseIPPPrinterAttributes(data, 1); err == nil {
				t.Fatal("accepted malformed media")
			}
		})
	}
	var b bytes.Buffer
	b.Write(ippNoMediaFixture())
	b.Truncate(b.Len() - 1)
	writeIPPAttribute(&b, 0x34, "vendor-nested", "")
	for i := 0; i < 8; i++ {
		writeIPPAttribute(&b, 0x4a, "", "nested")
		writeIPPAttribute(&b, 0x34, "", "")
	}
	for i := 0; i < 9; i++ {
		writeIPPAttribute(&b, 0x37, "", "")
	}
	b.WriteByte(3)
	if _, err := parseIPPPrinterAttributes(b.Bytes(), 1); err == nil {
		t.Fatal("unbounded collection nesting")
	}
}

func TestIPPGeometryPreservesActualMarginsAndDPI(t *testing.T) {
	attrs, err := parseIPPPrinterAttributes(ippMeasuredMediaFixture(), 1)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.PrinterConfig{ID: "ipp-receipt", Type: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/ipp/print"}
	for _, dpi := range []int{203, 300, 600} {
		attrs["printer-resolution-supported"] = fmt.Sprintf("%dx%ddpi", dpi, dpi)
		g, err := ippGeometryFromAttributes(cfg, attrs)
		if err != nil {
			t.Fatal(err)
		}
		if g.PrintableWidthDots != int(math.Floor(72*float64(dpi)/25.4)) || *g.PaperWidthMM != 80 || *g.OffsetXDots != int(math.Round(4*float64(dpi)/25.4)) || *g.DPIX != dpi || *g.DPIY != dpi {
			t.Fatalf("invented dimensions: %+v", g)
		}
		again, err := ippGeometryFromAttributes(cfg, attrs)
		if err != nil || g.ConfigFingerprint != again.ConfigFingerprint {
			t.Fatal("observation timestamp changed fingerprint")
		}
		cfg2 := cfg
		cfg2.Endpoint = "ipp://192.168.1.21/ipp/print"
		changed, err := ippGeometryFromAttributes(cfg2, attrs)
		if err != nil || changed.ConfigFingerprint == g.ConfigFingerprint {
			t.Fatal("destination change retained geometry fingerprint")
		}
	}
	delete(attrs, "printer-resolution-supported")
	if _, err := ippGeometryFromAttributes(cfg, attrs); err == nil {
		t.Fatal("invented unknown device DPI")
	}
	attrs["printer-resolution-supported"] = "118x118dpcm"
	dpcm, err := ippGeometryFromAttributes(cfg, attrs)
	if err != nil || dpcm.PrintableWidthDots != 849 || dpcm.DPIX != nil || dpcm.DPIY != nil {
		t.Fatalf("rounded dpcm was misrepresented as integral measured DPI: %+v %v", dpcm, err)
	}
}

func TestIPPMeasuredMediaRequestContainsFidelityAndBounds(t *testing.T) {
	attrs, err := parseIPPPrinterAttributes(ippMeasuredMediaFixture(), 1)
	if err != nil {
		t.Fatal(err)
	}
	attrs["printer-resolution-supported"] = "203x203dpi"
	attrs["print-scaling-supported"] = "none"
	o, err := selectIPPMedia(attrs, []ippPDFPage{ippPageMM(80, 200)})
	if err != nil {
		t.Fatal(err)
	}
	request := buildIPPPrintJobWithOptions("ipp://printer.local/ipp/print", []byte("DOCUMENT"), ippFormatPDF, o)
	var fidelity bytes.Buffer
	writeIPPBinary(&fidelity, 0x22, "ipp-attribute-fidelity", []byte{1})
	if !bytes.Contains(request, fidelity.Bytes()) || !bytes.HasSuffix(request, []byte("DOCUMENT")) {
		t.Fatal("lost strict fidelity or document")
	}
	for _, name := range []string{"media-col", "x-dimension", "y-dimension", "media-left-margin", "media-right-margin", "media-top-margin", "media-bottom-margin", "printer-resolution", "print-scaling"} {
		if !bytes.Contains(request, []byte(name)) {
			t.Fatalf("missing selected %s", name)
		}
	}
}

func TestIPPWrongMediaNeverTransmitsAndSubstitutionNeverRetries(t *testing.T) {
	for _, status := range []uint16{0, 1, 2} {
		var submissions atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body := readAll(r.Body)
			w.Header().Set("Content-Type", "application/ipp")
			if len(body) >= 8 && binary.BigEndian.Uint16(body[2:4]) == 0x000b {
				response := ippAttrResponse(ippFormatPDF)
				if status == 0 {
					response = bytes.ReplaceAll(response, []byte("iso_a4_210x297mm"), []byte("iso_a5_148x210mm"))
				}
				_, _ = w.Write(response)
				return
			}
			submissions.Add(1)
			_, _ = w.Write(ippAcceptedJobResponse(status, 3))
		}))
		p, err := NewIPPPrinter(server.URL, "strict media")
		if err != nil {
			t.Fatal(err)
		}
		err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
		server.Close()
		if status == 0 {
			if err == nil || OutcomeUnknown(err) || submissions.Load() != 0 || !strings.Contains(err.Error(), "media") {
				t.Fatalf("wrong media reached transport: %v count%d", err, submissions.Load())
			}
		} else if !OutcomeUnknown(err) || submissions.Load() != 1 {
			t.Fatalf("substitution lost unknown/no-retry boundary: %v count%d", err, submissions.Load())
		}
	}
}

func TestIPPPDFInspectionUsesRealPagesAndHonorsCancellation(t *testing.T) {
	pages, err := inspectIPPPDFPages(context.Background(), validPDF())
	if err != nil || len(pages) != 1 || pages[0].WidthPoints != 595 || pages[0].HeightPoints != 842 {
		t.Fatalf("actual PDFium measurement: %v %v", pages, err)
	}
	if _, err := inspectIPPPDFPages(context.Background(), []byte("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n")); err == nil {
		t.Fatal("accepted header-only malformed PDF")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := inspectIPPPDFPages(ctx, validPDF()); err != context.Canceled {
		t.Fatalf("cancellation not honored: %v", err)
	}
}

func TestIPPObservationRefreshChangesGeometryAndClearsFailedProbe(t *testing.T) {
	var phase atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if phase.Load() == 2 {
			w.WriteHeader(503)
			return
		}
		fixture := ippMeasuredMediaFixture()
		if phase.Load() == 1 {
			var old, new bytes.Buffer
			writeIPPIntAttr(&old, 0x21, "", 8000)
			writeIPPIntAttr(&new, 0x21, "", 8200)
			fixture = bytes.Replace(fixture, old.Bytes(), new.Bytes(), 1)
		}
		b := bytes.NewBuffer(fixture)
		b.Truncate(b.Len() - 1)
		resolution := append(ippEvidenceTestInt(300), ippEvidenceTestInt(300)...)
		writeIPPBinary(b, 0x32, "printer-resolution-supported", append(resolution, 3))
		b.WriteByte(3)
		w.Header().Set("Content-Type", "application/ipp")
		_, _ = w.Write(b.Bytes())
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "measured endpoint")
	if err != nil {
		t.Fatal(err)
	}
	// Production binding policy intentionally rejects loopback destinations.
	// This explicit test transport emulates the configured private printer.
	p.geometryConfig = config.PrinterConfig{ID: "ipp-live", Type: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/ipp/print"}
	first, err := p.PrinterGeometry(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if p.ObservedCapabilities()["ipp_capabilities"] == nil {
		t.Fatal("live advertised capabilities lost")
	}
	phase.Store(1)
	changed, err := p.PrinterGeometry(context.Background())
	if err != nil || changed.ConfigFingerprint == first.ConfigFingerprint || *changed.PaperWidthMM != 82 {
		t.Fatalf("media change retained stale geometry: %+v %v", changed, err)
	}
	phase.Store(2)
	if _, err := p.PrinterGeometry(context.Background()); err == nil {
		t.Fatal("failed probe returned geometry")
	}
	if len(p.ObservedCapabilities()) != 0 {
		t.Fatal("failed probe left stale capabilities published")
	}
}

func TestIPPDiscoveryPublishesMeasuredGeometryAndSupportedMedia(t *testing.T) {
	attrs, err := parseIPPPrinterAttributes(ippMeasuredMediaFixture(), 1)
	if err != nil {
		t.Fatal(err)
	}
	attrs["printer-state"] = "3"
	attrs["printer-resolution-supported"] = "203x203dpi"
	devices := []DeviceInfo{{ID: "ipp-discovered", Type: "ipp", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/ipp/print"}}
	verifyMDNSIPPCandidatesWithProbe(context.Background(), devices, func(context.Context, DeviceInfo) (map[string]string, error) { return attrs, nil })
	g := GeometryFromCapabilities(devices[0].Capabilities)
	if g == nil || g.PrinterID != "ipp-discovered" || g.Source != "ipp" || *g.PaperWidthMM != 80 {
		t.Fatalf("lost actual discovery geometry: %+v", g)
	}
	if devices[0].Capabilities["ipp_capabilities"] == nil || devices[0].Status != "online" {
		t.Fatalf("lost media/format/status: %+v", devices[0])
	}
}

func TestIPPMediaSelectionRejectsInvalidGeometryBeforeIntegerConversion(t *testing.T) {
	attrs := map[string]string{"media-supported": "iso_a4_210x297mm"}
	for _, p := range []ippPDFPage{{0, 842}, {-1, 842}, {math.NaN(), 842}, {595, math.Inf(1)}, {math.MaxFloat64, 842}, {0.0001, 842}} {
		if _, err := selectIPPMedia(attrs, []ippPDFPage{p}); err == nil {
			t.Fatalf("invalid media accepted: %+v", p)
		}
	}
}

func TestIPPLateCapabilityProbeCannotOverwriteNewerMedia(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		fixture := ippMeasuredMediaFixture()
		if call == 1 {
			close(entered)
			<-release
		} else {
			var old, new bytes.Buffer
			writeIPPIntAttr(&old, 0x21, "", 8000)
			writeIPPIntAttr(&new, 0x21, "", 8200)
			fixture = bytes.Replace(fixture, old.Bytes(), new.Bytes(), 1)
		}
		w.Header().Set("Content-Type", "application/ipp")
		_, _ = w.Write(fixture)
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "concurrent capability probes")
	if err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan error, 1)
	go func() { _, err := p.getPrinterAttributes(context.Background()); firstDone <- err }()
	<-entered
	_, secondErr := p.getPrinterAttributes(context.Background())
	close(release)
	firstErr := <-firstDone
	if firstErr != nil || secondErr != nil {
		t.Fatalf("fixture probe error: %v %v", firstErr, secondErr)
	}
	caps := p.ObservedCapabilities()["ipp_capabilities"].(map[string]interface{})
	media := caps["media"].([]ippMedia)
	if len(media) == 0 || media[0].Width.Min != 8200 {
		t.Fatalf("older response replaced fresh media: %+v", media)
	}
}
