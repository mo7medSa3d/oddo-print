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

fn development_data_override(names: &[&str]) -> Option<PathBuf> {
    // A packaged/elevated Windows process must not take privileged filesystem
    // roots from the invoking user's inherited environment. Keep overrides for
    // tests/debug builds and non-Windows development only.
    #[cfg(windows)]
    if !cfg!(debug_assertions) && !cfg!(test) {
        return None;
    }
    for name in names {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_program_data_root() -> PathBuf {
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    // FOLDERID_ProgramData = {62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}
    const FOLDERID_PROGRAM_DATA: Guid = Guid {
        data1: 0x62ab5d82,
        data2: 0xfdc1,
        data3: 0x4dc3,
        data4: [0xa9, 0xdd, 0x07, 0x0d, 0x1d, 0x49, 0x5d, 0x97],
    };
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetKnownFolderPath(
            rfid: *const Guid,
            flags: u32,
            token: *mut c_void,
            path: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(memory: *mut c_void);
    }

    let mut raw: *mut u16 = std::ptr::null_mut();
    let hr = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_PROGRAM_DATA,
            0,
            std::ptr::null_mut(),
            &mut raw,
        )
    };
    if hr >= 0 && !raw.is_null() {
        let mut len = 0usize;
        while len < 32_768 && unsafe { *raw.add(len) } != 0 {
            len += 1;
        }
        let value = if len < 32_768 {
            Some(PathBuf::from(OsString::from_wide(unsafe {
                std::slice::from_raw_parts(raw, len)
            })))
        } else {
            None
        };
        unsafe { CoTaskMemFree(raw.cast()) };
        if let Some(path) = value.filter(|path| !path.as_os_str().is_empty()) {
            return path;
        }
    } else if !raw.is_null() {
        unsafe { CoTaskMemFree(raw.cast()) };
    }
    // Fail closed to the standard machine location rather than consulting an
    // inherited PROGRAMDATA variable when Known Folder resolution fails.
    PathBuf::from(r"C:\ProgramData")
}

fn manager_data_root_candidate() -> PathBuf {
    if let Some(path) = development_data_override(&[
        "YASEIR_MANAGER_DATA_DIR",
        "YASSER_MANAGER_DATA_DIR",
        "ODOO_PRINT_MANAGER_DATA_DIR",
    ]) {
        return path;
    }
    #[cfg(windows)]
    {
        let pd = windows_program_data_root();
        let canonical = pd.join("YaseirManager");
        if canonical.exists() {
            return canonical;
        }
        let legacy = pd.join("YasserManager");
        if legacy.exists() {
            return legacy;
        }
        return canonical;
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
    if let Some(path) = development_data_override(&[
        "YASEIR_AGENT_DATA_DIR",
        "YASSER_AGENT_DATA_DIR",
        "ODOO_PRINT_AGENT_DATA_DIR",
    ]) {
        return path;
    }
    #[cfg(windows)]
    {
        let pd = windows_program_data_root();
        let canonical = pd.join("YaseirAgent");
        let legacy = pd.join("YasserAgent");
        let very_legacy = pd.join("OdooPrintAgent");

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
pub fn windows_system32_exe(name: &str) -> std::io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    if name.is_empty() || name.contains('\\') || name.contains('/') {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid Windows system executable name",
        ));
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }

    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if length as usize >= buffer.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Windows system directory path is too long",
        ));
    }
    let root = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
    let path = root.join(name);
    if !path.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Windows system executable not found: {}", path.display()),
        ));
    }
    Ok(path)
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
    // Bounded like every other privileged subprocess: an unbounded .output()
    // would hang the caller on a wedged helper with no deadline.
    let mut cmd = Command::new(windows_system32_exe("icacls.exe")?);
    cmd.arg(path).args(args);
    let output = crate::agent::run_bounded_command(
        cmd,
        std::time::Duration::from_secs(30),
        64 * 1024,
        64 * 1024,
    )
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::TimedOut, e))?;
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
    // A pre-existing explicit grant for ANOTHER user is invisible to the
    // writability probe above (it only tests the current user) yet leaves
    // the shared trust root mutable. The exact-DACL check below rejects it.
    verify_windows_manager_dacl_exact(path, is_directory)?;
    Ok(())
}

/// Trustee classes permitted on Manager trust roots. Anything else holding
/// an allow ACE is an unexpected grant (for example a pre-created explicit
/// FullControl ACE that `/grant:r` never touches, since it only replaces
/// grants for the SIDs it names).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ManagerTrustee {
    System,
    Administrators,
    Users,
    Other,
}

/// Classify a raw SID by value: S-1-5-18 (SYSTEM), S-1-5-32-544
/// (Administrators), S-1-5-32-545 (Users). Pure byte logic, no OS calls, so
/// the classification itself is unit-testable on any platform.
fn well_known_manager_trustee(sid: &[u8]) -> ManagerTrustee {
    if sid.len() < 8 || sid[0] != 1 || sid[2..8] != [0, 0, 0, 0, 0, 5] {
        return ManagerTrustee::Other;
    }
    let count = sid[1] as usize;
    if sid.len() != 8 + 4 * count {
        return ManagerTrustee::Other;
    }
    let sub = |i: usize| {
        u32::from_le_bytes([sid[8 + 4 * i], sid[8 + 4 * i + 1], sid[8 + 4 * i + 2], sid[8 + 4 * i + 3]])
    };
    if count == 1 && sub(0) == 18 {
        return ManagerTrustee::System;
    }
    if count == 2 && sub(0) == 32 && sub(1) == 544 {
        return ManagerTrustee::Administrators;
    }
    if count == 2 && sub(0) == 32 && sub(1) == 545 {
        return ManagerTrustee::Users;
    }
    ManagerTrustee::Other
}

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;

/// Write-class rights that must never be granted to anyone outside
/// SYSTEM/Administrators on a Manager trust root, regardless of how the
/// granting ACE encodes them (generic, standard or object-specific bits).
/// Note 0x8 is FILE_READ_EA (harmless read); the write bit is 0x10.
const MANAGER_WRITE_MASK: u32 = 0x4000_0000 // GENERIC_WRITE
    | 0x1000_0000 // GENERIC_ALL
    | 0x0100_0000 // ACCESS_SYSTEM_SECURITY
    | 0x0004_0000 // WRITE_DAC
    | 0x0008_0000 // WRITE_OWNER
    | 0x0001_0000 // DELETE
    | 0x0000_0002 // FILE_WRITE_DATA / FILE_ADD_FILE
    | 0x0000_0004 // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
    | 0x0000_0010 // FILE_WRITE_EA
    | 0x0000_0040 // FILE_DELETE_CHILD
    | 0x0000_0100; // FILE_WRITE_ATTRIBUTES

/// Verify that every allow ACE on a Manager trust root belongs to the
/// intended trustee set with safe rights. Deny ACEs restrict access and grant
/// nothing, so they are ignored here. Pure logic over already-read entries,
/// unit-testable on any platform.
fn verify_manager_dacl_entries(
    entries: &[(ManagerTrustee, u32, u8)],
    context: &str,
) -> Result<(), String> {
    for (trustee, mask, ace_type) in entries {
        if *ace_type != ACCESS_ALLOWED_ACE_TYPE {
            continue;
        }
        match trustee {
            ManagerTrustee::System | ManagerTrustee::Administrators => {}
            ManagerTrustee::Users => {
                if mask & MANAGER_WRITE_MASK != 0 {
                    return Err(format!(
                        "standard Users hold write rights (mask {mask:#010x}) on {context}"
                    ));
                }
            }
            ManagerTrustee::Other => {
                return Err(format!(
                    "unexpected trustee holds an allow ACE (mask {mask:#010x}) on {context}"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn read_manager_dacl_entries(path: &Path) -> std::io::Result<Vec<(ManagerTrustee, u32, u8)>> {
    use std::os::windows::ffi::OsStrExt;

    type RawHandle = *mut std::ffi::c_void;
    const SE_FILE_OBJECT: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const ACL_SIZE_INFORMATION_CLASS: u32 = 2;

    #[repr(C)]
    struct AclSizeInformation {
        ace_count: u32,
        _acl_bytes_in_use: u32,
        _acl_bytes_free: u32,
    }

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
        fn GetAclInformation(
            acl: RawHandle,
            info: *mut std::ffi::c_void,
            length: u32,
            class: u32,
        ) -> i32;
        fn GetAce(acl: RawHandle, index: u32, ace: *mut RawHandle) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: RawHandle) -> RawHandle;
    }

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut dacl: RawHandle = std::ptr::null_mut();
    let mut descriptor: RawHandle = std::ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let result = (|| {
        if dacl.is_null() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Manager runtime path has no DACL (unprotected discretionary access)",
            ));
        }
        let mut size_info = AclSizeInformation {
            ace_count: 0,
            _acl_bytes_in_use: 0,
            _acl_bytes_free: 0,
        };
        let ok = unsafe {
            GetAclInformation(
                dacl,
                &mut size_info as *mut AclSizeInformation as *mut std::ffi::c_void,
                std::mem::size_of::<AclSizeInformation>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut entries = Vec::with_capacity(size_info.ace_count as usize);
        for index in 0..size_info.ace_count {
            let mut ace: RawHandle = std::ptr::null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // ACCESS_ALLOWED_ACE layout: ACE_HEADER (type u8, flags u8,
            // size u16), Mask u32, then the trustee SID.
            let bytes = unsafe { std::slice::from_raw_parts(ace as *const u8, 8) };
            let ace_type = bytes[0];
            let mask = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
            // SID header: revision + sub-authority count at ACE offset 8.
            // Cap the count at the architectural SID maximum (15) so a
            // malformed ACE cannot drive an unbounded read.
            let count = unsafe { *((ace as *const u8).add(9)) } as usize;
            if count > 15 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Manager runtime path has a malformed ACE",
                ));
            }
            let sid_len = 8 + 4 * count;
            if sid_len < 12 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Manager runtime path has a malformed ACE",
                ));
            }
            let sid_bytes = unsafe { std::slice::from_raw_parts((ace as *const u8).add(8), sid_len) };
            entries.push((well_known_manager_trustee(sid_bytes), mask, ace_type));
        }
        Ok(entries)
    })();
    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[cfg(windows)]
fn verify_windows_manager_dacl_exact(path: &Path, is_directory: bool) -> std::io::Result<()> {
    let kind = if is_directory { "directory" } else { "file" };
    let entries = read_manager_dacl_entries(path)?;
    verify_manager_dacl_entries(&entries, kind).map_err(|detail| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("Manager runtime {} has an unexpected DACL ({}): {detail}", kind, path.display()),
        )
    })
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
        Ok(()) => {
            // icacls /grant:r replaces grants only for the SIDs it names: a
            // pre-existing explicit grant for any other trustee survives
            // hardening. Verify the installed DACL is exactly the intended
            // one instead of trusting the subprocess exit code.
            verify_windows_manager_dacl_exact(path, is_directory)
        }
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

#[cfg(test)]
mod manager_dacl_tests {
    use super::{well_known_manager_trustee, verify_manager_dacl_entries, ManagerTrustee};

    fn sid(subauthorities: &[u32]) -> Vec<u8> {
        let mut out = vec![1u8, subauthorities.len() as u8, 0, 0, 0, 0, 0, 5];
        for sub in subauthorities {
            out.extend_from_slice(&sub.to_le_bytes());
        }
        out
    }

    #[test]
    fn well_known_sids_classify_by_value() {
        assert_eq!(well_known_manager_trustee(&sid(&[18])), ManagerTrustee::System);
        assert_eq!(
            well_known_manager_trustee(&sid(&[32, 544])),
            ManagerTrustee::Administrators
        );
        assert_eq!(
            well_known_manager_trustee(&sid(&[32, 545])),
            ManagerTrustee::Users
        );
        // Everyone, malformed headers and truncated buffers are Other.
        assert_eq!(well_known_manager_trustee(&sid(&[0])), ManagerTrustee::Other);
        assert_eq!(well_known_manager_trustee(&[1, 1, 0]), ManagerTrustee::Other);
        assert_eq!(well_known_manager_trustee(&[]), ManagerTrustee::Other);
        assert_eq!(
            well_known_manager_trustee(&sid(&[32, 544])[..15]),
            ManagerTrustee::Other
        );
    }

    #[test]
    fn intended_manager_dacl_passes() {
        use super::ACCESS_ALLOWED_ACE_TYPE;
        let entries = [
            (ManagerTrustee::System, 0x001F_01FFu32, ACCESS_ALLOWED_ACE_TYPE),
            (ManagerTrustee::Administrators, 0x001F_01FFu32, ACCESS_ALLOWED_ACE_TYPE),
            (ManagerTrustee::Users, 0x0012_00A9u32, ACCESS_ALLOWED_ACE_TYPE),
        ];
        assert!(verify_manager_dacl_entries(&entries, "directory").is_ok());
    }

    #[test]
    fn third_party_full_control_grant_fails() {
        use super::ACCESS_ALLOWED_ACE_TYPE;
        let entries = [
            (ManagerTrustee::System, 0x001F_01FFu32, ACCESS_ALLOWED_ACE_TYPE),
            (ManagerTrustee::Administrators, 0x001F_01FFu32, ACCESS_ALLOWED_ACE_TYPE),
            (ManagerTrustee::Users, 0x0012_00A9u32, ACCESS_ALLOWED_ACE_TYPE),
            // Pre-created explicit grant for an unrelated trustee: this is
            // exactly what /grant:r leaves behind, and it must fail.
            (ManagerTrustee::Other, 0x001F_01FFu32, ACCESS_ALLOWED_ACE_TYPE),
        ];
        assert!(verify_manager_dacl_entries(&entries, "directory").is_err());
    }

    #[test]
    fn users_write_bits_fail() {
        use super::ACCESS_ALLOWED_ACE_TYPE;
        for mask in [
            0x0004_0000u32,
            0x0008_0000,
            0x4000_0000,
            0x1000_0000,
            0x0001_0000,
            0x0000_0010,
            0x0000_0040,
            0x0100_0000,
        ] {
            let entries = [(ManagerTrustee::Users, mask, ACCESS_ALLOWED_ACE_TYPE)];
            assert!(
                verify_manager_dacl_entries(&entries, "file").is_err(),
                "mask {mask:#x} must be rejected for Users"
            );
        }
    }

    #[test]
    fn deny_aces_grant_nothing_and_are_ignored() {
        let entries = [(ManagerTrustee::Other, 0x001F_01FFu32, 0x01u8)];
        assert!(verify_manager_dacl_entries(&entries, "file").is_ok());
    }

    /// Pre-created explicit FullControl for an unrelated trustee (S-1-1-0
    /// Everyone) must fail hardening: `/grant:r` only replaces grants for
    /// the SIDs it names, so the foreign ACE survives icacls and only the
    /// exact-DACL verification catches it. Reading a DACL needs no
    /// elevation, so the verification itself is asserted precisely; the
    /// end-to-end ensure call must fail either way (elevated: verification
    /// after hardening; standard user: untrusted path).
    #[cfg(windows)]
    #[test]
    fn precreated_third_party_grant_fails_hardening() {
        use super::{ensure_windows_manager_acl, verify_windows_manager_dacl_exact};
        let dir = std::env::temp_dir().join(format!(
            "yaseir-acl-audit-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("test temp dir");
        let grant = std::process::Command::new("icacls.exe")
            .arg(&dir)
            .arg("/grant")
            .arg("*S-1-1-0:(OI)(CI)F")
            .output()
            .expect("icacls grant");
        assert!(grant.status.success(), "test setup: pre-grant Everyone FullControl");
        let verify_err =
            verify_windows_manager_dacl_exact(&dir, true).expect_err("foreign FullControl grant must fail exact-DACL verification");
        assert!(
            verify_err.to_string().contains("unexpected trustee"),
            "unexpected error (wanted trustee rejection): {verify_err}"
        );
        ensure_windows_manager_acl(&dir, true)
            .expect_err("third-party FullControl grant must fail Manager hardening");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
