package printer

import (
	"bytes"
	"fmt"
	"image/color"
	"image/jpeg"
	"math"
)

// JPEGToPagedPDFGeometry places a production-rendered receipt at its declared
// physical density on explicit page media. Pages clip consecutive source rows;
// neither a long receipt nor a large printable area changes the text scale.
// The original JPEG is shared by every page and is never resampled/re-encoded.
func JPEGToPagedPDFGeometry(data []byte, geometry *Geometry) ([]byte, error) {
	if !geometry.PhysicalPageImageReady() {
		return nil, CapabilityMismatchf("PDF image output requires measured paper width/height, printable width/height, both DPI axes and both offsets")
	}
	if len(data) > maxPrintBytes {
		return nil, fmt.Errorf("JPEG input exceeds the bounded document size")
	}
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	decoded, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode complete receipt JPEG: %w", err)
	}
	dpiX, dpiY := float64(*geometry.DPIX), float64(*geometry.DPIY)
	pageW, pageH := *geometry.PaperWidthMM*72/25.4, *geometry.PaperHeightMM*72/25.4
	// Physical sizes can be rounded by one device pixel in a measured profile.
	// Keep every source pixel: use only complete rows inside the physical page,
	// and refuse an image too wide to fit without losing a source column.
	availableW := min(geometry.PrintableWidthDots, int(math.Floor(pageW*dpiX/72-float64(*geometry.OffsetXDots)+1e-8)))
	pageRows := min(*geometry.PrintableHeightDots, int(math.Floor(pageH*dpiY/72-float64(*geometry.OffsetYDots)+1e-8)))
	if cfg.Width > availableW || availableW < 1 || pageRows < 1 {
		return nil, CapabilityMismatchf("receipt raster does not fit the measured physical page; refresh the page geometry and render again")
	}
	segments, err := receiptRasterSegments(decoded, pageRows, *geometry.DPIY)
	if err != nil {
		return nil, err
	}
	count := len(segments)
	if count < 1 || count > maxPDFPages {
		return nil, fmt.Errorf("receipt pagination exceeds the %d-page document budget", maxPDFPages)
	}
	imageW, imageH := float64(cfg.Width)*72/dpiX, float64(cfg.Height)*72/dpiY
	imageX := (float64(*geometry.OffsetXDots) + float64(availableW-cfg.Width)/2) * 72 / dpiX
	top := pageH - float64(*geometry.OffsetYDots)*72/dpiY
	colorSpace, imageDecode := "/DeviceRGB", ""
	if cfg.ColorModel == color.GrayModel {
		colorSpace = "/DeviceGray"
	} else if cfg.ColorModel == color.CMYKModel {
		colorSpace, imageDecode = "/DeviceCMYK", " /Decode [1 0 1 0 1 0 1 0]"
	}

	var output bytes.Buffer
	output.Grow(len(data) + 1024 + count*512)
	output.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	offsets := make([]int, 4+2*count)
	object := func(index int, body []byte) {
		offsets[index] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n", index)
		output.Write(body)
		output.WriteString("\nendobj\n")
	}
	object(1, []byte("<< /Type /Catalog /Pages 2 0 R >>"))
	var kids bytes.Buffer
	kids.Grow(count * 8)
	for page := 0; page < count; page++ {
		fmt.Fprintf(&kids, "%d 0 R ", 4+2*page)
	}
	object(2, fmt.Appendf(nil, "<< /Type /Pages /Kids [%s] /Count %d >>", kids.String(), count))
	offsets[3] = output.Len()
	fmt.Fprintf(&output, "3 0 obj\n<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s%s /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n", cfg.Width, cfg.Height, colorSpace, imageDecode, len(data))
	output.Write(data)
	output.WriteString("\nendstream\nendobj\n")
	for page := 0; page < count; page++ {
		pageObject, contentObject := 4+2*page, 5+2*page
		object(pageObject, fmt.Appendf(nil, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.9f %.9f] /Resources << /XObject << /Im0 3 0 R >> >> /Contents %d 0 R >>", pageW, pageH, contentObject))
		start, rows := segments[page].Start, segments[page].Rows
		partH := float64(rows) * 72 / dpiY
		imageY := top - imageH + float64(start)*72/dpiY
		content := fmt.Sprintf("q\n%.9f %.9f %.9f %.9f re W n\n%.9f 0 0 %.9f %.9f %.9f cm\n/Im0 Do\nQ\n", imageX, top-partH, imageW, partH, imageW, imageH, imageX, imageY)
		object(contentObject, fmt.Appendf(nil, "<< /Length %d >>\nstream\n%sendstream", len(content), content))
	}
	xref := output.Len()
	fmt.Fprintf(&output, "xref\r\n0 %d\r\n0000000000 65535 f\r\n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&output, "%010d 00000 n\r\n", offset)
	}
	fmt.Fprintf(&output, "trailer\n<< /Root 1 0 R /Size %d >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	if output.Len() > MaxRenderedPDFBytes {
		return nil, fmt.Errorf("generated PDF exceeds the bounded output size")
	}
	return output.Bytes(), nil
}
