"""Compile/run actual std-only native pipe helpers without Tauri dependency stubs.

The full locked Cargo graph/native Windows acceptance has its own gate. This
focused harness uses the identical production functions and embedded Rust tests.
"""
from pathlib import Path
import os
import re
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_actual_native_gateway_pipe_helpers(tmp_path):
    toolchain = (ROOT / "src-tauri/rust-toolchain.toml").read_text(encoding="utf-8")
    pinned = re.search(r'^channel\s*=\s*"([^"\s]+)"', toolchain, re.M).group(1)
    tool_root = Path(os.environ.get("RUSTUP_HOME") or Path.home() / ".rustup")
    compiler_name = "rustc.exe" if os.name == "nt" else "rustc"
    compilers = list(tool_root.glob(f"toolchains/{pinned}-*/bin/{compiler_name}"))
    if not compilers:
        pytest.skip("UNVERIFIED: pinned native rustc is not cached; no toolchain download permitted")
    source = (ROOT / "src-tauri/src/agent.rs").read_text(encoding="utf-8")
    begin = source.index("type JoinedCommandIo =")
    end = source.index("fn resource_dir(", begin)
    tests_begin = source.index("#[cfg(test)]\nmod command_io_tests {")
    tests_end = source.find("\n#[cfg(test)]\nmod ", tests_begin + 1)
    if tests_end < 0:
        tests_end = len(source)
    # Only std imports are needed by this exact production-function slice;
    # no replacement Tauri/API implementation is injected.
    imports = "use std::io::{Read, Write};\nuse std::process::{Command, Stdio};\nuse std::sync::Arc;\nuse std::sync::atomic::{AtomicBool, Ordering};\n"
    harness = tmp_path / "gateway_io.rs"
    harness.write_text(imports + source[begin:end] + source[tests_begin:tests_end], encoding="utf-8")
    executable = tmp_path / ("gateway_io.exe" if os.name == "nt" else "gateway_io")
    build = subprocess.run([str(compilers[0]), "--edition=2024", "--test", str(harness), "-o", str(executable)], encoding="utf-8", capture_output=True, timeout=60)
    assert build.returncode == 0, build.stdout + build.stderr
    result = subprocess.run([str(executable), "--nocapture"], encoding="utf-8", capture_output=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "8 passed; 0 failed" in result.stdout, result.stdout
