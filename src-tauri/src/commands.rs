use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

use crate::agent;
use crate::logging;
use crate::paths;

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
    let exe = std::env::current_exe()
        .map_err(|e| format!("resolve current Manager executable: {e}"))?;
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

#[tauri::command]
pub fn relaunch_as_admin() -> Result<(), String> {
    #[cfg(windows)]
    {
        if is_running_as_admin() {
            return Err("Yaseir Print Manager is already running as administrator".into());
        }
        launch_elevated_manager()
    }
    #[cfg(not(windows))]
    {
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
        // TokenElevation (18) returns a TOKEN_ELEVATION struct with a
        // TokenIsElevated boolean field. TOKEN_ELEVATION_TYPE (20) returns
        // a different enum type and must not be used with TOKEN_ELEVATION.
        const TOKEN_ELEVATION: DWORD = 18;

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

#[tauri::command]
pub async fn get_agent_status(app: tauri::AppHandle) -> AgentStatus {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let base = AgentStatus {
        running: false,
        service: "YaseirAgent".into(),
        version: env!("CARGO_PKG_VERSION").into(),
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
    match tauri::async_runtime::spawn_blocking(move || agent::status(&app)).await {
        Ok((running, service_running, note)) => {
            let note_code = if note.starts_with("service state unavailable:") {
                "service_status_unavailable"
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
            };
            AgentStatus {
                running,
                note,
                note_code: note_code.into(),
                ..base
            }
        },
        Err(e) => AgentStatus {
            note: format!("status check failed: {e}"),
            note_code: "status_check_failed".into(),
            ..base
        },
    }
}

#[tauri::command]
pub async fn start_agent(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::start(&app))
        .await
        .map(|_| "agent started".into())
}

#[tauri::command]
pub async fn stop_agent(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::stop(&app))
        .await
        .map(|_| "agent stopped".into())
}

#[tauri::command]
pub async fn restart_agent(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::restart(&app))
        .await
        .map(|_| "agent restarted".into())
}

#[tauri::command]
pub async fn control_service(action: String, app: tauri::AppHandle) -> Result<String, String> {
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
    // Production Gateways must use HTTPS. Localhost HTTP remains available for
    // development without weakening the remote transport policy.
    if scheme == "http" {
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]");
        if !local {
            return Err("Gateway URL must use HTTPS for remote Gateways".into());
        }
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("gateway URL cannot include embedded credentials".into());
    }
    if parsed.path() != "/" { return Err("gateway URL must use the origin root".into()); }
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
    let cli = agent::cli_path(&app)?;
    let config = paths::agent_config_path();
    paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {e}"))?;
    let was_running = agent::status(&app).0;

    logging::info(&format!("pairing agent (server={gateway_url})"));
    let mut cmd = Command::new(&cli);
    cmd.arg("-pair")
        .arg(code)
        .arg("-server")
        .arg(gateway_url)
        .arg("-config")
        .arg(&config)
        .env("YASEIR_AGENT_DATA_DIR", paths::agent_data_root());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
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
        agent::restart(&app).map_err(|e| {
            format!("pairing saved but the running agent could not be restarted to use it ({e}); restart the agent manually")
        })?;
        logging::info(&format!("agent restarted after pairing: {stdout}"));
        return Ok(format!("{stdout} (agent restarted with the new identity)"));
    }
    Ok(format!("{stdout} (saved; start the agent to activate)"))
}

#[derive(Clone)]
struct ManagerSession {
    access_token: String,
    refresh_token: String,
}

#[derive(Default)]
struct ManagerState {
    origin: String,
    generation: u64,
    session: Option<ManagerSession>,
}

static MANAGER_SESSION: OnceLock<Mutex<ManagerState>> = OnceLock::new();
static MANAGER_AUTH_FLIGHT: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();

fn manager_session_store() -> &'static Mutex<ManagerState> {
    MANAGER_SESSION.get_or_init(|| Mutex::new(ManagerState::default()))
}

fn clear_manager_session_inner() {
    if let Ok(mut guard) = manager_session_store().lock() {
        guard.generation = guard.generation.wrapping_add(1);
        guard.session = None;
    }
}

fn manager_snapshot() -> Result<(url::Url, u64, Option<ManagerSession>), String> {
    let mut guard = manager_session_store().lock().map_err(|_| "manager state lock poisoned")?;
    let origin = configured_gateway_origin()?;
    let identity = origin.as_str().to_string();
    if guard.origin != identity {
        guard.origin = identity;
        guard.generation = guard.generation.wrapping_add(1);
        guard.session = None;
    }
    Ok((origin, guard.generation, guard.session.clone()))
}

fn current_manager_token() -> Option<String> {
    manager_snapshot().ok().and_then(|(_, _, session)| session.map(|s| s.access_token))
}

fn is_public_gateway_path(path: &str) -> bool {
    path == "/api/health"
        || path == "/api/agent/probe"
        || path == "/api/auth/manager/login"
        || path == "/api/auth/manager/refresh"
}

fn uses_manager_refresh_credential(path: &str) -> bool {
    path == "/api/auth/manager/refresh" || path == "/api/auth/manager/logout"
}

#[tauri::command]
pub fn clear_manager_session() {
    clear_manager_session_inner();
}

#[tauri::command]
pub fn has_manager_session() -> bool {
    current_manager_token().is_some()
}

#[derive(Deserialize)]
pub struct GatewayRequestArgs {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: String,
}

fn method_from_str(value: &str) -> Result<reqwest::Method, String> {
    let method = value
        .trim()
        .parse::<reqwest::Method>()
        .map_err(|_| "unsupported HTTP method".to_string())?;
    match method {
        reqwest::Method::GET | reqwest::Method::POST | reqwest::Method::PATCH => Ok(method),
        _ => Err("HTTP method is not permitted by the desktop Gateway boundary".into()),
    }
}

/// Read a Gateway response incrementally. Buffering the complete body before
/// checking its size would make the advertised limit ineffective for chunked
/// responses, so the 8 MiB boundary is enforced while reading.
async fn read_response_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    if let Some(len) = response.content_length() {
        if len > max_bytes as u64 {
            return Err(format!("Gateway response exceeds {} byte limit", max_bytes));
        }
    }

    let capacity = response
        .content_length()
        .map(|n| n.min(max_bytes as u64) as usize)
        .unwrap_or(16 * 1024);
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read Gateway response: {e}"))?
    {
        if chunk.len() > max_bytes.saturating_sub(body.len()) {
            return Err(format!("Gateway response exceeds {} byte limit", max_bytes));
        }
        body.extend_from_slice(&chunk);
    }

    String::from_utf8(body).map_err(|e| format!("Gateway response was not valid UTF-8: {e}"))
}

/// Probe a candidate Gateway health endpoint without changing the persisted
/// Gateway origin or touching the Manager session. Settings uses this before
/// committing a new origin so an unreachable typo cannot revoke a valid
/// authenticated session for the currently configured Gateway.
#[tauri::command]
pub async fn probe_gateway_health(url: String) -> Result<GatewayResponse, String> {
    let base = normalize_gateway_url(&url)?;
    let origin = base
        .parse::<url::Url>()
        .map_err(|e| format!("invalid Gateway URL: {e}"))?;
    let target = origin
        .join("api/agent/probe")
        .map_err(|e| format!("invalid Gateway probe URL: {e}"))?;
    if target.scheme() != origin.scheme()
        || target.host_str() != origin.host_str()
        || target.port_or_known_default() != origin.port_or_known_default()
    {
        return Err("Gateway probe must stay on the candidate origin".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))?;
    let response = client
        .get(target)
        .header("Origin", "tauri://localhost")
        .send()
        .await
        .map_err(|e| format!("Gateway probe failed: {e}"))?;
    let status = response.status().as_u16();
    let body = read_response_body_limited(response, 1024 * 1024).await?;
    Ok(GatewayResponse { status, body })
}

fn configured_gateway_origin() -> Result<url::Url, String> {
    let cfg = get_gateway_config()?;
    if cfg.url.is_empty() {
        return Err("Gateway URL is not configured".into());
    }
    normalize_gateway_url(&cfg.url)?
        .parse::<url::Url>()
        .map_err(|e| format!("invalid configured gateway URL: {e}"))
}

#[tauri::command]
pub async fn gateway_request(args: GatewayRequestArgs) -> Result<GatewayResponse, String> {
    let path = args.path.trim();
    let base_path = path.split('?').next().unwrap_or("");
    if path.contains('#') || base_path.contains('%') || path.chars().any(|c| c.is_control()) {
        return Err("Gateway paths must use literal API segments without fragments or controls".into());
    }
    let auth_path = base_path.starts_with("/api/auth/");
    if auth_path && path != base_path {
        return Err("Authentication paths do not accept query strings".into());
    }
    let _auth_flight = if auth_path {
        Some(MANAGER_AUTH_FLIGHT.get_or_init(|| tauri::async_runtime::Mutex::new(())).lock().await)
    } else { None };
    let (origin, generation, session) = manager_snapshot()?;
    if !path.starts_with("/api/") || path.contains("..") || path.contains('\\') {
        return Err("gateway request path must be an API-relative path".into());
    }
    let target = origin
        .join(path.trim_start_matches('/'))
        .map_err(|e| format!("invalid gateway request path: {e}"))?;
    if target.scheme() != origin.scheme()
        || target.host_str() != origin.host_str()
        || target.port_or_known_default() != origin.port_or_known_default()
    {
        return Err("gateway request must stay on the configured Gateway origin".into());
    }

    if target.path() != base_path || target.query_pairs().any(|(key, _)| matches!(key.to_ascii_lowercase().as_str(), "access_token" | "refresh_token" | "token" | "authorization" | "x-refresh-token")) {
        return Err("Gateway credential queries or nonliteral paths are forbidden".into());
    }
    // The renderer cannot supply its own Authorization header. Manager bearer
    // credentials are held only in Rust process memory for the packaged app.
    let mut header_budget = 0usize;
    for (name, value) in &args.headers {
        if name.eq_ignore_ascii_case("authorization")
            || name.eq_ignore_ascii_case("cookie")
            || name.eq_ignore_ascii_case("x-refresh-token")
            || name.eq_ignore_ascii_case("origin")
            || name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("upgrade")
            || name.eq_ignore_ascii_case("x-forwarded-for")
            || name.eq_ignore_ascii_case("x-forwarded-host")
            || name.eq_ignore_ascii_case("x-forwarded-proto")
            || name.eq_ignore_ascii_case("x-real-ip")
        {
            return Err("restricted authentication/proxy/transport headers are managed by the desktop boundary".into());
        }
        header_budget = header_budget
            .saturating_add(name.len())
            .saturating_add(value.len());
        if header_budget > 64 * 1024 {
            return Err("Gateway request headers exceed the 64 KiB limit".into());
        }
    }
    let manager_token = if is_public_gateway_path(path) {
        None
    } else {
        session.as_ref().map(|s| s.access_token.clone())
    };
    let manager_refresh_token = if uses_manager_refresh_credential(path) {
        session.as_ref().map(|s| s.refresh_token.clone())
    } else {
        None
    };
    if uses_manager_refresh_credential(path) && manager_refresh_token.is_none() {
        return Ok(GatewayResponse {
            status: 401,
            body: "{\"error\":\"manager_refresh_authentication_required\"}".into(),
        });
    }
    if !is_public_gateway_path(path) && manager_token.is_none() {
        return Ok(GatewayResponse {
            status: 401,
            body: "{\"error\":\"manager_authentication_required\"}".into(),
        });
    }

    let method = method_from_str(&args.method)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))?;
    let mut request = client.request(method, target);
    request = request.header("Origin", "tauri://localhost");
    // Restricted headers (host/cookie/authorization/...) already return Err
    // in the allowlist filter above, so they can never reach this loop.
    for (name, value) in args.headers {
        request = request.header(name, value);
    }
    if let Some(token) = manager_token {
        request = request.bearer_auth(token);
    }
    if let Some(refresh_token) = manager_refresh_token {
        request = request.header("X-Refresh-Token", refresh_token);
    }
    if let Some(body) = args.body {
        if body.len() > 8 * 1024 * 1024 {
            return Err("gateway request body exceeds 8 MiB".into());
        }
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Gateway request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = read_response_body_limited(response, 8 * 1024 * 1024).await?;

    let safe_body = {
        let mut guard = manager_session_store().lock().map_err(|_| "manager state lock poisoned")?;
        if guard.generation != generation || guard.origin != origin.as_str() {
            return Err("Gateway origin/session changed while the request was in flight; reconcile the original operation before retrying".into());
        }
        if path == "/api/auth/manager/logout" || (path == "/api/auth/manager/refresh" && (status == 401 || status == 403)) {
            guard.session = None;
            guard.generation = guard.generation.wrapping_add(1);
        }
        if auth_path {
            let mut value: serde_json::Value = serde_json::from_str(&body)
                .map_err(|_| "Gateway authentication response was invalid JSON")?;
            let object = value.as_object_mut().ok_or("Gateway authentication response must be an object")?;
            let access_token = object.remove("accessToken").and_then(|v| v.as_str().map(str::to_string));
            let refresh_token = object.remove("refreshToken").and_then(|v| v.as_str().map(str::to_string));
            if (path == "/api/auth/manager/login" || path == "/api/auth/manager/refresh") && (200..300).contains(&status) && object.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                match (access_token, refresh_token) {
                    (Some(access_token), Some(refresh_token)) if !access_token.is_empty() && !refresh_token.is_empty() => {
                        guard.generation = guard.generation.wrapping_add(1);
                        guard.session = Some(ManagerSession { access_token, refresh_token });
                    }
                    _ => return Err("Gateway authentication response omitted credentials".into()),
                }
            }
            serde_json::to_string(&value).map_err(|_| "could not sanitize authentication response")?
        } else { body }
    };
    Ok(GatewayResponse {
        status,
        body: safe_body,
    })
}

#[derive(Deserialize)]
pub struct AgentGatewayRequestArgs {
    pub path: String,
    pub method: String,
    pub body: Option<String>,
    /// Manager-visible Gateway origin the operator intends to act on. The
    /// paired Agent config owns a different origin (its own Server URL); the
    /// CLI refuses the request unless they match, so changing the Manager
    /// origin can never show or mutate the old Agent Gateway under the new
    /// displayed origin.
    pub expected_origin: String,
}

fn valid_gateway_printer_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '~'))
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
    if base != "/api/jobs" || query.is_empty() {
        return false;
    }
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let Some(value) = parts.next() else {
            return false;
        };
        if key.is_empty() || value.len() > 200 {
            return false;
        }
        if !matches!(
            key,
            "limit" | "offset" | "status" | "search" | "q" | "printerId" | "agentId"
        ) {
            return false;
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
        "GET" => path == "/api/printers" || valid_jobs_query(path) || path == "/api/agents",
        "POST" => {
            path == "/api/printers"
                || gateway_printer_action_path(path, "test-connection")
        }
        // Physical test-print and desired-state mutation are manager-RBAC only;
        // the Agent bearer may perform only non-printing console actions here.
        _ => false,
    }
}

#[tauri::command]
pub async fn gateway_agent_request(
    args: AgentGatewayRequestArgs,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let path = args.path.trim().to_string();
    let method = args.method.trim().to_ascii_uppercase();
    if !path.starts_with("/api/") || path.contains("..") || path.contains('\\') {
        return Err("gateway request path must be an API-relative path".into());
    }
    if !allowed_agent_gateway_path(&path, &method) {
        return Err("gateway request is not permitted for the desktop Agent console".into());
    }
    if args
        .body
        .as_ref()
        .map(|b| b.len() > 8 * 1024 * 1024)
        .unwrap_or(false)
    {
        return Err("gateway request body exceeds 8 MiB".into());
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
        if let Some(body) = args.body {
            request_cmd.arg("-body").arg(body);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            request_cmd.creation_flags(0x0800_0000);
        }
        let out = agent::run_bounded_command(
            request_cmd,
            std::time::Duration::from_secs(20),
            256 * 1024,
            64 * 1024,
        )?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            let msg = if stderr.is_empty() { stdout } else { stderr };
            return Err(msg);
        }
        // gateway-request returns a JSON {status, body} envelope for every
        // HTTP response, including application errors. Keep the actual status
        // visible to the desktop instead of manufacturing HTTP 200.
        let response: GatewayResponse = serde_json::from_str(&stdout)
            .map_err(|e| format!("invalid agent Gateway response envelope: {e}"))?;
        serde_json::to_string(&response)
            .map_err(|e| format!("serialize agent Gateway response: {e}"))
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
    let from: Vec<u16> = temp_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let to: Vec<u16> = destination.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
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
    if let Some(parent) = destination.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            dir.sync_all()
                .map_err(|e| format!("sync settings directory {}: {e}", parent.display()))?;
        }
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
        let temp_path = parent.join(format!(
            ".{file_name}.tmp-{}-{attempt}",
            std::process::id()
        ));
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

#[tauri::command]
pub fn get_gateway_config() -> Result<GatewayConfig, String> {
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
    let raw = read_file_or_default(&path).map_err(|e| {
        logging::error(&e);
        e
    })?;
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
pub fn set_gateway_config(url: String, app: tauri::AppHandle) -> Result<String, String> {
    let url = normalize_gateway_url(&url)?;
    let mut state = manager_session_store().lock().map_err(|_| "manager state lock poisoned")?;
    let previous = get_gateway_config().map(|cfg| cfg.url).unwrap_or_default();
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
        state.generation = state.generation.wrapping_add(1);
        state.origin = url.clone();
        state.session = None;
        drop(state);
        app.emit("gateway:config_changed", &url).map_err(|e| format!("Gateway saved but change notification failed: {e}"))?;
    }
    Ok(format!("saved gateway settings to {}", path.display()))
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
pub fn get_runtime_paths() -> RuntimePaths {
    RuntimePaths {
        manager_data: paths::manager_data_root().display().to_string(),
        settings: paths::settings_path().display().to_string(),
        agent_config: paths::agent_config_path().display().to_string(),
        manager_log: paths::manager_log_path().display().to_string(),
        agent_data: paths::agent_data_root().display().to_string(),
    }
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

/// Virtual / software / RDP-redirected queue detection — desktop safety net.
///
/// The authoritative filter is the Windows agent, which classifies every queue
/// during discovery (port monitor, driver, PnP ids, transport) and never
/// registers a non-physical printer. This only guards the UI against a record
/// that an older version already persisted.
/// Windows port monitors whose output never reaches hardware: they write a
/// file, discard the job or dial a modem. This is device metadata (like the
/// agent's `virtualPortMonitors`), not a printer name.
const VIRTUAL_PORT_MONITORS: &[&str] = &[
    "portprompt:", // Microsoft Print to PDF / print-to-file prompt
    "xpsport:",    // Microsoft XPS Document Writer
    "file:",       // print to file
    "nul:",
    "null:",
    "shrfax:", // Windows Shared Fax
    "fax:",
];

/// Driver / PnP families that only ever produce a file or hand the job to an
/// application. Mirrors the Windows agent's `softwareWriterTokens`.
const SOFTWARE_WRITER_TOKENS: &[&str] = &[
    // Microsoft in-box software writers
    "microsoft print to pdf",
    "microsoft xps document writer",
    "microsoft shared fax",
    "send to onenote",
    "onenote",
    // Semantic families (language independent)
    "document writer",
    "documentwriter",
    "print to pdf",
    "topdf",
    "pdf writer",
    "pdfwriter",
    "pdf printer",
    "pdf creator",
    "pdf converter",
    "pdf architect",
    "virtual printer",
    "software printer",
    "image printer",
    // Widely deployed third-party software writers
    "foxit",
    "anydesk",
    "cutepdf",
    "pdf995",
    "novapdf",
    "bullzip",
    "pdfcreator",
    "pdfforge",
    "doro pdf",
    "biopdf",
    "nitro pdf",
    "adobe pdf",
    "bluebeam",
    "tinypdf",
    "7-pdf",
    "icecream pdf",
    "pdf24",
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
    "thinprint",
    "safeguard print",
];

fn is_virtual_printer_for_ui(p: &PrinterInfo) -> bool {
    if p.is_virtual.unwrap_or(false) {
        return true;
    }
    if let Some(t) = p.printer_type.as_ref() {
        if t.trim().to_lowercase() == "virtual" {
            return true;
        }
    }
    if let Some(c) = p.connection_type.as_ref() {
        if c.trim().to_lowercase() == "virtual" {
            return true;
        }
    }
    if let Some(proto) = p.protocol.as_ref() {
        if proto.trim().to_lowercase() == "virtual" {
            return true;
        }
    }

    let caps = p.capabilities.as_ref();
    if let Some(caps) = caps {
        for key in ["virtual", "is_virtual"].iter() {
            if caps.get(*key).and_then(|v| v.as_bool()) == Some(true) {
                return true;
            }
        }
        let class = caps
            .get("printer_class")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        if class == "virtual" || class == "redirected" {
            return true;
        }
        // Port monitor. "IP_192.168.1.50,SNMP" -> "ip_192.168.1.50".
        if let Some(port) = caps.get("port_name").and_then(|v| v.as_str()) {
            let lowered = port.to_lowercase();
            let head = lowered.split(',').next().unwrap_or("").trim();
            if VIRTUAL_PORT_MONITORS
                .iter()
                .any(|m| head == *m || head.starts_with(m))
            {
                return true;
            }
        }
    }

    let name_lower = p.name.to_lowercase();
    // Windows: "HP LaserJet (redirected 3)". Citrix: "… (from WKS12) in session 4".
    if name_lower.contains("(redirected") || name_lower.contains(" in session ") {
        return true;
    }

    // The driver, the comment and the PnP ids identify a software writer or a
    // session tunnel far more reliably than the display name does.
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

    if SOFTWARE_WRITER_TOKENS.iter().any(|t| hay.contains(t)) {
        return true;
    }
    SESSION_REDIRECT_TOKENS.iter().any(|t| hay.contains(t))
}

fn is_valid_printer_for_ui(p: &PrinterInfo) -> bool {
    // Virtual, software and redirected queues are never production printers.
    if is_virtual_printer_for_ui(p) {
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
pub async fn get_printers(_app: tauri::AppHandle) -> Result<Vec<PrinterInfo>, String> {
    run_blocking(move || {
        let path = paths::agent_data_root().join("printers.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {}", path.display(), e))?;
        if raw.trim().is_empty() {
            return Ok(vec![]);
        }
        let v: Vec<PrinterInfo> =
            serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;
        let filtered: Vec<PrinterInfo> = v
            .into_iter()
            .filter(|p| is_valid_printer_for_ui(p))
            .collect();
        Ok(filtered)
    })
    .await
}

#[tauri::command]
pub async fn discover_printers(app: tauri::AppHandle) -> Result<DiscoverResult, String> {
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
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            discover_cmd.creation_flags(0x0800_0000);
        }
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
            .find_map(|marker| line.find(marker).map(|index| line[index..].trim().to_string()));
        if let Some(message) = actionable {
            if !diagnostics.iter().any(|existing| existing == &message) {
                diagnostics.push(message);
            }
        }
    }
    diagnostics
}

fn parse_discovery_stdout(stdout: &str) -> Result<Vec<PrinterInfo>, String> {
    // Older CLI builds encoded an empty slice as null. Accept that legacy
    // representation, but reject corrupt/non-JSON output rather than showing
    // an unrelated on-disk inventory as a successful discovery.
    let printers: Option<Vec<PrinterInfo>> = serde_json::from_str(stdout)
        .map_err(|e| format!("parse discovery JSON: {e}"))?;
    Ok(printers.unwrap_or_default().into_iter()
        .filter(is_valid_printer_for_ui).collect())
}

#[cfg(test)]
#[path = "audit_discovery_test.rs"]
mod audit_discovery_test;

#[tauri::command]
pub async fn test_printer(printer_id: String, app: tauri::AppHandle) -> Result<String, String> {
    // Same trust boundary as register_printer's arg_value: the id is passed
    // positionally to the Go CLI, whose parser treats a leading-dash value
    // as a flag (e.g. "-config" would be swallowed as a flag name). Printer
    // ids never legitimately start with '-'.
    let pid = printer_id.trim().to_string();
    if pid.is_empty() {
        return Err("printer id is required".into());
    }
    if pid.starts_with('-') {
        return Err("printer id must not start with '-'".into());
    }
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let mut test_cmd = std::process::Command::new(&cli);
        test_cmd
            .arg("printers")
            .arg("test")
            .arg(&pid)
            .arg("-config")
            .arg(&config)
            .env("YASEIR_AGENT_DATA_DIR", &root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            test_cmd.creation_flags(0x0800_0000);
        }
        let out = agent::run_bounded_command(
            test_cmd,
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
    // A value starting with `-` would be parsed by the Go CLI as a FLAG, not
    // a value (no shell is involved, so this is argument smuggling, not
    // injection): reject leading-dash values at the trust boundary.
    fn arg_value(name: &str, raw: &str) -> Result<String, String> {
        let v = raw.trim().to_string();
        if v.is_empty() {
            return Err(format!("{name} must not be empty"));
        }
        if v.starts_with('-') {
            return Err(format!("{name} must not start with '-'"));
        }
        Ok(v)
    }
    let name = arg_value("printer name", &request.name)?;
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
                .arg(arg_value("spooler name", sn)?);
        }
        if let Some(proto) = request.protocol.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--protocol")
                .arg(arg_value("protocol", proto)?.to_lowercase());
        }
        if let Some(pt) = request
            .printer_type
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            cmd.arg("--printer-type")
                .arg(arg_value("printer type", pt)?.to_lowercase());
        }
        if let Some(vid) = request.usb_vid.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--vid").arg(arg_value("USB VID", vid)?);
        }
        if let Some(pid) = request.usb_pid.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--pid").arg(arg_value("USB PID", pid)?);
        }
        if let Some(serial) = request.usb_serial.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--serial").arg(arg_value("USB serial", serial)?);
        }
        cmd.arg("-config").arg(&config);
        cmd.env("YASEIR_AGENT_DATA_DIR", &root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
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
    use super::{allowed_agent_gateway_path, gateway_printer_action_path, valid_jobs_query};

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
    }

    #[test]
    fn agent_console_allowlist_matches_desktop_jobs_requests() {
        assert!(allowed_agent_gateway_path("/api/printers", "POST"));
        assert!(!allowed_agent_gateway_path(
            "/api/printers/p1/test-print",
            "POST"
        ));
        assert!(allowed_agent_gateway_path(
            "/api/printers/p1/test-connection",
            "POST"
        ));
        assert!(allowed_agent_gateway_path("/api/jobs?limit=50", "GET"));
        assert!(allowed_agent_gateway_path(
            "/api/jobs?limit=50&search=invoice",
            "GET"
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
    }
}
#[cfg(test)]
mod security_tests {
    use super::{
        is_public_gateway_path, is_valid_code, normalize_gateway_url,
        uses_manager_refresh_credential,
    };

    #[test]
    fn only_probe_health_and_manager_login_are_public_gateway_paths() {
        assert!(is_public_gateway_path("/api/health"));
        assert!(is_public_gateway_path("/api/agent/probe"));
        assert!(is_public_gateway_path("/api/auth/manager/login"));
        assert!(is_public_gateway_path("/api/auth/manager/refresh"));
        assert!(uses_manager_refresh_credential("/api/auth/manager/refresh"));
        assert!(!is_public_gateway_path("/api/auth/manager/me"));
        assert!(!is_public_gateway_path("/api/jobs"));
    }

    #[test]
    fn remote_http_gateway_is_rejected() {
        assert!(normalize_gateway_url("http://gateway.example.com").is_err());
        assert!(normalize_gateway_url("http://127.0.0.1:3000").is_ok());
        assert!(normalize_gateway_url("http://[::1]:3000").is_ok());
        assert!(normalize_gateway_url("http://[2001:db8::1]:3000").is_err());
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
    fn pairing_code_contract_remains_strict() {
        assert!(is_valid_code("ABCD23"));
        assert!(!is_valid_code("ABC123")); // digit 1 is excluded by contract.
        assert!(!is_valid_code("ABCDEF7"));
    }
}
