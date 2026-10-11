"""Source contract: Manager version must never impersonate Agent build info.

A live Windows service version/provenance test remains necessary: the bundled
binary on disk can differ from a still-running pre-upgrade service process.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_desktop_agent_version_from_bundled_agent_marker_not_manager_version():
    source = (ROOT / "src-tauri/src/commands.rs").read_text()
    marker = source.split("fn bundled_agent_build_marker(", 1)[1].split("\n#[tauri::command]", 1)[0]
    get_status = source.split("pub async fn get_agent_status(", 1)[1].split("\n#[tauri::command]", 1)[0]
    assert 'cmd.arg("-version")' in marker
    assert 'agent::agent_path(app)' in marker
    assert 'agent::run_bounded_command(' in marker
    assert 'version: "unavailable".into()' in get_status
    assert "bundled_agent_build_marker(&app)" in get_status
    assert 'env!("CARGO_PKG_VERSION")' not in get_status


def test_desktop_agent_version_truthfully_labelled_disk_not_running_service():
    en = (ROOT / "src/i18n/messages/en.ts").read_text()
    ar = (ROOT / "src/i18n/messages/ar.ts").read_text()
    view = (ROOT / "src/desktop/pages/Agents.tsx").read_text()
    assert '"desktop.agents.version": "Bundled Agent build (disk)"' in en
    assert '"desktop.agents.version": "نسخة الوكيل المُرفَقة (على القرص)"' in ar
    assert 'anyStatus?.version || s.version' not in view
