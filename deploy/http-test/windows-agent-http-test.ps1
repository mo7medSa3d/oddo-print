param(
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,

  [Parameter(Mandatory = $true)]
  [string]$PairingCode,

  [string]$AgentCli = ".\yasser-agent-cli.exe"
)

$ErrorActionPreference = "Stop"

if (-not $ServerUrl.StartsWith("http://")) {
  throw "This helper is only for the isolated HTTP test environment. Use an https:// URL for production."
}

[Environment]::SetEnvironmentVariable("YASSER_AGENT_ALLOW_INSECURE_HTTP", "1", "Machine")
$env:YASSER_AGENT_ALLOW_INSECURE_HTTP = "1"

Write-Host "HTTP test transport explicitly enabled for this Windows test machine."
Write-Host "Pairing Yasser Agent with $ServerUrl ..."

& $AgentCli -pair $PairingCode -server $ServerUrl

if ($LASTEXITCODE -ne 0) {
  throw "Yasser Agent pairing failed with exit code $LASTEXITCODE."
}

Write-Host "PASS: Agent pairing command completed."
