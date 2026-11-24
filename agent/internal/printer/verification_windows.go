//go:build windows

package printer

import (
	"context"
	"fmt"
	"strings"
	"syscall"

	"github.com/yaseir-agent/agent/internal/config"
	"golang.org/x/sys/windows"
)

func (p *SpoolerPrinter) VerifyOperational(ctx context.Context, cfg config.PrinterConfig) (*OperationalVerification, error) {
	if !verificationEndpointMatches(cfg, p.SpoolerName, p.SpoolerName) {
		return nil, fmt.Errorf("Windows backend and selected queue differ")
	}
	if err := p.boundedPreflight(ctx, preflightTimeout, func() error {
		return dispatchPreFlightSpoolerCheck(p.SpoolerName)
	}); err != nil {
		return nil, err
	}
	detail, err := queueDetailContext(ctx, p.SpoolerName)
	if err != nil || strings.TrimSpace(detail.driverName) == "" || strings.TrimSpace(detail.portName) == "" {
		return nil, fmt.Errorf("Windows queue has no currently accessible driver and port: %v", err)
	}
	if isVirtualSpooler(detail.portName, detail.driverName, p.SpoolerName) {
		return nil, fmt.Errorf("Windows software-output queue cannot represent physical printing")
	}
	// This calls DocumentProperties, CreateDC/GetDeviceCaps and GetPrinter
	// using the uncached remote-handle policy. A declared profile cannot stand
	// in for the actual installed driver, port and usable device context.
	geometry, err := p.PrinterGeometry(ctx)
	if err != nil || geometry == nil || geometry.Source != "windows_driver" {
		return nil, fmt.Errorf("Windows queue driver/port measurement unavailable: %v", err)
	}
	return NewOperationalVerification(cfg, "windows_queue", "queue", "", "physical")
}

func (p *USBPrinter) VerifyOperational(ctx context.Context, cfg config.PrinterConfig) (*OperationalVerification, error) {
	if !verificationEndpointMatches(cfg, p.DevicePath, "") || cfg.NormalizedProtocolOrUnknown() != strings.ToLower(strings.TrimSpace(p.Protocol)) {
		return nil, fmt.Errorf("USB backend and selected interface/protocol differ")
	}
	if err := p.validateNativeBinding(ctx); err != nil {
		return nil, err
	}
	path, err := syscall.UTF16PtrFromString(p.DevicePath)
	if err != nil {
		return nil, err
	}
	// GENERIC_WRITE tests the same access required for dispatch. No bytes are
	// written and no USB reset/status/test-print command is submitted.
	handle, err := p.openDeviceBounded(ctx, path, windows.GENERIC_WRITE)
	if err != nil {
		return nil, fmt.Errorf("USB printer interface is not accessible for output: %v", err)
	}
	if err := windows.CloseHandle(handle); err != nil {
		return nil, err
	}
	physical := ""
	if usableIdentityValue(p.SerialNumber) {
		physical = operationalIdentityDigest(fmt.Sprintf("usb:%04x:%04x:%s", p.VID, p.PID, normalizeIdentityValue(p.SerialNumber)))
	}
	return NewOperationalVerification(cfg, "usb_interface", "device", physical, "physical")
}
