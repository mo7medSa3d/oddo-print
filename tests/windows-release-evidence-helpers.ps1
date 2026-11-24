#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$source = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts/verify-windows-release.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -ne 0) { throw "Release verifier has parse errors: $parseErrors" }
foreach ($name in @("Assert-ExactFileHash", "Assert-ReleaseSignatureRecord", "Get-PackagedManagerPath")) {
  $definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($definitions.Count -ne 1) { throw "Missing production helper '$name'" }
  Invoke-Expression $definitions[0].Extent.Text
}
$checks = 0
function Assert-Throws([scriptblock]$Action) {
  $failed = $false
  try { & $Action | Out-Null } catch { $failed = $true }
  if (-not $failed) { throw "Expected release evidence to be rejected" }
  $script:checks++
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("yaseir-artifact-" + [guid]::NewGuid().ToString("N"))
try {
  [IO.File]::WriteAllText($fixture, "candidate bytes")
  $expected = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
  Assert-ExactFileHash $fixture $expected
  $checks++
  [IO.File]::WriteAllText($fixture, "different installed bytes")
  Assert-Throws { Assert-ExactFileHash $fixture $expected }
  Assert-Throws { Assert-ExactFileHash $fixture "" }
  Assert-Throws { Assert-ExactFileHash ($fixture + ".missing") $expected }
} finally { Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue }
$candidateRoot = Join-Path ([IO.Path]::GetTempPath()) ("yaseir-packaged-manager-" + [guid]::NewGuid().ToString("N"))
try {
  $prebundle = Join-Path $candidateRoot "src-tauri/target/x86_64-pc-windows-msvc/release/yaseir-manager.exe"
  $packaged = Join-Path $candidateRoot "extracted-candidate/yaseir-manager.exe"
  New-Item -ItemType Directory -Force (Split-Path -Parent $prebundle), (Split-Path -Parent $packaged) | Out-Null
  [IO.File]::WriteAllText($prebundle, "pre-bundle Manager bytes")
  [IO.File]::WriteAllText($packaged, "patched and signed packaged Manager bytes")
  Assert-Throws { Get-PackagedManagerPath "" $prebundle }
  Assert-Throws { Get-PackagedManagerPath ($packaged + ".missing") $prebundle }
  Assert-Throws { Get-PackagedManagerPath $prebundle $prebundle }
  $selected = Get-PackagedManagerPath $packaged $prebundle
  if ($selected -ne [IO.Path]::GetFullPath($packaged)) { throw "The exact packaged Manager must be selected" }
  $packagedHash = (Get-FileHash -LiteralPath $selected -Algorithm SHA256).Hash
  Assert-ExactFileHash $packaged $packagedHash
  $checks++
  Assert-Throws { Assert-ExactFileHash $prebundle $packagedHash }
} finally { Remove-Item -LiteralPath $candidateRoot -Recurse -Force -ErrorAction SilentlyContinue }
$record = [pscustomobject]@{ Status = "Valid"; Thumbprint = "AABBCC"; Subject = "CN=Publisher"; Issuer = "CN=Issuer"; CodeSigningEku = $true; ChainValid = $true }
Assert-ReleaseSignatureRecord $record "aabbcc"
$checks++
Assert-Throws { Assert-ReleaseSignatureRecord $record "WRONG" }
foreach ($field in @("CodeSigningEku", "ChainValid")) {
  $bad = $record.PSObject.Copy(); $bad.$field = $false
  Assert-Throws { Assert-ReleaseSignatureRecord $bad "AABBCC" }
}
foreach ($status in @("NotSigned", "NotTrusted", "HashMismatch", "UnknownError")) {
  $bad = $record.PSObject.Copy(); $bad.Status = $status
  Assert-Throws { Assert-ReleaseSignatureRecord $bad "AABBCC" }
}
$bad = $record.PSObject.Copy(); $bad.Issuer = $bad.Subject
Assert-Throws { Assert-ReleaseSignatureRecord $bad "AABBCC" }
Write-Host "Release artifact verification helper checks passed: $checks"
