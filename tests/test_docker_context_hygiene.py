from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_docker_context_excludes_generated_and_runtime_state():
    lines = {
        line.strip()
        for line in (ROOT / ".dockerignore").read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    required = {
        "dist-desktop",
        "src-tauri/target",
        "src-tauri/gen",
        "agent/agent.db",
        "agent/agent.db-*",
        "agent/sudo",
        "agent/*.exe",
        ".pytest_cache",
        "**/__pycache__",
        "**/*.pyc",
        "*.tsbuildinfo",
    }
    assert not (required - lines), f"missing Docker context exclusions: {sorted(required - lines)}"
    assert "tauri/target" not in lines, "obsolete Tauri target path hides the wrong directory"
