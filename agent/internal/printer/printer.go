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

// SpoolerJobIDReporter exposes legacy backend-wide diagnostic history. The
// value can belong to an earlier or still-running session when a new call is
// rejected. Never use it to identify a Gateway dispatch; attach fresh
// WithSpoolerJobEvidence and let that invocation's worker publish its allocation.
type SpoolerJobIDReporter interface {
	LastSpoolerJobID() string
}

// LiveSessionReporter is implemented by backends whose transport session
// can outlive the caller's return. A wedged Win32 worker keeps its session
// after the caller reports UNKNOWN; an abandoned USB kernel write can still
// complete after Print gives up. Backend replacement must defer while a
// prior session may still own the physical queue/device: the replacement
// carries a fresh mutex/latch, so swapping eagerly would permit overlapping
// submissions to the same hardware.
type LiveSessionReporter interface {
	// SessionMayBeLive reports whether a prior print session may still own
	// the transport. It is advisory and fail-safe: true defers replacement,
	// false permits it.
	SessionMayBeLive() bool
}

// SpoolerJobIDOf returns the printer's last platform job ID, or "" when
// the printer does not report one. This does not identify a particular call.
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
