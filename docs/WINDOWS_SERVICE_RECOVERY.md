# Windows Agent service recovery

This is an operator procedure for an installed Windows release. The source and documentation checks do not execute Windows Service Control Manager (SCM), crash a service, contact a printer, or prove Gateway reconnection. Record the Windows procedure as **NOT RUN** until the observations below have been collected on the intended host.

## What the installed service configures

| Setting | Shipped behavior |
| --- | --- |
| Service name / display name | `YaseirAgent` / `Yaseir Agent` |
| Startup | Automatic |
| Declared dependency | `Tcpip` |
| First, second, subsequent failure actions | Three `restart/60000` entries: restart after 60 seconds |
| Failure-count reset period | `86400` seconds without a failure |
| Recovery policy installation | Native SCM API; failure to apply it is logged as a warning, so verify the installed policy |

The three entries are not a limit of three restarts. SCM repeats the last configured action after the array is exhausted. A clean service stop is different from a process crash; this code does not explicitly enable recovery actions for non-crash stops. These semantics are documented by Microsoft in [SERVICE_FAILURE_ACTIONSW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsw) and [SERVICE_FAILURE_ACTIONS_FLAG](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actions_flag).

`Spooler` is not a declared service dependency. Check it separately when testing Windows printer queues. A running Agent does not establish that Spooler, a printer, or the Gateway is healthy. The Agent also has an internal error/restart loop; an internal retry that leaves the process alive is not an observed SCM restart or an increment of the SCM failure count.

Source: `agent/cmd/agent/main.go` (`handleServiceControl`, `program.Start`, `program.Stop`) and `agent/cmd/agent/service_install_windows.go` (`configureServiceRecovery`, service ownership checks). Normal stop waits for the Agent loop for up to 27 seconds and avoids closing its queue while that loop is still active.

## 1. Inspect the exact installation

Use an elevated, 64-bit PowerShell session on the Windows test host. Set the expected executable from the installation you intend to test, not from an unverified service registration. Depending on the installed package, it is under the installation root or its `resources` directory.

```powershell
$ErrorActionPreference = 'Stop'
$ExpectedAgent = 'C:\Program Files\Yaseir Print Manager\resources\YaseirAgent.exe'
$ExpectedAgent = (Resolve-Path -LiteralPath $ExpectedAgent).ProviderPath
$ScExe = Join-Path ([Environment]::GetFolderPath('System')) 'sc.exe'

function Get-OwnedAgentService {
    $service = Get-CimInstance Win32_Service -Filter "Name='YaseirAgent'"
    if ($null -eq $service) { throw 'YaseirAgent is not installed.' }
    $command = [string]$service.PathName
    if ($command -match '^\s*"([^\"]+)"(?:\s|$)') {
        $image = $Matches[1]
    } elseif ($command -match '^\s*(\S+)(?:\s|$)') {
        $image = $Matches[1]
    } else {
        throw 'Cannot parse the registered service executable.'
    }
    if (-not [IO.Path]::IsPathRooted($image) -or
        -not [string]::Equals([IO.Path]::GetFullPath($image), $ExpectedAgent,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Service executable does not match the expected installation.'
    }
    return $service
}

$service = Get-OwnedAgentService
$service | Select-Object Name, State, StartMode, StartName, PathName, ProcessId
& $ScExe qc YaseirAgent
& $ScExe qfailure YaseirAgent
& $ScExe qfailureflag YaseirAgent
& $ScExe queryex YaseirAgent
Get-Service Spooler | Select-Object Name, Status, StartType
```

Check each command's output and exit status. `sc query`/`queryex` reports current state; `qfailure` reports the configured schedule, not a measured failure count or a history of successful recoveries. Preserve the exact binary path, package version, policy, and UTC observation time with the test record.

If the service is missing, reopen the installed Manager as Administrator to install/start it. If ownership verification fails, resolve the conflicting installation before changing the service. Do not repair this by deleting an arbitrary same-name service or starting another Agent executable.

For a stopped, verified installation, start it through its own ownership-checking command:

```powershell
$null = Get-OwnedAgentService
& $ExpectedAgent -service start
if ($LASTEXITCODE -ne 0) { throw 'Agent service start failed.' }
& $ScExe queryex YaseirAgent
```

The SCM equivalent is `sc start YaseirAgent`; the bundled Agent command additionally checks that the registered service belongs to this installation. Starting the service does not pair it. An unpaired or invalidly configured Agent can remain running while it waits for configuration. Use the Manager to finish pairing and verify an authenticated heartbeat before testing recovery.

## 2. Establish a baseline

Use a dedicated test machine or an agreed maintenance window with no active print jobs. Record the Agent's Gateway identity and a fresh authenticated heartbeat. Closing the Manager is independent of stopping the service; do not count reopening the UI as service recovery.

```powershell
$service = Get-OwnedAgentService
if ($service.State -ne 'Running' -or $service.ProcessId -eq 0) {
    throw 'The owned service must be running before a crash test.'
}
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)"
if ($null -eq $process -or [string]::IsNullOrEmpty($process.ExecutablePath) -or
    -not [string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath),
        $ExpectedAgent, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Running process ownership could not be established.'
}
$process | Select-Object ProcessId, ExecutablePath, CreationDate
$TestStarted = Get-Date
```

Keep `ExecutablePath` and `CreationDate` with the PID. A PID alone or an executable basename does not identify an installation or a process lifetime.

## 3. Optional crash → SCM restart → Gateway reconnect test

This step deliberately terminates the verified Agent process. Run it only for the recovery test after establishing the baseline. Do not use `taskkill /IM`, process-name enumeration, or a copied PID from an earlier session. The following keeps a handle to one process, verifies its path and start time, and rechecks the service before terminating that process. If any check fails, stop the test and collect a new baseline; do not bypass the check.

```powershell
$target = [Diagnostics.Process]::GetProcessById([int]$process.ProcessId)
try {
    $null = $target.Handle # Hold this process instance while verifying it.
    if ($target.HasExited -or
        -not [string]::Equals($target.MainModule.FileName, $ExpectedAgent,
            [StringComparison]::OrdinalIgnoreCase) -or
        [Math]::Abs(($target.StartTime.ToUniversalTime() -
            $process.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
        throw 'Process identity changed since the baseline.'
    }
    $currentService = Get-OwnedAgentService
    $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($target.Id)"
    if ($currentService.State -ne 'Running' -or
        $currentService.ProcessId -ne $target.Id -or
        $null -eq $currentProcess -or
        $currentProcess.CreationDate -ne $process.CreationDate -or
        $currentProcess.ExecutablePath -ne $process.ExecutablePath) {
        throw 'Service or process identity changed; crash test cancelled.'
    }
    $target.Kill()
    if (-not $target.WaitForExit(10000)) { throw 'Process did not exit in 10s.' }
} finally {
    $target.Dispose()
}
```

Observe SCM without manually starting the service or reopening the Manager during the observation window:

```powershell
$deadline = (Get-Date).AddSeconds(90)
do {
    $after = Get-OwnedAgentService
    $after | Select-Object Name, State, ProcessId
    if ($after.State -eq 'Running' -and $after.ProcessId -ne 0) { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
& $ScExe queryex YaseirAgent
if ($after.State -eq 'Running' -and $after.ProcessId -ne 0) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$($after.ProcessId)" |
        Select-Object ProcessId, ExecutablePath, CreationDate
}
Get-WinEvent -FilterHashtable @{
    LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = $TestStarted
} | Where-Object { $_.Message -match 'YaseirAgent|Yaseir Agent' } |
    Select-Object TimeCreated, Id, Message
```

The 90s window is an operator observation budget around the configured 60-second delay, not a recovery SLA. Confirm a new process creation time, the expected executable path, and matching SCM termination/restart events. If no recovery occurs, retain the observed state, installed recovery policy, event records, and Agent log before intervening. A manually issued start is useful remediation, but is not proof that SCM restarted the process.

Verify Gateway reconnection separately using the signed-in Workspace's Agent health view or its authenticated `GET /api/agents/health?agentId=...` request. The caller needs `agents.read` and must belong to the Agent's tenant. Record a heartbeat observed after the restart; an old “online” display or SCM `Running` state alone is insufficient. Do not paste cookies or Agent credentials into a report or an unauthenticated health command.

`GET /api/agents/service-status` currently returns a blocked diagnostic structure, including `UNKNOWN` state and null failure count/exit code. Its configured defaults are not a live query of Windows SCM and must not be used as proof of a restart, even when the remote Agent is on Windows.

## 4. Evidence and recovery decisions

Record the release/version, expected and observed executable paths, before/after PID and creation time, recovery policy, SCM event timestamps, reconnect heartbeat time, and pass/fail/NOT RUN result. Read the protected Agent log under the configured runtime directory (normally `%PROGRAMDATA%\YaseirAgent\logs\agent.log`); include only the relevant redacted excerpt.

If a print was in flight, reconcile its recorded outcome before submitting a new print intent. Service restart cannot prove whether paper was physically printed. Do not clear the queue or use `-service uninstall`/`-service purge` as a restart workaround: those commands remove local data. For routine recovery, use the installed Manager's service controls or the verified Agent's `-service stop` and `-service start` commands.

Source-only regression checks: `tests/windows-service-recovery.test.ts`, `tests/windows-service-recovery-native.contract.test.mjs`, and `tests/test_f026_operational_documentation.py`. Passing them establishes agreement with source contracts, not execution of this Windows procedure.
