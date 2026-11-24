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
	if cfg.GeometryProfile != nil {
		if err := ValidateGeometryProfile(*cfg.GeometryProfile); err != nil {
			return nil, fmt.Errorf("printer %s: %w", cfg.ID, err)
		}
	}
	geometry, _ := ConfiguredGeometry(cfg)
	t := cfg.NormalizedType()
	proto, protoErr := cfg.NormalizedProtocol()

	switch t {
	case "network":
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: network printer requires an endpoint (ip:port)", cfg.ID)
		}
		switch proto {
		case "raw", "escpos", "zpl", "tspl":
			width := 0
			if geometry != nil {
				width = geometry.PrintableWidthDots
			}
			return &NetworkPrinter{Address: cfg.Endpoint, Protocol: proto, RasterMaxWidth: width, Geometry: geometry}, nil
		case "ipp":
			// Network IPP may be configured explicitly, but an IPPS queue must
			// use the distinct ipps transport. Keep factory admission in sync
			// with config.ValidatePrinterConfig instead of silently changing
			// the declared transport at execution time.
			return newConfiguredIPPPrinter(cfg)
		case "ipps":
			return nil, fmt.Errorf("printer %s: IPPS requires type ipps", cfg.ID)
		case "unknown":
			return nil, fmt.Errorf("printer %s: protocol is not declared; the device is inventoried but NOT routable until an operator declares its protocol in agent.yaml", cfg.ID)
		default:
			if protoErr != nil {
				return nil, protoErr
			}
			return nil, fmt.Errorf("printer %s: unsupported protocol %q for network printer", cfg.ID, cfg.Protocol)
		}

	case "spooler":
		if protoErr != nil {
			return nil, protoErr
		}
		if proto != "spooler" {
			return nil, fmt.Errorf("printer %s: spooler transport requires spooler protocol", cfg.ID)
		}
		// Endpoint can be a discovery/display alias. Only an exact, verified
		// Windows queue name may be passed to winspool; never use endpoint
		// as a fallback after a saved binding loses spooler_name.
		spoolerName := cfg.SpoolerName
		if spoolerName == "" || spoolerName != strings.TrimSpace(spoolerName) {
			return nil, fmt.Errorf("printer %s: spooler printer requires an exact spooler_name", cfg.ID)
		}
		if isVirtualSpooler("", "", spoolerName) {
			return nil, fmt.Errorf("printer %s: software printer queue is not supported", cfg.ID)
		}
		if err := rejectVirtualWindowsSpooler(spoolerName); err != nil {
			return nil, fmt.Errorf("printer %s: %w", cfg.ID, err)
		}
		result := NewSpooler(spoolerName, cfg.Name)
		result.Config = cfg
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
			SupportsESCPOS: proto == "escpos",
			Geometry:       geometry,
		}, nil

	case "ipp", "ipps":
		// IPP/IPPS transport must agree with its declared protocol. Unknown
		// or mismatched declarations are inventory only, never executable.
		if protoErr != nil {
			return nil, protoErr
		}
		if proto != t {
			return nil, fmt.Errorf("printer %s: %s transport requires %s protocol", cfg.ID, t, t)
		}
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
	p.testPaperMM = cfg.PaperWidthMM // explicit diagnostic stock selection, never a dot-width inference
	p.geometryConfig = cfg
	return p, nil
}

// receiptPaperProfile retains explicit legacy measurements for compatibility.
// It never fills in missing dots, DPI or media from a nominal roll label.
func receiptPaperProfile(cfg config.PrinterConfig) (paperMM, dots, dpi int) {
	g, err := ConfiguredGeometry(cfg)
	if err != nil || g.PaperWidthMM == nil || g.DPIX == nil {
		return 0, 0, 0
	}
	return int(*g.PaperWidthMM), g.PrintableWidthDots, *g.DPIX
}
