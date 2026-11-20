# Linghao Passport v4 isolated local E2E

This runbook starts only the default-off, loopback-only Passport v4 surface.
It does not move or rename `D:\AIstory\app\app`, load the product Next config,
or use the product route tree. The launcher stages an exact 16-file source
allowlist plus a six-file harness under a fresh sibling directory on `D:`.

## Preconditions

- Run on Windows from the existing `D:\AIstory` checkout.
- The local Passport issuer is already available at `http://127.0.0.1:8000`.
- Repository dependencies already exist at `D:\AIstory\node_modules`.
- Port 4200 is free.
- The protected client-secret file and its owner-only DACL already satisfy the
  launcher checks. Do not open, copy, print, hash, or move its value.

## Start

Open PowerShell and run exactly:

```powershell
Set-Location -LiteralPath D:\AIstory
& D:\AIstory\scripts\start-aistory-linghao-passport-v4-local.ps1
```

The foreground launcher prints a fresh candidate path like:

```text
D:\AIstory-e2e-runs\linghao-passport-v4\run-<UTC>-<id>
```

It then serves only:

```text
http://127.0.0.1:4200/auth/linghao-passport-v4
```

Optional readiness probe from a second PowerShell window:

```powershell
(Invoke-WebRequest -UseBasicParsing `
  -Uri 'http://127.0.0.1:4200/api/auth/linghao-passport-v4/capabilities').Content
```

The enabled local candidate must return exactly `{"enabled":true}`. The
capability response must not set a cookie.

## Narrow browser logout regression check

Use only the retained task-owned synthetic Account A. Do not create another
account or change its password, MFA, membership, or product state.

1. Open the local entry and choose `开始本地登录`.
2. Authenticate through the local issuer using the separately authorized local
   fixture credential.
3. Stop if the projected profile ID is not exactly
   `2a17f273-5c69-52b8-8505-d27541e29c54`.
4. Click `本地登出` exactly once.
5. Require the clean URL `/auth/linghao-passport-v4`, no authenticated panel,
   and this exact notice:

   ```text
   本地登出与令牌撤销已确认，且已从上游 end-session 返回；不额外声明全局上游登出。
   ```

6. The server log must contain exactly one `POST .../logged-out?... 200` and no
   replay `400` for that state.
7. Click `载入会话` once and require `没有可用的本地测试会话。`.

This check does not expose or replay the exact revoked provider refresh token.

## Stop

In the same foreground launcher terminal, press `Ctrl+C` once. Do not use a
second kill command. The launcher finalizer records `status: stopped`, restores
its three inherited environment values, and removes only the candidate's exact
`node_modules` junction.

Post-stop verification, using the candidate path printed at startup:

```powershell
$candidate = 'D:\AIstory-e2e-runs\linghao-passport-v4\run-<UTC>-<id>'
@(Get-NetTCPConnection -LocalPort 4200 -State Listen `
  -ErrorAction SilentlyContinue).Count
Get-Content -LiteralPath (Join-Path $candidate 'run-state.json') -Raw
Test-Path -LiteralPath (Join-Path $candidate 'node_modules')
Test-Path -LiteralPath 'D:\AIstory\app\app'
```

Expected results are listener count `0`, run state `stopped`, candidate
`node_modules` `False`, and the original `app\app` tree `True`.

## Mechanical checks

Run these commands from `D:\AIstory`. They use the existing executables and do
not ask pnpm to rebuild the shared dependency tree.

```powershell
& .\node_modules\.bin\tsx.CMD scripts\test-linghao-passport-v4.ts
& .\node_modules\.bin\tsc.CMD -p .tmp\passport-v4-tsconfig.json --noEmit
& .\node_modules\.bin\eslint.CMD middleware.ts `
  components\LinghaoPassportV4LocalPanel.tsx `
  'lib/auth/linghaoPassportV4*.ts' `
  'app/api/auth/linghao-passport-v4/**/*.ts' `
  app\auth\linghao-passport-v4\page.tsx `
  scripts\test-linghao-passport-v4.ts

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath `
    'scripts/start-aistory-linghao-passport-v4-local.ps1'),
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) { throw ($errors | Out-String) }

git diff --check
```

The contract suite must report `All 19 tests passed.`
