#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot production build of the Yaseir Print Manager Windows installer.

.DESCRIPTION
  Orchestrates the full pipeline on a Windows build host:

    1. Prerequisite check (Node.js, npm, Go, Rust, tauri-cli)
    2. npm ci                      (pinned dependency install)
    3. npm run typecheck + lint    (gateway + desktop frontend)
    4. npm run desktop:vite:build  (React UI -> dist-desktop/)
    5. Go agent: vet + tests + release build (-trimpath -ldflags "-s -w")
    6. cargo tauri build           (embeds frontend + agent exes -> NSIS)

  Outputs (default target x86_64-pc-windows-msvc):
    src-tauri\target\<target>\release\bundle\nsis\Yaseir Print Manager_<ver>_x64-setup.exe

  The bundle is fully standalone: customers need no Node.js, Go, Rust or
  Python. WebView2 is fetched at install time via the bootstrapper (see
  bundle.windows.webviewInstallMode in src-tauri/tauri.conf.json).

.EXAMPLE
  pwsh -File scripts/build-windows-installer.ps1
  pwsh -File scripts/build-windows-installer.ps1 -Bundles nsis -SkipNpmInstall
#>
[CmdletBinding()]
param(
  # Windows MSVC target triple; non-default architectures need a matching C compiler.
  [string]$Target = "x86_64-pc-windows-msvc",
  # Only NSIS has the required Agent service installer/upgrade/removal hooks.
  # Reject unsupported MSI requests before running any build steps.
  [ValidateSet("nsis")]
  [string]$Bundles = "nsis",
  # Skip `npm ci` (use the existing node_modules).
  [switch]$SkipNpmInstall,
  # Skip Go vet + unit tests (CI already ran them).
  [switch]$SkipGoTests,
  # Generate or reuse a free self-signed CodeSigningCert, export yaseir-public.cer, and sign binaries.
  [switch]$GenerateSelfSignedCert
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot  = Split-Path -Parent $PSScriptRoot
$agentDir  = Join-Path $repoRoot "agent"
$bundleDir = Join-Path $repoRoot "src-tauri\target\$Target\release\bundle"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Assert-Command([string]$Name, [string]$InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Prerequisite missing: '$Name'. $InstallHint"
  }
  Write-Host ("  {0,-8} {1}" -f $Name, (Get-Command $Name).Source)
}

function Assert-MinVersion([string]$Name, [version]$Required, [string]$ActualText, [string]$InstallHint) {
  $match = [regex]::Match($ActualText, '\d+(?:\.\d+){1,3}')
  if (-not $match.Success) {
    throw "Unable to determine '$Name' version from: $ActualText. $InstallHint"
  }
  $actual = [version]$match.Value
  if ($actual -lt $Required) {
    throw "'$Name' $actual is unsupported; this repository requires >= $Required. $InstallHint"
  }
  Write-Host ("  {0,-8} {1} (minimum {2})" -f $Name, $actual, $Required)
}

function Get-GoArchitectureForTarget([string]$RustTarget) {
  # Tauri's documented Windows architectures; CI validates the default x64 target.
  switch -CaseSensitive ($RustTarget) {
    "x86_64-pc-windows-msvc" { return "amd64" }
    "i686-pc-windows-msvc" { return "386" }
    "aarch64-pc-windows-msvc" { return "arm64" }
    default { throw "Unsupported Windows release target '$RustTarget'; supported: x86_64-pc-windows-msvc, i686-pc-windows-msvc, aarch64-pc-windows-msvc." }
  }
}

function Assert-CodeSigningCertificate($Certificate, [string]$RequestedThumbprint) {
  if (-not $Certificate -or [string]::IsNullOrWhiteSpace($RequestedThumbprint) -or
      $Certificate.Thumbprint -ne $RequestedThumbprint) {
    throw "Requested Windows code-signing certificate '$RequestedThumbprint' was not found."
  }
}

function Assert-AuthenticodeSigningResult($Signature, [string]$ExpectedThumbprint, [string]$FilePath) {
  # A self-signed publisher can be untrusted on the build host; this is distinct
  # from a missing/invalid signature. Never accept signing errors as success.
  if (-not $Signature -or [string]::IsNullOrWhiteSpace($ExpectedThumbprint) -or
      [string]$Signature.Status -notin @("Valid", "NotTrusted") -or
      -not $Signature.SignerCertificate -or
      $Signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) {
    throw "Authenticode signing failed or returned an unexpected signer for '$FilePath'."
  }
  return [string]$Signature.Status
}

# Validate target and explicitly requested signing identity before any build.
$goArchitecture = Get-GoArchitectureForTarget $Target
$signingCert = $null
$thumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
if (-not [string]::IsNullOrWhiteSpace($thumbprint)) {
  $thumbprint = $thumbprint.Trim()
  $signingCert = Get-ChildItem -Path Cert:\CurrentUser\My,Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $thumbprint } |
    Select-Object -First 1
  Assert-CodeSigningCertificate $signingCert $thumbprint
}

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
Write-Step "Prerequisite check"
Assert-Command node   "Install Node.js >= 24.15.0 (the repository baseline is pinned by .nvmrc)."
Assert-Command npm    "Install the npm version bundled with Node.js 24.15.0+ (the repository baseline is pinned by .nvmrc)."
Assert-Command go     "Install Go 1.26+ from https://go.dev/dl/ (agent/go.mod requires Go 1.26)."
Assert-Command rustc  "Install the Rust toolchain pinned by src-tauri/rust-toolchain.toml: https://rustup.rs/."
Assert-Command cargo  "Install the Rust toolchain pinned by src-tauri/rust-toolchain.toml: https://rustup.rs/."
Assert-MinVersion "node" ([version]"24.15.0") (& node --version) "Install Node.js 24.15.0+; see .nvmrc for the CI baseline."
Assert-MinVersion "go" ([version]"1.26.0") (& go version) "Install Go 1.26+; agent/go.mod declares Go 1.26."
$rustToolchain = Get-Content (Join-Path $repoRoot "src-tauri\rust-toolchain.toml") | Select-String -Pattern '^channel\s*=\s*"(?<version>[^"\s]+)"' | ForEach-Object { $_.Matches[0].Groups["version"].Value }
if ([string]::IsNullOrWhiteSpace($rustToolchain)) { throw "Unable to determine the pinned Rust toolchain from src-tauri/rust-toolchain.toml" }
Assert-MinVersion "rustc" ([version]$rustToolchain) (& rustc --version) "Install the exact Rust toolchain pinned by src-tauri/rust-toolchain.toml ($rustToolchain)."
$rustActual = [regex]::Match((& rustc --version), '\d+(?:\.\d+){1,3}').Value
if ($rustActual -ne $rustToolchain) { throw "rustc $rustActual does not match the pinned repository toolchain $rustToolchain." }
& cargo tauri --version *> $null
if ($LASTEXITCODE -ne 0) {
  throw "tauri-cli missing. Install once with: cargo install tauri-cli --version `"^2`" --locked"
}
Write-Host "  tauri-cli present"

# ── 2-4. Node pipeline ───────────────────────────────────────────────────────
if (-not $SkipNpmInstall) {
  Write-Step "npm ci (pinned dependency install)"
  npm --prefix $repoRoot ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
}

Write-Step "TypeScript typecheck"
npm --prefix $repoRoot run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed with exit code $LASTEXITCODE" }

Write-Step "ESLint"
npm --prefix $repoRoot run lint
if ($LASTEXITCODE -ne 0) { throw "lint failed with exit code $LASTEXITCODE" }

Write-Step "Desktop frontend build (Vite -> dist-desktop)"
npm --prefix $repoRoot run desktop:vite:build
if ($LASTEXITCODE -ne 0) { throw "vite build failed with exit code $LASTEXITCODE" }

# ── 5. Go agent (release flags) ──────────────────────────────────────────────
$savedGoOS = $env:GOOS
$savedGoArch = $env:GOARCH
$savedCGOEnabled = $env:CGO_ENABLED
Push-Location $agentDir
try {
  if (-not $SkipGoTests) {
    Write-Step "Go vet"
    go vet .\...
    if ($LASTEXITCODE -ne 0) { throw "go vet failed with exit code $LASTEXITCODE" }

    Write-Step "Go tests"
    go test .\... -race -count=1
    if ($LASTEXITCODE -ne 0) { throw "go tests failed with exit code $LASTEXITCODE" }
  }

  # SQLite requires CGO; never package the non-CGO stub or a host-architecture
  # executable beside a different Rust target. Native tests above stay native.
  $env:GOOS = "windows"
  $env:GOARCH = $goArchitecture
  $env:CGO_ENABLED = "1"
  Write-Step "Building YaseirAgent.exe (release, windows/$goArchitecture, CGO enabled)"
  go build -trimpath -ldflags "-s -w" -o YaseirAgent.exe .\cmd\agent
  if ($LASTEXITCODE -ne 0) { throw "agent build failed with exit code $LASTEXITCODE" }

  Write-Step "Building yaseir-agent-cli.exe (release)"
  go build -trimpath -ldflags "-s -w" -o yaseir-agent-cli.exe .\cmd\cli
  if ($LASTEXITCODE -ne 0) { throw "cli build failed with exit code $LASTEXITCODE" }
} finally {
  $env:GOOS = $savedGoOS
  $env:GOARCH = $savedGoArch
  $env:CGO_ENABLED = $savedCGOEnabled
  Pop-Location
}

# Tauri bundles these EXEs as resources — a missing file fails the bundler
# late; fail early with a clear message instead.
foreach ($exe in @("YaseirAgent.exe", "yaseir-agent-cli.exe")) {
  $exePath = Join-Path $agentDir $exe
  if (-not (Test-Path $exePath)) { throw "Missing build output: $exePath" }
  $size = (Get-Item $exePath).Length
  if ($size -le 0) { throw "Empty build output: $exePath" }
  Write-Host "  $exe -> $([math]::Round($size / 1MB, 1)) MB"
}

if ($GenerateSelfSignedCert -and [string]::IsNullOrWhiteSpace($thumbprint)) {
  Write-Step "Preparing free self-signed Code Signing certificate"
  $existingCert = Get-ChildItem -Path Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like "*CN=Yaseir*" -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if ($existingCert) {
    $signingCert = $existingCert
    Write-Host "  Reusing existing Yaseir certificate: $($signingCert.Thumbprint)"
  } else {
    $signingCert = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject "CN=Yaseir, O=Yaseir Cloud Printing, C=EG" `
      -KeyAlgorithm RSA `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -NotAfter (Get-Date).AddYears(3)
    Write-Host "  Created new Yaseir self-signed certificate: $($signingCert.Thumbprint)"
  }
  $thumbprint = $signingCert.Thumbprint
}

if ($signingCert) {
  $publicCerPath = Join-Path $agentDir "yaseir-public.cer"
  Export-Certificate -Cert $signingCert -FilePath $publicCerPath -Force | Out-Null
  Write-Host "  Exported public certificate -> $publicCerPath"
  $env:TAURI_CONFIG = (@{
    bundle = @{
      resources = @{
        "../agent/YaseirAgent.exe" = "resources/YaseirAgent.exe"
        "../agent/yaseir-agent-cli.exe" = "resources/yaseir-agent-cli.exe"
        "../agent/yaseir-public.cer" = "resources/yaseir-public.cer"
      }
      windows = @{
        certificateThumbprint = $signingCert.Thumbprint
        digestAlgorithm = "sha256"
      }
    }
  } | ConvertTo-Json -Depth 6 -Compress)
  Write-Step "Signing Go Agent executables (Authenticode SHA-256)"
  foreach ($exe in @("YaseirAgent.exe", "yaseir-agent-cli.exe")) {
    $exePath = Join-Path $agentDir $exe
    $sigResult = Set-AuthenticodeSignature -FilePath $exePath -Certificate $signingCert -HashAlgorithm SHA256 -ErrorAction Stop
    $signatureStatus = Assert-AuthenticodeSigningResult $sigResult $signingCert.Thumbprint $exePath
    Write-Host "  Signed $exe (thumbprint: $($signingCert.Thumbprint); status: $signatureStatus)"
    if ($signatureStatus -eq "NotTrusted") { Write-Host "  Publisher trust is not established on this build host." }
  }
}

# ── 6. Tauri bundle ──────────────────────────────────────────────────────────
# Tauri's target directory may be cached between builds. Remove previous
# installer outputs so legacy files can never leak into the current release.
Write-Step "Cleaning stale Tauri installer bundles"
foreach ($dir in @("msi", "nsis")) {
  $path = Join-Path $bundleDir $dir
  if (Test-Path $path) {
    Remove-Item -Recurse -Force $path
  }
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

Write-Step "cargo tauri build (--target $Target --bundles $Bundles)"
Push-Location $repoRoot
try {
  cargo tauri build --target $Target --bundles $Bundles
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# ── 7. Artifact verification + summary ───────────────────────────────────────
Write-Step "Verifying installer artifacts"
$artifacts = @()
if ($Bundles -match "nsis") {
  $nsis = @(Get-ChildItem (Join-Path $bundleDir "nsis\Yaseir Print Manager_*-setup.exe") -File -ErrorAction SilentlyContinue)
  if ($nsis.Count -ne 1) { throw "Expected exactly one Yaseir Print Manager NSIS installer under $bundleDir\nsis; found $($nsis.Count)" }
  $unexpectedNsis = @(Get-ChildItem (Join-Path $bundleDir "nsis\*.exe") -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $nsis[0].Name })
  if ($unexpectedNsis.Count -ne 0) { throw "Unexpected extra NSIS executable(s) detected: $($unexpectedNsis.Name -join ', ')" }
  if ($signingCert) {
    Write-Step "Signing final NSIS installer executable"
    $sigResult = Set-AuthenticodeSignature -FilePath $nsis[0].FullName -Certificate $signingCert -HashAlgorithm SHA256 -ErrorAction Stop
    $signatureStatus = Assert-AuthenticodeSigningResult $sigResult $signingCert.Thumbprint $nsis[0].FullName
    Write-Host "  Signed installer: $($nsis[0].Name) (status: $signatureStatus)"
    if ($signatureStatus -eq "NotTrusted") { Write-Host "  Publisher trust is not established on this build host." }
  }
  $artifacts += $nsis
}

Write-Host ""
Write-Host "Build succeeded. Installer artifacts:" -ForegroundColor Green
foreach ($a in $artifacts) {
  Write-Host ("  {0}  ({1:N1} MB)" -f $a.FullName, ($a.Length / 1MB))
}

Write-Host @"

Next steps for a production release:
  1. Smoke-test on a CLEAN Windows VM (no Node/Go/Rust — WebView2 must come
     from the installer bootstrapper):
       .\\scripts\\smoke-test-windows.ps1
  2. Test upgrade + uninstall paths: install previous version, upgrade,
     run the app, then uninstall and confirm Add/Remove Programs is clean.
"@ -ForegroundColor DarkGray
