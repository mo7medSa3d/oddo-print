package printer

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"regexp"
	"strconv"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func testReceiptJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{255, 255, 255, 255})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func pdfImageGeometry(t *testing.T, pdf []byte) (pageW, pageH, imgW, imgH, imgX, imgY float64) {
	t.Helper()
	pageRE := regexp.MustCompile(`/MediaBox \[0 0 ([0-9.]+) ([0-9.]+)\]`)
	matrixRE := regexp.MustCompile(`(?m)([0-9.]+) 0 0 ([0-9.]+) ([0-9.]+) ([0-9.]+) cm`)
	m := pageRE.FindSubmatch(pdf)
	x := matrixRE.FindSubmatch(pdf)
	if len(m) != 3 || len(x) != 5 {
		t.Fatalf("JPEG receipt PDF has no standard MediaBox/transform")
	}
	parse := func(raw []byte) float64 {
		v, err := strconv.ParseFloat(string(raw), 64)
		if err != nil { t.Fatal(err) }
		return v
	}
	return parse(m[1]), parse(m[2]), parse(x[1]), parse(x[2]), parse(x[3]), parse(x[4])
}

func TestThermalReceiptPDFUsesActualPhysicalPaper(t *testing.T) {
	jpegBytes := testReceiptJPEG(t, 512, 900)
	for _, tc := range []struct {
		name string
		mm, dots, dpi int
	}{
		{"58mm_203dpi", 58, 384, 203},
		{"58mm_180dpi", 58, 360, 180},
		{"80mm_203dpi", 80, 576, 203},
		{"80mm_180dpi", 80, 512, 180},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pdf, err := JPEGToPDFReceipt(jpegBytes, tc.mm, tc.dots, tc.dpi)
			if err != nil { t.Fatal(err) }
			if err := ValidatePDF(pdf); err != nil { t.Fatal(err) }
			pageW, pageH, imgW, imgH, imgX, imgY := pdfImageGeometry(t, pdf)
			wantPoints := float64(tc.mm) * 72 / 25.4
			if math.Abs(pageW-wantPoints) > 0.1 {
				t.Fatalf("paper width %.2f points, expected %.2f for %dmm", pageW, wantPoints, tc.mm)
			}
			if imgW+imgX > pageW+0.01 || imgX < 1 || imgY <= 0 {
				t.Fatalf("image outside printable page: media=%gx%g image=%gx%g offset=%g,%g", pageW, pageH, imgW, imgH, imgX, imgY)
			}
			if math.Abs(imgH/imgW - 900.0/512) > .01 {
				t.Fatalf("aspect ratio was stretched: %g", imgH/imgW)
			}
			if !(pageH > imgH+imgY) {
				t.Fatal("missing top feed margin")
			}
		})
	}
}

func TestThermalReceiptRejectsUnknownOrUnsafeProfile(t *testing.T) {
	pdf := testReceiptJPEG(t, 384, 512)
	for _, profile := range []struct{ paper, dots, dpi int }{
		{210, 576, 203}, {80, 90000, 203}, {58, 100, 203},
	} {
		if _, err := JPEGToPDFReceipt(pdf, profile.paper, profile.dots, profile.dpi); err == nil {
			t.Fatalf("invalid dimensions accepted: %+v", profile)
		}
	}
}

func TestSpoolerProfilePrefersExplicitDotsAndDPI(t *testing.T) {
	for _, tc := range []struct {
		caps map[string]interface{}
		mm, dots, dpi int
	}{
		{map[string]interface{}{"max_paper_width": 512, "print_dpi": 180}, 80, 512, 180},
		{map[string]interface{}{"max_paper_width": 576, "print_dpi": 203}, 80, 576, 203},
		{map[string]interface{}{"print_dpi": 203}, 58, 384, 203},
		{map[string]interface{}{"print_dpi": 180}, 58, 360, 180},
	} {
		pc := config.PrinterConfig{PaperWidthMM: tc.mm, Capabilities: tc.caps}
		mm, dots, dpi := receiptPaperProfile(pc)
		if mm != tc.mm || dots != tc.dots || dpi != tc.dpi {
			t.Errorf("profile=%+v -> %d/%d/%d, want %d/%d/%d", tc.caps, mm,dots,dpi,tc.mm,tc.dots,tc.dpi)
		}
	}
	// Never claim an A4 or unknown printer is an 80mm receipt printer.
	pc := config.PrinterConfig{PaperWidthMM: 210}
	if mm, dots, dpi := receiptPaperProfile(pc); mm != 0 || dots != 0 || dpi != 0 {
		t.Fatal(fmt.Sprintf("generic paper leaked into thermal override: %d %d %d", mm,dots,dpi))
	}
}
