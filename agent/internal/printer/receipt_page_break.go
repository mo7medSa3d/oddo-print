package printer

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"math"

	"github.com/klippa-app/go-pdfium/requests"
)

type receiptRasterSegment struct{ Start, Rows int }

func receiptRowIsBlank(source image.Image, y int) bool {
	bounds := source.Bounds()
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		var luma uint8
		switch typed := source.(type) {
		case *image.Gray:
			luma = typed.GrayAt(x, y).Y
		case *image.YCbCr:
			luma = typed.YCbCrAt(x, y).Y
		default:
			luma = grayscale(source.At(x, y))
		}
		if luma < 245 {
			return false
		}
	}
	return true
}

// receiptRasterSegments selects a complete blank row run before each physical
// page boundary. Searching the entire preceding page lets a large QR block
// move intact to the next page. No rows are discarded or repeated. Continuous
// opaque images without a safe gap require an already-paginated document;
// blindly slicing them cannot promise readable codes or unbroken text.
func receiptRasterSegments(source image.Image, pageRows, dpiY int) ([]receiptRasterSegment, error) {
	height := source.Bounds().Dy()
	if pageRows < 1 || dpiY < 1 || height < 1 || height > MaxJPEGDimension || source.Bounds().Dx() < 1 || source.Bounds().Dx() > MaxJPEGDimension {
		return nil, fmt.Errorf("invalid receipt page segmentation bounds")
	}
	quietRows := max(2, int(math.Ceil(float64(dpiY)*0.25/25.4)))
	var segments []receiptRasterSegment
	for start := 0; start < height; {
		if len(segments) >= maxPDFPages {
			return nil, fmt.Errorf("receipt pagination exceeds the %d-page document budget", maxPDFPages)
		}
		end := min(height, start+pageRows)
		if end < height {
			blankRun, cut := 0, 0
			for y := end - 1; y > start; y-- {
				if receiptRowIsBlank(source, source.Bounds().Min.Y+y) {
					blankRun++
				} else {
					blankRun = 0
				}
				if blankRun >= quietRows {
					cut = y + quietRows/2
					break
				}
			}
			if cut <= start {
				return nil, CapabilityMismatchf("receipt has no safe blank page break within the measured printable height; render a paginated PDF or select larger compatible media")
			}
			end = cut
		}
		segments = append(segments, receiptRasterSegment{Start: start, Rows: end - start})
		start = end
	}
	return segments, nil
}

// paginateReceiptJPEG uses the same content-safe source-row selection as file
// output while keeping the Windows driver's measured form and bounded bitmap
// budget. The original single-image PDF remains unchanged.
func (p pdfPagePlan) paginateReceiptJPEG(data []byte, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int) ([]pdfPagePlan, error) {
	fixed, err := p.paginate(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY)
	if err != nil || len(fixed) <= 1 {
		return fixed, err
	}
	if p.crop == nil {
		return nil, fmt.Errorf("receipt image pagination requires a validated source crop")
	}
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	source, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode complete receipt JPEG before pagination: %w", err)
	}
	pointsPerRow := p.crop.Height / float64(cfg.Height)
	maxRows := int(math.Floor(fixed[0].crop.Height/pointsPerRow + 1e-6))
	rows, err := receiptRasterSegments(source, maxRows, dpiY)
	if err != nil {
		return nil, err
	}
	result := make([]pdfPagePlan, 0, len(rows))
	for _, segment := range rows {
		part := p
		part.crop = &requests.RenderPageCrop{X: p.crop.X, Y: p.crop.Y + float64(segment.Start)*pointsPerRow, Width: p.crop.Width, Height: float64(segment.Rows) * pointsPerRow}
		if segment.Start+segment.Rows == cfg.Height {
			part.crop.Height = p.crop.Height - float64(segment.Start)*pointsPerRow
		}
		if _, _, _, _, err := part.printableDestination(physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY); err != nil {
			return nil, err
		}
		result = append(result, part)
	}
	return result, nil
}
