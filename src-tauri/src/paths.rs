use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static MANAGER_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();
static AGENT_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Root for writable Yaseir Print Manager state.
///
/// Canonical `%PROGRAMDATA%\YaseirManager` on Windows: the desktop app and
/// the Windows Service (LocalSystem) must read and write the SAME location,
/// so no per-user fallback exists by design. Pre-migration installs used
/// `%PROGRAMDATA%\YasserManager`; the candidate below prefers the canonical
/// path but falls back to the legacy path when it already exists, so upgrades
/// keep their data. If this process cannot write
/// there, every mutating operation fails closed with an Administrator
/// message and the UI shows an elevation banner (see is_running_as_admin).
pub fn manager_data_root() -> PathBuf {
    if let Some(p) = MANAGER_DATA_ROOT.get() {
        return p.clone();
    }
    manager_data_root_candidate()
}

pub fn ensure_manager_data_root() -> std::io::Result<PathBuf> {
    if let Some(p) = MANAGER_DATA_ROOT.get() {
        return Ok(p.clone());
    }
    let primary = manager_data_root_candidate();
    if let Err(e) = ensure_dir(&primary) {
        return Err(admin_required_error("manager data dir", &primary, &e));
    }
    let _ = MANAGER_DATA_ROOT.set(primary.clone());
    Ok(primary)
}

fn manager_data_root_candidate() -> PathBuf {
    if let Ok(override_dir) = std::env::var("YASEIR_MANAGER_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    // Legacy fallback: pre-migration installs set YASSER_MANAGER_DATA_DIR.
    if let Ok(override_dir) = std::env::var("YASSER_MANAGER_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(override_dir) = std::env::var("ODOO_PRINT_MANAGER_DATA_DIR") {
            if !override_dir.trim().is_empty() {
                return PathBuf::from(override_dir);
            }
        }
    }
    if let Ok(pd) = std::env::var("PROGRAMDATA") {
        if !pd.trim().is_empty() {
            let canonical = PathBuf::from(&pd).join("YaseirManager");
            if canonical.exists() {
                return canonical;
            }
            let legacy = PathBuf::from(&pd).join("YasserManager");
            if legacy.exists() {
                return legacy;
            }
            return canonical;
        }
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\ProgramData\YaseirManager")
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config").join("yaseir-manager")
        } else {
            PathBuf::from("/tmp/yaseir-manager")
        }
    }
}

/// Root for the Go agent's writable runtime data.
///
/// Canonical `%PROGRAMDATA%\YaseirAgent` on Windows, for the same
/// no-split-brain reason as the manager root: the desktop-spawned agent
/// (pid file, config, queue) and the Windows Service must share one home.
/// Pre-migration installs used `%PROGRAMDATA%\YasserAgent`; prefer the
/// canonical path but fall back to the legacy path when it already exists.
pub fn agent_data_root() -> PathBuf {
    if let Some(p) = AGENT_DATA_ROOT.get() {
        return p.clone();
    }
    agent_data_root_candidate()
}

pub fn ensure_agent_data_root() -> std::io::Result<PathBuf> {
    if let Some(p) = AGENT_DATA_ROOT.get() {
        return Ok(p.clone());
    }
    let primary = agent_data_root_candidate();
    if let Err(e) = ensure_dir(&primary) {
        return Err(admin_required_error("agent data dir", &primary, &e));
    }
    let _ = AGENT_DATA_ROOT.set(primary.clone());
    Ok(primary)
}

fn agent_data_root_candidate() -> PathBuf {
    if let Ok(override_dir) = std::env::var("YASEIR_AGENT_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    // Legacy fallback: pre-migration installs set YASSER_AGENT_DATA_DIR.
    if let Ok(override_dir) = std::env::var("YASSER_AGENT_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(override_dir) = std::env::var("ODOO_PRINT_AGENT_DATA_DIR") {
            if !override_dir.trim().is_empty() {
                return PathBuf::from(override_dir);
            }
        }
    }
    if let Ok(pd) = std::env::var("PROGRAMDATA") {
        if !pd.trim().is_empty() {
            let canonical = PathBuf::from(&pd).join("YaseirAgent");
            if canonical.exists() {
                return canonical;
            }
            let legacy = PathBuf::from(&pd).join("YasserAgent");
            if legacy.exists() {
                return legacy;
            }
            return canonical;
        }
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\ProgramData\YaseirAgent")
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config").join("yaseir-agent")
        } else {
            PathBuf::from("/tmp/yaseir-agent")
        }
    }
}

/// Autostart belongs to the logged-in user, independently of shared service data.
pub fn autostart_choice_path() -> Result<PathBuf, String> {
    let root = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is unavailable; cannot persist a per-user autostart choice")?;
    if root.trim().is_empty() { return Err("LOCALAPPDATA is empty".into()); }
    Ok(PathBuf::from(root).join("YaseirManager").join("autostart-user-choice"))
}

pub fn settings_path() -> PathBuf {
    manager_data_root().join("settings.json")
}

pub fn agent_config_path() -> PathBuf {
    agent_data_root().join("config.yaml")
}

pub fn manager_log_dir() -> PathBuf {
    manager_data_root().join("logs")
}

pub fn manager_log_path() -> PathBuf {
    manager_log_dir().join("yaseir-manager.log")
}

pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

/// Fail-closed directory error: directory creation is where a missing
/// Administrator privilege surfaces first. State it explicitly so callers
/// (and the UI banner) can tell the operator to relaunch elevated instead
/// of showing a raw os error.
fn admin_required_error(what: &str, path: &Path, e: &std::io::Error) -> std::io::Error {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        std::io::Error::new(
            e.kind(),
            format!(
                "cannot create {what} ({}): access denied. Run the app as administrator",
                path.display()
            ),
        )
    } else {
        std::io::Error::new(
            e.kind(),
            format!("cannot create {what} ({}): {e}", path.display()),
        )
    }
}

pub fn ensure_runtime_dirs() -> std::io::Result<()> {
    ensure_manager_data_root()?;
    ensure_dir(&manager_log_dir())?;
    ensure_agent_data_root()?;
    Ok(())
}
