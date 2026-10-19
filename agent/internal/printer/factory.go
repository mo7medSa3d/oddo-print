package printer

import (
	"fmt"
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
)

// New builds the concrete Printer backend for a configured printer.
//
// Supported:
//   - type "network"/"tcp" with protocol "raw" or "escpos": RAW TCP (9100)
//   - type "spooler": Windows Print Spooler via winspool.drv (or stub on non-Windows)
//   - type "usb": direct USB transport requires a Windows device interface path;
//     Windows spooler queues are represented by type "spooler" with spooler_name;
//     an arbitrary USB endpoint is never treated as a spooler queue.
//   - type "ipp"/"ipps" and network:ipp protocol: real IPP client (IPPPrinter).
func New(cfg config.PrinterConfig) (Printer, error) {
	if cfg.ID == "" {
		return nil, fmt.Errorf("printer config is missing an id")
	}

	if strings.EqualFold(cfg.PrinterType, "virtual") || strings.EqualFold(cfg.PrinterType, "redirected") ||
		cfg.Capabilities["virtual_test_sink"] == true || cfg.Capabilities["virtual_spooler_test"] == true {
		return nil, fmt.Errorf("printer %s: virtual and redirected printers are not supported", cfg.ID)
	}
	// Recheck here as well as at discovery/manual admission. Persisted rows
	// from an older Agent and direct registration paths must not construct a
	// backend capable of probing or printing to an out-of-policy address.
	if err := config.ValidatePrinterEndpoint(cfg); err != nil {
		return nil, err
	}
	t := cfg.NormalizedType()
	proto, protoErr := cfg.NormalizedProtocol()

	switch t {
	case "network":
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: network printer requires an endpoint (ip:port)", cfg.ID)
		}
		switch proto {
		case "raw", "escpos", "zpl", "tspl":
			rasterWidth := RasterMaxWidthFromCapabilities(cfg.Capabilities)
			if cfg.PaperWidthMM > 0 {
				// The paper roll alone cannot justify 576 dots on an 80mm
				// 180dpi printer. Keep the operator's exact dot width/DPI.
				rasterWidth = RasterMaxWidthForConfiguredPaper(cfg.PaperWidthMM, cfg.Capabilities)
			}
			return &NetworkPrinter{Address: cfg.Endpoint, Protocol: proto, RasterMaxWidth: rasterWidth}, nil
		case "ipp", "ipps":
			// Network printer explicitly using IPP protocol -> treat as IPP
			return newConfiguredIPPPrinter(cfg)
		case "unknown":
			return nil, fmt.Errorf("printer %s: protocol is not declared; the device is inventoried but NOT routable until an operator declares its protocol in agent.yaml", cfg.ID)
		default:
			if protoErr != nil {
				return nil, protoErr
			}
			return nil, fmt.Errorf("printer %s: unsupported protocol %q for network printer", cfg.ID, cfg.Protocol)
		}

	case "spooler":
		spoolerName := cfg.SpoolerName
		if spoolerName == "" {
			spoolerName = cfg.Endpoint
		}
		if spoolerName == "" {
			return nil, fmt.Errorf("printer %s: spooler printer requires spooler_name or endpoint", cfg.ID)
		}
		if isVirtualSpooler("", "", spoolerName) {
			return nil, fmt.Errorf("printer %s: software printer queue is not supported", cfg.ID)
		}
		if err := rejectVirtualWindowsSpooler(spoolerName); err != nil {
			return nil, fmt.Errorf("printer %s: %w", cfg.ID, err)
		}
		result := NewSpooler(spoolerName, cfg.Name)
		result.ReceiptPaperMM, result.ReceiptRasterDots, result.ReceiptDPI = receiptPaperProfile(cfg)
		return result, nil

	case "usb":
		if protoErr != nil {
			return nil, protoErr
		}
		// A USB entry that reached this branch is direct USB transport. Any
		// Windows spooler-backed USB printer is normalized to type=spooler by
		// PrinterConfig.NormalizedType when spooler_name is present.
		endpoint := strings.TrimSpace(cfg.Endpoint)
		if !strings.HasPrefix(endpoint, `\\?\`) && !strings.HasPrefix(endpoint, `\\.\`) {
			return nil, fmt.Errorf("printer %s: direct USB transport requires a Windows device path (\\?\\... or \\.\\...); configure type=spooler with spooler_name for a Windows print queue", cfg.ID)
		}
		if proto != "raw" && proto != "escpos" && proto != "zpl" && proto != "tspl" {
			return nil, fmt.Errorf("printer %s: direct USB transport requires an explicit raw, escpos, zpl, or tspl protocol; refusing to infer a byte language", cfg.ID)
		}
		vid, err := config.ParseUSBID(cfg.USBVID)
		if err != nil {
			return nil, fmt.Errorf("printer %s: invalid usb_vid: %w", cfg.ID, err)
		}
		pid, err := config.ParseUSBID(cfg.USBPID)
		if err != nil {
			return nil, fmt.Errorf("printer %s: invalid usb_pid: %w", cfg.ID, err)
		}
		return &USBPrinter{
			ID:             cfg.ID,
			Name:           cfg.Name,
			VID:            vid,
			PID:            pid,
			SerialNumber:   cfg.USBSerial,
			DevicePath:     endpoint,
			Protocol:       proto,
			SupportsESCPOS: proto == "escpos" || capabilityProtocolListed(cfg.Capabilities, "escpos"),
		}, nil

	case "ipp", "ipps":
		// IPP/IPPS transport - requires URL endpoint
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: IPP printer requires endpoint URL (ipp://host/ipp/print or http://host:631/ipp/print)", cfg.ID)
		}
		return newConfiguredIPPPrinter(cfg)

	case "":
		return nil, fmt.Errorf("printer %s: missing printer type", cfg.ID)

	default:
		return nil, fmt.Errorf("printer %s: unknown printer type %q (expected network/usb/spooler/ipp)", cfg.ID, cfg.Type)
	}
}

func newConfiguredIPPPrinter(cfg config.PrinterConfig) (*IPPPrinter, error) {
	p, err := NewIPPPrinter(cfg.Endpoint, cfg.Name)
	if err != nil {
		return nil, err
	}
	p.testPaperMM, _, _ = receiptPaperProfile(cfg)
	return p, nil
}

// receiptPaperProfile returns a verified operator-defined 58/80mm roll.
// Unconfigured Windows queues are inspected from the driver's default form
// immediately before a receipt image is dispatched.
func receiptPaperProfile(cfg config.PrinterConfig) (paperMM, dots, dpi int) {
	paperMM = cfg.PaperWidthMM
	if paperMM == 0 {
		if v, ok := capabilityInt(cfg.Capabilities["paper_width_mm"]); ok {
			paperMM = v
		}
	}
	if paperMM != 58 && paperMM != 80 {
		return 0, 0, 0
	}
	if v, ok := capabilityInt(cfg.Capabilities["print_dpi"]); ok && (v == 180 || v == 203) {
		dpi = v
	} else if v, ok := capabilityInt(cfg.Capabilities["dpi"]); ok && (v == 180 || v == 203) {
		dpi = v
	}
	if v, ok := capabilityInt(cfg.Capabilities["max_paper_width"]); ok && v >= 288 && v <= 576 {
		dots = v
	} else if paperMM == 58 {
		if dpi == 180 {
			dots = 360
		} else {
			dots = 384
		}
	} else if dpi == 203 {
		dots = 576
	} else {
		dots = 512
	}
	return paperMM, dots, dpi
}

func capabilityProtocolListed(capabilities map[string]interface{}, protocol string) bool {
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	if protocol == "" || capabilities == nil {
		return false
	}
	value, ok := capabilities["supported_protocols"]
	if !ok {
		return false
	}
	switch list := value.(type) {
	case []string:
		for _, item := range list {
			if strings.EqualFold(strings.TrimSpace(item), protocol) {
				return true
			}
		}
	case []interface{}:
		for _, item := range list {
			if text, ok := item.(string); ok && strings.EqualFold(strings.TrimSpace(text), protocol) {
				return true
			}
		}
	}
	return false
}
