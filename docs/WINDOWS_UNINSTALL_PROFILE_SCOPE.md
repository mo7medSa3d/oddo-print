# Windows NSIS uninstall: account-scoped cleanup

## Confirmed CI failure and repair

The Windows NSIS smoke test for `74e50ff0cc7daccb78dcfcfa9b65c6c958d99030` installed and started the desktop Manager and Windows Agent service, passed the single-instance checks, and uninstalled the service. The remaining failure was an application-owned Tauri WebView2 user directory:

`%LOCALAPPDATA%\com.yasser.manager`

The existing Go `-service purge` helper removed only machine-wide `ProgramData` roots; by design it never visited **any** per-user folder. That left application-managed user data after an interactive uninstall, contradicting the current-user removal acceptance check.

The helper now reads **Windows Known Folders** for the **exact identity running the uninstaller**, and deletes only an explicit allowlist of Yaseir-named data directories under that identity's Local and Roaming AppData. `com.yasser.manager` is the current Tauri bundle ID in `src-tauri/tauri.conf.json`. ProgramData ownership checks and agent-service fencing are unchanged. The established root reparse/junction check is applied to all new product roots.

No installer process or service is killed by image name. The uninstaller does not walk `C:\Users`, modify arbitrary account profiles, trust inherited `APPDATA`/`LOCALAPPDATA` for elevated deletion, or sweep HKCU/HKU registry keys. When the uninstaller runs under LocalSystem/LocalService/NetworkService, it does not delete per-user profile data.

## Remaining operator limits

If UAC elevation switches from the normal interactive user to a **different administrator account**, only the elevated caller's own profile is within this cleanup scope. Other Windows accounts, roaming profiles, locked files, and disabled/unloaded profiles remain out of scope for machine-wide deletion. The operator must close running Manager/WebView sessions, inspect any reported purge warnings, and clean another account's data only with that account's authorization. Never broaden cleanup by recursive enumeration of all user profiles.

The GitHub Windows workflow checks **the runner's current account only** and reports a failure when its owned product data remain after uninstall. A passing workflow does not prove all multi-user Windows installations can be purged universally. Real paper output and physical printer acceptance are separate checks.
