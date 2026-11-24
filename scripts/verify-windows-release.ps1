#Requires -Version 7.0
<#
.SYNOPSIS
  Bind a signed Windows release and installed files to exact SHA-256 evidence.
.DESCRIPTION
  Record validates the explicit installer, its packaged Manager and Go outputs.
  Installed validates the same installed bytes, public publisher trust, SCM
  executable ownership and WebView2 presence. Uninstalled checks removal.
  This script never installs, uninstalls, reboots, changes trust, or prints.
  A successful stage is not lifecycle or physical-printer acceptance.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet("Record", "Installed", "Uninstalled")][string]$Mode,
  [Parameter(Mandatory)][string]$ManifestPath,
  [Parameter(Mandatory)][string]$ExpectedPublisherThumbprint,
  [string]$ExpectedManifestSha256,
  [string]$SourceArchiveSha256,
  [string]$InstallerPath,
  [string]$PackagedManagerPath,
  [string]$InstallDir,
  [string]$OutputPath,
  [string]$Target = "x86_64-pc-windows-msvc"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PackagedManagerPath([string]$CandidatePath, [string]$PrebundlePath) {
  if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    throw "Record requires -PackagedManagerPath from the exact candidate installer"
  }
  $resolved = [IO.Path]::GetFullPath($CandidatePath)
  if ([string]::Equals($resolved, [IO.Path]::GetFullPath($PrebundlePath), [StringComparison]::OrdinalIgnoreCase)) {
    throw "The pre-bundle Manager is not the patched executable packaged by Tauri"
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "The exact packaged Manager is missing: $resolved"
  }
  return $resolved
}

function Assert-ExactFileHash([string]$Path, [string]$ExpectedSha256) {
  if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "A complete expected SHA-256 is required" }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Release file is missing: $Path" }
  $item = Get-Item -LiteralPath $Path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release file is a reparse point: $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if ($actual -ne $ExpectedSha256) { throw "Release file does not match the recorded SHA-256: $Path" }
}

function Assert-ReleaseSignatureRecord($Record, [string]$ExpectedThumbprint) {
  if (-not $Record -or [string]::IsNullOrWhiteSpace($ExpectedThumbprint) -or
      $Record.Status -ne "Valid" -or $Record.Thumbprint -ne $ExpectedThumbprint -or
      $Record.Subject -eq $Record.Issuer -or -not $Record.CodeSigningEku -or -not $Record.ChainValid) {
    throw "Public code-signing trust and the expected publisher were not established"
  }
}

function Get-ReleaseSignature([string]$Path, [string]$ExpectedThumbprint) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $certificate = $signature.SignerCertificate
  if (-not $certificate) { throw "Release file has no Authenticode publisher: $Path" }
  $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
    $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    $chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
    $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
    $chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3"))
    $record = [pscustomobject]@{
      Status = [string]$signature.Status
      Thumbprint = $certificate.Thumbprint
      Subject = $certificate.Subject
      Issuer = $certificate.Issuer
      CodeSigningEku = @($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq "1.3.6.1.5.5.7.3.3" }).Count -gt 0
      ChainValid = $chain.Build($certificate)
    }
    Assert-ReleaseSignatureRecord $record $ExpectedThumbprint
    return $record
  } finally { $chain.Dispose() }
}

function Write-EvidenceJson([string]$Path, $Value) {
  $resolved = [IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $resolved) { throw "Evidence already exists; use a new stage filename: $resolved" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $resolved) -Force | Out-Null
  $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resolved -Encoding utf8NoBOM
  Write-Host "Evidence: $resolved"
  Write-Host "SHA256: $((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash)"
}

if (-not $IsWindows) { throw "BLOCKED: this acceptance stage requires an actual Windows host" }
if ($Target -ne "x86_64-pc-windows-msvc") { throw "This acceptance profile verifies the supported Windows x64 release" }
$ExpectedPublisherThumbprint = $ExpectedPublisherThumbprint.Trim()
$repoRoot = Split-Path -Parent $PSScriptRoot
$managerBuildPath = $null
if ($Mode -eq "Record") {
  # Tauri patches and re-signs the Manager embedded in NSIS, then restores the
  # pre-bundle release executable. Record the actual candidate payload bytes.
  $prebundleManager = Join-Path $repoRoot "src-tauri/target/$Target/release/yaseir-manager.exe"
  $managerBuildPath = Get-PackagedManagerPath $PackagedManagerPath $prebundleManager
}
$artifacts = @(
  @{ id = "installer"; buildPath = $InstallerPath; installedPath = $null },
  @{ id = "manager"; buildPath = $managerBuildPath; installedPath = "yaseir-manager.exe" },
  @{ id = "agent"; buildPath = (Join-Path $repoRoot "agent/YaseirAgent.exe"); installedPath = "resources/YaseirAgent.exe" },
  @{ id = "cli"; buildPath = (Join-Path $repoRoot "agent/yaseir-agent-cli.exe"); installedPath = "resources/yaseir-agent-cli.exe" }
)
$os = Get-CimInstance Win32_OperatingSystem
$environment = @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; lastBootUtc = $os.LastBootUpTime.ToUniversalTime().ToString("o") }

if ($Mode -eq "Record") {
  if ($SourceArchiveSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Record requires the verified final source archive SHA-256" }
  if ([string]::IsNullOrWhiteSpace($InstallerPath)) { throw "Select the exact new installer; no directory discovery is performed" }
  $records = foreach ($artifact in $artifacts) {
    $path = [IO.Path]::GetFullPath($artifact.buildPath)
    $signature = Get-ReleaseSignature $path $ExpectedPublisherThumbprint
    $sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    Assert-ExactFileHash $path $sha256
    @{ id = $artifact.id; name = [IO.Path]::GetFileName($path); installedPath = $artifact.installedPath; bytes = (Get-Item -LiteralPath $path).Length; sha256 = $sha256; signature = $signature }
  }
  Write-EvidenceJson $ManifestPath @{
    schema = 1; stage = "signed-build-record"; createdUtc = [DateTime]::UtcNow.ToString("o")
    sourceArchiveSha256 = $SourceArchiveSha256; target = $Target
    publisherThumbprint = $ExpectedPublisherThumbprint; environment = $environment; artifacts = @($records)
    lifecycleAcceptance = "BLOCKED until install, upgrade, crash, reboot, rollback and uninstall observations are recorded"
    physicalAcceptance = "BLOCKED until authorized physical printer matrix is completed"
  }
  return
}

Assert-ExactFileHash $ManifestPath $ExpectedManifestSha256
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.target -ne $Target -or $manifest.publisherThumbprint -ne $ExpectedPublisherThumbprint) {
  throw "Release manifest identity does not match this acceptance run"
}
if ((@($manifest.artifacts.id | Sort-Object) -join ',') -ne 'agent,cli,installer,manager') { throw "Release manifest must contain exactly the four required artifacts" }
if ([string]::IsNullOrWhiteSpace($InstallDir) -or [string]::IsNullOrWhiteSpace($OutputPath)) { throw "Installed/Uninstalled requires an explicit installation directory and new evidence path" }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$service = Get-CimInstance Win32_Service -Filter "Name='YaseirAgent'"
if ($Mode -eq "Uninstalled") {
  if ($service) { throw "The YaseirAgent service still exists" }
  if ((Test-Path -LiteralPath $InstallDir) -and @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0) { throw "The installation directory is not empty" }
  Write-EvidenceJson $OutputPath @{ schema = 1; stage = "uninstalled-binaries-and-service"; result = "PASS"; manifestSha256 = $ExpectedManifestSha256; utc = [DateTime]::UtcNow.ToString("o"); environment = $environment; dataRetentionAcceptance = "Requires the separate documented data-purge/retention and ACL observations" }
  return
}
$installed = foreach ($artifact in $artifacts | Where-Object { $_.id -ne "installer" }) {
  $expected = @($manifest.artifacts | Where-Object { $_.id -eq $artifact.id })[0]
  if ($expected.installedPath -ne $artifact.installedPath) { throw "Unexpected installation layout in release manifest" }
  $path = Join-Path $InstallDir $artifact.installedPath
  Assert-ExactFileHash $path $expected.sha256
  $signature = Get-ReleaseSignature $path $ExpectedPublisherThumbprint
  @{ id = $artifact.id; sha256 = $expected.sha256; signature = $signature }
}
if (-not $service) { throw "Installed YaseirAgent service is missing" }
$imagePath = [string]$service.PathName
$match = [regex]::Match($imagePath, '^\s*"([^"\r\n]+)"(?:\s|$)')
if (-not $match.Success) { throw "Service executable path must be explicitly quoted" }
$ownedAgent = [IO.Path]::GetFullPath((Join-Path $InstallDir "resources/YaseirAgent.exe"))
if (-not [string]::Equals([IO.Path]::GetFullPath($match.Groups[1].Value), $ownedAgent, [StringComparison]::OrdinalIgnoreCase)) { throw "SCM service executable is not the verified installed agent" }
$webview = foreach ($key in @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)) {
  if (Test-Path -LiteralPath $key) {
    $version = (Get-ItemProperty -LiteralPath $key -Name pv).pv
    if ([version]$version -gt [version]'0.0.0.0') { [string]$version }
  }
}
if (@($webview).Count -eq 0) { throw "The production WebView2 Runtime was not detected" }
Write-EvidenceJson $OutputPath @{
  schema = 1; stage = "installed-artifact-identity"; result = "PASS"; manifestSha256 = $ExpectedManifestSha256
  utc = [DateTime]::UtcNow.ToString("o"); environment = $environment; artifacts = @($installed)
  service = @{ state = $service.State; startMode = $service.StartMode; account = $service.StartName; processId = $service.ProcessId; executable = $ownedAgent }
  webview2Versions = @($webview)
  remainingAcceptance = "Run smoke-test-windows.ps1 and the lifecycle, ACL/DPAPI and physical matrix; this stage verifies identity only"
}
