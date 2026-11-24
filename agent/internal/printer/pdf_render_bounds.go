package printer

import (
	"fmt"
	"math"
)

// Bound one rendered page independently of backend, paper form and source size.
const maxPDFRenderPixels = 16_000_000 // <= 64 MiB of 32-bit pixel storage.

// PDFium preserves the PDF's square-pixel aspect ratio. Render at the denser
// driver axis before GDI maps it to independent device axes; a 600x300 driver
// otherwise loses half of its horizontal image detail.
func renderBoundsForDPI(width, height, dpiX, dpiY int) (int, int, error) {
	if width < 1 || height < 1 || dpiX < 1 || dpiY < 1 {
		return 0, 0, fmt.Errorf("invalid PDF render geometry or DPI")
	}
	density := float64(max(dpiX, dpiY))
	w, h := math.Ceil(float64(width)*density/float64(dpiX)), math.Ceil(float64(height)*density/float64(dpiY))
	if math.IsInf(w, 0) || math.IsInf(h, 0) || w > math.MaxInt32 || h > math.MaxInt32 {
		return 0, 0, fmt.Errorf("PDF render dimensions exceed software limits")
	}
	return renderBounds(int(w), int(h))
}

func renderBounds(printableWidth, printableHeight int) (int, int, error) {
	if printableWidth <= 0 || printableHeight <= 0 {
		return 0, 0, fmt.Errorf("printer reported invalid printable area %dx%d", printableWidth, printableHeight)
	}
	// Division avoids overflowing the input area for an extreme driver value.
	if printableWidth <= maxPDFRenderPixels/printableHeight {
		return printableWidth, printableHeight, nil
	}
	scale := math.Sqrt(float64(maxPDFRenderPixels) / float64(printableWidth) / float64(printableHeight))
	w := min(maxPDFRenderPixels, max(1, int(float64(printableWidth)*scale)))
	h := min(maxPDFRenderPixels, max(1, int(float64(printableHeight)*scale)))
	// Clamping a sub-pixel short side to one can break the area bound. Keep
	// both dimensions nonzero and shrink the long side to restore the budget.
	if w > maxPDFRenderPixels/h {
		if w >= h {
			w = maxPDFRenderPixels / h
		} else {
			h = maxPDFRenderPixels / w
		}
	}
	return w, h, nil
}
