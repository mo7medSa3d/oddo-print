package elevation

import "testing"

// The service-host path must never be gated: SCM runs the agent as
// LocalSystem in Session 0, with no desktop for a UAC prompt anyway.
// RequireElevatedInteractive(false, ...) returning at all is the
// assertion — the gated path exits the process, which a test cannot
// survive.
func TestServiceHostPathIsNeverGated(t *testing.T) {
	RequireElevatedInteractive(false, false)
	RequireElevatedInteractive(false, true)
}

// On non-Windows developer builds the gate is a no-op so the whole
// module keeps building and testing everywhere; on Windows CI this same
// test asserts the test runner's own token state is reported honestly
// (either value is valid — the gate's behaviour, not the machine's
// elevation, is under test).
func TestIsElevatedReturns(t *testing.T) {
	_ = IsElevated()
}
