# Windows Service Recovery — Enterprise Grade

## Overview
The Go agent and Tauri manager must survive crashes, restarts, and host reboots. This doc defines SCM (Service Control Manager) recovery, state reporting, and testing.

## Official References
- Microsoft SCM: https://learn.microsoft.com/en-us/windows/win32/services/service-control-manager
- Failure actions: https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa
- Recovery actions: restart service, run program, restart computer
- The Go Agent owns Windows SCM registration/recovery through `github.com/kardianos/service`; the Tauri Manager supervises that service or an owned background `YaseirAgent.exe` process and does not replace the Agent's SCM implementation.

## Service Definition
- Service Name: `YaseirAgent` (matches the `service.Config{Name: "YaseirAgent"}` registration in `agent/cmd/agent/main.go` and the `SERVICE_NAME` constant in `src-tauri/src/agent.rs`)
- Display Name: `Yaseir Agent`
- Start Type: Automatic (delayed start allowed)
- Dependencies: `Tcpip` (matches the actual `Dependencies: []string{"Tcpip"}` in `main.go`; the Windows Print Spooler is a runtime requirement only when the optional `spooler` transport is used)
- Binary: `YaseirAgent.exe` with config path (produced by `build-windows.yml` as `YaseirAgent.exe`)
- Log On As: `LocalSystem` or dedicated service account with `SeServiceLogonRight` and printer access

### Printer visibility is security-context scoped

Windows printer connections are not a machine-global inventory. `PRINTER_ENUM_LOCAL` covers queues available in the Agent process context; `PRINTER_ENUM_CONNECTIONS` covers connections for that context, not arbitrary signed-in desktop users. A LocalSystem service running in Session 0 must therefore **not** assume it sees the same connected queues or network credentials as an interactive user. The Agent marks interactive-user connected queues as discovery-only when they cannot be proved executable from Session 0. For production, install/share the queue for the service account or use a dedicated service account that has the required printer/network permissions. An `OpenPrinterW` access failure is reported as queue/access **unknown**, not proof that the physical printer is Offline.

## Failure Actions (SCM)
The Go Agent applies these recovery actions automatically through the native Windows SCM API on `YaseirAgent.exe -service install` (see `configureServiceRecovery` in `agent/cmd/agent/service_install_windows.go`). The commands below are operator diagnostics/examples only:
```
sc failure YaseirAgent reset= 86400 actions= restart/60000/restart/60000/restart/60000
sc failureflag YaseirAgent 1
```
- First failure: restart after 60s
- Second failure: restart after 60s
- Subsequent: restart after 60s
- Reset failure count after 86400s (1 day)
- Failure flag: enabled (failure actions on non-crash failures too)

## State Model
Expose via `/api/agents/health` and Tauri manager UI:
- Service State: Running / Stopped / Paused / Start Pending / Stop Pending
- Start Type: Automatic / Manual / Disabled / Automatic (Delayed)
- Recovery: Restart on failure (with delays)
- Last Restart: timestamp
- Failure Count: number since reset
- Exit Code: last exit code (0 = clean, non-zero = crash)
- Uptime: seconds

## Implementation in Go Agent
- The agent uses `github.com/kardianos/service` (see `agent/cmd/agent/main.go`) with
  `service.Config{Name: "YaseirAgent"}` — not the raw `golang.org/x/sys/windows/svc`
  handle. `program.Start/Stop` implement the service interface.
- Handle `Stop`/`Shutdown` controls via the kardianos `service.Service` contract
- On stop, graceful shutdown is bounded by the Agent's `shutdownGrace = 25s`; it cancels the runtime, drains/joins owned work, closes the local queue, and returns control to the service manager.
- Recovery actions are applied automatically on install via `configureServiceRecovery` and `mgr.Service.SetRecoveryActions` after verifying the service `BinaryPathName` belongs to this installation. No inherited `SystemRoot`, `WINDIR`, or `PATH` lookup is used for this privileged mutation; recovery-policy update failure remains warn-only after a valid service installation.
- No separate heartbeat file / external watchdog exists; liveness is the Gateway
  heartbeat (`POST /api/agent/heartbeat`) plus SCM state.

## Implementation in Tauri (Desktop Manager)
- Tauri exposes `get_agent_status` for local service/process state and `control_service` for install/uninstall/start/stop/restart operations. Start/stop/status service control is delegated to the bundled Agent CLI, which verifies the SCM `BinaryPathName` belongs to the current install before mutating or presenting that registration as owned.
- `start_agent` / `stop_agent` / `restart_agent` run through the Tauri blocking pool so process and service control does not block the WebView UI thread.
- Background process ownership is recorded by PID plus process creation time and canonical image path; stop refuses to kill an unowned or identity-mismatched PID.

## Kill → Restart → Reconnect Test
Manual test for client demo:
1. Start agent as service: `sc start YaseirAgent`
2. Verify Gateway sees agent ONLINE via `/api/agents/health`
3. Kill process: `taskkill /F /PID <pid>` or `Stop-Process -Id <pid> -Force`
4. Wait for SCM recovery (60s): `sc query YaseirAgent` should show RUNNING again
5. Verify new PID, check failure count incremented: `sc qfailure YaseirAgent`
6. Verify Gateway sees agent ONLINE again within 90s (heartbeat)
7. Verify queue depth preserved (jobs not lost)
8. Verify printer status still reported

Controlled crash/recovery drill (isolated Windows staging VM only; deliberately destructive):

The operator **must not** select a process by image name. The snippet reads
SCM's exact running service PID and executable path, then rechecks that exact
PID, process creation timestamp, and image path immediately before the forced
crash. If SCM reports an unquoted/ambiguous executable or identity changes,
the drill aborts instead of guessing. This is not an application start/stop
implementation, and is **not** an approved production automation.

```powershell
$svc = Get-CimInstance Win32_Service -Filter "Name='YaseirAgent'"
if (-not $svc -or $svc.State -ne 'Running' -or $svc.ProcessId -le 0) {
  throw 'Expected the owned YaseirAgent SCM service to be running'
}
$match = [regex]::Match($svc.PathName, '^"(?<exe>[^"]+\.exe)"(?:\s|$)')
if (-not $match.Success) { throw 'Ambiguous/unquoted SCM executable path; abort' }
$scmImage = [IO.Path]::GetFullPath($match.Groups['exe'].Value)
$ownedPid = [int]$svc.ProcessId
$before = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid"
if (-not $before -or [IO.Path]::GetFullPath($before.ExecutablePath) -ine $scmImage) {
  throw 'SCM-owned executable identity mismatch; abort'
}
$confirm = Read-Host 'Type YaseirAgent to force-crash this verified staging service'
if ($confirm -cne 'YaseirAgent') { throw 'Drill canceled' }
$liveSvc = Get-CimInstance Win32_Service -Filter "Name='YaseirAgent'"
$liveProc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid"
if (-not $liveSvc -or [int]$liveSvc.ProcessId -ne $ownedPid -or
    -not $liveProc -or $liveProc.CreationDate -ne $before.CreationDate -or
    [IO.Path]::GetFullPath($liveProc.ExecutablePath) -ine $scmImage) {
  throw 'Process identity changed; abort'
}
Stop-Process -Id $ownedPid -Force
Start-Sleep -Seconds 65
$restarted = Get-CimInstance Win32_Service -Filter "Name='YaseirAgent'"
if (-not $restarted -or $restarted.State -ne 'Running' -or
    [int]$restarted.ProcessId -le 0 -or [int]$restarted.ProcessId -eq $ownedPid) {
  throw 'Service recovery or new process identity not verified'
}
```

Verify Agent health **through a separately authenticated Manager session** in
the saved Gateway origin (the `GET /api/agents/health?agentId=...` route requires
workspace Manager authorization and `agents.read`). Do not use unauthenticated
`Invoke-RestMethod`, transmit session cookies in logs, or paste customer tokens
into scripts. The permitted Manager must verify tenant/Agent identity, fresh
heartbeat after restart, retained queue contents, and printer observations.
Native Windows SCM and Gateway session checks still require operator evidence.

## Observability
- Structured logs include `requestId`, `agentId`, `failureCount`, `exitCode`, `lastRestart`
- Metrics: `agent_restarts_total`, `agent_failures_total`
- Dashboard: System Health page shows service state per agent

## BLOCKED Handling
In sandbox (no Windows SCM), this is BLOCKED by design. Code is hardened with SCM binary-path ownership verification, bounded helper execution, trusted OS system-directory resolution for the remaining native utilities, and background PID metadata (`creation_time` + canonical image). Real Windows service testing requires a Windows host.

## Future: Tauri Updater Signed
- Use Tauri updater with signed artifacts (see DESKTOP_UPDATER.md)
- Windows service update requires stopping service, replacing binary, starting service
- MSI has no supported Agent service lifecycle in this repository; NSIS is the only shipping installer until separately implemented and verified

### Agent-health collection pagination

`GET /api/agents/health` remains an array response for compatibility, but the collection form is bounded. It accepts `limit` (default 100, maximum 200) and `offset` (default 0, maximum 100000). Responses include `x-has-more` and, when another page exists, `x-next-offset`. Supplying `agentId` continues to return a single Agent health object and does not use collection pagination.
