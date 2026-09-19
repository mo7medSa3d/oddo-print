package printer

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/yasser-agent/agent/internal/config"
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

	t := cfg.NormalizedType()
	proto, protoErr := cfg.NormalizedProtocol()

	switch t {
	case "network":
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: network printer requires an endpoint (ip:port)", cfg.ID)
		}
		switch proto {
		case "raw", "escpos", "zpl", "tspl":
			return &NetworkPrinter{Address: cfg.Endpoint, Protocol: proto, RasterMaxWidth: RasterMaxWidthFromCapabilities(cfg.Capabilities)}, nil
		case "ipp", "ipps":
			// Network printer explicitly using IPP protocol -> treat as IPP
			return NewIPPPrinter(cfg.Endpoint, cfg.Name)
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
		return NewSpooler(spoolerName, cfg.Name), nil

	case "usb":
		if protoErr != nil {
			return nil, protoErr
		}
		// A USB entry that reached this branch is direct USB transport. Any
		// Windows spooler-backed USB printer is normalized to type=spooler by
		// PrinterConfig.NormalizedType when spooler_name is present.
		if !strings.HasPrefix(cfg.Endpoint, `\\?\`) && !strings.HasPrefix(cfg.Endpoint, `\\.\`) {
			return nil, fmt.Errorf("printer %s: direct USB transport requires a Windows device path (\\?\\... or \\.\\...); configure type=spooler with spooler_name for a Windows print queue", cfg.ID)
		}
		vid := parseHex16(cfg.USBVID)
		pid := parseHex16(cfg.USBPID)
		return &USBPrinter{
			ID:           cfg.ID,
			Name:         cfg.Name,
			VID:          vid,
			PID:          pid,
			SerialNumber: cfg.USBSerial,
			DevicePath:   cfg.Endpoint,
		}, nil

	case "ipp", "ipps":
		// IPP/IPPS transport - requires URL endpoint
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: IPP printer requires endpoint URL (ipp://host/ipp/print or http://host:631/ipp/print)", cfg.ID)
		}
		return NewIPPPrinter(cfg.Endpoint, cfg.Name)

	case "":
		return nil, fmt.Errorf("printer %s: missing printer type", cfg.ID)

	default:
		return nil, fmt.Errorf("printer %s: unknown printer type %q (expected network/usb/spooler/ipp)", cfg.ID, cfg.Type)
	}
}

func parseHex16(s string) uint16 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	v, err := strconv.ParseUint(s, 16, 16)
	if err != nil {
		return 0
	}
	return uint16(v)
}
