# Acceptance procedure only. This script was parsed, not executed, in this session.
# Run from the verified source root on the dedicated Windows x64 build VM.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'Actual Windows x64 is required'
}

function Invoke-AcceptanceTool {
  param([Parameter(Mandatory)][string]$Executable, [string[]]$CommandArguments = @())
  & $Executable @CommandArguments
  if ($LASTEXITCODE -ne 0) { throw "Required tool failed: $Executable (exit $LASTEXITCODE)" }
}

$ReleaseEvidence = [IO.Path]::GetFullPath('..\windows-release-evidence')
$ReleaseTools = [IO.Path]::GetFullPath('..\windows-release-tools')
$ReleaseBin = Join-Path $ReleaseTools 'bin'
New-Item -ItemType Directory -Force $ReleaseEvidence, $ReleaseBin | Out-Null
foreach ($Name in @('node', 'go', 'python', 'rustup', 'cargo', 'gcc')) {
  Get-Command $Name -CommandType Application -ErrorAction Stop | Out-Null
}

# Match CI's native Go/CGO contract. Keep CC/CXX unset so the Rust MSVC target
# can choose its own MSVC compiler; do not globally force GCC on Cargo builds.
if ($env:CC -or $env:CXX) { throw 'Use a clean acceptance shell without CC/CXX overrides' }
Remove-Item Env:GOOS, Env:GOARCH, Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
$env:CGO_ENABLED = '1'
$env:GOTOOLCHAIN = 'local'
$NodeVersion = (Invoke-AcceptanceTool -Executable node -CommandArguments @('--version') | Out-String).Trim()
if ($NodeVersion -ne 'v24.22.1') { throw 'Node must match .nvmrc: 24.22.1' }
$GoIdentity = Invoke-AcceptanceTool -Executable go -CommandArguments @('env', '-json', 'GOVERSION', 'GOOS', 'GOARCH', 'GOHOSTOS', 'GOHOSTARCH', 'CGO_ENABLED', 'CC', 'GOGCCFLAGS') | ConvertFrom-Json
if ($GoIdentity.GOVERSION -ne 'go1.26.11' -or $GoIdentity.GOOS -ne 'windows' -or
    $GoIdentity.GOARCH -ne 'amd64' -or $GoIdentity.GOHOSTOS -ne 'windows' -or
    $GoIdentity.GOHOSTARCH -ne 'amd64' -or $GoIdentity.CGO_ENABLED -ne '1') {
  throw 'Require pinned Go 1.26.11, native Windows/amd64 and CGO=1'
}
if ($GoIdentity.CC -notin @('gcc', 'gcc.exe')) {
  throw 'This procedure follows the CI default GCC selection; remove persistent Go CC overrides'
}
$CgoCommand = Get-Command $GoIdentity.CC -CommandType Application -ErrorAction Stop
$CgoTarget = (Invoke-AcceptanceTool -Executable $CgoCommand.Source -CommandArguments @('-dumpmachine') | Out-String).Trim()
$CgoVersion = (Invoke-AcceptanceTool -Executable $CgoCommand.Source -CommandArguments @('-dumpfullversion', '-dumpversion') | Out-String).Trim()
$CgoBanner = (Invoke-AcceptanceTool -Executable $CgoCommand.Source -CommandArguments @('--version') | Out-String).Trim()
$CgoSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $CgoCommand.Source).Hash.ToLowerInvariant()
if ($CgoTarget -ne 'x86_64-w64-mingw32') { throw 'Require an x64 Windows MinGW-w64 GCC target' }
# Obtain these non-secret expected values from the selected build-toolchain
# manifest and recorded distribution provenance; no additional approval step.
if ([string]::IsNullOrWhiteSpace($env:YASEIR_EXPECTED_CGO_VERSION) -or
    $env:YASEIR_EXPECTED_CGO_SHA256 -notmatch '^[0-9a-fA-F]{64}$') {
  throw 'Expected compiler version and executable SHA256 are required'
}
if ($CgoVersion -ne $env:YASEIR_EXPECTED_CGO_VERSION -or $CgoSha256 -ne $env:YASEIR_EXPECTED_CGO_SHA256) {
  throw 'Selected GCC does not match the expected compiler identity'
}
Invoke-AcceptanceTool -Executable python -CommandArguments @('-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)')

# Install only the recorded tool versions into this acceptance tool directory.
$AcceptanceRust = '1.98.1-x86_64-pc-windows-msvc'
Invoke-AcceptanceTool -Executable rustup -CommandArguments @('toolchain', 'install', $AcceptanceRust, '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy', '--target', 'x86_64-pc-windows-msvc')
$env:RUSTUP_TOOLCHAIN = $AcceptanceRust
$env:GOBIN = $ReleaseBin
$env:PATH = $ReleaseBin + [IO.Path]::PathSeparator + $env:PATH
Invoke-AcceptanceTool -Executable go -CommandArguments @('install', 'honnef.co/go/tools/cmd/staticcheck@v0.7.0')
Invoke-AcceptanceTool -Executable go -CommandArguments @('install', 'golang.org/x/vuln/cmd/govulncheck@v1.9.0')
Invoke-AcceptanceTool -Executable cargo -CommandArguments @('install', '--root', $ReleaseTools, '--version', '=0.22.2', '--locked', 'cargo-audit')
Invoke-AcceptanceTool -Executable cargo -CommandArguments @('install', '--root', $ReleaseTools, '--version', '=2.11.4', '--locked', 'tauri-cli')

$ToolPaths = [ordered]@{}
foreach ($Name in @('staticcheck', 'govulncheck', 'cargo-audit', 'cargo-tauri')) {
  $Command = Get-Command $Name -CommandType Application -ErrorAction Stop
  $Expected = Join-Path $ReleaseBin ($Name + '.exe')
  if (-not [string]::Equals([IO.Path]::GetFullPath($Command.Source), $Expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "PATH selects an unexpected executable for $Name"
  }
  $ToolPaths[$Name] = $Command.Source
}
$Versions = [ordered]@{
  node = $NodeVersion
  go = (Invoke-AcceptanceTool -Executable go -CommandArguments @('version') | Out-String).Trim()
  rustc = (Invoke-AcceptanceTool -Executable rustc -CommandArguments @('--version', '--verbose') | Out-String).Trim()
  cargo = (Invoke-AcceptanceTool -Executable cargo -CommandArguments @('--version') | Out-String).Trim()
  rustfmt = (Invoke-AcceptanceTool -Executable rustfmt -CommandArguments @('--version') | Out-String).Trim()
  clippy = (Invoke-AcceptanceTool -Executable cargo -CommandArguments @('clippy', '--version') | Out-String).Trim()
  staticcheck = (Invoke-AcceptanceTool -Executable staticcheck -CommandArguments @('-version') | Out-String).Trim()
  govulncheck = (Invoke-AcceptanceTool -Executable govulncheck -CommandArguments @('-version') | Out-String).Trim()
  cargoAudit = (Invoke-AcceptanceTool -Executable cargo -CommandArguments @('audit', '--version') | Out-String).Trim()
  tauri = (Invoke-AcceptanceTool -Executable cargo -CommandArguments @('tauri', '--version') | Out-String).Trim()
}
if ($Versions.rustc -notmatch '^rustc 1\.98\.1 ' -or $Versions.cargo -notmatch '^cargo 1\.98\.1 ' -or
    $Versions.staticcheck -notmatch '\(v0\.7\.0\)' -or $Versions.govulncheck -notmatch 'govulncheck@v1\.9\.0' -or
    $Versions.cargoAudit -notmatch '^cargo-audit 0\.22\.2(?:\s|$)' -or $Versions.tauri -notmatch '(?:tauri-cli|cargo-tauri) 2\.11\.4(?:\s|$)') {
  throw 'Installed acceptance tool version mismatch'
}
$RustComponents = @(Invoke-AcceptanceTool -Executable rustup -CommandArguments @('component', 'list', '--toolchain', $AcceptanceRust, '--installed'))
[ordered]@{
  recordedAtUtc = [DateTime]::UtcNow.ToString('o')
  versions = $Versions
  toolPaths = $ToolPaths
  goEnvironment = $GoIdentity
  rustToolchain = $AcceptanceRust
  rustComponents = $RustComponents
  cgoCompiler = [ordered]@{ path = $CgoCommand.Source; target = $CgoTarget; version = $CgoVersion; sha256 = $CgoSha256; banner = $CgoBanner }
  limits = 'Provisioning and identity only. Native tests, public signing and all installed/physical acceptance gates remain required.'
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ReleaseEvidence 'toolchain-public.json') -Encoding utf8
