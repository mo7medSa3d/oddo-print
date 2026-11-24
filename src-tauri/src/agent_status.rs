/// Project the locally observed service/process evidence into the public IPC
/// note vocabulary. A failed ownership check is not evidence of a stopped
/// service; the independently verified background-process flag stays separate.
pub(crate) fn note_code(running: bool, service_running: bool, note: &str) -> &'static str {
    if note.starts_with("service state unavailable:") {
        "service_status_unavailable"
    } else if note.starts_with("service registration is not owned by this Yaseir installation:") {
        "service_ownership_unverified"
    } else if service_running {
        "service_running"
    } else if note.contains("service not detected") && running {
        "background_running_service_missing"
    } else if note.contains("service not detected") {
        "service_missing"
    } else if note.contains("owned but stopped/transitioning") && running {
        "background_running_service_stopped"
    } else if note.contains("owned but not running") {
        "service_stopped"
    } else if running {
        "background_running"
    } else {
        "not_running"
    }
}

#[cfg(test)]
mod tests {
    use super::note_code;

    #[test]
    fn unverified_service_ownership_is_not_reported_as_stopped() {
        let note =
            "service registration is not owned by this Yaseir installation: binary path mismatch";
        assert_eq!(
            note_code(false, false, note),
            "service_ownership_unverified"
        );
        // A verified fallback may be running while service ownership is
        // unavailable. Preserve the diagnostic without overriding that flag.
        assert_eq!(note_code(true, false, note), "service_ownership_unverified");
    }

    #[test]
    fn existing_service_and_background_evidence_keeps_its_meaning() {
        assert_eq!(
            note_code(false, false, "service state unavailable: access denied"),
            "service_status_unavailable"
        );
        assert_eq!(
            note_code(true, false, "service state unavailable: access denied"),
            "service_status_unavailable"
        );
        assert_eq!(
            note_code(true, true, "Windows service YaseirAgent is running"),
            "service_running"
        );
        assert_eq!(
            note_code(
                true,
                false,
                "background process is running (service not detected)"
            ),
            "background_running_service_missing"
        );
        assert_eq!(
            note_code(
                false,
                false,
                "agent is not running; service/process not detected"
            ),
            "not_running"
        );
        assert_eq!(
            note_code(
                false,
                false,
                "Windows service YaseirAgent is owned but not running"
            ),
            "service_stopped"
        );
        assert_eq!(
            note_code(
                true,
                false,
                "Windows service is owned but stopped/transitioning; owned background Agent is running"
            ),
            "background_running_service_stopped"
        );
    }
}
