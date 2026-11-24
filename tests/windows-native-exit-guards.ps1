#Requires -Version 7.0
# Execute the actual workflow command blocks with a failing native Cargo shim.
# This validates exit propagation on any PowerShell host; it does not execute Win32.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# The checkout on Windows may use CRLF; regexes in the workflow parser
# operate on normalized LF rather than silently indexing a missing section.
$workflow = (Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) ".github/workflows/build-windows.yml") -Raw) -replace "`r`n", "`n"
$sections = @($workflow -split '(?m)^  build-windows:\n', 2)
if ($sections.Count -ne 2) { throw "build-windows job definition was not found" }
$release = $sections[1]

function Get-WorkflowScript([string]$Name) {
  $step = ($release -split ([regex]::Escape("- name: $Name`n")), 2)[1]
  $step = ($step -split "`n      - name:", 2)[0]
  $body = ($step -split "run: \|\r?\n", 2)[1]
  return [scriptblock]::Create(($body -replace '(?m)^          ', ''))
}

function cargo { $global:LASTEXITCODE = $script:cargoExitCode }

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("yaseir-cargo-exit-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Join-Path $temporaryRoot "src-tauri") -Force | Out-Null
Set-Content -LiteralPath (Join-Path $temporaryRoot "src-tauri/Cargo.lock") -Value "# fixture"
$checks = 0
Push-Location $temporaryRoot
try {
  foreach ($name in @("Verify Cargo.lock", "Rust unit tests (desktop)")) {
    $script = Get-WorkflowScript $name
    $script:cargoExitCode = 42
    $threw = $false
    try { & $script } catch { $threw = $true }
    Set-Location $temporaryRoot
    if (-not $threw) { throw "Workflow accepted Cargo exit 42 in '$name'" }
    $checks++

    $script:cargoExitCode = 0
    & $script
    Set-Location $temporaryRoot
    $checks++
  }
} finally {
  Pop-Location
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
Write-Host "Windows workflow Cargo exit propagation checks passed: $checks"
