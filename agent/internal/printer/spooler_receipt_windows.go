//go:build windows

package printer

import (
	"context"
	"crypto/sha256"
	"fmt"
	"runtime"

	"golang.org/x/sys/windows"
)

// PrinterGeometry observes the selected driver form. The shared bounded
// preflight watchdog contains a wedged native call without inventing geometry.
func (p *SpoolerPrinter) PrinterGeometry(ctx context.Context) (*Geometry, error) {
	var geometry *Geometry
	err := runPreflightBounded(p.SpoolerName, preflightTimeout, ctx, func() error {
		unlock := pinGDIPrintThread()
		defer unlock()
		mode, err := pdfPrinterCurrentDevMode(p.SpoolerName)
		if err != nil {
			return err
		}
		hdc, err := openPrinterDC(p.SpoolerName, mode)
		if err != nil {
			return err
		}
		defer procDeleteDC.Call(hdc)
		profile, err := deviceGeometryProfile(deviceCaps(hdc, capPhysicalWidth), deviceCaps(hdc, capPhysicalHeight),
			deviceCaps(hdc, capHorzRes), deviceCaps(hdc, capVertRes), deviceCaps(hdc, capLogPixelsX), deviceCaps(hdc, capLogPixelsY),
			deviceCaps(hdc, capPhysicalOffsetX), deviceCaps(hdc, capPhysicalOffsetY))
		if err != nil {
			return err
		}
		name, err := windows.UTF16PtrFromString(p.SpoolerName)
		if err != nil {
			return err
		}
		handle, err := currentOpenPrinterWPtr()(name)
		if err != nil {
			return err
		}
		defer procClosePrinter.Call(uintptr(handle))
		info, keep, err := currentGetPrinterInfo2()(handle)
		if err != nil || info == nil {
			return fmt.Errorf("read driver identity for geometry: %v", err)
		}
		defer runtime.KeepAlive(keep)
		driver, port := utf16PtrToString(info.pDriverName), utf16PtrToString(info.pPortName)
		if driver == "" || port == "" {
			return fmt.Errorf("driver identity or port is unknown")
		}
		modeHash := sha256.Sum256(mode)
		geometry, err = NewGeometry(p.Config, profile, "windows_driver", "observed", fmt.Sprintf("%s\x00%s\x00%x", driver, port, modeHash))
		return err
	})
	if err != nil {
		return nil, err
	}
	return geometry, nil
}
