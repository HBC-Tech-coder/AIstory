# Park integration candidate — offline runbook

Status: **offline candidate only. Not a live integration, not deployed.**
There is no HTTP route, UI, scheduler hook, generation/retry/adopt path, or
real network/provider/GPU call in this module. The default transport is
**absent**, which disables outbound publication and guarantees zero sends.
Authenticated, mapped inbound `job.status` reads remain available.

## What this actually does

- Inbound `job.status@1`: reads mapped, existing generation jobs only, through
  the two read-only store readers (`listStoredGenerationJobs`,
  `listProjectAssets`). Returns a redacted DTO (`jobRef`, `status`, and an
  eligible mapped `assetRef`/`contentHash` only).
- Outbound `group.publishResult@1`: validates an explicitly mapped, ready asset
  and succeeded, publishable job, persists the request intent before any
  effect, then hands a redacted command to an injected transport.
- `request.status`: reads only the caller's own persisted request, and for
  `unknown`/`accepted` asks the injected transport by the original `requestId`.
  It never resends.
- Events: authenticated ingestion with full validated-content dedupe and
  monotonic terminal states.
- Durable state: one JSON file written temp+fsync+atomic rename, guarded by a
  cross-process exclusive lock file. Process-restart behavior is preserved;
  there is no forced power-loss guarantee. No stale-backup fallback.

Identity always comes from the injected transport verifier. Request bodies can
never claim a principal, instance, project, group or capability.

## Exact offline commands (Windows PowerShell)

Run from the isolated candidate root `D:\aistory-park-20261113`, or from
`D:\AIstory` after the exact module, tests and fixture have been integrated.

```powershell
# Tests
$env:NODE_OPTIONS = "--conditions=react-server"
node node_modules/tsx/dist/cli.mjs tests/park-integration.test.ts
$env:NODE_OPTIONS = $null

# Synthetic CLI fixture (temporary directories only)
$env:NODE_OPTIONS = "--conditions=react-server"
node node_modules/tsx/dist/cli.mjs scripts/park-fixture.ts
$env:NODE_OPTIONS = $null
```

## Exact offline commands (POSIX shell)

```sh
NODE_OPTIONS=--conditions=react-server node node_modules/tsx/dist/cli.mjs tests/park-integration.test.ts
NODE_OPTIONS=--conditions=react-server node node_modules/tsx/dist/cli.mjs scripts/park-fixture.ts
```

No `cross-env`, shell wrapper, network access or extra environment variables are
assumed. The `react-server` condition is required because the adapter modules
import `server-only`.

Typecheck (optional, stricter than the runtime path):

```sh
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

## The proposed-but-not-deployed transport

`ParkOutboundTransport.query` is a **proposed candidate contract**. It is not
deployed and does not exist on any real park side. The fixture uses an injected
fake; every group message reference (`groupMessageRef`, e.g. `fixture-msg-*`)
is **synthetic**. A `succeeded` result requires a validated successful receipt
with a `groupMessageRef`. In this fixture that receipt proves local handling
and persistence only, not actual remote delivery.

Likewise, the fake verifier and fake authorizer in tests/fixture are test
doubles. Nothing here proves a live connection, credentials, deployment,
network reachability, real park compatibility, or production readiness.

## Crash / lock failure behavior

The lock file (`park-integration.lock` next to the state file) is never
inspected, aged out, or stolen. If a process crashes while holding it, the
adapter stays **fail-closed** (`lock_busy`, zero sends). There is **no
automatic crash recovery**.

An operator may recover only after all of the following:

1. Independently verify that the process that created the lock is no longer
   running (do not rely on PID reuse or lock age).
2. Reconcile every persisted `sending` request with the park side using the
   original `requestId`; a `sending` record observed after restart is treated
   as `unknown` and is never resent automatically.
3. Manually remove that exact lock file only after the checks above.

Removing a lock while the original process may still run risks concurrent
writers and must not be automated.

## Durability caveat

Writes use temp file + file `fsync` + atomic rename. Directory `fsync` is not
available on Windows, so atomic rename must **not** be treated as proof of
power-loss durability. What is covered is the runtime/process-restart path for
state already persisted: a `sending` record is recovered as `unknown` and is
never resent automatically. There is **no forced power-loss guarantee**. The
store never falls back to backups, so a stale state file cannot resurrect an
already-completed send.

## Not claimed

- No live park connection or deployment.
- No real outbound transport, provider, GPU, or production call.
- No HTTP route, UI, scheduler import, generation, retry, adopt or asset write.
- No identity inferred from the request body.
- No automatic crash recovery or lock stealing.
- No forced power-loss durability guarantee.
