// Can also run with rustc --edition=2024 --test, using only installed std libraries.
use std::path::PathBuf;
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();
mod paths {
    pub fn ensure_manager_data_root() -> std::io::Result<std::path::PathBuf> {
        Ok(super::ROOT
            .get()
            .expect("test log root initialized")
            .clone())
    }

    pub fn ensure_manager_directory_security(_path: &std::path::Path) -> std::io::Result<()> {
        Ok(())
    }

    pub fn ensure_manager_file_security(_path: &std::path::Path) -> std::io::Result<()> {
        Ok(())
    }
}
#[path = "../src/logging.rs"]
mod logging;

#[test]
fn running_logger_rotates_without_restart() {
    let root = std::env::temp_dir().join(format!(
        "printing-audit-log-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    ROOT.set(root.clone()).unwrap();
    let path = logging::init().expect("initialize actual logger");
    logging::info(&"x".repeat(6 * 1024 * 1024));
    logging::warn("after rotation");
    logging::error("still writable");
    let previous_hook = std::panic::take_hook();
    logging::install_panic_hook();
    let panic_result = std::panic::catch_unwind(|| panic!("fixture panic reaches the log"));
    std::panic::set_hook(previous_hook);
    assert!(panic_result.is_err());
    assert!(std::path::PathBuf::from(format!("{}.1", path.display())).is_file());
    let active = std::fs::read_to_string(&path).unwrap();
    assert!(active.contains("after rotation"));
    assert!(active.contains("still writable"));
    assert!(active.contains("[PANIC]"));
    assert!(active.contains("fixture panic reaches the log"));
    assert!(active.len() < 1024);
    std::fs::remove_dir_all(root).unwrap();
}
