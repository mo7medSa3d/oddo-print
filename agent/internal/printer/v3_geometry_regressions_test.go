package printer

import (
	"github.com/yaseir-agent/agent/internal/config"
	"strings"
	"testing"

	"github.com/klippa-app/go-pdfium/requests"
)

func TestV3UnknownRasterGeometryNeverInventsDotWidth(t *testing.T) {
	for _, caps := range []map[string]interface{}{
		nil, {}, {"paper_widths": []int{58, 80}}, {"paper_width_mm": 80, "print_dpi": 203},
		{"max_paper_width": 58}, {"max_paper_width": 80}, {"max_paper_width": 0},
		{"max_paper_width": -1}, {"max_paper_width": MaxJPEGDimension + 1},
	} {
		if got := RasterMaxWidthFromCapabilities(caps); got != 0 {
			t.Errorf("unverified geometry %v invented %d printable dots", caps, got)
		}
	}
	for _, mm := range []int{0, 58, 80, 75, 210} {
		if got := RasterMaxWidthFromPaperWidthMM(mm); got != 0 {
			t.Errorf("nominal %dmm invented %d printable dots", mm, got)
		}
		if got := RasterMaxWidthForConfiguredPaper(mm, map[string]interface{}{"print_dpi": 203}); got != 0 {
			t.Errorf("nominal %dmm and DPI invented %d printable dots", mm, got)
		}
	}
}

func TestV3ExplicitDotBudgetIsNotClampedToAnInventedPrinthead(t *testing.T) {
	for _, width := range []int{288, 384, 512, 576, 832, 850, 1664, 1700} {
		caps := map[string]interface{}{"max_paper_width": width}
		if got := RasterMaxWidthFromCapabilities(caps); got != width {
			t.Errorf("explicit %d dots changed to %d", width, got)
		}
		if got := RasterMaxWidthForConfiguredPaper(80, caps); got != width {
			t.Errorf("configured explicit %d dots changed to %d", width, got)
		}
	}
}

func TestV3RasterConversionRequiresAnExplicitDotBudget(t *testing.T) {
	data := createTestJPEG(576, 8)
	for _, width := range []int{0, -1, MaxJPEGDimension + 1} {
		if output, err := JPEGToESCPOSWithMaxWidth(data, 256, width); err == nil || len(output) != 0 {
			t.Errorf("invalid/unknown width %d produced %d bytes, error=%v", width, len(output), err)
		}
	}
}

func TestV3ReceiptPDFRequiresActualDotsAndDPI(t *testing.T) {
	data := createTestJPEG(576, 8)
	for _, profile := range [][3]int{{80, 0, 203}, {58, 0, 180}, {80, 576, 0}, {58, 384, 0}} {
		if output, err := JPEGToPDFReceipt(data, profile[0], profile[1], profile[2]); err == nil || len(output) != 0 {
			t.Errorf("incomplete physical profile %v produced %d bytes, error=%v", profile, len(output), err)
		}
	}
}

func TestV3LongReceiptRefusesUnsegmentedHeightShrinking(t *testing.T) {
	plan := pdfPagePlan{width: 80 * 72 / 25.4, height: 4000 * 72 / 25.4,
		crop: &requests.RenderPageCrop{Width: 576 * 72.0 / 203, Height: 4000 * 72 / 25.4}}
	_, _, width, _, err := plan.printableDestination(640, 4000, 576, 3976, 203, 203, 32, 12)
	if err == nil {
		t.Fatalf("unsegmented 4m receipt silently reduced a576-dot printable width to%d; it must be paginated before submission", width)
	}
}

func TestV3DeclaredUSBESCPOSAcceptsImageConversion(t *testing.T) {
	geometry := testRasterGeometry(576)
	if ok, reason := PayloadCompatibleForDevice("image", "", TransportFacts{Connection: "usb", Protocol: "escpos", SupportedProtocol: []string{"escpos", "image"}, Geometry: geometry}); !ok {
		t.Fatalf("declared USB ESC/POS raster cannot reach the renderer: %s", reason)
	}
	if got := (&USBPrinter{Protocol: "escpos", SupportsESCPOS: true, Geometry: geometry}).SupportsKind(KindImage); !got {
		t.Fatal("USB ESC/POS backend lacks its image renderer")
	}
	for _, protocol := range []string{"unknown", "raw", "zpl", "tspl"} {
		if ok, _ := PayloadCompatibleForDevice("image", "", TransportFacts{Connection: "usb", Protocol: protocol}); ok {
			t.Errorf("unverified image byte language %q was admitted", protocol)
		}
	}
}

func testRasterGeometry(width int) *Geometry {
	return &Geometry{Version: 1, Source: "validated_profile", Validation: "configured", ObservedAt: "2026-10-24T12:00:00Z", PrinterID: "receipt-printer", ConfigFingerprint: strings.Repeat("a", 64), GeometryProfile: config.GeometryProfile{PrintableWidthDots: width, RasterCommand: "gs_v_0"}}
}
