# Windows service and data uninstall ownership

The NSIS `POSTUNINSTALL` hook does **not** recursively delete arbitrary profile folders or inherited `%PROGRAMDATA%`, `%APPDATA%`, and `%LOCALAPPDATA%`. The signed, installed `YaseirAgent.exe -service purge` helper first verifies SCM registration identity and removes only known machine product directories rooted in the Windows Known Folder `FOLDERID_ProgramData`. It refuses an existing product root tagged as a reparse point. A failed service ownership or deletion check aborts uninstall before further destructive operations.

## Operator procedures (authorized Windows administrator)

1. Make a verified backup of the tenant's pairing/configuration and print troubleshooting data to an approved protected location before uninstall; record the application's installed executable path and authorized SCM service `ImagePath`.
2. Stop print submissions and verify all outstanding jobs/printing threads reach terminal state. Run the signed product uninstaller elevated. Do **not** set `PROGRAMDATA`, `APPDATA`, `LOCALAPPDATA`, `SystemDrive`, or `PATH` to influence cleanup.
3. If uninstall reports a foreign or uninspectable service, **stop**: do not delete by service name alone. Check `sc.exe qc <service>` and signatures/paths and resolve the service owner separately.
4. If a locked file or reparse-point error remains, do **not** use a recursive whole-profile/parent-folder deletion. Inspect with Windows Explorer/PowerShell as administrator, confirm the exact directory resolves within the trusted OS ProgramData location, confirm it is not a reparse point, inspect all nested links, confirm path and ACL ownership and independent backup, and remove only the confirmed product-owned residual directory after service stops. Do not automate this as an elevated broad fallback.
5. If per-user profile data must be removed, run an authenticated per-user process in *that profile*, separately confirming the folder/executable ownership. Never sweep `C:\Users` or HKU Run keys by a matching display name.
6. Reinstall/rollback only from signed, pinned, verified installers; restore config only for the intended tenant after service and path validation. Confirm service identity before enabling Agent requests.

## Remaining acceptance

Code review and portable contract tests are not a native uninstaller test. Validate on a disposable native Windows VM with (a) no service, (b) owned service, (c) unrelated same-name service, (d) redirected inherited environment roots, (e) product-named junction to a sentinel directory, (f) nested reparse/junction and concurrent path replacement, (g) locked data, (h) per-user data in another profile, (i) legacy service upgrade. Record actual file/service changes and rollback result. Fail closed for any uncertainty; do not treat a Windows cross-build as proof of safe deletion.
