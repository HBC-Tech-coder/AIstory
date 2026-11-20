# LocalMiniDrama source snapshot for AIstory

Upstream: https://github.com/xuanyustudio/LocalMiniDrama
Tag: v1.2.9
Commit: abcec932e2395bad2fdb298dac95d59c7c6a83a3
License: MIT; original copyright and license retained in LICENSE.

This directory contains the backend and web frontend source, lockfiles, tests,
SQL migrations and built-in assistant skill. It is a versioned copy of the core
used by AIstory, not another independently developed product. Upstream desktop
packaging, screenshots, sample ZIPs, ffmpeg binaries, build output, databases,
dependencies and provider keys are excluded. Install ffmpeg separately for video
merge and tail-frame extraction. The upstream README covers the broader product.

Two existing AIstory compatibility patches are included:
- backend-node/src/services/dramaService.js: thumbnail create/update/outline.
- backend-node/src/services/imageClient.js: Bailian dedicated maas gateway.

From each of backend-node and frontweb, run `npm ci`. Node 24.13.0 was verified.
Build the frontend with `npm run build` in frontweb.

Launch the backend using AIstory's peripheral adapter, from the AIstory root:

```powershell
node scripts/localminidrama-safe-launch.cjs --backend-root vendor/localminidrama/backend-node --port 5679
```

The backend serves the built web UI at http://127.0.0.1:5679/.
For the separate development UI, from frontweb:

```powershell
npm run dev -- --host 127.0.0.1 --port 4107 --strictPort
```

The AIstory local stack script accepts `-LocalMiniDramaRoot` for an explicit
core location. Without it, installed vendored dependencies select this copy;
otherwise the existing workstation's versioned 1.2.9 checkout is used.
Stop existing listeners before switching copies to avoid two database writers.

The safe adapter enforces loopback/TLS, blocks automatic provider task resume,
initializes the new assistant and reports the package version. The upstream
config.yaml is an unchanged key-free template, not production configuration.
Configure your own providers after startup; never commit the resulting data.

Source qualification: backend 131/131, frontend 20/20, Vite build, local-stack
safety and actual project CRUD/thumbnail/assistant-history checks passed.
Real paid generation and public multi-user access are separate acceptance.
