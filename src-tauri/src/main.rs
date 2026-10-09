#![cfg_attr(windows, windows_subsystem = "windows")]

mod agent;
mod cleanup;
mod commands;
mod logging;
mod paths;
mod tray;

use tauri::Manager;

#[cfg(windows)]
struct SingleInstanceGuard(*mut std::ffi::c_void);

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(
        mutex_attributes: *mut std::ffi::c_void,
        initial_owner: i32,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn GetLastError() -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn FindWindowW(class_name: *const u16, window_name: *const u16) -> *mut std::ffi::c_void;
    fn ShowWindow(window: *mut std::ffi::c_void, command: i32) -> i32;
    fn SetForegroundWindow(window: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
fn focus_existing_manager_window() {
    const SW_RESTORE: i32 = 9;
    let title: Vec<u16> = "Yaseir Print Manager".encode_utf16().chain(Some(0)).collect();
    let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if !window.is_null() {
        unsafe {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }
}

#[cfg(windows)]
fn acquire_single_instance(wait_for_previous: bool) -> Result<Option<SingleInstanceGuard>, String> {
    const ERROR_ALREADY_EXISTS: u32 = 183;
    const ERROR_ACCESS_DENIED: u32 = 5;
    let name: Vec<u16> = "Global\\YaseirPrintManager.SingleInstance.v1"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);

    loop {
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle.is_null() {
            let error = unsafe { GetLastError() };
            // During an explicit Run-as-Administrator relaunch, the elevated
            // process can race the unelevated process while it still owns the
            // global mutex. Wait for that exact handoff instead of exiting the
            // newly approved elevated instance.
            if wait_for_previous
                && error == ERROR_ACCESS_DENIED
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            if error == ERROR_ACCESS_DENIED {
                focus_existing_manager_window();
                return Ok(None);
            }
            return Err(format!(
                "CreateMutexW failed while enforcing single-instance startup: {error}"
            ));
        }

        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            if wait_for_previous && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            focus_existing_manager_window();
            return Ok(None);
        }

        return Ok(Some(SingleInstanceGuard(handle)));
    }
}

fn main() {
    #[cfg(windows)]
    let elevated_relaunch = std::env::args_os()
        .any(|arg| arg.to_string_lossy() == "--elevated-relaunch");
    #[cfg(windows)]
    let _single_instance_guard = match acquire_single_instance(elevated_relaunch) {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[yaseir-manager] {error}");
            std::process::exit(1);
        }
    };
    // Initialize file logging before the Tauri builder so startup failures are
    // visible in a writable ProgramData location rather than disappearing.
    if logging::init().is_none() {
        eprintln!("[yaseir-manager] file logging could not be initialized");
    }

    // Release builds have no console; make panics land in the log file.
    logging::install_panic_hook();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            logging::info("application setup started");

            // Runtime dirs are strictly %PROGRAMDATA% (no per-user fallback,
            // so desktop and service share one home). A non-elevated launch
            // cannot create them — warn and continue so the app still opens
            // and the elevation banner + per-operation admin errors guide
            // the operator to relaunch as administrator.
            if let Err(e) = paths::ensure_runtime_dirs() {
                logging::error(&format!(
                    "unable to create runtime dirs (run as administrator): {e}"
                ));
            }

            logging::info(&format!(
                "runtime dirs: manager={}, agent={}",
                paths::manager_data_root().display(),
                paths::agent_data_root().display()
            ));

            #[cfg(windows)]
            {
                use tauri_plugin_autostart::ManagerExt;
                if std::env::var("YASEIR_MANAGER_AUTOSTART_AGENT").as_deref() != Ok("0") {
                match paths::autostart_choice_path() {
                    Ok(marker) => apply_first_launch_autostart(
                        &marker,
                        || app.autolaunch().enable().map_err(|e| e.to_string()),
                        |path| {
                            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
                            std::fs::write(path, "1").map_err(|e| e.to_string())
                        },
                    ),
                    Err(error) => logging::error(&error),
                }
                }
            }

            tray::setup_tray(app.handle())?;

            // Closing the main window must terminate the desktop manager.
            // The Agent is an independent Windows service (or a separately
            // owned background fallback), so exiting the UI must not leave a
            // hidden manager process in the tray or create duplicate manager
            // instances after repeated open/close cycles.
            if let Some(win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { .. } = e {
                        logging::info("main window close requested; exiting desktop manager");
                        app_handle.exit(0);
                    }
                });
            }

            // Service repair/start is privileged. A normal unelevated launch
            // must not attempt service installation or spawn a fallback Agent
            // before the UI can explain the required Administrator action.
            // An already-running Windows service is independent of this
            // desktop process and remains available without elevation.
            if std::env::var("YASEIR_MANAGER_AUTOSTART_AGENT").as_deref() == Ok("0") {
                logging::info("automatic Agent startup disabled by explicit environment setting");
            } else if cfg!(windows) && !commands::is_running_as_admin() {
                logging::info(
                    "Manager is not elevated; deferring Agent service repair/start until Administrator relaunch",
                );
            } else {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = agent::ensure_started(&handle) {
                        logging::warn(&format!("agent could not be started during setup: {e}"));
                    } else {
                        logging::info("agent service started during setup");
                    }
                });
            }

            logging::info("application setup completed");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_agent_status,
            commands::start_agent,
            commands::stop_agent,
            commands::restart_agent,
            commands::control_service,
            commands::pair_agent,
            commands::get_gateway_config,
            commands::set_gateway_config,
            commands::probe_gateway_health,
            commands::gateway_agent_request,
            commands::get_runtime_paths,
            commands::get_app_version,
            commands::get_printers,
            commands::discover_printers,
            commands::test_printer,
            cleanup::cleanup_local_jobs,
            commands::register_printer,
            commands::get_autostart,
            commands::set_autostart,
            commands::is_running_as_admin,
            commands::relaunch_as_admin,
            tray::set_tray_locale
        ])
        .build(tauri::generate_context!());

    let app = match result {
        Ok(app) => app,
        Err(e) => {
            let msg = format!("error while building tauri app: {e}");
            logging::error(&msg);
            eprintln!("{msg}");
            std::process::exit(1);
        }
    };

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => logging::info("application exit requested"),
        tauri::RunEvent::Exit => logging::info("application exited"),
        _ => {}
    });
}

/// Autostart defaults to ON only on the FIRST launch. Once the user has made
/// a choice (`set_autostart` writes the marker file) this must not override
/// it — the old unconditional `enable()` silently re-enabled autostart on
/// every app start, breaking the user's "off" choice (audit #21).
///
/// The marker means "a default-enable SUCCEEDED or the user chose", never
/// "we tried": when `enable()` fails the marker must NOT be written, so the
/// next launch retries instead of being permanently suppressed by a false
/// success record.
#[cfg(windows)]
fn apply_first_launch_autostart(
    marker: &std::path::Path,
    enable: impl FnOnce() -> Result<(), String>,
    write_marker: impl FnOnce(&std::path::Path) -> Result<(), String>,
) {
    if marker.exists() {
        logging::info("desktop autostart left as configured by the user");
        return;
    }
    match enable() {
        Ok(()) => {
            logging::info("desktop autostart enabled by default on first launch");
            if let Err(e) = write_marker(marker) {
                logging::warn(&format!("could not persist autostart marker: {e}"));
            }
        }
        Err(e) => {
            // No marker: a failed first attempt must remain RETRYABLE on the
            // next launch. This is the defect this function now proves.
            logging::warn(&format!(
                "desktop autostart could not be enabled by default (will retry on next launch): {e}"
            ));
        }
    }
}

#[cfg(all(test, windows))]
mod autostart_tests {
    use super::apply_first_launch_autostart;

    fn temp_marker(test: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("odoo-autostart-{test}-{:?}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("autostart-user-choice")
    }

    #[test]
    fn first_launch_enable_success_persists_the_marker() {
        let marker = temp_marker("ok");
        let _ = std::fs::remove_file(&marker);
        apply_first_launch_autostart(
            &marker,
            || Ok(()),
            |p| std::fs::write(p, "1").map_err(|e| e.to_string()),
        );
        assert!(
            marker.exists(),
            "successful default-enable must record the marker"
        );
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn first_launch_enable_failure_must_not_persist_a_false_marker() {
        // THE regression: previously the marker was written even when
        // enable() failed, permanently suppressing the retry.
        let marker = temp_marker("fail");
        let _ = std::fs::remove_file(&marker);
        let marker_written = std::cell::Cell::new(false);
        apply_first_launch_autostart(
            &marker,
            || Err("registry denied".to_string()),
            |_p| {
                marker_written.set(true);
                Ok(())
            },
        );
        assert!(
            !marker_written.get(),
            "failed enable must not invoke the marker write at all"
        );
        assert!(
            !marker.exists(),
            "failed enable must leave the state retryable (no marker)"
        );
    }

    #[test]
    fn marker_present_never_re_enables_on_subsequent_launches() {
        // Covers both the post-default-enable relaunch and the explicit user
        // choice (set_autostart writes the same marker): enable() must not run.
        let marker = temp_marker("present");
        std::fs::write(&marker, "1").unwrap();
        let mut enable_called = false;
        apply_first_launch_autostart(
            &marker,
            || {
                enable_called = true;
                Ok(())
            },
            |_p| Ok(()),
        );
        assert!(
            !enable_called,
            "an existing marker means the decision is already recorded"
        );
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn marker_write_failure_on_success_is_logged_not_fatal() {
        let marker = temp_marker("writefail");
        let _ = std::fs::remove_file(&marker);
        apply_first_launch_autostart(&marker, || Ok(()), |_p| Err("disk full".to_string()));
        assert!(!marker.exists());
    }
}
