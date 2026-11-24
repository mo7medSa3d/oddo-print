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
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	return parse(m[1]), parse(m[2]), parse(x[1]), parse(x[2]), parse(x[3]), parse(x[4])
}

func TestThermalReceiptPDFUsesActualPhysicalPaper(t *testing.T) {
	jpegBytes := testReceiptJPEG(t, 512, 900)
	for _, tc := range []struct {
		name          string
		mm, dots, dpi int
	}{
		{"58mm_203dpi", 58, 384, 203},
		{"58mm_180dpi", 58, 360, 180},
		{"80mm_203dpi", 80, 576, 203},
		{"80mm_180dpi", 80, 512, 180},
		{"80mm_300dpi", 80, 850, 300},
		{"80mm_600dpi", 80, 1700, 600},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pdf, err := JPEGToPDFReceipt(jpegBytes, tc.mm, tc.dots, tc.dpi)
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidatePDF(pdf); err != nil {
				t.Fatal(err)
			}
			pageW, pageH, imgW, imgH, imgX, imgY := pdfImageGeometry(t, pdf)
			wantPoints := float64(tc.mm) * 72 / 25.4
			if math.Abs(pageW-wantPoints) > 0.1 {
				t.Fatalf("paper width %.2f points, expected %.2f for %dmm", pageW, wantPoints, tc.mm)
			}
			if imgW+imgX > pageW+0.01 || imgX < 1 || imgY <= 0 {
				t.Fatalf("image outside printable page: media=%gx%g image=%gx%g offset=%g,%g", pageW, pageH, imgW, imgH, imgX, imgY)
			}
			if math.Abs(imgH/imgW-900.0/512) > .01 {
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
		{0, 576, 203}, {80, 90000, 203}, {58, 1000, 203}, {80, 1700, 0},
	} {
		if _, err := JPEGToPDFReceipt(pdf, profile.paper, profile.dots, profile.dpi); err == nil {
			t.Fatalf("invalid dimensions accepted: %+v", profile)
		}
	}
}

func TestThermalReceiptPDFPreservesReportedDPI(t *testing.T) {
	data := testReceiptJPEG(t, 512, 900)
	for _, dpi := range []int{180, 200, 203, 204, 300} {
		t.Run(strconv.Itoa(dpi), func(t *testing.T) {
			pdf, err := JPEGToPDFReceipt(data, 80, 512, dpi)
			if err != nil {
				t.Fatal(err)
			}
			_, _, width, height, _, _ := pdfImageGeometry(t, pdf)
			want := math.Min(512*72/float64(dpi), 76*72/25.4)
			if math.Abs(width-want) > .01 || math.Abs(height/width-900.0/512) > .001 {
				t.Fatalf("reported %d DPI changed: image=%.2fx%.2fpt, want width=%.2fpt", dpi, width, height, want)
			}
		})
	}
}

func longReceiptJPEG(t *testing.T) []byte {
	t.Helper()
	const width, height, border = 288, 16384, 8
	img := image.NewGray(image.Rect(0, 0, width, height))
	row := bytes.Repeat([]byte{255}, width)
	clear(row[:border])
	clear(row[width-border:])
	for y := 0; y < height; y++ {
		copy(img.Pix[y*img.Stride:], row)
	}
	clear(img.Pix[:border*img.Stride])
	clear(img.Pix[(height-border)*img.Stride:])
	var source bytes.Buffer
	if err := jpeg.Encode(&source, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return source.Bytes()
}

func TestLongReceiptImageFitsCurrentMediaWithoutWindowsForm(t *testing.T) {
	const width, height = 288, 16384
	source := longReceiptJPEG(t)
	for _, tc := range []struct {
		name                         string
		paperMM                      float64
		dots, physicalWidth, offsetX int
		configured                   bool
	}{
		{"configured80mm", 80, 576, 640, 32, true},
		{"detected70mm", 560 * 25.4 / 203, 552, 560, 4, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var pdf []byte
			var err error
			if tc.configured {
				pdf, err = JPEGToPDFReceipt(source, int(tc.paperMM), tc.dots, 203)
			} else {
				pdf, err = jpegToPDFWithReceiptPaper(source, tc.paperMM, tc.dots, 203)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidatePDF(pdf); err != nil {
				t.Fatal(err)
			}
			if bytes.Count(pdf, source) != 1 {
				t.Fatal("long receipt JPEG was changed or truncated")
			}
			pageW, pageH, imgW, imgH, imgX, imgY := pdfImageGeometry(t, pdf)
			if math.Abs(pageW-tc.paperMM*72/25.4) > .01 || pageH*25.4/72 <= 3276.7 || pageH >= 14400 {
				t.Fatalf("unexpected long receipt page %.2fx%.2fpt", pageW, pageH)
			}
			if _, err := pdfPaperForPoints(pageW, pageH); err == nil {
				t.Fatal("fixture must need current media rather than a Windows custom form")
			}
			if math.Abs(imgH/imgW-float64(height)/width) > .01 || imgX < 0 || imgY < 0 || imgX+imgW > pageW+.01 || imgY+imgH > pageH+.01 {
				t.Fatal("long receipt image was distorted or extended beyond its PDF page")
			}
			x, y, w, h, err := pdfPrintableDestination(pageW, pageH, tc.physicalWidth, 4000, tc.dots, 3976, 203, 203, tc.offsetX, 12)
			if err != nil {
				t.Fatal(err)
			}
			if x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > tc.dots || y+h > 3976 {
				t.Fatalf("long receipt outside current printable bounds: %d,%d %dx%d", x, y, w, h)
			}
			wantW, wantH := pageW*203/72, pageH*203/72
			if math.Abs(float64(w)/wantW-float64(h)/wantH) > 1/wantW+1/wantH {
				t.Fatal("fitting long receipt changed its physical aspect ratio")
			}
		})
	}
}

func TestSpoolerProfilePrefersExplicitDotsAndDPI(t *testing.T) {
	for _, tc := range []struct {
		caps          map[string]interface{}
		mm, dots, dpi int
	}{
		{map[string]interface{}{"max_paper_width": 512, "print_dpi": 180}, 80, 512, 180},
		{map[string]interface{}{"max_paper_width": 576, "print_dpi": 203}, 80, 576, 203},
		{map[string]interface{}{"max_paper_width": 512, "print_dpi": 300}, 80, 512, 300},
		{map[string]interface{}{"max_paper_width": 512, "dpi": 200}, 80, 512, 200},
		{map[string]interface{}{"max_paper_width": 850, "print_dpi": 300}, 80, 850, 300},
		{map[string]interface{}{"max_paper_width": 1700, "print_dpi": 600}, 80, 1700, 600},
	} {
		pc := config.PrinterConfig{ID: "receipt", Type: "spooler", Protocol: "spooler", SpoolerName: "Receipt queue", PaperWidthMM: tc.mm, Capabilities: tc.caps, ExplicitLegacyGeometry: true}
		mm, dots, dpi := receiptPaperProfile(pc)
		if mm != tc.mm || dots != tc.dots || dpi != tc.dpi {
			t.Errorf("profile=%+v -> %d/%d/%d, want %d/%d/%d", tc.caps, mm, dots, dpi, tc.mm, tc.dots, tc.dpi)
		}
	}
	for _, dpi := range []int{180, 203, 300, 600} {
		pc := config.PrinterConfig{ID: "receipt", Type: "spooler", Protocol: "spooler", SpoolerName: "Receipt queue", PaperWidthMM: 58, Capabilities: map[string]interface{}{"print_dpi": dpi}, ExplicitLegacyGeometry: true}
		if mm, dots, dpi := receiptPaperProfile(pc); mm != 0 || dots != 0 || dpi != 0 {
			t.Fatal("DPI and nominal paper invented printable dots")
		}
	}
	// Never claim an A4 or unknown printer is an 80mm receipt printer.
	pc := config.PrinterConfig{PaperWidthMM: 210}
	if mm, dots, dpi := receiptPaperProfile(pc); mm != 0 || dots != 0 || dpi != 0 {
		t.Fatal(fmt.Sprintf("generic paper leaked into thermal override: %d %d %d", mm, dots, dpi))
	}
}
