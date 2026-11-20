<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Repository Guidelines

This is the primary working guide for AI coding agents and contributors. It summarizes the repo-specific rules and adds contributor workflow guidance. Prefer it over generic Next.js assumptions.

## Project Structure & First Reads

InfiPlot is a Next.js 16 / React 19 / TypeScript app for AI-driven interactive visual novels (galgame). The server is intentionally stateless: the client carries the full `Session` and sends it to API routes whenever new generation is needed.

- `app/`: App Router pages and API routes. Start here for request/response behavior.
- `app/page.tsx`: Home/custom-start flow, preset cards, style-image upload/parsing, and analytics.
- `app/play/page.tsx`: Client session runtime, speculative scene prefetch, voice retention/stripping, image preload/proxying, orientation locking, and API callers.
- `components/`: Client UI, especially `PlayCanvas.tsx`, `CustomForm.tsx`, `PresetCard.tsx`, `TtsKeyModal.tsx`, and `Analytics.tsx`.
- `lib/types/index.ts`: Shared domain contracts. Read this before changing payload shapes.
- `lib/engine/`: Core story engine. `director.ts` orchestrates scene generation.
- `lib/engine/agents/`: Architect, Writer, CharacterDesigner, Cinematographer, Painter.
- `lib/engine/prompts.ts`: Agent prompts and prompt-cache-sensitive message builders.
- `lib/ai-client/`: Text, image, vision, and retry wrappers.
- `lib/tts-client/`: TTS integration. `stepfun-voices.json` is the single source of truth for the 32 StepFun preset voices (shared by the scorer, CharacterDesigner prompt, `/api/tts-provider`, and the enrich script).
- `lib/config.ts`: Server-side provider/environment loading.
- `lib/presets.ts`, `lib/ttsPresets.ts`, `lib/options.ts`: Home-page presets and selectable options.
- `scripts/`: Asset and preset generation helpers.
- `public/`, `docs/`: Static assets and documentation imagery.
- `lib/admin/`, `app/admin/`, `app/api/admin/`: Super-admin domain
  repositories, strict server-side authorization, local control-plane storage,
  and the administrator workbench. `AUTH_ENABLED=false` never grants admin
  access. The local adapter is opt-in, localhost-only, and writes to the
  gitignored `.aistory-admin/` directory. Ordinary phone sessions never become
  administrator principals. Independent administrator principal v1 keeps the
  P0.4 `local_fake_only` contract as non-deployable evidence and adds a separate,
  default-off `production_v1` feature gate. Production requires a root/owner-only
  credential reference, exact HTTPS origin, Gate14 plus the independent DB gate,
  durable atomic rate/session-family/rotation/revocation state and append-only
  auth audit. Its browser session is opaque, and its public actor projection
  contains no principal/database identifier. It never maps to phone identity or
  legacy Supabase administrator identity. The P0.5 production principal may read
  the existing console projection only; all legacy admin/business mutations stay
  fail-closed until a separately reviewed independent authorization wrapper exists.
  Pending activation v2 is a separate default-off admission policy over the
  unchanged first-password-change adjunct to terminal Gate16. Its public defaults
  authenticate through normal administrator login only to a password-change-only
  state with no administrator actor. There is no manual claim window, installation
  activation token or pending-account deadline; an expired restricted session may
  log in again. DB-derived verifier revision and stage are authoritative, not
  browser state or the seed verifier. Current-password verification, verifier
  revision, all old-family revocation and audit commit atomically; success forces
  logout, never creates an admin session. A fresh new-password login is required.
  Public default credentials are explicitly first-claim-wins: any first visitor
  can take the pending account; restricted state and rate limits do not prove
  deployment ownership. Founder accepts this risk, not a claim of anti-takeover.
  Existing pending/active principals and seeds must never be reinitialized on
  install, upgrade or restart. The old owner-window listener is retired. The
  protected first-install bootstrap, exact v2 selector and release boundaries
  remain in `runbooks/independent-admin-first-password-change-v1.md`; local v2
  tests do not authorize hot-enabling the current production default account.
- `components/CreatorStudioShell.tsx`, `lib/creator-studio/`,
  `lib/localminidrama/`: AIstory-owned creator shell and loopback-only
  LocalMiniDrama capability adapter. The donor repository is reference-only;
  production features remain embedded behind the AIstory shell instead of
  being copied into a second codebase. The protocol-v1 iframe bridge accepts
  only exact-origin/source project selection and allowlisted task/media/local
  navigation intents for known projects. Until the donor implements its
  sender, Studio reports `awaiting_donor_sender` and keeps the AIstory project
  dropdown as the working fallback.
- `lib/providers/comfyui/`: fail-closed local image/video provider contract,
  dynamic workflow validation, capability discovery, and foreground queue
  adapter. Workflow node ids, checkpoints, LoRAs, ControlNets, references,
  face continuity and video nodes are configuration, never code constants.
  Studio's AIstory-owned registry manager accepts only a strict 2 MB package-v1
  JSON body through the loopback local-admin control plane, returns redacted
  current/history summaries, and manages dry validation, version import,
  enable/disable and active-version rollback without probing or running ComfyUI.
  Registry writes are serialized only within the current AIstory process; do
  not run multiple local registry writers. Registry and local-admin audit are
  separate stores rather than one transaction, so an uncertain mutation must
  be re-read and reconciled before another change. New ComfyUI generation jobs
  pin the exact workflow id, version and fingerprint before enqueue; execution
  and output allowlists read that immutable historical version. Active-version
  switches and disabling are rejected while the same workflow has a queued,
  running or provider-pending job. Dry validation, version import, terminal
  jobs and enable-only changes remain available. Legacy queued jobs without an
  exact pin fail closed before any provider request.
- `content/case-studies/`, `lib/case-studies/`, `public/case-studies/`: authored
  local showcase sources, strict delivery validation, deterministic graph
  compilation, and public derived assets. Source documents and face references
  remain under `content`; only manifest-confirmed generated assets may be copied
  into `public`.
- `lib/generation-jobs/`, `app/api/generation-jobs/`: server-only durable local
  foreground job store and the single-concurrency AIstory GPU scheduler. It
  currently executes registered ComfyUI workflows and the safe LocalMiniDrama
  image adapter; legacy iframe submissions remain an explicit queue bypass.
- `lib/project-assets/`, `app/api/project-assets/`: AIstory-owned durable
  project asset registry. Adopted artifacts stay project-scoped and reference
  only content-addressed `.aistory-cache/media` files. Ordinary users never
  receive provider task ids, prompts, workflow JSON, or local filesystem paths.
- `lib/providers/volcengine-agent-plan/`: production-network-disabled P1
  capability and async-video contract for the product-level Agent Plan
  provider. It is parallel to Bailian; text/image/TTS are selection-only until
  concrete adapters are implemented.
- `lib/sceneMedia.ts`, `components/SceneMediaCanvas.tsx`,
  `components/VideoStoryPlayer.tsx`: backwards-compatible scene media
  coercion and the interactive video runtime. Missing `Scene.media` remains a
  legacy image. Reviewed videos use controlled AIstory URLs, in-frame
  subtitles, browser-only playback preferences, and one idempotent completion
  path for ended/seek-to-end/skip.
- `lib/video-assets/`, `app/api/admin/video-assets/`,
  `app/api/video-assets/`: strong-admin video upload, content validation,
  review/publish/offline state, content-addressed local-development storage,
  and Range delivery. The local adapter is loopback-only and gitignored.
  Production composes a server-only Supabase metadata repository, private
  Aliyun OSS transport, IMDSv2-only ECS RAM Role credentials and a bounded
  ffprobe byte probe only when every Gate14/configuration prerequisite is
  present; otherwise every production path remains a safe 503.
- `lib/world-model-demos/`, `components/WorldModelDemoShowcase.tsx`,
  `app/api/video-assets/world-model-demos/`: the five published world-model
  demos use an exact public release manifest and a controlled MP4 stream with
  200/206/416 and HEAD semantics. Their legacy `public/case-studies/.../demo.mp4`
  paths are exact `beforeFiles` rewrites to the same route so cached sessions
  cannot fall back to Next.js static-file Range error handling.
- `lib/video-stories/`, `app/api/admin/video-stories/`,
  `app/api/video-stories/`: local-development interactive video story drafts,
  graph validation, deterministic author-locked compilation, content-addressed
  release artifacts, and public read projection. Production never falls back
  to this gitignored filesystem store.
- `lib/video-workflow-ab/`, `app/api/admin/video-workflow-ab/`,
  `components/AdminVideoWorkflowABPanel.tsx`: server-owned Wan workflow A/B
  experiment manifests, strict fair-pair/package validation, blind review and
  approval/adoption gates. Imported workflows and outputs remain server-only
  under the gitignored local-development store until an approved run is
  separately adopted and then passes the existing VideoAsset publish gate.
- `lib/gpu-coordinator/`, `app/api/gpu-coordinator/`,
  `components/AdminGpuCoordinatorPanel.tsx`: default-off GPU Connector LAN LAB
  coordinator v1. It accepts one allowlisted outbound-polling Connector, one
  32+ byte HMAC secret, exact mechanically verified workflow id/SHA pairs and
  one global GPU lease. ComfyUI remains private and the existing loopback
  execution path remains the default. LAN artifacts are validated MP4/WebM
  bytes in a gitignored durable store before mirroring to the normal
  content-addressed cache and explicit ProjectAsset adoption. Original video
  generation and video upscaling are separate GenerationJobs: upscaling reads
  a succeeded source through a one-time `sourceVideo` ticket and never mutates
  the original workflow or artifact. Connector registration also pins the
  exact build, release, capability and externally hashed Central contract plus
  an exact signed network-posture declaration. Registration rotates the
  session, whose first wire heartbeat must be `idle`; every later request
  rechecks the stored attestation. The initial `no_work_only` runner returns
  before lease expiry scans, GPU acquisition or queued-job claims. Connector
  network posture is a declaration, not proof of the remote machine, and a
  foreground runner requires a fresh registration/session and separate gate.
  Offline Connector package qualification accepts only four explicit files:
  the ZIP, its external sidecar manifest, the Central golden JSON, and that
  golden's checksum sidecar. It never searches a default directory, reads
  runtime environment values, or executes archive content. Static
  qualification proves byte-level compatibility only; it never proves a
  runtime binding, `no_work`, GPU execution, deployment, provenance, or
  publishability.
- `desktop/`, `lib/steam/`, `app/[locale]/steam/`,
  `components/SteamLaunchExperience.tsx`: Windows x64 Steam P1 desktop shell,
  plus an offline-only Linux x64 directory-package candidate. Both use the
  loopback-only bundled Next standalone runtime, controller/soft-keyboard
  bridge contract, XDG/Electron application storage roots, brand/about
  surfaces and chapter-completion CTA. The Electron renderer is sandboxed with
  no Node integration and no arbitrary navigation. Steamworks/AppID/Cloud/
  Input/Overlay/Wallet remain fail-closed until their own production
  integration and mechanical acceptance. The Windows directory candidate uses
  a verified local Electron ZIP, a per-profile stable random loopback port and
  a per-launch child-owned proof endpoint. Its Steam-only Next build serves
  reviewed images without the runtime optimizer so the installation tree stays
  byte-for-byte immutable across launches.
  The Steam launch video production plan is a read-only deterministic
  projection of the designated public author-locked case graph plus existing
  workflow/job/video-asset state. It never submits GPU work. Original video
  and optional upscale remain separate immutable tasks and output references;
  missing capability or ambiguous linkage fails closed.
  The launch-three-shot preflight is derived from that plan plus the
  authoritative v1.1 shot and public asset manifests. Public projections
  expose only safe ids, hashes, versioned policy and fixed blocker codes.
  Source prose and prompts remain server-only. `STEAM_RELEASE_TARGET` is fixed
  to landscape 16:9, 1280x720, 24 fps, 30 seconds, attach audio and runtime
  WebVTT; `LAB_NON_PUBLISHABLE` keeps its separate 768x480 original and
  1280x800 upscale specs. Release and LAB workflow candidates resolve in
  separate pools, and LAB compatibility can never grant release compatibility
  or execution permission. Unprepared reference tokens and the absence of an
  enabled, exact publishable registry pin remain honest blockers. The pure
  future-job mapper accepts only the release discriminator and does not write a
  GenerationJob or contact a provider.
  The Steam settings surface can generate a schema-v1 redacted Demo test
  report only after an explicit user action. The renderer builds a fixed
  allowlist JSON of public release/runtime/capability/context fields plus a
  bounded plain-text issue description; it never reads storage, logs, secrets
  or private story text, adds no telemetry/API/IPC, and never uploads a report.

- `lib/credentials/`: browser-safe credential-mode contracts plus server-only authorization policy. Public testing defaults to `user_byok`; `platform_managed` requires a server kill switch and authenticated allowlist.
- `lib/credentials/hosted/`, `app/api/credentials/hosted/`: default-off,
  server-only hosted BYOK vault. Per-record AES-256-GCM DEKs are wrapped by a
  versioned root-only KEK ring. Browser DTOs expose status/capability metadata
  only; no route returns plaintext, ciphertext or wrapped keys. Production
  requires a stable phone UUID, recent OTP step-up, the exact database gate,
  service-role RPCs and provider/origin/model allowlists. Existing browser
  BYOK never migrates automatically.
- `lib/auth/`, `lib/billing/`, `app/api/auth/phone/`, `app/api/account/`:
  fail-closed phone-verification/session contracts and the formal server credit
  gate. Anonymous users may read published/cached content, but a platform-paid
  cache miss must quote, authenticate, reserve immutable credits, then settle
  or refund. Local SMS is a loopback-only mock and never sends a real message.
  AIUser OIDC readiness v1 is a separate default-off, server-only offline
  contract validator. It creates no route, callback, token exchange, session or
  account link, and login can never mutate membership, entitlement or credits.
  The separate AIUser callback v1 adds exact production-beta-v2 start/callback
  routes but remains disabled without protected host-registry/handoff acceptance,
  actual recipient UID/ACL and shared durable replay storage. It verifies ES256
  ID/resource tokens. With the separate exact
  `AISTORY_AIUSER_USER_INTEGRATION_MODE=aistory-aiuser-user-integration-v1:enabled`
  selector it issues an independent encrypted ordinary product session, never a
  phone UUID or administrator. Account/me exposes no subject, token or internal
  identifier; no membership or credit grant is inferred. Access-token typ must
  be `at+jwt`; ID-token typ is absent or `JWT`. Session lifetime is bounded by
  both verified tokens and at most900 seconds; reads never extend it. Product
  logout durably tombstones the session/transaction/browser lineage in the
  existing protected shared replay store, including late callbacks, but is not
  a global IdP logout or immediate upstream membership revocation. Invalid AIUser
  cookies cannot fall through to a different phone/legacy identity. Phone-only
  billing, Hosted BYOK, cloud-progress and administrator gates remain unchanged.
  Explicit AIUser-to-existing-phone association remains a separate, default-off
  local slice. Its capability is true only for the exact selector, current AIUser
  and phone proofs, signed recent ID-token `auth_time`, and uncached exact DB
  posture. Product-session `iat` is never a recent-auth substitute. Prepare first
  registers an append-only durable intent; confirm locks and consumes it through
  the unique audit row in the same transaction as the one-to-one mapping. Exact
  response-loss replay returns the stored outcome without a second mutation.
  Logout durably tombstones both link-session bindings before acknowledgement so
  prepare/confirm share the DB serialization authority. A separate exact sticky
  revocation selector must be enabled after the link DB gate and before admission,
  and must remain enabled while admission is disabled and older workers drain;
  admission requires both selectors. The five link tables are
  FORCE-RLS/no-policy/owner-only and an immutable catalog manifest binds their
  PG16 constraints, defaults and function bodies. This remains non-deployable
  until the isolated PG16.15 runner passes; local policy/service tests never
  substitute for that result. Existing phone accounts/assets/credits are not merged.
  Configuration is documented in `runbooks/aiuser-oidc-callback-v1.md` with current
  recipient and ordinary-session rules in `runbooks/aiuser-user-integration-v1.md`.
  AIstory's production-beta registration is selected in
  `lib/auth/aiUserOidcProductionBeta.ts`: a dedicated HTTPS callback on the
  authoritative AIstory origin, an exact product client/resource and a protected
  credential reference. It reuses the readiness validator and requires a separate
  registry authority pin, but still implements no login/callback/runtime. Its
  selection fingerprint is not an IdP acceptance or deployment receipt.
  Registration revision `production-beta-v2` explicitly requests only `openid`
  and `product.access`, not `offline_access`; resource claims require independently
  pre-existing active membership at AIUser, never creation during login. Its issuer
  is exactly `https://id.hibcglobal.com` without a trailing slash. Issuer validation
  preserves that spelling and fingerprint rather than normalizing the identity.
  Supabase callback, phone sessions and HarnessDesk company-account identities
  are not fallback values for its issuer, client, redirect URI or audience.
- `lib/company-account/v1/`, `app/api/company-account/v1/capabilities/`:
  default-off E2 contract for `HarnessDesk`. Its immutable
  product/client/audience are `harnessdesk-desktop`,
  `harnessdesk-windows` and
  `urn:hbc:company-account:harnessdesk-desktop`. Authorization codes use
  PKCE S256 and an independent opaque token family in an in-memory fake only;
  the product-grant contract records no balance, and the provider proxy runs
  only through injected fakes after every posture gate passes. DeepSeek is an
  adapter, never the session audience or ledger product. The sole route is a
  loopback read-only capability DTO that truthfully reports login, grants,
  proxy, Hosted BYOK and payments unavailable. It does not reuse the AIstory
  Cookie, global 1000-credit grant, billing RPCs, hosted vault, or user proxy.
- `lib/production/databaseGate.ts`,
  `supabase/migrations/20260729093000_production_identity_billing_gate.sql`,
  `supabase/migrations/20260729183000_anonymous_phone_claim_gate.sql`,
  `supabase/migrations/20260731120000_sensitive_identity_billing_privilege_hardening.sql`,
  `supabase/migrations/20260731183000_admin_identity_rpc_read_gate.sql`,
  `supabase/migrations/20260801193000_hosted_byok_vault_gate.sql`,
  `supabase/migrations/20260801213000_hosted_byok_rpc_ambiguity_hardening.sql`,
  `supabase/migrations/20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql`,
  `supabase/migrations/20260809113000_phone_admin_identity_gate.sql`,
  `supabase/migrations/20260811193000_production_video_asset_metadata_gate.sql`,
  `supabase/migrations/20260828233000_independent_admin_principal_pg16_gate.sql`,
  `supabase/migrations/20260829063000_independent_admin_qualification_residue_retirement_gate.sql`:
  production phone identities use stable application UUIDs mapped from a
  phone HMAC. Real SMS and formal credits require the explicit Supabase
  repository configuration plus the exact database-owned gate version.
  Registration, initial grant, administrator credit adjustments, billing
  terminals, and production administrator mutations use allowlisted
  security-definer RPCs so business state and audit commit together.
  The second gate adds a signed high-entropy anonymous browser subject and an
  atomic same-browser claim into the stable phone UUID. Claim manifests contain
  only validated public progress summaries, content hashes and experiment
  assignments; BYOK credentials, demo credits and private content are outside
  the migration read set.
  The hosted-vault gate adds encrypted credential records, append-only
  idempotent user audit, forced RLS and service-role-only RPCs. Applying it
  does not enable the feature or inject a KEK. The following forward-only
  hardening gate removes PL/pgSQL variable/column ambiguity from every hosted
  RPC. The runtime-qualification forward gate replaces block-label expression
  qualifiers with argument locals and explicit table aliases; gate10 and
  gate11 remain immutable. Gate12 must be present before hosted credentials
  can pass the production database gate. Gate13's historical stable-phone
  administrator schema remains immutable, but the application no longer maps
  ordinary phone sessions into administrator principals or uses that path for
  a first administrator. Legacy Supabase administrators and the independent
  administrator-principal candidate remain isolated; neither is automatically
  migrated or merged.
  Gate14 adds tenant-scoped production video metadata and idempotency tables,
  forced RLS, service-role-only atomic create/mutate RPCs and a database-owned
  video security posture. It does not configure a bucket, grant an ECS role,
  fetch credentials or enable video upload by itself.
  The independent-administrator feature gate is a separate schema-gate row and
  does not advance or weaken Gate14. Its principal, rate buckets, session
  families, sessions and auth audit have forced RLS, no browser/direct service
  table grants and service-role-only security-definer RPCs. Applying the
  migration alone neither initializes a principal nor enables login.
  Gate16 is the forward-only response to the P0.5 qualification singleton
  incident. On a non-empty Gate15 baseline it captures a database-owner-only,
  exact pre-state commitment and remains `awaiting_attestation` on Gate15; it
  cannot retire anything during migration apply. Retirement requires a second,
  owner-only one-time commitment bound to the controlled incident receipt and
  the same recomputed pre-state. Success appends one audit event, converts only
  the proven qualification principal to immutable slot-0 revoked history, and
  advances the independent gate to Gate16 without deleting principal, rate,
  session-family, session or audit records. Empty Gate15 data becomes
  `not_required`. Active sessions, any state not independently attested as the
  known qualification residue, proof drift or ambiguity fail closed. The
  application accepts only terminal Gate16; pending
  Gate15 must never be paired with an enabled P0.5 release or a protected-TTY
  initializer. Gate16 domain SQL does not own the Supabase migration ledger.
  Its immutable package must apply the unchanged Gate16 migration and append
  the exact `version/name/sha256/applied_at` ledger row through
  `scripts/apply-independent-admin-gate16-ledger.psql` in one database-owner
  transaction. It row-locks and pins the exact Gate15 predecessor
  `version/name/sha256/applied_at` identity before DDL. The envelope rejects any
  owner, relation, column, primary-key, trigger/rule or predecessor drift,
  never repairs the ledger, and
  rolls both domain objects and bookkeeping back on append or postflight
  failure. The superseded `version/statements/name` runner must not be reused.

For engine work, read `lib/types/index.ts`, the target agent/orchestrator file, and the API route exposing the behavior. For UI work, inspect the component and the owning page.

## Core Architecture

The engine behaves like `Session + EngineConfig -> SceneResult`. The client appends returned scenes to `session.history`, replaces `session.characters` and `session.storyState`, and sends the updated `Session` back later. Do not introduce server-side session storage, hidden global game state, or persistence unless explicitly requested.

The core pipeline is `directScene()` in `lib/engine/director.ts`. Writer is intentionally split into two phases so image generation can begin before full dialogue is ready:

1. Writer Phase A runs serially and produces `WriterPlan`: `sceneSummary`, `sceneKey`, `entryBeatId`, `cast`, `entryActiveCharacters`, and `entrySpeaker`.
2. Writer Phase B starts immediately and overlaps the image pipeline. It produces `beats[]` and `storyStatePatch`, constrained to honor the plan.
3. CharacterDesigner card LLMs and Cinematographer run in parallel from the plan.
4. Entry-beat portraits may block Painter because they become references.
5. Painter generates the scene background from Cinematographer `integratedPrompt` plus `referenceImages`.
6. Non-entry portraits and all voice provisioning should overlap with painting, then Phase B is awaited before scene assembly.

Do not add blocking calls between Writer Phase A completion and Painter start. Anything that can overlap with Phase B or painting should.

At session start, `startSession()` runs Architect first to create `storyState`; subsequent scene requests must rely on the client-carried `Session`, not server memory.

## Domain Model Invariants

`Scene` is an image plus a graph of `Beat` nodes. `Beat.next` is either `continue` or `choice`. A scene should have at least one meaningful `change-scene` exit toward a new scene. Beat ids are graph keys; keep them unique and repair references when coercing LLM output.

`Scene.media` is an optional discriminated image/video descriptor. Do not
remove `Scene.imageUrl`: old sessions, shares, image references and authored
cases depend on it. Missing/invalid media coerces to the legacy image path.
Video URLs must be controlled AIstory routes; player payloads never carry
filesystem paths, workflow JSON, prompts, or provider task ids. A video with
its own audio suppresses beat TTS. Choices/dialogue unlock only through the
player's idempotent completion handler; video frames are not vision/freeform
targets unless the authored media explicitly enables hotspots.

`SceneHistoryEntry.storyStateAfter` snapshots the story memory after each scene is generated. Keep it when exporting/importing playable story JSON or replaying shared sessions so continuing from a replayed prefix uses the right narrative context.
Author-locked case studies carry `authorLocked`, per-node `episodeId` /
`sourceParagraphIds`, a fail-closed `releasePolicy`, and an
`aiContinuationBoundary`. Before that boundary, authored choices must resolve
through the carried local graph: do not prefetch `/api/scene`, accept freeform
or vision branches, or rewrite authored prose. Restricted nodes and source
reference material must never be emitted into the public case bundle.

`StoryState` has stable and volatile zones. Stable fields are set by Architect and must not be patched by Writer: `logline`, `genreTags`, `protagonist`, `castNotes`. Volatile fields may be rewritten every scene: `synopsis`, `openThreads`, `relationships`, `nextHook`. If adding a field, classify it and update `applyStoryStatePatch()` plus Writer coercion.

Characters are identified by `name`. `mergeCharacters()` preserves existing portrait and voice fields when a later design omits them. Do not casually change character matching without checking Writer, Director, and Painter reference handling.

Authored showcase cases use `Session.authoredStory`. Their node graph, current
node/beat, numeric variables, role state, and character state travel with the
browser-local Session. `TimelineCheckpointSnapshot` must clone and restore the
same authored runtime so variables and per-character visual states survive
worldline forks and branch activation. Authored character forms use a stable
`characterId` plus `spriteStateId`; switching visual form must preserve voice,
voiceProfile, relationships, and identity. Choices with `authoredTargetNodeId`
must transition locally and must not call `/api/scene` or speculative
generation, including history re-selection. Pending case assets use an explicit
pending illustration; never promote an unconfirmed file or a source face
reference to a public cover/scene.

`Character.voiceProfile` is the structured voice-casting constraint derived from gender, age range, and archetype. Provider adapters must honor it before free-text `voiceDescription` guessing: male profiles may only resolve to male presets, female profiles to female presets, and the opt-in narrator profile must remain separate from character dialogue. Include `voiceProfile` in beat-audio fallback payloads and cache keys so a changed casting profile cannot reuse stale audio.

The player POV is hardcoded as second-person Chinese `"你"`. The player should not appear in `activeCharacters`, images, portraits, or TTS. Preserve normalization in Writer and InsertBeat flows.

`orientation` is session-wide and locked at start (`"portrait"` for upright touch devices, otherwise `"landscape"`). It controls prompt framing, generated dimensions, mock images, and `PlayCanvas` layout; preserve back-compat by coercing missing/invalid values to `"landscape"`.

`styleReferenceImage` is an optional client-resized `data:image/...` reference stored in the carried `Session`. It can make request bodies large, so keep validation limits and client resizing intact.

## Agent Output & Error Handling

Agent outputs should follow the existing pattern:

1. Raw LLM type accepts optional and variant fields.
2. Coercion normalizes names, defaults, and malformed values.
3. Repair fixes structural issues.
4. Fallback returns a safe value instead of throwing at the agent boundary.

Never use direct `JSON.parse()` on core agent LLM output. Use `parseJsonLoose()` from `lib/engine/jsonParser.ts`, which attempts direct parse, fenced JSON extraction, object slicing, and `jsonrepair`. Narrow utility routes may parse first only when they also have a safe fallback, as `/api/parse-style-image` does.

Maintain graceful degradation. Existing flows tolerate malformed AI JSON, failed character cards, failed portraits, failed TTS, failed image references, optional analytics, and provider timeouts. Do not convert optional provider failures into hard crashes.

## Visual Continuity & Prompt Caching

`sceneKey` identifies a physical space such as `"classroom-dusk"`. If a new scene shares a key with prior history, the prior scene image should be reused as a reference. Character portraits are also references.

Runware allows at most 4 references. Preserve the priority: style reference image, prior scene, speaker portrait, then other NPCs. Prefer image URLs for `referenceImages` when needed because Runware can fail to recognize UUIDs. The native OpenAI image path (gpt-image) can also accept references via `images.edit`, but returns data URIs and synthetic UUIDs, so repeated session transport is heavier than Runware's URL/UUID loop.

Writer prompt caching depends on `buildWriterPlanUserMessage()` and `buildWriterBeatsUserMessage()` keeping their stable prefixes intact: world, style, story spine, archived history, known scene keys, and character list. The dynamic suffix contains current state, last beat, exit hint, and the current plan. Do not reorder or reformat stable prefix sections casually; it can destroy cache hit rates.

## API Flow

Common routes live under `app/api/`:

- `POST /api/start`: starts a session via Architect then `directScene()`.
- `POST /api/scene`: generates the next scene from an existing session.
- `POST /api/vision`: interprets scene-image clicks.
- `POST /api/insert-beat`: creates a transient beat without image generation.
- `POST /api/beat-audio`: lazy TTS for a displayed beat; returns binary audio, or `204` when silent. `voice` is now OPTIONAL — when the server runs StepFun, the client omits the ~220KB Xiaomi reference audio and sends `stepfunVoiceId` / `voiceDescription` instead (saves Fast Origin Transfer bandwidth). The engine re-provisions on a provider mismatch before synthesizing.
- `POST /api/beat-audio` also accepts `voiceProfile` as a structured provider fallback. Keep it aligned with `Character.voiceProfile` and include it when the client shapes either lightweight or defensive fallback requests.
- `POST /api/parse-style-image`: extracts a style prompt from uploaded reference art.
- `GET /api/tts-provider`: returns `{ provider: "stepfun" | "xiaomi" | null }` (the server's TTS provider, inferred from `TTS_BASE_URL`). Probed once at `/play` mount (non-BYO) so `fetchBeatAudio` can shape its request body — skip the ~220KB Xiaomi reference audio when the server runs StepFun. BYO client TTS takes precedence over this signal.
- `POST /api/story-pack` / `POST /api/story-unpack`: stateless packing/unpacking for playable story share `.infiplot` files (plaintext + SHA-256 integrity check, no encryption).
- `POST /api/gallery-pack` / `POST /api/gallery-unpack`: same format as story-pack/unpack but for gallery share files (5 MB pack limit vs story's 12 MB).

When changing public types or route payloads, update all route callers and client consumers in the same change.

All API routes currently run on `runtime = "nodejs"`. Keep Cloudflare implications in mind before adding Node-only dependencies to code that should also work in browser/client or OpenNext builds.

The client deliberately strips `voice.referenceAudioBase64` from `Session` before `/api/scene`, `/api/vision`, and `/api/insert-beat` transport, then merges voices back locally. Server responses strip already-known voices to reduce payload size. Preserve this first-load/request-size behavior when changing character or TTS flow.

`clientTts: true` means the browser owns Xiaomi TTS keys and provisions/synthesizes voices locally; routes must drop `config.tts` so server-side TTS is skipped and user keys never touch the server.

`app/play/page.tsx` speculatively prefetches future `/api/scene` responses up to `PREFETCH_MAX_DEPTH`. If scene/session shape changes, update speculative session construction, cache re-rooting, abort logic, and voice/image preload handling together.

## Build, Test, and Development Commands

Use pnpm with Node >=22. `pnpm-lock.yaml` is the source of truth; `package-lock.json` is legacy and should not be updated unless requested.

- `pnpm dev`: local Next.js dev server.
- `pnpm build`: production build for Vercel/default target.
- `pnpm test:local-font-offline`: zero-network static gate for production font
  inputs. It rejects `next/font/google` and Google Font stylesheet/asset hosts
  from build source, and verifies that the packaged system serif/sans CSS
  variables remain defined. The canonical `pnpm build` runs this gate first,
  then validates its non-empty `BUILD_ID`, required App Router manifest paths,
  parsed font manifest, and generated artifacts before reporting success.
- `pnpm start`: run production server after building.
- `pnpm lint`: Next.js built-in lint.
- `pnpm typecheck`: `tsc --noEmit`.
- `pnpm test:admin`: local repository, admin security, immutable/idempotent
  credit ledger, configuration precedence, masking, audit, and analytics tests.
- `pnpm test:account-billing`: phone normalization/masking, OTP throttling and
  expiry, one-time registration grant, signed user sessions, versioned 2x price
  policy, reserve/settle/refund, admin-grant idempotency/audit, anonymous cache
  access, BYOK exemption, and speculative depth-0 hard rejection.
- `pnpm test:platform-billing`: exhaustive direct-provider route inventory,
  cache/author-lock preflight ordering, phone-only platform access, formal
  idempotency keys, cancellation refunds, receipt-vs-catalog settlement,
  BYOK TTS isolation, and loopback/video fail-closed boundaries. It performs no
  provider request and uses no production database.
- `pnpm test:sms-provider`: zero-network Aliyun Dysmsapi V2 adapter coverage,
  including canonical configuration, domestic-number normalization, redacted
  diagnostics, provider failure mapping, pending/sent/invalidation
  compensation, local-mock loopback enforcement, and response/store secrecy.
- `pnpm test:production-db-gate`: static forward-migration/RLS/GRANT/RPC
  contract, browser direct-write denial, database-owned security posture,
  UUID phone-session compatibility, production fail-closed behavior,
  redacted RPC payloads, and atomic/idempotent administrator mutation
  coverage. It does not apply the migration or claim a real Postgres run.
- `pnpm test:admin-staging`: zero-network by default. With its explicit
  staging switch it accepts only an SSH-tunnel/loopback Supabase URL, verifies
  the database/admin posture and RPC snapshot, and can optionally replay one
  separately approved synthetic credit adjustment. It never prints secrets or
  identity values.
- `pnpm test:anonymous-claim`: signed high-entropy anonymous subject,
  public-safe claim-manifest validation, same-browser UUID inheritance,
  first-grant/claim transaction semantics, replay/conflict/concurrency,
  experiment assignment pinning, credential/demo-credit exclusion, local
  namespace recovery, and the forward SQL/RLS/RPC contract. It uses fake
  repositories and never sends SMS or applies a database migration.
- `pnpm test:hosted-byok`: zero-network envelope encryption, AAD tamper,
  cross-user denial, KEK rotation, recent step-up, mutation idempotency,
  redacted DTO/audit, zero-platform-credit and speculative-depth-0 coverage.
  It uses synthetic in-memory keys and a fake repository.
- `pnpm test:video-story-runtime`: legacy image coercion, controlled video
  media/share round trips, subtitle cue selection, embedded-audio TTS
  suppression, interaction defaults, and ended/seek/skip single completion.
- `pnpm test:world-model-demos`: five-card/catalog/story identity, public
  derivative size/hash, exact legacy rewrites, controlled URL redaction and
  synthetic zero-network MP4 200/206/416/HEAD Range delivery coverage.
- `pnpm test:admin-video-assets`: MP4/WebM content validation, WebVTT safety,
  local adapter fail-closed rules, atomic idempotent adoption, review/publish
  gate, DTO redaction, and ComfyUI video availability preflight. It uses a
  synthetic header fixture and fake probe; it does not run ffprobe or a model.
- `pnpm test:production-video-assets`: zero-network production video-asset
  contract and runtime-adapter coverage. It uses in-memory metadata/RPC state,
  a fake `ali-oss` client, a fake ECS-role builder and a fake ffprobe runner to
  verify IMDSv2-only credentials, exact internal endpoint/bucket/prefix rules,
  tenant/project/hash keys, conditional put/head/range/delete/scoped-list,
  idempotent upload/publish, reference-aware cleanup, grace-aged project-only
  reconciliation, append-only audit, DTO redaction, Gate14 fail-closed behavior
  and object 200/206/416 delivery. It
  never reads runtime credentials or connects IMDS, Supabase, OSS or ffprobe.
- `pnpm test:video-story-composer`: interactive video graph validation, asset
  scope/review gates, deterministic public-safe compilation, local draft
  idempotency, review/publish/offline state, and preview completion semantics.
- `pnpm test:video-workflow-ab`: canonical experiment hashes, official-weight
  fairness constraints, hostile ZIP/path/symlink/size rejection, media/probe
  integrity, blinded review/reveal/approval rules, redacted DTOs, idempotency,
  local persistence, and the post-approval ProjectAsset-only adoption gate. It
  uses synthetic bytes and a fake probe; it does not run ComfyUI or ffprobe.
- `pnpm test:gpu-coordinator`: zero-network LAN LAB contract coverage for
  canonical HMAC vectors, single-flight idempotency, connector/version gates,
  global single-concurrency lease order, progress/cancellation, exact workflow
  allowlists, public DTO redaction, MP4/WebM upload integrity, and one-time
  source-video download tickets for an independent upscale job. It does not
  connect a 4090 machine or run ComfyUI.
- `pnpm export:gpu-central-contract`: export a deterministic, gitignored
  Central schema/transcript bundle tied to SHA-256 digests of `types.ts`,
  `connectorCompatibility.ts`, `protocol.ts`, `service.ts`, and `server.ts`.
  The canonical bundle never embeds its own hash; the operator computes and
  injects that external SHA-256 into both sides. Connector readiness must
  validate the whole bundle hash before treating fake conformance as
  Central-compatible.
- `pnpm test:gpu-connector-qualification`: zero-network synthetic coverage for
  the explicit four-file offline package qualifier, including raw ZIP header
  limits, hostile path/link/encryption rejection, payload/source-tree hashes,
  the exact current Central golden, P1.7 enum/posture compatibility and a
  deterministic redacted static-only report. It never executes archive code,
  starts a Connector, reads runtime secrets, or claims deployability.
- `pnpm test:steam-desktop`: controlled external-link allowlist, Steamworks
  fail-closed capability state, Gamepad mapping, ending-only brand CTA,
  Electron renderer security flags, loopback runtime and offline billing/SMS
  shutdown contract. It does not start Electron or connect Steamworks.
- `pnpm test:steam-video-plan`: deterministic Steam launch graph coverage,
  stable task/output ids, five-stage dependency batches, strict job/asset
  projection, original/upscale separation, review/publish gates and redacted
  JSON/CSV export. It uses synthetic snapshots and performs no provider or
  network request.
- `pnpm test:steam-video-preflight`: authoritative three-shot coverage,
  deterministic spec/input hashes, strict publishable workflow pinning,
  source-reference and shot-policy blockers, independent upscale specs, pure
  GenerationJob input mapping and redacted JSON/CSV export. It writes no job,
  submits no provider request and performs no network call.
- `pnpm build:steam:runtime`: build Next standalone and stage a content-hashed,
  secret-excluding desktop runtime under ignored `dist/steam/`.
- `pnpm package:steam:win`: repeat the standalone staging and create an
  unsigned Windows x64 Electron directory package. It does not upload a depot,
  sign binaries or connect Steamworks.
- `pnpm build:steam:runtime:linux`: build the same secret-excluding standalone
  runtime with a Linux x64 target manifest.
- `pnpm package:steam:linux`: create an unsigned Linux x64 Electron directory
  package only from an already-cached official Electron ZIP. It fails with
  `BLOCKED_NATIVE_BINARY_NOT_BUILT` instead of downloading, and never builds an
  AppImage or uploads a depot.
- `pnpm test:creator-providers`: creator-module routing, loopback boundaries,
  dynamic ComfyUI image/video workflows, invalid references, and the P1 rule
  that ComfyUI never accepts speculative-prefetch submissions.
- `pnpm test:workflow-registry`: zero-network package-v1 parsing, hostile
  field/path/secret rejection, loopback Host/Origin and JSON-size gates, safe
  management DTOs, idempotent in-process concurrent version imports, enable/disable,
  rollback and primary/previous registry integrity. It never probes 8188 or
  runs a workflow.
- `pnpm test:case-study`: validate the Virtual Girlfriend source graph, branch
  variables, manifest contract, deterministic compilation, transition state,
  and JSON persistence.- `pnpm test:author-locked-v1.1`: validate the 180-paragraph author
- `pnpm test:case-asset-review`: validate the loopback-only Virtual Girlfriend
  review manifest projection, count totals, local-path/prompt redaction, and
  in-memory review decisions. Review labels never copy assets into `public`.
- `pnpm test:author-locked-v1.1`: validate the 180-paragraph author
  traceability matrix, 13 verbatim choices, public/restricted release boundary,
  authored worldline transitions, cache-version isolation, and the derived
  public bundle/assets.
- `pnpm import:virtual-girlfriend`: validate and mechanically compile the local
  case-study delivery. It copies only assets marked `generated` from that
  case's `generated-assets` directory; pending items remain explicit pending UI.
- `pnpm test:asset-continuity`: temporary-store fixture for succeeded job →
  project asset adoption → integrity-checked ComfyUI reference upload → next
  generation job. It covers project isolation, tamper/missing-cache rejection,
  stable reference revisions, loopback mutation security, and upload
  single-flight without touching the normal local stores.
- `pnpm test:studio-generation`: pure request-builder coverage for the
  `/studio` ComfyUI/LocalMiniDrama engine selector. It asserts the donor input
  whitelist, current project binding, unavailable/no-project fail-closed
  states, reference exclusion, shared job visibility, and honest
  cancel-request messaging without submitting a real generation task.
- `pnpm test:usage-disclosure`: generation-call transparency coverage for
  immediate text/image/TTS calls, 0/1-layer speculative generation, BYOK vs
  controlled-platform responsibility, mixed capability sources, and the rule
  that no key, endpoint, model name, invented price, or credit amount may be
  serialized into disclosure state.
- `pnpm test:creator-bridge`: typed LocalMiniDrama project summaries, partial
  endpoint degradation, loopback enforcement, and private-body redaction.
- `pnpm test:creator-studio-typed-bridge`: zero-network protocol-v1 iframe
  parser/builders, exact origin/source and known-project actions, task/media
  intent allowlists, project-memory fallback, prototype/extra-field rejection,
  and public bridge DTO redaction.
- `pnpm test:local-stack-security`: zero-network startup-policy coverage for
  loopback-by-default listeners, the explicit LAN-development switch, exact
  HTTP 200 health gates, forced TLS verification, and the read-only SQLite
- `pnpm test:steam-demo-report`: zero-network pure contract coverage for the
  Steam settings test-report allowlist, public identifiers, bounded manual
  description, fixed filename, UTF-8 serialization, local download and exact
  copy fallback. It does not read storage or logs, call an API, or upload a
  report.
  resumable-supplier-task preflight. It uses a synthetic temporary database.
- `pnpm test:local-generation`: ComfyUI workflow registry/version rollback,
  transport limits, Host/Origin enforcement, durable GenerationJob recovery,
  idempotency/content fingerprints, cancellation races, LocalMiniDrama adapter,
  and single-flight scheduling.
- `powershell -File scripts/start-aistory-local-stack.ps1`: idempotently start
  or verify the local AIstory 4200 + LocalMiniDrama backend 5679 + frontend
  4107 stack. It binds all three services to `127.0.0.1` by default, forces
  LocalMiniDrama TLS verification, and refuses to start its backend while a
  resumable supplier video task exists. Use `-StatusOnly` for checks without
  starting anything. The independent `-AllowLanBinding` development switch
  binds all three services to `0.0.0.0` and prints a risk warning; it never
  disables TLS verification. The script reuses the established
  `D:\AI-story\logs` / `D:\AI-story\pids` locations and does not install an OS
  startup task. Donor-local launch commands are reference-only and bypass
  these safety gates; do not use them as AIstory startup paths.
  If the tracked `app/[locale]/studio/page.tsx` exists but Studio returns 404
  and `.next/dev` omits that route while a production build contains it, stop
  only AIstory, quarantine the ignored `.next/dev` directory, and restart via
  this script. Do not add a duplicate page or bypass locale routing.
- `pnpm enrich:firstacts`: one-off enrichment of `public/home/firstact{,-portrait}/*.json` — adds `characters[i].stepfunVoiceId` via a TEXT-provider LLM call per character (uses `.env.local`). Idempotent; `--force` re-picks, `--only=f0,f1` filters, `--portrait` targets the portrait set.
- `pnpm build:cf`: Cloudflare Workers build through OpenNext.
- `pnpm preview:cf`: local Cloudflare preview.
- `pnpm deploy:cf`: Cloudflare deploy.

There is no dedicated test framework, no Prettier config, and no standalone ESLint config. Before handing off code changes, run `pnpm typecheck` and `pnpm lint`; run `pnpm build` for routing, deployment, or provider initialization changes.

## Coding Style & Imports

Write TypeScript with 2-space indentation, double quotes, semicolons, and ESM imports. Prefer named exports for shared helpers and components when practical.

Use aliases from `tsconfig.json`: `@/*`, `@infiplot/engine`, `@infiplot/ai-client`, `@infiplot/tts-client`, and `@infiplot/types`. Avoid deep relative import chains when an alias exists.

React components use PascalCase. Hooks, helpers, variables, and functions use camelCase. Types and interfaces use PascalCase. Route folders follow Next.js App Router conventions. UI work should follow the existing Tailwind-heavy visual language.

Modal/dialog UI should be extracted into dedicated components instead of being inlined inside large page or canvas components. Keep the host responsible for open/close state and domain data, and keep the modal component responsible for dialog layout, overlay behavior, keyboard close handling, scroll containers, and modal-specific styling.

Comment only non-obvious sequencing, provider quirks, fallback behavior, or architectural invariants.

## Configuration & Providers

Use `.env.example` as the source of truth. Never commit `.env.local`, API keys, uploaded user content, or generated secrets.

- Text and Vision use `TEXT_*` and `VISION_*` over the `openai_compatible` protocol (the only supported text/vision protocol); Claude and Gemini are reached via their own OpenAI-compatible endpoints with the `*_PROVIDER` var unset.
- Image uses `IMAGE_*`; supported protocols are `runware`, `openai_compatible`, and native `openai`. When `IMAGE_PROVIDER` is unset, Runware is inferred from `*.runware.ai` URLs and otherwise falls back to OpenAI-compatible image generations.
- `IMAGE_TIMEOUT_MS` (per-attempt hard deadline) and `IMAGE_HEDGE_MS` (Painter scene-paint hedging: race a second request when the first is still pending after the threshold) are both OFF when unset — the default path must stay byte-identical to historical behavior. Hedging applies only to the Tier-A scene paint, never to portraits, and never fires after a fast failure (saturation guard). Client-side engine configs (`resolveEngineConfig`) intentionally do not set these fields.
- TTS supports Xiaomi MiMo (voicedesign + voiceclone) or StepFun (preset voices), inferred from `TTS_BASE_URL` (host containing `stepfun.com` → StepFun, otherwise → MiMo). `CharacterVoice` is a discriminated union on `provider`; synth dispatches on the voice's own tag so a session may carry both shapes through a provider switch. Blank config means silent mode. StepFun voice selection: the CharacterDesigner LLM picks a preset id directly from the 32-entry catalog (`lib/tts-client/stepfun-voices.json`, rendered by `formatStepfunCatalogForPrompt`) when `config.tts` is StepFun — zero extra LLM call. `pickStepfunVoiceId` (keyword scorer) is the fallback for orphan speakers / invalid picks. Prebaked homepage cards are enriched with `Character.stepfunVoiceId` via `scripts/enrich-firstacts-stepfun.mjs` so a card works under either server provider.
- `MOCK_IMAGE=true` skips image generation and returns a placeholder for cheap local iteration.
- `NEXT_PUBLIC_IMAGE_PROXY_URL` and `NEXT_PUBLIC_IMAGE_PROXY_ALLOWED_HOSTS` opt into browser-side image proxying for allowed hosts.
- Analytics uses optional Umami `NEXT_PUBLIC_UMAMI_*` values and must stay content-free/privacy-preserving.
- Application text uses packaged CSS system-font stacks through
  `--font-serif` and `--font-sans`; this checkout has no tracked text font
  binaries. Do not reintroduce a build-time font download or source a font from
  `.next`, browser caches, or machine-local font directories. A new bundled
  third-party font requires an explicit license and provenance review.
- `.infiplot` share files use plaintext + SHA-256 integrity (no encryption, no secret needed); the feature is always enabled.
- `NEXT_PUBLIC_*` values are inlined at build time.
- The admin control plane defaults to a server-only local repository and is
  disabled for login until both `AISTORY_LOCAL_ADMIN_ENABLED=true` and a random
  `AISTORY_LOCAL_ADMIN_SECRET` (24+ characters) are provided. Local admin
  sessions are accepted only on loopback hostnames. Production must opt into
  `AISTORY_ADMIN_REPOSITORY=supabase` and provide
  `SUPABASE_SERVICE_ROLE_KEY` through a secret manager. Never use player
  `requireUser()` for administrator authorization.
- BYOK defaults to browser `sessionStorage`; remembering keys in `localStorage` is an explicit user choice and is not described as encrypted. Platform keys are server-only `env:`/`secret:` references. Public routes may use them only when `AISTORY_PLATFORM_MANAGED_ENABLED=true` and the authenticated user id is in `AISTORY_PLATFORM_MANAGED_ALLOWLIST`; `anonymous` is always denied and client flags never grant access.
- BYOK capability diagnostics are field-only and must never serialize API keys,
  base URLs, model names, or endpoint details. Text and image are the core
  interactive-story capabilities; vision, TTS, and video are optional.
- Current-scene BYOK redraw may read only the user's image credential, and
  current-scene BYOK prose rewrite may read only the user's text credential.
  These strict paths must not call `/api/style-hot-swap`, fall back to
  `/api/llm/user-proxy`, or use platform-managed credentials.
- Formal platform-credit generation is separately gated by
  `AISTORY_PLATFORM_BILLING_ENABLED`. Cache reads and authored local transitions
  happen before that gate. On a cache miss, anonymous callers receive a
  redacted quote and phone-login requirement; only phone-authenticated callers
  may reserve integer credits before provider work. Every platform-credit call
  requires a caller-supplied idempotency key. Success appends a settle entry, while cache
  races, failures, cancellation and empty output append a refund. A typed,
  currency-matched provider receipt may settle with the actual cost and
  reconcile the difference; without that receipt the source stays explicitly
  `price_catalog`. Registration `initial_grant` is globally one-time per
  account even when the price-policy version changes. Browser demo credits are
  not a formal server balance.
- Production phone identity and billing additionally require
  `AISTORY_PRODUCTION_IDENTITY_ENABLED=true`,
  `AISTORY_IDENTITY_REPOSITORY=supabase`,
  `AISTORY_ADMIN_REPOSITORY=supabase`, and
  `AISTORY_DATABASE_GATE_VERSION=20260811193000`, together with the Supabase
  URL and service-role secret. The server verifies both the same version and
  the database-owned RLS/GRANT security posture before sending real SMS or
  quoting/reserving formal credits.
  An env version alone never proves that a migration was applied. Legacy
  `phone_<hash>` sessions are local-mock-only; production phone cookies carry
  a stable UUID.
  Production also requires independent 32+ character
  `AISTORY_ANONYMOUS_SESSION_SECRET` and
  `AISTORY_ANONYMOUS_SUBJECT_PEPPER` values before any real SMS transport.
  Missing values fail closed before an external call.
- Production administrator actors are bound to the Supabase repository only
  after the same environment and database-owned gate check. They never fall
  back to `.aistory-admin`; loopback local actors remain explicitly bound to
  the local development repository.
- Phone verification selects `AISTORY_SMS_PROVIDER=aliyun_dysms` only when
  server-side `ALIBABA_CLOUD_ACCESS_KEY_ID` /
  `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, `ALIYUN_SMS_SIGN_NAME`, and
  `ALIYUN_SMS_TEMPLATE_CODE_LOGIN` are all present. Optional canonical settings
  are `ALIYUN_SMS_REGION`, `ALIYUN_SMS_ENDPOINT`,
  `ALIYUN_SMS_TEMPLATE_PARAM_CODE_KEY`, and bounded connect/read timeouts. The
  provider uses the official Dysmsapi 2017-05-25 V2 SDK, treats only
  `SendSms` Code `OK` as success, does not retry an ambiguous send, accepts
  domestic `+86` numbers only, and never returns raw provider errors. The OTP
  challenge is pending before the call and becomes verifiable only after both
  provider acceptance and durable `sent` marking; every failure invalidates it.
  Local mock remains loopback-only. Production configuration and a real-message
  smoke test are deployment gates, not claims made by the code adapter.
- Before a foreground generation action, UI disclosure must describe the
  capability set and cost-responsibility source without displaying secrets or
  invented prices. Prefetch depth 0 means no speculative request; depth 1 may
  prepare only the next text and image layer. Platform-credit prices remain
  absent until the authoritative server ledger can quote and settle them.
- Steam P1 starts the bundled runtime only on a `127.0.0.1` port that is
  randomly allocated on first launch and then retained in that Electron
  `userData` profile so browser-local saves keep a stable origin. Every launch
  rejects a preoccupied port and requires a fresh 32-byte proof from the newly
  spawned bundled child before trusting that origin. The desktop shell is
  single-instance, and blocks renderer Node access, unexpected permissions,
  arbitrary navigation, new windows and webviews. External navigation is
  user-triggered, shows the target domain, matches an exact official allowlist
  and opens in the system browser. The launch brand is briefly skippable;
  product CTA appears only after a chapter/ending completes and never grants
  rewards. Normal gameplay frames are not watermarked. Steam builds cannot
  offer off-platform purchases; Wallet remains unavailable until real
  Steamworks is approved. Windows x64 and Linux x64 use directory-package
  candidates; Steam Deck remains planned through Proton and native Linux/Deck
  are not mechanically verified. Linux packaging is strictly offline and uses
  Electron/XDG user-data, cache and log roots rather than the install tree.
- LocalMiniDrama bridge URLs default to `127.0.0.1:5679` and `:4107`; P1 blocks
  non-loopback URLs and exposes only sanitized health/capability state.
  ComfyUI is opt-in with `COMFYUI_ENABLED=true`; configure image/video API
  workflow wrappers through `COMFYUI_*_WORKFLOW_JSON`. Invalid, missing, or
  offline configuration fails closed. ComfyUI accepts foreground generation
  only in P1, so branch-prefetch depth 0 remains a hard no-request/no-GPU rule.
- ComfyUI templates can instead be registered in the gitignored
  `.aistory-comfyui/` server-only registry. Ordinary users only receive enabled
  template summaries; import/enable/rollback requires an authenticated local
  admin, a loopback same-origin mutation, a reason, and audit logging.
- All local GPU mutations require an exact loopback Host/Origin pair even when
  dev is bound to `0.0.0.0`. Provider fetches reject redirects. GenerationJob
  input is not returned by public APIs; `.aistory-jobs/` is server-only.
- The separate GPU Connector LAN LAB is OFF unless every
  `AISTORY_GPU_LAN_LAB_*` gate is explicit. It accepts a single connector id,
  a 32+ byte server-only HMAC secret, an explicit gitignored store, one exact
  HTTPS upload hostname, and exact workflow id/SHA allowlist entries. Its
  connector polls outbound; ComfyUI itself is never exposed. Empty allowlists,
  missing storage or missing secrets fail closed. It shares the AIstory-owned
  global GPU slot and never accepts speculative jobs. Frozen parameters are
  authoritative: the current original LTX LAB workflow remains 768x480/81
  frames/24 FPS/seed 40902000. Higher resolution requires a distinct allowlisted
  upscale workflow with a one-time `sourceVideo` GET ticket, preserved audio,
  and a new output artifact; do not edit the original workflow to upscale it.
  P1.7 additionally requires exact expected Connector build/release/
  capability/Central-contract hashes and an exact `no_work_only` posture before
  registration. `registered` is never a heartbeat state; reconcile requests
  accept only received/running/succeeded/failed/cancelled while Central replies
  only offered/acknowledged/running/succeeded/failed/cancelled/unknown. The
  production-network and LAN-LAB-network Connector switches default false and
  are mutually exclusive; Central does not infer remote network truth from
  their signed values.
- GenerationJob idempotency keys prevent replay but are excluded from the
  stable content fingerprint. Missing seeds are generated and persisted before
  fingerprinting; explicit force/regeneration nonce bypasses content reuse.
- Project assets must never be sent to ComfyUI by their public URL. Resolve
  `projectId + assetId` server-side, reread the content-addressed media cache,
  verify SHA-256/MIME/bytes, then upload through the existing redirect-denying
  ComfyUI transport. The returned client DTO is limited to a provider input
  name/subfolder plus a stable revision derived from asset id and content hash.
- `/studio` exposes ComfyUI and LocalMiniDrama as two frontends for the same
  GenerationJob scheduler. LocalMiniDrama UI requests may contain only the
  current drama id, prompt, negative prompt, frame/size/aspect, style, seed,
  and idempotency fields; never forward workflow ids, references, provider or
  model overrides, URLs, or filesystem paths. Both provider routes run a
  server-side availability preflight before queue insertion.
- Administrator video upload requires `AISTORY_VIDEO_ASSET_ADAPTER` to equal
  `local_development`, an absolute `AISTORY_VIDEO_FFPROBE_PATH`, a local admin
  session, and an exact loopback Host/Origin. It accepts only MP4/WebM after
  magic/MIME/size/ffprobe codec validation and stores content under
  `.aistory-video-assets`. Production uses the server-only Gate14 Supabase RPC
  repository, private Aliyun OSS adapter, explicit ECS RAM Role IMDSv2-only
  credential source and bounded temporary-file ffprobe. It accepts only the
  exact configured internal HTTPS endpoint and canonical
  `aistory/video-assets/v1/tenants/<tenant>/...` prefix; it never uses the SMS
  AK variables or exposes OSS URLs/keys. Missing Gate14, repository, role,
  endpoint, bucket, probe or any database-owned posture returns a generic 503
  with no local fallback. Code/fake conformance is not real-cloud acceptance;
  applying the migration, configuring private OSS/IAM and executing an
  explicitly approved synthetic cloud smoke remain deployment gates. See
  `runbooks/production-video-assets-aliyun-oss.md`.
  Generated video must be adopted as draft, reviewed, and approved before a
  public projection exists. Bind/release-policy changes are draft-only.
- Interactive video story composition is local-only when
  `AISTORY_VIDEO_STORY_ADAPTER=local_development`. Its gitignored
  `.aistory-video-stories/` store uses atomic replacement and content-addressed
  release artifacts. Production repositories and object storage are not
  implemented, so production administrators and public release reads fail
  closed instead of falling back to local JSON.
- Video workflow A/B import is local-only when
  `AISTORY_VIDEO_AB_ADAPTER=local_development`. Packages must use canonical
  manifests, identical official weight hashes and generation semantics across
  A/B, empty third-party LoRA lists, and an allowlisted execution-only B diff.
  Warmups and post-processing are separately labeled; neither can decide the
  base comparison. Approval requires blinded, interleaved measured pairs and
  still does not publish: adoption creates a private ProjectAsset that must pass
  the existing VideoAsset review/release gate.

## File Dependency Map

If modifying Writer, also check `director.ts`, `prompts.ts`, WriterPlan/StoryState types, and Cinematographer/Painter consumers. If modifying CharacterDesigner, check Director scheduling/merge logic, portrait prompts, voice provisioning, Painter reference collection, and (StepFun path) the `buildCharacterDesignerSystem` catalog injection + `stepfunVoiceId` validation. If modifying the StepFun voice catalog (`lib/tts-client/stepfun-voices.json`), also check `formatStepfunCatalogForPrompt`, `isValidStepfunVoiceId`, the CharacterDesigner system prompt, and the enrich script. If modifying Cinematographer or Painter, check Director, prompt builders, provider image options, orientation handling, and reference priority. If modifying Architect, check `orchestrator.ts`, `prompts.ts`, and StoryState patch rules. If modifying `lib/types/index.ts`, check all agents, Director, Orchestrator, API routes, and client consumers in `app/page.tsx`, `app/play/page.tsx`, and `components/PlayCanvas.tsx`. If modifying TTS, check server `beat-audio` (including the `resolveVoice` provider-mismatch normalization), `/api/tts-provider`, BYO client TTS, voice stripping/merging, payload privacy, and the StepFun voice-id flow (CharacterDesigner → provision → synth). If modifying image delivery, check Painter, `lib/ai-client/image.ts`, mock images, orientation dimensions, preload/proxy logic, and style-reference validation.

## Guide Maintenance

After any refactor, architecture change, provider-client rewrite, public type change, new route, payload-shape change, or major UI flow change, reread the affected files and compare them against this `AGENTS.md`. Update `AGENTS.md` in the same change if the architecture, commands, invariants, dependency map, environment variables, or "What Not To Do" list drifted. The canonical filename is `AGENTS.md`; treat mentions like `AGETNS.md` as typos and repair the real file.

## Commit & Pull Request Guidelines

Follow observed Conventional Commit style: `feat(web): ...`, `fix(play): ...`, `perf(engine): ...`, `chore(engine): ...`.

PRs should include a short behavior summary, validation commands run, linked issues when relevant, screenshots or recordings for UI changes, and notes for environment, provider, deployment, or payload-shape changes.

## What Not To Do

- Do not make the server stateful.
- Do not generate images, portraits, or TTS for `"你"`.
- Do not let Writer patch stable `StoryState` fields.
- Do not reorder the Writer stable prompt prefix without a clear cache-aware reason.
- Do not assume Runware UUID references always work.
- Do not remove fallbacks, timeout handling, analytics privacy constraints, or reference priority rules.
- Do not leak browser-provided TTS keys to the server or send retained voice audio through scene/vision/insert-beat session payloads.
- Do not break session-locked orientation or style-reference propagation when changing start/play flows.
- Do not regenerate large assets in `public/` unless the user requested asset work.
- Do not mix prompt refactors, provider-client rewrites, UI restyling, and deployment changes in one narrow task.
