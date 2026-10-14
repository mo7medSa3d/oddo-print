#Requires -Version 5.1
# Exercise the actual pure release helpers, without running installer builds,
# installing packages, reading certificate stores, or signing any file.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$builder = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts/build-windows-installer.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($builder, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -ne 0) { throw "Release builder has PowerShell parse errors: $parseErrors" }
foreach ($name in @("Get-GoArchitectureForTarget", "Assert-CodeSigningCertificate", "Assert-AuthenticodeSigningResult")) {
  $definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($definitions.Count -ne 1) { throw "Expected exactly one production helper '$name'" }
  Invoke-Expression $definitions[0].Extent.Text
}

$script:checks = 0
function Assert-Equal($Actual, $Expected) {
  if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" }
  $script:checks++
}
function Assert-Throws([scriptblock]$Action) {
  $threw = $false
  try { & $Action | Out-Null } catch { $threw = $true }
  if (-not $threw) { throw "Expected production helper to reject invalid input" }
  $script:checks++
}

Assert-Equal (Get-GoArchitectureForTarget "x86_64-pc-windows-msvc") "amd64"
Assert-Equal (Get-GoArchitectureForTarget "i686-pc-windows-msvc") "386"
Assert-Equal (Get-GoArchitectureForTarget "aarch64-pc-windows-msvc") "arm64"
foreach ($target in @("x86_64-unknown-linux-gnu", "x86_64-pc-windows-gnu", "bogus", "")) {
  Assert-Throws { Get-GoArchitectureForTarget $target }
}

$certificate = [pscustomobject]@{ Thumbprint = "AABBCC" }
Assert-CodeSigningCertificate $certificate "aabbcc"
$script:checks++
Assert-Throws { Assert-CodeSigningCertificate $null "AABBCC" }
Assert-Throws { Assert-CodeSigningCertificate $certificate "" }
Assert-Throws { Assert-CodeSigningCertificate $certificate "DIFFERENT" }

foreach ($status in @("Valid", "NotTrusted")) {
  $signature = [pscustomobject]@{ Status = $status; SignerCertificate = $certificate }
  Assert-Equal (Assert-AuthenticodeSigningResult $signature "AABBCC" "fixture.exe") $status
}
foreach ($status in @("UnknownError", "NotSigned", "HashMismatch", "NotSupportedFileFormat", "Incompatible", "future-status")) {
  $signature = [pscustomobject]@{ Status = $status; SignerCertificate = $certificate }
  Assert-Throws { Assert-AuthenticodeSigningResult $signature "AABBCC" "fixture.exe" }
}
Assert-Throws { Assert-AuthenticodeSigningResult $null "AABBCC" "fixture.exe" }
$signature = [pscustomobject]@{ Status = "Valid"; SignerCertificate = $null }
Assert-Throws { Assert-AuthenticodeSigningResult $signature "AABBCC" "fixture.exe" }
$signature = [pscustomobject]@{ Status = "Valid"; SignerCertificate = $certificate }
Assert-Throws { Assert-AuthenticodeSigningResult $signature "DIFFERENT" "fixture.exe" }
Assert-Throws { Assert-AuthenticodeSigningResult $signature "" "fixture.exe" }
Write-Host "Windows release pure helper checks passed: $script:checks"
