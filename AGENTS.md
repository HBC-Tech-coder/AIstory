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
  gitignored `.aistory-admin/` directory.
- `components/CreatorStudioShell.tsx`, `lib/creator-studio/`,
  `lib/localminidrama/`: AIstory-owned creator shell and loopback-only
  LocalMiniDrama capability adapter. The donor repository is reference-only;
  production features remain embedded behind the AIstory shell instead of
  being copied into a second codebase.
- `lib/providers/comfyui/`: fail-closed local image/video provider contract,
  dynamic workflow validation, capability discovery, and foreground queue
  adapter. Workflow node ids, checkpoints, LoRAs, ControlNets, references,
  face continuity and video nodes are configuration, never code constants.
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

- `lib/credentials/`: browser-safe credential-mode contracts plus server-only authorization policy. Public testing defaults to `user_byok`; `platform_managed` requires a server kill switch and authenticated allowlist.
- `lib/auth/`, `lib/billing/`, `app/api/auth/phone/`, `app/api/account/`:
  fail-closed phone-verification/session contracts and the formal server credit
  gate. Anonymous users may read published/cached content, but a platform-paid
  cache miss must quote, authenticate, reserve immutable credits, then settle
  or refund. Local SMS is a loopback-only mock and never sends a real message.
- `lib/production/databaseGate.ts`,
  `supabase/migrations/20260729093000_production_identity_billing_gate.sql`:
  production phone identities use stable application UUIDs mapped from a
  phone HMAC. Real SMS and formal credits require the explicit Supabase
  repository configuration plus the exact database-owned gate version.
  Registration, initial grant, administrator credit adjustments, billing
  terminals, and production administrator mutations use allowlisted
  security-definer RPCs so business state and audit commit together.

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
- `pnpm start`: run production server after building.
- `pnpm lint`: Next.js built-in lint.
- `pnpm typecheck`: `tsc --noEmit`.
- `pnpm test:admin`: local repository, admin security, immutable/idempotent
  credit ledger, configuration precedence, masking, audit, and analytics tests.
- `pnpm test:account-billing`: phone normalization/masking, OTP throttling and
  expiry, one-time registration grant, signed user sessions, versioned 2x price
  policy, reserve/settle/refund, admin-grant idempotency/audit, anonymous cache
  access, BYOK exemption, and speculative depth-0 hard rejection.
- `pnpm test:sms-provider`: zero-network Aliyun Dysmsapi V2 adapter coverage,
  including canonical configuration, domestic-number normalization, redacted
  diagnostics, provider failure mapping, pending/sent/invalidation
  compensation, local-mock loopback enforcement, and response/store secrecy.
- `pnpm test:production-db-gate`: static forward-migration/RLS/RPC contract,
  UUID phone-session compatibility, production fail-closed behavior,
  redacted RPC payloads, and atomic/idempotent administrator mutation
  coverage. It does not apply the migration or claim a real Postgres run.
- `pnpm test:creator-providers`: creator-module routing, loopback boundaries,
  dynamic ComfyUI image/video workflows, invalid references, and the P1 rule
  that ComfyUI never accepts speculative-prefetch submissions.
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
- `pnpm test:local-generation`: ComfyUI workflow registry/version rollback,
  transport limits, Host/Origin enforcement, durable GenerationJob recovery,
  idempotency/content fingerprints, cancellation races, LocalMiniDrama adapter,
  and single-flight scheduling.
- `powershell -File scripts/start-aistory-local-stack.ps1`: idempotently start
  or verify the local AIstory 4200 + LocalMiniDrama backend 5679 + frontend
  4107 stack. Use `-StatusOnly` for checks without starting anything. It reuses
  the established `D:\AI-story\logs` / `D:\AI-story\pids` locations and does
  not install an OS startup task.
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
  redacted quote and phone-login requirement; authenticated callers reserve
  integer credits before provider work and then append a settle or refund
  entry. Registration `initial_grant` is globally one-time per account even
  when the price-policy version changes. Browser demo credits are not a formal
  server balance.
- Production phone identity and billing additionally require
  `AISTORY_PRODUCTION_IDENTITY_ENABLED=true`,
  `AISTORY_IDENTITY_REPOSITORY=supabase`,
  `AISTORY_ADMIN_REPOSITORY=supabase`, and
  `AISTORY_DATABASE_GATE_VERSION=20260729093000`, together with the Supabase
  URL and service-role secret. The server verifies the same version through a
  database RPC before sending real SMS or quoting/reserving formal credits.
  An env version alone never proves that a migration was applied. Legacy
  `phone_<hash>` sessions are local-mock-only; production phone cookies carry
  a stable UUID.
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
