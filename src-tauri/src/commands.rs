use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

use crate::agent;
use crate::logging;
use crate::paths;

const GATEWAY_CONSOLE_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
// Five allowed4096-byte pagination headers plus envelope field names fit64KiB.
// Go json.Marshal may expand an ASCII body/header byte to a six-byte escape.
const GATEWAY_CONSOLE_MAX_ENVELOPE_BYTES: usize = 6 * (GATEWAY_CONSOLE_MAX_BODY_BYTES + 64 * 1024);
/// Execute a blocking operation (process spawn, sc.exe/tasklist, or the
/// pairing CLI's HTTP round-trip) on Tauri's blocking thread pool. Tauri runs
/// synchronous commands on the main thread, so without this every long action
/// would freeze the WebView2 UI for its entire duration.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

#[derive(Serialize)]
pub struct AgentStatus {
    pub running: bool,
    pub service: String,
    pub version: String,
    pub hostname: String,
    pub note: String,
    pub note_code: String,
}

#[cfg(windows)]
fn launch_elevated_manager() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> isize;
    }

    const SW_SHOWNORMAL: i32 = 1;
    let exe =
        std::env::current_exe().map_err(|e| format!("resolve current Manager executable: {e}"))?;
    let operation: Vec<u16> = std::ffi::OsStr::new("runas")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    // The new elevated process is allowed to wait briefly for this process to
    // release the single-instance mutex instead of immediately exiting.
    let parameters: Vec<u16> = std::ffi::OsStr::new("--elevated-relaunch")
        .encode_wide()
        .chain(Some(0))
        .collect();

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result <= 32 {
        let detail = match result {
            5 => "administrator approval was cancelled or denied",
            2 => "Manager executable was not found",
            3 => "Manager executable path was not found",
            _ => "Windows could not start the elevated Manager",
        };
        return Err(format!("{detail} (ShellExecuteW={result})"));
    }
    Ok(())
}

pub(crate) fn require_admin() -> Result<(), String> {
    if is_running_as_admin() {
        return Ok(());
    }
    Err("Administrator permission is required. Restart Yaseir Print Manager as Administrator.".into())
}

#[tauri::command]
pub fn close_app(app: tauri::AppHandle) {
    logging::info("closing desktop manager on operator request");
    app.exit(0);
}

#[tauri::command]
pub fn relaunch_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        if is_running_as_admin() {
            return Err("Yaseir Print Manager is already running as administrator".into());
        }
        launch_elevated_manager()?;
        // Close the unelevated window immediately after the elevated copy starts.
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("administrator relaunch is only available on Windows".into())
    }
}

#[tauri::command]
pub fn is_running_as_admin() -> bool {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        type HANDLE = *mut c_void;
        type BOOL = i32;
        type DWORD = u32;

        #[repr(C)]
        struct TOKEN_ELEVATION {
            token_is_elevated: DWORD,
        }

        const TOKEN_QUERY: DWORD = 0x0008;
        // TokenElevation (20) returns a TOKEN_ELEVATION struct with a
        // TokenIsElevated boolean field. TokenElevationType (18) returns
        // a non-zero enum (1=Default, 2=Full, 3=Limited) even when unelevated.
        const TOKEN_ELEVATION: DWORD = 20;

        unsafe extern "system" {
            fn GetCurrentProcess() -> HANDLE;
            fn OpenProcessToken(process: HANDLE, desired_access: DWORD, token: *mut HANDLE)
            -> BOOL;
            fn GetTokenInformation(
                token: HANDLE,
                class: DWORD,
                info: *mut c_void,
                len: DWORD,
                ret_len: *mut DWORD,
            ) -> BOOL;
            fn CloseHandle(handle: HANDLE) -> BOOL;
        }

        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION {
                token_is_elevated: 0,
            };
            let mut ret_len: DWORD = 0;
            let ok = GetTokenInformation(
                token,
                TOKEN_ELEVATION,
                &mut elevation as *mut _ as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as DWORD,
                &mut ret_len,
            );
            CloseHandle(token);
            ok != 0 && elevation.token_is_elevated != 0
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

// This is the build marker of the bundled Agent executable on disk, NOT a
// version attestation from the running Windows Service process. The Manager's
// Cargo version is intentionally never substituted for the Agent's version.
// Service/process ownership and running-state are separately evaluated by
// agent::status; a service still needs a restart after an Agent upgrade.
fn bundled_agent_build_marker(app: &tauri::AppHandle) -> String {
    static BUNDLED_AGENT_BUILD: OnceLock<String> = OnceLock::new();
    if let Some(cached) = BUNDLED_AGENT_BUILD.get() {
        return cached.clone();
    }
    let Ok(path) = agent::agent_path(app) else {
        return "unavailable".into();
    };
    let mut cmd = Command::new(path);
    cmd.arg("-version");
    let Ok(output) =
        agent::run_bounded_command(cmd, std::time::Duration::from_secs(3), 256, 256)
    else {
        return "unavailable".into();
    };
    if !output.status.success() {
        return "unavailable".into();
    }
    let Ok(marker) = std::str::from_utf8(&output.stdout) else {
        return "unavailable".into();
    };
    let marker = marker.trim();
    let resolved = if marker.len() <= 128
        && marker.starts_with("YaseirAgent go=")
        && !marker.chars().any(char::is_control)
    {
        marker.to_string()
    } else {
        "legacy / unverified".into()
    };
    let _ = BUNDLED_AGENT_BUILD.set(resolved.clone());
    resolved
}

#[tauri::command]
pub async fn get_agent_status(app: tauri::AppHandle) -> AgentStatus {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let base = AgentStatus {
        running: false,
        service: "YaseirAgent".into(),
        version: "unavailable".into(),
        hostname,
        note: String::new(),
        note_code: "not_running".into(),
    };
    // Local service/process inspection can touch Windows control-plane APIs
    // and process metadata; keep it off the UI thread for consistency with the
    // rest of the command surface.
    //
    // Only LOCAL process/service state is reported here. The agent's gateway
    // WS-connection state and last heartbeat live on the Gateway (the desktop
    // has no manager credential to query them), so they are deliberately NOT
    // included — no invented values.
    match tauri::async_runtime::spawn_blocking(move || {
        let status = agent::status(&app);
        (
            status.0,
            status.1,
            status.2,
            bundled_agent_build_marker(&app),
        )
    })
    .await
    {
        Ok((running, service_running, note, version)) => {
            let note_code = crate::agent_status::note_code(running, service_running, &note);
            AgentStatus {
                running,
                version,
                note,
                note_code: note_code.into(),
                ..base
            }
        }
        Err(e) => AgentStatus {
            note: format!("status check failed: {e}"),
            note_code: "status_check_failed".into(),
            ..base
        },
    }
}

#[tauri::command]
pub async fn start_agent(app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    run_blocking(move || agent::start(&app))
        .await
        .map(|_| "agent started".into())
}

#[tauri::command]
pub async fn stop_agent(app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    run_blocking(move || agent::stop(&app))
        .await
        .map(|_| "agent stopped".into())
}

#[tauri::command]
pub async fn restart_agent(app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    run_blocking(move || agent::restart(&app))
        .await
        .map(|_| "agent restarted".into())
}

#[tauri::command]
pub async fn control_service(action: String, app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    run_blocking(move || agent::control_service(&action, &app)).await
}

#[derive(Deserialize)]
pub struct PairArgs {
    pub code: String,
    pub gateway_url: String,
}

fn normalize_gateway_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("gateway URL cannot be empty".into());
    }
    if url.contains(char::is_whitespace) {
        return Err("gateway URL cannot contain whitespace".into());
    }
    // Match the renderer: an operator can paste a plain domain and the
    // desktop safely promotes it to HTTPS. Explicit non-HTTP schemes are
    // still rejected below.
    let candidate = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    let parsed = candidate
        .parse::<url::Url>()
        .map_err(|e| format!("invalid gateway URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err("gateway URL must use http:// or https://".into());
    }
    // Plain HTTP is accepted for any host so staging/test servers reachable
    // by IP can be paired without a TLS certificate.
    // An empty userinfo marker (https://@host) may serialize away before
    // username()/password() are inspected. Reject the original authority
    // marker like Go's url.User != nil, including empty credentials.
    if candidate.contains('@') || parsed.username() != "" || parsed.password().is_some() {
        return Err("gateway URL cannot include embedded credentials".into());
    }
    // url::Url can normalize an authority with an empty trailing port
    // (https://host:/). Go rejects this source spelling and port 0 before
    // constructing Agent endpoints. Preserve that exact origin contract.
    let raw_authority = candidate
        .split_once("://")
        .map(|(_, remainder)| remainder.split(['/', '\\', '?', '#']).next().unwrap_or(""))
        .unwrap_or("");
    if raw_authority.ends_with(':') || parsed.port() == Some(0) {
        return Err("gateway URL port must be between 1 and 65535".into());
    }
    if parsed.path() != "/" {
        return Err("gateway URL must use the origin root".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("gateway URL cannot include query strings or fragments".into());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

/// Pairing codes are generated by the gateway as 6 characters from an
/// unambiguous alphabet (no O/I, no 0/1) — mirror of the gateway contract.
fn is_valid_code(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    t.len() == 6
        && t.chars()
            .all(|c| matches!(c, 'A'..='H' | 'J'..='N' | 'P'..='Z' | '2'..='9'))
}

#[tauri::command]
pub async fn pair_agent(args: PairArgs, app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    // Cheap validation happens before dispatching to the blocking pool so the
    // UI gets immediate feedback on malformed input.
    let code = args.code.trim().to_uppercase();
    if !is_valid_code(&code) {
        return Err("pairing code must be a 6-character code from the dashboard (letters without O/I and digits without 0/1)".into());
    }
    let gateway_url = normalize_gateway_url(&args.gateway_url)?;
    run_blocking(move || run_pairing(app, &code, &gateway_url)).await
}

/// The actual pairing: invokes the bundled CLI, which performs the HTTPS
/// register call and writes the credentials to the agent config. The returned
/// stdout only contains the agent id by CLI contract — never the secret.
///
/// Pairing is serialized with runtime control: a running Agent holds its
/// initial config in memory, so without a restart the runtime keeps the OLD
/// connection while console requests use the NEW identity. After a durable
/// save the runtime is restarted when it was running, and the result reports
/// whether activation converged or the agent still needs a manual start.
fn run_pairing(app: tauri::AppHandle, code: &str, gateway_url: &str) -> Result<String, String> {
    agent::with_control(|| run_pairing_inner(app, code, gateway_url))
}

fn run_pairing_inner(
    app: tauri::AppHandle,
    code: &str,
    gateway_url: &str,
) -> Result<String, String> {
    let cli = agent::cli_path(&app)?;
    let config = paths::agent_config_path();
    paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {e}"))?;
    let was_running = agent::status(&app).0;

    logging::info(&format!("pairing agent (server={gateway_url})"));
    let mut cmd = Command::new(&cli);
    cmd.arg("-server")
        .arg(gateway_url)
        .arg("-config")
        .arg(&config)
        .env("YASEIR_AGENT_DATA_DIR", paths::agent_data_root())
        // The pairing code travels via the environment, not argv: process
        // command lines are visible to other local users, while the CLI
        // already prefers YASEIR_PAIRING_CODE over -pair for that reason.
        .env("YASEIR_PAIRING_CODE", code);
    let out = agent::run_bounded_command(
        cmd,
        std::time::Duration::from_secs(60),
        64 * 1024,
        64 * 1024,
    )?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let msg = if stderr.is_empty() { stdout } else { stderr };
        logging::error(&format!("pairing failed: {msg}"));
        return Err(msg);
    }
    // Do not echo anything that could contain the secret. Register only prints
    // the agent id and a success hint; keep that contract on the Rust side.
    logging::info(&format!("pairing succeeded: {stdout}"));
    if was_running {
        agent::restart_inner(&app).map_err(|e| {
            format!("pairing saved but the running agent could not be restarted to use it ({e}); restart the agent manually")
        })?;
        logging::info(&format!("agent restarted after pairing: {stdout}"));
        return Ok(format!("{stdout} (agent restarted with the new identity)"));
    }
    Ok(format!("{stdout} (saved; start the agent to activate)"))
}

#[derive(Serialize, Deserialize)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: String,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub headers: std::collections::BTreeMap<String, String>,
}

static GATEWAY_CONFIG_LOCK: Mutex<()> = Mutex::new(());
static GATEWAY_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn gateway_http_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = GATEWAY_HTTP_CLIENT.get() {
        return Ok(client);
    }

    // reqwest::Client owns a connection pool and is explicitly intended to be
    // reused. Rebuilding it for every 10s probe forced fresh DNS/TLS/socket
    // work and made short resolver/proxy hiccups look like Gateway outages.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("build Gateway HTTP client: {e}"))?;
    let _ = GATEWAY_HTTP_CLIENT.set(client);
    GATEWAY_HTTP_CLIENT
        .get()
        .ok_or_else(|| "Gateway HTTP client initialization failed".to_string())
}

async fn read_response_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    if let Some(len) = response.content_length()
        && len > max_bytes as u64
    {
        return Err(format!("Odoo response exceeds {} byte limit", max_bytes));
    }

    let capacity = response
        .content_length()
        .map(|n| n.min(max_bytes as u64) as usize)
        .unwrap_or(16 * 1024);
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read Odoo response: {}", gateway_http_error_detail(e)))?
    {
        if chunk.len() > max_bytes.saturating_sub(body.len()) {
            return Err(format!("Odoo response exceeds {} byte limit", max_bytes));
        }
        body.extend_from_slice(&chunk);
    }

    String::from_utf8(body).map_err(|e| format!("Odoo response was not valid UTF-8: {e}"))
}

/// Probe a candidate Gateway health endpoint without mutating the saved
/// origin or the Agent pairing identity. Settings checks connectivity before
/// saving so an unreachable typo cannot replace a valid connection.
#[tauri::command]
pub async fn probe_gateway_health(url: String) -> Result<GatewayResponse, String> {
    let base = normalize_gateway_url(&url)?;
    let origin = base
        .parse::<url::Url>()
        .map_err(|e| format!("invalid Odoo URL: {e}"))?;
    let target = origin
        .join("api/agent/probe")
        .map_err(|e| format!("invalid Odoo Agent probe URL: {e}"))?;
    if target.scheme() != origin.scheme()
        || target.host_str() != origin.host_str()
        || target.port_or_known_default() != origin.port_or_known_default()
    {
        return Err("Odoo Agent probe must stay on the candidate origin".into());
    }

    let started = std::time::Instant::now();
    logging::info(&format!("Gateway probe started origin={base}"));
    let client = gateway_http_client().map_err(|e| log_gateway_probe_error(&base, started, e))?;
    let response = client
        .get(target)
        .header("Origin", "tauri://localhost")
        .send()
        .await
        .map_err(|e| log_gateway_probe_error(&base, started, gateway_http_error_detail(e)))?;
    let status = response.status().as_u16();
    // Correlate a server response without logging bodies, cookies or headers.
    let request_id = gateway_request_id(
        response
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok()),
    );
    let body = read_response_body_limited(response, 1024 * 1024)
        .await
        .map_err(|e| log_gateway_probe_error(&base, started, e))?;
    let confirmed = (200..300).contains(&status)
        && serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .is_some_and(|value| {
                value.get("ok").and_then(|v| v.as_bool()) == Some(true)
                    && value.get("service").and_then(|v| v.as_str()).map_or(false, |s| s == "odoo-direct-print-agent" || s == "yaseir-print-gateway")
            });
    let summary = format!(
        "Odoo Agent probe completed origin={base} status={status} confirmed={confirmed} elapsed_ms={} request_id={request_id}",
        started.elapsed().as_millis(),
    );
    if confirmed {
        logging::info(&summary);
    } else {
        logging::warn(&summary);
    }
    Ok(GatewayResponse {
        status,
        body,
        headers: Default::default(),
    })
}

fn gateway_request_id(value: Option<&str>) -> String {
    value
        .unwrap_or("none")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '-' | '_' | '.' | ':'))
        .take(128)
        .collect()
}

fn gateway_http_error_detail(error: reqwest::Error) -> String {
    // reqwest's Display omits DNS/TLS/socket causes. Keep a bounded cause chain
    // and remove the request URL (other Gateway calls can contain queries).
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else {
        "transport"
    };
    let error = error.without_url();
    let mut detail = format!("{category}: {error}");
    let mut cause = std::error::Error::source(&error);
    for _ in 0..8 {
        let Some(current) = cause else {
            break;
        };
        detail.push_str(&format!(": {current}"));
        cause = current.source();
    }
    detail
        .chars()
        .filter(|c| !c.is_control())
        .take(2048)
        .collect()
}

fn log_gateway_probe_error(base: &str, started: std::time::Instant, detail: String) -> String {
    let message = format!("Odoo Agent probe failed: {detail}");
    logging::error(&format!(
        "{message} origin={base} elapsed_ms={}",
        started.elapsed().as_millis()
    ));
    message
}

#[derive(Deserialize)]
pub struct AgentGatewayRequestArgs {
    pub path: String,
    pub method: String,
    pub body: Option<String>,
    /// The Gateway origin displayed in the desktop must match the paired
    /// Agent's configured Server URL. The CLI rejects origin changes that
    /// might otherwise send actions to another Gateway without re-pairing.
    pub expected_origin: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

// This is one canonical encodeURIComponent(printerId) path segment from
// the WebView. No second decode or path normalization is permitted.
fn valid_gateway_printer_id(segment: &str) -> bool {
    if segment.is_empty() || segment.len() > 360 {
        return false;
    }
    let input = segment.as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            if i + 2 >= input.len() {
                return false;
            }
            let Ok(hex) = std::str::from_utf8(&input[i + 1..i + 3]) else {
                return false;
            };
            let Ok(byte) = u8::from_str_radix(hex, 16) else {
                return false;
            };
            decoded.push(byte);
            i += 3;
        } else {
            if !input[i].is_ascii() {
                return false;
            }
            decoded.push(input[i]);
            i += 1;
        }
    }
    let Ok(identity) = std::str::from_utf8(&decoded) else {
        return false;
    };
    if identity.is_empty()
        || identity.len() > 120
        || identity.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}') != identity
        || identity.contains("..")
        || identity.chars().any(|ch| ch.is_control() || matches!(ch, '/' | '?' | '#' | '%') || ch == char::from(92))
        || identity.chars().next().is_some_and(|ch| ch.is_ascii() && !ch.is_ascii_alphanumeric())
    {
        return false;
    }
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut canonical = String::with_capacity(segment.len());
    for byte in decoded {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'(' | b')' | 39) {
            canonical.push(char::from(byte));
        } else {
            canonical.push('%');
            canonical.push(char::from(HEX[(byte >> 4) as usize]));
            canonical.push(char::from(HEX[(byte & 15) as usize]));
        }
    }
    canonical == segment
}

fn gateway_printer_action_path(path: &str, action: &str) -> bool {
    let prefix = "/api/printers/";
    let Some(rest) = path.strip_prefix(prefix) else {
        return false;
    };
    let mut parts = rest.split('/');
    let id = parts.next().unwrap_or("");
    let selected_action = parts.next().unwrap_or("");
    parts.next().is_none() && selected_action == action && valid_gateway_printer_id(id)
}

fn valid_jobs_query(path: &str) -> bool {
    let Some((base, query)) = path.split_once('?') else {
        return path == "/api/jobs";
    };
    if base != "/api/jobs" || query.is_empty() || query.contains('#') {
        return false;
    }
    let mut keys = std::collections::BTreeSet::new();
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let Some(value) = parts.next() else {
            return false;
        };
        if key.is_empty() || value.len() > 200 || !keys.insert(key) {
            return false;
        }
        if !matches!(
            key,
            "limit" | "offset" | "status" | "search" | "q" | "printerId" | "agentId"
        ) {
            return false;
        }
        // A malformed %-escape must not be normalized or ignored while
        // the native Agent sends an authenticated Gateway request.
        let bytes = value.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (index + 2 >= bytes.len()
                    || !bytes[index + 1].is_ascii_hexdigit()
                    || !bytes[index + 2].is_ascii_hexdigit())
            {
                return false;
            }
        }
    }
    true
}

// Distinguish an overlong jobs-query value from a generic not-permitted
// path: valid_jobs_query already rejects values over 200 chars, but the
// caller previously surfaced that as "not permitted", so a long search
// failed without telling the operator the search itself was too long.
fn jobs_query_overlong_value(path: &str) -> bool {
    let Some((base, query)) = path.split_once('?') else {
        return false;
    };
    if base != "/api/jobs" {
        return false;
    }
    query.split('&').any(|pair| {
        pair.split_once('=')
            .map(|(_, value)| value.len() > 200)
            .unwrap_or(false)
    })
}

fn valid_fleet_query(path: &str) -> bool {
    let (base, query) = path.split_once('?').unwrap_or((path, ""));
    if !matches!(base, "/api/printers" | "/api/agents") {
        return false;
    }
    if !path.contains('?') {
        return true;
    }
    if query.is_empty() || query.contains('#') {
        return false;
    }
    let mut keys = std::collections::BTreeSet::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            return false;
        };
        if !matches!(
            key,
            "limit" | "offset" | "beforeCreatedAt" | "beforeId" | "beforeIdEncoded"
        ) || value.is_empty()
            || value.len() > 4096
            || !keys.insert(key)
        {
            return false;
        }
        let bytes = value.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (index + 2 >= bytes.len()
                    || !bytes[index + 1].is_ascii_hexdigit()
                    || !bytes[index + 2].is_ascii_hexdigit())
            {
                return false;
            }
        }
    }
    true
}

fn allowed_agent_gateway_path(path: &str, method: &str) -> bool {
    let method = method.to_ascii_uppercase();
    match method.as_str() {
        // Deliberately narrower than the Go CLI allowlist
        // (gatewayAgentPathRe also permits /api/agents/<id>): the desktop
        // console proxy exposes only the agent list, while the operator CLI
        // needs single-agent fetch for diagnostics. Both are read-only.
        "GET" => valid_fleet_query(path) || valid_jobs_query(path),
        "POST" => {
            path == "/api/printers"
                || gateway_printer_action_path(path, "test-connection")
                || gateway_printer_action_path(path, "test-print")
        }
        // Other PATCH/DELETE and arbitrary control-plane mutations remain denied.
        // The explicitly allowlisted test-print is authenticated and fenced
        // to this Agent's own printer by the Gateway API.
        _ => false,
    }
}

// Validate the route part independently of safe Jobs-search/Fleet cursor
// values; the allowlisted path and parameter names are validated below.
fn unsafe_gateway_route_path(path: &str) -> bool {
    let route = path.split_once('?').map(|(route, _)| route).unwrap_or(path);
    route.contains("..") || path.contains('\\')
}

#[tauri::command]
pub async fn gateway_agent_request(
    args: AgentGatewayRequestArgs,
    app: tauri::AppHandle,
) -> Result<String, String> {
    require_admin()?;
    let path = args.path.trim().to_string();
    let method = args.method.trim().to_ascii_uppercase();
    if !path.starts_with("/api/") || unsafe_gateway_route_path(&path) {
        return Err("gateway request path must be an API-relative path".into());
    }
    if method == "GET" && jobs_query_overlong_value(&path) {
        return Err("gateway jobs query value exceeds the 200-character limit; shorten the search".into());
    }
    if !allowed_agent_gateway_path(&path, &method) {
        return Err("gateway request is not permitted for the desktop Agent console".into());
    }
    if args
        .body
        .as_ref()
        .map(|b| b.len() > GATEWAY_CONSOLE_MAX_BODY_BYTES)
        .unwrap_or(false)
    {
        return Err("gateway request body exceeds 8 MiB".into());
    }
    // Credentials and privileged headers are never accepted from the WebView.
    // Only a bounded retry key may reach the paired CLI for a test-print.
    if let Some(key) = args.idempotency_key.as_deref() {
        if !gateway_printer_action_path(&path, "test-print")
            || !(8..=128).contains(&key.len())
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        {
            return Err("invalid printer diagnostic idempotency key".into());
        }
    } else if gateway_printer_action_path(&path, "test-print") {
        return Err("printer test-print requires an idempotency key".into());
    }
    let expected_origin = normalize_gateway_url(&args.expected_origin)
        .map_err(|e| format!("invalid expected Gateway origin: {e}"))?;
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let mut request_cmd = std::process::Command::new(&cli);
        request_cmd
            .arg("gateway-request")
            .arg("-method")
            .arg(&method)
            .arg("-path")
            .arg(&path)
            .arg("-expect-origin")
            .arg(&expected_origin)
            .arg("-config")
            .arg(&config)
            .env("YASEIR_AGENT_DATA_DIR", &root);
        // Windows command lines are limited to32767 UTF-16 characters. Keep
        // the unchanged8MiB body gate, but send bytes through owned stdin.
        let input = args.body.map(|body| {
            request_cmd.arg("-body-stdin");
            body.into_bytes()
        });
        if let Some(key) = args.idempotency_key {
            // Like the pairing code, a retry key must not travel on argv
            // where other local users can read the process command line.
            request_cmd.env("YASEIR_IDEMPOTENCY_KEY", key);
        }
        // The CLI independently bounds the HTTP body to8MiB. JSON string/HTML
        // escaping can expand one input byte to6 bytes; include bounded header
        // metadata/envelope overhead without changing any API or helper limit.
        let max_stdout = GATEWAY_CONSOLE_MAX_ENVELOPE_BYTES;
        let out = agent::run_bounded_command_with_input(
            request_cmd,
            input,
            std::time::Duration::from_secs(20),
            max_stdout,
            64 * 1024,
        )?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            let msg = if stderr.is_empty() { stdout } else { stderr };
            return Err(msg);
        }
        // gateway-request returns a JSON {status, body, headers?} envelope for every
        // HTTP response, including application errors. Keep the actual status
        // visible to the desktop instead of manufacturing HTTP 200.
        let mut response: GatewayResponse = serde_json::from_str(&stdout)
            .map_err(|e| format!("invalid agent Odoo response envelope: {e}"))?;
        response.headers.retain(|key, _| {
            matches!(
                key.as_str(),
                "x-has-more"
                    | "x-next-before-created-at"
                    | "x-next-before-id-encoded"
                    | "x-next-before-id"
                    | "x-next-cursor"
            )
        });
        serde_json::to_string(&response)
            .map_err(|e| format!("serialize agent Odoo response: {e}"))
    })
    .await
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GatewayConfig {
    pub url: String,
}

fn read_file_or_default(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(format!("failed to read settings {}: {e}", path.display())),
    }
}

#[cfg(windows)]
fn atomic_replace_file(temp_path: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let from: Vec<u16> = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(format!(
            "replace settings {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(temp_path: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(temp_path, destination)
        .map_err(|e| format!("replace settings {}: {e}", destination.display()))?;
    if let Some(parent) = destination.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        dir.sync_all()
            .map_err(|e| format!("sync settings directory {}: {e}", parent.display()))?;
    }
    Ok(())
}

fn atomic_write_settings(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("settings path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create settings dir {}: {e}", parent.display()))?;
    paths::ensure_manager_directory_security(parent)
        .map_err(|e| format!("secure settings dir {}: {e}", parent.display()))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.json");
    let mut last_collision = None;
    for attempt in 0..16u32 {
        let temp_path = parent.join(format!(".{file_name}.tmp-{}-{attempt}", std::process::id()));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_collision = Some(e);
                continue;
            }
            Err(e) => return Err(format!("create settings temp {}: {e}", temp_path.display())),
        };

        let write_result = (|| -> Result<(), String> {
            file.write_all(contents)
                .map_err(|e| format!("write settings temp {}: {e}", temp_path.display()))?;
            file.sync_all()
                .map_err(|e| format!("sync settings temp {}: {e}", temp_path.display()))?;
            drop(file);
            paths::ensure_manager_file_security(&temp_path)
                .map_err(|e| format!("secure settings temp {}: {e}", temp_path.display()))?;
            atomic_replace_file(&temp_path, path)
        })();
        if write_result.is_err() {
            let _ = std::fs::remove_file(&temp_path);
        }
        return write_result;
    }

    Err(format!(
        "create settings temp in {}: {}",
        parent.display(),
        last_collision
            .map(|e| e.to_string())
            .unwrap_or_else(|| "temporary file collision".into())
    ))
}

fn read_gateway_config_sync() -> Result<GatewayConfig, String> {
    let root = paths::ensure_manager_data_root().map_err(|e| {
        let message = format!("manager data directory is not secure or accessible: {e}");
        logging::error(&message);
        message
    })?;
    let path = root.join("settings.json");
    if path.exists() {
        paths::ensure_manager_file_security(&path).map_err(|e| {
            let message = format!("manager settings file is not secure: {e}");
            logging::error(&message);
            message
        })?;
    }
    let raw = read_file_or_default(&path).inspect_err(|e| logging::error(e))?;
    if raw.trim() == "{}" {
        return Ok(GatewayConfig { url: String::new() });
    }
    serde_json::from_str::<GatewayConfig>(&raw).map_err(|e| {
        let message = format!("settings file is invalid JSON at {}: {e}", path.display());
        logging::error(&message);
        message
    })
}

#[tauri::command]
pub async fn get_gateway_config() -> Result<GatewayConfig, String> {
    run_blocking(read_gateway_config_sync).await
}

#[tauri::command]
pub async fn set_gateway_config(url: String, app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    let url = normalize_gateway_url(&url)?;
    run_blocking(move || {
        let state = GATEWAY_CONFIG_LOCK
            .lock()
            .map_err(|_| "gateway config lock poisoned")?;
        // A corrupt or inaccessible existing origin must not be treated as an unset origin.
        let previous = read_gateway_config_sync()?.url;
        let root = paths::ensure_manager_data_root()
            .map_err(|e| format!("manager data directory is not secure or accessible: {e}"))?;
        let path = root.join("settings.json");
        let cfg = GatewayConfig { url: url.clone() };
        let json =
            serde_json::to_string_pretty(&cfg).map_err(|e| format!("serialize settings: {e}"))?;
        atomic_write_settings(&path, json.as_bytes())?;
        paths::ensure_manager_file_security(&path)
            .map_err(|e| format!("secure manager settings file after save: {e}"))?;
        logging::info(&format!("gateway settings saved to {}", path.display()));
        if previous != url {
            drop(state);
            app.emit("gateway:config_changed", &url)
                .map_err(|e| format!("Gateway saved but change notification failed: {e}"))?;
        }
        Ok(format!("saved gateway settings to {}", path.display()))
    })
    .await
}

#[derive(Serialize)]
pub struct RuntimePaths {
    pub manager_data: String,
    pub settings: String,
    pub agent_config: String,
    pub manager_log: String,
    pub agent_data: String,
}

#[tauri::command]
pub async fn get_runtime_paths() -> Result<RuntimePaths, String> {
    run_blocking(|| {
        Ok(RuntimePaths {
            manager_data: paths::manager_data_root().display().to_string(),
            settings: paths::settings_path().display().to_string(),
            agent_config: paths::agent_config_path().display().to_string(),
            manager_log: paths::manager_log_path().display().to_string(),
            agent_data: paths::agent_data_root().display().to_string(),
        })
    })
    .await
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrinterInfo {
    #[serde(rename = "agentId", alias = "agent_id")]
    pub agent_id: Option<String>,
    pub id: String,
    pub name: String,
    #[serde(rename = "displayName", alias = "display_name")]
    pub display_name: Option<String>,
    #[serde(rename = "printerType", alias = "printer_type")]
    pub printer_type: Option<String>,
    #[serde(rename = "connectionType", alias = "connection_type")]
    pub connection_type: Option<String>,
    pub protocol: Option<String>,
    pub endpoint: Option<String>,
    #[serde(rename = "spoolerName", alias = "spooler_name")]
    pub spooler_name: Option<String>,
    #[serde(rename = "networkAddress", alias = "network_address")]
    pub network_address: Option<String>,
    pub port: Option<i32>,
    pub status: String,
    pub enabled: bool,
    #[serde(
        rename = "availableToOdoo",
        default = "default_printer_gateway_sharing"
    )]
    pub available_to_odoo: bool,
    #[serde(rename = "isVirtual", alias = "is_virtual")]
    pub is_virtual: Option<bool>,
    #[serde(rename = "usbVid")]
    pub usb_vid: Option<String>,
    #[serde(rename = "usbPid")]
    pub usb_pid: Option<String>,
    #[serde(rename = "usbSerial")]
    pub usb_serial: Option<String>,
    pub capabilities: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct DiscoverResult {
    pub printers: Vec<PrinterInfo>,
    pub errors: Vec<String>,
}

fn default_printer_gateway_sharing() -> bool {
    true
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrinterVisibilityReply {
    pub printer_id: String,
    pub available_to_odoo: bool,
}

fn validate_local_printer_id(raw: &str) -> Result<String, String> {
    let id = raw;
    if id.is_empty()
        || id.trim() != id
        || id.len() > 256
        || id.starts_with('-')
        || id.chars().any(|ch| ch.is_control() || ch == '\u{feff}')
    {
        return Err("invalid local printer id".into());
    }
    Ok(id.to_string())
}

/// Preserve the caller-selected opaque local printer ID exactly. An invalid
/// padded or option-shaped ID cannot silently redirect a physical test print.
fn build_local_printer_test_command(
    cli: &std::path::Path,
    config: &std::path::Path,
    root: &std::path::Path,
    raw_id: &str,
) -> Result<std::process::Command, String> {
    let id = validate_local_printer_id(raw_id)?;
    let mut command = std::process::Command::new(cli);
    command
        .arg("printers")
        .arg("test")
        .arg(id)
        .arg("-config")
        .arg(config)
        .env("YASEIR_AGENT_DATA_DIR", root);
    Ok(command)
}

fn decode_printer_visibility_reply(
    stdout: &[u8],
    id: &str,
    shared: bool,
) -> Result<PrinterVisibilityReply, String> {
    let reply: PrinterVisibilityReply = serde_json::from_slice(stdout)
        .map_err(|_| "invalid local printer sharing acknowledgment".to_string())?;
    if reply.printer_id != id || reply.available_to_odoo != shared {
        return Err("local printer sharing acknowledgment did not match the request".into());
    }
    Ok(reply)
}

#[tauri::command]
pub async fn set_printer_visibility(
    app: tauri::AppHandle,
    printer_id: String,
    available_to_odoo: bool,
) -> Result<PrinterVisibilityReply, String> {
    if !is_running_as_admin() {
        return Err("Administrator privileges are required to change local printer sharing".into());
    }
    let id = validate_local_printer_id(&printer_id)?;
    run_blocking(move || {
        let mut cmd = Command::new(agent::cli_path(&app)?);
        cmd.arg("printers-share")
            .arg("--id")
            .arg(&id)
            .arg("--shared")
            .arg(if available_to_odoo { "true" } else { "false" })
            .arg("-config")
            .arg(paths::agent_config_path())
            .env("YASEIR_AGENT_DATA_DIR", paths::agent_data_root());
        // Go JSON can escape each byte of the validated256-byte ID sixfold.
        let output =
            agent::run_bounded_command(cmd, std::time::Duration::from_secs(15), 2048, 8192)?;
        if !output.status.success() {
            return Err(format!(
                "Local printer sharing: {}",
                String::from_utf8_lossy(&output.stderr)
                    .trim()
                    .chars()
                    .take(480)
                    .collect::<String>()
            ));
        }
        decode_printer_visibility_reply(&output.stdout, &id, available_to_odoo)
    })
    .await
}

/// Unusable virtual / fax / RDP-redirected queue detection — desktop safety net.
///
/// Printable virtual printers (Microsoft Print to PDF, XPS Document Writer,
/// CUPS-PDF, Print to File, etc.) are first-class managed printers matching
/// the Go agent (`agent/internal/printer/classify_device.go`) and Desktop UI
/// (`src/lib/printer-virtual.ts`). Only truly non-printable stubs (blackhole
/// ports, fax queues, session-redirected queues) are excluded here.
const UNUSABLE_PORT_MONITORS: &[&str] = &[
    "nul:",
    "null:",
    "shrfax:", // Windows Shared Fax
    "fax:",
    "brfax:", // Brother vendor software fax monitor
];

/// Fax-only software writer tokens that cannot print documents.
const UNUSABLE_WRITER_TOKENS: &[&str] = &[
    "microsoft shared fax",
    "pc-fax",
    "pc fax",
    "pcfax",
    "fax v.",
    "fax driver",
];

/// Queues tunnelled from another desktop session. Mirrors the agent's
/// `sessionRedirectTokens`.
const SESSION_REDIRECT_TOKENS: &[&str] = &[
    "remote desktop easy print",
    "terminal services easy print",
    "ts easy print",
    "easy print",
    "citrix",
    "vmware virtual print",
    "vmware universal printer",
    "thinprint",
    "safeguard print",
];

fn is_terminal_services_port(head: &str) -> bool {
    head.strip_prefix("ts")
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn is_unusable_virtual_printer_for_ui(p: &PrinterInfo) -> bool {
    if let Some(t) = p.printer_type.as_ref()
        && t.trim().eq_ignore_ascii_case("redirected")
    {
        return true;
    }

    let caps = p.capabilities.as_ref();
    if let Some(caps) = caps {
        for key in ["virtual_test_sink", "virtual_spooler_test"].iter() {
            if caps.get(*key).is_some() {
                return true;
            }
        }
        let class = caps
            .get("printer_class")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        if class == "redirected" {
            return true;
        }
        // Port monitor. "IP_192.168.1.50,SNMP" -> "ip_192.168.1.50".
        if let Some(port) = caps.get("port_name").and_then(|v| v.as_str()) {
            let lowered = port.to_lowercase();
            let head = lowered.split(',').next().unwrap_or("").trim();
            if UNUSABLE_PORT_MONITORS
                .iter()
                .any(|m| head == *m || head.starts_with(m))
                || is_terminal_services_port(head)
            {
                return true;
            }
        }
    }

    let name_lower = p.name.trim().to_lowercase();
    // Windows: "HP LaserJet (redirected 3)". Citrix: "… (from WKS12) in session 4".
    if name_lower.contains("(redirected")
        || name_lower.ends_with("redirected)")
        || name_lower.contains(" in session ")
        || name_lower.ends_with(" in session")
        || name_lower == "fax"
        || name_lower.ends_with(" fax")
        || name_lower.ends_with("-fax")
        || name_lower.ends_with(" (fax)")
    {
        return true;
    }

    // The driver, the comment and the PnP ids identify fax or session tunnels
    // far more reliably than the display name does.
    let mut hay = String::new();
    if let Some(caps) = caps {
        for key in ["driver_name", "comment", "device_id"].iter() {
            if let Some(v) = caps.get(*key).and_then(|v| v.as_str()) {
                hay.push(' ');
                hay.push_str(&v.to_lowercase());
            }
        }
        for key in ["hardware_ids", "compatible_ids"].iter() {
            if let Some(list) = caps.get(*key).and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(v) = item.as_str() {
                        hay.push(' ');
                        hay.push_str(&v.to_lowercase());
                    }
                }
            }
        }
    }
    hay.push(' ');
    hay.push_str(&name_lower);

    if UNUSABLE_WRITER_TOKENS.iter().any(|t| hay.contains(t)) {
        return true;
    }
    SESSION_REDIRECT_TOKENS.iter().any(|t| hay.contains(t))
}

fn is_valid_printer_for_ui(p: &PrinterInfo) -> bool {
    // Only unusable stubs (fax, blackhole/nul:, session-redirected) are excluded;
    // printable virtual printers (PDF/XPS) remain first-class managed printers.
    if is_unusable_virtual_printer_for_ui(p) {
        return false;
    }
    let name_lower = p.name.to_lowercase();
    let driver_lower = p
        .capabilities
        .as_ref()
        .and_then(|v| v.get("driver_name").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_lowercase();
    let combined = format!("{} {}", name_lower, driver_lower);
    let generic = [
        "usb input device",
        "usb composite device",
        "hid-compliant",
        "hid compliant",
        "standard system devices",
        "standard usb host controller",
        "intel(r) wireless bluetooth",
        "wireless bluetooth",
        "bluetooth adapter",
        "fingerprint sensor",
        "touch fingerprint",
        "synaptics",
        "vfs7552",
        "hd camera",
        "hp hd camera",
        "camera",
        "usb hub",
        "generic usb hub",
    ];
    for g in generic {
        if combined.contains(g) {
            // Allow if driver explicitly says printer (check "printer" not "print" to avoid fingerprint)
            if driver_lower.contains("printer")
                || driver_lower.contains("laser")
                || driver_lower.contains("inkjet")
                || driver_lower.contains("thermal")
                || driver_lower.contains("label")
                || driver_lower.contains("zebra")
            {
                continue;
            }
            return false;
        }
    }
    true
}

#[tauri::command]
pub async fn get_printers(app: tauri::AppHandle) -> Result<Vec<PrinterInfo>, String> {
    run_blocking(move || {
        // The registry is durable configuration, not a live Windows observation.
        let mut cmd = Command::new(agent::cli_path(&app)?);
        cmd.arg("printers")
            .arg("list")
            .arg("--json")
            .arg("-config")
            .arg(paths::agent_config_path())
            .env("YASEIR_AGENT_DATA_DIR", paths::agent_data_root());
        let output = agent::run_bounded_command(
            cmd,
            std::time::Duration::from_secs(30),
            512 * 1024,
            64 * 1024,
        )?;
        if !output.status.success() {
            return Err(format!(
                "Local printer inventory: {}",
                String::from_utf8_lossy(&output.stderr)
                    .trim()
                    .chars()
                    .take(480)
                    .collect::<String>()
            ));
        }
        let v: Vec<PrinterInfo> = serde_json::from_slice(&output.stdout)
            .map_err(|_| "invalid local printer inventory response".to_string())?;
        let filtered: Vec<PrinterInfo> = v.into_iter().filter(is_valid_printer_for_ui).collect();
        Ok(filtered)
    })
    .await
}

#[tauri::command]
pub async fn discover_printers(app: tauri::AppHandle) -> Result<DiscoverResult, String> {
    require_admin()?;
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let _ =
            paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {}", e))?;
        let mut discover_cmd = std::process::Command::new(&cli);
        discover_cmd
            .arg("printers")
            .arg("discover")
            .arg("--json")
            .arg("-config")
            .arg(&config)
            .env("YASEIR_AGENT_DATA_DIR", &root);
        let out = agent::run_bounded_command(
            discover_cmd,
            std::time::Duration::from_secs(30),
            512 * 1024,
            64 * 1024,
        )?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        if !out.status.success() {
            let msg = if stderr.trim().is_empty() {
                stdout.clone()
            } else {
                stderr.clone()
            };
            return Err(format!("discover failed: {}", msg));
        }
        let errors = parse_discovery_diagnostics(&stderr);
        // Retain source-level diagnostics in the protected Manager log rather
        // than raising non-actionable warning banners in the customer UI.
        for diagnostic in &errors {
            logging::warn(&format!(
                "printer discovery source: {}",
                diagnostic.chars().take(400).collect::<String>()
            ));
        }
        // --json returns this scan's inventory. Registry persistence can fail;
        // rereading the file would silently substitute stale or empty results.
        let printers = parse_discovery_stdout(&stdout)?;
        Ok(DiscoverResult { printers, errors })
    })
    .await
}

fn parse_discovery_diagnostics(stderr: &str) -> Vec<String> {
    let mut diagnostics = Vec::new();
    for raw in stderr.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let actionable = ["Failed to persist discovery:", "Discovery warning:"]
            .iter()
            .find_map(|marker| {
                line.find(marker)
                    .map(|index| line[index..].trim().to_string())
            });
        if let Some(message) = actionable
            && !diagnostics.iter().any(|existing| existing == &message)
        {
            diagnostics.push(message);
        }
    }
    diagnostics
}

fn parse_discovery_stdout(stdout: &str) -> Result<Vec<PrinterInfo>, String> {
    // Older CLI builds encoded an empty slice as null. Accept that legacy
    // representation, but reject corrupt/non-JSON output rather than showing
    // an unrelated on-disk inventory as a successful discovery.
    let printers: Option<Vec<PrinterInfo>> =
        serde_json::from_str(stdout).map_err(|e| format!("parse discovery JSON: {e}"))?;
    // The desktop neither enumerates nor exposes software writers. A stale
    // CLI can still return them, so retain this independent fail-closed guard.
    Ok(printers
        .unwrap_or_default()
        .into_iter()
        .filter(is_valid_printer_for_ui)
        .collect())
}

#[cfg(test)]
#[path = "audit_discovery_test.rs"]
mod audit_discovery_test;

#[tauri::command]
pub async fn test_printer(printer_id: String, app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    // No .trim(): printer IDs are exact execution targets. Reject padded,
    // option-shaped, control-character and overlong IDs before invoking CLI.
    let pid = validate_local_printer_id(&printer_id)?;
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let test_cmd = build_local_printer_test_command(&cli, &config, &root, &pid)?;
        let out = agent::run_bounded_command(
            test_cmd,
            // Allow the Agent's 120s document budget plus startup/cleanup.
            std::time::Duration::from_secs(150),
            64 * 1024,
            64 * 1024,
        )
        .map_err(|error| format!("Local print test did not return a confirmed result; check the printer before repeating: {error}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            let msg = if stderr.is_empty() { stdout } else { stderr };
            return Err(msg);
        }
        Ok(stdout)
    })
    .await
}

#[derive(Deserialize, Debug)]
pub struct RegisterPrinterRequest {
    pub name: String,
    #[serde(rename = "connectionType")]
    pub connection_type: String,
    #[serde(rename = "connection_type")]
    pub connection_type_alt: Option<String>,
    pub endpoint: Option<String>,
    #[serde(rename = "spoolerName")]
    pub spooler_name: Option<String>,
    pub protocol: Option<String>,
    #[serde(rename = "printerType")]
    pub printer_type: Option<String>,
    #[serde(rename = "usbVid")]
    pub usb_vid: Option<String>,
    #[serde(rename = "usbPid")]
    pub usb_pid: Option<String>,
    #[serde(rename = "usbSerial")]
    pub usb_serial: Option<String>,
}

#[tauri::command]
pub async fn register_printer(
    request: RegisterPrinterRequest,
    app: tauri::AppHandle,
) -> Result<String, String> {
    require_admin()?;
    // A value starting with `-` would be parsed by the Go CLI as a FLAG, not
    // a value (no shell is involved, so this is argument smuggling, not
    // injection): reject leading-dash values at the trust boundary.
    // Caps are deliberately generous, not Gateway field limits (which are
    // not in this contract): no legitimate Windows spooler name (<=220
    // chars), IPP endpoint, or USB serial approaches them, but an unbounded
    // value can no longer fail opaquely at CLI spawn or persist an
    // unbounded registry row.
    fn arg_value(name: &str, raw: &str) -> Result<String, String> {
        arg_value_max(name, raw, 2048)
    }
    fn arg_value_max(name: &str, raw: &str, max: usize) -> Result<String, String> {
        let v = raw.trim().to_string();
        if v.is_empty() {
            return Err(format!("{name} must not be empty"));
        }
        if v.starts_with('-') {
            return Err(format!("{name} must not start with '-'"));
        }
        if v.chars().any(|ch| ch.is_control() || ch == '\u{feff}') {
            return Err(format!("{name} must not contain control characters"));
        }
        if v.len() > max {
            return Err(format!("{name} exceeds the {max}-character limit"));
        }
        Ok(v)
    }
    let name = arg_value_max("printer name", &request.name, 512)?;
    let conn = request
        .connection_type_alt
        .clone()
        .unwrap_or(request.connection_type.clone());
    let conn_lower = conn.trim().to_lowercase();
    let valid_conns = ["spooler", "network", "tcp", "usb", "ipp", "ipps"];
    if !valid_conns.contains(&conn_lower.as_str()) {
        // List the ACTUALLY accepted types — the old message dropped the
        // valid tcp/ipps options (audit #21).
        return Err("connection type must be spooler, network, tcp, usb, ipp, or ipps".into());
    }
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let mut cmd = std::process::Command::new(&cli);
        cmd.arg("printers")
            .arg("add")
            .arg("--name")
            .arg(&name)
            .arg("--type")
            .arg(&conn_lower);
        if let Some(ep) = request.endpoint.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--endpoint").arg(arg_value("endpoint", ep)?);
        }
        if let Some(sn) = request
            .spooler_name
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            cmd.arg("--spooler-name")
                .arg(arg_value_max("spooler name", sn, 512)?);
        }
        if let Some(proto) = request.protocol.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--protocol")
                .arg(arg_value_max("protocol", proto, 64)?.to_lowercase());
        }
        if let Some(pt) = request
            .printer_type
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            cmd.arg("--printer-type")
                .arg(arg_value_max("printer type", pt, 128)?.to_lowercase());
        }
        if let Some(vid) = request.usb_vid.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--vid").arg(arg_value_max("USB VID", vid, 64)?);
        }
        if let Some(pid) = request.usb_pid.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--pid").arg(arg_value_max("USB PID", pid, 64)?);
        }
        if let Some(serial) = request.usb_serial.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--serial").arg(arg_value_max("USB serial", serial, 1024)?);
        }
        cmd.arg("-config").arg(&config);
        cmd.env("YASEIR_AGENT_DATA_DIR", &root);
        let out = agent::run_bounded_command(
            cmd,
            std::time::Duration::from_secs(30),
            64 * 1024,
            64 * 1024,
        )?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            let msg = if stderr.is_empty() { stdout } else { stderr };
            return Err(msg);
        }
        if stdout.is_empty() {
            Ok(format!("Printer '{}' added", name))
        } else {
            Ok(stdout)
        }
    })
    .await
}

#[derive(Serialize, Clone)]
pub struct AutostartStatus {
    pub enabled: bool,
}

#[tauri::command]
pub async fn get_autostart(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    run_blocking(move || {
        #[cfg(windows)]
        {
            use tauri_plugin_autostart::ManagerExt;
            let enabled = app
                .autolaunch()
                .is_enabled()
                .map_err(|e| format!("read autostart: {e}"))?;
            Ok(AutostartStatus { enabled })
        }
        #[cfg(not(windows))]
        {
            let _ = &app;
            Ok(AutostartStatus { enabled: false })
        }
    })
    .await
}

/// Record that the user has explicitly chosen an autostart state, so the
/// first-launch default (main.rs) never overrides it again. MUST fail loudly
/// when the record cannot be persisted: a silently swallowed write failure
/// would make the next launch treat the user as "never chose" and re-apply
/// the default-enable - silently reversing an explicit DISABLE.
#[cfg(any(windows, test))]
fn record_autostart_choice(marker: &Path) -> Result<(), String> {
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create marker dir {}: {e}", parent.display()))?;
    }
    std::fs::write(marker, "1").map_err(|e| format!("write marker {}: {e}", marker.display()))
}

/// Apply an explicit user autostart choice so the OS registry state and the
/// durable choice marker can never silently diverge: without the marker, the
/// next launch treats this machine as "never chose" and re-applies the
/// first-launch default-enable — silently reversing an explicit DISABLE.
///
/// Order: OS change first, marker second; if persisting the marker fails,
/// the OS change is rolled back to the pre-attempt state before the error
/// surfaces. No silent divergence, no false success, and no claim of true
/// atomicity: a rollback that itself fails is reported with both errors so
/// the operator knows the machine needs manual reconciliation.
#[cfg(any(windows, test))]
fn apply_autostart_choice(
    enabled: bool,
    previous: bool,
    mut set_os: impl FnMut(bool) -> Result<(), String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<String, String> {
    set_os(enabled)?;
    let state = if enabled {
        "autostart enabled"
    } else {
        "autostart disabled"
    };
    if let Err(persist_err) = persist() {
        return Err(match set_os(previous) {
            Ok(()) => format!(
                "{state} applied, but the user-choice record could not be persisted ({persist_err}); \
                 the OS change was reverted so a later start cannot silently override it - retry from Settings"
            ),
            Err(rollback_err) => format!(
                "{state} applied, but the user-choice record could not be persisted ({persist_err}) \
                 and reverting the OS change also failed ({rollback_err}); restart the app and retry from Settings"
            ),
        });
    }
    Ok(state.to_string())
}

#[tauri::command]
pub async fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<String, String> {
    require_admin()?;
    run_blocking(move || {
        #[cfg(windows)]
        {
            use tauri_plugin_autostart::ManagerExt;
            // Record that the user has explicitly chosen autostart so the
            // app never re-enables it on a later start (see setup in main.rs).
            let touched = paths::autostart_choice_path()?;
            let previous = app
                .autolaunch()
                .is_enabled()
                .map_err(|e| format!("read autostart: {e}"))?;
            apply_autostart_choice(
                enabled,
                previous,
                |on| {
                    if on {
                        app.autolaunch()
                            .enable()
                            .map_err(|e| format!("enable autostart: {}", e))
                    } else {
                        app.autolaunch()
                            .disable()
                            .map_err(|e| format!("disable autostart: {}", e))
                    }
                },
                || record_autostart_choice(&touched),
            )
        }
        #[cfg(not(windows))]
        {
            let _ = (&app, enabled);
            Err("autostart only available on Windows".into())
        }
    })
    .await
}

#[cfg(test)]
mod autostart_choice_tests {
    use super::{apply_autostart_choice, record_autostart_choice};

    #[test]
    fn apply_enable_success_persists_and_reports_enabled() {
        let mut os_calls: Vec<bool> = Vec::new();
        let res = apply_autostart_choice(
            true,
            false,
            |on| {
                os_calls.push(on);
                Ok(())
            },
            || Ok(()),
        );
        assert_eq!(res, Ok("autostart enabled".to_string()));
        assert_eq!(os_calls, vec![true]);
    }

    #[test]
    fn apply_disable_success_persists_and_reports_disabled() {
        let mut os_calls: Vec<bool> = Vec::new();
        let res = apply_autostart_choice(
            false,
            true,
            |on| {
                os_calls.push(on);
                Ok(())
            },
            || Ok(()),
        );
        assert_eq!(res, Ok("autostart disabled".to_string()));
        assert_eq!(os_calls, vec![false]);
    }

    #[test]
    fn os_failure_aborts_before_any_persistence() {
        let mut persist_called = false;
        let res = apply_autostart_choice(
            true,
            false,
            |_| Err("registry denied".to_string()),
            || {
                persist_called = true;
                Ok(())
            },
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("registry denied"));
        assert!(
            !persist_called,
            "a failed OS change must not attempt marker persistence"
        );
    }

    #[test]
    fn marker_failure_rolls_back_the_os_change_and_errors() {
        // THE invariant: an explicit DISABLE whose marker cannot be recorded
        // must revert the OS change, otherwise the next launch (no marker)
        // would silently re-apply the first-launch default-enable.
        let mut os_calls: Vec<bool> = Vec::new();
        let res = apply_autostart_choice(
            false,
            true,
            |on| {
                os_calls.push(on);
                Ok(())
            },
            || Err("disk full writing marker".to_string()),
        );
        let err = res.expect_err("divergence must surface, never succeed silently");
        assert!(
            err.contains("disk full writing marker"),
            "original persistence error must survive: {err}"
        );
        assert!(
            err.contains("reverted"),
            "message must state the rollback: {err}"
        );
        assert_eq!(
            os_calls,
            vec![false, true],
            "OS change must be rolled back exactly once"
        );
    }

    #[test]
    fn marker_failure_restores_idempotent_requests_to_the_actual_previous_state() {
        for enabled in [true, false] {
            let mut calls = Vec::new();
            let result = apply_autostart_choice(
                enabled,
                enabled,
                |on| {
                    calls.push(on);
                    Ok(())
                },
                || Err("disk full".into()),
            );
            assert!(result.is_err());
            assert_eq!(calls, vec![enabled, enabled]);
        }
    }

    #[test]
    fn rollback_failure_reports_both_errors() {
        // Best-effort rollback that itself fails: both failures must be
        // visible so the divergence can be reconciled manually.
        let mut calls = 0;
        let res = apply_autostart_choice(
            true,
            false,
            |_| {
                calls += 1;
                if calls == 1 {
                    Ok(())
                } else {
                    Err("rollback denied".to_string())
                }
            },
            || Err("disk full writing marker".to_string()),
        );
        let err = res.expect_err("must still report failure");
        assert!(
            err.contains("disk full writing marker"),
            "persist error: {err}"
        );
        assert!(err.contains("rollback denied"), "rollback error: {err}");
    }

    #[test]
    fn successful_choice_record_persists_the_marker() {
        let dir = std::env::temp_dir().join(format!("odoo-choice-ok-{}", std::process::id()));
        let marker = dir.join("nested").join("autostart-user-choice");
        let _ = std::fs::remove_dir_all(&dir);
        record_autostart_choice(&marker).expect("marker must persist");
        assert!(
            marker.exists(),
            "explicit user choice must be durably recorded"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persistence_failure_is_propagated_not_swallowed() {
        // THE regression: the command previously did `let _ = fs::write(...)`
        // - a failed choice record silently left the next launch to re-apply
        // the default-enable, reversing an explicit user DISABLE. Here the
        // marker path is a DIRECTORY, so any write to it must fail loudly.
        let dir = std::env::temp_dir().join(format!("odoo-choice-fail-{}", std::process::id()));
        let marker = dir.join("autostart-user-choice");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&marker).unwrap();
        let err = record_autostart_choice(&marker)
            .expect_err("write onto a directory must surface an error");
        assert!(
            err.contains("write marker"),
            "error must identify the failed persistence: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod agent_console_path_tests {
    use super::{
        allowed_agent_gateway_path, gateway_printer_action_path, valid_fleet_query,
        valid_jobs_query, unsafe_gateway_route_path,
    };

    #[test]
    fn fleet_pagination_is_read_only_and_bounded() {
        assert!(allowed_agent_gateway_path(
            "/api/printers?limit=100&beforeCreatedAt=2026-10-13T00%3A00%3A00Z&beforeIdEncoded=cDE",
            "GET"
        ));
        assert!(allowed_agent_gateway_path(
            "/api/agents?beforeId=a1&beforeCreatedAt=2026-10-13",
            "GET"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/printers?limit=100",
            "POST"
        ));
        for path in [
            "/api/printers?",
            "/api/printers?limit=",
            "/api/agents?limit=1&limit=2",
            "/api/printers?redirect=x",
            "/api/agents?beforeId=%GG",
            "/api/agents?beforeId=a#fragment",
            "/api/printers/p1?limit=10",
        ] {
            assert!(!valid_fleet_query(path), "accepted {path}");
        }
        assert!(!valid_fleet_query(&format!(
            "/api/printers?beforeIdEncoded={}",
            "a".repeat(4097)
        )));
    }

    #[test]
    fn gateway_envelopes_remain_backward_compatible() {
        let legacy: super::GatewayResponse =
            serde_json::from_str(r#"{"status":200,"body":"[]"}"#).unwrap();
        assert!(legacy.headers.is_empty());
        let paged: super::GatewayResponse = serde_json::from_str(r#"{"status":200,"body":"[]","headers":{"x-has-more":"true","x-next-before-id-encoded":"cDE"}}"#).unwrap();
        assert_eq!(paged.headers.get("x-has-more").unwrap(), "true");
        assert!(
            serde_json::to_string(&paged)
                .unwrap()
                .contains("x-next-before-id-encoded")
        );
    }

    #[test]
    fn printer_action_paths_are_strictly_scoped() {
        assert!(gateway_printer_action_path(
            "/api/printers/p1/test-print",
            "test-print"
        ));
        assert!(gateway_printer_action_path(
            "/api/printers/p1/test-connection",
            "test-connection"
        ));
        assert!(!gateway_printer_action_path(
            "/api/other/p1/test-print",
            "test-print"
        ));
        assert!(!gateway_printer_action_path(
            "/api/printers/p1/test-print/extra",
            "test-print"
        ));
        assert!(!gateway_printer_action_path(
            "/api/printers/../agents/test-print",
            "test-print"
        ));
        assert!(!gateway_printer_action_path(
            "/api/printers/-p1/test-print",
            "test-print"
        ));
        for path in [
            "/api/printers/%D8%B7%D8%A7%D8%A8%D8%B9%D8%A9~1234abcd/test-print",
            "/api/printers/Receipt%20Printer/test-print",
            "/api/printers/pr%EF%BB%BFinter/test-print",
        ] {
            assert!(gateway_printer_action_path(path, "test-print"), "{path}");
        }
        for path in [
            "/api/printers/p%2Fother/test-print",
            "/api/printers/p%5Cother/test-print",
            "/api/printers/p%3Fother/test-print",
            "/api/printers/p%252Fother/test-print",
            "/api/printers/%2E%2E/test-print",
            "/api/printers/p%70/test-print",
            "/api/printers/%FF/test-print",
            "/api/printers/%d8%b7/test-print",
            "/api/printers/%EF%BB%BFprinter/test-print",
            "/api/printers/printer%EF%BB%BF/test-print",
            "/api/printers/Bad%00Name/test-print",
            "/api/printers/p%ZZ/test-print",
            "/api/printers/p1/test-print?target=/api/other",
        ] {
            assert!(!gateway_printer_action_path(path, "test-print"), "{path}");
        }
        assert!(!gateway_printer_action_path(
            &format!("/api/printers/{}/test-print", "p".repeat(121)),
            "test-print"
        ));
    }

    #[test]
    fn jobs_query_allows_only_known_bounded_filters() {
        assert!(valid_jobs_query("/api/jobs"));
        assert!(valid_jobs_query("/api/jobs?limit=50"));
        assert!(valid_jobs_query("/api/jobs?limit=50&search=invoice"));
        assert!(valid_jobs_query(
            "/api/jobs?status=queued&offset=10&printerId=p1&agentId=a1"
        ));
        assert!(!valid_jobs_query("/api/jobs?evil=https://example.com"));
        assert!(!valid_jobs_query("/api/jobs?limit=50&evil=x"));
        assert!(!valid_jobs_query("/api/jobs?limit"));
        assert!(!valid_jobs_query("/api/jobs?=50"));
        assert!(valid_jobs_query("/api/jobs?search=receipt+%D8%A3"));
        assert!(valid_jobs_query("/api/jobs?search=a%23b"));
        assert!(!valid_jobs_query("/api/jobs?limit=10&limit=20"));
        assert!(!valid_jobs_query("/api/jobs?search=%ZZ"));
        assert!(!valid_jobs_query("/api/jobs?status=queued&evil=%ZZ"));
        assert!(!valid_jobs_query("/api/jobs?"));
        assert!(!valid_jobs_query("/api/jobs#"));
        assert!(!valid_jobs_query("/api/jobs?status=queued#"));
    }

    #[test]
    fn gateway_path_guard_rejects_traversal_but_not_query_search_dots() {
        assert!(!unsafe_gateway_route_path("/api/jobs?search=invoice..pdf"));
        assert!(!unsafe_gateway_route_path("/api/printers?beforeId=queue..two"));
        assert!(unsafe_gateway_route_path("/api/printers/../agents"));
        assert!(unsafe_gateway_route_path("/api/printers/p..q/test-print"));
        assert!(unsafe_gateway_route_path("/api/jobs?search=a\\b"));
        assert!(allowed_agent_gateway_path("/api/jobs?search=invoice..pdf", "GET"));
    }

    #[test]
    fn agent_console_allowlist_matches_desktop_jobs_requests() {
        assert!(allowed_agent_gateway_path("/api/printers", "POST"));
        assert!(allowed_agent_gateway_path(
            "/api/printers/p1/test-print",
            "POST"
        )); // Own-Agent test print is gated by validated retry key + Gateway ownership
        assert!(allowed_agent_gateway_path(
            "/api/printers/p1/test-connection",
            "POST"
        ));
        assert!(allowed_agent_gateway_path("/api/jobs?limit=50", "GET"));
        assert!(allowed_agent_gateway_path(
            "/api/jobs?limit=50&search=invoice",
            "GET"
        ));
        // Keep this allowlist narrow: no read or control-plane mutation
        // through the test-print path, no query injection or path traversal.
        assert!(!allowed_agent_gateway_path(
            "/api/printers/p1/test-print",
            "GET"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/printers/p1/test-print",
            "PATCH"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/printers/p1/test-print?redirect=/api/agents",
            "POST"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/printers/../test-print",
            "POST"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/other/p1/test-print",
            "POST"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/jobs/p1/test-print",
            "POST"
        ));
        assert!(!allowed_agent_gateway_path(
            "/api/jobs?next=/api/other",
            "GET"
        ));
        assert!(!allowed_agent_gateway_path("/api/printers/p1", "PATCH"));
        // Removed customer E2E capture paths must stay denied.
        for method in ["GET", "POST", "PATCH", "DELETE"] {
            assert!(!allowed_agent_gateway_path(
                "/api/agent/test-captures/status",
                method
            ));
            assert!(!allowed_agent_gateway_path(
                "/api/agent/test-captures/preview?id=cap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                method
            ));
        }
    }
}
#[cfg(test)]
mod security_tests {
    use super::{gateway_http_client, gateway_request_id, is_valid_code, normalize_gateway_url};

    #[test]
    fn gateway_http_client_is_process_reused() {
        let first = gateway_http_client().expect("first client") as *const reqwest::Client;
        let second = gateway_http_client().expect("second client") as *const reqwest::Client;
        assert_eq!(first, second);
    }

    #[test]
    fn gateway_envelope_budget_covers_max_body_and_pagination_escaping() {
        let body_bytes = crate::commands::GATEWAY_CONSOLE_MAX_BODY_BYTES;
        let body = "\0".repeat(body_bytes);
        let response = serde_json::json!({
            "status": 200,
            "body": body,
            "headers": {
                "x-has-more": "&".repeat(4096),
                "x-next-before-created-at": "&".repeat(4096),
                "x-next-before-id-encoded": "&".repeat(4096),
                "x-next-before-id": "&".repeat(4096),
                "x-next-cursor": "&".repeat(4096),
            },
        });
        let envelope = serde_json::to_vec(&response).unwrap();
        assert!(envelope.len() > 6 * body_bytes);
        assert!(envelope.len() <= crate::commands::GATEWAY_CONSOLE_MAX_ENVELOPE_BYTES);
        assert!(
            crate::commands::GATEWAY_CONSOLE_MAX_ENVELOPE_BYTES
                >= 6 * body_bytes + 6 * 5 * 4096 + 1024
        );
    }
    #[test]
    fn probe_correlation_is_bounded_and_cannot_inject_log_lines() {
        assert_eq!(gateway_request_id(None), "none");
        assert_eq!(
            gateway_request_id(Some("req-1\r\nERROR: injected")),
            "req-1ERROR:injected"
        );
        assert_eq!(gateway_request_id(Some(&"a".repeat(200))).len(), 128);
    }

    #[test]
    fn http_gateway_is_accepted_for_staging() {
        assert!(normalize_gateway_url("http://gateway.example.com").is_ok());
        assert!(normalize_gateway_url("http://127.0.0.1:3000").is_ok());
        assert!(normalize_gateway_url("http://[::1]:3000").is_ok());
        assert!(normalize_gateway_url("http://[2001:db8::1]:3000").is_ok());
        assert!(normalize_gateway_url("https://gateway.example.com").is_ok());
        assert_eq!(
            normalize_gateway_url("gateway.example.com").unwrap(),
            "https://gateway.example.com"
        );
        assert_eq!(
            normalize_gateway_url("https://gateway.example.com/").unwrap(),
            "https://gateway.example.com"
        );
    }

    #[test]
    fn gateway_url_rejects_empty_userinfo_before_native_pairing() {
        for raw in [
            "https://@gateway.example.com/",
            "https://:@gateway.example.com/",
            "https://user:@gateway.example.com/",
            "https://:password@gateway.example.com/",
        ] {
            assert!(
                normalize_gateway_url(raw).is_err(),
                "embedded userinfo marker was silently normalized: {raw}"
            );
        }
        assert_eq!(
            normalize_gateway_url("https://gateway.example.com/").unwrap(),
            "https://gateway.example.com"
        );
    }

    #[test]
    fn gateway_url_rejects_empty_or_zero_ports_without_normalization() {
        for raw in [
            "https://gateway.example.com:/",
            "https://gateway.example.com:0/",
            "https://gateway.example.com:00000/",
            "http://localhost:/",
            "http://localhost:0/",
            "https://[::1]:/",
            "https://[::1]:0/",
        ] {
            assert!(
                normalize_gateway_url(raw).is_err(),
                "invalid Gateway port silently normalized: {raw}"
            );
        }
        assert_eq!(
            normalize_gateway_url("https://gateway.example.com:443/").unwrap(),
            "https://gateway.example.com"
        );
        assert_eq!(
            normalize_gateway_url("https://gateway.example.com:8443/").unwrap(),
            "https://gateway.example.com:8443"
        );
    }

    #[test]
    fn pairing_code_contract_remains_strict() {
        assert!(is_valid_code("ABCD23"));
        assert!(!is_valid_code("ABC123")); // digit 1 is excluded by contract.
        assert!(!is_valid_code("ABCDEF7"));
    }
}
