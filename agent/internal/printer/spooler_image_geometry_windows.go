//go:build windows

package printer

import "math"

func checkImageDeviceGeometry(g *Geometry, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int) error {
	if !g.PhysicalImageReady() {
		return CapabilityMismatchf("measured physical image geometry is required")
	}
	actual, err := deviceGeometryProfile(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY)
	if err != nil {
		return err
	}
	// Allow up to ~2mm horizontal driver-margin drift (e.g. 80mm vs 79mm thermal roll),
	// matching pdf_receipt.go's printableDestination/paginate tolerance.
	tolDots := math.Max(2.0, float64(dpiX)*2.0/25.4)
	tolWidthMM := math.Max(2.0, 25.4/float64(dpiX)) + 1e-9
	if math.Abs(float64(g.PrintableWidthDots-actual.PrintableWidthDots)) > tolDots || *g.DPIX != dpiX || *g.DPIY != dpiY ||
		math.Abs(*g.PaperWidthMM-*actual.PaperWidthMM) > tolWidthMM ||
		(g.PrintableHeightDots != nil && *g.PrintableHeightDots != printableH) ||
		(g.PaperHeightMM != nil && math.Abs(*g.PaperHeightMM-*actual.PaperHeightMM) > 25.4/float64(dpiY)+1e-9) ||
		(g.OffsetXDots != nil && math.Abs(float64(*g.OffsetXDots-offsetX)) > tolDots) || (g.OffsetYDots != nil && *g.OffsetYDots != offsetY) {
		return CapabilityMismatchf("Windows driver geometry changed after image rendering; refresh measurements and render again")
	}
	return nil
}

// imageGeometryKey carries the exact profile checked before image conversion.
// The actual DC is checked again before StartDocW.
type imageGeometryKey struct{}

type generatedReceiptJPEGKey struct{}
