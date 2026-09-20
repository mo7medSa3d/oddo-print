use std::path::PathBuf;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use crate::paths;
use crate::logging;

const SERVICE_NAME: &str = "YasserAgent";
const BACKGROUND_PID_FILE: &str = "agent.pid";
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;

/// Execute a short-lived bundled helper with a hard wall-clock deadline and
/// per-stream output budget. On timeout/output overflow the child is killed
/// and reaped before the error is returned, so no helper process or pipe can
/// survive a failed IPC call.
pub(crate) fn run_bounded_command(
    mut cmd: Command,
    timeout: std::time::Duration,
    max_stdout: usize,
    max_stderr: usize,
) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn command failed: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "command stdout pipe unavailable".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "command stderr pipe unavailable".to_string())?;

    let overflow = Arc::new(AtomicBool::new(false));
    let overflow_out = Arc::clone(&overflow);
    let overflow_err = Arc::clone(&overflow);

    let out_thread = std::thread::spawn(move || {
        let mut reader = stdout.take((max_stdout as u64).saturating_add(1));
        let mut buf = Vec::with_capacity(max_stdout.min(64 * 1024));
        let _ = reader.read_to_end(&mut buf);
        if buf.len() > max_stdout {
            overflow_out.store(true, Ordering::Release);
            buf.truncate(max_stdout);
        }
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut reader = stderr.take((max_stderr as u64).saturating_add(1));
        let mut buf = Vec::with_capacity(max_stderr.min(64 * 1024));
        let _ = reader.read_to_end(&mut buf);
        if buf.len() > max_stderr {
            overflow_err.store(true, Ordering::Release);
            buf.truncate(max_stderr);
        }
        buf
    });

    let deadline = std::time::Instant::now() + timeout;
    let mut status = None;
    loop {
        if overflow.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err(format!("command output exceeded the {} byte stream budget", max_stdout.max(max_stderr)));
        }
        match child.try_wait() {
            Ok(Some(s)) => {
                status = Some(s);
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    return Err(format!("command exceeded timeout of {} seconds", timeout.as_secs()));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(format!("wait for command failed: {e}"));
            }
        }
    }

    if overflow.load(Ordering::Acquire) {
        let _ = out_thread.join();
        let _ = err_thread.join();
        return Err("command output exceeded the configured stream budget".to_string());
    }

    let stdout = out_thread.join().map_err(|_| "stdout reader thread panicked".to_string())?;
    let stderr = err_thread.join().map_err(|_| "stderr reader thread panicked".to_string())?;
    Ok(std::process::Output {
        status: status.expect("status set before reader join"),
        stdout,
        stderr,
    })
}

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

#[cfg(windows)]
fn system32_exe(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\\') || name.contains('/') {
        return Err("invalid Windows system executable name".into());
    }
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .ok_or_else(|| "Windows SystemRoot is unavailable".to_string())?;
    let path = PathBuf::from(root).join("System32").join(name);
    if !path.is_file() {
        return Err(format!("Windows system executable not found: {}", path.display()));
    }
    Ok(path)
}

pub fn agent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_executable(app, "YasserAgent.exe")
}

pub fn cli_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_executable(app, "yasser-agent-cli.exe")
}

fn resolve_executable(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir(app) {
        candidates.push(dir.join("resources").join(name));
        candidates.push(dir.join(name));
    }
    if let Some(dir) = current_exe_dir() {
        candidates.push(dir.join("resources").join(name));
        candidates.push(dir.join(name));
    }
    #[cfg(debug_assertions)]
    {
        let dev_base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("agent");
        candidates.push(dev_base.join(name));
    }

    let path = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("bundled executable {name} not found; checked resource/current-exe/dev paths"))?;
    logging::info(&format!("resolved executable {name}: {}", path.display()));
    Ok(path)
}

#[cfg(windows)]
fn sc_query() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let sc = system32_exe("sc.exe").ok()?;
    let mut cmd = Command::new(sc);
    cmd.args(["query", SERVICE_NAME]).creation_flags(CREATE_NO_WINDOW);
    let out = run_bounded_command(cmd, std::time::Duration::from_secs(5), 16 * 1024, 16 * 1024).ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(not(windows))]
fn sc_query() -> Option<String> {
    None
}

#[cfg(windows)]
fn is_running(app: &tauri::AppHandle) -> bool {
    if let Some(q) = sc_query() {
        if q.to_ascii_uppercase().contains("RUNNING") {
            return true;
        }
    }
    is_process_running(app)
}

#[cfg(not(windows))]
fn is_running(_app: &tauri::AppHandle) -> bool {
    false
}

#[cfg(windows)]
fn is_process_running(app: &tauri::AppHandle) -> bool {
    read_background_record()
        .map(|record| background_record_matches(app, &record))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_process_running(_app: &tauri::AppHandle) -> bool {
    false
}

#[cfg(windows)]
fn run_net(action: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let net = system32_exe("net.exe")?;
    let mut cmd = Command::new(net);
    cmd.args([action, SERVICE_NAME]).creation_flags(CREATE_NO_WINDOW);
    let out = run_bounded_command(cmd, std::time::Duration::from_secs(30), 64 * 1024, 64 * 1024)?;
    if !out.status.success() {
        return Err(format!(
            "net {action} {SERVICE_NAME} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(not(windows))]
fn run_net(action: &str) -> Result<String, String> {
    Err(format!("net {action} is only supported on Windows"))
}

#[cfg(windows)]
fn background_pid_path() -> Result<PathBuf, String> {
    paths::ensure_agent_data_root()
        .map(|root| root.join(BACKGROUND_PID_FILE))
        .map_err(|e| format!("create agent data dir: {e}"))
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct BackgroundProcessRecord {
    pid: u32,
    creation_time: u64,
    image: String,
}

#[cfg(windows)]
fn background_process_record_path() -> Result<PathBuf, String> {
    background_pid_path()
}

#[cfg(windows)]
fn read_background_record() -> Option<BackgroundProcessRecord> {
    let path = background_process_record_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let mut pid = None;
    let mut creation_time = None;
    let mut image = None;
    for line in raw.lines() {
        let (key, value) = line.split_once('=')?;
        match key {
            "pid" => pid = value.trim().parse::<u32>().ok(),
            "creation_time" => creation_time = value.trim().parse::<u64>().ok(),
            "image" => image = Some(value.trim().to_string()),
            _ => {}
        }
    }
    Some(BackgroundProcessRecord {
        pid: pid?,
        creation_time: creation_time?,
        image: image?.trim().to_string(),
    })
}

#[cfg(windows)]
fn clear_background_pid() {
    if let Ok(path) = background_process_record_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
fn pid_permission_guidance(path: &std::path::Path, op: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return format!(
            "cannot {op} the agent ownership record ({}): access denied. Run the app as administrator or use Windows Service mode instead",
            path.display()
        );
    }
    format!("{op} background pid: {e}")
}

#[cfg(windows)]
fn process_identity(pid: u32) -> Result<(String, u64), String> {
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;

    type Handle = *mut c_void;
    type Dword = u32;
    type Bool = i32;

    #[repr(C)]
    struct FileTime {
        low: Dword,
        high: Dword,
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
    unsafe extern "system" {
        fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: Dword,
            exe_name: *mut u16,
            size: *mut Dword,
        ) -> Bool;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
    }

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess({pid}) failed"));
    }

    let result = (|| {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as Dword;
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len)
        };
        if ok == 0 || len == 0 {
            return Err(format!("QueryFullProcessImageNameW({pid}) failed"));
        }
        let image = OsString::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .to_string();

        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let ok = unsafe {
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
        };
        if ok == 0 {
            return Err(format!("GetProcessTimes({pid}) failed"));
        }
        let creation_time = ((creation.high as u64) << 32) | creation.low as u64;
        Ok((image, creation_time))
    })();

    unsafe { CloseHandle(handle); }
    result
}

#[cfg(windows)]
fn terminate_owned_background_process(
    app: &tauri::AppHandle,
    record: &BackgroundProcessRecord,
) -> Result<(), String> {
    use std::ffi::c_void;

    type Handle = *mut c_void;
    type Dword = u32;
    type Bool = i32;

    #[repr(C)]
    struct FileTime {
        low: Dword,
        high: Dword,
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
    const PROCESS_TERMINATE: Dword = 0x0001;
    const SYNCHRONIZE: Dword = 0x0010_0000;
    const WAIT_OBJECT_0: Dword = 0;
    const WAIT_TIMEOUT: Dword = 0x102;

    unsafe extern "system" {
        fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: Dword,
            exe_name: *mut u16,
            size: *mut Dword,
        ) -> Bool;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> Bool;
        fn TerminateProcess(process: Handle, exit_code: Dword) -> Bool;
        fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
        fn CloseHandle(handle: Handle) -> Bool;
    }

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
            0,
            record.pid,
        )
    };
    if handle.is_null() {
        return Err(format!("OpenProcess({}) failed while stopping the owned agent", record.pid));
    }

    let result = (|| {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as Dword;
        if unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) } == 0 || len == 0 {
            return Err(format!("cannot verify image path for owned agent PID {}", record.pid));
        }
        let image = std::os::windows::ffi::OsStringExt::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .to_string();

        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
            return Err(format!("cannot verify creation time for owned agent PID {}", record.pid));
        }
        let creation_time = ((creation.high as u64) << 32) | creation.low as u64;
        let expected = expected_agent_image(app)?;
        if !image.eq_ignore_ascii_case(&expected)
            || creation_time != record.creation_time
            || !record.image.eq_ignore_ascii_case(&expected)
        {
            return Err(format!(
                "refusing to terminate PID {} because process identity does not match the owned YasserAgent.exe",
                record.pid
            ));
        }

        if unsafe { TerminateProcess(handle, 1) } == 0 {
            return Err(format!("TerminateProcess({}) failed", record.pid));
        }
        match unsafe { WaitForSingleObject(handle, 5000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(format!("owned YasserAgent.exe PID {} did not exit within 5 seconds", record.pid)),
            other => Err(format!("waiting for owned YasserAgent.exe PID {} failed with status 0x{other:08x}", record.pid)),
        }
    })();

    unsafe { CloseHandle(handle); }
    result
}

#[cfg(windows)]
fn expected_agent_image(app: &tauri::AppHandle) -> Result<String, String> {
    let path = agent_path(app)?;
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(canonical.to_string_lossy().to_string())
}

#[cfg(windows)]
fn background_record_matches(app: &tauri::AppHandle, record: &BackgroundProcessRecord) -> bool {
    let Ok(expected) = expected_agent_image(app) else { return false; };
    let Ok((actual, creation_time)) = process_identity(record.pid) else { return false; };
    actual.eq_ignore_ascii_case(&expected)
        && creation_time == record.creation_time
        && record.image.eq_ignore_ascii_case(&expected)
}

#[cfg(windows)]
fn write_background_pid(pid: u32) -> Result<(), String> {
    let path = background_process_record_path()?;
    let (image, creation_time) = process_identity(pid)?;
    let tmp = path.with_extension("tmp");
    let image = std::fs::canonicalize(&image).unwrap_or_else(|_| PathBuf::from(&image));
    let contents = format!(
        "pid={}\ncreation_time={}\nimage={}\n",
        pid,
        creation_time,
        image.display()
    );
    std::fs::write(&tmp, contents)
        .map_err(|e| pid_permission_guidance(&tmp, "write", &e))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| pid_permission_guidance(&path, "commit", &e))?;
    Ok(())
}

#[cfg(windows)]
fn taskkill_pid(pid: u32, force: bool) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid_arg = pid.to_string();
    let taskkill = system32_exe("taskkill.exe")?;
    let mut cmd = Command::new(taskkill);
    if force {
        cmd.args(["/PID", &pid_arg, "/T", "/F"]);
    } else {
        cmd.args(["/PID", &pid_arg, "/T"]);
    }
    cmd.creation_flags(CREATE_NO_WINDOW);
    run_bounded_command(cmd, std::time::Duration::from_secs(30), 32 * 1024, 32 * 1024)
}

/// Spawn a background agent and record ownership metadata for it. If the
/// PID cannot be persisted the child is terminated and reaped BEFORE the
/// error surfaces: `stop()`/`restart()` only ever kill the recorded PID (by
/// design they refuse to kill by image name), so an agent running without a
/// persisted ownership record would be permanently unmanaged. Reconciling
/// here keeps the invariant "no unowned spawned process is ever left behind"
/// while preserving the original persistence error verbatim.
#[cfg(windows)]
fn spawn_persist_or_reconcile(
    mut spawn: impl FnMut() -> Result<std::process::Child, String>,
    persist: impl FnOnce(u32) -> Result<(), String>,
) -> Result<u32, String> {
    let mut child = spawn()?;
    let pid = child.id();
    match persist(pid) {
        Ok(()) => Ok(pid),
        Err(e) => {
            logging::warn(&format!(
                "agent pid={pid} spawned but its ownership record could not be persisted; terminating the unowned child: {e}"
            ));
            let _ = child.kill();
            let _ = child.wait();
            Err(e)
        }
    }
}

#[cfg(windows)]
fn spawn_background(app: &tauri::AppHandle) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let path = agent_path(app)?;
    let root = paths::ensure_agent_data_root()
        .map_err(|e| format!("create agent data dir: {e}"))?;
    let config = root.join("config.yaml");

    let mut cmd = Command::new(&path);
    cmd.arg("-config").arg(&config);
    cmd.env("YASSER_AGENT_DATA_DIR", &root);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);

    let pid = spawn_persist_or_reconcile(
        || {
            cmd
                .spawn()
                .map_err(|e| format!("spawn agent {} (config {}) : {e}", path.display(), config.display()))
        },
        write_background_pid,
    )?;
    logging::info(&format!("started YasserAgent.exe pid={pid} config={}", config.display()));
    Ok(pid)
}

#[cfg(not(windows))]
fn spawn_background(_app: &tauri::AppHandle) -> Result<u32, String> {
    Err("YasserAgent.exe can only be launched on Windows".into())
}

pub fn ensure_started(app: &tauri::AppHandle) -> Result<(), String> {
    if is_running(app) {
        logging::info("agent is already running");
        return Ok(());
    }
    start(app)
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if is_running(app) {
        return Ok(());
    }
    if sc_query().is_some() {
        match run_net("start") {
            Ok(_) => {
                logging::info("agent service started via net start");
                return Ok(());
            }
            Err(e) => logging::warn(&format!("could not start agent service ({e}); falling back to background process")),
        }
    }
    spawn_background(app).map(|_| ())
}

pub fn stop(app: &tauri::AppHandle) -> Result<(), String> {
    if is_running(app) {
        if sc_query().map(|q| q.to_ascii_uppercase().contains("RUNNING")).unwrap_or(false) {
            run_net("stop")?;
        } else {
            #[cfg(windows)]
            {
                let record = read_background_record().ok_or_else(|| {
                    "background agent is running but its secure ownership record is missing or legacy; refusing to kill arbitrary YasserAgent.exe processes".to_string()
                })?;
                if !background_record_matches(app, &record) {
                    return Err(format!(
                        "refusing to stop PID {} because its image path or creation time no longer matches the owned YasserAgent.exe",
                        record.pid
                    ));
                }

                terminate_owned_background_process(app, &record)?;
                logging::info(&format!(
                    "terminated exactly the owned YasserAgent.exe PID {} after identity verification",
                    record.pid
                ));
                clear_background_pid();
            }
        }
    }
    logging::info("agent stopped");
    Ok(())
}

pub fn restart(app: &tauri::AppHandle) -> Result<(), String> {
    stop(app)?;
    start(app)
}

pub fn status(app: &tauri::AppHandle) -> (bool, bool, String) {
    let service_running = sc_query()
        .map(|q| q.to_ascii_uppercase().contains("RUNNING"))
        .unwrap_or(false);
    let process_running = is_process_running(app);
    let note = if service_running {
        format!("Windows service {SERVICE_NAME} is running")
    } else if process_running {
        format!("background process YasserAgent.exe is running (service not detected)")
    } else {
        format!("agent is not running; service/process not detected")
    };
    (service_running || process_running, service_running, note)
}

pub fn control_service(action: &str, app: &tauri::AppHandle) -> Result<String, String> {
    match action {
        "install" | "uninstall" | "start" | "stop" | "restart" => {
            let path = agent_path(app)?;
            let config = paths::agent_config_path();
            let _ = paths::ensure_agent_data_root()
                .map_err(|e| format!("create agent data dir: {e}"))?;
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let out = Command::new(&path)
                    .args(["-service", action, "-config"])
                    .arg(&config)
                    .env("YASSER_AGENT_DATA_DIR", paths::agent_data_root())
                    .creation_flags(CREATE_NO_WINDOW)
                    run_bounded_command(
                        Command::new(&path)
                            .args(["-service", action, "-config"])
                            .arg(&config)
                            .env("YASSER_AGENT_DATA_DIR", paths::agent_data_root()),
                        COMMAND_TIMEOUT,
                        MAX_COMMAND_OUTPUT_BYTES,
                        MAX_COMMAND_OUTPUT_BYTES,
                    )?;
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !out.status.success() {
                    let msg = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
                    return Err(format!(
                        "service action {action} failed (administrator may be required): {msg}"
                    ));
                }
                let msg = if !stdout.is_empty() { stdout } else { format!("service action {action} completed") };
                logging::info(&format!("service control {action}: {msg}"));
                return Ok(msg);
            }
            #[cfg(not(windows))]
            {
                let out = Command::new(&path)
                    .args(["-service", action, "-config"])
                    .arg(&config)
                    .env("YASSER_AGENT_DATA_DIR", paths::agent_data_root())
                    .output()
                    .map_err(|e| format!("failed to run {} -service {action}: {e}", path.display()))?;
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !out.status.success() {
                    let msg = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
                    return Err(format!(
                        "service action {action} failed (administrator may be required): {msg}"
                    ));
                }
                let msg = if !stdout.is_empty() { stdout } else { format!("service action {action} completed") };
                logging::info(&format!("service control {action}: {msg}"));
                return Ok(msg);
            }
        }
        _ => Err(format!("invalid service action {:?}", action)),
    }
}

#[cfg(all(test, windows))]
mod spawn_tests {
    use super::spawn_persist_or_reconcile;
    use super::system32_exe;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn sleeper() -> std::process::Child {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/C", "ping 127.0.0.1 -n 15 > nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .expect("spawn cmd.exe sleeper")
    }

    fn pid_alive(pid: u32) -> bool {
        use std::os::windows::process::CommandExt;
        let tasklist = match system32_exe("tasklist.exe") {
            Ok(path) => path,
            Err(_) => return false,
        };
        let out = Command::new(tasklist)
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    #[test]
    fn successful_persistence_keeps_the_spawned_agent_owned_and_alive() {
        let pid = spawn_persist_or_reconcile(|| Ok(sleeper()), |_| Ok(())).expect("spawn+persist must succeed");
        assert!(pid_alive(pid), "the agent child must remain running when ownership was recorded");
        // Exact-PID cleanup of this TEST's own child (never a name kill).
        let taskkill = system32_exe("taskkill.exe").unwrap_or_else(|_| PathBuf::from("taskkill.exe"));
        let _ = Command::new(taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    #[test]
    fn failed_pid_persistence_terminates_the_child_and_preserves_the_error() {
        // THE regression: previously the child was left running with no PID
        // record - permanently unmanaged, because stop() refuses to kill
        // processes it cannot attribute to itself.
        use std::cell::Cell;
        let spawned_pid = Cell::new(0u32);
        let result = spawn_persist_or_reconcile(|| Ok(sleeper()), |pid| {
            spawned_pid.set(pid);
            Err("disk full writing agent.pid".to_string())
        });
        let err = result.expect_err("the original persistence error must be returned");
        assert_eq!(err, "disk full writing agent.pid", "error must be surfaced verbatim");

        let pid = spawned_pid.get();
        assert_ne!(pid, 0, "a child must actually have been spawned before persist was called");
        let deadline = Instant::now() + Duration::from_secs(5);
        while pid_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!pid_alive(pid), "spawned child must be terminated and reaped when its PID write fails");
    }
}

#[cfg(all(windows, test))]
mod tests {
    use super::system32_exe;

    #[test]
    fn system_commands_are_resolved_from_system32() {
        for name in ["sc.exe", "net.exe", "tasklist.exe", "taskkill.exe"] {
            let path = system32_exe(name).expect("Windows system executable must exist");
            assert!(path.ends_with(["System32", name].iter().collect::<std::path::PathBuf>()));
        }
    }
}
