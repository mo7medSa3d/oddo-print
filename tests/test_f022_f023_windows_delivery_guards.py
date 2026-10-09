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
    assert 'cargo tauri build --target $Target --bundles $Bundles' in script
    assert 'if ($Bundles -match "msi")' not in script
    assert 'NSIS/MSI' not in script
    assert 'bundle\\msi\\Yaseir Print Manager_' not in script
    # Clearing leftover bundles is permitted; producing/advertising MSI is not.


def test_f023_manager_window_close_requires_explicit_tauri_acl():
    ipc = (ROOT / 'src/desktop/lib/ipc.ts').read_text(encoding='utf-8')
    dialog = (ROOT / 'src/desktop/components/AdminPrivilegeDialog.tsx').read_text(encoding='utf-8')
    acl = json.loads((ROOT / 'src-tauri/capabilities/default.json').read_text(encoding='utf-8'))
    assert 'getCurrentWindow().close()' in ipc
    assert 'await onRelaunch();' in dialog and 'await closeApp();' in dialog
    assert dialog.index('await onRelaunch();') < dialog.index('await closeApp();')
    assert 'core:window:allow-close' in acl['permissions']
    assert acl['windows'] == ['main']
