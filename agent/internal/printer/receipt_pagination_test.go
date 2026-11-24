package printer

import (
	"math"
	"testing"

	"github.com/klippa-app/go-pdfium/requests"
)

func TestReceiptPaginationPreservesMeasuredWidthAndEveryVerticalRegion(t *testing.T) {
	for _, geometry := range []struct{ physicalW, physicalH, width, height, dpiX, dpiY, offsetX, offsetY int }{
		{640, 4000, 576, 3976, 203, 203, 32, 12},
		{945, 3508, 850, 3470, 300, 300, 48, 18},
		{1890, 7016, 1700, 6940, 600, 600, 96, 36},
		{1890, 3508, 1700, 3470, 600, 300, 96, 18},
	} {
		widthPoints := float64(geometry.width) * 72 / float64(geometry.dpiX)
		p := pdfPagePlan{width: float64(geometry.physicalW) * 72 / float64(geometry.dpiX), height: 4000 * 72 / 25.4,
			crop: &requests.RenderPageCrop{X: 1, Width: widthPoints, Height: 4000 * 72 / 25.4}}
		parts, err := p.paginate(geometry.physicalW, geometry.physicalH, geometry.width, geometry.height, geometry.dpiX, geometry.dpiY, geometry.offsetX, geometry.offsetY)
		if err != nil || len(parts) < 2 {
			t.Fatalf("long receipt did not paginate: parts=%d error=%v", len(parts), err)
		}
		nextY := 0.0
		for index, part := range parts {
			if part.crop == nil || math.Abs(part.crop.Y-nextY) > 1e-7 || part.crop.X != 1 || part.crop.Width != widthPoints {
				t.Fatalf("page%d left a gap, duplicated rows or changed width: %+v", index, part.crop)
			}
			nextY = part.crop.Y + part.crop.Height
			_, y, w, h, err := part.printableDestination(geometry.physicalW, geometry.physicalH, geometry.width, geometry.height, geometry.dpiX, geometry.dpiY, geometry.offsetX, geometry.offsetY)
			if err != nil || w != geometry.width || y != 0 || h < 1 || h > geometry.height {
				t.Fatalf("page%d changed measured width or escaped the form: %d,%d %dx%d %v", index, 0, y, w, h, err)
			}
		}
		if math.Abs(nextY-p.height) > 1e-7 {
			t.Fatalf("last source rows were lost: covered%g want%g", nextY, p.height)
		}
		t.Logf("measured profile DPI=%dx%d printable=%dx%d; 4000mm receipt ->%d pages, each width=%d dots", geometry.dpiX, geometry.dpiY, geometry.width, geometry.height, len(parts), geometry.width)
	}
}

func TestReceiptPaginationRejectsChangedWidthAndExcessiveLengthBeforeSubmission(t *testing.T) {
	p := pdfPagePlan{width: 80 * 72 / 25.4, height: 4000 * 72 / 25.4,
		crop: &requests.RenderPageCrop{Width: 576 * 72.0 / 203, Height: 4000 * 72 / 25.4}}
	if _, err := p.paginate(640, 4000, 552, 3976, 203, 203, 32, 12); err == nil {
		t.Fatal("a changed narrow form silently reduced the validated receipt width")
	}
	p.height, p.crop.Height = 1e10, 1e10
	if _, err := p.paginate(640, 4000, 576, 3976, 203, 203, 32, 12); err == nil {
		t.Fatal("unbounded pagination was admitted")
	}
}

func TestReceiptPaginationUsesMeasuredFormWithoutReclassifyingOfficeDocuments(t *testing.T) {
	for _, points := range [][2]float64{{595.28, 841.89}, {419.53, 595.28}} {
		p := pdfPagePlan{width: points[0], height: points[1]}
		parts, err := p.paginate(2480, 3508, 2330, 3328, 300, 300, 75, 90)
		if err != nil || len(parts) != 1 || parts[0].crop != nil {
			t.Fatalf("ordinary A4/A5 document was changed into a receipt: %+v %v", parts, err)
		}
	}
	p := pdfPagePlan{width: 80 * 72 / 25.4, height: 4000 * 72 / 25.4}
	parts, err := p.paginate(640, 4000, 576, 3976, 203, 203, 32, 12)
	if err != nil || len(parts) < 2 {
		t.Fatalf("ordinary long thermal PDF still height-fits: %d %v", len(parts), err)
	}
	for _, part := range parts {
		_, y, w, _, err := part.printableDestination(640, 4000, 576, 3976, 203, 203, 32, 12)
		if err != nil || y != 0 || w != 576 {
			t.Fatalf("ordinary receipt segment lost the horizontal fit: %d,%d %v", y, w, err)
		}
	}
}
