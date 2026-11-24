package printer

import (
	"fmt"
	"math"

	pdfium "github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/enums"
	"github.com/klippa-app/go-pdfium/requests"
)

type pdfPagePlan struct {
	width, height float64
	crop          *requests.RenderPageCrop
	// A document may fit horizontally once before it is divided vertically.
	// Generated receipts keep their measured physical width (the zero value is 1).
	renderScale float64
}

func (p pdfPagePlan) printableDestination(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int) (x, y, w, h int, err error) {
	if err = p.rejectUnsafeNarrowConversion(physicalW, dpiX); err != nil {
		return
	}
	if p.crop == nil {
		if p.isNarrowReceipt(physicalW, dpiX) {
			scale := math.Min(1, float64(printableW)/(p.width*float64(dpiX)/72))
			if p.height*float64(dpiY)/72*scale > float64(printableH)+1e-7 {
				return 0, 0, 0, 0, fmt.Errorf("long receipt requires vertical pagination; refusing to shrink its width to fit page height")
			}
		}
		return pdfPrintableDestination(p.width, p.height, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY)
	}
	if _, _, _, _, err = pdfPrintableDestination(p.width, p.height, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY); err != nil {
		return
	}
	if err = p.validateCrop(); err != nil {
		return
	}
	scale := p.renderScale
	if scale == 0 {
		scale = 1
	}
	width := p.crop.Width * float64(dpiX) / 72 * scale
	height := p.crop.Height * float64(dpiY) / 72 * scale
	// Allow up to ~2mm driver-margin drift (e.g. 80mm vs 79mm thermal roll)
	// by gently fitting to printableW instead of failing cashier receipts.
	tolDots := math.Max(2.0, float64(dpiX)*2.0/25.4)
	if width > float64(printableW)+tolDots {
		return 0, 0, 0, 0, fmt.Errorf("receipt printable width changed; refresh the measured printer profile before submission")
	}
	if width > float64(printableW) {
		fit := float64(printableW) / width
		width = float64(printableW)
		height = height * fit
	}
	if height > float64(printableH)+0.49 {
		return 0, 0, 0, 0, fmt.Errorf("long receipt requires vertical pagination; refusing to shrink its width to fit page height")
	}
	w, h = max(1, int(math.Round(width))), max(1, int(math.Round(height)))
	return (printableW - w) / 2, 0, w, h, nil
}

func (p pdfPagePlan) validateCrop() error {
	if p.crop == nil {
		return nil
	}
	if err := validatePDFPageDimensions(p.crop.Width, p.crop.Height); err != nil {
		return err
	}
	if math.IsNaN(p.crop.X) || math.IsNaN(p.crop.Y) || math.IsInf(p.crop.X, 0) || math.IsInf(p.crop.Y, 0) ||
		p.crop.X < 0 || p.crop.Y < 0 || p.crop.X+p.crop.Width > p.width+1e-7 || p.crop.Y+p.crop.Height > p.height+1e-7 ||
		math.IsNaN(p.renderScale) || math.IsInf(p.renderScale, 0) || p.renderScale < 0 || p.renderScale > 1 {
		return fmt.Errorf("invalid receipt crop or physical scale")
	}
	return nil
}

func (p pdfPagePlan) isNarrowReceipt(physicalW, dpiX int) bool {
	if physicalW <= 0 || dpiX <= 0 {
		return false
	}
	pageMM, driverMM := p.width*25.4/72, float64(physicalW)*25.4/float64(dpiX)
	return pageMM >= 40 && pageMM <= 120 && driverMM >= 40 && driverMM <= 120 && p.height >= 4*p.width
}

func (p pdfPagePlan) rejectUnsafeNarrowConversion(physicalW, dpiX int) error {
	if p.crop == nil && physicalW > 0 && dpiX > 0 && float64(physicalW)*25.4/float64(dpiX) <= 120 && p.width*25.4/72 > 120 {
		return CapabilityMismatchf("office-width PDF cannot be fitted safely onto narrow media; choose compatible document paper or generate a dedicated reflowed receipt layout")
	}
	return nil
}

// paginate uses the selected driver's actual printable height and independent
// axis DPI. It runs before StartDocW; no page can be accepted while this plan
// is incomplete. Crop coordinates are PDFium's rendered-page points, measured
// downwards from the top, so adjacent regions cover the source exactly once.
func (p pdfPagePlan) paginate(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int) ([]pdfPagePlan, error) {
	if err := p.rejectUnsafeNarrowConversion(physicalW, dpiX); err != nil {
		return nil, err
	}
	if _, _, _, _, err := pdfPrintableDestination(p.width, p.height, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY); err != nil {
		return nil, err
	}
	if p.crop == nil {
		if !p.isNarrowReceipt(physicalW, dpiX) {
			return []pdfPagePlan{p}, nil
		}
		p.crop = &requests.RenderPageCrop{Width: p.width, Height: p.height}
		p.renderScale = math.Min(1, float64(printableW)/(p.width*float64(dpiX)/72))
	}
	if err := p.validateCrop(); err != nil {
		return nil, err
	}
	scale := p.renderScale
	if scale == 0 {
		scale = 1
	}
	tolDots := math.Max(2.0, float64(dpiX)*2.0/25.4)
	if p.crop.Width*float64(dpiX)/72*scale > float64(printableW)+tolDots {
		return nil, fmt.Errorf("receipt printable width changed; refresh the measured printer profile before submission")
	}
	maxPoints := float64(printableH) * 72 / float64(dpiY) / scale
	// Every generated receipt crop keeps its native width, including A4 at
	// 600 DPI. Restrict vertical segments before the shared render allocator
	// would otherwise lower both axes and then stretch the bitmap back out.
	density := float64(max(dpiX, dpiY))
	renderWidth := math.Ceil(p.crop.Width * density / 72 * scale)
	if renderWidth < 1 || renderWidth > maxPDFRenderPixels {
		return nil, fmt.Errorf("receipt width exceeds bounded renderer capacity")
	}
	renderRows := math.Floor(float64(maxPDFRenderPixels) / renderWidth)
	deviceRows := math.Floor(renderRows * float64(dpiY) / density)
	if deviceRows < 1 {
		return nil, fmt.Errorf("receipt row exceeds bounded renderer capacity")
	}
	maxPoints = math.Min(maxPoints, deviceRows*72/float64(dpiY)/scale)
	segments := math.Max(1, math.Ceil(p.crop.Height/maxPoints-1e-10))
	if segments < 1 || segments > 500 || math.IsNaN(segments) || math.IsInf(segments, 0) {
		return nil, fmt.Errorf("receipt pagination exceeds the 500-page document budget")
	}
	result := make([]pdfPagePlan, 0, int(segments))
	for index := 0; index < int(segments); index++ {
		start := float64(index) * maxPoints
		part := p
		part.crop = &requests.RenderPageCrop{X: p.crop.X, Y: p.crop.Y + start,
			Width: p.crop.Width, Height: math.Min(maxPoints, p.crop.Height-start)}
		if _, _, _, _, err := part.printableDestination(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY); err != nil {
			return nil, err
		}
		result = append(result, part)
	}
	return result, nil
}

// Only Agent-generated receipt PDFs reach this helper; remove blank side margins, never image pixels or feed margins.
func receiptPDFCrop(instance pdfium.Pdfium, page requests.Page, width, height float64) (*requests.RenderPageCrop, error) {
	if err := validatePDFPageDimensions(width, height); err != nil {
		return nil, err
	}
	count, err := instance.FPDFPage_CountObjects(&requests.FPDFPage_CountObjects{Page: page})
	if err != nil || count == nil || count.Count != 1 {
		return nil, fmt.Errorf("generated receipt PDF must contain exactly one image: %v", err)
	}
	object, err := instance.FPDFPage_GetObject(&requests.FPDFPage_GetObject{Page: page, Index: 0})
	if err != nil || object == nil {
		return nil, fmt.Errorf("read generated receipt image: %v", err)
	}
	kind, err := instance.FPDFPageObj_GetType(&requests.FPDFPageObj_GetType{PageObject: object.PageObject})
	if err != nil || kind == nil || kind.Type != enums.FPDF_PAGEOBJ_IMAGE {
		return nil, fmt.Errorf("generated receipt PDF object is not an image: %v", err)
	}
	bounds, err := instance.FPDFPageObj_GetBounds(&requests.FPDFPageObj_GetBounds{PageObject: object.PageObject})
	if err != nil || bounds == nil {
		return nil, fmt.Errorf("read generated receipt image bounds: %v", err)
	}
	left, bottom, right, top := float64(bounds.Left), float64(bounds.Bottom), float64(bounds.Right), float64(bounds.Top)
	for _, value := range []float64{left, bottom, right, top} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("generated receipt image has invalid bounds")
		}
	}
	// FPDFPageObj_GetBounds returns float32 values; tolerate sub-thousandth-point
	// float32 rounding at full-bleed native-width page edges while still rejecting
	// genuinely out-of-page objects.
	const boundsEps = 1e-3
	if left < -boundsEps || bottom < -boundsEps || right > width+boundsEps || top > height+boundsEps || right <= left || top <= bottom {
		return nil, fmt.Errorf("generated receipt image lies outside its page")
	}
	left = math.Max(0, left)
	right = math.Min(width, right)
	if right <= left {
		return nil, fmt.Errorf("generated receipt image lies outside its page")
	}
	return &requests.RenderPageCrop{X: left, Width: right - left, Height: height}, nil
}
