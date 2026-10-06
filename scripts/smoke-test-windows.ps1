#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Deterministic Windows smoke test for the installed Yaseir Print Manager.

.DESCRIPTION
  Verifies that the installed desktop app and bundled agent/CLI binaries exist,
  the desktop process starts and stays alive, duplicate desktop/Agent launches
  are fenced by the machine-wide single-instance guards, standalone Agent
  initialization works when no Windows service owns the runtime, and processes
  can be stopped cleanly.

  This script is intended for the Windows build/installation host or a Windows
  VM. It must run from an elevated or at least unrestricted shell when the
  installed app is under "C:\Program Files".

.EXAMPLE
  ./scripts/smoke-test-windows.ps1
  ./scripts/smoke-test-windows.ps1 -InstallDir "$env:ProgramFiles\Yaseir Print Manager"
#>
param(
  [string]$InstallDir = "",
  [int]$WaitSeconds = 5,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"

if (-not $InstallDir) {
  $candidateDirs = @(
    (Join-Path $env:ProgramFiles "Yaseir\Yaseir Print Manager"),
    (Join-Path $env:ProgramFiles "Yaseir Print Manager"),
    (Join-Path $env:ProgramFiles "yasser-manager"),
    (Join-Path ${env:ProgramFiles(x86)} "Yaseir\Yaseir Print Manager"),
    (Join-Path ${env:ProgramFiles(x86)} "Yaseir Print Manager"),
    (Join-Path ${env:ProgramFiles(x86)} "yasser-manager"),
    (Join-Path $env:LOCALAPPDATA "Programs\Yaseir Print Manager"),
    (Join-Path $env:LOCALAPPDATA "Yaseir Print Manager")
  )
  $InstallDir = $candidateDirs | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $InstallDir) {
    $regKeys = Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match "^Yaseir( Manager)?$" -or $_.DisplayName -match "^Yasser( Manager)?$" }  # legacy fallback for pre-migration installs
    foreach ($k in $regKeys) {
      if ($k.InstallLocation -and (Test-Path $k.InstallLocation)) {
        $InstallDir = $k.InstallLocation
        break
      }
    }
  }
  if (-not $InstallDir) {
    $candidateFiles = Get-ChildItem -Path @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs") -Filter "*Yaseir*.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue
    if ($candidateFiles) {
      $InstallDir = $candidateFiles[0].DirectoryName
    }
  }
  if (-not $InstallDir) {
    $InstallDir = Join-Path $env:ProgramFiles "Yaseir Print Manager"
  }
}

# Each run owns an isolated data root; never reuse production ProgramData.
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("yaseir-smoke-" + [guid]::NewGuid().ToString("N"))
$agentDataDir = Join-Path $smokeRoot "agent"
$managerDataDir = Join-Path $smokeRoot "manager"

function Assert-Path {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "FAIL: $Label not found: $Path"
    throw "Smoke assertion failed"
  }
  Write-Host "PASS: $Label exists -> $Path"
}

function Assert-NotExited {
  param([System.Diagnostics.Process]$Process, [string]$Label)
  Start-Sleep -Seconds $WaitSeconds
  if ($Process.HasExited) {
    Write-Error "FAIL: $Label exited early (code $($Process.ExitCode))"
    throw "Smoke assertion failed"
  }
  Write-Host "PASS: $Label is still running after $WaitSeconds seconds (pid $($Process.Id))"
}

$ErrorActionPreference = "Stop"

Write-Host "== Yaseir Print Manager Windows smoke test =="
Write-Host "Install dir: $InstallDir"
Write-Host "Agent data dir: $agentDataDir"

# 1. Installed / bundled files -------------------------------------------------
$candidateAppExes = @(
  (Join-Path $InstallDir "yaseir-manager.exe"),
  (Join-Path $InstallDir "yasser-manager.exe"),  # legacy fallback
  (Join-Path $InstallDir "Yaseir Print Manager.exe")
)
$appExe = $candidateAppExes | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $appExe) {
  $appExe = Get-ChildItem -Path $InstallDir -Filter "Yaseir Print Manager*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $appExe) {
  $appExe = Join-Path $InstallDir "yaseir-manager.exe"
}

$candidateAgentExes = @(
  (Join-Path $InstallDir "resources\YaseirAgent.exe"),
  (Join-Path $InstallDir "YaseirAgent.exe")
)
$agentExe = $candidateAgentExes | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $agentExe) {
  $agentExe = Get-ChildItem -Path $InstallDir -Filter "YaseirAgent.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $agentExe) {
  $agentExe = Join-Path $InstallDir "resources\YaseirAgent.exe"
}

$candidateCliExes = @(
  (Join-Path $InstallDir "resources\yaseir-agent-cli.exe"),
  (Join-Path $InstallDir "yaseir-agent-cli.exe")
)
$cliExe = $candidateCliExes | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cliExe) {
  $cliExe = Get-ChildItem -Path $InstallDir -Filter "yaseir-agent-cli.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $cliExe) {
  $cliExe = Join-Path $InstallDir "resources\yaseir-agent-cli.exe"
}

Assert-Path $appExe "Installed desktop executable"
Assert-Path $agentExe "Bundled agent executable"
Assert-Path $cliExe "Bundled CLI executable"

# The desktop UI check must not start, stop, or register a production service.
$oldAgentData = $env:YASEIR_AGENT_DATA_DIR
$oldManagerData = $env:YASEIR_MANAGER_DATA_DIR
$oldAutostart = $env:YASEIR_MANAGER_AUTOSTART_AGENT
$env:YASEIR_AGENT_DATA_DIR = $agentDataDir
$env:YASEIR_MANAGER_DATA_DIR = $managerDataDir
$env:YASEIR_MANAGER_AUTOSTART_AGENT = "0"
try {

# 2. Desktop application process ----------------------------------------------
$desktop = $null
$secondDesktop = $null
try {
  $desktop = Start-Process -FilePath $appExe -PassThru
  Assert-NotExited $desktop "Yaseir Print Manager desktop process"

  # The Manager runtime contains the trusted Gateway origin. A locally
  # pre-created writable ProgramData tree must never be accepted: the desktop
  # hardens ownership/DACL at startup and fails closed before reading settings.
  Assert-Path $managerDataDir "Manager writable data directory"
  $managerAcl = Get-Acl -LiteralPath $managerDataDir
  if (-not $managerAcl.AreAccessRulesProtected) {
    throw "FAIL: Manager data directory still inherits parent ACLs"
  }
  $ownerSid = ([System.Security.Principal.NTAccount]$managerAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne "S-1-5-32-544") {
    throw "FAIL: Manager data directory owner is $ownerSid; expected BUILTIN\Administrators"
  }
  $usersSid = "S-1-5-32-545"
  $dangerousRights = ([System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
  foreach ($rule in $managerAcl.Access) {
    try {
      $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      continue
    }
    if ($ruleSid -eq $usersSid -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
      if (($rule.FileSystemRights -band $dangerousRights) -ne 0) {
        throw "FAIL: BUILTIN\Users retained write-capable rights on Manager data: $($rule.FileSystemRights)"
      }
    }
  }
  Write-Host "PASS: Manager data ownership/DACL is protected; standard Users are read-only."

  # Regression guard: repeated clicks must focus/exit the duplicate launcher,
  # never create another long-lived desktop that can race Agent control.
  $secondDesktop = Start-Process -FilePath $appExe -PassThru
  Start-Sleep -Seconds 2
  if (-not $secondDesktop.HasExited) {
    Stop-Process -Id $secondDesktop.Id -Force -ErrorAction SilentlyContinue
    Write-Error "FAIL: a second desktop instance stayed alive (pid $($secondDesktop.Id))"
    throw "Smoke assertion failed"
  }
  if ($secondDesktop.ExitCode -ne 0) {
    Write-Error "FAIL: duplicate desktop instance exited with code $($secondDesktop.ExitCode)"
    throw "Smoke assertion failed"
  }
  if ($desktop.HasExited) {
    Write-Error "FAIL: launching a duplicate desktop terminated the original instance"
    throw "Smoke assertion failed"
  }
  Write-Host "PASS: duplicate desktop launch exited cleanly; the original instance remains the single owner."
} finally {
  if (-not $KeepRunning -and $secondDesktop -and -not $secondDesktop.HasExited) {
    Stop-Process -Id $secondDesktop.Id -Force -ErrorAction SilentlyContinue
  }
  if (-not $KeepRunning -and $desktop -and -not $desktop.HasExited) {
    Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
    Write-Host "PASS: desktop process stopped cleanly (forced process termination)."
  }

}

# 3. CLI help ----------------------------------------------------------------
Write-Host "== CLI help =="
$cliOut = & $cliExe --help 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "FAIL: yaseir-agent-cli.exe --help returned exit code $LASTEXITCODE"
  throw "Smoke assertion failed"
}
$cliText = ($cliOut | Out-String)
if ($cliText -notmatch "-pair" -or $cliText -notmatch "-server" -or $cliText -notmatch "-config") {
  Write-Error "FAIL: CLI help did not mention -pair/-server/-config"
  throw "Smoke assertion failed"
}
Write-Host "PASS: CLI help lists -pair, -server, -config"

# 4. Agent runtime ownership / first-run initialization -----------------------
$agent = $null
try {
  $configPath = Join-Path $agentDataDir "config.yaml"
  $installedService = Get-Service -Name YaseirAgent -ErrorAction SilentlyContinue

  if ($installedService -and $installedService.Status -eq "Running") {
    # Installed-package smoke runs while the real Windows service owns the
    # machine-wide Agent singleton. A second manual launch MUST exit cleanly;
    # expecting it to stay alive would incorrectly treat duplicate prevention
    # as a crash and would recreate the exact multi-Agent bug this test guards.
    $agent = Start-Process -FilePath $agentExe -ArgumentList @("-config", $configPath) -PassThru
    Start-Sleep -Seconds 2
    if (-not $agent.HasExited) {
      Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue
      Write-Error "FAIL: a second Agent runtime stayed alive while the YaseirAgent service was running"
      throw "Smoke assertion failed"
    }
    if ($agent.ExitCode -ne 0) {
      Write-Error "FAIL: duplicate Agent runtime exited with code $($agent.ExitCode)"
      throw "Smoke assertion failed"
    }
    Write-Host "PASS: running Windows service fenced the duplicate Agent runtime cleanly."
  } else {
    # Standalone smoke (no installed service): the Agent intentionally stays
    # alive while unpaired/configured. Verify its writable runtime is created.
    $agent = Start-Process -FilePath $agentExe -ArgumentList @("-config", $configPath) -PassThru
    Start-Sleep -Seconds 4
    if ($agent.HasExited) {
      Write-Error "FAIL: standalone agent exited early (code $($agent.ExitCode)); inspect $agentDataDir"
      throw "Smoke assertion failed"
    }
    Assert-Path $agentDataDir "Agent writable data directory"
    Assert-Path $configPath "Agent default config file"
    Assert-Path (Join-Path $agentDataDir "logs\agent.log") "Agent log file"
    Assert-Path (Join-Path $agentDataDir "queue.db") "Agent SQLite database"
    Write-Host "PASS: standalone Agent first-run initialization completed without manual directory creation."
  }
} finally {
  if (-not $KeepRunning -and $agent -and -not $agent.HasExited) {
    Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue
    Write-Host "PASS: agent process stopped."
  }
}

if ($KeepRunning) {
  Write-Host "PASS: isolated smoke processes kept running: desktop PID=$($desktop.Id), Agent PID=$($agent.Id); data=$smokeRoot"
} else {
  Write-Host "PASS: UI startup and Agent single-instance/initialization checks completed. Physical printing was not exercised."
}
} finally {
  $env:YASEIR_AGENT_DATA_DIR = $oldAgentData
  $env:YASEIR_MANAGER_DATA_DIR = $oldManagerData
  $env:YASEIR_MANAGER_AUTOSTART_AGENT = $oldAutostart
  if (-not $KeepRunning -and (Test-Path -LiteralPath $smokeRoot)) {
    Remove-Item -LiteralPath $smokeRoot -Recurse -Force
  }
}
