// Can also run directly with rustc --test, using only installed std libraries.
use std::path::PathBuf;
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();
mod paths {
    pub fn ensure_manager_data_root() -> std::io::Result<std::path::PathBuf> {
        Ok(super::ROOT.get().expect("test log root initialized").clone())
    }
}
#[path = "../src/logging.rs"]
mod logging;

#[test]
fn running_logger_rotates_without_restart() {
    let root = std::env::temp_dir().join(format!("printing-audit-log-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    ROOT.set(root.clone()).unwrap();
    let path = logging::init().expect("initialize actual logger");
    logging::info(&"x".repeat(6 * 1024 * 1024));
    logging::warn("after rotation");
    logging::error("still writable");
    assert!(std::path::PathBuf::from(format!("{}.1", path.display())).is_file());
    let active = std::fs::read_to_string(&path).unwrap();
    assert!(active.contains("after rotation"));
    assert!(active.contains("still writable"));
    assert!(active.len() < 1024);
    std::fs::remove_dir_all(root).unwrap();
}
