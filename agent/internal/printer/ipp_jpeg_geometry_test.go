package printer

import (
	"encoding/binary"
	"math"
	"testing"
)

func TestIPPJPEGGeometryPreservesPhysicalSizeWhenBounded(t *testing.T) {
	for _, points := range [][2]float64{{595.28, 841.89}, {2160, 2160}, {144, 12000}, {5000, 3000}} {
		w, h, dpi, err := ippJPEGGeometry(points[0], points[1], 16_000_000)
		if err != nil {
			t.Fatal(err)
		}
		if w > 32767 || h > 32767 || int64(w)*int64(h) > 16_000_000 || dpi < 1 || dpi > 200 {
			t.Fatalf("invalid bounded geometry %dx%d @ %d dpi", w, h, dpi)
		}
		// At most half a rendered pixel of rounding error per dimension.
		if math.Abs(float64(w)/float64(dpi)-points[0]/72) > 0.501/float64(dpi) || math.Abs(float64(h)/float64(dpi)-points[1]/72) > 0.501/float64(dpi) {
			t.Fatalf("physical size changed: %v points -> %dx%d @ %d", points, w, h, dpi)
		}
		jfif, err := wrapIPPPayloadAsJFIF([]byte{0xff, 0xd8, 0xff, 0xd9}, uint16(dpi))
		if err != nil {
			t.Fatal(err)
		}
		if got := int(binary.BigEndian.Uint16(jfif[14:16])); got != dpi {
			t.Fatalf("JFIF advertises %d dpi instead of actual %d", got, dpi)
		}
	}
}

func TestIPPJPEGGeometryOrdinaryInvoiceKeeps200DPI(t *testing.T) {
	w, h, dpi, err := ippJPEGGeometry(612, 792, 16_000_000)
	if err != nil || w != 1700 || h != 2200 || dpi != 200 {
		t.Fatalf("ordinary invoice changed: %dx%d @ %d: %v", w, h, dpi, err)
	}
	_, _, boundedDPI, err := ippJPEGGeometry(2160, 2160, 16_000_000)
	if err != nil || boundedDPI >= 200 {
		t.Fatalf("oversized PDF needs honest reduced density: %d, %v", boundedDPI, err)
	}
}

func TestIPPJPEGGeometryRejectsInvalidAndUnrepresentablePages(t *testing.T) {
	for _, points := range [][2]float64{{0, 72}, {-1, 72}, {math.NaN(), 72}, {72, math.Inf(1)}, {1e308, 1e308}, {0.01, 72}} {
		if _, _, _, err := ippJPEGGeometry(points[0], points[1], 16_000_000); err == nil {
			t.Fatalf("accepted invalid dimensions %v", points)
		}
	}
	if _, _, _, err := ippJPEGGeometry(72, 72, 0); err == nil {
		t.Fatal("accepted empty pixel budget")
	}
}
