# AUDIT FINDINGS

## DEP-001
- **ID:** DEP-001
- **Severity:** P1
- **Subsystem:** Gateway / web dependency supply chain
- **File/location:** `package.json`, `package-lock.json`
- **Problem:** Production pinned Next.js 16.3.6 while 16.3.8 contains a high-severity SSRF fix in Image Optimization (GHSA-cjq9-62q9-8jv4), plus additional security fixes.
- **Root cause:** Security patch release not integrated into `main`.
- **Affected flows:** Next.js production Gateway.
- **Fix strategy:** Update Next.js and matching lockfile.
- **Status:** FIXED — PR verification pending.

## DESK-001
- **ID:** DESK-001
- **Severity:** P1
- **Subsystem:** Desktop / Tauri authorization
- **File/location:** `src-tauri/capabilities/default.json`; `src-tauri/src/main.rs`; `src/desktop/lib/ipc.ts`
- **Problem:** UI invokes `relaunch_as_admin` and Rust registers it, but main-window capability omitted `allow-relaunch-as-admin`.
- **Root cause:** IPC command registry and capability allowlist drift.
- **Affected flows:** Administrator relaunch; privileged Agent service installation/repair/start.
- **Fix strategy:** Grant exact command permission only.
- **Status:** FIXED — PR verification pending.

## DESK-003
- **ID:** DESK-003
- **Severity:** P1
- **Subsystem:** Desktop / Tauri Gateway configuration
- **File/location:** `src-tauri/capabilities/default.json`; `src-tauri/src/commands.rs`; `src/desktop/lib/ipc.ts`
- **Problem:** Settings invokes `probe_gateway_health` before persisting a candidate Gateway URL, but the main-window capability omitted `allow-probe-gateway-health`.
- **Root cause:** IPC command registry and capability allowlist drift.
- **Affected flows:** Desktop Gateway URL validation/configuration; valid Gateway domains can be rejected before the Rust probe executes.
- **Fix strategy:** Grant exact health-probe command permission only.
- **Status:** FIXED — PR verification pending.

## DESK-002
- **ID:** DESK-002
- **Severity:** P3
- **Subsystem:** Desktop / Tauri localization
- **File/location:** `src-tauri/capabilities/default.json`; `src-tauri/src/tray.rs`; `src/desktop/lib/ipc.ts`
- **Problem:** UI invokes `set_tray_locale` but capability omitted `allow-set-tray-locale`.
- **Root cause:** IPC command registry and capability allowlist drift.
- **Affected flows:** Native tray English/Arabic synchronization.
- **Fix strategy:** Grant exact tray-locale command.
- **Status:** FIXED — PR verification pending.

## Verification note — current main CodeQL
Latest Static Security Gates failed in the three CodeQL language jobs because GitHub improved incremental analysis/cache did not complete successfully after analysis/SARIF generation. Secret Scan passed. A fresh audit-PR run is required.
