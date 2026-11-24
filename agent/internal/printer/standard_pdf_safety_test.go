package printer

import (
	"math"
	"testing"

	"github.com/klippa-app/go-pdfium/requests"
)

func TestDenseOfficePDFIsRejectedBeforeShrinkingOntoNarrowMedia(t *testing.T) {
	for _, mm := range [][2]float64{{210, 297}, {148, 210}, {215.9, 279.4}, {215.9, 355.6}, {297, 210}} {
		plan := pdfPagePlan{width: mm[0] * 72 / 25.4, height: mm[1] * 72 / 25.4}
		parts, err := plan.paginate(464, 4000, 384, 3976, 203, 203, 40, 12)
		if err == nil {
			_, _, width, height, fitErr := plan.printableDestination(464, 4000, 384, 3976, 203, 203, 40, 12)
			t.Errorf("office page %.1fx%.1fmm silently fits to %dx%d dots on58mm media (parts%d fitError%v); require dedicated receipt reflow", mm[0], mm[1], width, height, len(parts), fitErr)
		}
	}
}

func TestStandardPDFPagePlansRetainCompatibleSizesAndOrientation(t *testing.T) {
	for _, mm := range [][2]float64{{210, 297}, {148, 210}, {215.9, 279.4}, {215.9, 355.6}, {297, 210}, {279.4, 215.9}} {
		plan := pdfPagePlan{width: mm[0] * 72 / 25.4, height: mm[1] * 72 / 25.4}
		physicalW, physicalH := int(mm[0]*300/25.4+0.5), int(mm[1]*300/25.4+0.5)
		parts, err := plan.paginate(physicalW, physicalH, physicalW-120, physicalH-120, 300, 300, 60, 60)
		if err != nil || len(parts) != 1 || parts[0].width != plan.width || parts[0].height != plan.height {
			t.Fatalf("compatible standard page changed: %v %+v", err, parts)
		}
	}
}

func TestStandardReceiptCropBudgetPreservesNativeAxisResolution(t *testing.T) {
	for _, axes := range [][2]int{{203, 203}, {300, 300}, {600, 600}, {203, 300}, {600, 300}, {600, 203}} {
		dpiX, dpiY := axes[0], axes[1]
		physicalW, physicalH := int(math.Round(210*float64(dpiX)/25.4)), int(math.Round(297*float64(dpiY)/25.4))
		printableW, printableH := int(math.Floor(200*float64(dpiX)/25.4)), int(math.Floor(287*float64(dpiY)/25.4))
		offsetX, offsetY := int(math.Round(5*float64(dpiX)/25.4)), int(math.Round(5*float64(dpiY)/25.4))
		width, height := float64(printableW)*72/float64(dpiX), 8000*72.0/float64(dpiY)
		plan := pdfPagePlan{width: 210 * 72.0 / 25.4, height: height, crop: &requests.RenderPageCrop{Width: width, Height: height}}
		parts, err := plan.paginate(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY)
		if err != nil {
			t.Fatal(err)
		}
		for index, part := range parts {
			_, _, w, h, err := part.printableDestination(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY)
			if err != nil {
				t.Fatal(err)
			}
			renderW, renderH, err := renderBoundsForDPI(w, h, dpiX, dpiY)
			if err != nil {
				t.Fatal(err)
			}
			wantW := int(math.Ceil(float64(w) * float64(max(dpiX, dpiY)) / float64(dpiX)))
			if w != printableW || renderW != wantW || renderW > maxPDFRenderPixels/renderH {
				t.Errorf("A4 receipt %dx%d DPI segment%d was downsampled: device %dx%d bitmap %dx%d wanted width%d", dpiX, dpiY, index, w, h, renderW, renderH, wantW)
			}
		}
	}
}
