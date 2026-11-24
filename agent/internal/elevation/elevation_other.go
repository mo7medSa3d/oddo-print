//go:build !windows

package elevation

import "errors"

func processElevated() bool { return true }

// relaunchElevated is unreachable on non-Windows builds
// (processElevated always reports true); it exists so the shared gate
// compiles everywhere.
func relaunchElevated() error {
	return errors.New("elevated relaunch is only available on Windows")
}
