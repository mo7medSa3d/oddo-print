use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

struct LogWriter {
    file: Option<File>,
    path: PathBuf,
}
static LOG_FILE: OnceLock<Mutex<LogWriter>> = OnceLock::new();

/// Rotate the log once it grows past this size; rotated copies are kept under
/// `name.1` … `name.3` next to the live file.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB
const MAX_ROTATED_FILES: u32 = 3;

/// Initialize the production file logger. Logs are written to a writable
/// ProgramData directory, never to `C:\Program Files\Yaseir Print Manager`.
/// Returns the log path on success.
pub fn init() -> Option<PathBuf> {
    let root = paths::ensure_manager_data_root().ok()?;
    let dir = root.join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[yaseir-manager] unable to create log dir {}: {e}",
            dir.display()
        );
        return None;
    }
    if let Err(e) = paths::ensure_manager_directory_security(&dir) {
        eprintln!(
            "[yaseir-manager] refusing insecure log dir {}: {e}",
            dir.display()
        );
        return None;
    }
    let path = dir.join("yaseir-manager.log");
    if path.exists()
        && let Err(e) = paths::ensure_manager_file_security(&path)
    {
        eprintln!(
            "[yaseir-manager] refusing insecure log file {}: {e}",
            path.display()
        );
        return None;
    }
    rotate_if_full(&path);
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "[yaseir-manager] unable to open log {}: {e}",
                path.display()
            );
            return None;
        }
    };
    if let Err(e) = paths::ensure_manager_file_security(&path) {
        eprintln!(
            "[yaseir-manager] refusing insecure log file {}: {e}",
            path.display()
        );
        return None;
    }
    let _ = LOG_FILE.set(Mutex::new(LogWriter {
        file: Some(file),
        path: path.clone(),
    }));
    info("application logger initialized");
    Some(path)
}

/// If `path` exceeds MAX_LOG_BYTES, shift `path.1..MAX` up by one and rename
/// `path` to `path.1`, so the current file starts empty. All failures are
/// ignored on purpose: logging must never prevent the app from starting.
fn rotate_if_full(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    let _ = std::fs::remove_file(rotated_path(path, MAX_ROTATED_FILES));
    for i in (1..MAX_ROTATED_FILES).rev() {
        let from = rotated_path(path, i);
        if from.exists() {
            let _ = std::fs::rename(&from, rotated_path(path, i + 1));
        }
    }
    let _ = std::fs::rename(path, rotated_path(path, 1));
}

fn rotated_path(path: &Path, index: u32) -> PathBuf {
    PathBuf::from(format!("{}.{index}", path.display()))
}

/// Route Rust panics into the log file. Release builds use the Windows GUI
/// subsystem (no console), so an unhandled panic would otherwise abort the
/// process without any trace. The hook writes a PANIC line with location and
/// payload before the default unwinding continues.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        write_line("PANIC", &format!("panic at {location}: {payload}"));
    }));
}

pub fn info(msg: &str) {
    write_line("INFO", msg);
}

pub fn warn(msg: &str) {
    write_line("WARN", msg);
}

pub fn error(msg: &str) {
    write_line("ERROR", msg);
}

fn timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => format_utc_iso8601(d.as_secs(), d.subsec_millis()),
        Err(_) => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

/// Format Unix seconds as ISO 8601 UTC (`2026-09-27T00:00:00.123Z`) without a
/// date-time dependency (civil-from-days conversion; March-based epoch shift
/// so leap days land at the end of February).
fn format_utc_iso8601(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        m,
        d,
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60,
        millis,
    )
}

/// Prevent log-line forging (CR/LF/control chars) and redact credential
/// tokens before writing to a log file readable by standard local users.
fn sanitize_log_message(msg: &str) -> String {
    let clean: String = msg
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let lower = clean.to_ascii_lowercase();
    let mut out = String::with_capacity(clean.len());
    let bytes = clean.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let rest_lower = &lower[i..];
        let mut redacted_prefix: Option<usize> = None;
        for marker in [
            "authorization: bearer ",
            "authorization: basic ",
            "bearer ",
            "authorization:",
            "yaseir_pairing_code=",
            "pairing_code=",
            "secret=",
            "secret:",
            r#""secret":"#,
            "token=",
            "token:",
            r#""token":"#,
            "password=",
            "password:",
            r#""password":"#,
            "api_key=",
            "api_key:",
            r#""api_key":"#,
        ] {
            if rest_lower.starts_with(marker) {
                redacted_prefix = Some(marker.len());
                break;
            }
        }
        if let Some(prefix_len) = redacted_prefix {
            out.push_str(&clean[i..i + prefix_len]);
            i += prefix_len;
            while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'"' | b'\'') {
                out.push(bytes[i] as char);
                i += 1;
            }
            while i < bytes.len()
                && !matches!(bytes[i], b' ' | b'\t' | b',' | b';' | b'"' | b'\'' | b')' | b'}' | b']')
            {
                i += 1;
            }
            out.push_str("[REDACTED]");
            continue;
        }
        if let Some(ch) = clean[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn write_line(level: &str, msg: &str) {
    let safe_msg = sanitize_log_message(msg);
    let line = format!("[{}] [{}] {}\n", timestamp(), level, safe_msg);
    {
        if let Some(m) = LOG_FILE.get()
            && let Ok(mut logger) = m.lock()
        {
            let full = logger
                .file
                .as_ref()
                .and_then(|file| file.metadata().ok())
                .is_some_and(|meta| meta.len() > MAX_LOG_BYTES);
            if full {
                // Close the handle before rename, including on Windows.
                drop(logger.file.take());
                rotate_if_full(&logger.path);
                logger.file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&logger.path)
                    .ok();
                if logger.file.is_some()
                    && paths::ensure_manager_file_security(&logger.path).is_err()
                {
                    logger.file = None;
                }
            }
            if let Some(file) = logger.file.as_mut()
                && file
                    .write_all(line.as_bytes())
                    .and_then(|_| file.flush())
                    .is_ok()
            {
                return;
            }
        }
    }
    // Fallback only for startup failures before the logger is initialized.
    let _ = std::io::stderr().write_all(line.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::{format_utc_iso8601, sanitize_log_message};

    #[test]
    fn sanitize_prevents_log_injection_and_redacts_secrets() {
        assert_eq!(
            sanitize_log_message("line1\r\n[2026] [INFO] forged"),
            "line1  [2026] [INFO] forged"
        );
        assert_eq!(
            sanitize_log_message("auth failed: Bearer supersecret123 next"),
            "auth failed: Bearer [REDACTED] next"
        );
        assert_eq!(
            sanitize_log_message("Authorization: Bearer supersecret123"),
            "Authorization: Bearer [REDACTED]"
        );
        assert_eq!(
            sanitize_log_message(r#"{"token":"abc123","ok":false}"#),
            r#"{"token":"[REDACTED]","ok":false}"#
        );
        assert_eq!(
            sanitize_log_message("pairing_code=KQ7XTM failed"),
            "pairing_code=[REDACTED] failed"
        );
    }

    #[test]
    fn timestamp_formats_known_epochs_as_iso8601_utc() {
        assert_eq!(format_utc_iso8601(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_utc_iso8601(1_695_772_800, 123),
            "2023-09-27T00:00:00.123Z"
        );
        // Leap day survives the civil conversion.
        assert_eq!(
            format_utc_iso8601(1_709_164_800, 0),
            "2024-02-29T00:00:00.000Z"
        );
        assert_eq!(
            format_utc_iso8601(1_790_467_200, 5),
            "2026-09-27T00:00:00.005Z"
        );
    }
}
