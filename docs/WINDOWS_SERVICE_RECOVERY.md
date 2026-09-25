# Windows Service Recovery — Enterprise Grade

## Overview
The Go agent and Tauri manager must survive crashes, restarts, and host reboots. This doc defines SCM (Service Control Manager) recovery, state reporting, and testing.

## Official References
- Microsoft SCM: https://learn.microsoft.com/en-us/windows/win32/services/service-control-manager
- Failure actions: https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa
- Recovery actions: restart service, run program, restart computer
- The Go Agent owns Windows SCM registration/recovery through `github.com/kardianos/service`; the Tauri Manager supervises that service or an owned background `YasserAgent.exe` process and does not replace the Agent's SCM implementation.

## Service Definition
- Service Name: `YasserAgent` (matches the `service.Config{Name: "YasserAgent"}` registration in `agent/cmd/agent/main.go` and the `SERVICE_NAME` constant in `src-tauri/src/agent.rs`)
- Display Name: `Yasser Agent`
- Start Type: Automatic (delayed start allowed)
- Dependencies: `Tcpip` (matches the actual `Dependencies: []string{"Tcpip"}` in `main.go`; the Windows Print Spooler is a runtime requirement only when the optional `spooler` transport is used)
- Binary: `YasserAgent.exe` with config path (produced by `build-windows.yml` as `YasserAgent.exe`)
- Log On As: `LocalSystem` or dedicated service account with `SeServiceLogonRight` and printer access

## Failure Actions (SCM)
Configure via `sc failure` or API. The Go agent applies this automatically on
`YasserAgent.exe -service install` (see `configureServiceRecovery` in
`agent/cmd/agent/main.go`):
```
sc failure YasserAgent reset= 86400 actions= restart/60000/restart/60000/restart/60000
sc failureflag YasserAgent 1
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
  `service.Config{Name: "YasserAgent"}` — not the raw `golang.org/x/sys/windows/svc`
  handle. `program.Start/Stop` implement the service interface.
- Handle `Stop`/`Shutdown` controls via the kardianos `service.Service` contract
- On stop, graceful shutdown is bounded by the Agent's `shutdownGrace = 25s`; it cancels the runtime, drains/joins owned work, closes the local queue, and returns control to the service manager.
- Recovery actions are applied automatically on install via `configureServiceRecovery`
  (shells to `sc.exe`, warn-only)
- No separate heartbeat file / external watchdog exists; liveness is the Gateway
  heartbeat (`POST /api/agent/heartbeat`) plus SCM state.

## Implementation in Tauri (Desktop Manager)
- Tauri exposes `get_agent_status` for local service/process state and `control_service` for install/uninstall/start/stop/restart operations.
- `start_agent` / `stop_agent` / `restart_agent` run through the Tauri blocking pool so process and service control does not block the WebView UI thread.
- Background process ownership is recorded by PID plus process creation time and canonical image path; stop refuses to kill an unowned or identity-mismatched PID.

## Kill → Restart → Reconnect Test
Manual test for client demo:
1. Start agent as service: `sc start YasserAgent`
2. Verify Gateway sees agent ONLINE via `/api/agents/health`
3. Kill process: `taskkill /F /PID <pid>` or `Stop-Process -Id <pid> -Force`
4. Wait for SCM recovery (60s): `sc query YasserAgent` should show RUNNING again
5. Verify new PID, check failure count incremented: `sc qfailure YasserAgent`
6. Verify Gateway sees agent ONLINE again within 90s (heartbeat)
7. Verify queue depth preserved (jobs not lost)
8. Verify printer status still reported

Automated test (Windows only):
```powershell
$svc = "YasserAgent"
$before = (Get-Service $svc).Status
$proc = Get-Process YasserAgent -ErrorAction SilentlyContinue
if ($proc) { Stop-Process -Id $proc.Id -Force }
Start-Sleep 65
$after = (Get-Service $svc).Status
if ($after -ne "Running") { throw "Service did not recover" }
# Check Gateway health
Invoke-RestMethod "http://localhost:3000/api/agents/health?agentId=xxx"
```

## Observability
- Structured logs include `requestId`, `agentId`, `failureCount`, `exitCode`, `lastRestart`
- Metrics: `agent_restarts_total`, `agent_failures_total`
- Dashboard: System Health page shows service state per agent

## BLOCKED Handling
In sandbox (no Windows SCM), this is BLOCKED by design. Code is hardened with `system32_exe` path validation, `run_bounded_command` budget, background PID meta creation_time+image. Real Windows service testing requires Windows host.

## Future: Tauri Updater Signed
- Use Tauri updater with signed artifacts (see DESKTOP_UPDATER.md)
- Windows service update requires stopping service, replacing binary, starting service
- MSI installer should configure SCM failure actions during install
