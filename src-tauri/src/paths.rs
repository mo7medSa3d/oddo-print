use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(windows)]
use std::process::Command;

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
    if let Err(e) = ensure_manager_directory_security(&primary) {
        return Err(admin_required_error("secure manager data dir", &primary, &e));
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
            let legacy = PathBuf::from(&pd).join("YasserAgent");
            let very_legacy = PathBuf::from(&pd).join("OdooPrintAgent");

            if canonical.join("config.yaml").is_file() {
                return canonical;
            }
            if legacy.join("config.yaml").is_file() {
                return legacy;
            }
            if very_legacy.join("config.yaml").is_file() {
                return very_legacy;
            }

            // No paired config exists yet. Preserve any existing writable data
            // root before creating a new canonical one.
            if canonical.exists() {
                return canonical;
            }
            if legacy.exists() {
                return legacy;
            }
            if very_legacy.exists() {
                return very_legacy;
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

#[cfg(windows)]
fn windows_system32_exe(name: &str) -> PathBuf {
    let root = std::env::var_os("WINDIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(name)
}

#[cfg(windows)]
fn reject_windows_reparse_point(path: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "refusing manager runtime path through a Windows reparse point: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn run_icacls(path: &Path, args: &[&str]) -> std::io::Result<()> {
    let output = Command::new(windows_system32_exe("icacls.exe"))
        .arg(path)
        .args(args)
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        if detail.is_empty() {
            format!("icacls failed for {}", path.display())
        } else {
            format!("icacls failed for {}: {detail}", path.display())
        },
    ))
}

#[cfg(windows)]
fn manager_path_owned_by_administrators(path: &Path) -> std::io::Result<bool> {
    use std::os::windows::ffi::OsStrExt;

    type RawHandle = *mut std::ffi::c_void;
    const SE_FILE_OBJECT: u32 = 1;
    const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
    const WIN_BUILTIN_ADMINISTRATORS_SID: i32 = 26;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetNamedSecurityInfoW(
            object_name: *const u16,
            object_type: u32,
            security_info: u32,
            owner: *mut RawHandle,
            group: *mut RawHandle,
            dacl: *mut RawHandle,
            sacl: *mut RawHandle,
            security_descriptor: *mut RawHandle,
        ) -> u32;
        fn IsWellKnownSid(sid: RawHandle, well_known_sid_type: i32) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: RawHandle) -> RawHandle;
    }

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut owner: RawHandle = std::ptr::null_mut();
    let mut descriptor: RawHandle = std::ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let is_admin_owner =
        !owner.is_null() && unsafe { IsWellKnownSid(owner, WIN_BUILTIN_ADMINISTRATORS_SID) } != 0;
    if !descriptor.is_null() {
        unsafe {
            let _ = LocalFree(descriptor);
        }
    }
    Ok(is_admin_owner)
}

#[cfg(windows)]
fn manager_directory_is_writable(path: &Path) -> std::io::Result<bool> {
    for attempt in 0..8u32 {
        let probe = path.join(format!(
            ".yaseir-manager-acl-probe-{}-{attempt}",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
        {
            Ok(file) => {
                drop(file);
                let _ = std::fs::remove_file(&probe);
                return Ok(true);
            }
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique Manager ACL probe file",
    ))
}

#[cfg(windows)]
fn manager_file_is_writable(path: &Path) -> std::io::Result<bool> {
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => {
            drop(file);
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn verify_windows_manager_readonly_security(path: &Path, is_directory: bool) -> std::io::Result<()> {
    reject_windows_reparse_point(path)?;
    if !manager_path_owned_by_administrators(path)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "Manager runtime path is not owned by BUILTIN\\Administrators: {}",
                path.display()
            ),
        ));
    }
    let writable = if is_directory {
        manager_directory_is_writable(path)?
    } else {
        manager_file_is_writable(path)?
    };
    if writable {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "Manager runtime path is writable by the current non-elevated user: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_windows_manager_acl(path: &Path, is_directory: bool) -> std::io::Result<()> {
    reject_windows_reparse_point(path)?;

    // A pre-created ProgramData directory can otherwise retain an untrusted
    // owner who may rewrite its DACL later. Move ownership to Administrators
    // before replacing inherited permissions. SIDs avoid localized account
    // names on non-English Windows installations.
    let harden = (|| {
        run_icacls(path, &["/setowner", "*S-1-5-32-544"])?;
        if is_directory {
            run_icacls(
                path,
                &[
                    "/inheritance:r",
                    "/grant:r",
                    "*S-1-5-18:(OI)(CI)F",
                    "*S-1-5-32-544:(OI)(CI)F",
                    "*S-1-5-32-545:(OI)(CI)RX",
                ],
            )
        } else {
            run_icacls(
                path,
                &[
                    "/inheritance:r",
                    "/grant:r",
                    "*S-1-5-18:F",
                    "*S-1-5-32-544:F",
                    "*S-1-5-32-545:R",
                ],
            )
        }
    })();

    match harden {
        Ok(()) => Ok(()),
        // Normal standard-user launches cannot rewrite a protected DACL. They
        // may still read the Manager configuration, but only after proving the
        // path is owned by Administrators, is not a reparse point, and is not
        // writable by the current user. This preserves the desktop's
        // non-elevated read-only UX without reopening the pre-creation attack.
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            verify_windows_manager_readonly_security(path, is_directory)
        }
        Err(e) => Err(e),
    }
}

/// Harden a Manager-owned directory. On Windows, SYSTEM and Administrators
/// retain full control while standard Users are read/execute only. A
/// non-elevated caller may use an already-secure read-only path after verifying
/// its owner and effective write denial.
pub fn ensure_manager_directory_security(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        return ensure_windows_manager_acl(path, true);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(())
    }
}

/// Harden an existing Manager-owned file before trusting its contents.
pub fn ensure_manager_file_security(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        return ensure_windows_manager_acl(path, false);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(())
    }
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
