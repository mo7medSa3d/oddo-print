package printer

import (
	"bytes"
	"crypto/sha256"
	"math"
	"os"
	"testing"
)

func TestReceiptPaperPreservesDriverGeometry(t *testing.T) {
	source, err := os.ReadFile("testdata/receipt-geometry.jpg")
	if err != nil {
		t.Fatal(err)
	}
	image, err := decodeJPEGConfig(source)
	if err != nil || image.Width != 512 || image.Height != 2852 {
		t.Fatalf("invalid synthetic receipt fixture: %+v %v", image, err)
	}
	t.Logf("source=%dx%dpx sha256=%x", image.Width, image.Height, sha256.Sum256(source))
	for _, tc := range []struct {
		name                             string
		physical, printable, dpi, offset int
	}{
		{"58mm180", 411, 360, 180, 20},
		{"58mm203", 464, 384, 203, 40},
		{"80mm180", 567, 512, 180, 20},
		{"80mm203_72mmPrintable", 640, 576, 203, 32},
		{"70mmForm", 560, 552, 203, 4},
		{"80mm_70mmPrintable", 640, 560, 203, 40},
		{"unusualFormAndDPI", 598, 560, 200, 12},
		{"80mm300", 945, 850, 300, 40},
		{"80mm600", 1890, 1700, 600, 80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mm, dots, dpi := receiptPaperFromDeviceCaps(tc.physical, tc.printable, tc.dpi, tc.offset)
			wantMM := float64(tc.physical) * 25.4 / float64(tc.dpi)
			if math.Abs(mm-wantMM) > 1e-9 || dots != tc.printable || dpi != tc.dpi {
				t.Fatalf("driver %d/%d/%d offset=%d became %.5fmm/%d/%d; want %.5fmm/%d/%d", tc.physical, tc.printable, tc.dpi, tc.offset, mm, dots, dpi, wantMM, tc.printable, tc.dpi)
			}
			pdf, err := jpegToPDFWithReceiptPaper(source, mm, dots, dpi)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(pdf, source) {
				t.Fatal("source JPEG was cropped or re-encoded")
			}
			pw, ph, iw, ih, ix, iy := pdfImageGeometry(t, pdf)
			if math.Abs(pw-mm*72/25.4) > .01 || math.Abs(iw-float64(dots)*72/float64(dpi)) > .01 ||
				math.Abs(ih/iw-float64(image.Height)/float64(image.Width)) > .001 || ix < 0 || iy < 0 || ix+iw > pw+.01 || iy+ih > ph+.01 {
				t.Fatal("receipt geometry lost the source aspect ratio or escaped the PDF page")
			}
			physicalH := int(math.Ceil(ph * float64(dpi) / 72))
			x, y, w, h, err := pdfPrintableDestination(pw, ph, tc.physical, physicalH, dots, physicalH-24, dpi, dpi, tc.offset, 12)
			if err != nil || x < 0 || y < 0 || x+w > dots || y+h > physicalH-24 {
				t.Fatalf("receipt escaped final driver bounds: %d,%d %dx%d %v", x, y, w, h, err)
			}
			t.Logf("form=%.5fmm printable=%ddots dpi=%d offset=%d,12px PDF=%.2fx%.2fpt image=%.2fx%.2fpt destination=%d,%d %dx%dpx sha256=%x", mm, dots, dpi, tc.offset, pw, ph, iw, ih, x, y, w, h, sha256.Sum256(pdf))
		})
	}
}

func TestReceiptPaperRejectsInvalidOrOfficeGeometry(t *testing.T) {
	for _, tc := range []struct{ physical, printable, dpi, offset int }{
		{640, 576, 0, 32}, {640, 576, -203, 32}, {0, 576, 203, 32},
		{640, 0, 203, 32}, {640, 650, 203, 0}, {640, 620, 203, 32},
		{640, 576, 203, -1}, {640, 576, 203, 640},
		{2480, 2330, 300, 75}, {2550, 2400, 300, 75},
	} {
		if mm, dots, dpi := receiptPaperFromDeviceCaps(tc.physical, tc.printable, tc.dpi, tc.offset); mm != 0 || dots != 0 || dpi != 0 {
			t.Fatalf("invalid/non-receipt geometry %+v accepted as %g/%d/%d", tc, mm, dots, dpi)
		}
	}
}
