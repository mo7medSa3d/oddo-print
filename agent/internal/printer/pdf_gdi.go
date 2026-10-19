package printer

import "fmt"

// Each page uses one drawing API; a failed submission must never be replayed.
func transferGDIBitmap(resize, directSupported bool, direct, stretch func() (int32, error)) error {
	api, transfer := "SetDIBitsToDevice", direct
	useStretch := resize || !directSupported
	if useStretch {
		api, transfer = "StretchDIBits", stretch
	}
	scanlines, err := transfer()
	if err != nil {
		return err
	}
	// StretchDIBits can return negative successful counts for mirrored content.
	if scanlines == 0 || scanlines == -1 || (!useStretch && scanlines < 0) {
		return fmt.Errorf("%s returned %d; bitmap transfer is unconfirmed", api, scanlines)
	}
	return nil
}
