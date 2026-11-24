package printer

import (
	"context"
	"fmt"

	"github.com/yaseir-agent/agent/internal/config"
)

func (p *IPPPrinter) VerifyOperational(ctx context.Context, cfg config.PrinterConfig) (*OperationalVerification, error) {
	if !verificationEndpointMatches(cfg, p.PrinterURI, "") {
		return nil, fmt.Errorf("IPP backend and selected destination differ")
	}
	attrs, err := p.getPrinterAttributes(ctx)
	if err != nil {
		return nil, err
	}
	if !hasUsableIPPPrinterState(attrs) {
		return nil, fmt.Errorf("IPP response does not contain a usable printer service state")
	}
	status, _ := interpretIPPPrinterStatus(attrs)
	if status == "offline" || status == "error" || attrs["printer-is-accepting-jobs"] == "false" {
		return nil, fmt.Errorf("IPP printer service is not accepting work")
	}
	formats := parseIPPSupportedFormats(attrs)
	if !containsIPPFormat(formats, ippFormatPDF) && !containsIPPFormat(formats, "image/pwg-raster") && !containsIPPFormat(formats, ippFormatJPEG) {
		return nil, fmt.Errorf("IPP service advertises no supported document rendering path")
	}
	// getPrinterAttributes already validates/persists the service UUID where
	// supplied. A UUID is not silently relabeled as a physical chassis ID.
	return NewOperationalVerification(cfg, "ipp_attributes", "service", "", "physical")
}
