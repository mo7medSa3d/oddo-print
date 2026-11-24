// Package elevation enforces the Agent's administrator-only startup
// rule: outside the Windows service host (which already runs as
// LocalSystem), an interactive launch without an elevated token hands
// off to an elevated copy of the application and exits — there is NO
// dialog and no in-app state to dismiss. The only prompt the user ever
// sees is the Windows UAC consent raised by the "runas" relaunch
// itself; declining it (or any relaunch failure) exits the process, so
// a non-elevated process NEVER continues past this gate. The check runs
// before any configuration, service, queue, or printer work; only flag
// parsing and the -version early exit (which touches no state and exits
// immediately) precede it in main().
package elevation

import "os"

// IsElevated reports whether the current process token is elevated
// (a full administrator token under UAC). On non-Windows platforms it
// always reports true: the gate exists for the Windows product only,
// and developer builds elsewhere must not be blocked by it.
func IsElevated() bool {
	return processElevated()
}

// RequireElevatedInteractive enforces the administrator-only rule for
// one interactive entry point. interactive=false means the process was
// started by the Windows Service Control Manager: that path already
// runs as LocalSystem and is never gated, so it returns immediately.
// Otherwise, when the token is not elevated, an elevated copy of the
// application is launched at once (UAC prompt) and this process EXITS
// — exit 0 only when the elevated replacement was successfully
// launched, exit 1 in every other case. relaunched marks a process
// that IS that elevated replacement (the relaunch passes
// -elevated-relaunch): if it is somehow still not elevated, it exits
// instead of relaunching again, so the UAC prompt can never loop.
// Nothing else in the process has started yet at the point main()
// calls this.
func RequireElevatedInteractive(interactive bool, relaunched bool) {
	if !interactive {
		return
	}
	if IsElevated() {
		return
	}
	if relaunched {
		os.Exit(1)
	}
	if err := relaunchElevated(); err == nil {
		os.Exit(0)
	}
	os.Exit(1)
}
