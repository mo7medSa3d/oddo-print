package printer

import (
	"context"
	"fmt"
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
// submitting one document, converting to advertised PWG Raster or single-page
// JPEG when needed. Unsupported formats never receive disguised PDF bytes.
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
		// A failed TCP dial proves no capability probe reached this printer.
		// A second dial carrying the entire PDF cannot fix an unreachable
		// endpoint: it only adds another network timeout on the critical path.
		// Preserve the safely pre-dispatch failure classification and give the
		// operator the actionable IPP/port diagnosis from the first failure.
		if preDispatchIRErr(probeErr) {
			return fmt.Errorf("IPP printer %s unreachable (request not sent): capability probe could not connect; verify the IPP address, TCP port and protocol from the Windows Agent: %w", p.URL, probeErr)
		}
		return fmt.Errorf("IPP printer %s could not verify document-format-supported before submission; verify the IPP address, authentication and Get-Printer-Attributes support, or configure the installed Windows spooler driver: %w", p.URL, probeErr)
	}
	if strings.EqualFold(attrs["printer-is-accepting-jobs"], "false") {
		return fmt.Errorf("IPP printer %s is rejecting new jobs; resume the printer before attempting submission", p.URL)
	}
	formats := parseIPPSupportedFormats(attrs)
	if strings.TrimSpace(attrs["document-format-supported"]) == "" {
		return fmt.Errorf("IPP printer %s did not advertise document-format-supported; no document was submitted. Verify the IPP endpoint and printer capabilities, or configure the installed Windows spooler driver", p.URL)
	}
	if containsIPPFormat(formats, ippFormatPDF) {
		return p.printDocument(ctx, data, ippFormatPDF)
	}
	if containsIPPFormat(formats, "image/pwg-raster") {
		// IPP Everywhere requires PWG Raster even where PDF is not
		// advertised. Assemble every page locally into one compliant
		// RaS2 stream before one Print-Job; do not send raw bitmap bytes.
		pwg, err := renderIPPPDFToPWG(ctx, data, attrs)
		if err != nil {
			return fmt.Errorf("IPP printer %s supports image/pwg-raster but conversion failed before submission: %w. Configure the installed Windows spooler driver if this device needs a format variant the Agent cannot encode", p.URL, err)
		}
		return p.printDocument(ctx, pwg, "image/pwg-raster")
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
