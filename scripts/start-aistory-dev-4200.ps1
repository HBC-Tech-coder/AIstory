[CmdletBinding()]
param(
  [switch]$AllowLanBinding
)

$ErrorActionPreference = "Stop"

$projectRoot = "D:\AIstory"
$port = 4200
$bindHost = if ($AllowLanBinding) { "0.0.0.0" } else { "127.0.0.1" }

if ($AllowLanBinding) {
  Write-Warning "LAN binding explicitly enabled for this development run. AIstory may be reachable from the local network."
}

$existing = @(
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
)
if ($existing) {
  $allowedAddresses = if ($AllowLanBinding) {
    @("127.0.0.1", "::1", "0.0.0.0", "::")
  } else {
    @("127.0.0.1", "::1")
  }
  $unsafe = @(
    $existing | Where-Object { $allowedAddresses -notcontains $_.LocalAddress }
  )
  if ($unsafe.Count -gt 0) {
    throw "AIstory has an unsafe existing listener on port $port. Stop it explicitly or rerun with -AllowLanBinding after reviewing the LAN exposure risk."
  }
  Write-Host "AIstory dev server already listening on http://localhost:$port/ (PID $($existing[0].OwningProcess))."
  exit 0
}

Set-Location -LiteralPath $projectRoot
pnpm exec next dev -H $bindHost -p $port
