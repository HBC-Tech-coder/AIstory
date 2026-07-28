import {
  startSession as startSessionClient,
  requestScene as requestSceneClient,
  visionDecide as visionDecideClient,
  classifyFreeform as classifyFreeformClient,
  requestInsertBeat as requestInsertBeatClient,
} from "@infiplot/engine";
import {
  readStoredModelConfig,
  resolveStoredProviderConfig,
  resolveEngineConfig,
} from "@/lib/clientModelConfig";
import { loadClientTtsConfig } from "@/lib/clientTtsConfig";
import { chat, generateImage } from "@infiplot/ai-client";
import { coerceOrientation } from "@infiplot/types";
import { buildPainterPrompt } from "@/lib/engine/prompts";
import { parseJsonLoose } from "@/lib/engine/jsonParser";
import {
  applyExpressionRewrite,
  canonicalBeats,
  currentStyleCacheKeys,
} from "@/lib/styleHotSwap";
import { isAuthoredAiContinuationAllowed } from "@/lib/case-studies/schema";
import { stripSessionVoices } from "@/lib/persistence/sessionSlim";
import type {
  Character,
  FreeformClassifyRequest,
  FreeformClassifyResponse,
  EngineConfig,
  InsertBeatRequest,
  InsertBeatResponse,
  SceneRequest,
  SceneResponse,
  SceneStreamEvent,
  Session,
  StartRequest,
  StartResponse,
  StyleHotSwapRequest,
  StyleHotSwapResponse,
  TtsProvider,
  VisionRequest,
  VisionResponse,
} from "@infiplot/types";

function getClientConfig(): EngineConfig | null {
  const modelCfg = readStoredModelConfig();
  const ttsCfg = loadClientTtsConfig();
  if (!modelCfg) return null;
  return resolveEngineConfig(modelCfg, ttsCfg);
}

const clientStyleCache = new Map<string, StyleHotSwapResponse>();

function characterReference(character: Character | undefined): string | undefined {
  if (!character) return undefined;
  const stateId = character.currentState?.spriteStateId;
  const stateSprite = stateId
    ? character.spriteStates?.find((sprite) => sprite.id === stateId)
    : undefined;
  const currentSprite = character.spriteStates?.find(
    (sprite) => sprite.id === "current",
  );
  return (
    stateSprite?.portraitUrl ??
    stateSprite?.portraitUuid ??
    currentSprite?.portraitUrl ??
    currentSprite?.portraitUuid ??
    character.basePortraitUrl ??
    character.basePortraitUuid
  );
}

function currentSceneCharacters(
  session: Session,
  beat: import("@infiplot/types").Beat | undefined,
): Character[] {
  const names = new Set(
    (beat?.activeCharacters ?? []).map((character) => character.name),
  );
  if (beat?.speaker && beat.speaker !== "你") names.add(beat.speaker);
  return session.characters.filter((character) => names.has(character.name));
}

function styleReferences(
  session: Session,
  characters: Character[],
): string[] {
  const refs = [
    session.styleReferenceImage,
    ...characters.map(characterReference),
  ].filter((item): item is string => Boolean(item));
  return [...new Set(refs)].slice(0, 4);
}

type RawStyleRewrite = {
  beats?: Array<{
    id?: string;
    narration?: string;
    line?: string;
    lineDelivery?: string;
  }>;
};

async function applyByokStyleHotSwap(
  model: NonNullable<ReturnType<typeof readStoredModelConfig>>,
  req: StyleHotSwapRequest,
): Promise<StyleHotSwapResponse> {
  const entry = req.session.history.find(
    (item) => item.scene.id === req.sceneId,
  );
  if (!entry) throw new Error("当前剧情画面不存在，无法切换风格。");
  const sourceBeats = canonicalBeats(entry.scene);
  const entryBeat = sourceBeats.find(
    (beat) => beat.id === entry.scene.entryBeatId,
  );

  if (req.action === "redraw-current") {
    const image = resolveStoredProviderConfig(model, "image");
    const cacheKey = currentStyleCacheKeys(
      req.session,
      req.sceneId,
      { text: image, image },
    ).imageKey;
    const cached = clientStyleCache.get(cacheKey);
    if (
      cached?.action === "redraw-current" &&
      cached.status === "ready"
    ) {
      return { ...cached, cacheStatus: "hit" };
    }
    const onStageCharacters = currentSceneCharacters(req.session, entryBeat);
    const prompt = buildPainterPrompt(
      entry.scene.scenePrompt,
      req.session.styleGuide,
      onStageCharacters,
      coerceOrientation(req.session.orientation),
    );
    let generated;
    try {
      generated = await generateImage(image, prompt, {
        referenceImages: styleReferences(req.session, onStageCharacters),
        orientation: coerceOrientation(req.session.orientation),
      });
    } catch {
      throw new Error("图片能力调用失败，旧图已保留。请检查图片 API 配置或稍后重试。");
    }
    const response: StyleHotSwapResponse = {
      action: "redraw-current",
      status: "ready",
      imageUrl: generated.imageUrl,
      imageUuid: generated.imageUuid,
      cacheStatus: "write",
    };
    clientStyleCache.set(cacheKey, response);
    return response;
  }

  const authored = req.session.authoredStory;
  if (authored?.authorLocked && !isAuthoredAiContinuationAllowed(authored)) {
    throw new Error("作者锁定章节不允许 AI 改写原稿。");
  }
  const text = resolveStoredProviderConfig(model, "text");
  const cacheKey = currentStyleCacheKeys(
    req.session,
    req.sceneId,
    { text, image: text },
  ).textKey;
  const cached = clientStyleCache.get(cacheKey);
  if (cached?.action === "rewrite-current") {
    return { ...cached, cacheStatus: "hit" };
  }
  let raw: string;
  try {
    raw = await chat(
      text,
      [
        {
          role: "system",
          content:
            "你只负责改写互动小说的表达。严格保持每个 beat 的 id、speaker、事实、人物关系、事件结果、选项语义和状态不变；不得新增、删除或重排 beat。玩家名必须继续写成 {{PLAYER_NAME}}。只返回 JSON：{\"beats\":[{\"id\",\"narration\",\"line\",\"lineDelivery\"}]}。",
        },
        {
          role: "user",
          content: `目标叙事文风：${req.session.narrativeStyle || "自动"}\n原始 canonical beats：${JSON.stringify(
            sourceBeats.map((beat) => ({
              id: beat.id,
              narration: beat.narration,
              speaker: beat.speaker,
              line: beat.line,
              lineDelivery: beat.lineDelivery,
              next: beat.next,
            })),
          )}`,
        },
      ],
      {
        temperature: 0.55,
        tag: "byok-style-hot-swap-rewrite",
        allowServerProxyFallback: false,
      },
    );
  } catch {
    throw new Error("文字能力调用失败，当前文字保持不变。请检查文字 API 配置或稍后重试。");
  }
  const parsed = parseJsonLoose<RawStyleRewrite>(raw);
  const rewritten = (parsed.beats ?? [])
    .filter((beat) => typeof beat.id === "string" && beat.id.length > 0)
    .map((beat) => ({
      id: beat.id!,
      narration: beat.narration,
      line: beat.line,
      lineDelivery: beat.lineDelivery,
    }));
  const response: StyleHotSwapResponse = {
    action: "rewrite-current",
    status: "ready",
    beats: applyExpressionRewrite(sourceBeats, rewritten),
    cacheStatus: "write",
  };
  clientStyleCache.set(cacheKey, response);
  return response;
}

export class AuthRequiredError extends Error {
  readonly quote?: {
    estimatedCredits: number;
    pricePolicyVersion: string;
    modalities: string[];
  };

  constructor(
    message = "此操作将使用平台积分，请先完成手机号验证码登录。",
    quote?: AuthRequiredError["quote"],
  ) {
    super(message);
    this.name = "AuthRequiredError";
    this.quote = quote;
  }
}

type ErrorPayload = {
  error?: string;
  quote?: AuthRequiredError["quote"];
};

async function readErrorPayload(response: Response): Promise<ErrorPayload> {
  try {
    return await response.json() as ErrorPayload;
  } catch {
    return {};
  }
}

function requestIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `generation:${crypto.randomUUID()}`;
  }
  return `generation:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": requestIdempotencyKey(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await readErrorPayload(res);
    if (res.status === 401) {
      throw new AuthRequiredError(data.error, data.quote);
    }
    let message = `HTTP ${res.status}`;
    if (data.error) message = data.error;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// GET variant of postJson — same 401 → AuthRequiredError mapping. Used by
// getTtsProvider (a tiny config probe, no body).
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "GET" });
  if (!res.ok) {
    if (res.status === 401) throw new AuthRequiredError();
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── FOT reduction helpers (server-fallback path only) ─────────────────
// The server-fallback POSTs send the whole Session over the wire. Voice
// data is bulky (~160KB/character via referenceAudioBase64) and the
// scene-generation / vision / classify pipelines never need it — voices
// are only consumed by /api/beat-audio, which receives them directly, not
// via the session. So strip voices before transport. The stripping rule itself
// lives in lib/persistence/sessionSlim.ts (shared with the local-store layer so
// "what counts as voice" has one definition).
function stripVoicesForTransport(session: Session): Session {
  return stripSessionVoices(session);
}

// The server strips voice from already-known characters before responding
// (see /api/scene stripKnownVoices and /api/insert-beat's blanket strip) to
// save bandwidth, so only NEW characters carry voice in the response. For
// existing characters, re-attach the voice the client already holds locally.
function mergeCharactersPreserveVoice(
  local: Character[],
  remote: Character[],
): Character[] {
  const localByName = new Map(local.map((c) => [c.name, c]));
  return remote.map((c) => {
    const prev = localByName.get(c.name);
    if (!prev) return c;
    return { ...c, voice: c.voice ?? prev.voice };
  });
}

// ── SSE consumption (server-fallback path) ───────────────────────────
// When an `emit` callback is provided, the server-fallback path requests
// SSE instead of JSON so the caller can render progressive events
// (plan → beat → background → voice → done). The final "done" event
// carries the complete response payload.

async function fetchSSE<T>(
  path: string,
  body: unknown,
  emit?: (event: SceneStreamEvent) => void,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": requestIdempotencyKey(),
      ...(emit ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await readErrorPayload(res);
    if (res.status === 401) {
      throw new AuthRequiredError(data.error, data.quote);
    }
    let message = `HTTP ${res.status}`;
    if (data.error) message = data.error;
    throw new Error(message);
  }

  if (!emit || !res.headers.get("content-type")?.includes("text/event-stream")) {
    return res.json() as Promise<T>;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;

    for (const part of parts) {
      if (!part.trim()) continue;
      const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      let event;
      try {
        event = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      if (event.type === "done") {
        result = event.response as T;
      } else if (event.type === "error") {
        throw new Error(event.message || "Scene generation failed");
      } else {
        emit(event as SceneStreamEvent);
      }
    }
  }

  if (!result) throw new Error("SSE stream ended without a done event");
  return result;
}

// ── Unified entry points ───────────────────────────────────────────────
// When the browser has a BYO model config in localStorage, these call the
// client-side engine directly (talking to providers from the browser).
// Otherwise they fall back to the server-side API routes, which read
// environment variables — useful for Vercel deploys that already supply keys.

// Probe the server's TTS provider so fetchBeatAudio can shape its request body
// (skip the ~220KB Xiaomi reference audio when the server runs StepFun).
//
// BYO precedence: when the browser has a client model config (BYO mode),
// voice synthesis always runs locally against the user's own Xiaomi key, so
// the server provider is irrelevant — return "xiaomi" synchronously without a
// round-trip. Non-BYO → GET /api/tts-provider. Errors degrade to null (the
// caller then sends voice fields defensively and the server normalizes).
export async function getTtsProvider(): Promise<TtsProvider> {
  if (loadClientTtsConfig()) return "xiaomi";
  try {
    const data = await getJson<{ provider: TtsProvider }>("/api/tts-provider");
    return data.provider;
  } catch (e) {
    // AuthRequiredError (401) propagates so the caller's handleAuthError can
    // surface the login modal; other errors (network, 5xx) → null = unknown,
    // and fetchBeatAudio falls back to sending everything + server normalizes.
    if (e instanceof AuthRequiredError) throw e;
    console.warn("[getTtsProvider] probe failed, assuming unknown:", e);
    return null;
  }
}

export async function startSession(
  req: StartRequest,
  emit?: (event: SceneStreamEvent) => void,
): Promise<StartResponse> {
  const config = getClientConfig();
  if (config) {
    return startSessionClient(config, req, emit);
  }
  return fetchSSE<StartResponse>("/api/start", {
    ...req,
    credentialMode: "platform_managed",
  }, emit);
}

export async function requestScene(
  req: SceneRequest,
  emit?: (event: SceneStreamEvent) => void,
): Promise<SceneResponse> {
  const config = getClientConfig();
  if (config) {
    return requestSceneClient(config, req, emit);
  }
  const data = await fetchSSE<SceneResponse>("/api/scene", {
    ...req,
    credentialMode: "platform_managed",
    session: stripVoicesForTransport(req.session),
  }, emit);
  // Server stripped known-character voices for bandwidth — re-attach the
  // voices we already hold so fetchBeatAudio can synth them.
  data.characters = mergeCharactersPreserveVoice(req.session.characters, data.characters);
  return data;
}

/**
 * Raises a queued server-side prediction ahead of background work. Reuses the
 * same cache key/single-flight promise and never starts a second generation.
 * BYO model mode has no server queue, so promotion is a no-op there.
 */
export async function promoteSpeculativeBranch(req: SceneRequest): Promise<void> {
  if (readStoredModelConfig()) return;
  try {
    await postJson<{ promoted: boolean }>("/api/speculative-branch", {
      ...req,
      speculation: req.speculation
        ? { ...req.speculation, mode: "foreground" as const }
        : undefined,
      session: stripVoicesForTransport(req.session),
    });
  } catch {
    // Promotion is an optimization. The original prediction remains valid.
  }
}

export async function cancelSpeculativeBranch(req: SceneRequest): Promise<void> {
  if (readStoredModelConfig()) return;
  try {
    await postJson<{ cancelled: boolean }>("/api/speculative-branch", {
      ...req,
      command: "cancel",
      speculation: req.speculation
        ? { ...req.speculation, mode: "foreground" as const }
        : undefined,
      session: stripVoicesForTransport(req.session),
    });
  } catch {
    // In-flight work may finish into the old revisioned TTL cache, which is safe.
  }
}

export async function applyStyleHotSwap(
  req: StyleHotSwapRequest,
): Promise<StyleHotSwapResponse> {
  const model = readStoredModelConfig();
  if (model) {
    return applyByokStyleHotSwap(model, req);
  }
  return postJson<StyleHotSwapResponse>("/api/style-hot-swap", {
    ...req,
    credentialMode: "platform_managed",
    session: stripVoicesForTransport(req.session),
  });
}

export async function visionDecide(req: VisionRequest): Promise<VisionResponse> {
  const model = readStoredModelConfig();
  if (model) {
    const config = resolveEngineConfig(model, loadClientTtsConfig());
    config.vision = resolveStoredProviderConfig(model, "vision");
    return visionDecideClient(config, req);
  }
  return postJson<VisionResponse>("/api/vision", {
    ...req,
    credentialMode: "platform_managed",
    session: stripVoicesForTransport(req.session),
  });
}

export async function classifyFreeform(
  req: FreeformClassifyRequest,
): Promise<FreeformClassifyResponse> {
  const config = getClientConfig();
  if (config) {
    return classifyFreeformClient(config, req);
  }
  return postJson<FreeformClassifyResponse>("/api/classify-freeform", {
    ...req,
    credentialMode: "platform_managed",
    session: stripVoicesForTransport(req.session),
  });
}

export async function requestInsertBeat(
  req: InsertBeatRequest,
): Promise<InsertBeatResponse> {
  const config = getClientConfig();
  if (config) {
    return requestInsertBeatClient(config, req);
  }
  const data = await postJson<InsertBeatResponse>("/api/insert-beat", {
    ...req,
    credentialMode: "platform_managed",
    session: stripVoicesForTransport(req.session),
  });
  // /api/insert-beat strips voice from ALL characters before responding —
  // re-attach every voice the client already holds so audio keeps working.
  data.characters = mergeCharactersPreserveVoice(req.session.characters, data.characters);
  return data;
}
