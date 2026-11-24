//go:build !windows

package printer

import (
	"context"
	"errors"
)

// ErrSpoolerNotifyUnsupported marks spooler change notifications on a
// non-Windows build: the caller logs the fallback once and keeps its
// periodic discovery/heartbeat polling.
var ErrSpoolerNotifyUnsupported = errors.New("spooler change notifications are only available on Windows")

// WatchSpoolerChanges is the non-Windows stub for the Windows
// FindFirstPrinterChangeNotification watch.
func WatchSpoolerChanges(ctx context.Context, onChange func()) error {
	return ErrSpoolerNotifyUnsupported
}
