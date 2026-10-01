param(
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,

  [Parameter(Mandatory = $true)]
  [string]$PairingCode,

  [string]$AgentCli = ".\yaseir-agent-cli.exe"
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

Write-Host "HTTP test transport is enabled directly by the isolated staging Agent/Gateway URL contract."
Write-Host "Pairing Yaseir Agent with $ServerUrl ..."

& $AgentCli -pair $PairingCode -server $ServerUrl
if ($LASTEXITCODE -ne 0) {
  throw "Yaseir Agent pairing failed with exit code $LASTEXITCODE."
}

# Verify that the persisted Agent credentials can immediately use the HTTP
# Gateway from the CLI path used by the Tauri desktop for Agent-authenticated
# console requests. This catches the exact class of bug where pairing succeeds
# but the Windows service/CLI still rejects the stored HTTP URL.
$consoleResponse = & $AgentCli gateway-request -method GET -path "/api/agents"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($consoleResponse -join ""))) {
  throw "Yaseir Agent paired, but its HTTP Gateway console request failed."
}
if (($consoleResponse -join "") -notmatch '"status":s*200') {
  throw "Yaseir Agent HTTP Gateway console request did not return HTTP 200: $($consoleResponse -join " ")"
}

Write-Host "PASS: Agent pairing and persisted HTTP Gateway authentication verified."
