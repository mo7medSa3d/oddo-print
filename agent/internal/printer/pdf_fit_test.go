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
	}{
		{"Letter to POS80 driver72mm", 612, 792, 576, 800, 552, 776, 203, 203, 12, 12},
		{"80mm receipt on58mm driver", 80 * 72 / 25.4, 180 * 72 / 25.4, 464, 800, 440, 776, 203, 203, 12, 12},
		{"Letter to A4", 612, 792, 2480, 3508, 2330, 3328, 300, 300, 75, 90},
		{"landscape to portrait", 792, 612, 2550, 3300, 2400, 3120, 300, 300, 75, 90},
		{"unequal axis DPI", 612, 792, 5100, 3300, 4800, 3120, 600, 300, 150, 90},
		{"small page remains small", 144, 216, 2550, 3300, 2400, 3120, 300, 300, 75, 90},
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
			if x != (tc.printableW-w)/2 || y != (tc.printableH-h)/2 {
				t.Fatal("remaining printable space not centered")
			}
		})
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
	if _, _, _, _, err := pdfPrintableDestination(math.NaN(), 792, 576, 800, 552, 776, 203, 203, 12, 12); err == nil {
		t.Fatal("malformed document dimensions accepted")
	}
}
