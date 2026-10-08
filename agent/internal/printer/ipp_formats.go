package printer

import (
	"context"
	"fmt"
	"log"
	"strings"
)

// IPP Everywhere devices are required to support PWG Raster but PDF remains
// optional (PWG 5100.14). The document-format-supported IPP attribute is
// authoritative: do not claim a PDF blob is another MIME type.
const ippFormatJPEG = "image/jpeg"

func parseIPPSupportedFormats(attrs map[string]string) []string {
	if attrs == nil {
		return nil
	}
	seen := make(map[string]bool)
	var out []string
	for _, token := range strings.Split(attrs["document-format-supported"], ",") {
		format := strings.ToLower(strings.TrimSpace(token))
		switch format {
		case ippFormatPDF, ippFormatJPEG, "image/pwg-raster", "image/urf",
			"application/pclm", "application/postscript", "application/vnd.hp-pcl":
			if !seen[format] {
				seen[format] = true
				out = append(out, format)
			}
		}
	}
	return out
}

func containsIPPFormat(formats []string, target string) bool {
	for _, format := range formats {
		if format == target {
			return true
		}
	}
	return false
}

// printPDFWithFormatNegotiation probes the specific IPP destination before
// submitting a single document. A PDF-rejecting but JPEG-capable printer can
// print a ONE-page PDF by rendering to JPEG locally; unsupported PWG/URF
// raster devices require a dedicated raster encoder or installed Windows
// driver and must never receive unconverted bytes under a false MIME type.
func (p *IPPPrinter) printPDFWithFormatNegotiation(ctx context.Context, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Honour the Agent's last-moment disable/retirement fence even for
	// the read-only IPP capability probe. The existing printDocument
	// executes the fence again just before sending document bytes.
	if err := runDispatchAdmission(ctx); err != nil {
		return fmt.Errorf("IPP format probe admission refused: %w", err)
	}
	attrs, probeErr := p.getPrinterAttributes(ctx)
	if err := ctx.Err(); err != nil {
		return err
	}
	if probeErr != nil {
		// Legacy IPP servers can implement Print-Job but reject the probe.
		// An unknown capability list is not proof that PDF is unsupported.
		// Attempt native PDF, report any explicit 0x040A rejection clearly.
		log.Printf("IPP document-format probe unavailable for %s: %v; trying native PDF", p.URL, probeErr)
		return p.printDocument(ctx, data, ippFormatPDF)
	}
	if strings.EqualFold(attrs["printer-is-accepting-jobs"], "false") {
		return fmt.Errorf("IPP printer %s is rejecting new jobs; resume the printer before attempting submission", p.URL)
	}
	formats := parseIPPSupportedFormats(attrs)
	if len(formats) == 0 || containsIPPFormat(formats, ippFormatPDF) {
		return p.printDocument(ctx, data, ippFormatPDF)
	}
	if containsIPPFormat(formats, ippFormatJPEG) {
		// Rendering before print submission preserves deterministic
		// failure semantics: no uncertain partial job after a render error.
		jpegData, err := renderIPPPDFToJPEG(ctx, data)
		if err != nil {
			return fmt.Errorf("IPP printer %s rejects application/pdf (supported: %s); cannot convert document to JPEG: %w. For multi-page/raster-only printers select a Windows spooler queue with an installed print driver", p.URL, strings.Join(formats, ", "), err)
		}
		return p.printDocument(ctx, jpegData, ippFormatJPEG)
	}
	return fmt.Errorf("IPP printer %s rejects application/pdf (document-format-supported: %s). Configure the printer's installed Windows queue with the spooler transport for document conversion; no unsupported data was submitted", p.URL, strings.Join(formats, ", "))
}
