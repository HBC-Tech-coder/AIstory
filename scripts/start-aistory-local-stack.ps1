[CmdletBinding()]
param(
  [switch]$StatusOnly,
  [switch]$AllowLanBinding,
  [string]$LocalMiniDramaRoot = "",
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

$aiStoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LocalMiniDramaRoot)) {
  $bundledCore = Join-Path $aiStoryRoot "vendor\localminidrama"
  $localMiniDramaRoot = $bundledCore
} else {
  $localMiniDramaRoot = [System.IO.Path]::GetFullPath($LocalMiniDramaRoot)
}
$localMiniDramaBackendRoot = Join-Path $localMiniDramaRoot "backend-node"
$localMiniDramaLogs = Join-Path $aiStoryRoot ".logs\localminidrama"
$localMiniDramaPids = Join-Path $aiStoryRoot ".logs\pids"
$aiStoryLogs = Join-Path $aiStoryRoot ".logs"
$safeBackendLauncher = Join-Path $aiStoryRoot "scripts\localminidrama-safe-launch.cjs"
$bindHost = if ($AllowLanBinding) { "0.0.0.0" } else { "127.0.0.1" }
$backendArguments = @(
  $safeBackendLauncher,
  "--backend-root",
  $localMiniDramaBackendRoot,
  "--port",
  "5679"
)
if ($AllowLanBinding) {
  $backendArguments += "--allow-lan-binding"
  Write-Warning "LAN binding explicitly enabled for this development run. All three services may be reachable from the local network; TLS verification remains enabled."
}

$services = @(
  @{
    Name = "AIstory"
    Port = 4200
    Root = $aiStoryRoot
    Command = "node.exe"
    Arguments = @((Join-Path $aiStoryRoot "node_modules\next\dist\bin\next"), "dev", "--hostname", $bindHost, "--port", "4200")
    Stdout = Join-Path $aiStoryLogs "dev-4200.out.log"
    Stderr = Join-Path $aiStoryLogs "dev-4200.err.log"
    PidFile = Join-Path $aiStoryLogs "dev-4200.wrapper.pid"
    HealthUrl = "http://127.0.0.1:4200/"
    ExpectedStatus = 200
    RequiredCommandLineFragments = @($aiStoryRoot, "start-server.js")
  },
  @{
    Name = "LocalMiniDrama backend"
    Port = 5679
    Root = $localMiniDramaBackendRoot
    Command = "node.exe"
    Arguments = $backendArguments
    Stdout = Join-Path $localMiniDramaLogs "localminidrama-backend-5679.out.log"
    Stderr = Join-Path $localMiniDramaLogs "localminidrama-backend-5679.err.log"
    PidFile = Join-Path $localMiniDramaPids "localminidrama-backend-5679.wrapper.pid"
    HealthUrl = "http://127.0.0.1:5679/health"
    ExpectedStatus = 200
    RequiredCommandLineFragments = @(
      $safeBackendLauncher,
      "--backend-root",
      $localMiniDramaBackendRoot
    )
  },
  @{
    Name = "LocalMiniDrama frontend"
    Port = 4107
    Root = Join-Path $localMiniDramaRoot "frontweb"
    Command = "node.exe"
    Arguments = @((Join-Path $localMiniDramaRoot "frontweb\node_modules\vite\bin\vite.js"), "--host", $bindHost, "--port", "4107", "--strictPort")
    Stdout = Join-Path $localMiniDramaLogs "localminidrama-frontweb-4107.out.log"
    Stderr = Join-Path $localMiniDramaLogs "localminidrama-frontweb-4107.err.log"
    PidFile = Join-Path $localMiniDramaPids "localminidrama-frontweb-4107.wrapper.pid"
    HealthUrl = "http://127.0.0.1:4107/"
    ExpectedStatus = 200
    RequiredCommandLineFragments = @(
      (Join-Path $localMiniDramaRoot "frontweb"),
      "vite"
    )
  }
)

function Get-ListenerConnections {
  param([int]$Port)
  return @(
    Get-NetTCPConnection `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue
  )
}

function Assert-ExpectedListenerBinding {
  param(
    [hashtable]$Service,
    [object[]]$Connections
  )
  if (-not $Connections -or $Connections.Count -eq 0) {
    return $null
  }

  $allowedAddresses = if ($AllowLanBinding) {
    @("127.0.0.1", "::1", "0.0.0.0", "::")
  } else {
    @("127.0.0.1", "::1")
  }
  $unexpected = @(
    $Connections | Where-Object { $allowedAddresses -notcontains $_.LocalAddress }
  )
  if ($unexpected.Count -gt 0) {
    $details = ($unexpected | ForEach-Object {
      "$($_.LocalAddress):$($_.LocalPort) PID $($_.OwningProcess)"
    }) -join ", "
    throw "$($Service.Name) has an unsafe existing listener: $details. Stop it explicitly or rerun with -AllowLanBinding after reviewing the LAN exposure risk."
  }

  $processIds = @(
    $Connections | Select-Object -ExpandProperty OwningProcess -Unique
  )
  if ($processIds.Count -ne 1) {
    throw "$($Service.Name) port $($Service.Port) is owned by multiple listeners; refusing to treat it as healthy."
  }
  $listenerProcessId = [int]$processIds[0]
  if ($Service.RequiredCommandLineFragments) {
    $listenerProcess = Get-CimInstance `
      -ClassName Win32_Process `
      -Filter "ProcessId = $listenerProcessId" `
      -ErrorAction SilentlyContinue
    if (-not $listenerProcess -or -not $listenerProcess.CommandLine) {
      throw "$($Service.Name) listener PID $listenerProcessId has no verifiable command provenance."
    }
    foreach ($fragment in $Service.RequiredCommandLineFragments) {
      if (-not $listenerProcess.CommandLine.Contains([string]$fragment)) {
        throw "$($Service.Name) listener PID $listenerProcessId was not started through the expected AIstory-owned command. Stop it explicitly before retrying."
      }
    }
  }
  return $listenerProcessId
}

function Test-HttpEndpoint {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest `
      -Uri $Url `
      -UseBasicParsing `
      -MaximumRedirection 0 `
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
    $connections = @(Get-ListenerConnections -Port $Service.Port)
    $listenerProcessId = Assert-ExpectedListenerBinding `
      -Service $Service `
      -Connections $connections
    if ($listenerProcessId) {
      $status = Test-HttpEndpoint -Url $Service.HealthUrl
      if ($status -eq $Service.ExpectedStatus) {
        return @{
          Pid = $listenerProcessId
          HttpStatus = $status
        }
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return @{
    Pid = Assert-ExpectedListenerBinding `
      -Service $Service `
      -Connections @(Get-ListenerConnections -Port $Service.Port)
    HttpStatus = Test-HttpEndpoint -Url $Service.HealthUrl
  }
}

if (-not $StatusOnly) {
  foreach ($directory in @(
    $aiStoryLogs,
    $localMiniDramaLogs,
    $localMiniDramaPids
  )) {
    if (-not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
  }
}

$started = @()
foreach ($service in $services) {
  if (-not (Test-Path -LiteralPath $service.Root -PathType Container)) {
    throw "$($service.Name) root does not exist: $($service.Root)"
  }

  $listenerProcessId = Assert-ExpectedListenerBinding `
    -Service $service `
    -Connections @(Get-ListenerConnections -Port $service.Port)
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
    -ArgumentList ($service.Arguments | ForEach-Object { '"' + $_ + '"' }) `
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
  $timeout = if ($StatusOnly) { 1 } else { $WaitSeconds }
  $ready = Wait-ServiceReady -Service $service -TimeoutSeconds $timeout
  $ok = $ready.Pid -and $ready.HttpStatus -eq $service.ExpectedStatus
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

$bridgeChecks = @(
  @{ Url = "http://127.0.0.1:4200/api/localminidrama/status"; ExpectedStatus = 200 },
  @{ Url = "http://127.0.0.1:4200/api/localminidrama/dramas"; ExpectedStatus = 200 },
  @{ Url = "http://127.0.0.1:4200/studio"; ExpectedStatus = 200 }
)

foreach ($check in $bridgeChecks) {
  $status = Test-HttpEndpoint -Url $check.Url
  if ($status -ne $check.ExpectedStatus) {
    Write-Error "Bridge check failed: expected HTTP $($check.ExpectedStatus), received HTTP $status $($check.Url)"
    exit 1
  }
  Write-Host "[http $status] $($check.Url)"
}

if ($started.Count -eq 0) {
  Write-Host "All services were already running; no duplicate process was started."
} else {
  Write-Host "Started: $($started -join ', ')"
}
