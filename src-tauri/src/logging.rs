use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

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
        eprintln!("[yaseir-manager] unable to create log dir {}: {e}", dir.display());
        return None;
    }
    let path = dir.join("yaseir-manager.log");
    rotate_if_full(&path);
    let file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[yaseir-manager] unable to open log {}: {e}", path.display());
            return None;
        }
    };
    let _ = LOG_FILE.set(Mutex::new(file));
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

#[cfg(test)]
mod tests {
    use super::format_utc_iso8601;

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

fn write_line(level: &str, msg: &str) {
    let line = format!("[{}] [{}] {}\n", timestamp(), level, msg);
    {
        if let Some(m) = LOG_FILE.get() {
            if let Ok(mut file) = m.lock() {
                let _ = file.write_all(line.as_bytes());
                let _ = file.flush();
                return;
            }
        }
    }
    // Fallback only for startup failures before the logger is initialized.
    let _ = std::io::stderr().write_all(line.as_bytes());
}
