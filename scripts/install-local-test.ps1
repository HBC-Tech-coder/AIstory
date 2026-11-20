[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
  throw "Install Node.js 24 LTS (minimum 22), reopen PowerShell, and retry."
}
if (-not (Get-Command corepack.cmd -ErrorAction SilentlyContinue)) {
  throw "Corepack is missing. Run npm.cmd install --global corepack, reopen PowerShell, and retry."
}

# The browser test kit does not need the Electron desktop binary.
$previousElectronSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
Push-Location $repoRoot
try {
  & corepack.cmd pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "AIstory dependency installation failed." }
  foreach ($relative in @("vendor\localminidrama\backend-node", "vendor\localminidrama\frontweb")) {
    Push-Location (Join-Path $repoRoot $relative)
    try {
      & npm.cmd ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed in $relative." }
    } finally { Pop-Location }
  }
  Push-Location (Join-Path $repoRoot "vendor\localminidrama\frontweb")
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "LocalMiniDrama frontend build failed." }
  } finally { Pop-Location }
} finally {
  Pop-Location
  $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $previousElectronSkip
}

Write-Host "Installed. Run: powershell -ExecutionPolicy Bypass -File scripts/start-aistory-local-stack.ps1"
Write-Host "Then open http://127.0.0.1:4200 . No API key is needed for the bundled published examples."
