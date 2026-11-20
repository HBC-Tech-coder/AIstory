# LocalMiniDrama 1.2.9 core upgrade

Upstream: https://github.com/xuanyustudio/LocalMiniDrama/tree/v1.2.9
Pinned commit: `abcec932e2395bad2fdb298dac95d59c7c6a83a3`.

Local source: `D:/AI-story/repos/localminidrama-1.2.9`.
Previous 1.2.7 checkout remains at `D:/AI-story/repos/localminidrama`.
Use a new database; no previous provider keys or user data are copied.

## Integration

- Retain AIstory's drama thumbnail create/update/outline patch and the Bailian
  dedicated gateway compatibility patch in `imageClient.js`.
- `scripts/localminidrama-safe-launch.cjs` initializes the upstream Mastra
  runtime before listening and checks readiness. This initialization normally
  lives in upstream `server.js`, which our launcher deliberately does not use.
- Report the package version through `/health`; upstream YAML says 1.0.0.
- Bind 5679 and frontend 4107 to loopback. Preserve TLS verification and the
  existing startup provider-poll guard.
- `scripts/start-aistory-local-stack.ps1` now selects the versioned directory.
- Node 24.13.0 was tested; backend dependencies include Mastra and LibSQL.

## Acceptance (2026-11-20)

Backend tests 131/131; frontend tests 20/20; Vite production build passed.
AIstory local-stack security tests passed. Actual service health reports 1.2.9.
Project create/read/delete and thumbnail preservation passed with synthetic
data. Assistant history returned 200 through both backend and frontend proxy.
No provider generation, external AI request or paid model call was made.

The upstream assistant is a local single-user authoring capability. Its routes
and tool result fields are not a public multi-user authorization layer. AIstory
public Studio integration remains a separate proxy/authorization task.
Paid generation and real model chat require fresh provider configuration and
are not claimed accepted by these offline tests.

This is the tagged release, not later main-branch fixes (including approval
episode-context restoration and bounded assistant polling).
