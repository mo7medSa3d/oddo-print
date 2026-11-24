fn main() {
    const COMMANDS: &[&str] = &[
        "get_agent_status",
        "start_agent",
        "stop_agent",
        "restart_agent",
        "control_service",
        "pair_agent",
        "get_gateway_config",
        "set_gateway_config",
        "probe_gateway_health",
        "gateway_agent_request",
        "get_runtime_paths",
        "get_app_version",
        "get_printers",
        "set_printer_visibility",
        "discover_printers",
        "test_printer",
        "cleanup_local_jobs",
        "register_printer",
        "get_autostart",
        "set_autostart",
        "is_running_as_admin",
        "relaunch_as_admin",
        "close_app",
        "set_tray_locale",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .unwrap();
}
