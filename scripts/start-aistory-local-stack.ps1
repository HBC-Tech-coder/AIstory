[CmdletBinding()]
param(
  [switch]$StatusOnly,
  [ValidateRange(1, 120)]
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = "Stop"

# Some launchers provide both Path and PATH entries. Windows PowerShell's
# Start-Process builds a case-insensitive environment dictionary and fails on
# that duplicate, so normalize the process-local entry before spawning.
$taskPathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $taskPathValue, "Process")

$aiStoryRoot = "D:\AIstory"
$localMiniDramaRoot = "D:\AI-story\repos\localminidrama"
$localMiniDramaLogs = "D:\AI-story\logs"
$localMiniDramaPids = "D:\AI-story\pids"
$aiStoryLogs = Join-Path $aiStoryRoot ".logs"

$services = @(
  @{
    Name = "AIstory"
    Port = 4200
    Root = $aiStoryRoot
    Command = "pnpm.cmd"
    Arguments = @("dev", "--hostname", "0.0.0.0", "--port", "4200")
    Stdout = Join-Path $aiStoryLogs "dev-4200.out.log"
    Stderr = Join-Path $aiStoryLogs "dev-4200.err.log"
    PidFile = Join-Path $aiStoryLogs "dev-4200.wrapper.pid"
    HealthUrl = "http://127.0.0.1:4200/"
  },
  @{
    Name = "LocalMiniDrama backend"
    Port = 5679
    Root = Join-Path $localMiniDramaRoot "backend-node"
    Command = "npm.cmd"
    Arguments = @("start")
    Stdout = Join-Path $localMiniDramaLogs "localminidrama-backend-5679.out.log"
    Stderr = Join-Path $localMiniDramaLogs "localminidrama-backend-5679.err.log"
    PidFile = Join-Path $localMiniDramaPids "localminidrama-backend-5679.wrapper.pid"
    HealthUrl = "http://127.0.0.1:5679/health"
  },
  @{
    Name = "LocalMiniDrama frontend"
    Port = 4107
    Root = Join-Path $localMiniDramaRoot "frontweb"
    Command = "npm.cmd"
    Arguments = @("run", "dev", "--", "--host", "0.0.0.0", "--port", "4107")
    Stdout = Join-Path $localMiniDramaLogs "localminidrama-frontweb-4107.out.log"
    Stderr = Join-Path $localMiniDramaLogs "localminidrama-frontweb-4107.err.log"
    PidFile = Join-Path $localMiniDramaPids "localminidrama-frontweb-4107.wrapper.pid"
    HealthUrl = "http://127.0.0.1:4107/"
  }
)

function Get-ListenerProcessId {
  param([int]$Port)
  $connection = Get-NetTCPConnection `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($connection) {
    return [int]$connection.OwningProcess
  }
  return $null
}

function Test-HttpEndpoint {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest `
      -Uri $Url `
      -UseBasicParsing `
      -TimeoutSec 5
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      return [int]$_.Exception.Response.StatusCode
    }
    return 0
  }
}

function Wait-ServiceReady {
  param(
    [hashtable]$Service,
    [int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $listenerProcessId = Get-ListenerProcessId -Port $Service.Port
    if ($listenerProcessId) {
      $status = Test-HttpEndpoint -Url $Service.HealthUrl
      if ($status -ge 200 -and $status -lt 500) {
        return @{
          Pid = $listenerProcessId
          HttpStatus = $status
        }
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return @{
    Pid = Get-ListenerProcessId -Port $Service.Port
    HttpStatus = Test-HttpEndpoint -Url $Service.HealthUrl
  }
}

foreach ($directory in @(
  $aiStoryLogs,
  $localMiniDramaLogs,
  $localMiniDramaPids
)) {
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
}

$started = @()
foreach ($service in $services) {
  if (-not (Test-Path -LiteralPath $service.Root -PathType Container)) {
    throw "$($service.Name) root does not exist: $($service.Root)"
  }

  $listenerProcessId = Get-ListenerProcessId -Port $service.Port
  if ($listenerProcessId) {
    Write-Host "[running] $($service.Name) port $($service.Port), PID $listenerProcessId"
    continue
  }

  if ($StatusOnly) {
    Write-Host "[stopped] $($service.Name) port $($service.Port)"
    continue
  }

  $process = Start-Process `
    -FilePath $service.Command `
    -ArgumentList $service.Arguments `
    -WorkingDirectory $service.Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $service.Stdout `
    -RedirectStandardError $service.Stderr `
    -PassThru
  Set-Content `
    -LiteralPath $service.PidFile `
    -Value $process.Id `
    -Encoding ascii
  $started += $service.Name
  Write-Host "[starting] $($service.Name), wrapper PID $($process.Id)"
}

$results = @()
foreach ($service in $services) {
  $ready = Wait-ServiceReady -Service $service -TimeoutSeconds $WaitSeconds
  $ok = $ready.Pid -and $ready.HttpStatus -ge 200 -and $ready.HttpStatus -lt 500
  $results += [pscustomobject]@{
    Service = $service.Name
    Port = $service.Port
    ListeningPid = $ready.Pid
    HttpStatus = $ready.HttpStatus
    State = if ($ok) { "ready" } else { "unavailable" }
  }
}

$results | Format-Table -AutoSize

if (($results | Where-Object State -ne "ready").Count -gt 0) {
  Write-Error "One or more local services are unavailable. Check the existing log files."
  exit 1
}

$bridgeUrls = @(
  "http://127.0.0.1:4200/api/localminidrama/status",
  "http://127.0.0.1:4200/api/localminidrama/dramas",
  "http://127.0.0.1:4200/studio"
)

foreach ($url in $bridgeUrls) {
  $status = Test-HttpEndpoint -Url $url
  if ($status -lt 200 -or $status -ge 500) {
    Write-Error "Bridge check failed: HTTP $status $url"
    exit 1
  }
  Write-Host "[http $status] $url"
}

if ($started.Count -eq 0) {
  Write-Host "All services were already running; no duplicate process was started."
} else {
  Write-Host "Started: $($started -join ', ')"
}
