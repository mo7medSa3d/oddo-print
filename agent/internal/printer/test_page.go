package printer

import (
	"bytes"
	"context"
	"fmt"
	"math"
)

// Keep real test-page submission distinct from read-only backend probes.
func runLocalPrinterTest(ctx context.Context, p Printer) error {
	if physical, ok := p.(interface{ PrintTestPage(context.Context) error }); ok {
		return physical.PrintTestPage(ctx)
	}
	return p.Test(ctx)
}

func selectLocalTestTarget(registered, configured []DeviceInfo, requested string) (*DeviceInfo, error) {
	if requested == "" {
		return nil, fmt.Errorf("printer selection requires a stable ID or unique name")
	}
	// Stable IDs retain registry precedence. A friendly name must be unique
	// across both sources: the same name can describe different destinations.
	for _, records := range [][]DeviceInfo{registered, configured} {
		var selected *DeviceInfo
		for _, row := range records {
			if row.ID != requested {
				continue
			}
			if selected != nil {
				return nil, fmt.Errorf("printer selection %q is ambiguous; use a unique stable printer ID", requested)
			}
			copy := row
			selected = &copy
		}
		if selected != nil {
			return selected, nil
		}
	}
	var selected *DeviceInfo
	for _, records := range [][]DeviceInfo{registered, configured} {
		matchedInSource := false
		for _, row := range records {
			if row.SpoolerName != requested && row.Name != requested {
				continue
			}
			if matchedInSource || (selected != nil && (selected.ID == "" || selected.ID != row.ID)) {
				return nil, fmt.Errorf("printer selection %q is ambiguous; use a unique stable printer ID", requested)
			}
			matchedInSource = true
			if selected == nil {
				copy := row
				selected = &copy
			}
		}
	}
	return selected, nil
}

// boundedDiagnosticPaper selects a short diagnostic on a narrow, long roll.
// Do not interpret the Windows driver's entire 10-metre form as a document:
// DEVMODE cannot represent that source length, and the printer would waste
// media. The physical WIDTH remains the real driver selection; office sheets
// and short narrow forms keep their exact dimensions.
func boundedDiagnosticPaper(width, height float64) (float64, float64, error) {
	if err := validatePDFPageDimensions(width, height); err != nil {
		return 0, 0, err
	}
	widthMM, heightMM := width*25.4/72, height*25.4/72
	if widthMM >= 40 && widthMM <= 120 && heightMM >= 4*widthMM {
		height = 100 * 72 / 25.4
	}
	if _, err := pdfPaperForPoints(width, height); err != nil {
		return 0, 0, err
	}
	return width, height, nil
}

func diagnosticTestPDF(width, height float64) ([]byte, error) {
	if _, err := pdfPaperForPoints(width, height); err != nil {
		return nil, err
	}
	margin := math.Min(18, math.Min(width, height)/10)
	// Fixed ASCII lines need no metadata escaping; reserve one full em per
	// character plus padding so even narrow stock retains every glyph.
	font := math.Min(14, math.Min((width-2*margin)/19, (height-2*margin)/7))
	content := fmt.Sprintf("q 0.5 w %.2f %.2f %.2f %.2f re S Q\nBT /F1 %.2f Tf %.2f TL %.2f %.2f Td (YASEIR PRINT TEST) Tj T* (Printer diagnostic) Tj T* (Document pipeline) Tj T* (Check paper output) Tj ET\n",
		margin, margin, width-2*margin, height-2*margin, font, font*1.4, margin+font/2, height-margin-font*1.5)
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", width, height),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content), content),
	}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for i, object := range objects {
		offsets[i] = pdf.Len()
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&pdf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return pdf.Bytes(), nil
}

func localByteDiagnosticPayload(protocol string) ([]byte, error) {
	switch NormalizeKind(protocol) {
	case "raw":
		return []byte("YASEIR PRINT TEST\r\nCheck printer output.\r\n\r\n"), nil
	case "escpos":
		return localESCPOSDiagnosticPayload(), nil
	case "zpl":
		return []byte("^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n"), nil
	case "tspl":
		// TSC's native diagnostic uses current stock without guessed SIZE/GAP.
		return []byte("SELFTEST\r\n"), nil
	default:
		return nil, CapabilityMismatchf("local test needs a declared raw/escpos/zpl/tspl byte language (device protocol %q)", protocol)
	}
}
