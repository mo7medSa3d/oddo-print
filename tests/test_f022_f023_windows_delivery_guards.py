"""F022 D04 and F023 D05 native-delivery source guards.

Source-contract checks only. No PowerShell execution, NSIS install or Tauri native runtime.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_f022_installer_only_advertises_verified_nsis_lifecycle():
    script = (ROOT / 'scripts/build-windows-installer.ps1').read_text(encoding='utf-8')
    tauri = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    assert tauri['bundle']['targets'] == ['nsis']
    assert tauri['bundle']['windows']['nsis']['installerHooks'].endswith('.nsh')
    assert re.search(r'\[ValidateSet\("nsis"\)\]\s*\[string\]\$Bundles\s*=\s*"nsis"', script)
    # Invoke exactly the NSIS target via the argument array, with an explicit
    # signing overlay only when a certificate is available. The old literal
    # command no longer captures the signing config required by the bundler.
    assert '$buildArgs = @("tauri", "build", "--target", $Target, "--bundles", $Bundles)' in script
    assert '& cargo @buildArgs' in script
    assert '$buildArgs += @("--config", $tauriSigningConfig)' in script
    assert 'if ($Bundles -match "msi")' not in script
    assert 'NSIS/MSI' not in script
    assert 'bundle\\msi\\Yaseir Print Manager_' not in script
    # Clearing leftover bundles is permitted; producing/advertising MSI is not.


def test_f023_manager_window_close_is_owned_by_native_runtime():
    # The main window's native CloseRequested event is handled in Rust and
    # exits the manager. Exposing core:window:allow-close to the WebView is
    # unnecessary privilege and would reintroduce a second close path.
    main = (ROOT / 'src-tauri/src/main.rs').read_text(encoding='utf-8')
    ipc = (ROOT / 'src/desktop/lib/ipc.ts').read_text(encoding='utf-8')
    acl = json.loads((ROOT / 'src-tauri/capabilities/default.json').read_text(encoding='utf-8'))
    assert 'win.on_window_event(' in main
    assert 'tauri::WindowEvent::CloseRequested' in main
    assert 'app_handle.exit(0)' in main
    assert 'getCurrentWindow().close()' not in ipc
    assert 'core:window:allow-close' not in acl['permissions']
    assert acl['windows'] == ['main']
