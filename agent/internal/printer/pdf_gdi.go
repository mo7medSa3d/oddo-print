package printer

import (
	"fmt"
	"syscall"
)

const (
	rcBitBlt      = 0x0001
	rcDIBitmap    = 0x0080
	rcDIBToDevice = 0x0200
	rcStretchBlt  = 0x0800
	rcStretchDIB  = 0x2000
)

func gdiBitmapCapabilities(caps int, resize bool) (compatible, dib bool) {
	compatible = caps&rcDIBitmap != 0 && (caps&rcStretchBlt != 0 || (!resize && caps&rcBitBlt != 0))
	dib = caps&rcStretchDIB != 0 || (!resize && caps&rcDIBToDevice != 0)
	return
}

// wrapGDIFallbackFailure preserves BOTH phases when device-compatible bitmap
// preparation failed and a supported DIB path later returned zero. Preparation
// alone is safe to retry (no printer drawing), but the DIB call happens after
// StartDocW and its outcome remains UNKNOWN. Never attempt another draw here.
func wrapGDIFallbackFailure(preparationErr, transferErr error) error {
	if transferErr == nil {
		return nil
	}
	if preparationErr == nil {
		return transferErr
	}
	return fmt.Errorf("compatible bitmap preparation failed before submission (%v); fallback DIB transfer failed: %w", preparationErr, transferErr)
}

// Each page uses one drawing API; a failed submission must never be replayed.
func transferGDIBitmap(resize, directSupported bool, direct, stretch func() (int32, error)) error {
	api, transfer := "SetDIBitsToDevice", direct
	useStretch := resize || !directSupported
	if useStretch {
		api, transfer = "StretchDIBits", stretch
	}
	scanlines, err := transfer()
	// LazyProc.Call returns Errno even on success; preparation errors are separate.
	nativeErr, native := err.(syscall.Errno)
	if err != nil && !native {
		return err
	}
	// StretchDIBits can return negative successful counts for mirrored content.
	if scanlines == 0 || scanlines == -1 || (!useStretch && scanlines < 0) {
		if native {
			return fmt.Errorf("%s returned %d; bitmap transfer is unconfirmed (win32_last_error=%d, diagnostic only)", api, scanlines, nativeErr)
		}
		return fmt.Errorf("%s returned %d; bitmap transfer is unconfirmed", api, scanlines)
	}
	return nil
}
