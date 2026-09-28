param(
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,

  [Parameter(Mandatory = $true)]
  [string]$PairingCode,

  [string]$AgentCli = ".\yasser-agent-cli.exe"
)

$ErrorActionPreference = "Stop"

try {
  $uri = [Uri]$ServerUrl
} catch {
  throw "ServerUrl must be a valid HTTP URL using the server IPv4 address."
}
if ($uri.Scheme -ne "http") {
  throw "This helper is only for the isolated HTTP test environment. Use an https:// URL for production."
}
if ([string]::IsNullOrWhiteSpace($uri.Host)) {
  throw "ServerUrl must include the staging server IPv4 address."
}
try {
  $ip = [System.Net.IPAddress]::Parse($uri.Host)
} catch {
  throw "ServerUrl must use the staging server IPv4 address, not a hostname."
}
if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw "ServerUrl must use an IPv4 address."
}
if ($uri.AbsolutePath -ne "/" -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or $uri.UserInfo) {
  throw "ServerUrl must be the Gateway origin only (http://IP[:port])."
}

Write-Host "HTTP test transport is enabled by the staging Gateway URL contract with explicit insecure-HTTP opt-in for this process only."
Write-Host "Pairing Yasser Agent with $ServerUrl ..."

$env:YASSER_AGENT_ALLOW_INSECURE_HTTP = "1"
$pairExitCode = 0
try {
    & $AgentCli -pair $PairingCode -server $ServerUrl
    $pairExitCode = $LASTEXITCODE
} finally {
    Remove-Item Env:YASSER_AGENT_ALLOW_INSECURE_HTTP -ErrorAction SilentlyContinue
}

if ($pairExitCode -ne 0) {
  throw "Yasser Agent pairing failed with exit code $pairExitCode."
}

Write-Host "PASS: Agent pairing command completed."
