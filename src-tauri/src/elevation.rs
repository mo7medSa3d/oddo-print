//! Administrator elevation helper.
//!
//! When the Windows desktop Manager is launched without an elevated
//! Administrator token, the app opens ONLY to a locked Administrator-required
//! screen and blocks all privileged backend commands until the operator
//! relaunches elevated via `relaunch_as_admin` (Windows UAC "runas") or
//! closes the app and reopens it as Administrator.

pub fn is_elevated() -> bool {
    crate::commands::is_running_as_admin()
}
