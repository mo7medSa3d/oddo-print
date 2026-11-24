package printer

import (
	"fmt"
	"math"
)

// ippJPEGGeometry derives pixels from an advertised density. A large page
// fails before submission instead of silently lowering an unsupported DPI.
func ippJPEGGeometry(widthPoints, heightPoints float64, maxPixels int64, resolution int) (width, height, dpi int, err error) {
	if !(widthPoints > 0 && heightPoints > 0) || math.IsNaN(widthPoints) || math.IsNaN(heightPoints) || math.IsInf(widthPoints, 0) || math.IsInf(heightPoints, 0) || maxPixels <= 0 || resolution < 1 || resolution > 1200 {
		return 0, 0, 0, fmt.Errorf("invalid PDF page dimensions or pixel budget")
	}
	dpi = resolution
	w, h := widthPoints*float64(dpi)/72, heightPoints*float64(dpi)/72
	if w < 1 || h < 1 || w > 32767 || h > 32767 {
		return 0, 0, 0, fmt.Errorf("PDF dimensions exceed IPP JPEG limits at advertised %d DPI", dpi)
	}
	width, height = int(math.Round(w)), int(math.Round(h))
	if int64(width)*int64(height) > maxPixels {
		return 0, 0, 0, fmt.Errorf("PDF at advertised %d DPI exceeds the IPP JPEG %d pixel budget; use the Windows driver", dpi, maxPixels)
	}
	return width, height, dpi, nil
}

func ippJPEGResolution(attrs map[string]string) (int, error) {
	best := 0
	for _, resolution := range ippResolutions(attrs["printer-resolution-supported"]) {
		x, y := resolution.dpi()
		if x != y || x > 1200 {
			continue
		}
		if best == 0 || (x <= 300 && (best > 300 || x > best)) || (best > 300 && x < best) {
			best = x
		}
	}
	if best == 0 {
		return 0, fmt.Errorf("IPP JPEG requires an advertised square printer-resolution-supported up to 1200 DPI; no density was assumed")
	}
	return best, nil
}
