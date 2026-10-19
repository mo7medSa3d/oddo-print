package printer

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Windows DEVMODE paper dimensions are signed shorts in tenths of a mm.
// Keep geometry policy independent of Win32 so it can be tested without a printer.
type pdfPaper struct {
	Width, Length int16
	Orientation   int16
	ID            int16
}

func pdfPaperForPoints(width, height float64) (pdfPaper, error) {
	if math.IsNaN(width) || math.IsNaN(height) || math.IsInf(width, 0) || math.IsInf(height, 0) || width <= 0 || height <= 0 {
		return pdfPaper{}, fmt.Errorf("PDF page has invalid physical dimensions %gx%g points", width, height)
	}
	w, h := math.Round(width*254/72), math.Round(height*254/72)
	if w < 1 || h < 1 || w > math.MaxInt16 || h > math.MaxInt16 {
		return pdfPaper{}, fmt.Errorf("PDF page size exceeds Windows paper dimension limits")
	}
	p := pdfPaper{Width: int16(w), Length: int16(h), Orientation: 1}
	if w > h {
		p.Width, p.Length, p.Orientation = p.Length, p.Width, 2
	}
	// Standard paper IDs avoid drivers rejecting custom dimensions for an
	// ordinary sheet. One tenth-mm tolerance covers rounded PDF point sizes.
	for _, standard := range []pdfPaper{{2159, 2794, 1, 1}, {2159, 3556, 1, 5}, {2100, 2970, 1, 9}} {
		if math.Abs(float64(p.Width-standard.Width)) <= 1 && math.Abs(float64(p.Length-standard.Length)) <= 1 {
			p.ID = standard.ID
			break
		}
	}
	return p, nil
}

func validatePDFDevModeBuffer(buf []byte) error {
	const minPublicSize = 92
	if len(buf) < minPublicSize {
		return fmt.Errorf("printer returned a truncated DEVMODEW")
	}
	public := int(binary.LittleEndian.Uint16(buf[68:70]))
	extra := int(binary.LittleEndian.Uint16(buf[70:72]))
	if public < minPublicSize || public+extra > len(buf) {
		return fmt.Errorf("printer returned invalid DEVMODEW lengths")
	}
	return nil
}

func configurePDFDevMode(buf []byte, paper pdfPaper) error {
	// Offsets are from DEVMODEW, not its ANSI variant. Preserve every private
	// driver byte; DocumentProperties owns allocation and validation.
	if err := validatePDFDevModeBuffer(buf); err != nil {
		return err
	}
	fields := uint32(0x1 | 0x2 | 0x10 | 0x100) // orientation, paper ID, scale, copies
	if paper.ID == 0 {
		fields |= 0x4 | 0x8 // custom dimensions require dmPaperSize=0
	}
	const formName = 0x10000
	current := binary.LittleEndian.Uint32(buf[72:76])
	binary.LittleEndian.PutUint32(buf[72:76], (current&^(formName|0xe))|fields)
	for offset, value := range map[int]int16{76: paper.Orientation, 78: paper.ID, 80: paper.Length, 82: paper.Width, 84: 100, 86: 1} {
		binary.LittleEndian.PutUint16(buf[offset:offset+2], uint16(value))
	}
	return nil
}

func configurePDFCurrentMedia(buf []byte) error {
	if err := validatePDFDevModeBuffer(buf); err != nil {
		return err
	}
	// Keep the selected driver's form, orientation and private settings.
	fields := binary.LittleEndian.Uint32(buf[72:76])
	binary.LittleEndian.PutUint32(buf[72:76], fields|0x10|0x100)
	binary.LittleEndian.PutUint16(buf[84:86], 100)
	binary.LittleEndian.PutUint16(buf[86:88], 1)
	return nil
}

func selectPDFPaperMode(requested, current func() ([]byte, error)) ([]byte, bool, error) {
	mode, requestedErr := requested()
	if requestedErr == nil {
		return mode, false, nil
	}
	mode, currentErr := current()
	if currentErr != nil {
		return nil, false, fmt.Errorf("document media and current printer media are unavailable: %w", errors.Join(requestedErr, currentErr))
	}
	return mode, true, nil
}

func validatePDFDevModeResult(buf []byte) error {
	// DocumentProperties merges the requested settings with driver policy.
	// Check its output before passing the buffer to CreateDC: sheet geometry
	// alone cannot establish that the driver retained one unscaled copy.
	if err := validatePDFDevModeBuffer(buf); err != nil {
		return err
	}
	fields := binary.LittleEndian.Uint32(buf[72:76])
	if scale := int16(binary.LittleEndian.Uint16(buf[84:86])); fields&0x10 != 0 && scale != 100 {
		return fmt.Errorf("printer substituted PDF scale %d%%; configure 100%% printing", scale)
	}
	if copies := int16(binary.LittleEndian.Uint16(buf[86:88])); fields&0x100 != 0 && copies != 1 {
		return fmt.Errorf("printer substituted %d PDF copies; configure one copy per job", copies)
	}
	// A cleared dmFields bit marks a member as unused. Do not reject stale
	// bytes for settings the driver does not implement.
	return nil
}

// Report exact media matches for diagnostics. A mismatch now uses the separate
// proportional printable-area policy instead of refusing usable driver media.
func validatePDFSheet(widthPoints, heightPoints float64, pixelsW, pixelsH, dpiX, dpiY int) error {
	if _, err := pdfPaperForPoints(widthPoints, heightPoints); err != nil {
		return err
	}
	if pixelsW <= 0 || pixelsH <= 0 || dpiX <= 0 || dpiY <= 0 {
		return fmt.Errorf("printer returned invalid physical page or DPI")
	}
	actualW, actualH := float64(pixelsW)*25.4/float64(dpiX), float64(pixelsH)*25.4/float64(dpiY)
	wantW, wantH := widthPoints*25.4/72, heightPoints*25.4/72
	if math.Abs(actualW-wantW) > 1 || math.Abs(actualH-wantH) > 1 {
		return fmt.Errorf("printer physical media %.1fx%.1fmm differs from PDF %.1fx%.1fmm; proportional fitting is required", actualW, actualH, wantW, wantH)
	}
	return nil
}

func pdfSheetDiagnostic(cause error, page int, beforeStartDoc bool, widthPoints, heightPoints float64, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int) error {
	phase := "after StartDocW; earlier pages may have been submitted"
	if beforeStartDoc {
		phase = "before StartDocW; no document submitted"
	}
	mediaMM := func(width, height int) string {
		if width <= 0 || height <= 0 || dpiX <= 0 || dpiY <= 0 {
			return "unknown"
		}
		return fmt.Sprintf("%.1fx%.1fmm", float64(width)*25.4/float64(dpiX), float64(height)*25.4/float64(dpiY))
	}
	return fmt.Errorf("PDF page %d media rejection (%s): requested=%.1fx%.1fmm; driver physical=%s (%dx%dpx); printable=%s (%dx%dpx); DPI=%dx%d; offset=%d,%dpx: %w",
		page, phase, widthPoints*25.4/72, heightPoints*25.4/72,
		mediaMM(physicalW, physicalH), physicalW, physicalH, mediaMM(printableW, printableH), printableW, printableH,
		dpiX, dpiY, offsetX, offsetY, cause)
}

func pdfBitmapDestination(pageWidth, pageHeight, offsetX, offsetY int) (int, int, int, int, error) {
	if pageWidth <= 0 || pageHeight <= 0 || offsetX < 0 || offsetY < 0 || offsetX >= pageWidth || offsetY >= pageHeight {
		return 0, 0, 0, 0, fmt.Errorf("printer returned invalid physical page origin")
	}
	// GDI's origin is the printable rectangle. Negative hardware offsets put
	// the PDF's origin at the physical sheet edge, retaining its own margins.
	return -offsetX, -offsetY, pageWidth, pageHeight, nil
}

func pdfPrintableDestination(widthPoints, heightPoints float64, physicalW, physicalH, printableW, printableH, dpiX, dpiY, offsetX, offsetY int) (int, int, int, int, error) {
	if _, err := pdfPaperForPoints(widthPoints, heightPoints); err != nil {
		return 0, 0, 0, 0, err
	}
	if _, _, _, _, err := pdfBitmapDestination(physicalW, physicalH, offsetX, offsetY); err != nil {
		return 0, 0, 0, 0, err
	}
	if dpiX <= 0 || dpiY <= 0 || printableW <= 0 || printableH <= 0 || printableW > physicalW-offsetX || printableH > physicalH-offsetY {
		return 0, 0, 0, 0, fmt.Errorf("printer returned invalid printable page or DPI")
	}
	wantW, wantH := widthPoints*float64(dpiX)/72, heightPoints*float64(dpiY)/72
	scale := math.Min(1, math.Min(float64(printableW)/wantW, float64(printableH)/wantH))
	w := min(printableW, max(1, int(math.Floor(wantW*scale))))
	h := min(printableH, max(1, int(math.Floor(wantH*scale))))
	// GDI starts at the printable origin. One proportional, shrink-only fit
	// keeps all content inside hardware margins without changing physical aspect.
	return (printableW - w) / 2, (printableH - h) / 2, w, h, nil
}
