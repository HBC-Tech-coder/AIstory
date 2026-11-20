#requires -Version 5.1
<#
  Stages and starts an isolated AIstory Next.js candidate for the default-off
  Linghao Passport v4 local test surface.

  This launcher never creates, copies, prints, hashes, rewrites, or overwrites
  the protected secret. It reads metadata and the DACL only, then passes the
  exact selector and exact file reference to the foreground child process.
  Product sources are copied through an explicit allowlist into a fresh run
  directory outside the repository; no production env/config or recursive App
  tree participates in route discovery.
#>

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SelectorName = "AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE"
$SelectorValue = "aistory-linghao-passport-v4-local-v1:enabled"
$SecretFileEnvName = "AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE"
$SecretFilePath = "C:\Users\sunat\AppData\Local\AIstory\secrets\linghao-passport-v4\client-secret.v1"
$ExpectedHost = "127.0.0.1"
$ExpectedPort = 4200
$CandidateBaseDirectoryName = "AIstory-e2e-runs\linghao-passport-v4"
$RuntimeRelativeFiles = @(
  "lib\auth\linghaoPassportV4Public.ts",
  "lib\auth\linghaoPassportV4Config.ts",
  "lib\auth\linghaoPassportV4SecretFile.ts",
  "lib\auth\linghaoPassportV4Oidc.ts",
  "lib\auth\linghaoPassportV4Session.ts",
  "lib\auth\linghaoPassportV4Server.ts",
  "app\api\auth\linghao-passport-v4\capabilities\route.ts",
  "app\api\auth\linghao-passport-v4\start\route.ts",
  "app\api\auth\linghao-passport-v4\callback\route.ts",
  "app\api\auth\linghao-passport-v4\session\route.ts",
  "app\api\auth\linghao-passport-v4\renew\route.ts",
  "app\api\auth\linghao-passport-v4\draft\route.ts",
  "app\api\auth\linghao-passport-v4\logout\route.ts",
  "app\api\auth\linghao-passport-v4\logged-out\route.ts",
  "app\auth\linghao-passport-v4\page.tsx",
  "components\LinghaoPassportV4LocalPanel.tsx"
)

function Fail-Closed {
  param([string]$Reason)
  throw "Linghao Passport v4 launcher refused: $Reason"
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-InstalledPackageVersion {
  param(
    [Parameter(Mandatory = $true)][string]$NodeModulesPath,
    [Parameter(Mandatory = $true)][string]$PackageName
  )
  $packageJsonPath = Join-Path (
    Join-Path $NodeModulesPath $PackageName
  ) "package.json"
  if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    Fail-Closed "installed package $PackageName is unavailable"
  }
  $packageDocument = Get-Content -LiteralPath $packageJsonPath -Raw |
    ConvertFrom-Json
  if ($packageDocument.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    Fail-Closed "installed package $PackageName has an invalid version"
  }
  return [string]$packageDocument.version
}

function Copy-VerifiedCandidateFile {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$CandidateRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )
  $repositoryPrefix = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\') + '\'
  $sourcePath = [System.IO.Path]::GetFullPath(
    (Join-Path $RepositoryRoot $RelativePath)
  )
  if (-not $sourcePath.StartsWith(
    $repositoryPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    Fail-Closed "candidate source escaped the repository root"
  }
  $sourceItem = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
  if (-not ($sourceItem -is [System.IO.FileInfo])) {
    Fail-Closed "candidate source $RelativePath is not a regular file"
  }
  if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-Closed "candidate source $RelativePath is a reparse point"
  }

  $destinationPath = Join-Path $CandidateRoot $RelativePath
  $destinationDirectory = Split-Path -Parent $destinationPath
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath

  $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $destinationHash = (
    Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($sourceHash -ne $destinationHash) {
    Fail-Closed "candidate copy verification failed for $RelativePath"
  }
  return [ordered]@{
    path = $RelativePath.Replace('\', '/')
    sha256 = $sourceHash
  }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Fail-Closed "Windows is required"
}
if ($env:NODE_ENV -eq "production") {
  Fail-Closed "NODE_ENV=production is not allowed"
}
if (Test-Path Env:AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET) {
  Fail-Closed "the retired direct-secret environment variable must be absent"
}

$expectedNormalized = [System.IO.Path]::GetFullPath($SecretFilePath)
$secretItem = Get-Item -LiteralPath $SecretFilePath -Force -ErrorAction Stop
if (-not ($secretItem -is [System.IO.FileInfo])) {
  Fail-Closed "the secret reference is not a regular file"
}
if (-not [string]::Equals(
  [System.IO.Path]::GetFullPath($secretItem.FullName),
  $expectedNormalized,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  Fail-Closed "the secret reference resolved to an unexpected path"
}
if ($secretItem.Length -lt 32 -or $secretItem.Length -gt 256) {
  Fail-Closed "the secret file size is outside the required bound"
}
if (($secretItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  Fail-Closed "the secret reference is a reparse point"
}
$linkTypeProperty = $secretItem.PSObject.Properties["LinkType"]
if ($null -ne $linkTypeProperty -and
    $null -ne $linkTypeProperty.Value -and
    $linkTypeProperty.Value -ne "") {
  Fail-Closed "the secret reference is a link"
}

$cursor = $secretItem.Directory
while ($null -ne $cursor) {
  if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-Closed "a parent directory is a reparse point"
  }
  $cursor = $cursor.Parent
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$systemSid = "S-1-5-18"
$acl = Get-Acl -LiteralPath $SecretFilePath
if (-not $acl.AreAccessRulesProtected) {
  Fail-Closed "the secret DACL is inherited"
}
$ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
  [System.Security.Principal.SecurityIdentifier]
).Value
if ($ownerSid -ne $currentSid) {
  Fail-Closed "the secret owner is not the current interactive user"
}
$explicitRules = @($acl.GetAccessRules(
  $true,
  $false,
  [System.Security.Principal.SecurityIdentifier]
))
if ($explicitRules.Count -eq 0) {
  Fail-Closed "the secret DACL has no explicit grants"
}
$sawCurrentUser = $false
$sawLocalSystem = $false
foreach ($rule in $explicitRules) {
  if ($rule.IsInherited) {
    Fail-Closed "the secret DACL contains an inherited ACE"
  }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    Fail-Closed "the secret DACL contains a non-allow ACE"
  }
  $sid = $rule.IdentityReference.Value
  if ($sid -ne $currentSid -and $sid -ne $systemSid) {
    Fail-Closed "the secret DACL contains an unexpected principal"
  }
  if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None -or
      $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
    Fail-Closed "the secret DACL contains an unexpected rights shape"
  }
  if ($sid -eq $currentSid) {
    if ($sawCurrentUser) { Fail-Closed "the current-user ACE is duplicated" }
    $sawCurrentUser = $true
  } else {
    if ($sawLocalSystem) { Fail-Closed "the LocalSystem ACE is duplicated" }
    $sawLocalSystem = $true
  }
}
if ($explicitRules.Count -ne 2 -or -not $sawCurrentUser -or -not $sawLocalSystem) {
  Fail-Closed "the secret DACL must contain exactly current user and LocalSystem"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$CandidateBasePath = Join-Path (
  Split-Path -Parent $repoRoot
) $CandidateBaseDirectoryName
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "next.config.ts") -PathType Leaf) -and
    -not (Test-Path -LiteralPath (Join-Path $repoRoot "next.config.mjs") -PathType Leaf) -and
    -not (Test-Path -LiteralPath (Join-Path $repoRoot "next.config.js") -PathType Leaf)) {
  Fail-Closed "the AIstory repository root could not be identified"
}
$repoNodeModules = Join-Path $repoRoot "node_modules"
$nextEntry = Join-Path $repoNodeModules "next\dist\bin\next"
if (-not (Test-Path -LiteralPath $nextEntry -PathType Leaf)) {
  Fail-Closed "the repository-local Next entry point is unavailable"
}
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $nodeCommand -PathType Leaf)) {
  Fail-Closed "node.exe is unavailable"
}
if (Get-NetTCPConnection -LocalPort $ExpectedPort -State Listen -ErrorAction SilentlyContinue) {
  Fail-Closed "port $ExpectedPort already has a listener"
}

$candidateBase = [System.IO.Path]::GetFullPath($CandidateBasePath)
New-Item -ItemType Directory -Path $candidateBase -Force | Out-Null
$candidateBaseItem = Get-Item -LiteralPath $candidateBase -Force
if (($candidateBaseItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  Fail-Closed "the candidate base is a reparse point"
}
$runId = "run-{0}-{1}" -f (
  (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
), ([System.Guid]::NewGuid().ToString("N").Substring(0, 8))
$candidateRoot = [System.IO.Path]::GetFullPath((Join-Path $candidateBase $runId))
$candidatePrefix = $candidateBase.TrimEnd('\') + '\'
if (-not $candidateRoot.StartsWith(
  $candidatePrefix,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  Fail-Closed "the candidate root escaped its isolated base"
}
New-Item -ItemType Directory -Path $candidateRoot | Out-Null

$sourceManifest = @()
foreach ($relativePath in $RuntimeRelativeFiles) {
  $sourceManifest += Copy-VerifiedCandidateFile `
    -RepositoryRoot $repoRoot `
    -CandidateRoot $candidateRoot `
    -RelativePath $relativePath
}

$nextVersion = Get-InstalledPackageVersion $repoNodeModules "next"
$reactVersion = Get-InstalledPackageVersion $repoNodeModules "react"
$reactDomVersion = Get-InstalledPackageVersion $repoNodeModules "react-dom"
$joseVersion = Get-InstalledPackageVersion $repoNodeModules "jose"
$typescriptVersion = Get-InstalledPackageVersion $repoNodeModules "typescript"
$nodeTypesVersion = Get-InstalledPackageVersion $repoNodeModules "@types/node"
$reactTypesVersion = Get-InstalledPackageVersion $repoNodeModules "@types/react"
$reactDomTypesVersion = Get-InstalledPackageVersion $repoNodeModules "@types/react-dom"

$layoutSource = @'
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AIstory Linghao Passport v4 local candidate",
  description: "Default-off loopback-only integration candidate",
};

export default function CandidateLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
'@
$configSource = @'
/** @type {import("next").NextConfig} */
const config = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  reactStrictMode: true,
  typedRoutes: false,
};

export default config;
'@
$nextEnvSource = @'
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Generated only inside the isolated local candidate.
'@
$packageDocument = [ordered]@{
  name = "aistory-linghao-passport-v4-local-candidate"
  version = "0.0.0-local"
  private = $true
  dependencies = [ordered]@{
    jose = $joseVersion
    next = $nextVersion
    react = $reactVersion
    "react-dom" = $reactDomVersion
  }
  devDependencies = [ordered]@{
    "@types/node" = $nodeTypesVersion
    "@types/react" = $reactTypesVersion
    "@types/react-dom" = $reactDomTypesVersion
    typescript = $typescriptVersion
  }
}
$tsconfigDocument = [ordered]@{
  compilerOptions = [ordered]@{
    target = "ES2022"
    lib = @("ES2022", "DOM", "DOM.Iterable")
    module = "ESNext"
    moduleResolution = "Bundler"
    esModuleInterop = $true
    strict = $true
    skipLibCheck = $true
    forceConsistentCasingInFileNames = $true
    resolveJsonModule = $true
    isolatedModules = $true
    noUncheckedIndexedAccess = $true
    verbatimModuleSyntax = $false
    jsx = "react-jsx"
    noEmit = $true
    incremental = $true
    plugins = @([ordered]@{ name = "next" })
    paths = [ordered]@{ "@/*" = @("./*") }
  }
  include = @(
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts"
  )
  exclude = @("node_modules")
}
$instructionsSource = @"
AIstory Linghao Passport v4 isolated local candidate
Candidate: $candidateRoot
Entry: http://$ExpectedHost`:$ExpectedPort/auth/linghao-passport-v4
Start: & D:\AIstory\scripts\start-aistory-linghao-passport-v4-local.ps1
Stop: press Ctrl+C once in the foreground launcher terminal
The original D:\AIstory app tree and production configuration are not used.
"@
$harnessFiles = [ordered]@{
  "app\layout.tsx" = $layoutSource
  "next.config.mjs" = $configSource
  "next-env.d.ts" = $nextEnvSource
  "package.json" = ($packageDocument | ConvertTo-Json -Depth 8)
  "tsconfig.json" = ($tsconfigDocument | ConvertTo-Json -Depth 8)
  "RUN-INSTRUCTIONS.txt" = $instructionsSource
}
$harnessManifest = @()
foreach ($entry in $harnessFiles.GetEnumerator()) {
  $destinationPath = Join-Path $candidateRoot $entry.Key
  $destinationDirectory = Split-Path -Parent $destinationPath
  if ($destinationDirectory -and -not (Test-Path -LiteralPath $destinationDirectory)) {
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  }
  Write-Utf8NoBom -Path $destinationPath -Content ([string]$entry.Value)
  $harnessManifest += [ordered]@{
    path = $entry.Key.Replace('\', '/')
    sha256 = (
      Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
  }
}

$manifestPath = Join-Path $candidateRoot "candidate-manifest.json"
$manifestDocument = [ordered]@{
  schemaVersion = 1
  runId = $runId
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceRepository = [System.IO.Path]::GetFullPath($repoRoot)
  candidateRoot = $candidateRoot
  entry = "http://$ExpectedHost`:$ExpectedPort/auth/linghao-passport-v4"
  modeSelector = "$SelectorName=$SelectorValue"
  bundler = "webpack"
  sourceFiles = $sourceManifest
  harnessFiles = $harnessManifest
  installedRuntime = [ordered]@{
    node = (& $nodeCommand --version)
    next = $nextVersion
    react = $reactVersion
    reactDom = $reactDomVersion
    jose = $joseVersion
    typescript = $typescriptVersion
  }
}
Write-Utf8NoBom -Path $manifestPath -Content (
  $manifestDocument | ConvertTo-Json -Depth 10
)

$candidateNodeModules = Join-Path $candidateRoot "node_modules"
$runStatePath = Join-Path $candidateRoot "run-state.json"
$runState = $null
$previousSelector = $env:AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE
$previousSecretFile = $env:AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE
$previousTelemetryDisabled = $env:NEXT_TELEMETRY_DISABLED
$hadSelector = Test-Path Env:AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE
$hadSecretFile = Test-Path Env:AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE
$hadTelemetryDisabled = Test-Path Env:NEXT_TELEMETRY_DISABLED

try {
  # Enter the cleanup scope before creating the junction. A startup failure or
  # Ctrl+C at any later point must not leave a live link into repo node_modules.
  $junctionItem = New-Item -ItemType Junction `
    -Path $candidateNodeModules `
    -Target $repoNodeModules
  if (($junctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
    Fail-Closed "the candidate node_modules junction was not created"
  }
  $candidateNextEntry = Join-Path $candidateNodeModules "next\dist\bin\next"
  if (-not (Test-Path -LiteralPath $candidateNextEntry -PathType Leaf)) {
    Fail-Closed "the candidate Next entry point is unavailable"
  }

  $runState = [ordered]@{
    schemaVersion = 1
    runId = $runId
    candidateRoot = $candidateRoot
    entry = "http://$ExpectedHost`:$ExpectedPort/auth/linghao-passport-v4"
    launcherPid = $PID
    status = "starting"
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-Utf8NoBom -Path $runStatePath -Content (
    $runState | ConvertTo-Json -Depth 5
  )
  Write-Host "Linghao Passport v4 isolated candidate: $candidateRoot"
  Write-Host "Local entry: http://$ExpectedHost`:$ExpectedPort/auth/linghao-passport-v4"
  Write-Host "Stop: press Ctrl+C once in this foreground terminal."

  $env:AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE = $SelectorValue
  $env:AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE = $SecretFilePath
  $env:NEXT_TELEMETRY_DISABLED = "1"
  $runState.status = "running"
  Write-Utf8NoBom -Path $runStatePath -Content ($runState | ConvertTo-Json -Depth 5)
  Push-Location -LiteralPath $candidateRoot
  try {
    # Next 16 documents [directory] as the project root. This exact fresh
    # candidate contains no recursive app/app tree and writes its own .next.
    & $nodeCommand $candidateNextEntry dev $candidateRoot --webpack `
      --hostname $ExpectedHost --port $ExpectedPort
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    $runState.status = "stopped"
    $runState.stoppedAt = (Get-Date).ToUniversalTime().ToString("o")
    $runState.exitCode = $exitCode
    Write-Utf8NoBom -Path $runStatePath -Content ($runState | ConvertTo-Json -Depth 5)
    if ($exitCode -notin @(0, 130, -1073741510)) {
      throw "AIstory dev server exited with code $exitCode"
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  try {
    if ($null -ne $runState -and $runState.status -in @("starting", "running")) {
      $runState.status = "stopped"
      $runState.stoppedAt = (Get-Date).ToUniversalTime().ToString("o")
      $runState.stopReason = "foreground launcher ended"
      try {
        Write-Utf8NoBom -Path $runStatePath -Content (
          $runState | ConvertTo-Json -Depth 5
        )
      }
      catch {
        Write-Warning "could not finalize the isolated candidate run state"
      }
    }

    if (Test-Path -LiteralPath $candidateNodeModules) {
      $candidateNodeModulesItem = Get-Item -LiteralPath $candidateNodeModules -Force
      if (($candidateNodeModulesItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -and
          [string]::Equals(
            [System.IO.Path]::GetFullPath($candidateNodeModulesItem.FullName),
            [System.IO.Path]::GetFullPath($candidateNodeModules),
            [System.StringComparison]::OrdinalIgnoreCase
          ) -and
          [string]::Equals(
            [string]$candidateNodeModulesItem.Target,
            [System.IO.Path]::GetFullPath($repoNodeModules),
            [System.StringComparison]::OrdinalIgnoreCase
          )) {
        Remove-Item -LiteralPath $candidateNodeModules -Force
      } else {
        Write-Warning "candidate node_modules was not the expected junction; it was left untouched"
      }
    }
  }
  finally {
    # Environment restoration must run even if junction inspection/removal
    # fails. Never leave the default-off selector or secret-file reference set.
    if ($hadSelector) {
      $env:AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE = $previousSelector
    } else {
      Remove-Item Env:AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE -ErrorAction SilentlyContinue
    }
    if ($hadSecretFile) {
      $env:AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE = $previousSecretFile
    } else {
      Remove-Item Env:AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE -ErrorAction SilentlyContinue
    }
    if ($hadTelemetryDisabled) {
      $env:NEXT_TELEMETRY_DISABLED = $previousTelemetryDisabled
    } else {
      Remove-Item Env:NEXT_TELEMETRY_DISABLED -ErrorAction SilentlyContinue
    }
  }
}

