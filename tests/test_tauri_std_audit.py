"""Compile and execute the actual dependency-free Rust helpers offline."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_actual_rust_logging_and_process_identity(tmp_path):
    agent = (ROOT / "src-tauri/src/agent.rs").read_text()
    helpers = agent[agent.index("fn normalized_process_image("):agent.index("#[cfg(windows)]\nfn expected_agent_image(")]
    identity_tests = agent[agent.index("#[cfg(test)]\nmod image_identity_audit_tests"):]
    logging = (ROOT / "src-tauri/src/logging.rs").read_text()
    # Only the OS data-root boundary is substituted; logger code/tests stay intact.
    source = "mod paths { pub fn ensure_manager_data_root() -> std::io::Result<std::path::PathBuf> { Ok(std::env::temp_dir()) } }\n"
    source += "mod logging {\n" + logging + "\n}\n" + helpers + identity_tests
    rust_file = tmp_path / "actual_helpers.rs"
    binary = tmp_path / "actual_helpers"
    rust_file.write_text(source)
    built = subprocess.run(["rustc", "--edition=2021", "--test", str(rust_file), "-o", str(binary)], capture_output=True, text=True)
    assert built.returncode == 0, built.stderr
    ran = subprocess.run([str(binary)], capture_output=True, text=True)
    assert ran.returncode == 0, ran.stdout + ran.stderr
    assert "2 passed" in ran.stdout
