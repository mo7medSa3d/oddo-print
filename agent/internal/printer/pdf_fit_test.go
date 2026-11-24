package printer

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

func TestPDFCurrentMediaPreservesFormPrivateBytesAndOrientation(t *testing.T) {
	buf := bytes.Repeat([]byte{0x4d}, 236)
	binary.LittleEndian.PutUint16(buf[68:70], 220)
	binary.LittleEndian.PutUint16(buf[70:72], 16)
	before := append([]byte(nil), buf...)
	if err := configurePDFCurrentMedia(buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf[:72], before[:72]) || !bytes.Equal(buf[76:84], before[76:84]) || !bytes.Equal(buf[88:], before[88:]) {
		t.Fatal("current-media normalization changed driver form, orientation or private fields")
	}
	if binary.LittleEndian.Uint16(buf[84:86]) != 100 || binary.LittleEndian.Uint16(buf[86:88]) != 1 {
		t.Fatal("current media retained driver scaling or duplicate copies")
	}
	if err := validatePDFDevModeResult(buf); err != nil {
		t.Fatal(err)
	}
	if err := configurePDFCurrentMedia(buf[:90]); err == nil {
		t.Fatal("truncated current media accepted")
	}
}

func TestPDFPaperModeFallbackIsBeforeSubmissionAndRetainsErrors(t *testing.T) {
	requestedErr, currentErr := errors.New("document form unsupported"), errors.New("driver unavailable")
	for _, tc := range []struct {
		name               string
		requested, current error
		wantFallback       bool
	}{
		{"document form", nil, nil, false}, {"current form", requestedErr, nil, true}, {"both fail", requestedErr, currentErr, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			mode, fallback, err := selectPDFPaperMode(func() ([]byte, error) { calls++; return []byte("requested"), tc.requested }, func() ([]byte, error) { calls++; return []byte("current"), tc.current })
			if fallback != tc.wantFallback {
				t.Fatalf("fallback=%v err=%v", fallback, err)
			}
			if tc.requested == nil && (calls != 1 || string(mode) != "requested" || err != nil) {
				t.Fatalf("supported form unnecessarily fell back: %d %q %v", calls, mode, err)
			}
			if tc.wantFallback && (calls != 2 || string(mode) != "current" || err != nil) {
				t.Fatalf("current driver media unavailable: %d %q %v", calls, mode, err)
			}
			if tc.current != nil && (!errors.Is(err, requestedErr) || !errors.Is(err, currentErr) || mode != nil) {
				t.Fatalf("driver failures were hidden: %v", err)
			}
		})
	}
}

func TestPDFFitKeepsWholePageProportionalInsidePrintableBounds(t *testing.T) {
	for _, tc := range []struct {
		name                                                                       string
		pointsW, pointsH                                                           float64
		physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int
		topAligned                                                                 bool
	}{
		{"Letter to POS80 driver72mm", 612, 792, 576, 800, 552, 776, 203, 203, 12, 12, false},
		{"80mm receipt on58mm driver", 80 * 72 / 25.4, 180 * 72 / 25.4, 464, 800, 440, 776, 203, 203, 12, 12, false},
		{"Letter to A4", 612, 792, 2480, 3508, 2330, 3328, 300, 300, 75, 90, false},
		{"landscape to portrait", 792, 612, 2550, 3300, 2400, 3120, 300, 300, 75, 90, false},
		{"unequal axis DPI", 612, 792, 5100, 3300, 4800, 3120, 600, 300, 150, 90, false},
		{"80mm roll70mm form", 80 * 72 / 25.4, 450 * 72 / 25.4, 560, 4000, 552, 3976, 203, 203, 4, 12, true},
		{"80mm roll70mm printable", 80 * 72 / 25.4, 450 * 72 / 25.4, 640, 4000, 560, 3976, 203, 203, 40, 12, true},
		{"custom narrow form300dpi", 75 * 72 / 25.4, 600 * 72 / 25.4, 886, 7500, 832, 7460, 300, 300, 27, 20, true},
		{"small page remains small", 144, 216, 2550, 3300, 2400, 3120, 300, 300, 75, 90, false},
		{"long page exceeds Windows form limit", 80 * 72 / 25.4, 4000 * 72 / 25.4, 640, 4000, 560, 3976, 203, 203, 40, 12, true},
		{"large page exceeds Windows form limit", 12000, 10000, 2550, 3300, 2400, 3120, 300, 300, 75, 90, false},
		{"page smaller than Windows form resolution", 0.01, 0.02, 2550, 3300, 2400, 3120, 300, 300, 75, 90, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			x, y, w, h, err := pdfPrintableDestination(tc.pointsW, tc.pointsH, tc.physicalW, tc.physicalH, tc.printableW, tc.printableH, tc.dpiX, tc.dpiY, tc.offsetX, tc.offsetY)
			if err != nil || x < 0 || y < 0 || w < 1 || h < 1 || x+w > tc.printableW || y+h > tc.printableH {
				t.Fatalf("content escaped printable paper: %d,%d %dx%d %v", x, y, w, h, err)
			}
			wantW, wantH := tc.pointsW*float64(tc.dpiX)/72, tc.pointsH*float64(tc.dpiY)/72
			if float64(w) > wantW+1 || float64(h) > wantH+1 {
				t.Fatal("small document enlarged")
			}
			scaleW, scaleH := float64(w)/wantW, float64(h)/wantH
			if math.Abs(scaleW-scaleH) > 1/wantW+1/wantH {
				t.Fatalf("physical aspect ratio changed: %g %g", scaleW, scaleH)
			}
			wantY := (tc.printableH - h) / 2
			if tc.topAligned {
				wantY = 0
			}
			if x != (tc.printableW-w)/2 || y != wantY {
				t.Fatalf("printable destination alignment changed: got (%d,%d) want Y=%d", x, y, wantY)
			}
			t.Logf("fixture source=%.4gx%.4gpt physical=%dx%d printable=%dx%d dpi=%dx%d offset=%d,%d destination=%d,%d %dx%d",
				tc.pointsW, tc.pointsH, tc.physicalW, tc.physicalH, tc.printableW, tc.printableH, tc.dpiX, tc.dpiY, tc.offsetX, tc.offsetY, x, y, w, h)
		})
	}
}

func TestPDFLongRollOrdinaryPageStartsAtFeedOrigin(t *testing.T) {
	// Captures the operator's actual POS80 geometry: the old generic PDF path
	// centered 640x828 at Y=12677 inside VERTRES=26183.
	x, y, w, h, err := pdfPrintableDestination(612, 792, 640, 26200, 640, 26183, 203, 203, 0, 12)
	if err != nil || x != 0 || y != 0 || w != 640 || h != 828 {
		t.Fatalf("POS80 long roll must start at feed origin: (%d,%d) %dx%d, err=%v", x, y, w, h, err)
	}
}

func TestPDFRollClassificationUsesPhysicalMillimetersAndAxisDPI(t *testing.T) {
	for _, tc := range []struct {
		name                             string
		physicalW, physicalH, dpiX, dpiY int
		want                             bool
	}{
		{"80mm long roll unequal DPI", 1889, 7100, 600, 300, true},
		{"160mm wide banner unequal DPI", 1889, 7100, 300, 300, false},
		{"A4 office paper", 2480, 3508, 300, 300, false},
		{"80mm short custom form", 640, 1200, 203, 203, false},
		{"40mm long roll", 400, 4000, 254, 254, true},
		{"negative native caps", -1, 4000, 203, 203, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isClearlyLongRollMedia(tc.physicalW, tc.physicalH, tc.dpiX, tc.dpiY); got != tc.want {
				t.Fatalf("roll classifier got %v want %v", got, tc.want)
			}
		})
	}
}

func TestPDFLongButWideBannerKeepsVerticalCenter(t *testing.T) {
	_, y, _, h, err := pdfPrintableDestination(612, 792, 5100, 40000, 4800, 39700, 600, 600, 150, 150)
	if err != nil || y != (39700-h)/2 {
		t.Fatalf("wide format media must keep sheet centering; got Y=%d height=%d, err=%v", y, h, err)
	}
}

func TestPDFFitBoundsExtremeFiniteSourceWithoutOverflow(t *testing.T) {
	for _, points := range [][2]float64{
		{math.MaxFloat64, math.MaxFloat64},
		{math.MaxFloat64, math.MaxFloat64 / 2},
		{math.SmallestNonzeroFloat64, math.SmallestNonzeroFloat64},
	} {
		x, y, w, h, err := pdfPrintableDestination(points[0], points[1], 2550, 3300, 2400, 3120, 300, 300, 75, 90)
		if err != nil || x < 0 || y < 0 || w < 1 || h < 1 || x+w > 2400 || y+h > 3120 {
			t.Fatalf("finite page not safely bounded: %g x %g -> %d,%d %dx%d %v", points[0], points[1], x, y, w, h, err)
		}
		if points[0] == math.MaxFloat64 && (w != 2400 || h != int(2400*(points[1]/points[0]))) {
			t.Fatalf("overflow changed source proportions: %dx%d", w, h)
		}
	}
}

func TestPDFFitStillRejectsInvalidPrinterAndDocumentGeometry(t *testing.T) {
	for _, tc := range []struct{ pw, ph, hw, hh, dx, dy, ox, oy int }{
		{0, 800, 552, 776, 203, 203, 0, 0}, {576, 800, 0, 776, 203, 203, 12, 12}, {576, 800, 552, 776, 0, 203, 12, 12},
		{576, 800, 575, 776, 203, 203, 12, 12}, {576, 800, 552, 799, 203, 203, 12, 12}, {576, 800, 552, 776, 203, 203, -1, 12},
	} {
		if _, _, _, _, err := pdfPrintableDestination(612, 792, tc.pw, tc.ph, tc.hw, tc.hh, tc.dx, tc.dy, tc.ox, tc.oy); err == nil {
			t.Fatalf("invalid native geometry admitted: %+v", tc)
		}
	}
	for _, value := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		for _, points := range [][2]float64{{value, 792}, {612, value}} {
			if _, _, _, _, err := pdfPrintableDestination(points[0], points[1], 576, 800, 552, 776, 203, 203, 12, 12); err == nil {
				t.Fatalf("malformed document dimensions accepted: %v", points)
			}
		}
	}
}
