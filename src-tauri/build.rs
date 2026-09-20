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
    "gateway_request",
    "gateway_agent_request",
    "clear_manager_session",
    "has_manager_session",
    "get_runtime_paths",
    "get_app_version",
    "get_printers",
    "discover_printers",
    "test_printer",
    "cleanup_local_jobs",
    "register_printer",
    "get_autostart",
    "set_autostart",
    "is_running_as_admin",
  ];

  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(
        tauri_build::AppManifest::new().commands(COMMANDS),
      ),
  )
  .unwrap();
}
