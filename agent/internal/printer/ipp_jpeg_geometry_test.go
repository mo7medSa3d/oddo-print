package printer

import (
	"encoding/binary"
	"fmt"
	"math"
	"testing"
)

func TestIPPJPEGGeometryPreservesPhysicalSizeAtAdvertisedDensity(t *testing.T) {
	for _, dpi := range []int{203, 300, 600} {
		for _, points := range [][2]float64{{72, 144}, {226.77, 566.93}, {144, 720}} {
			w, h, actual, err := ippJPEGGeometry(points[0], points[1], 16_000_000, dpi)
			if err != nil {
				t.Fatal(err)
			}
			if actual != dpi || w > 32767 || h > 32767 || int64(w)*int64(h) > 16_000_000 {
				t.Fatalf("invalid geometry %dx%d at %d", w, h, actual)
			}
			if math.Abs(float64(w)/float64(actual)-points[0]/72) > 0.501/float64(actual) || math.Abs(float64(h)/float64(actual)-points[1]/72) > 0.501/float64(actual) {
				t.Fatalf("physical size changed at %d DPI", dpi)
			}
			jfif, err := wrapIPPPayloadAsJFIF([]byte{0xff, 0xd8, 0xff, 0xd9}, uint16(actual))
			if err != nil {
				t.Fatal(err)
			}
			if got := int(binary.BigEndian.Uint16(jfif[14:16])); got != actual {
				t.Fatalf("JFIF density %d differs from actual %d", got, actual)
			}
		}
	}
}

func TestIPPJPEGGeometryNeverLowersUnsupportedDensityToFit(t *testing.T) {
	w, h, dpi, err := ippJPEGGeometry(612, 792, 16_000_000, 300)
	if err != nil || w != 2550 || h != 3300 || dpi != 300 {
		t.Fatalf("invoice geometry: %dx%d @ %d: %v", w, h, dpi, err)
	}
	if _, _, _, err := ippJPEGGeometry(612, 792, 16_000_000, 600); err == nil {
		t.Fatal("oversized bitmap silently reduced its advertised 600 DPI")
	}
	if _, _, _, err := ippJPEGGeometry(144, 12000, 16_000_000, 203); err == nil {
		t.Fatal("overlong page silently reduced its density")
	}
}

func TestIPPJPEGGeometryRejectsInvalidAndUnrepresentablePages(t *testing.T) {
	for _, points := range [][2]float64{{0, 72}, {-1, 72}, {math.NaN(), 72}, {72, math.Inf(1)}, {1e308, 1e308}, {0.01, 72}} {
		if _, _, _, err := ippJPEGGeometry(points[0], points[1], 16_000_000, 203); err == nil {
			t.Fatalf("accepted invalid dimensions %v", points)
		}
	}
	for _, dpi := range []int{0, -1, 1201} {
		if _, _, _, err := ippJPEGGeometry(72, 72, 16_000_000, dpi); err == nil {
			t.Fatalf("accepted invalid DPI %d", dpi)
		}
	}
	if _, _, _, err := ippJPEGGeometry(72, 72, 0, 203); err == nil {
		t.Fatal("accepted empty pixel budget")
	}
}

func TestIPPJPEGRequiresAdvertisedResolution(t *testing.T) {
	if _, err := ippJPEGResolution(nil); err == nil {
		t.Fatal("invented missing DPI")
	}
	for _, dpi := range []int{203, 300, 600} {
		attrs := map[string]string{"printer-resolution-supported": fmt.Sprintf("%dx%ddpi", dpi, dpi)}
		if got, err := ippJPEGResolution(attrs); err != nil || got != dpi {
			t.Fatalf("selected %d: %v", got, err)
		}
	}
}
