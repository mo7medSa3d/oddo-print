//go:build windows

package printer

import (
	"context"
	"fmt"
	"math"
	"unsafe"

	"golang.org/x/sys/windows"
)

// spoolerDetectedReceiptPaper reads the *driver's currently configured form*
// and its printable dot width, rather than guessing from a POS80/58 product
// name. Printers configured for A4/Letter remain ordinary Windows queues.
// CreateDCW and GetDeviceCaps are bounded by the shared preflight watchdog:
// a hung driver cannot indefinitely stall the print executor.
func spoolerDetectedReceiptPaper(ctx context.Context, queue string) (paperMM, dots, dpi int) {
	var widthMM, printableDots, horizontalDPI int
	err := runPreflightBounded(queue, preflightTimeout, ctx, func() error {
		driver, err := windows.UTF16PtrFromString("WINSPOOL")
		if err != nil {
			return err
		}
		device, err := windows.UTF16PtrFromString(queue)
		if err != nil {
			return err
		}
		hdc, _, callErr := procCreateDCW.Call(
			uintptr(unsafe.Pointer(driver)), uintptr(unsafe.Pointer(device)), 0, 0,
		)
		if hdc == 0 {
			return fmt.Errorf("CreateDCW default printer media failed: %w", callErr)
		}
		defer procDeleteDC.Call(hdc)
		physicalDots := deviceCaps(hdc, capPhysicalWidth)
		horizontalDPI = deviceCaps(hdc, capLogPixelsX)
		printableDots = deviceCaps(hdc, 8) // HORZRES: usable pixels, not full roll
		if physicalDots <= 0 || horizontalDPI <= 0 || printableDots <= 0 {
			return fmt.Errorf("driver provided no valid paper geometry")
		}
		mm := float64(physicalDots) * 25.4 / float64(horizontalDPI)
		switch {
		case math.Abs(mm-58) <= 2.0:
			widthMM = 58
		case math.Abs(mm-80) <= 2.0:
			widthMM = 80
		default:
			widthMM = 0
		}
		return nil
	})
	if err != nil || widthMM == 0 || printableDots < 288 || printableDots > 576 {
		return 0, 0, 0
	}
	if horizontalDPI != 180 && horizontalDPI != 203 {
		// Keep the detected paper, but use explicit, conservative DPI
		// fallback for unusual device resolutions. Never claim true DPI.
		return widthMM, printableDots, 0
	}
	return widthMM, printableDots, horizontalDPI
}
