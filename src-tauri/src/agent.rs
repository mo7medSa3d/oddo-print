use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use crate::logging;
use crate::paths;

const SERVICE_NAME: &str = "YaseirAgent";
const BACKGROUND_PID_FILE: &str = "agent.pid";
const BACKGROUND_PID_META_FILE: &str = "agent.pid.meta";
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;

/// Execute a short-lived bundled helper with a hard wall-clock deadline and
/// per-stream output budget. On timeout/output overflow the child is killed
/// and reaped before the error is returned, so no helper process or pipe can
/// survive a failed IPC call.
/// Reader-thread join bound for [`run_bounded_command`]. After the child is
/// reaped its pipes normally EOF promptly — unless a forked descendant
/// inherited them and keeps them open. An unbounded `join()` would then hang
/// the caller forever, so the join itself carries a deadline. On expiry the
/// call fails (the reader threads plus one join-waiter thread are detached,
/// never accumulated by the caller — at most three per hung invocation, and
/// invocations are finite operator/system actions, not loops); the child
/// itself was already killed and reaped above.
fn join_reader_thread(
    handle: std::thread::JoinHandle<Result<Vec<u8>, String>>,
    what: &str,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(handle.join());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("{what} reader thread panicked")),
        Err(_) => Err(format!(
            "{what} reader thread did not finish within 10s (a descendant process may hold the pipe); output discarded"
        )),
    }
}

pub(crate) fn run_bounded_command(
    mut cmd: Command,
    timeout: std::time::Duration,
    max_stdout: usize,
    max_stderr: usize,
) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn command failed: {e}"))?;
    let stdout = match child.stdout.take() {
        Some(pipe) => pipe,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("command stdout pipe unavailable".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(pipe) => pipe,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("command stderr pipe unavailable".to_string());
        }
    };

    let overflow = Arc::new(AtomicBool::new(false));
    let overflow_out = Arc::clone(&overflow);
    let overflow_err = Arc::clone(&overflow);

    let out_thread = std::thread::spawn(move || {
        let mut reader = stdout.take((max_stdout as u64).saturating_add(1));
        let mut buf = Vec::with_capacity(max_stdout.min(64 * 1024));
        let read_result = reader.read_to_end(&mut buf);
        if buf.len() > max_stdout {
            overflow_out.store(true, Ordering::Release);
            buf.truncate(max_stdout);
        }
        read_result.map(|_| buf).map_err(|error| format!("read command output: {error}"))
    });
    let err_thread = std::thread::spawn(move || {
        let mut reader = stderr.take((max_stderr as u64).saturating_add(1));
        let mut buf = Vec::with_capacity(max_stderr.min(64 * 1024));
        let read_result = reader.read_to_end(&mut buf);
        if buf.len() > max_stderr {
            overflow_err.store(true, Ordering::Release);
            buf.truncate(max_stderr);
        }
        read_result.map(|_| buf).map_err(|error| format!("read command output: {error}"))
    });

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        if overflow.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            join_reader_thread(out_thread, "stdout")?;
            join_reader_thread(err_thread, "stderr")?;
            return Err(format!(
                "command output exceeded the {} byte stream budget",
                max_stdout.max(max_stderr)
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    join_reader_thread(out_thread, "stdout")?;
                    join_reader_thread(err_thread, "stderr")?;
                    return Err(format!(
                        "command exceeded timeout of {} seconds",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                join_reader_thread(out_thread, "stdout")?;
                join_reader_thread(err_thread, "stderr")?;
                return Err(format!("wait for command failed: {e}"));
            }
        };
    };

    if overflow.load(Ordering::Acquire) {
        join_reader_thread(out_thread, "stdout")?;
        join_reader_thread(err_thread, "stderr")?;
        return Err("command output exceeded the configured stream budget".to_string());
    }

    let stdout = join_reader_thread(out_thread, "stdout")?;
    let stderr = join_reader_thread(err_thread, "stderr")?;
    if overflow.load(Ordering::Acquire) {
        return Err("command output exceeded the configured stream budget".to_string());
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|p| p.to_path_buf())
}

#[cfg(windows)]
fn system32_exe(name: &str) -> Result<PathBuf, String> {
    // Never resolve privileged executables from inherited environment
    // variables: SystemRoot/WINDIR can be spoofed to redirect
    // taskkill.exe execution to an attacker-controlled file. Share the
    // OS-resolved system-directory helper (GetSystemDirectoryW).
    crate::paths::windows_system32_exe(name).map_err(|e| e.to_string())
}

pub fn agent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Canonical binary is YaseirAgent.exe; pre-migration bundles shipped
    // YasserAgent.exe — accept the legacy name as a fallback so upgraded
    // installs keep working until they reinstall.
    resolve_executable(app, "YaseirAgent.exe")
        .or_else(|_| resolve_executable(app, "YasserAgent.exe"))
}

pub fn cli_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_executable(app, "yaseir-agent-cli.exe")
        .or_else(|_| resolve_executable(app, "yasser-agent-cli.exe"))
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
        let dev_base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("agent");
        candidates.push(dev_base.join(name));
    }

    let path = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            format!("bundled executable {name} not found; checked resource/current-exe/dev paths")
        })?;
    logging::info(&format!("resolved executable {name}: {}", path.display()));
    Ok(path)
}

#[cfg(windows)]
fn sc_query() -> Result<Option<u32>, String> {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct ServiceStatusProcess {
        service_type: u32, current_state: u32, controls_accepted: u32,
        win32_exit_code: u32, service_specific_exit_code: u32,
        checkpoint: u32, wait_hint: u32, process_id: u32, service_flags: u32,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenSCManagerW(machine: *const u16, database: *const u16, access: u32) -> Handle;
        fn OpenServiceW(manager: Handle, name: *const u16, access: u32) -> Handle;
        fn QueryServiceStatusEx(service: Handle, level: u32, buffer: *mut u8, size: u32, needed: *mut u32) -> i32;
        fn CloseServiceHandle(handle: Handle) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" { fn GetLastError() -> u32; }
    let name: Vec<u16> = SERVICE_NAME.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let manager = OpenSCManagerW(std::ptr::null(), std::ptr::null(), 0x0001);
        if manager.is_null() { return Err(format!("OpenSCManagerW failed: {}", GetLastError())); }
        let service = OpenServiceW(manager, name.as_ptr(), 0x0004);
        if service.is_null() {
            let error = GetLastError();
            CloseServiceHandle(manager);
            return if error == 1060 { Ok(None) } else { Err(format!("OpenServiceW failed: {error}")) };
        }
        let mut status = ServiceStatusProcess::default();
        let mut needed = 0;
        let ok = QueryServiceStatusEx(service, 0, &mut status as *mut _ as *mut u8, std::mem::size_of::<ServiceStatusProcess>() as u32, &mut needed);
        let error = if ok == 0 { Some(GetLastError()) } else { None };
        CloseServiceHandle(service); CloseServiceHandle(manager);
        if let Some(error) = error { Err(format!("QueryServiceStatusEx failed: {error}")) } else { Ok(Some(status.current_state)) }
    }
}

#[cfg(not(windows))]
fn sc_query() -> Result<Option<u32>, String> { Ok(None) }

fn wait_service_state(expected: u32) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match sc_query()? {
            Some(state) if state == expected => return Ok(()),
            None => return Err("service disappeared during control operation".into()),
            Some(state) if state != 2 && state != 3 => return Err(format!("service reached unexpected state {state}; expected {expected}")),
            _ => {}
        }
        if std::time::Instant::now() >= deadline { return Err("service state transition timed out; background fallback is blocked".into()); }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

static AGENT_CONTROL: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn run_agent_service_command(
    app: &tauri::AppHandle,
    action: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let path = agent_path(app)?;
    let config = paths::agent_config_path();
    let _ = paths::ensure_agent_data_root()
        .map_err(|e| format!("create agent data dir: {e}"))?;
    let mut service_cmd = Command::new(&path);
    service_cmd
        .args(["-service", action, "-config"])
        .arg(&config)
        .env("YASEIR_AGENT_DATA_DIR", paths::agent_data_root());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        service_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = run_bounded_command(
        service_cmd,
        timeout,
        MAX_COMMAND_OUTPUT_BYTES,
        MAX_COMMAND_OUTPUT_BYTES,
    )?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "service action {action} failed (administrator may be required): {message}"
        ));
    }
    Ok(if stdout.is_empty() {
        format!("service action {action} completed")
    } else {
        stdout
    })
}

fn verify_installed_service_ownership(app: &tauri::AppHandle) -> Result<(), String> {
    run_agent_service_command(app, "status", COMMAND_TIMEOUT).map(|_| ())
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
    paths::ensure_agent_data_root()
        .map(|root| root.join(BACKGROUND_PID_META_FILE))
        .map_err(|e| format!("create agent data dir: {e}"))
}

#[cfg(windows)]
fn read_background_record() -> Option<BackgroundProcessRecord> {
    let pid_path = background_pid_path().ok()?;
    let raw_pid = std::fs::read_to_string(pid_path).ok()?;
    let mut pid = raw_pid.trim().parse::<u32>().ok()?;

    // The legacy contract remains agent.pid = plain decimal PID. The identity
    // metadata is optional for backward compatibility; when absent (old
    // installs) reconstruct it from the live process before any termination.
    let meta_path = background_process_record_path().ok()?;
    let raw = std::fs::read_to_string(meta_path).ok();
    let Some(raw) = raw else {
        let (image, creation_time) = process_identity(pid).ok()?;
        return Some(BackgroundProcessRecord {
            pid,
            creation_time,
            image,
        });
    };

    let mut creation_time = None;
    let mut image = None;
    for line in raw.lines() {
        // Skip a single malformed line instead of abandoning the whole
        // record: otherwise one corrupt line makes a running agent look
        // unmanaged.
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "pid" => {
                pid = value.trim().parse::<u32>().ok()?;
            }
            "creation_time" => creation_time = value.trim().parse::<u64>().ok(),
            "image" => image = Some(value.trim().to_string()),
            _ => {}
        }
    }
    Some(BackgroundProcessRecord {
        pid,
        creation_time: creation_time?,
        image: image?.trim().to_string(),
    })
}

#[cfg(windows)]
fn clear_background_pid() {
    if let Ok(path) = background_pid_path() {
        let _ = std::fs::remove_file(path);
    }
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
    use std::ffi::{OsString, c_void};
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
        let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) };
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
        let ok =
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
        if ok == 0 {
            return Err(format!("GetProcessTimes({pid}) failed"));
        }
        let creation_time = ((creation.high as u64) << 32) | creation.low as u64;
        Ok((image, creation_time))
    })();

    unsafe {
        CloseHandle(handle);
    }
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
        return Err(format!(
            "OpenProcess({}) failed while stopping the owned agent",
            record.pid
        ));
    }

    let result = (|| {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as Dword;
        if unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) } == 0
            || len == 0
        {
            return Err(format!(
                "cannot verify image path for owned agent PID {}",
                record.pid
            ));
        }
        let image = <std::ffi::OsString as std::os::windows::ffi::OsStringExt>::from_wide(
            &buf[..len as usize],
        )
        .to_string_lossy()
        .to_string();

        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(format!(
                "cannot verify creation time for owned agent PID {}",
                record.pid
            ));
        }
        let creation_time = ((creation.high as u64) << 32) | creation.low as u64;
        let expected = expected_agent_image(app)?;
        if !process_images_match(&image, &expected)
            || creation_time != record.creation_time
            || !process_images_match(&record.image, &expected)
        {
            return Err(format!(
                "refusing to terminate PID {} because process identity does not match the owned YaseirAgent.exe",
                record.pid
            ));
        }

        if unsafe { TerminateProcess(handle, 1) } == 0 {
            return Err(format!("TerminateProcess({}) failed", record.pid));
        }
        match unsafe { WaitForSingleObject(handle, 5000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(format!(
                "owned YaseirAgent.exe PID {} did not exit within 5 seconds",
                record.pid
            )),
            other => Err(format!(
                "waiting for owned YaseirAgent.exe PID {} failed with status 0x{other:08x}",
                record.pid
            )),
        }
    })();

    unsafe {
        CloseHandle(handle);
    }
    result
}

fn normalized_process_image(image: &str) -> String {
    let path = image.replace('/', "\\");
    if path.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"\\?\UNC\")) {
        return format!(r"\\{}", &path[8..]);
    }
    if let Some(drive) = path.strip_prefix(r"\\?\") {
        if drive.as_bytes().get(1) == Some(&b':') { return drive.to_string(); }
    }
    path
}

fn process_images_match(actual: &str, expected: &str) -> bool {
    normalized_process_image(actual).eq_ignore_ascii_case(&normalized_process_image(expected))
}

#[cfg(windows)]
fn expected_agent_image(app: &tauri::AppHandle) -> Result<String, String> {
    let path = agent_path(app)?;
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(canonical.to_string_lossy().to_string())
}

#[cfg(windows)]
fn background_record_matches(app: &tauri::AppHandle, record: &BackgroundProcessRecord) -> bool {
    let Ok(expected) = expected_agent_image(app) else {
        return false;
    };
    let Ok((actual, creation_time)) = process_identity(record.pid) else {
        return false;
    };
    process_images_match(&actual, &expected)
        && creation_time == record.creation_time
        && process_images_match(&record.image, &expected)
}

#[cfg(windows)]
fn write_background_pid(pid: u32) -> Result<(), String> {
    let pid_path = background_pid_path()?;
    let meta_path = background_process_record_path()?;
    let (image, creation_time) = process_identity(pid)?;
    let image = std::fs::canonicalize(&image).unwrap_or_else(|_| PathBuf::from(&image));

    let pid_tmp = pid_path.with_extension("tmp");
    std::fs::write(&pid_tmp, pid.to_string())
        .map_err(|e| pid_permission_guidance(&pid_tmp, "write", &e))?;
    if let Err(e) = std::fs::rename(&pid_tmp, &pid_path) {
        let _ = std::fs::remove_file(&pid_tmp);
        return Err(pid_permission_guidance(&pid_path, "commit", &e));
    }

    let meta_tmp = meta_path.with_extension("tmp");
    let meta_contents = format!(
        "creation_time={}\nimage={}\n",
        creation_time,
        image.display()
    );
    if let Err(e) = std::fs::write(&meta_tmp, meta_contents)
        .map_err(|e| pid_permission_guidance(&meta_tmp, "write", &e))
        .and_then(|_| {
            std::fs::rename(&meta_tmp, &meta_path)
                .map_err(|e| pid_permission_guidance(&meta_path, "commit", &e))
        })
    {
        let _ = std::fs::remove_file(&meta_tmp);
        let _ = std::fs::remove_file(&pid_path);
        return Err(e);
    }
    Ok(())
}

/// Spawn a background agent and record ownership metadata for it. If the
/// PID cannot be persisted the child is terminated and reaped BEFORE the
/// error surfaces: `stop()`/`restart()` only ever kill the recorded PID (by
/// design they refuse to kill by image name), so an agent running without a
/// persisted ownership record would be permanently unmanaged. Reconciling
/// here keeps the invariant "no unowned spawned process is ever left behind"
/// while preserving the original persistence error verbatim.
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
    run_bounded_command(
        cmd,
        std::time::Duration::from_secs(30),
        32 * 1024,
        32 * 1024,
    )
}

#[cfg(windows)]
fn spawn_persist_or_reconcile(
    mut spawn: impl FnMut() -> Result<std::process::Child, String>,
    persist: impl FnOnce(u32) -> Result<(), String>,
) -> Result<u32, String> {
    let mut child = spawn()?;
    let pid = child.id();

    // A duplicate runtime or startup validation failure exits almost
    // immediately. Give it a short grace window before recording ownership so
    // a dead process can never be persisted as a healthy background Agent.
    std::thread::sleep(std::time::Duration::from_millis(250));
    match child.try_wait() {
        Ok(Some(status)) => {
            return Err(format!(
                "YaseirAgent.exe pid={pid} exited during startup with status {status}"
            ));
        }
        Ok(None) => {}
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("verify Agent startup pid={pid}: {error}"));
        }
    }

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
    let root =
        paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {e}"))?;
    let config = root.join("config.yaml");

    let mut cmd = Command::new(&path);
    cmd.arg("-config").arg(&config);
    cmd.env("YASEIR_AGENT_DATA_DIR", &root);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);

    let pid = spawn_persist_or_reconcile(
        || {
            cmd.spawn().map_err(|e| {
                format!(
                    "spawn agent {} (config {}) : {e}",
                    path.display(),
                    config.display()
                )
            })
        },
        write_background_pid,
    )?;
    logging::info(&format!(
        "started YaseirAgent.exe pid={pid} config={}",
        config.display()
    ));
    Ok(pid)
}

#[cfg(not(windows))]
fn spawn_background(_app: &tauri::AppHandle) -> Result<u32, String> {
    Err("YaseirAgent.exe can only be launched on Windows".into())
}

pub fn ensure_started(app: &tauri::AppHandle) -> Result<(), String> { start(app) }

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let _control = AGENT_CONTROL.lock().map_err(|_| "Agent control lock poisoned")?;
    start_inner(app)
}

fn start_inner(app: &tauri::AppHandle) -> Result<(), String> {
    match sc_query()? {
        Some(state) => {
            // A well-known service name is not ownership evidence. The
            // bundled Agent validates the SCM BinaryPathName against its own
            // executable before status/start/stop/restart operations.
            verify_installed_service_ownership(app)?;
            match state {
                4 => Ok(()),
                2 => wait_service_state(4),
                3 => {
                    wait_service_state(1)?;
                    run_agent_service_command(app, "start", COMMAND_TIMEOUT)?;
                    wait_service_state(4)
                }
                1 => {
                    if is_process_running(app) {
                        stop_inner(app)?;
                    }
                    run_agent_service_command(app, "start", COMMAND_TIMEOUT)?;
                    wait_service_state(4)
                }
                other => Err(format!(
                    "installed service is in state {other}; fix the service before starting another Agent"
                )),
            }
        }
        None => {
            if is_process_running(app) {
                return Ok(());
            }
            spawn_background(app).map(|_| ())
        }
    }
}

pub fn stop(app: &tauri::AppHandle) -> Result<(), String> {
    let _control = AGENT_CONTROL.lock().map_err(|_| "Agent control lock poisoned")?;
    stop_inner(app)
}

fn stop_inner(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = sc_query()? {
        verify_installed_service_ownership(app)?;
        match state {
            1 => {}
            2 => {
                wait_service_state(4)?;
                run_agent_service_command(app, "stop", COMMAND_TIMEOUT)?;
                wait_service_state(1)?;
            }
            3 => {
                wait_service_state(1)?;
            }
            _ => {
                run_agent_service_command(app, "stop", COMMAND_TIMEOUT)?;
                wait_service_state(1)?;
            }
        }
    }
    #[cfg(windows)]
    if is_process_running(app) {
    let record = read_background_record().ok_or_else(|| {
        "background agent is running but its secure ownership record is missing or legacy; refusing to kill arbitrary YaseirAgent.exe processes".to_string()
    })?;
    if !background_record_matches(app, &record) {
        return Err(format!(
            "refusing to stop PID {} because its image path or creation time no longer matches the owned YaseirAgent.exe",
            record.pid
        ));
    }

    // Preserve the previous graceful-stop behavior, but only
    // after verifying that the recorded PID still denotes our exact
    // executable instance. If the process ignores graceful stop,
    // re-verify identity and then use the same exact PID for force
    // termination.
    let out = taskkill_pid(record.pid, false)?;
    if !out.status.success() {
        logging::warn(&format!(
            "graceful taskkill for owned agent pid={} reported: {}",
            record.pid,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    } else {
        logging::info(&format!(
            "graceful shutdown requested for owned agent pid={}",
            record.pid
        ));
    }

    for _ in 0..5 {
        if !background_record_matches(app, &record) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    if background_record_matches(app, &record) {
        terminate_owned_background_process(app, &record)?;
        logging::warn(&format!(
            "owned agent pid={} did not exit within the grace window; force-terminated after identity re-verification",
            record.pid
        ));
    }
    if background_record_matches(app, &record) {
        return Err(format!(
            "owned YaseirAgent.exe PID {} is still running after forced termination",
            record.pid
        ));
    }
    clear_background_pid();
    }
    logging::info("agent stopped");
    Ok(())
}

pub fn restart(app: &tauri::AppHandle) -> Result<(), String> {
    let _control = AGENT_CONTROL.lock().map_err(|_| "Agent control lock poisoned")?;
    stop_inner(app)?;
    start_inner(app)
}

pub fn status(app: &tauri::AppHandle) -> (bool, bool, String) {
    let process_running = is_process_running(app);
    match sc_query() {
        Err(error) => (
            process_running,
            false,
            format!("service state unavailable: {error}; background fallback is {}", if process_running { "running" } else { "not running" }),
        ),
        Ok(None) => {
            if process_running {
                (true, false, "background process YaseirAgent.exe is running (service not detected)".to_string())
            } else {
                (false, false, "agent is not running; service/process not detected".to_string())
            }
        }
        Ok(Some(state)) => {
            if let Err(error) = verify_installed_service_ownership(app) {
                let note = format!(
                    "service registration is not owned by this Yaseir installation: {error}"
                );
                return (process_running, false, note);
            }
            let service_running = state == 4;
            let note = if service_running {
                format!("Windows service {SERVICE_NAME} is running")
            } else if process_running {
                format!("Windows service {SERVICE_NAME} is owned but stopped/transitioning; owned background Agent is running")
            } else {
                format!("Windows service {SERVICE_NAME} is owned but not running")
            };
            (service_running || process_running, service_running, note)
        }
    }
}

pub fn control_service(action: &str, app: &tauri::AppHandle) -> Result<String, String> {
    let _control = AGENT_CONTROL.lock().map_err(|_| "Agent control lock poisoned")?;
    match action {
        "install" | "uninstall" | "start" | "stop" | "restart" => {
            // Service install/start/restart and destructive uninstall must
            // never overlap the desktop background fallback. In particular,
            // uninstall has to close queue.db before the Go purge removes its
            // ProgramData tree.
            if matches!(action, "install" | "uninstall" | "start" | "restart")
                && is_process_running(app)
            {
                stop_inner(app)?;
            }
            let timeout = if action == "uninstall" {
                // Purging WebView/cache/log/runtime data across Windows user
                // profiles can legitimately take longer than a simple SCM
                // start/stop operation.
                std::time::Duration::from_secs(120)
            } else {
                COMMAND_TIMEOUT
            };
            let message = run_agent_service_command(app, action, timeout)?;
            if matches!(action, "start" | "restart") {
                wait_service_state(4)?;
            }
            if action == "stop" {
                wait_service_state(1)?;
            }
            logging::info(&format!("service control {action}: {message}"));
            return Ok(message);
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
        let pid = spawn_persist_or_reconcile(|| Ok(sleeper()), |_| Ok(()))
            .expect("spawn+persist must succeed");
        assert!(
            pid_alive(pid),
            "the agent child must remain running when ownership was recorded"
        );
        // Exact-PID cleanup of this TEST's own child (never a name kill).
        let taskkill =
            system32_exe("taskkill.exe").unwrap_or_else(|_| PathBuf::from("taskkill.exe"));
        let _ = Command::new(taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    #[test]
    fn immediate_child_exit_is_never_persisted_as_a_running_agent() {
        use std::cell::Cell;
        use std::os::windows::process::CommandExt;

        let persist_called = Cell::new(false);
        let result = spawn_persist_or_reconcile(
            || {
                Command::new("cmd")
                    .args(["/C", "exit 7"])
                    .creation_flags(0x0800_0000)
                    .spawn()
                    .map_err(|e| e.to_string())
            },
            |_| {
                persist_called.set(true);
                Ok(())
            },
        );

        let error = result.expect_err("an immediately exiting child must fail startup");
        assert!(
            error.contains("exited during startup"),
            "unexpected startup error: {error}"
        );
        assert!(
            !persist_called.get(),
            "a dead child PID must never be persisted as Agent ownership"
        );
    }

    #[test]
    fn failed_pid_persistence_terminates_the_child_and_preserves_the_error() {
        // THE regression: previously the child was left running with no PID
        // record - permanently unmanaged, because stop() refuses to kill
        // processes it cannot attribute to itself.
        use std::cell::Cell;
        let spawned_pid = Cell::new(0u32);
        let result = spawn_persist_or_reconcile(
            || Ok(sleeper()),
            |pid| {
                spawned_pid.set(pid);
                Err("disk full writing agent.pid".to_string())
            },
        );
        let err = result.expect_err("the original persistence error must be returned");
        assert_eq!(
            err, "disk full writing agent.pid",
            "error must be surfaced verbatim"
        );

        let pid = spawned_pid.get();
        assert_ne!(
            pid, 0,
            "a child must actually have been spawned before persist was called"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while pid_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !pid_alive(pid),
            "spawned child must be terminated and reaped when its PID write fails"
        );
    }
}

#[cfg(all(windows, test))]
mod tests {
    use super::system32_exe;

    #[test]
    fn system_commands_are_resolved_from_system32() {
        for name in ["tasklist.exe", "taskkill.exe"] {
            let path = system32_exe(name).expect("Windows system executable must exist");
            assert_eq!(
                path.file_name().and_then(|part| part.to_str()).map(|part| part.to_ascii_lowercase()),
                Some(name.to_ascii_lowercase()),
            );
            assert_eq!(
                path.parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|part| part.to_str())
                    .map(|part| part.to_ascii_lowercase()),
                Some("system32".to_string()),
            );
        }
    }

    #[test]
    fn inherited_system_root_cannot_redirect_privileged_execution() {
        // Spoof the inherited environment: resolution must come from the OS
        // (GetSystemDirectoryW), never from SystemRoot/WINDIR, and must never
        // return a binary under the spoofed directory.
        let spoof = std::env::temp_dir().join("yaseir-system32-spoof");
        let _ = std::fs::create_dir_all(&spoof);
        let prior_root = std::env::var_os("SystemRoot");
        let prior_windir = std::env::var_os("WINDIR");
        unsafe {
            std::env::set_var("SystemRoot", &spoof);
            std::env::set_var("WINDIR", &spoof);
        }
        let resolved = system32_exe("taskkill.exe");
        match prior_root {
            Some(root) => unsafe { std::env::set_var("SystemRoot", root) },
            None => unsafe { std::env::remove_var("SystemRoot") },
        }
        match prior_windir {
            Some(windir) => unsafe { std::env::set_var("WINDIR", windir) },
            None => unsafe { std::env::remove_var("WINDIR") },
        }
        let path = resolved.expect("system resolution must not depend on inherited environment");
        assert!(
            !path.starts_with(&spoof),
            "privileged executable resolved under spoofed directory: {}",
            path.display()
        );
        assert_eq!(
            path.file_name().and_then(|part| part.to_str()).map(|part| part.to_ascii_lowercase()),
            Some("taskkill.exe".to_string()),
        );
        assert_eq!(
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|part| part.to_str())
                .map(|part| part.to_ascii_lowercase()),
            Some("system32".to_string()),
        );
    }
}

#[cfg(test)]
mod image_identity_audit_tests {
    use super::*;
    #[test]
    fn extended_paths_retain_executable_identity() {
        assert!(process_images_match(r"\\?\C:\Program Files\Yaseir\YaseirAgent.exe", r"c:\Program Files\Yaseir\YaseirAgent.exe"));
        assert!(process_images_match(r"\\?\UNC\server\share\YaseirAgent.exe", r"\\server\share\YaseirAgent.exe"));
        assert!(!process_images_match(r"C:\other\YaseirAgent.exe", r"C:\Yaseir\YaseirAgent.exe"));
        assert!(!process_images_match("طابعة مختلفة", "different"));
    }
}
