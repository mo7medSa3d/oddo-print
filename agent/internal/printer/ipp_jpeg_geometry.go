package printer

import (
	"fmt"
	"math"
)

// ippJPEGGeometry selects bounded pixels and their ACTUAL integer JFIF DPI.
// Scaling the pixel dimensions alone while still declaring 200 DPI shrinks
// oversized invoices on printers which honor JFIF physical dimensions.
func ippJPEGGeometry(widthPoints, heightPoints float64, maxPixels int64) (width, height, dpi int, err error) {
	if !(widthPoints > 0 && heightPoints > 0) || math.IsNaN(widthPoints) || math.IsNaN(heightPoints) || math.IsInf(widthPoints, 0) || math.IsInf(heightPoints, 0) || maxPixels <= 0 {
		return 0, 0, 0, fmt.Errorf("invalid PDF page dimensions or pixel budget")
	}
	// JFIF density is integral. Choose the highest whole DPI within both
	// bounds, then derive pixels from it rather than rounding an unrelated
	// scale factor. At most 200 iterations, no allocation or PDF rendering.
	for dpi = 200; dpi >= 1; dpi-- {
		w, h := widthPoints*float64(dpi)/72.0, heightPoints*float64(dpi)/72.0
		if w < 1 || h < 1 {
			break
		}
		if w > 32767 || h > 32767 {
			continue
		}
		width, height = int(math.Round(w)), int(math.Round(h))
		if int64(width)*int64(height) <= maxPixels {
			return width, height, dpi, nil
		}
	}
	return 0, 0, 0, fmt.Errorf("PDF dimensions cannot fit the IPP JPEG renderer's %d pixel budget", maxPixels)
}
