package printer

import (
	"context"
)

// Printer is the execution backend for a single physical printer.
type Printer interface {
	Print(ctx context.Context, data []byte) error
	Test(ctx context.Context) error
	Status() string
}

// SpoolerJobIDReporter is an OPTIONAL interface for printers that receive
// a platform job identity for completed submissions (Windows spooler
// StartDocPrinterW return value). It is deliberately optional — not part
// of Printer — so network/USB/IPP backends (which have no such identity)
// do not change. Use SpoolerJobIDOf to read it without a type switch at
// every call site.
type SpoolerJobIDReporter interface {
	// LastSpoolerJobID returns the platform job ID of the most recent
	// successfully completed session on this printer, or "" when none
	// (never completed, or backend has no platform identity).
	LastSpoolerJobID() string
}

// SpoolerJobIDOf returns the printer's last platform job ID, or "" when
// the printer does not report one. Safe to call on any Printer.
func SpoolerJobIDOf(p Printer) string {
	if r, ok := p.(SpoolerJobIDReporter); ok {
		return r.LastSpoolerJobID()
	}
	return ""
}

// DeviceInfo is the discovery-time description of a physical printer.
// It is used for listing, manual registration, stable-ID persistence, and
// reporting to the Gateway via heartbeat.
type DeviceInfo struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	DisplayName    string                 `json:"displayName,omitempty"`
	PrinterType    string                 `json:"printerType,omitempty"` // thermal/laser/inkjet/other/unknown/virtual
	ConnectionType string                 `json:"connectionType"`        // tcp/usb/spooler/ipp/virtual
	Protocol       string                 `json:"protocol"`              // raw/escpos/ipp/spooler/windows_spooler
	Endpoint       string                 `json:"endpoint,omitempty"`    // ip:port or device path
	SpoolerName    string                 `json:"spoolerName,omitempty"` // Windows spooler name
	SpoolerServer  string                 `json:"spoolerServer,omitempty"`
	SpoolerPort    string                 `json:"spoolerPort,omitempty"`
	SpoolerDriver  string                 `json:"spoolerDriver,omitempty"`
	SpoolerShare   string                 `json:"spoolerShare,omitempty"`
	USBVID         string                 `json:"usbVid,omitempty"`
	USBPID         string                 `json:"usbPid,omitempty"`
	USBSerial      string                 `json:"usbSerial,omitempty"`
	NetworkAddress string                 `json:"networkAddress,omitempty"`
	Port           int                    `json:"port,omitempty"`
	Status         string                 `json:"status"` // online/offline/unknown/busy/error
	Enabled        bool                   `json:"enabled"`
	IsVirtual      bool                   `json:"isVirtual,omitempty"`
	Capabilities   map[string]interface{} `json:"capabilities,omitempty"`
	// Legacy aliases for backward compatibility with heartbeat
	Type string `json:"-"`
}

// Capability describes printable capabilities used for validation.
type Capability struct {
	MaxPaperWidth      *int     `json:"max_paper_width,omitempty"`
	SupportsColor      *bool    `json:"supports_color,omitempty"`
	SupportsDuplex     *bool    `json:"supports_duplex,omitempty"`
	SupportedProtocols []string `json:"supported_protocols,omitempty"`
}
