from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def kebab(command: str) -> str:
    return command.replace("_", "-")


def test_tauri_invoke_handler_commands_are_manifested_and_capability_allowed():
    main = read("src-tauri/src/main.rs")
    build = read("src-tauri/build.rs")
    caps = json.loads(read("src-tauri/capabilities/default.json"))

    handler_match = re.search(
        r"\.invoke_handler\(tauri::generate_handler!\[(.*?)\]\)",
        main,
        re.S,
    )
    assert handler_match, "Tauri invoke_handler block not found"
    handler_commands = re.findall(
        r"(?:commands|cleanup|tray)::([A-Za-z0-9_]+)",
        handler_match.group(1),
    )
    assert handler_commands, "No application commands found in invoke_handler"

    manifest_match = re.search(
        r"const COMMANDS: &\[&str\] = &\[(.*?)\];",
        build,
        re.S,
    )
    assert manifest_match, "Tauri app manifest command list not found"
    manifested = set(re.findall(r'"([A-Za-z0-9_]+)"', manifest_match.group(1)))
    permissions = set(caps["permissions"])

    missing_manifest = sorted(set(handler_commands) - manifested)
    missing_permissions = sorted(
        command
        for command in handler_commands
        if f"allow-{kebab(command)}" not in permissions
    )

    assert not missing_manifest, (
        "invoke_handler commands missing from tauri-build AppManifest: "
        + ", ".join(missing_manifest)
    )
    assert not missing_permissions, (
        "invoke_handler commands missing from main-window capabilities: "
        + ", ".join(missing_permissions)
    )


def test_gateway_probe_command_is_exposed_to_the_main_window():
    build = read("src-tauri/build.rs")
    caps = json.loads(read("src-tauri/capabilities/default.json"))
    assert '"probe_gateway_health"' in build
    assert "allow-probe-gateway-health" in caps["permissions"]
