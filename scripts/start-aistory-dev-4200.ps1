$ErrorActionPreference = "Stop"

$projectRoot = "D:\AIstory"
$port = 4200

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "AIstory dev server already listening on http://localhost:$port/ (PID $($existing[0].OwningProcess))."
  exit 0
}

Set-Location -LiteralPath $projectRoot
pnpm exec next dev -H 0.0.0.0 -p $port
