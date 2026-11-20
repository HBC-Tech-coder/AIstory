"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PlayCanvas,
  type LoadingProgress,
  type Phase,
} from "@/components/PlayCanvas";
import type { VideoStoryCompletion } from "@/components/VideoStoryPlayer";
import type { DialogueHistoryItem } from "@/components/DialogueHistoryModal";
import {
  StyleSwitcherDrawer,
  type StyleSelection,
} from "@/components/StyleSwitcherDrawer";
import { readBrowserByokReady } from "@/components/UsageDisclosureNote";
import type { GalleryDoc, GalleryScene } from "@/app/[locale]/gallery/page";
import {
  SettingsModal,
  readStoredBranchPrefetchDepth,
  readStoredPlayerName,
  readStoredVisionClick,
} from "@/components/SettingsModal";
import { annotateClick } from "@/lib/annotateClient";
import { loadClientTtsConfig } from "@/lib/clientTtsConfig";
import { collectBeatAudioForExport } from "@/lib/exportAudio";
import {
  hasPersonalizationSlot,
  renderPersonalizedText,
} from "@/lib/personalization";
import { saveStory, loadStorySession } from "@/lib/clientStoryPersistence";
import { PRESETS } from "@/lib/presets";
import {
  STORY_SHARE_STORAGE_KEY,
  createStoryShareDoc,
  parseStoryShareDoc,
  storyShareFilename,
} from "@/lib/storyShare";
import {
  STORY_IMPORT_RECOVERY_COPY,
  readStoryImportDoc,
  type StoryImportIssue,
} from "@/lib/storyImportRecovery";
import { provisionVoice, synthesize } from "@infiplot/tts-client";
import {
  startSession,
  requestScene as requestSceneUnsafe,
  visionDecide,
  requestInsertBeat,
  getTtsProvider,
  promoteSpeculativeBranch,
  cancelSpeculativeBranch,
  applyStyleHotSwap,
  AuthRequiredError,
  isPlatformGenerationUnavailable,
} from "@/lib/engineClient";
import {
  DEFAULT_BRANCH_PREFETCH_BUDGET,
  shouldSchedulePrefetch,
} from "@/lib/speculativeBranch";
import { applyStyleToSession } from "@/lib/styleHotSwap";
import {
  buildUsageDisclosure,
  formatUsageDisclosure,
} from "@/lib/usageDisclosure";
import {
  activateTimelineBranch,
  forkTimelineAtDecision,
  migrateLegacyDecisions,
  recordTimelineDecision,
  updateActiveTimelineSnapshot,
} from "@/lib/timeline";
import type {
  Beat,
  BeatChoice,
  BranchPrefetchDepth,
  Character,
  CharacterVoice,
  CharacterVoiceProfile,
  Orientation,
  Scene,
  SceneExit,
  SceneResponse,
  SceneRequest,
  Session,
  SceneStreamEvent,
  StartResponse,
  TimelineDecision,
  TtsConfig,
  TtsProvider,
} from "@infiplot/types";
import { coerceOrientation } from "@infiplot/types";
import { track } from "@/lib/analytics";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { consumeResumeSnapshot } from "@/lib/authResume";
import {
  playIssueRecoveryCopy,
  readCustomPlayDraft,
} from "@/lib/playIssueRecovery";
import {
  AuthModal,
  type AuthRequirement,
} from "@/components/AuthModal";
import { UserChip } from "@/components/UserChip";
import { useI18n } from "@/lib/i18n/client";
import { useLocalePath } from "@/lib/i18n/hooks";
import { StoryCharacterModal } from "@/components/StoryCharacterModal";
import {
  sanitizeCharacterName,
  withCharacterIdentity,
} from "@/lib/character-names";
import {
  coerceSceneMedia,
  sceneHasRenderableMedia,
  scenePosterUrl,
  sceneUsesEmbeddedAudio,
  videoAllowsSceneInteraction,
} from "@/lib/sceneMedia";
import {
  matchVoiceProfile,
  voiceDescriptionFromProfile,
} from "@/lib/voiceProfiles";
import { SteamCompletionCta } from "@/components/SteamCompletionCta";
import { SteamDesktopBridge } from "@/components/SteamDesktopBridge";
import { shouldShowSteamCompletionCta } from "@/lib/steam/contracts";
import { SharedStoryPublishPanel } from "@/components/SharedStoryPublishPanel";
import {
  findAuthoredNode,
  isAuthoredAiContinuationAllowed,
  transitionAuthoredStorySession,
  type CaseStudyPublishedBundle,
} from "@/lib/case-studies/schema";
import { isAuthoredChoiceAvailable } from "@/lib/video-stories/runtime";
import {
  buildPlayEndOfDemoNotice,
  buildPlayFirstLoadErrorCopy,
  buildPlaySceneErrorCopy,
  detectPlayTerminal,
  PLAY_FIRST_LOAD_DEMO_LABEL,
  PLAY_FIRST_LOAD_SETTINGS_LABEL,
  resolveSafeReturn,
  STORY_ARCHIVE_EMPTY,
  STORY_ARCHIVE_EXPORT_DONE,
  STORY_ARCHIVE_EXPORT_LABEL,
  STORY_ARCHIVE_EXPORT_TITLE,
  STORY_ARCHIVE_PACKING,
} from "@/lib/playerReviewPolicy";

// Author-locked scenes may stay interactive only at their authored boundary.
// Keep this meaning in one place so UI gating and request guards cannot drift.
function isAuthorLockedScene(session: Session | null | undefined): boolean {
  const runtime = session?.authoredStory;
  return Boolean(
    runtime?.authorLocked && !isAuthoredAiContinuationAllowed(runtime),
  );
}

async function requestScene(request: SceneRequest): Promise<SceneResponse> {
  if (isAuthorLockedScene(request.session)) {
    throw new Error("作者锁定章节尚未到达 AI 续写边界");
  }
  return requestSceneUnsafe(request);
}

const MUTED_STORAGE_KEY = "infiplot:muted";
// Legacy one-shot OAuth resume key. New phone login remains in-page and does
// not write it; consuming old snapshots preserves upgrade compatibility.
const PLAY_RESUME_KEY = "infiplot:play-resume";

// Serializable legacy action restored from a pre-phone-login snapshot.
type PendingResumeAction =
  | { kind: "choice"; choice: BeatChoice }
  | { kind: "freeform"; text: string }
  | { kind: "background-click"; x: number; y: number };

// Shape written to sessionStorage[PLAY_RESUME_KEY]. `imageOriginalUrl` is the
// legacy remote poster URL (never a blob: URL). Video-only scenes may omit it;
// restorePlayResume then waits for video metadata instead of image decode.
type PlayResumeSnapshot = {
  session: Session;
  beatId: string;
  visitedBeats: string[];
  orientation: Orientation;
  imageOriginalUrl?: string;
  pendingAction?: PendingResumeAction;
};

// Consecutive silent (no-audio) beats before we surface the BYO-key nudge to a
// non-BYO, unmuted player. Set high enough that one transient miss won't trip
// it, low enough to catch a scene that's clearly being rate-limited.
const SILENCE_NUDGE_THRESHOLD = 3;

// Mobile-portrait users get a 9:16 scene image painted for them; everyone else
// (desktop, tablet, mobile-landscape) keeps the 16:9 landscape image. Only a
// touch device (coarse pointer) held upright counts as "portrait" — a mouse
// device is always landscape. Detected once and locked for the whole session.
function detectOrientation(): Orientation {
  if (typeof window === "undefined") return "landscape";
  const portrait = window.matchMedia("(orientation: portrait)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return portrait && coarse ? "portrait" : "landscape";
}

function durableSessionFingerprint(session: Session): string {
  const history = session.history ?? [];
  const lastBeatCount = history[history.length - 1]?.scene?.beats?.length ?? 0;
  const aliasRevision = session.characters
    .map((character) => `${character.characterId || character.name}:${character.alias || ""}`)
    .join("|");
  const authoredRevision = session.authoredStory
    ? `${session.authoredStory.currentNodeId}:${session.authoredStory.currentBeatId}:${JSON.stringify(session.authoredStory.variables)}`
    : "";
  return `${history.length}:${lastBeatCount}:${session.playerName ?? ""}:${session.timeline?.activeBranchId || ""}:${aliasRevision}:${authoredRevision}`;
}

type LoadingTextKey =
  | "init"
  | "saved"
  | "template"
  | "cache"
  | "cacheHit"
  | "plan"
  | "beat"
  | "background"
  | "voice"
  | "choices"
  | "image"
  | "ready"
  | "error";

const LOADING_TEXT: Record<string, Record<LoadingTextKey, string>> = {
  "zh-CN": {
    init: "正在理解你的故事",
    saved: "正在载入上次进度",
    template: "正在载入精选剧本",
    cache: "正在检查故事缓存",
    cacheHit: "命中缓存，正在载入画面",
    plan: "正在规划剧情和角色",
    beat: "剧情文本正在成形",
    background: "首帧画面已生成，正在加载",
    voice: "正在准备角色声音",
    choices: "正在整理互动选项",
    image: "正在加载首帧图片",
    ready: "准备进入第一幕",
    error: "生成遇到问题",
  },
  en: {
    init: "Understanding your story",
    saved: "Loading saved progress",
    template: "Loading featured story",
    cache: "Checking story cache",
    cacheHit: "Cache hit, loading the first frame",
    plan: "Planning plot and characters",
    beat: "Writing the opening beats",
    background: "First image generated, loading",
    voice: "Preparing character voices",
    choices: "Preparing choices",
    image: "Loading first image",
    ready: "Entering scene one",
    error: "Generation hit a problem",
  },
  ja: {
    init: "物語を読み解いています",
    saved: "保存済みの進行を読み込み中",
    template: "おすすめ作品を読み込み中",
    cache: "物語キャッシュを確認中",
    cacheHit: "キャッシュを読み込み中",
    plan: "物語とキャラクターを構成中",
    beat: "冒頭のビートを生成中",
    background: "最初の画像を読み込み中",
    voice: "キャラクターボイスを準備中",
    choices: "選択肢を準備中",
    image: "最初の画像を読み込み中",
    ready: "第一幕へ移動中",
    error: "生成で問題が発生しました",
  },
};

function loadingLabel(locale: string, key: LoadingTextKey): string {
  return LOADING_TEXT[locale]?.[key] ?? LOADING_TEXT["zh-CN"]![key];
}

function loadingProgress(
  locale: string,
  percent: number,
  key: LoadingTextKey,
  detail?: string,
): LoadingProgress {
  return {
    percent,
    label: loadingLabel(locale, key),
    detail,
  };
}

function mergeLoadingProgress(
  previous: LoadingProgress,
  next: LoadingProgress,
): LoadingProgress {
  if (next.percent >= previous.percent) {
    return { ...next, detail: next.detail ?? previous.detail };
  }
  return { ...previous, percent: Math.max(previous.percent, next.percent) };
}

function progressForSceneEvent(
  event: SceneStreamEvent,
  locale: string,
): LoadingProgress | null {
  if (event.type === "cache") {
    return event.status === "hit"
      ? loadingProgress(locale, 82, "cacheHit")
      : loadingProgress(locale, 18, "cache");
  }
  if (event.type === "plan") return loadingProgress(locale, 36, "plan");
  if (event.type === "beat") return loadingProgress(locale, 52, "beat");
  if (event.type === "background") return loadingProgress(locale, 78, "background");
  if (event.type === "voice") return loadingProgress(locale, 88, "voice");
  if (event.type === "choices") return loadingProgress(locale, 93, "choices");
  return null;
}

// Runs before the browser paints (so it can correct first-frame state without a
// visible flash), but useLayoutEffect warns when called during SSR. PlayInner
// only ever renders on the client (/play prerenders the Suspense fallback), yet
// fall back to useEffect on the server anyway to keep the warning out.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Cap how long we wait for the browser to download + decode a scene image
// before giving up and rendering anyway. Runware's CDN is usually <2s for a
// 1792×1024 PNG, but over slow links / VPN / strict corp networks the same
// download can stretch to 10-20s. The previous 8s ceiling fired in that
// window, and because the rendered <img> has no aspect-ratio occupation, the
// layout collapsed to a one-pixel-tall sliver until the bytes actually
// finished arriving — "等了很久 → 一根线 → 突然出图" of the original report.
// 20s + the <img> aspect-video fallback together remove that failure mode.
const IMAGE_PRELOAD_TIMEOUT_MS = 20000;

// After blob/preload resolves the <img> still needs to decode the bitmap.
// This gate keeps the "transitioning" overlay visible until decode fires,
// so the user never sees progressive paint or a blank flash. 3s is generous
// (decode is typically <100ms for a locally-held blob).
const IMAGE_READY_TIMEOUT_MS = 3000;

// ──────────────────────────────────────────────────────────────────────
//  Two ways an <img> gets its pixels, picked per-URL by shouldProxy():
//
//  1. DIRECT (default — no proxy configured): preload the URL with an
//     Image() + decode() so the HTTP cache is warm and the bitmap decoded
//     before React commits, then hand the ORIGINAL URL to <img>. This is the
//     long-standing behavior; deployers who set no env var get exactly this
//     and are completely unaffected by the proxy machinery below.
//
//  2. PROXY (opt-in — NEXT_PUBLIC_IMAGE_PROXY_URL set, host allow-listed):
//     fetch the bytes through the Cloudflare Worker (which adds CORS and
//     serves over stable HTTP/2), await the FULL body via .blob(), materialize
//     a blob: URL over that local copy, and hand THAT to <img>. The <img>
//     never sees a network-backed src, so there's no "字节还在路上" middle
//     state and no progressive paint.
//     Why it matters: Chrome's direct fetch of im.runware.ai sometimes hits
//     ERR_QUIC_PROTOCOL_ERROR mid-stream, leaving partial PNG bytes that
//     paint row-by-row. The Worker re-fetches server-to-server (no QUIC
//     fragility) and serves over HTTP/2 — atomic and reliable. Trade-off:
//     callers MUST revoke the blob URL when swapping it out (revokeBlobUrlFor)
//     or the bytes leak in the JS heap.
//
//  Data URIs (MOCK_IMAGE mode) are already local; passed through unchanged
//  on both paths. blobUrlCache is keyed by the ORIGINAL URL either way.
// ──────────────────────────────────────────────────────────────────────

// Direct-path preload: decode the URL in memory before committing to React
// state, so when the <img> mounts the cache is warm and first paint is
// instant. Errors / timeouts resolve quietly — better a broken <img> than a
// hung play loop. (im.runware.ai sends no CORS header, so we can't fetch()
// its bytes here; warming + decoding is the most the direct path can do.)
function preloadImage(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const img = new Image();
    // Single exit: clear the timeout and resolve. resolve() is idempotent, so
    // whichever path fires first (load+decode, error, timeout) wins.
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    // Armed across BOTH network load and decode, so a hung decode still
    // resolves quietly — better a broken <img> than a stuck play loop.
    const timer = setTimeout(done, IMAGE_PRELOAD_TIMEOUT_MS);
    img.onload = () => {
      // .decode() forces the bitmap to be fully decoded before we proceed —
      // without it, a slow decode could still cause a flash on first paint.
      img.decode().then(done, done);
    };
    img.onerror = done;
    img.src = url;
  });
}

// Opt-in Cloudflare Workers proxy (deploy your own — see the link in README).
// Inlined by Next.js at build time. Empty / unset → no proxy → every URL takes
// the direct path above, exactly as if this feature didn't exist.
const IMAGE_PROXY_BASE = (
  process.env.NEXT_PUBLIC_IMAGE_PROXY_URL ?? ""
).replace(/\/$/, "");

// Hostnames eligible for the proxy. Default: Runware's CDN only. Deployers who
// point IMAGE_BASE_URL at another provider can opt that provider's image host
// in via NEXT_PUBLIC_IMAGE_PROXY_ALLOWED_HOSTS (comma-separated). Inlined at
// build time. Anything not on this list stays on the direct path.
const IMAGE_PROXY_ALLOWED_HOSTS = (
  process.env.NEXT_PUBLIC_IMAGE_PROXY_ALLOWED_HOSTS ?? "im.runware.ai"
)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Route a URL through the proxy only when a proxy is configured AND it's a
// remote http(s) image on an allow-listed host. data: URIs (MOCK_IMAGE) are
// already local; malformed URLs and any other origin fall through to direct.
function shouldProxy(originalUrl: string): boolean {
  if (!IMAGE_PROXY_BASE) return false;
  if (originalUrl.startsWith("data:")) return false;
  try {
    const { protocol, hostname } = new URL(originalUrl);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return IMAGE_PROXY_ALLOWED_HOSTS.includes(hostname.toLowerCase());
  } catch {
    return false;
  }
}

function proxiedImageUrl(originalUrl: string): string {
  return `${IMAGE_PROXY_BASE}/?url=${encodeURIComponent(originalUrl)}`;
}

async function fetchImageAsBlobUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;

  // Direct path (default): warm the cache + decode, hand back the original
  // URL. No fetch() — im.runware.ai has no CORS, so fetch().blob() would throw.
  if (!shouldProxy(url)) {
    await preloadImage(url);
    return url;
  }

  // Proxy path (opt-in): fetch through the Worker and materialize a blob: URL.
  // On error / timeout fall back to the original URL so <img> still tries
  // (possible progressive paint — same as the direct path, never worse).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_PRELOAD_TIMEOUT_MS);
  try {
    const r = await fetch(proxiedImageUrl(url), { signal: ctrl.signal });
    if (!r.ok) return url;
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

// Module-level cache so speculative prefetches and the eventual commit share
// the same in-flight fetch — no double-download per scene. Keyed by the
// ORIGINAL CDN URL (the blob: URL it resolves to is the value). Persists for
// the page's lifetime; entries are explicitly revoked when the scene swaps.
const blobUrlCache = new Map<string, Promise<string>>();

function getOrCreateBlobUrl(originalUrl: string): Promise<string> {
  let p = blobUrlCache.get(originalUrl);
  if (!p) {
    p = fetchImageAsBlobUrl(originalUrl);
    blobUrlCache.set(originalUrl, p);
  }
  return p;
}

function revokeBlobUrlFor(originalUrl: string): void {
  const p = blobUrlCache.get(originalUrl);
  if (!p) return;
  blobUrlCache.delete(originalUrl);
  p.then((u) => {
    if (u.startsWith("blob:")) URL.revokeObjectURL(u);
  }).catch(() => {});
}

// ──────────────────────────────────────────────────────────────────────
//  Prefetch pool — speculative SceneResponses keyed by choice path.
//
//  Key format: "C1" → reached by choosing C1 from current scene.
//              "C1/C2" → after C1, then C2 (recursive must-pass prefetch).
//
//  When the player picks a change-scene choice, we keep that key's
//  descendants (re-rooted) and abort the rest.
// ──────────────────────────────────────────────────────────────────────

type PrefetchEntry = {
  promise: Promise<SceneResponse>;
  abort: AbortController;
  request: SceneRequest;
};

type PrefetchBudget = {
  used: number;
  max: number;
};

type ScenePathStep = {
  fromScene: Scene;
  fromVisitedBeats: string[];
  exit: { choiceId: string; label: string; nextSceneSeed: string };
};

function buildDialogueHistory(
  session: Session | null,
): DialogueHistoryItem[] {
  if (!session) return [];

  return session.history.flatMap((entry, sceneIndex) => {
    const beatsById = new Map(entry.scene.beats.map((b) => [b.id, b]));
    const visitedBeatIds = entry.visitedBeatIds;

    return visitedBeatIds.flatMap((beatId, beatIndex) => {
      const beat = beatsById.get(beatId);
      if (!beat) return [];

      const nextVisitedBeatId = visitedBeatIds[beatIndex + 1];
      const choice =
        beat.next.type === "choice"
          ? beat.next.choices.find((c) => {
              if (c.effect.kind === "advance-beat") {
                return c.effect.targetBeatId === nextVisitedBeatId;
              }
              return (
                beatIndex === visitedBeatIds.length - 1 &&
                entry.exit?.kind === "choice" &&
                c.id === entry.exit.choiceId
              );
            })
          : undefined;
      const freeformAction =
        beatIndex === visitedBeatIds.length - 1 &&
        entry.exit?.kind === "freeform"
          ? entry.exit.action
          : undefined;

      const body = beat.speaker ? beat.line : beat.narration;
      const narration = beat.speaker ? beat.narration : undefined;
      if (!body && !narration && !choice && !freeformAction) return [];

      return [
        {
          id: `${sceneIndex}:${beatId}:${beatIndex}`,
          sceneIndex: sceneIndex + 1,
          speaker: beat.speaker,
          body,
          narration,
          selectedChoice: choice?.label,
          freeformAction,
        },
      ];
    });
  });
}

function pathKey(steps: ScenePathStep[]): string {
  return steps.map((s) => s.exit.choiceId).join("/");
}

function buildSpeculativeSession(
  base: Session,
  steps: ScenePathStep[],
): Session {
  // Drop base's current (last) entry and re-add each step's `fromScene` with
  // its exit set. Final result has `history.length = base.length - 1 + steps.length`.
  const newHistory = [...base.history.slice(0, -1)];
  for (const step of steps) {
    newHistory.push({
      scene: step.fromScene,
      visitedBeatIds: step.fromVisitedBeats,
      exit: {
        kind: "choice",
        choiceId: step.exit.choiceId,
        label: step.exit.label,
        nextSceneSeed: step.exit.nextSceneSeed,
      },
    });
  }
  return { ...base, history: newHistory };
}

function findAllChangeSceneChoices(scene: Scene): BeatChoice[] {
  const result: BeatChoice[] = [];
  const seen = new Set<string>();
  for (const b of scene.beats) {
    if (b.next.type === "choice") {
      for (const c of b.next.choices) {
        if (c.effect.kind === "change-scene" && !seen.has(c.id)) {
          seen.add(c.id);
          result.push(c);
        }
      }
    }
  }
  return result;
}

function prefetchScenePath(
  pool: Map<string, PrefetchEntry>,
  // Resolved-prefetch sink for the gallery export. Every successful resolve
  // is recorded here keyed by `${parentSceneId}:${choiceId}` so the gallery
  // can let the player click any choice whose alternate the AI already paid
  // to generate — even ones that were later abandoned mid-play because the
  // player took a different branch. Survives `consumeChoice`'s abort sweep:
  // a prefetch that's already resolved when its parent choice is abandoned
  // still leaves the result here.
  resolvedSink: Map<string, Scene>,
  baseSession: Session,
  steps: ScenePathStep[],
  depth: number,
  clientTts: boolean,
  requestedDepth: BranchPrefetchDepth,
  budget: PrefetchBudget,
): void {
  if (
    !shouldSchedulePrefetch(
      depth,
      requestedDepth,
      2,
      budget.used,
      budget.max,
    )
  ) {
    return;
  }
  const key = pathKey(steps);
  if (pool.has(key)) return;
  const branchOrdinal = budget.used++;

  const specSession = buildSpeculativeSession(baseSession, steps);
  const abort = new AbortController();
  const prefetchT0 = Date.now();
  const sceneRequest: SceneRequest = {
    session: specSession,
    clientTts,
    speculation: {
      mode: "prefetch",
      requestedDepth,
      branchOrdinal,
      includeAudio: false,
    },
  };
  const promise = (async () => {
    const data = await requestScene(sceneRequest);
    if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");

    // Record this resolved alternate for the gallery export. Key is
    // (parent scene id at the choice point) : (choice id). Includes the
    // CDN imageUrl on the Scene so the gallery has everything it needs to
    // render without any further info from the engine.
    const lastStep = steps[steps.length - 1]!;
    resolvedSink.set(`${lastStep.fromScene.id}:${lastStep.exit.choiceId}`, {
      ...data.scene,
      imageUrl: data.imageUrl,
    });

    // Kick off the blob fetch for this URL so when the player eventually
    // picks this choice, transitioning is a no-op cache lookup instead of a
    // fresh CDN download. Don't await — let it run in the background; the
    // transition path awaits the same cached promise via getOrCreateBlobUrl.
    void getOrCreateBlobUrl(data.imageUrl);

    // Recursively schedule every direct child within the user depth and the
    // shared branch budget. The server repeats both cap/budget checks.
    if (depth + 1 < requestedDepth) {
      const children = findAllChangeSceneChoices(data.scene);
      for (const child of children) {
        if (child.effect.kind !== "change-scene") continue;
        const nextStep: ScenePathStep = {
          fromScene: data.scene,
          fromVisitedBeats: [data.scene.entryBeatId],
          exit: {
            choiceId: child.id,
            label: child.label,
            nextSceneSeed: child.effect.nextSceneSeed,
          },
        };
        // Carry forward the registry that the parent prefetch result already
        // settled (it may include characters introduced by the intermediate
        // scene). Without this, the L2+ prefetch starts from the original
        // base.characters and a later transition through this survivor would
        // silently drop voices the player has already heard.
        const carriedBase: Session = {
          ...baseSession,
          characters: data.characters,
          storyState: data.storyState,
        };
        prefetchScenePath(
          pool,
          resolvedSink,
          carriedBase,
          [...steps, nextStep],
          depth + 1,
          clientTts,
          requestedDepth,
          budget,
        );
      }
    }

    return data;
  })();

  promise.catch((e) => {
    if ((e as { name?: string }).name === "AbortError") return;
    const { kind, http_status } = classifyError(e);
    track("play_error", {
      source: "prefetch" as const,
      kind,
      http_status,
      orientation: coerceOrientation(baseSession.orientation),
      connection: getConnectionType(),
      was_hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      scene_index: baseSession.history.length,
      elapsed_bucket: elapsedBucket(prefetchT0),
    });
  });
  pool.set(key, { promise, abort, request: sceneRequest });
}

function consumeChoice(
  pool: Map<string, PrefetchEntry>,
  choiceId: string,
): PrefetchEntry | undefined {
  const my = pool.get(choiceId);
  const survivors = new Map<string, PrefetchEntry>();
  for (const [key, entry] of pool) {
    if (key === choiceId) continue;
    if (key.startsWith(choiceId + "/")) {
      survivors.set(key.slice(choiceId.length + 1), entry);
    }
  }
  pool.clear();
  for (const [k, e] of survivors) pool.set(k, e);
  return my;
}

function clearPool(pool: Map<string, PrefetchEntry>): void {
  for (const e of pool.values()) e.abort.abort();
  pool.clear();
}

// ──────────────────────────────────────────────────────────────────────
//  BYO voice resolution (client-direct Xiaomi TTS).
//
//  In BYO mode the server skips all TTS (clientTts:true), so the browser must
//  obtain each speaker's reference audio itself. `cache` is keyed by character
//  NAME and persists for the whole session, so a voice locked in on a
//  character's first speaking beat stays identical across every later scene —
//  even though /api/scene returns its characters without `.voice`. Storing the
//  in-flight Promise (not the resolved value) dedupes the burst of concurrent
//  beats by the same speaker into ONE voicedesign call, which matters because
//  Xiaomi rate-limits voicedesign hard.
// ──────────────────────────────────────────────────────────────────────

async function resolveByoVoice(
  cache: Map<string, Promise<CharacterVoice>>,
  cfg: TtsConfig,
  speaker: Character,
): Promise<CharacterVoice | null> {
  const cached = cache.get(speaker.name);
  if (cached) return cached;
  // Prebaked cards ship baked reference audio — reuse it directly (cross-key
  // synth with the user's key works), keeping the prebaked voice identical.
  if (speaker.voice) {
    const ready = Promise.resolve(speaker.voice);
    cache.set(speaker.name, ready);
    return ready;
  }
  if (!speaker.voiceDescription) return null;
  const p = provisionVoice(cfg, speaker.voiceDescription, speaker.name, {
    voiceProfile: speaker.voiceProfile,
    stepfunVoiceId: speaker.stepfunVoiceId,
  });
  cache.set(speaker.name, p);
  try {
    return await p;
  } catch (e) {
    cache.delete(speaker.name); // failed provision — let a later beat retry
    throw e;
  }
}

// ── Error observability helpers ────────────────────────────────────────

type ErrorSource = "scene" | "start" | "vision" | "insert_beat" | "freeform" | "prefetch";

function classifyError(
  e: unknown,
  res?: Response,
): { kind: "network" | "timeout" | "http_5xx" | "http_4xx" | "abort" | "unknown"; http_status: number } {
  if (res) {
    const s = res.status;
    if (s >= 500) return { kind: "http_5xx", http_status: s };
    if (s >= 400) return { kind: "http_4xx", http_status: s };
  }
  if (e instanceof Error) {
    if (e.name === "AbortError") return { kind: "abort", http_status: 0 };
    if (e instanceof TypeError && /fetch|network/i.test(e.message))
      return { kind: "network", http_status: 0 };
    if (/timeout/i.test(e.message)) return { kind: "timeout", http_status: 0 };
    const httpMatch = e.message.match(/^HTTP (\d+)$/);
    if (httpMatch) {
      const s = Number(httpMatch[1]);
      if (s >= 500) return { kind: "http_5xx", http_status: s };
      if (s >= 400) return { kind: "http_4xx", http_status: s };
    }
  }
  return { kind: "unknown", http_status: 0 };
}

function elapsedBucket(startMs: number): "<5s" | "5-30s" | "30-60s" | "60-120s" | "120s+" {
  const s = (Date.now() - startMs) / 1000;
  if (s < 5) return "<5s";
  if (s < 30) return "5-30s";
  if (s < 60) return "30-60s";
  if (s < 120) return "60-120s";
  return "120s+";
}

function getConnectionType(): "4g" | "3g" | "2g" | "slow-2g" | "unknown" {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const conn = (nav as { connection?: { effectiveType?: string } } | undefined)?.connection;
  const et = conn?.effectiveType;
  if (et === "4g" || et === "3g" || et === "2g" || et === "slow-2g") return et;
  return "unknown";
}

// ──────────────────────────────────────────────────────────────────────
//  Component
// ──────────────────────────────────────────────────────────────────────

type PlayableRole = {
  id: string;
  name: string;
  role: string;
  source: "story" | "hot" | "custom";
  description: string;
  voice: string;
  voiceProfile?: CharacterVoiceProfile;
  visualStyle: string;
  tags: string[];
  portraitUrl?: string;
};

const PLAY_ROLE_STORAGE_KEY = "aistory:play-roles";
const PLAY_SELECTED_ROLE_KEY = "aistory:selected-play-role";
const PLAY_ACTIVE_ROLE_KEY = "aistory:active-play-role";

const DEFAULT_CUSTOM_VOICE_PROFILE = matchVoiceProfile({
  role: "自定义玩家角色",
  voiceDescription: "女性，清亮自然",
  gender: "female",
  style: "bright",
});

const HOT_PLAY_ROLES: PlayableRole[] = [
  {
    id: "hot-su-wan",
    name: "苏晚",
    role: "纪录片剪辑师",
    source: "hot",
    description: "敏感、克制，擅长从画面细节里找真相，适合悬疑恋爱和旧案回声类剧本。",
    voice: "低声、克制、带一点雨夜质感",
    voiceProfile: { id: "female-cold-sister", label: "女声 · 冷艳御姐", gender: "female", ageRange: "adult", style: "cold", timbre: "冷静、克制、带雨夜质感", bailianVoiceId: "Cherry", stepfunVoiceId: "lengyanyujie" },
    visualStyle: "电影感水彩 / 都市悬疑",
    tags: ["热播", "悬疑", "女性向"],
  },
  {
    id: "hot-shen-yan",
    name: "沈砚",
    role: "旧案记者",
    source: "hot",
    description: "理性、执着，表面冷静但容易被真实情感撬动，适合双主角调查线。",
    voice: "沉稳、清晰、轻微沙哑",
    voiceProfile: { id: "male-calm-lead", label: "男声 · 沉稳男主", gender: "male", ageRange: "adult", style: "calm", timbre: "沉稳、清晰、轻微沙哑", bailianVoiceId: "Andre", stepfunVoiceId: "cixingnansheng" },
    visualStyle: "写实电影 / 都市旧案",
    tags: ["高完播", "调查", "双主角"],
  },
  {
    id: "hot-a-li",
    name: "阿梨",
    role: "录像里的少女",
    source: "hot",
    description: "像是困在某个夏夜，知道支线背后的秘密，适合作为关键可攻略角色。",
    voice: "清亮、轻快、末尾带迟疑",
    voiceProfile: { id: "female-young-clear", label: "女声 · 清亮少女", gender: "female", ageRange: "young", style: "bright", timbre: "清亮、轻快、末尾带迟疑", bailianVoiceId: "Cherry", stepfunVoiceId: "qingchunshaonv" },
    visualStyle: "日系动画 / 青梅竹马",
    tags: ["人气", "恋爱", "秘密"],
  },
  {
    id: "hot-zero",
    name: "零",
    role: "边境城黑客",
    source: "hot",
    description: "半机械义体、擅长破解世界规则，适合赛博、谍战和高自由度支线。",
    voice: "冷静、中性、电子噪声边缘",
    voiceProfile: { id: "male-cold-low", label: "男声 · 冷感低音", gender: "male", ageRange: "adult", style: "cold", timbre: "冷静、中性、电子噪声边缘", bailianVoiceId: "Andre", stepfunVoiceId: "shenchennanyin" },
    visualStyle: "赛博朋克 / 高对比霓虹",
    tags: ["赛博", "动作", "世界线"],
  },
];

function readCustomRoles(): PlayableRole[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PLAY_ROLE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((role): role is PlayableRole => (
      role &&
      typeof role.id === "string" &&
      typeof role.name === "string" &&
      typeof role.role === "string" &&
      typeof role.description === "string"
    ));
  } catch {
    return [];
  }
}

function writeCustomRoles(roles: PlayableRole[]) {
  try {
    window.localStorage.setItem(PLAY_ROLE_STORAGE_KEY, JSON.stringify(roles));
  } catch {
    /* ignore */
  }
}

function saveSelectedRole(role: PlayableRole) {
  try {
    window.localStorage.setItem(PLAY_SELECTED_ROLE_KEY, JSON.stringify(role));
    window.sessionStorage.setItem(PLAY_ACTIVE_ROLE_KEY, JSON.stringify(role));
  } catch {
    /* ignore */
  }
}

function RoleToast({ message }: { message: string }) {
  return (
    <div className="fixed left-1/2 top-4 z-[80] -translate-x-1/2 rounded-full border border-blue-300/25 bg-black/78 px-4 py-2 text-[12px] text-cream-50 shadow-lg backdrop-blur-sm">
      <i className="fa-solid fa-user-check mr-2 text-blue-300" />
      {message}
    </div>
  );
}

function PlayNoticeToast({ message }: { message: string }) {
  return (
    <div className="fixed left-1/2 top-16 z-[85] -translate-x-1/2 rounded-full border border-blue-300/25 bg-black/78 px-4 py-2 text-[12px] text-cream-50 shadow-lg backdrop-blur-sm">
      <i className="fa-solid fa-circle-info mr-2 text-blue-300" />
      {message}
    </div>
  );
}

function CharacterPickerModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (role: PlayableRole) => void;
}) {
  const [customRoles, setCustomRoles] = useState<PlayableRole[]>([]);
  const [tab, setTab] = useState<"hot" | "mine" | "create">("hot");
  const [form, setForm] = useState({
    name: "",
    role: "",
    description: "",
    visualStyle: "电影感水彩",
    voice: "清亮自然",
    voiceProfile: DEFAULT_CUSTOM_VOICE_PROFILE,
  });

  useEffect(() => {
    setCustomRoles(readCustomRoles());
  }, []);

  const chooseRole = (role: PlayableRole) => {
    saveSelectedRole(role);
    onSelect(role);
    onClose();
  };

  const createRole = () => {
    const name = form.name.trim();
    if (!name) return;
    const voiceProfile = matchVoiceProfile({
      name,
      role: form.role,
      description: form.description,
      voiceDescription: form.voice,
      gender: form.voiceProfile.gender,
      ageRange: form.voiceProfile.ageRange,
      style: form.voiceProfile.style,
    });
    const role: PlayableRole = {
      id: `custom-${Date.now()}`,
      name,
      role: form.role.trim() || "自定义玩家角色",
      source: "custom",
      description:
        form.description.trim() ||
        "用户创建的可玩角色。后续会接入角色外观、声音、记忆和剧情参与方式。",
      visualStyle: form.visualStyle.trim() || "电影感水彩",
      voice: voiceDescriptionFromProfile(voiceProfile, form.voice.trim() || "清亮自然"),
      voiceProfile,
      tags: ["我的角色", "本地保存"],
    };
    const nextRoles = [role, ...customRoles].slice(0, 24);
    setCustomRoles(nextRoles);
    writeCustomRoles(nextRoles);
    chooseRole(role);
  };

  const renderRoleCard = (role: PlayableRole) => (
    <button
      key={role.id}
      type="button"
      onClick={() => chooseRole(role)}
      className="group w-full border border-clay-900/12 bg-cream-50/85 p-4 text-left transition-colors hover:border-ember-500/55 hover:bg-cream-100"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ember-500/80">
            {role.source === "hot" ? "热播角色" : "我的角色"}
          </p>
          <h3 className="mt-2 text-xl font-semibold text-clay-900">{role.name}</h3>
          <p className="mt-1 text-sm text-clay-500">{role.role}</p>
        </div>
        <span className="flex h-10 w-10 items-center justify-center border border-clay-900/12 text-ember-500 transition-colors group-hover:border-ember-500/55">
          <i className="fa-solid fa-user-plus text-[13px]" />
        </span>
      </div>
      <p className="mt-4 text-sm leading-6 text-clay-600">{role.description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {role.tags.map((tag) => (
          <span key={tag} className="border border-clay-900/10 px-2 py-1 text-[11px] text-clay-500">
            {tag}
          </span>
        ))}
      </div>
      <div className="mt-4 grid gap-2 text-xs text-clay-500 md:grid-cols-2">
        <span>画风：{role.visualStyle}</span>
        <span>声线：{role.voice}</span>
      </div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden border border-clay-900/18 bg-cream-50 shadow-2xl">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-5 py-4 md:px-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ember-500/75">
              Playable Character
            </p>
            <h2 className="mt-1 text-2xl font-semibold text-clay-900">选择或创建角色</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center border border-clay-900/12 text-clay-500 transition-colors hover:border-ember-500/50 hover:text-ember-500"
            aria-label="关闭角色面板"
            title="关闭"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[210px_minmax(0,1fr)]">
          <aside className="border-b border-clay-900/10 bg-cream-100/55 p-4 md:border-b-0 md:border-r">
            {[
              ["hot", "热门角色", "新用户默认看到这些高完播角色"],
              ["mine", "我的角色", "本机保存的自定义角色"],
              ["create", "创建角色", "参考 LocalMiniDrama 的角色创建入口"],
            ].map(([key, label, note]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key as "hot" | "mine" | "create")}
                className={`mb-3 w-full border px-4 py-3 text-left transition-colors ${
                  tab === key
                    ? "border-ember-500/55 bg-cream-50 text-ember-500"
                    : "border-clay-900/10 text-clay-600 hover:border-ember-500/35"
                }`}
              >
                <span className="block text-sm font-semibold">{label}</span>
                <span className="mt-1 block text-xs leading-5 text-clay-500">{note}</span>
              </button>
            ))}
          </aside>

          <section className="min-h-0 overflow-y-auto p-4 md:p-6">
            {tab === "hot" && (
              <div className="grid gap-4 md:grid-cols-2">
                {HOT_PLAY_ROLES.map(renderRoleCard)}
              </div>
            )}

            {tab === "mine" && (
              customRoles.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {customRoles.map(renderRoleCard)}
                </div>
              ) : (
                <div className="flex min-h-[360px] flex-col items-center justify-center border border-dashed border-clay-900/16 text-center">
                  <i className="fa-solid fa-user-pen text-3xl text-ember-500/65" />
                  <h3 className="mt-5 text-xl font-semibold text-clay-900">还没有自定义角色</h3>
                  <p className="mt-2 max-w-md text-sm leading-6 text-clay-500">
                    新用户默认只展示热门角色。创建第一个角色后，它会保存在本机，并可进入后续剧情测试。
                  </p>
                  <button
                    type="button"
                    onClick={() => setTab("create")}
                    className="mt-6 border border-ember-500 bg-ember-500 px-5 py-3 text-sm font-semibold text-white"
                  >
                    创建我的角色
                  </button>
                </div>
              )
            )}

            {tab === "create" && (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  <label className="block">
                    <span className="text-sm font-semibold text-clay-700">角色名字</span>
                    <input
                      value={form.name}
                      onChange={(e) => setForm((value) => ({ ...value, name: e.target.value }))}
                      placeholder="例如：林穗、阿梨、你自己的名字"
                      className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-ember-500/55"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-semibold text-clay-700">身份定位</span>
                    <input
                      value={form.role}
                      onChange={(e) => setForm((value) => ({ ...value, role: e.target.value }))}
                      placeholder="例如：旧案记者、青梅竹马、边境城黑客"
                      className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-ember-500/55"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-semibold text-clay-700">角色设定</span>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm((value) => ({ ...value, description: e.target.value }))}
                      placeholder="写一点性格、关系、禁忌、要参与的剧情方向。"
                      rows={5}
                      className="mt-2 w-full resize-none border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-ember-500/55"
                    />
                  </label>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="text-sm font-semibold text-clay-700">画面风格</span>
                      <select
                        value={form.visualStyle}
                        onChange={(e) => setForm((value) => ({ ...value, visualStyle: e.target.value }))}
                        className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-ember-500/55"
                      >
                        <option>电影感水彩</option>
                        <option>日系动画</option>
                        <option>写实电影</option>
                        <option>赛博朋克</option>
                        <option>国风志怪</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-sm font-semibold text-clay-700">语音声线</span>
                      <select
                        value={form.voice}
                        onChange={(e) => setForm((value) => ({ ...value, voice: e.target.value }))}
                        className="mt-2 w-full border border-clay-900/12 bg-cream-50 px-4 py-3 text-clay-900 outline-none transition-colors focus:border-ember-500/55"
                      >
                        <option>清亮自然</option>
                        <option>低声克制</option>
                        <option>沉稳磁性</option>
                        <option>冷静中性</option>
                        <option>甜感轻快</option>
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={createRole}
                    disabled={!form.name.trim()}
                    className="border border-ember-500 bg-ember-500 px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    保存并进入当前剧情
                  </button>
                </div>
                <aside className="border border-clay-900/12 bg-cream-100/45 p-5">
                  <h3 className="text-lg font-semibold text-clay-900">后续接入点</h3>
                  <p className="mt-3 text-sm leading-7 text-clay-600">
                    这版先完成入口和本地保存。下一步会把角色名字单独抽成变量，进入文本缓存、翻译缓存和 TTS 合成，避免只改名字就重新生成整段故事。
                  </p>
                  <p className="mt-4 text-sm leading-7 text-clay-600">
                    真人形象、声音克隆和用户上传素材会走后台审批；个人用户不满足授权时只能本机生成，不能公开分享。
                  </p>
                </aside>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PlayInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t, locale } = useI18n();
  const lp = useLocalePath();
  const steamChannel = params?.get("channel") === "steam";
  // Only the exact allowlisted `/mobile` return target is honored; every other
  // value (including absolute/protocol-relative URLs) falls back to home. The
  // hrefs are built by lp(), so the result stays locale-aware and can never be
  // an open redirect.
  const safeReturn = resolveSafeReturn({
    returnTo: params?.get("returnTo"),
    homeHref: lp("/"),
    mobileHref: lp("/mobile"),
  });

  const [phase, setPhase] = useState<Phase>("loading-first");
  const [firstFrameProgress, setFirstFrameProgress] = useState<LoadingProgress>(
    () => loadingProgress(locale, 8, "init"),
  );
  const [session, setSession] = useState<Session | null>(null);
  const [currentScene, setCurrentScene] = useState<Scene | null>(null);
  const [currentBeatId, setCurrentBeatId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [videoInteractionKey, setVideoInteractionKey] = useState<string | null>(
    null,
  );
  const [beatAudioMap, setBeatAudioMap] = useState<Record<string, string>>({});
  // Lazy-initialize 优先级：本局选择(homepage 的「语音配音」存到 sessionStorage:infiplot:custom)
  // > 上次会话的粘性偏好(localStorage:infiplot:muted) > 默认非静音。
  // 这样首页选了「关闭」开始游戏，进来就是静音；选「开启」就不是静音；进入 play 页后用户自己
  // 切换 静音/有声 时再用 localStorage 持久化，下一局开新游戏 sessionStorage 选择会再覆盖。
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const stored = window.sessionStorage.getItem("infiplot:custom");
      if (stored) {
        const parsed = JSON.parse(stored) as { audioEnabled?: boolean };
        if (typeof parsed.audioEnabled === "boolean") {
          return !parsed.audioEnabled;
        }
      }
      return window.localStorage.getItem(MUTED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [pendingClick, setPendingClick] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // custom=1 reads a tab-local sessionStorage draft. Missing/corrupt drafts are
  // recoverable (the user can return home and re-edit); they must not be
  // silently redirected away from the play URL.
  const [customDraftIssue, setCustomDraftIssue] = useState<
    "missing" | "malformed" | null
  >(null);
  // ?share=1 replays a story file imported in THIS tab. A new tab / reopened
  // browser may lack the sessionStorage copy (opener cloning and session restore
  // can preserve it). That is a recoverable import problem
  // and must never fall through to the generic provider/model/key error.
  const [importIssue, setImportIssue] = useState<StoryImportIssue | null>(null);
  const [platformGenerationUnavailable, setPlatformGenerationUnavailable] =
    useState(false);
  const [presentation, setPresentation] = useState(false);
  // Session-locked image orientation (see detectOrientation). "portrait" makes
  // the whole play surface render full-bleed vertical on phones.
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [lastExitLabel, setLastExitLabel] = useState<string | null>(null);
  // Consecutive server-side TTS misses (null audio / failed /api/beat-audio).
  // Climbs when the shared server key is rate-limited by MiMo — the exact pain
  // BYO fixes — so the play page can nudge non-BYO users to add their own key.
  // Reset to 0 on any successful synth. Only the server path touches it.
  const [silenceStrikes, setSilenceStrikes] = useState(0);
  // Once the player dismisses the silence nudge, keep it gone for this session.
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [styleDrawerOpen, setStyleDrawerOpen] = useState(false);
  const [styleBusy, setStyleBusy] =
    useState<"visual" | "narrative" | null>(null);
  const [styleFeedback, setStyleFeedback] = useState<string>();
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  const [visionClickEnabled, setVisionClickEnabled] = useState(true);
  const [branchPrefetchDepth, setBranchPrefetchDepth] =
    useState<BranchPrefetchDepth>(1);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authRequirement, setAuthRequirement] =
    useState<AuthRequirement | undefined>();
  // First-load auth is different from an in-scene 401: there is no action
  // closure to replay, and the loading canvas must not pretend to be at 100%.
  // While this is set the page renders an explicit paused recovery screen and
  // leaves the tab-local draft untouched.
  const [firstLoadAuthRequirement, setFirstLoadAuthRequirement] =
    useState<AuthRequirement | null>(null);
  const firstLoadAuthRequirementRef = useRef<AuthRequirement | null>(null);
  const authResolveRef = useRef<(() => void) | null>(null);
  // Serializable description of the action that hit the 401 (choice / freeform
  // text / background-click coords), captured alongside the retry closure. An
  // OAuth round-trip destroys the closure, but this survives in sessionStorage
  // so the exact action can be replayed after game state is restored.
  const pendingResumeActionRef = useRef<PendingResumeAction | null>(null);
  // Set by restorePlayResume when a snapshot carries a pending action; a
  // dedicated effect dispatches it once the restored state has committed
  // (phase "ready", session + scene present), then clears it. Mirrors the
  // homepage's autoStartPending resume pattern.
  const [pendingReplayAction, setPendingReplayAction] =
    useState<PendingResumeAction | null>(null);
  // Bumped by the OAuth-resume fallback to retrigger the bootstrap effect after
  // relinquishing its `startedRef` slot (snapshot consumed but user not signed
  // in → run normal card/preset/custom bootstrap instead of leaving a blank
  // loading screen).
  const [retryBootstrap, setRetryBootstrap] = useState(0);
  // Top-of-screen progress toast for the gallery / story export pipeline.
  // null when idle; { done, total, label } while collecting beat audio.
  const [exportProgress, setExportProgress] = useState<
    { done: number; total: number; label: string } | null
  >(null);
  const [playNotice, setPlayNotice] = useState<string | null>(null);
  const playNoticeTimerRef = useRef<number | null>(null);

  const showPlayNotice = useCallback((message: string) => {
    setPlayNotice(message);
    if (playNoticeTimerRef.current !== null) {
      window.clearTimeout(playNoticeTimerRef.current);
    }
    playNoticeTimerRef.current = window.setTimeout(() => {
      setPlayNotice(null);
      playNoticeTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (playNoticeTimerRef.current !== null) {
        window.clearTimeout(playNoticeTimerRef.current);
      }
    };
  }, []);

  // `retry` re-runs the action that hit the 401, replayed by AuthModal.onSuccess
  // after the user signs in. Omitted by callers whose path can't actually 401
  // (initial load already gated on the homepage, recorded replay is local).
  // `action` is the serializable twin of `retry`: same intent, but survives an
  // OAuth full-page redirect via sessionStorage so it can be replayed after
  // game state is restored (the retry closure itself is destroyed on unmount).
  const handleAuthError = useCallback(
    (
      e: unknown,
      retry?: () => void,
      action?: PendingResumeAction,
    ): boolean => {
      if (e instanceof AuthRequiredError) {
        setAuthRequirement({
          message: e.message,
          quote: e.quote,
        });
        authResolveRef.current = retry ?? null;
        pendingResumeActionRef.current = action ?? null;
        setAuthModalOpen(true);
        return true;
      }
      return false;
    },
    [],
  );

  // First-load 401: pause instead of claiming 100% error progress. There is no
  // serializable action to replay yet, so AuthModal success re-runs the
  // bootstrap effect once (instead of retrying a scene call).
  const markFirstLoadAuthRequired = useCallback(
    (e: AuthRequiredError) => {
      const requirement: AuthRequirement = {
        message: e.message,
        quote: e.quote,
      };
      firstLoadAuthRequirementRef.current = requirement;
      setFirstLoadAuthRequirement(requirement);
      authResolveRef.current = null;
      pendingResumeActionRef.current = null;
      setError(null);
      setPlatformGenerationUnavailable(false);
      handleAuthError(e);
    },
    [handleAuthError],
  );

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
    setAuthRequirement(undefined);
    // User dismissed login — drop the retry, don't re-run the action. A
    // first-load pause stays on screen so login can be reopened explicitly.
    authResolveRef.current = null;
    pendingResumeActionRef.current = null;
  }, []);

  const completeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
    setAuthRequirement(undefined);
    if (firstLoadAuthRequirementRef.current) {
      firstLoadAuthRequirementRef.current = null;
      setFirstLoadAuthRequirement(null);
      authResolveRef.current = null;
      pendingResumeActionRef.current = null;
      setError(null);
      setPlatformGenerationUnavailable(false);
      // Relinquish the bootstrap slot before re-running it. The increment is
      // the existing retryBootstrap trigger; clearing the ref first guarantees
      // this can happen at most once per successful first-load sign-in.
      startedRef.current = false;
      setRetryBootstrap((n) => n + 1);
      return;
    }
    const retry = authResolveRef.current;
    authResolveRef.current = null;
    pendingResumeActionRef.current = null;
    retry?.();
  }, []);

  useEffect(() => {
    if (!roleNotice) return;
    const timer = window.setTimeout(() => setRoleNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [roleNotice]);

  const handlePlayableRoleSelect = useCallback((role: PlayableRole) => {
    setRoleNotice(`已绑定角色：${role.name}。下一步会把角色名字、声线和形象接入剧情生成。`);
  }, []);

  const handleCharacterRename = useCallback((
    characterId: string,
    alias: string | undefined,
    meta?: { source: "user" | "random" | "ai" | "fallback"; generatorVersion?: string; locale?: string; culture?: string },
  ) => {
    const safeAlias = alias ? sanitizeCharacterName(alias) : null;
    setSession((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        characters: previous.characters.map((rawCharacter) => {
          const character = withCharacterIdentity(rawCharacter, previous.id);
          if (character.characterId !== characterId) return character;
          return {
            ...character,
            ...(safeAlias ? { alias: safeAlias, aliasMeta: meta || { source: "user" as const } } : {}),
            ...(!safeAlias ? { alias: undefined, aliasMeta: undefined } : {}),
          };
        }),
      };
    });
    // The provider/server cache is text-keyed, so unchanged lines still hit;
    // clearing only the page-local URL map lets lines containing the renamed
    // character synthesize the new display text without changing voiceProfile.
    setBeatAudioMap({});
    setRoleNotice(safeAlias ? `角色称呼已改为：${safeAlias}` : "已恢复作品原名");
  }, []);

  // Restore one older in-progress snapshot and replay its pending action.
  const restorePlayResume = useCallback(
    async (snap: PlayResumeSnapshot): Promise<void> => {
      const last = snap.session.history[snap.session.history.length - 1];
      if (!last?.scene) throw new Error("resume snapshot missing current scene");

      setOrientation(snap.orientation);
      visitedBeatsRef.current = [...snap.visitedBeats];
      const poster = snap.imageOriginalUrl || scenePosterUrl(last.scene);
      lastImageOriginalUrlRef.current = poster ?? null;

      setSession(snap.session);
      setCurrentScene(last.scene);
      setCurrentBeatId(snap.beatId);

      const blobUrl = poster ? await getOrCreateBlobUrl(poster) : null;
      const ready = waitForImageReady();
      setImageUrl(blobUrl);
      await ready;
      setPhase("ready");
      track("scene_reached", { scene_index: snap.session.history.length });

      if (snap.pendingAction) setPendingReplayAction(snap.pendingAction);
    },
    [],
  );

  const startedRef = useRef(false);
  const poolRef = useRef<Map<string, PrefetchEntry>>(new Map());
  // Accumulator for resolved prefetches across the whole session — every
  // `prefetchScenePath` resolution writes here, keyed by parent-scene + choice.
  // Survives `consumeChoice`'s pool sweep (an already-resolved promise is not
  // un-resolved by aborting its controller), so abandoned alternates remain
  // available for the gallery export. Cleared only on unmount.
  const resolvedPrefetchesRef = useRef<Map<string, Scene>>(new Map());
  // Lazy per-beat audio fetches keyed by beat.id. Aborted when the scene
  // changes so stale in-flight requests can't poison the new scene's map
  // (beat ids like "b1" are scene-local and would collide across scenes).
  const beatAudioAbortRef = useRef<Map<string, AbortController>>(new Map());
  // Mirrors `muted` so the closure-stable fetchBeatAudio (deps []) can gate on
  // it. Muting stops TTS *synthesis*, not just playback — TTS is the only sound
  // source, so synthesizing audio the user can't hear just burns quota.
  // 首页「语音配音 关闭」会把 muted 初值置为 true（见上方 useState 初始化），
  // 不再单独维护 audioEnabledRef —— 单一来源避免两个 flag 漂移。
  const mutedRef = useRef<boolean>(muted);
  const phaseRef = useRef<Phase>(phase);

  // Resolved bring-your-own Xiaomi TTS config (region preset + key), read once
  // from localStorage. When non-null, the browser provisions + synths voices
  // directly against Xiaomi — the key never touches our server — and every
  // start/scene/insert-beat request carries clientTts:true so the engine skips
  // server-side TTS. null = user hasn't opted in (server default / silent).
  const [byoTtsConfig, setByoTtsConfig] = useState<TtsConfig | null>(() =>
    loadClientTtsConfig(),
  );
  const byoTtsRef = useRef<TtsConfig | null>(byoTtsConfig);
  // Server TTS provider (probed once at mount via /api/tts-provider). Used by
  // fetchBeatAudio to decide which voice fields to send: when the server runs
  // StepFun, omit the ~220KB Xiaomi `voice` and send stepfunVoiceId /
  // voiceDescription instead (saves Fast Origin Transfer bandwidth). null =
  // probe failed or server has no TTS; fetchBeatAudio then sends defensively
  // and the server normalizes. Ignored entirely in BYO mode (byoTtsRef wins).
  const [serverTtsProvider, setServerTtsProvider] = useState<TtsProvider>(null);
  const serverTtsProviderRef = useRef<TtsProvider>(null);
  // BYO voice cache (see resolveByoVoice). Keyed by character name; persists
  // across scenes so each speaker is provisioned at most once per session.
  const provisionedVoicesRef = useRef<Map<string, Promise<CharacterVoice>>>(
    new Map(),
  );

  // Mirrors for use inside async handlers (closure-stable)
  const sessionRef = useRef<Session | null>(null);
  const currentSceneRef = useRef<Scene | null>(null);
  const currentBeatRef = useRef<Beat | null>(null);
  const visitedBeatsRef = useRef<string[]>([]);
  const replaySourceRef = useRef<Session | null>(null);
  const replayIndexRef = useRef(-1);
  const replayActiveRef = useRef(false);
  const exportingStoryRef = useRef(false);
  const exportingGalleryRef = useRef(false);
  const prebakedAudioRef = useRef<Record<string, string>>({});
  // Original (CDN) URL of the currently-rendered scene image. Used as the key
  // to revoke its blob: URL when the scene swaps. We track the ORIGINAL URL,
  // not the blob URL, because blobUrlCache is keyed by original URL.
  const lastImageOriginalUrlRef = useRef<string | null>(null);

  // Image-ready gate: keeps the "transitioning" overlay visible until the
  // actual <img> element has decoded its bitmap, so the user never sees
  // progressive paint or a blank flash between scenes.
  const imageReadyResolverRef = useRef<(() => void) | null>(null);
  function waitForImageReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        imageReadyResolverRef.current = null;
        resolve();
      };
      imageReadyResolverRef.current = done;
      setTimeout(done, IMAGE_READY_TIMEOUT_MS);
    });
  }
  const handleImageReady = useCallback(() => {
    imageReadyResolverRef.current?.();
  }, []);

  const currentBeat = useMemo<Beat | null>(() => {
    if (!currentScene || !currentBeatId) return null;
    return currentScene.beats.find((b) => b.id === currentBeatId) ?? null;
  }, [currentScene, currentBeatId]);

  const currentSceneMedia = useMemo(
    () =>
      currentScene
        ? coerceSceneMedia(currentScene)
        : ({ kind: "image" } as const),
    [currentScene],
  );
  const currentVideoKey = currentScene
    ? `${session?.timeline?.activeBranchId || "main"}:${session?.history.length || 0}:${currentScene.id}`
    : null;
  const videoInteractionUnlocked =
    currentSceneMedia.kind !== "video" ||
    (currentVideoKey !== null && videoInteractionKey === currentVideoKey);
  const currentAuthoredNode = session?.authoredStory
    ? findAuthoredNode(
        session.authoredStory,
        session.authoredStory.currentNodeId,
      )
    : undefined;
  const showSteamCompletion = shouldShowSteamCompletionCta({
    channel: steamChannel ? "steam" : null,
    authoredNodeKind: currentAuthoredNode?.kind,
    mediaKind: currentSceneMedia.kind,
    videoInteractionUnlocked,
  });

  // ── Honest end-of-demo / preserved-canvas error state ────────────────
  // An authored terminal beat (or a dangling continue) has no forward path.
  // Rather than looking stuck, surface an explicit notice. Detection is
  // conservative and NEVER generates content or relaxes author locks.
  const hasPreservedCanvas = Boolean(
    session && currentScene && (imageUrl || sceneHasRenderableMedia(currentScene)),
  );
  const terminalReason =
    phase === "ready" &&
    !error &&
    // Never cover an authored video while it is still playing: the terminal
    // notice waits until the player has finished the video and interaction is
    // unlocked (image scenes have no such gate).
    (currentSceneMedia.kind !== "video" || videoInteractionUnlocked)
      ? detectPlayTerminal({
          scene: currentScene,
          beat: currentBeat,
          currentBeatId,
          authoredNodeKind: currentAuthoredNode?.kind,
          authoredLocked: isAuthorLockedScene(session),
        })
      : null;
  const endOfDemoNotice = terminalReason
    ? buildPlayEndOfDemoNotice(terminalReason, safeReturn)
    : null;
  const handleReplayEndOfDemo = useCallback(() => {
    if (!currentScene) return;
    const firstBeat = currentScene.entryBeatId;
    setCurrentBeatId(firstBeat);
    visitedBeatsRef.current = [firstBeat];
    setError(null);
  }, [currentScene]);

  const canvasErrorCopy = buildPlaySceneErrorCopy(safeReturn);
  const firstLoadErrorCopy = buildPlayFirstLoadErrorCopy(safeReturn);
  // With a valid canvas still on screen, a failed step must not replace the
  // whole page with a raw backend error. Keep the scene and show fixed,
  // dismissible Chinese copy with a safe way out.
  const canvasErrorBanner =
    error && hasPreservedCanvas ? (
      <div
        className="fixed inset-x-0 top-0 z-[74] px-3 pt-3"
        role="alert"
        data-play-canvas-error
      >
        <div className="mx-auto max-w-xl rounded-xl border border-ember-500/55 bg-black/90 px-4 py-3 text-left shadow-2xl backdrop-blur">
          <div className="flex items-start gap-3">
            <i className="fa-solid fa-circle-exclamation mt-0.5 text-ember-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-cream-50">
                {canvasErrorCopy.title}
              </p>
              <p className="mt-1 text-[11px] leading-5 text-cream-50/80">
                {canvasErrorCopy.body}
              </p>
              <p className="mt-1 text-[10px] leading-5 text-cream-50/60">
                {canvasErrorCopy.safetyNote}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="min-h-8 rounded-lg border border-blue-300/50 px-3 text-[11px] font-semibold text-blue-100 transition-colors hover:border-blue-300/80"
                >
                  {canvasErrorCopy.dismissLabel}
                </button>
                <a
                  href={safeReturn.href}
                  className="min-h-8 rounded-lg border border-cream-50/25 px-3 text-[11px] font-semibold leading-8 text-cream-50/85 transition-colors hover:text-cream-50"
                >
                  {canvasErrorCopy.backLabel}
                </a>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-cream-50/60 transition-colors hover:text-cream-50"
              aria-label="关闭错误提示"
            >
              <i className="fa-solid fa-xmark text-[13px]" />
            </button>
          </div>
        </div>
      </div>
    ) : null;

  const dialogueHistory = useMemo<DialogueHistoryItem[]>(
    () => buildDialogueHistory(session),
    [session],
  );
  const timelineDecisions = useMemo<TimelineDecision[]>(() => {
    if (!session) return [];
    return [
      ...(session.timeline?.decisions ?? []),
      ...migrateLegacyDecisions(session),
    ].sort((a, b) => a.sceneIndex - b.sceneIndex || a.createdAt - b.createdAt);
  }, [session]);

  const audioSrc = (currentBeat ? beatAudioMap[currentBeat.id] : undefined) ?? null;

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // Autosave bookkeeping. We persist on a stable FINGERPRINT of the durable,
  // session-level state — committed-scene count + playerName — not the raw
  // `session` reference, which churns on every beat advance (visitedBeatIds).
  //  - lastSavedFingerprintRef holds the fingerprint of the last SUCCESSFUL save.
  //    On failure it's cleared so the next session change retries: a
  //    fire-and-forget that silently failed (IndexedDB transiently unavailable)
  //    must not strand the scene unsaved.
  //  - saveChainRef serializes writes so a slow save for scene N can't land after
  //    a faster save for N+1 and persist a stale, shorter session.
  const lastSavedFingerprintRef = useRef("");
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  // Persist to the browser-local store when the durable state changes (Req 2.1).
  // Fingerprint = committed-scene count + last-scene beat count + playerName:
  //  - scene count grows on a normal scene commit;
  //  - last-scene beat count grows on an insert-beat (freeform / background-click
  //    appends a beat to the current scene WITHOUT changing history.length), which
  //    is real generated narrative that must persist — keying on length alone
  //    would silently drop it;
  //  - playerName captures a late rename.
  // Within-scene *visited* progress (visitedBeatIds) is deliberately NOT in the
  // fingerprint, so merely advancing through existing beats doesn't re-save. The
  // resume path primes the fingerprint so loading a story stays a pure read (no
  // re-save / rev bump / list reorder). No debounce — the write is issued on the
  // committing render, so navigating home right after a change can't drop it (the
  // IndexedDB put is already in flight, serialized, not cancelled by unmount).
  // Fire-and-forget: never blocks.
  useEffect(() => {
    // Never persist a replayed shared story into the user's own library — it
    // isn't theirs and its id can collide with (and clobber) a real local save.
    // Guard on replaySourceRef (set unconditionally on import, cleared by
    // detachRecordedReplay when the user takes over) — NOT replayActiveRef, which
    // means "more recorded scenes remain" and is false for a single-scene share,
    // so that share would otherwise slip through and overwrite a real save.
    if (!session || replaySourceRef.current) return;
    const history = session.history ?? [];
    if (history.length < 1) return;
    const fingerprint = durableSessionFingerprint(session);
    if (fingerprint === lastSavedFingerprintRef.current) return;
    lastSavedFingerprintRef.current = fingerprint; // optimistic; rolled back on failure
    const snapshot = session;
    saveChainRef.current = saveChainRef.current
      .then(async () => {
        const r = await saveStory(snapshot);
        // Roll back only if no newer save has superseded us, so the next session
        // change retries this content instead of the failure being permanent.
        if (!r.ok && lastSavedFingerprintRef.current === fingerprint) {
          lastSavedFingerprintRef.current = "";
        }
      })
      .catch(() => {
        if (lastSavedFingerprintRef.current === fingerprint) {
          lastSavedFingerprintRef.current = "";
        }
      });
  }, [session]);
  useEffect(() => {
    currentSceneRef.current = currentScene;
  }, [currentScene]);
  useEffect(() => {
    currentBeatRef.current = currentBeat;
  }, [currentBeat]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    serverTtsProviderRef.current = serverTtsProvider;
  }, [serverTtsProvider]);
  useEffect(() => {
    setVisionClickEnabled(readStoredVisionClick());
    setBranchPrefetchDepth(readStoredBranchPrefetchDepth());
  }, []);
  useEffect(() => {
    setSession((prev) => {
      if (!prev || prev.language === locale) return prev;
      return { ...prev, language: locale };
    });
  }, [locale]);

  // Probe the server's TTS provider ONCE at mount. Non-BYO users need this so
  // fetchBeatAudio can skip the ~220KB Xiaomi reference audio when the server
  // runs StepFun. BYO users never read this ref (byoTtsRef takes precedence),
  // but the probe is harmless and cheap, so we run it unconditionally and let
  // getTtsProvider short-circuit for BYO. AuthRequiredError is handled by the
  // bootstrap flow's handleAuthError; other errors degrade to null silently.
  useEffect(() => {
    let cancelled = false;
    getTtsProvider()
      .then((p) => {
        if (!cancelled) setServerTtsProvider(p);
      })
      .catch((e) => {
        if (!cancelled && e instanceof AuthRequiredError) {
          // Defer to the bootstrap effect's auth modal — leave provider null.
          return;
        }
        // Non-auth errors already logged in getTtsProvider; null = unknown.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function trackPlayError(source: ErrorSource, e: unknown, startMs: number, res?: Response) {
    const { kind, http_status } = classifyError(e, res);
    track("play_error", {
      source,
      kind,
      http_status,
      orientation,
      connection: getConnectionType(),
      was_hidden: document.visibilityState === "hidden",
      scene_index: session?.history.length ?? 0,
      elapsed_bucket: elapsedBucket(startMs),
    });
  }

  // Coarse liveness ping for active-time analytics. /play is a single SPA
  // route, so page views alone read as ~0 duration; a 30s heartbeat (only
  // while the tab is visible) gives Umami the timestamps to derive real
  // engaged time. Content-free — no payload. The interval is never even
  // scheduled unless the tracker is configured, so it's zero work when off.
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_UMAMI_SRC || !process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID) {
      return;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") track("play_heartbeat");
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    function onVisChange() {
      if (document.visibilityState === "hidden") {
        const p = phaseRef.current;
        track("play_visibility_lost", {
          phase: p,
          had_pending_fetch: p !== "ready",
        });
      }
    }
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, []);

  // Whenever currentBeatId changes, append it to visited (skip consecutive dups)
  useEffect(() => {
    if (!currentBeatId) return;
    if (visitedBeatsRef.current.at(-1) === currentBeatId) return;
    visitedBeatsRef.current = [...visitedBeatsRef.current, currentBeatId];
    setSession((s) => {
      if (!s) return s;
      return {
        ...s,
        authoredStory: s.authoredStory
          ? { ...s.authoredStory, currentBeatId }
          : undefined,
        history: s.history.map((h, i, arr) =>
          i === arr.length - 1
            ? { ...h, visitedBeatIds: [...visitedBeatsRef.current] }
            : h,
        ),
      };
    });
  }, [currentBeatId]);

  // ── Lazy per-beat audio fetch ────────────────────────────────────────
  // Returns silently on any failure — the UI never waits for audio, so a
  // null result just means that beat plays without voice.
  // Sends only the speaker's voice + the line to speak — NOT the whole
  // session — so the per-beat payload stays small even with many characters
  // (each voice.referenceAudioBase64 is ~160KB).
  const fetchBeatAudio = useCallback(
    async (
      sess: Session,
      beat: { id: string; speaker?: string; line?: string; lineDelivery?: string },
    ): Promise<void> => {
      if (mutedRef.current) return; // 静音 → 不合成 TTS（避免无谓的调用与花费）。
      if (sceneUsesEmbeddedAudio(currentSceneRef.current)) return;
      // 「首页选关闭」也走这条路：bootstrap 时 muted 已被初始化为 true。
      if (!beat.speaker || !beat.line) return;
      const speechLine = renderPersonalizedText(
        beat.line,
        sess.playerName,
        "你",
        sess.characters,
      ).trim();
      if (!speechLine) return;

      // Reuse pre-baked audio from a `.infiplot` import before any synth —
      // free, instant, and identical to what the original player heard.
      // If the canonical line contains a personalization slot, do not reuse
      // baked audio blindly: another player's name may have been spoken.
      const curSceneId = currentSceneRef.current?.id;
      if (curSceneId) {
        const baked = prebakedAudioRef.current[`${curSceneId}:${beat.id}`];
        if (baked && !hasPersonalizationSlot(beat.line)) {
          setBeatAudioMap((m) => (m[beat.id] === baked ? m : { ...m, [beat.id]: baked }));
          return;
        }
      }

      const speaker = sess.characters.find((c) => c.name === beat.speaker);
      if (!speaker) return;

      const byo = byoTtsRef.current;
      const serverProvider = serverTtsProviderRef.current;
      // What we need to synthesize depends on the path:
      //   - BYO (xiaomi): baked voice OR voiceDescription to provision locally.
      //   - Server stepfun: stepfunVoiceId or voiceDescription — no Xiaomi
      //     `voice` needed (saves the ~220KB reference-audio FOT).
      //   - Server xiaomi / unknown (probe pending): accept ANY synthesizable
      //     source. The null case covers the race where getTtsProvider hasn't
      //     resolved before the first beat fetch fires — without this widening
      //     a stepfun-only speaker (no Xiaomi voice) would be silently dropped.
      //     The server resolves + normalizes regardless of which fields arrive.
      if (byo) {
        if (!speaker.voice && !speaker.voiceDescription) return;
      } else if (serverProvider === "stepfun" || serverProvider === "bailian") {
        if (!speaker.stepfunVoiceId && !speaker.voiceDescription) return;
      } else {
        if (!speaker.voice && !speaker.stepfunVoiceId && !speaker.voiceDescription) return;
      }

      if (beatAudioAbortRef.current.has(beat.id)) return;
      const abort = new AbortController();
      beatAudioAbortRef.current.set(beat.id, abort);
      try {
        let audioUrl: string | null = null;
        if (byo) {
          // Client-direct: provision (once per speaker, cached) + synth against
          // Xiaomi with the user's own key — the key never touches our server.
          const voice = await resolveByoVoice(
            provisionedVoicesRef.current,
            byo,
            speaker,
          );
          if (!voice || abort.signal.aborted) return;
          const out = await synthesize(
            byo,
            voice,
            speechLine,
            beat.lineDelivery,
            abort.signal,
          );
          audioUrl = `data:${out.mimeType};base64,${out.audioBase64}`;
        } else {
          // Server-side synth: shape the body by the probed provider so we don't
          // waste Fast Origin Transfer bandwidth on the ~220KB Xiaomi reference
          // audio when the server actually runs StepFun.
          //   - stepfun → stepfunVoiceId + voiceDescription + characterName
          //     (all lightweight; the server synths directly with the id).
          //   - xiaomi / unknown → voice (the ~220KB reference audio the server
          //     needs to clone), PLUS the lightweight fallback fields so the
          //     server can still normalize on a provider mismatch (e.g. a prebaked
          //     card holding a Xiaomi voice while the server runs StepFun).
          const isLightweightServer = serverProvider === "stepfun" || serverProvider === "bailian";
           const res = await fetch("/api/beat-audio", {
             method: "POST",
             headers: {
               "Content-Type": "application/json",
               "X-Idempotency-Key": `generation:${crypto.randomUUID()}`,
             },
            body: JSON.stringify({
              beat: { id: beat.id, line: speechLine, lineDelivery: beat.lineDelivery },
              ...(isLightweightServer
                ? {
                    stepfunVoiceId: speaker.stepfunVoiceId,
                    voiceDescription: speaker.voiceDescription,
                    voiceProfile: speaker.voiceProfile,
                    characterName: speaker.name,
                  }
                : {
                    voice: speaker.voice,
                    // Defensive fallback fields (lightweight) — let the server
                    // re-provision if speaker.voice.provider ≠ server provider.
                    stepfunVoiceId: speaker.stepfunVoiceId,
                    voiceDescription: speaker.voiceDescription,
                    voiceProfile: speaker.voiceProfile,
                    characterName: speaker.name,
                  }),
            }),
            signal: abort.signal,
           });
           if (res.status === 401) {
             const payload = await res.json().catch(() => ({})) as {
               error?: string;
               quote?: AuthRequiredError["quote"];
             };
             handleAuthError(
               new AuthRequiredError(payload.error, payload.quote),
               () => {
                 void fetchBeatAudio(sess, beat);
               },
             );
             return;
           }
          if (res.status === 204) {
            setSilenceStrikes((n) => Math.min(n + 1, 99));
            return;
          }
          if (!res.ok) {
            setSilenceStrikes((n) => Math.min(n + 1, 99));
            return;
          }
          const blob = await res.blob();
          // Defensive: a 200 with an empty body (proxy/CDN truncation,
          // framework edge cases) would create a silent blob URL and wrongly
          // reset the silence counter. Treat empty as a miss so the nudge
          // still surfaces when the shared key is being rate-limited.
          if (blob.size === 0) {
            setSilenceStrikes((n) => Math.min(n + 1, 99));
            return;
          }
          audioUrl = URL.createObjectURL(blob);
          setSilenceStrikes(0);
        }
        // Skip the state write if we've been aborted between the await and
        // here — beat ids are scene-local, so a late arrival from a prior
        // scene would otherwise overwrite the current scene's audio under the
        // same id.
        if (audioUrl && !abort.signal.aborted) {
          setBeatAudioMap((m) => ({ ...m, [beat.id]: audioUrl }));
        } else if (audioUrl?.startsWith("blob:")) {
          // Aborted between synth and store — revoke the blob URL we just
          // created so it doesn't leak. (Scene-change and mute transitions
          // revoke stored URLs separately; this only covers this race.)
          URL.revokeObjectURL(audioUrl);
        }
      } catch {
        // aborted (scene change / mute) — silent fallback, NOT a strike.
        // Network failure / server 5xx / shared-key rate-limit that surfaces
        // as a thrown error on the server path DOES count — otherwise the
        // silence nudge would never fire for those cases (the explicit 204/
        // !ok/empty-blob branches above only cover responses, not throws).
        // BYO throws are the user's own key quota, not the shared-key pain
        // the nudge addresses, so they don't count.
        if (!abort.signal.aborted && !byo) {
          setSilenceStrikes((n) => Math.min(n + 1, 99));
        }
      } finally {
        // Only clear the slot if it's still ours. An aborted prior fetch
        // running its finally late could otherwise delete the controller of a
        // new fetch that took the same beat id, leaving the new one
        // unabortable on the next scene change.
        if (beatAudioAbortRef.current.get(beat.id) === abort) {
          beatAudioAbortRef.current.delete(beat.id);
        }
      }
    },
    [handleAuthError],
  );

  function cancelBeatAudioFetches(): void {
    for (const c of beatAudioAbortRef.current.values()) c.abort();
    beatAudioAbortRef.current.clear();
  }

  // Fire one /api/beat-audio request per speaking beat in the current scene.
  // Reads refs (not props) so it stays closure-stable and can be re-run on
  // un-mute as well as on scene change.
  const prefetchSceneAudio = useCallback(() => {
    const scene = currentSceneRef.current;
    const sess = sessionRef.current;
    if (!scene || !sess) return;
    if (sceneUsesEmbeddedAudio(scene)) return;
    for (const b of scene.beats) {
      if (b.speaker && b.line) void fetchBeatAudio(sess, b);
    }
  }, [fetchBeatAudio]);

  // (Re)synthesize each time the scene changes. Cancel any in-flight requests
  // from the prior scene first — beat ids are scene-local ("b1" repeats across
  // scenes) so a late arrival would land under the wrong beat otherwise.
  useEffect(() => {
    cancelBeatAudioFetches();
    setBeatAudioMap((prev) => {
      for (const url of Object.values(prev)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
      return {};
    });
    prefetchSceneAudio();
  }, [currentScene?.id, prefetchSceneAudio]);

  // ── Mute persistence (read is via the useState lazy initializer above) ─
  const toggleMuted = useCallback(() => {
    const nextMuted = !mutedRef.current;
    track("tts_toggle", { muted: nextMuted });
    showPlayNotice(nextMuted ? "声音已关闭" : "声音已开启");
    setMuted((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(MUTED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, [showPlayNotice]);

  // Muting stops synthesis, not just playback: abort in-flight requests when
  // muting. When un-muting, re-synthesize the current scene — fetchBeatAudio
  // skips synthesis while muted, so a scene entered muted has no audio to play
  // back otherwise. (Clearing the map re-synthesizes already-fetched beats on a
  // mid-scene un-mute, but that's bounded to one scene and a rare toggle.)
  //
  // Gate on actual mute *transitions*: on mount this effect would otherwise
  // fire alongside the scene effect above (both call prefetchSceneAudio),
  // doubling the initial /api/beat-audio batch — the first set is dispatched
  // only to be aborted mid-flight, burning TTS quota.
  const prevMutedRef = useRef(muted);
  useEffect(() => {
    const prev = prevMutedRef.current;
    prevMutedRef.current = muted;
    if (prev === muted) return;
    cancelBeatAudioFetches();
    if (muted) return;
    setBeatAudioMap((prev) => {
      for (const url of Object.values(prev)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
      return {};
    });
    prefetchSceneAudio();
  }, [muted, prefetchSceneAudio]);

  const handleSettingsSaved = useCallback(
    (settings: {
      playerName: string;
      visionClickEnabled: boolean;
      branchPrefetchDepth: BranchPrefetchDepth;
      ttsConfigured: boolean;
    }) => {
      setVisionClickEnabled(settings.visionClickEnabled);
      setBranchPrefetchDepth(settings.branchPrefetchDepth);
      const nextPlayerName = settings.playerName || undefined;
      const prevPlayerName = sessionRef.current?.playerName || undefined;
      const playerNameChanged = prevPlayerName !== nextPlayerName;
      setSession((prev) => {
        const next = prev ? { ...prev, playerName: nextPlayerName } : prev;
        if (next) sessionRef.current = next;
        return next;
      });
      const cfg = settings.ttsConfigured ? loadClientTtsConfig() : null;
      byoTtsRef.current = cfg;
      setByoTtsConfig(cfg);
      if (cfg || playerNameChanged) {
        // Switching to BYO: any server-path audio in flight is now stale,
        // and the silence nudge is no longer relevant. Abort + clear, then
        // re-synth the current scene with the user's own key. A player-name
        // change also invalidates any beat whose spoken line renders the name.
        if (cfg) setSilenceStrikes(0);
        cancelBeatAudioFetches();
        setBeatAudioMap((prev) => {
          for (const url of Object.values(prev)) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          }
          return {};
        });
        prefetchSceneAudio();
      }
    },
    [prefetchSceneAudio],
  );

  function detachRecordedReplay(): void {
    replayActiveRef.current = false;
    replaySourceRef.current = null;
    replayIndexRef.current = -1;
    clearPool(poolRef.current);
  }

  // ── Export to interactive gallery (PPT-style replay) ─────────────────
  // Drop all but the (keepCount) most-recent gallery exports from localStorage,
  // ordered by their stored createdAt. Called right before writing a new
  // export so the cap is enforced strictly (≤ keepCount + 1 transiently → ≤ N
  // once write completes). Corrupt entries (un-parseable / no createdAt) sort
  // last and get evicted first.
  //
  // Audio lives in a sidecar key `infiplot:gallery:<id>:audio` so the main
  // doc JSON.parse on gallery load doesn't block the main thread with several
  // MB of base64. The sidecar key inherits its doc's age — paired by id, not
  // its own createdAt (it never has one) — and is evicted alongside its doc.
  const trimGalleryExports = useCallback((keepCount: number) => {
    try {
      const prefix = "infiplot:gallery:";
      const audioSuffix = ":audio";
      const docs: Map<string, { key: string; createdAt: number }> = new Map();
      const sidecars: Map<string, string> = new Map();
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        if (k.endsWith(audioSuffix)) {
          const id = k.slice(prefix.length, -audioSuffix.length);
          sidecars.set(id, k);
          continue;
        }
        const id = k.slice(prefix.length);
        let createdAt = 0;
        try {
          const raw = window.localStorage.getItem(k);
          if (raw) {
            const parsed = JSON.parse(raw) as { createdAt?: number };
            createdAt = parsed.createdAt ?? 0;
          }
        } catch {
          createdAt = 0;
        }
        docs.set(id, { key: k, createdAt });
      }
      const ordered = [...docs.entries()].sort(
        (a, b) => b[1].createdAt - a[1].createdAt,
      );
      for (const [id, { key }] of ordered.slice(keepCount)) {
        window.localStorage.removeItem(key);
        const sc = sidecars.get(id);
        if (sc) window.localStorage.removeItem(sc);
        sidecars.delete(id);
      }
      // Orphan sidecars (their doc was already gone) get cleaned up too.
      for (const sc of sidecars.values()) {
        if (!docs.has(sc.slice(prefix.length, -audioSuffix.length))) {
          window.localStorage.removeItem(sc);
        }
      }
    } catch {
      // best-effort — quota or disabled storage shouldn't block the export
    }
  }, []);

  // Strips the live Session to a small GalleryDoc — only scene images +
  // dialogue text + recorded choices, no voice base64 / portraits / style
  // reference (those are tens-to-hundreds of KB each). Writes it to
  // localStorage under a one-shot id and opens /gallery#<id> in a new tab
  // so the play session keeps running.
  //
  // Beat audio is collected synchronously here (reusing the per-scene
  // beatAudioMap when possible, BYO / server TTS for the rest) and stashed
  // in a sidecar localStorage key so the gallery's first paint isn't
  // bottlenecked on JSON.parse-ing several MB of base64.
  const handleExportGallery = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) {
      showPlayNotice("暂无可导出的剧情");
      return;
    }
    if (exportingGalleryRef.current) {
      showPlayNotice("图集正在导出中");
      return;
    }
    showPlayNotice("正在导出图集...");
    exportingGalleryRef.current = true;
    const scenes: GalleryScene[] = s.history
      .map((h) => ({
        id: h.scene.id,
        imageUrl: h.scene.imageUrl ?? "",
        sceneKey: h.scene.sceneKey,
        orientation: h.scene.orientation,
        beats: h.scene.beats,
        entryBeatId: h.scene.entryBeatId,
        visitedBeatIds: h.visitedBeatIds,
        exit: h.exit,
      }))
      .filter((sc) => sc.imageUrl);
    if (scenes.length === 0) {
      exportingGalleryRef.current = false;
      showPlayNotice("暂无可导出的画面");
      return;
    }

    // Alternates: ${parentSceneId}:${choiceId} → reachable scene. Two sources,
    // merged with main-path winning ties (it always agrees with prefetch when
    // prefetch was actually used, so the override is a no-op in the common case;
    // it differs only when the player took a cold path and the prefetch had
    // resolved to something the engine later regenerated):
    //   1. Every resolved prefetch (including alternates the player never took)
    //   2. Main path: every history step's choice exit → the next visited scene
    const alternates: Record<string, GalleryScene> = {};
    for (const [key, scene] of resolvedPrefetchesRef.current) {
      if (!scene.imageUrl) continue;
      alternates[key] = {
        id: scene.id,
        imageUrl: scene.imageUrl,
        sceneKey: scene.sceneKey,
        orientation: scene.orientation,
        beats: scene.beats,
        entryBeatId: scene.entryBeatId,
      };
    }
    for (let i = 0; i < s.history.length - 1; i++) {
      const h = s.history[i]!;
      const nextH = s.history[i + 1]!;
      if (
        h.exit?.kind === "choice" &&
        h.scene.id &&
        nextH.scene.imageUrl
      ) {
        alternates[`${h.scene.id}:${h.exit.choiceId}`] = {
          id: nextH.scene.id,
          imageUrl: nextH.scene.imageUrl,
          sceneKey: nextH.scene.sceneKey,
          orientation: nextH.scene.orientation,
          beats: nextH.scene.beats,
          entryBeatId: nextH.scene.entryBeatId,
        };
      }
    }

    // Character portraits — names + CDN URLs only. The big voice base64s are
    // intentionally dropped (the gallery only needs the portraits for download).
    const characters = s.characters
      .filter((c) => c.basePortraitUrl)
      .map((c) => ({
        name: c.name,
        basePortraitUrl: c.basePortraitUrl as string,
      }));

    const id = `${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    let audioByBeatId: Record<string, string> = {};
    try {
      setExportProgress({ done: 0, total: 0, label: t("play.exportProgress.preparingVoice") });
      audioByBeatId = await collectBeatAudioForExport({
        session: s,
        beatAudioMap,
        currentSceneId: currentSceneRef.current?.id ?? null,
        byoTts: byoTtsRef.current,
        byoVoiceCache: provisionedVoicesRef.current,
        prebakedAudio: prebakedAudioRef.current,
        onProgress: (done, total) =>
          setExportProgress({ done, total, label: t("play.exportProgress.preparingVoice") }),
      });
    } catch {
      // best-effort — even if the collector throws, the gallery without audio
      // is still usable; we keep going rather than block the export.
    } finally {
      setExportProgress(null);
    }

    const doc: GalleryDoc = {
      v: audioByBeatId && Object.keys(audioByBeatId).length > 0 ? 3 : 2,
      id,
      createdAt: Date.now(),
      orientation: coerceOrientation(s.orientation),
      scenes,
      alternates,
      characters,
      playerName: s.playerName,
    };
    // Cap retained gallery exports at the most recent 2. Drop everything
    // older BEFORE writing the new doc so we never transiently exceed the cap
    // (and so a near-quota localStorage has headroom for the new entry).
    trimGalleryExports(1);
    const docStr = JSON.stringify(doc);
    try {
      window.localStorage.setItem(`infiplot:gallery:${id}`, docStr);
    } catch {
      // localStorage full or disabled — silently bail; the player keeps playing.
      exportingGalleryRef.current = false;
      showPlayNotice("浏览器空间不足，图集暂时无法导出");
      return;
    }
    const audioCount = Object.keys(audioByBeatId).length;
    if (audioCount > 0) {
      try {
        window.localStorage.setItem(
          `infiplot:gallery:${id}:audio`,
          JSON.stringify(audioByBeatId),
        );
      } catch {
        // Sidecar too big for quota — gallery still opens without sound.
      }
    }
    track("gallery_export", { scene_count: scenes.length, audio_count: audioCount });
    const opened = window.open(`/gallery#id=${id}`, "_blank", "noopener");
    showPlayNotice(opened ? "图集已在新标签页打开" : "图集已生成，请检查浏览器弹窗权限");
    exportingGalleryRef.current = false;
  }, [beatAudioMap, showPlayNotice, trimGalleryExports, t]);

  const handleExportStory = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.history.length === 0) {
      showPlayNotice(STORY_ARCHIVE_EMPTY);
      return;
    }
    if (exportingStoryRef.current) {
      showPlayNotice("剧情存档正在打包中");
      return;
    }
    showPlayNotice(STORY_ARCHIVE_PACKING);
    exportingStoryRef.current = true;
    const sceneIndex = Math.max(0, s.history.length - 1);

    let audioByBeatId: Record<string, string> = {};
    try {
      setExportProgress({ done: 0, total: 0, label: t("play.exportProgress.preparingVoice") });
      audioByBeatId = await collectBeatAudioForExport({
        session: s,
        beatAudioMap,
        currentSceneId: currentSceneRef.current?.id ?? null,
        byoTts: byoTtsRef.current,
        byoVoiceCache: provisionedVoicesRef.current,
        prebakedAudio: prebakedAudioRef.current,
        onProgress: (done, total) =>
          setExportProgress({ done, total, label: t("play.exportProgress.preparingVoice") }),
      });
    } catch {
      // best-effort — share the doc silent if collecting audio failed
    } finally {
      setExportProgress(null);
    }

    const doc = createStoryShareDoc(
      s,
      {
        sceneIndex,
        beatId: currentBeatRef.current?.id ?? s.history[sceneIndex]?.scene.entryBeatId,
      },
      Object.keys(audioByBeatId).length > 0 ? audioByBeatId : undefined,
    );

    try {
      const r = await fetch("/api/story-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docStr: JSON.stringify(doc) }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        showPlayNotice(j.error ?? t("play.shareErrors.packFailed"));
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = storyShareFilename(doc);
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showPlayNotice(STORY_ARCHIVE_EXPORT_DONE);
    } catch {
      showPlayNotice(t("play.shareErrors.packFailed"));
    } finally {
      exportingStoryRef.current = false;
    }
  }, [beatAudioMap, showPlayNotice, t]);

  // ── Presentation mode toggle ─────────────────────────────────────────
  const togglePresentation = useCallback(async () => {
    const entering = !presentation;
    track("fullscreen_toggle", { on: entering });
    showPlayNotice(entering ? "进入全屏模式" : "退出全屏模式");
    if (entering) {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        }
      } catch {
        // ignore — fall through to chrome-less mode anyway
      }
      setPresentation(true);
    } else {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // ignore
      }
      setPresentation(false);
    }
  }, [presentation, showPlayNotice]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "f" || e.key === "F") {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        void togglePresentation();
      } else if (e.key === "Escape" && presentation) {
        setPresentation(false);
      }
    }
    function onFullscreenChange() {
      if (!document.fullscreenElement && presentation) setPresentation(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [togglePresentation, presentation]);

  // Lock the visible orientation BEFORE the first paint, so portrait phones
  // never flash the landscape loading chrome. The state inits to "landscape"
  // for SSR-safety; this corrects it pre-paint (no-op re-render on landscape
  // devices). The bootstrap effect below re-derives the same value for the
  // /api/start payload.
  useIsomorphicLayoutEffect(() => {
    setOrientation(detectOrientation());
  }, [params]);

  // ── Bootstrap: start session ─────────────────────────────────────────
  useEffect(() => {
    if (!params) return;
    if (startedRef.current) return;
    startedRef.current = true;

    // Consume a legacy OAuth snapshot when one remains from an older build.
    // Only this existence probe is guarded: reading sessionStorage can throw in
    // privacy-restricted tabs, and an unguarded throw here would abort the
    // bootstrap before the custom-draft recovery screen can render. The consume
    // path below keeps its existing behaviour untouched.
    let hasLegacyResumeSnapshot = false;
    if (AUTH_ENABLED) {
      try {
        hasLegacyResumeSnapshot =
          sessionStorage.getItem(PLAY_RESUME_KEY) !== null;
      } catch {
        hasLegacyResumeSnapshot = false;
      }
    }
    if (hasLegacyResumeSnapshot) {
      void (async () => {
        const snap = await consumeResumeSnapshot<PlayResumeSnapshot>(
          PLAY_RESUME_KEY,
        );
        if (!snap) {
          // Snapshot existed but user isn't signed in / payload corrupt →
          // consumeResumeSnapshot already removed it. Relinquish the slot so
          // the normal bootstrap below re-runs on the next effect cycle.
          startedRef.current = false;
          setRetryBootstrap((n) => n + 1);
          return;
        }
        try {
          await restorePlayResume(snap);
        } catch {
          // Corrupt snapshot / network — relinquish and bootstrap normally.
          startedRef.current = false;
          setRetryBootstrap((n) => n + 1);
        }
      })();
      return;
    }

    // 三条进入路径：
    //   ?card=<m0..f31>      → 首页精选卡，直接从 /home/firstact/{name}.json
    //                          静态文件加载（已在构建期 prebake，免一切引擎调用）
    //   ?preset=<id>         → 内置 PRESETS（仍走 /api/start 现场生成）
    //   ?custom=1            → 用户自定义 prompt，sessionStorage 取 ws/sg
    //                          后走 /api/start 现场生成
    //   ?share=1             → 首页上传的剧情分享 JSON，从第一幕开始本地回放
    //   ?storyId=<uuid>      → 加载已保存的剧情（从 localStorage）
    //   ?case=<case-id>      → 加载本地原创案例的确定性 authored graph
    //   ?videoStory=<id>     → 加载已发布的内容寻址互动视频 authored graph
    const cardName = params.get("card");
    const caseStudyId = params.get("case");
    const videoStoryId = params.get("videoStory");
    const presetId = params.get("preset");
    const isCustom = params.get("custom") === "1";
    const isShare = params.get("share") === "1";
    const storyId = params.get("storyId");
    const requestedBranchId = params.get("branchId");

    if (isShare) {
      (async () => {
        const t0 = Date.now();
        // Reset the import classification on every legitimate (re)bootstrap so
        // a retried bootstrap re-derives the current tab's state.
        setImportIssue(null);
        // Classify the tab-local import BEFORE any image-loading request. A
        // missing/corrupt/unreadable import is a dedicated recovery state, not
        // a generation failure — nothing below may throw it into the generic
        // first-load error screen.
        const importRead = readStoryImportDoc(
          () => sessionStorage,
          STORY_SHARE_STORAGE_KEY,
          (raw) => parseStoryShareDoc(JSON.parse(raw)),
        );
        if (importRead.status !== "ok") {
          setImportIssue(importRead.status);
          return;
        }
        const doc = importRead.doc;
        const imported = doc.session;
        const first = imported.history[0];
        const initialStoryState = first?.storyStateAfter ?? imported.storyState;
        // Everything the synchronous replay setup needs is validated here so a
        // structurally usable but unplayable document is reported as a
        // malformed import instead of failing mid-playback.
        if (!first || !sceneHasRenderableMedia(first.scene) || !initialStoryState) {
          setImportIssue("malformed");
          return;
        }

        try {
          const sessionOrientation =
            first.scene.orientation ?? imported.orientation ?? detectOrientation();
          setOrientation(sessionOrientation);
          const firstPoster = scenePosterUrl(first.scene);
          const blobUrl = firstPoster
            ? await getOrCreateBlobUrl(firstPoster)
            : null;
          lastImageOriginalUrlRef.current = firstPoster ?? null;

          const initial: Session = {
            ...imported,
            cacheIdentity: {
              visibility: "private",
              storyId: imported.id,
              version: imported.cacheIdentity?.version || "import-v1",
              ownerNamespace:
                imported.cacheIdentity?.ownerNamespace || imported.id,
            },
            history: [
              {
                ...first,
                visitedBeatIds: [first.scene.entryBeatId],
                exit: undefined,
              },
            ],
            storyState: initialStoryState,
            orientation: sessionOrientation,
          };
          replaySourceRef.current = imported;
          replayIndexRef.current = 0;
          replayActiveRef.current = imported.history.length > 1;
          visitedBeatsRef.current = [first.scene.entryBeatId];
          if (doc.audioByBeatId) {
            prebakedAudioRef.current = { ...doc.audioByBeatId };
            const seed: Record<string, string> = {};
            for (const beat of first.scene.beats) {
              const k = `${first.scene.id}:${beat.id}`;
              const v = doc.audioByBeatId[k];
              if (v) seed[beat.id] = v;
            }
            if (Object.keys(seed).length > 0) setBeatAudioMap(seed);
          }
          setSession(initial);
          setCurrentScene(first.scene);
          setCurrentBeatId(first.scene.entryBeatId);
          const ready = waitForImageReady();
          setImageUrl(blobUrl);
          await ready;
          setPhase("ready");
          track("scene_reached", { scene_index: 1 });
        } catch (e) {
          if (!handleAuthError(e)) {
            trackPlayError("start", e, t0);
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      })();
      return;
    }

    let liveAudioEnabled = false;
    let livePayload: {
      worldSetting: string;
      styleGuide: string;
      styleReferenceImage?: string;
      orientation?: Orientation;
      playerName?: string;
      language?: string;
    } | null = null;
    // custom=1 is the only entry path backed by a tab-local sessionStorage
    // draft. A missing/corrupt payload is recoverable and must NOT silently
    // redirect away from /play or reuse story text from the URL.
    let customDraftFailure: "missing" | "malformed" | null = null;
    if (!cardName) {
      if (presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (p) livePayload = { worldSetting: p.worldSetting, styleGuide: p.styleGuide, playerName: readStoredPlayerName() || undefined, language: locale };
      }
      if (
        !livePayload &&
        isCustom &&
        !caseStudyId &&
        !videoStoryId &&
        !storyId
      ) {
        let draftResult: ReturnType<typeof readCustomPlayDraft>;
        try {
          // Accessing sessionStorage can itself throw in restricted tabs; the
          // helper additionally guards getItem/JSON.parse.
          draftResult = readCustomPlayDraft(window.sessionStorage);
        } catch {
          draftResult = { status: "malformed" };
        }
        if (draftResult.status === "ok") {
          const parsed = draftResult.draft;
          livePayload = {
            worldSetting: parsed.worldSetting,
            styleGuide: parsed.styleGuide,
            styleReferenceImage: parsed.styleReferenceImage || undefined,
            playerName: parsed.playerName || undefined,
            language: locale,
          };
          liveAudioEnabled = parsed.audioEnabled === true;
        } else {
          customDraftFailure = draftResult.status;
        }
      }
    }

    if (customDraftFailure) {
      setCustomDraftIssue(customDraftFailure);
      return;
    }

    // Lock orientation for the whole session. Both prebaked-card and live paths
    // now respect device orientation — portrait prebaked assets live under
    // firstact-portrait/ and firstscene-portrait/.
    const sessionOrientation: Orientation = detectOrientation();
    if (livePayload) livePayload.orientation = sessionOrientation;
    // sessionLanguage flows into Session.language regardless of which start
    // path was taken (prebaked card skips /api/start, so the language has to
    // be tagged onto the local Session build for /api/scene calls).
    const sessionLanguage: string = locale;
    const initialUsageDetail = livePayload
      ? formatUsageDisclosure(
          buildUsageDisclosure({
            action: "start_custom",
            audioEnabled: liveAudioEnabled,
            prefetchDepth: readStoredBranchPrefetchDepth(),
            byokReady: readBrowserByokReady(),
          }),
          locale,
        )
      : undefined;
    setFirstFrameProgress(
      loadingProgress(
        locale,
        storyId ? 20 : caseStudyId || videoStoryId ? 22 : cardName ? 24 : 8,
        storyId ? "saved" : caseStudyId || videoStoryId || cardName ? "template" : "init",
        initialUsageDetail,
      ),
    );

    if (!cardName && !caseStudyId && !videoStoryId && !livePayload && !storyId) {
      router.replace(lp("/"));
      return;
    }

    if (caseStudyId || videoStoryId) {
      (async () => {
        try {
          const authoredId = caseStudyId || videoStoryId!;
          const savedId = caseStudyId
            ? `case:${authoredId}`
            : `video-story:${authoredId}`;
          const saved = await loadStorySession(savedId);
          const response = await fetch(
            caseStudyId
              ? `/case-studies/${encodeURIComponent(authoredId)}/story.json`
              : `/api/video-stories/${encodeURIComponent(authoredId)}`,
          );
          if (!response.ok) {
            throw new Error(
              caseStudyId
                ? "本地案例内容尚未完成入库"
                : "互动视频剧情不存在、已下线或发布物不可用",
            );
          }
          const bundle = (await response.json()) as CaseStudyPublishedBundle;
          if (
            bundle.kind !== "aistory-authored-case" ||
            bundle.session.authoredStory?.caseStudyId !== authoredId
          ) {
            throw new Error("作者锁定剧情数据格式不合法");
          }
          const publishedVersion = bundle.session.authoredStory.version;
          const resumedSaved =
            saved?.authoredStory?.caseStudyId === authoredId &&
            saved.authoredStory.version === publishedVersion;
          const caseSession = resumedSaved ? saved : bundle.session;
          const runtime = caseSession.authoredStory;
          if (!runtime) throw new Error("本地案例缺少 authored graph");
          const currentNode = findAuthoredNode(runtime, runtime.currentNodeId);
          if (!currentNode || !sceneHasRenderableMedia(currentNode.scene)) {
            throw new Error("本地案例当前画面不可用");
          }
          const currentEntry = caseSession.history.at(-1);
          const resumeScene = currentEntry?.scene ?? currentNode.scene;
          const resumeBeat = resumeScene.beats.some(
            (beat) => beat.id === runtime.currentBeatId,
          )
            ? runtime.currentBeatId
            : resumeScene.entryBeatId;
          const originalImage =
            scenePosterUrl(resumeScene) || scenePosterUrl(currentNode.scene);
          setFirstFrameProgress(loadingProgress(locale, 72, "image"));
          const blobUrl = originalImage
            ? await getOrCreateBlobUrl(originalImage)
            : null;
          lastImageOriginalUrlRef.current = originalImage ?? null;
          visitedBeatsRef.current = currentEntry?.visitedBeatIds?.length
            ? [...currentEntry.visitedBeatIds]
            : [resumeScene.entryBeatId];
          lastSavedFingerprintRef.current = resumedSaved
            ? durableSessionFingerprint(caseSession)
            : "";
          setSession(caseSession);
          sessionRef.current = caseSession;
          setCurrentScene(resumeScene);
          setCurrentBeatId(resumeBeat);
          setOrientation(coerceOrientation(caseSession.orientation));
          const ready = waitForImageReady();
          setImageUrl(blobUrl);
          await ready;
          setFirstFrameProgress(loadingProgress(locale, 100, "ready"));
          setPhase("ready");
          track("scene_reached", { scene_index: caseSession.history.length });
        } catch (error) {
          setFirstFrameProgress(loadingProgress(locale, 100, "error"));
          setError(error instanceof Error ? error.message : String(error));
        }
      })();
      return;
    }

    // ── Load saved story path ──
    if (storyId) {
      (async () => {
        // Browser-local store (IndexedDB) is async; load inside the IIFE.
        let loadedSession = await loadStorySession(storyId);
        if (!loadedSession) {
          setError(t("play.savedStoryNotFound"));
          return;
        }
        if (!loadedSession.cacheIdentity) {
          loadedSession.cacheIdentity = {
            visibility: "private",
            storyId: loadedSession.id,
            version: "saved-v1",
            ownerNamespace: loadedSession.id,
          };
        }
        if (requestedBranchId) {
          loadedSession = activateTimelineBranch(
            loadedSession,
            requestedBranchId,
          );
          void saveStory(loadedSession);
        }
        // Resume at the player's last position. Walk from the newest scene back
        // to the first and resume at the latest one that actually has a rendered
        // image: the final scene → correct position; if the very last scene
        // failed to image (committed without one), a small rewind beats a blank
        // canvas (Req 3.3). If NO scene has an image the story can't render —
        // surface savedStoryCorrupted instead of landing on getOrCreateBlobUrl("").
        const history = loadedSession.history;
        let resumeEntry = history[history.length - 1];
        for (let i = history.length - 1; i >= 0; i--) {
          if (sceneHasRenderableMedia(history[i]?.scene)) {
            resumeEntry = history[i];
            break;
          }
        }
        const resumeScene = resumeEntry?.scene;
        if (!resumeScene || !sceneHasRenderableMedia(resumeScene)) {
          setError(t("play.savedStoryCorrupted"));
          return;
        }
        // Pure read: prime the autosave fingerprint so loading doesn't re-save /
        // bump rev / reorder the list. Must match the effect's fingerprint shape
        // exactly (scene count + last-scene beat count + playerName) or the first
        // render would re-persist.
        {
          lastSavedFingerprintRef.current = durableSessionFingerprint(loadedSession);
        }
        try {
          setFirstFrameProgress(loadingProgress(locale, 72, "image"));
          const resumePoster = scenePosterUrl(resumeScene);
          const blobUrl = resumePoster
            ? await getOrCreateBlobUrl(resumePoster)
            : null;
          lastImageOriginalUrlRef.current = resumePoster ?? null;
          setSession(loadedSession);
          setCurrentScene(resumeScene);
          setCurrentBeatId(resumeScene.entryBeatId);
          setImageUrl(blobUrl);
          visitedBeatsRef.current = [resumeScene.entryBeatId];
          setOrientation(coerceOrientation(loadedSession.orientation));
          setFirstFrameProgress(loadingProgress(locale, 100, "ready"));
          setPhase("ready");
          track("scene_reached", { scene_index: loadedSession.history.length });
        } catch (e) {
          setError(String(e));
        }
      })();
      return;
    }

    type PrebakedFirstAct = StartResponse & {
      worldSetting: string;
      styleGuide: string;
      // Live /api/start path tags this on after the response (prebaked card
      // JSONs never have one — they were rendered at build time without any
      // user-uploaded reference). Carried into Session so /api/scene's painter
      // anchors the same style image on every subsequent scene.
      styleReferenceImage?: string;
      cardName?: string;
      cardTitle?: string;
      cardGender?: string;
    };

    const baseDir = sessionOrientation === "portrait"
      ? "firstact-portrait"
      : "firstact";
    const localeSuffix = locale !== "zh-CN" ? `-${locale}` : "";
    const firstactDir = `${baseDir}${localeSuffix}`;

    const startT0 = Date.now();
    const fetchStart: Promise<PrebakedFirstAct> = cardName
      ? fetch(`/home/${firstactDir}/${encodeURIComponent(cardName)}.json`).then(
          async (r) => {
            if (r.ok) return (await r.json()) as PrebakedFirstAct;
            // Fallback chain: locale-specific → zh-CN portrait → zh-CN landscape
            if (localeSuffix) {
              const zhFb = await fetch(`/home/${baseDir}/${encodeURIComponent(cardName)}.json`);
              if (zhFb.ok) return (await zhFb.json()) as PrebakedFirstAct;
            }
            if (sessionOrientation === "portrait") {
              console.warn(`[play] portrait firstact missing for ${cardName} (HTTP ${r.status}), falling back to landscape`);
              const fbDir = localeSuffix ? `firstact-${locale}` : "firstact";
              const fb = await fetch(`/home/${fbDir}/${encodeURIComponent(cardName)}.json`);
              if (fb.ok) {
                const fallback = (await fb.json()) as PrebakedFirstAct;
                return { ...fallback, scene: { ...fallback.scene, orientation: "landscape" as const } };
              }
              if (localeSuffix) {
                const zhLandscape = await fetch(`/home/firstact/${encodeURIComponent(cardName)}.json`);
                if (zhLandscape.ok) {
                  const fallback = (await zhLandscape.json()) as PrebakedFirstAct;
                  return { ...fallback, scene: { ...fallback.scene, orientation: "landscape" as const } };
                }
              }
            }
            throw new Error(t("home.errors.cardNotFound", { cardName }));
          },
        )
      : (async () => {
          const data = await startSession(
            {
              ...livePayload!,
              clientTts: !!byoTtsRef.current,
            },
            (event) => {
              const progress = progressForSceneEvent(event, locale);
              if (progress) {
                setFirstFrameProgress((prev) =>
                  mergeLoadingProgress(prev, progress),
                );
              }
            },
          );
          // startSession doesn't echo ws/sg back — splice in what we sent.
          // styleReferenceImage is similarly not in StartResponse; tag it on so
          // the session we build below carries it for every scene call.
          return {
            ...data,
            worldSetting: livePayload!.worldSetting,
            styleGuide: livePayload!.styleGuide,
            styleReferenceImage: livePayload!.styleReferenceImage,
          };
        })();

    fetchStart
      .then(async (data) => {
        setFirstFrameProgress((prev) =>
          mergeLoadingProgress(prev, loadingProgress(locale, 96, "image")),
        );
        const blobUrl = await getOrCreateBlobUrl(data.imageUrl);
        lastImageOriginalUrlRef.current = data.imageUrl;

        const initial: Session = {
          id: data.sessionId,
          createdAt: Date.now(),
          worldSetting: data.worldSetting,
          styleGuide: data.styleGuide,
          history: [
            {
              scene: data.scene,
              visitedBeatIds: [data.scene.entryBeatId],
              storyStateAfter: data.storyState,
            },
          ],
          characters: data.characters,
          storyState: data.storyState,
          styleReferenceImage: data.styleReferenceImage,
          orientation: data.scene.orientation ?? sessionOrientation,
          playerName: livePayload?.playerName || readStoredPlayerName() || undefined,
          language: sessionLanguage,
          cacheIdentity: cardName
            ? {
                visibility: "public",
                storyId: `card:${cardName}`,
                templateId: cardName,
                version: "firstact-v1",
              }
            : presetId
              ? {
                  visibility: "public",
                  storyId: `preset:${presetId}`,
                  templateId: presetId,
                  version: "preset-v1",
                }
              : {
                  visibility: "private",
                  storyId: data.sessionId,
                  version: "custom-v1",
                  ownerNamespace: data.sessionId,
                },
        };
        visitedBeatsRef.current = [data.scene.entryBeatId];
        setSession(initial);
        setCurrentScene(data.scene);
        setCurrentBeatId(data.scene.entryBeatId);
        const ready = waitForImageReady();
        setImageUrl(blobUrl);
        await ready;
        setFirstFrameProgress(loadingProgress(locale, 100, "ready"));
        setPhase("ready");
        track("scene_reached", { scene_index: initial.history.length });
      })
      .catch((e) => {
        // A first-load 401 is a paused state, not an error: do not jump the
        // canvas progress to 100%/error and do not leave a blank loading
        // screen. The paused screen keeps the draft and offers sign-in home.
        if (e instanceof AuthRequiredError) {
          markFirstLoadAuthRequired(e);
          return;
        }
        setFirstFrameProgress(loadingProgress(locale, 100, "error"));
        if (!handleAuthError(e)) {
          trackPlayError("start", e, startT0);
          if (isPlatformGenerationUnavailable(e)) {
            setPlatformGenerationUnavailable(true);
            setError(t("play.error.platformUnavailableTitle"));
          } else {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      });
  }, [
    params,
    router,
    retryBootstrap,
    restorePlayResume,
    markFirstLoadAuthRequired,
  ]);

  // ── Deferred replay of the action that hit 401 (OAuth resume) ─────────
  // After restorePlayResume commits the restored session/scene/beat, dispatch
  // the pending action so the player lands exactly where they were headed
  // (seamless continuation). Runs once the restored state is interactive,
  // then clears the slot. Mirrors the homepage's autoStartPending pattern.
  useEffect(() => {
    if (!pendingReplayAction) return;
    if (phase !== "ready" || !session || !currentScene) return;
    const action = pendingReplayAction;
    setPendingReplayAction(null);
    if (action.kind === "choice") {
      onSelectChoice(action.choice);
    } else if (action.kind === "freeform") {
      void onFreeformInput(action.text);
    } else {
      void onBackgroundClick({ x: action.x, y: action.y });
    }
    // onSelectChoice/onFreeformInput/onBackgroundClick are stable inner
    // functions keyed off the restored state; listing them would re-fire on
    // every render, so we intentionally scope deps to the readiness gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReplayAction, phase, session, currentScene]);

  // ── Prefetch on scene entry: L1 + recursive L2/L3 for must-pass ──────
  useEffect(() => {
    const s = session;
    const scene = currentScene;
    if (!s || !scene) return;
    if (isRecordedReplayLockedAt(currentBeat)) return;
    if (
      s.authoredStory?.authorLocked &&
      !isAuthoredAiContinuationAllowed(s.authoredStory)
    ) {
      clearPool(poolRef.current);
      return;
    }
    if (branchPrefetchDepth === 0) {
      clearPool(poolRef.current);
      return;
    }

    const exits = findAllChangeSceneChoices(scene).filter(
      (choice) =>
        choice.effect.kind !== "change-scene" ||
        !choice.effect.authoredTargetNodeId,
    );
    const budget: PrefetchBudget = {
      used: 0,
      max: DEFAULT_BRANCH_PREFETCH_BUDGET,
    };
    for (const choice of exits) {
      if (choice.effect.kind !== "change-scene") continue;
      const step: ScenePathStep = {
        fromScene: scene,
        // Snapshot of visited beats at prefetch start. Slight drift is OK.
        fromVisitedBeats: [...visitedBeatsRef.current],
        exit: {
          choiceId: choice.id,
          label: choice.label,
          nextSceneSeed: choice.effect.nextSceneSeed,
        },
      };
      prefetchScenePath(
        poolRef.current,
        resolvedPrefetchesRef.current,
        s,
        [step],
        0,
        !!byoTtsRef.current,
        branchPrefetchDepth,
        budget,
      );
    }
  }, [
    branchPrefetchDepth,
    currentScene?.id,
    session?.id,
    session?.visualStyleRevision,
    session?.narrativeStyleRevision,
  ]);

  // Abort all in-flight speculative prefetches when the page unmounts, so we
  // stop paying for background scene/image generation. Empty deps → fires only
  // on unmount; it must NOT run on scene transitions, which rely on
  // consumeChoice keeping the re-rooted survivor prefetches alive.
  // Also revoke any surviving blob: URLs so their bytes can be GC'd — the
  // module-level blobUrlCache outlives the component but its entries should
  // not survive the page navigation that unmounts us.
  useEffect(() => {
    const pool = poolRef.current;
    const beatAborts = beatAudioAbortRef.current;
    return () => {
      clearPool(pool);
      for (const c of beatAborts.values()) c.abort();
      beatAborts.clear();
      for (const [originalUrl] of blobUrlCache) {
        revokeBlobUrlFor(originalUrl);
      }
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────

  function onAdvance() {
    if (phase !== "ready") return;
    const beat = currentBeatRef.current;
    if (!beat || beat.next.type !== "continue") return;
    setCurrentBeatId(beat.next.nextBeatId);
  }

  function onVideoComplete(event: VideoStoryCompletion) {
    const scene = currentSceneRef.current;
    const currentSession = sessionRef.current;
    if (!scene || !currentSession) return;
    const media = coerceSceneMedia(scene);
    if (media.kind !== "video") return;
    const key = `${currentSession.timeline?.activeBranchId || "main"}:${currentSession.history.length}:${scene.id}`;
    if (videoInteractionKey === key) return;
    setVideoInteractionKey(key);
    track("video_playback_complete", {
      completion_reason: event.reason,
      scene_index: currentSession.history.length,
    });
    if (
      media.endBehavior === "advance-beat" &&
      media.authoredTargetNodeId &&
      currentSession.authoredStory
    ) {
      const choice: BeatChoice = {
        id: `${scene.id}:video-auto-advance`,
        label: "视频播放完成",
        effect: {
          kind: "change-scene",
          nextSceneSeed: `video-story:${scene.id}:auto`,
          authoredTargetNodeId: media.authoredTargetNodeId,
          ...(media.authoredVariableDelta
            ? { variableDelta: media.authoredVariableDelta }
            : {}),
        },
      };
      const changeSceneEffect = choice.effect;
      const exit: SceneExit = {
        kind: "choice",
        choiceId: choice.id,
        label: choice.label,
        nextSceneSeed:
          changeSceneEffect.kind === "change-scene"
            ? changeSceneEffect.nextSceneSeed
            : `video-story:${scene.id}:auto`,
      };
      void performAuthoredStoryTransition(
        currentSession,
        choice,
        exit,
        [...visitedBeatsRef.current],
      );
      return;
    }
    if (
      media.endBehavior === "advance-beat" &&
      currentBeatRef.current?.next.type === "continue"
    ) {
      setCurrentBeatId(currentBeatRef.current.next.nextBeatId);
    }
  }

  async function performAuthoredStoryTransition(
    baseSession: Session,
    choice: BeatChoice,
    exit: SceneExit,
    visitedForCurrent: string[],
  ): Promise<void> {
    if (choice.effect.kind !== "change-scene") return;
    const targetNodeId = choice.effect.authoredTargetNodeId;
    const runtime = baseSession.authoredStory;
    if (!runtime || !targetNodeId) return;
    const target = findAuthoredNode(runtime, targetNodeId);
    if (!target || !sceneHasRenderableMedia(target.scene)) {
      setError("案例目标节点或画面不存在");
      return;
    }
    setPhase("transitioning");
    setPendingClick(null);
    clearPool(poolRef.current);
    try {
      const originalImage = scenePosterUrl(target.scene);
      const blobUrl = originalImage
        ? await getOrCreateBlobUrl(originalImage)
        : null;
      let nextSession = transitionAuthoredStorySession(
        baseSession,
        choice,
        exit,
        visitedForCurrent,
      ).session;
      visitedBeatsRef.current = [target.scene.entryBeatId];
      nextSession = updateActiveTimelineSnapshot(
        nextSession,
        target.scene.id,
        target.scene.entryBeatId,
        visitedBeatsRef.current,
      );
      sessionRef.current = nextSession;
      setSession(nextSession);
      setCurrentScene(target.scene);
      setCurrentBeatId(target.scene.entryBeatId);
      lastImageOriginalUrlRef.current = originalImage ?? null;
      const ready = waitForImageReady();
      setImageUrl(blobUrl);
      setLastExitLabel(choice.label);
      await ready;
      setPhase("ready");
      track("scene_reached", { scene_index: nextSession.history.length });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setPhase("ready");
    }
  }

  async function performSceneTransition(
    source: PrefetchEntry | Promise<SceneResponse>,
    exit: SceneExit,
    visitedForCurrent: string[],
    exitLabel: string,
    retry?: () => void,
    action?: PendingResumeAction,
  ) {
    const sceneT0 = Date.now();
    setPhase("transitioning");
    setPendingClick(null);
    try {
      const result = await ("promise" in source ? source.promise : source);

      const base = sessionRef.current;
      if (!base) throw new Error("Session lost mid-transition");

      // Pull full image bytes into a local blob: URL before committing. For
      // prefetched scenes the speculative getOrCreateBlobUrl in
      // prefetchScenePath already has this in flight (often resolved), so
      // this is a near-instant cache lookup. For cold transitions we eat the
      // CDN download / preload time under the "transitioning" overlay. Proxy
      // path: the <img> then gets a fully-local blob (no progressive paint);
      // direct path (default): the preloaded original URL.
      const blobUrl = await getOrCreateBlobUrl(result.imageUrl);
      // Revoke the previous scene's blob (no longer rendered) to release JS
      // heap. New scene's original URL takes its place as "current".
      const priorOriginal = lastImageOriginalUrlRef.current;
      if (priorOriginal && priorOriginal !== result.imageUrl) {
        revokeBlobUrlFor(priorOriginal);
      }
      lastImageOriginalUrlRef.current = result.imageUrl;

      const closedHistory = base.history.map((h, i, arr) =>
        i === arr.length - 1
          ? { ...h, visitedBeatIds: visitedForCurrent, exit }
          : h,
      );
      let newSession: Session = {
        ...base,
        history: [
          ...closedHistory,
          {
            scene: result.scene,
            visitedBeatIds: [result.scene.entryBeatId],
            storyStateAfter: result.storyState,
          },
        ],
        characters: result.characters,
        storyState: result.storyState,
      };
      visitedBeatsRef.current = [result.scene.entryBeatId];
      newSession = updateActiveTimelineSnapshot(
        newSession,
        result.scene.id,
        result.scene.entryBeatId,
        visitedBeatsRef.current,
      );
      sessionRef.current = newSession;
      setSession(newSession);
      setCurrentScene(result.scene);
      setCurrentBeatId(result.scene.entryBeatId);
      const ready = waitForImageReady();
      setImageUrl(blobUrl);
      setLastExitLabel(exitLabel);
      await ready;
      setPhase("ready");
      track("scene_reached", { scene_index: newSession.history.length });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") {
        setPhase("ready");
        return;
      }
      if (!handleAuthError(e, retry, action)) {
        trackPlayError("scene", e, sceneT0);
        setError(String(e));
      }
      setPhase("ready");
    }
  }

  function tryRecordedSceneTransition(
    choice: BeatChoice,
    exit: SceneExit,
    visitedForCurrent: string[],
  ): boolean {
    const source = replaySourceRef.current;
    const idx = replayIndexRef.current;
    if (!source || idx < 0 || !isRecordedReplayLockedAt(currentBeatRef.current)) {
      return false;
    }

    const recorded = source.history[idx];
    const next = source.history[idx + 1];
    if (
      !recorded ||
      !next ||
      recorded.exit?.kind !== "choice" ||
      recorded.exit.choiceId !== choice.id
    ) {
      detachRecordedReplay();
      return false;
    }

    void (async () => {
      const replayT0 = Date.now();
      setPhase("transitioning");
      setPendingClick(null);
      try {
        if (!sceneHasRenderableMedia(next.scene)) {
          throw new Error(t("play.shareErrors.noNextImage"));
        }
        const nextPoster = scenePosterUrl(next.scene);
        const blobUrl = nextPoster
          ? await getOrCreateBlobUrl(nextPoster)
          : null;
        const priorOriginal = lastImageOriginalUrlRef.current;
        if (priorOriginal && priorOriginal !== nextPoster) {
          revokeBlobUrlFor(priorOriginal);
        }
        lastImageOriginalUrlRef.current = nextPoster ?? null;

        const base = sessionRef.current;
        if (!base) throw new Error("Session lost mid-replay");
        const closedHistory = base.history.map((h, i, arr) =>
          i === arr.length - 1
            ? { ...h, visitedBeatIds: visitedForCurrent, exit }
            : h,
        );
        const nextIndex = idx + 1;
        const nextSession: Session = {
          ...base,
          history: [
            ...closedHistory,
            {
              ...next,
              visitedBeatIds: [next.scene.entryBeatId],
              exit: undefined,
            },
          ],
          characters: source.characters,
          storyState: next.storyStateAfter ?? base.storyState,
          orientation: next.scene.orientation ?? base.orientation,
        };
        replayIndexRef.current = nextIndex;
        replayActiveRef.current = true;
        visitedBeatsRef.current = [next.scene.entryBeatId];
        setSession(nextSession);
        setCurrentScene(next.scene);
        setCurrentBeatId(next.scene.entryBeatId);
        const ready = waitForImageReady();
        setImageUrl(blobUrl);
        setLastExitLabel(choice.label);
        await ready;
        setPhase("ready");
        track("scene_reached", { scene_index: nextSession.history.length });
      } catch (e) {
        if (!handleAuthError(e)) {
          trackPlayError("scene", e, replayT0);
          setError(e instanceof Error ? e.message : String(e));
        }
        setPhase("ready");
      }
    })();

    return true;
  }

  function recordedAllowedChoiceIds(beat: Beat | null): Set<string> | null {
    if (!replaySourceRef.current || !beat || beat.next.type !== "choice") return null;
    const source = replaySourceRef.current;
    const recorded = source?.history[replayIndexRef.current];
    if (!recorded) return new Set();

    const visited = recorded.visitedBeatIds;
    const beatIdx = visited.indexOf(beat.id);
    if (beatIdx < 0) return null;
    const nextVisited = beatIdx >= 0 ? visited[beatIdx + 1] : undefined;
    const allowed = new Set<string>();
    if (nextVisited) {
      for (const choice of beat.next.choices) {
        if (
          choice.effect.kind === "advance-beat" &&
          choice.effect.targetBeatId === nextVisited
        ) {
          allowed.add(choice.id);
        }
      }
      return allowed;
    }

    if (
      beatIdx === visited.length - 1 &&
      recorded.exit?.kind === "choice" &&
      source.history[replayIndexRef.current + 1]
    ) {
      allowed.add(recorded.exit.choiceId);
      return allowed;
    }
    return null;
  }

  function isRecordedReplayLockedAt(beat: Beat | null): boolean {
    if (!replaySourceRef.current || !beat) return false;
    const recorded = replaySourceRef.current.history[replayIndexRef.current];
    if (!recorded) return false;
    const beatIdx = recorded.visitedBeatIds.indexOf(beat.id);
    if (beatIdx < 0) return false;
    return Boolean(
      recorded.visitedBeatIds[beatIdx + 1] ||
        (
          beatIdx === recorded.visitedBeatIds.length - 1 &&
          recorded.exit?.kind === "choice" &&
          replaySourceRef.current.history[replayIndexRef.current + 1]
        ),
    );
  }

  function isDisabledByRecordedReplay(choice: BeatChoice): boolean {
    const allowed = recordedAllowedChoiceIds(currentBeatRef.current);
    return allowed !== null && !allowed.has(choice.id);
  }

  function onSelectChoice(choice: BeatChoice) {
    if (phase !== "ready" || !session || !currentScene) return;
    if (isDisabledByRecordedReplay(choice)) return;
    if (
      session.authoredStory &&
      !isAuthoredChoiceAvailable(choice, session.authoredStory.variables)
    ) {
      return;
    }

    const beatNext = currentBeatRef.current?.next;
    const choiceIndex =
      beatNext?.type === "choice"
        ? beatNext.choices.findIndex((c) => c.id === choice.id)
        : -1;
    if (choiceIndex >= 0) {
      track("choice_select", {
        scene_index: session.history.length,
        choice_index: choiceIndex,
        kind: choice.effect.kind,
      });
    }

    if (choice.effect.kind === "advance-beat") {
      if (replayActiveRef.current && currentBeatRef.current) {
        const source = replaySourceRef.current;
        const idx = replayIndexRef.current;
        const recorded = source?.history[idx];
        const recordedVisited = recorded?.visitedBeatIds ?? [];
        const beatIdx = recordedVisited.indexOf(currentBeatRef.current.id);
        const recordedNext = beatIdx >= 0 ? recordedVisited[beatIdx + 1] : undefined;
        if (recordedNext && recordedNext !== choice.effect.targetBeatId) {
          detachRecordedReplay();
        }
      } else if (
        replaySourceRef.current &&
        !isRecordedReplayLockedAt(currentBeatRef.current)
      ) {
        detachRecordedReplay();
      }
      // Pure local jump. No network. No pool changes.
      setCurrentBeatId(choice.effect.targetBeatId);
      return;
    }

    const visited = [...visitedBeatsRef.current];
    const exit: SceneExit = {
      kind: "choice",
      choiceId: choice.id,
      label: choice.label,
      nextSceneSeed: choice.effect.nextSceneSeed,
    };

    if (tryRecordedSceneTransition(choice, exit, visited)) return;
    if (replaySourceRef.current) detachRecordedReplay();

    const decisionBeat = currentBeatRef.current;
    const timelineSession =
      decisionBeat?.next.type === "choice"
        ? recordTimelineDecision(
            session,
            currentScene,
            decisionBeat,
            choice,
            visited,
          )
        : session;
    if (
      choice.effect.authoredTargetNodeId &&
      timelineSession.authoredStory
    ) {
      void performAuthoredStoryTransition(
        timelineSession,
        choice,
        exit,
        visited,
      );
      return;
    }
    if (isAuthorLockedScene(timelineSession)) {
      // Nonfatal: authored scenes stay playable, but a non-authored fallback
      // must never trigger a provider request.
      showPlayNotice("作者锁定章节只能使用原稿选项继续");
      clearPool(poolRef.current);
      return;
    }
    sessionRef.current = timelineSession;
    setSession(timelineSession);

    const cached = consumeChoice(poolRef.current, choice.id);
    if (cached) {
      void promoteSpeculativeBranch(cached.request);
      void performSceneTransition(
        cached,
        exit,
        visited,
        choice.label,
        () => onSelectChoice(choice),
        { kind: "choice", choice },
      );
      return;
    }

    // Cold path — start a fresh fetch
    const step: ScenePathStep = {
      fromScene: currentScene,
      fromVisitedBeats: visited,
      exit: {
        choiceId: choice.id,
        label: choice.label,
        nextSceneSeed: choice.effect.nextSceneSeed,
      },
    };
    const specSession = buildSpeculativeSession(timelineSession, [step]);
    clearPool(poolRef.current);

    const sceneRequest: SceneRequest = {
      session: specSession,
      clientTts: !!byoTtsRef.current,
      speculation:
        branchPrefetchDepth === 0
          ? undefined
          : {
              mode: "foreground",
              requestedDepth: branchPrefetchDepth,
              branchOrdinal: 0,
              includeAudio: false,
            },
    };
    const promise = (async () => {
      const data = await requestScene(sceneRequest);
      return data;
    })();

    void performSceneTransition(
      promise,
      exit,
      visited,
      choice.label,
      () => onSelectChoice(choice),
      { kind: "choice", choice },
    );
  }

  async function onFreeformInput(text: string) {
    if (phase !== "ready" || !session || !currentScene) return;
    if (isAuthorLockedScene(session)) {
      // Nonfatal authored-lock guard: no provider request, keep the scene.
      showPlayNotice("作者锁定章节只能使用原稿选项继续");
      return;
    }
    // Detach if we're still replaying a shared story (gate on replaySourceRef,
    // not replayActiveRef — the latter is false for a single-scene share, which
    // would otherwise leave us "stuck" in replay and block autosave forever).
    if (replaySourceRef.current) detachRecordedReplay();

    track("freeform_input", {
      scene_index: session.history.length,
      text_length: text.length,
    });

    const freeformT0 = Date.now();
    setPhase("vision-thinking");

    try {
      // Always generate a new scene for freeform text input — the player
      // typed something, so they expect the story to move forward.
      const visited = [...visitedBeatsRef.current];
      const exit: SceneExit = {
        kind: "freeform",
        action: text,
      };
      clearPool(poolRef.current);

      const specSession: Session = {
        ...session,
        history: session.history.map((h, i, arr) =>
          i === arr.length - 1
            ? { ...h, visitedBeatIds: visited, exit }
            : h,
        ),
      };

      const promise = (async () => {
        const data = await requestScene({
          session: specSession,
          clientTts: !!byoTtsRef.current,
        });
        return data;
      })();

      setPendingClick(null);
      void performSceneTransition(
        promise,
        exit,
        visited,
        text,
        () => onFreeformInput(text),
        { kind: "freeform", text },
      );
    } catch (e) {
      if (!handleAuthError(e, () => onFreeformInput(text), { kind: "freeform", text })) {
        trackPlayError("freeform", e, freeformT0);
        setError(String(e));
      }
      setPhase("ready");
    }
  }

  async function onBackgroundClick(click: { x: number; y: number }) {
    if (phase !== "ready" || !session || !currentScene || !imageUrl) return;
    if (isAuthorLockedScene(session)) {
      // Nonfatal authored-lock guard: no vision/insert-beat provider request.
      showPlayNotice("作者锁定章节不启用画面识别或 AI 改写");
      return;
    }
    // Gate on replaySourceRef, not replayActiveRef (false for a single-scene
    // share) — see onFreeformInput for the rationale.
    if (replaySourceRef.current) detachRecordedReplay();
    const visionT0 = Date.now();
    setPhase("vision-thinking");
    setPendingClick(click);

    try {
      const annotatedImageBase64 = await annotateClick(imageUrl, click);
      const decision = await visionDecide({
        session,
        annotatedImageBase64,
      });
      track("vision_click", { result: decision.classify });

      if (decision.classify === "insert-beat") {
        setPhase("inserting-beat");
        const { partial, extraBeats, characters: insertChars } = await requestInsertBeat({
          session,
          freeformAction: decision.intent.freeformAction,
          clientTts: !!byoTtsRef.current,
        });

        const fromBeatId =
          currentBeatRef.current?.id ?? currentScene.entryBeatId;
        const allPartials = [partial, ...(extraBeats ?? [])];
        const newBeats: Beat[] = [];
        const newBeatIds: string[] = [];

        for (const [i, p] of allPartials.entries()) {
          const id = `b_ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${i}`;
          newBeatIds.push(id);
          newBeats.push({
            id,
            narration: p.narration,
            speaker: p.speaker,
            line: p.line,
            lineDelivery: p.lineDelivery,
            next: { type: "continue", nextBeatId: "" },
          });
        }

        // Chain beats: each points to the next; last one loops back to original beat
        for (let i = 0; i < newBeats.length - 1; i++) {
          newBeats[i]!.next = { type: "continue", nextBeatId: newBeatIds[i + 1]! };
        }
        newBeats[newBeats.length - 1]!.next = { type: "continue", nextBeatId: fromBeatId };

        const patched: Scene = {
          ...currentScene,
          beats: [...currentScene.beats, ...newBeats],
        };
        const nextVisited = [...visitedBeatsRef.current, ...newBeatIds];
        visitedBeatsRef.current = nextVisited;

        const nextSession: Session = {
          ...session,
          history: session.history.map((h, i, arr) =>
            i === arr.length - 1 ? { ...h, scene: patched, visitedBeatIds: nextVisited } : h,
          ),
          characters: insertChars,
        };
        setSession(nextSession);
        setCurrentScene(patched);
        setCurrentBeatId(newBeatIds[0]!);

        for (const nb of newBeats) {
          if (nb.speaker && nb.line) {
            void fetchBeatAudio(nextSession, {
              id: nb.id,
              speaker: nb.speaker,
              line: nb.line,
              lineDelivery: nb.lineDelivery,
            });
          }
        }
        setLastExitLabel(decision.intent.freeformAction);
        setPhase("ready");
        setPendingClick(null);
      } else {
        const exit: SceneExit = {
          kind: "freeform",
          action: decision.intent.freeformAction,
        };
        const visited = [...visitedBeatsRef.current];
        const base = sessionRef.current;
        if (!base) {
          setPhase("ready");
          setPendingClick(null);
          return;
        }
        const specSession: Session = {
          ...base,
          history: base.history.map((h, i, arr) =>
            i === arr.length - 1 ? { ...h, visitedBeatIds: visited, exit } : h,
          ),
        };
        clearPool(poolRef.current);

        const promise = (async () => {
          const data = await requestScene({
            session: specSession,
            clientTts: !!byoTtsRef.current,
          });
          return data;
        })();

        await performSceneTransition(
          promise,
          exit,
          visited,
          decision.intent.freeformAction,
          () => onBackgroundClick(click),
          { kind: "background-click", x: click.x, y: click.y },
        );
      }
    } catch (e) {
      if (!handleAuthError(e, () => onBackgroundClick(click), { kind: "background-click", x: click.x, y: click.y })) {
        trackPlayError("vision", e, visionT0);
        setError(String(e));
      }
      setPendingClick(null);
      setPhase("ready");
    }
  }

  function commitStyleSelection(selection: StyleSelection): Session | null {
    const base = sessionRef.current;
    if (!base) return null;
    // Old-style work may still finish into its own revisioned cache, but it
    // must leave the active pool so it can never be consumed after a switch.
    for (const entry of poolRef.current.values()) {
      void cancelSpeculativeBranch(entry.request);
    }
    clearPool(poolRef.current);
    const next = applyStyleToSession(base, selection);
    sessionRef.current = next;
    setSession(next);
    return next;
  }

  function handleApplyStyleNext(selection: StyleSelection): void {
    const next = commitStyleSelection(selection);
    if (!next) return;
    setStyleFeedback(
      branchPrefetchDepth === 0
        ? "已保存；从下一段生效。分支预生成保持关闭。"
        : `已保存；从下一段生效，并按 ${branchPrefetchDepth} 层重新预生成。`,
    );
  }

  async function handleRedrawCurrent(selection: StyleSelection): Promise<void> {
    const next = commitStyleSelection(selection);
    const scene = currentSceneRef.current;
    if (!next || !scene) return;
    setStyleBusy("visual");
    setStyleFeedback("新风格生成中，当前画面会保持显示。");
    try {
      const result = await applyStyleHotSwap({
        action: "redraw-current",
        session: next,
        sceneId: scene.id,
      });
      if (result.action !== "redraw-current") return;
      if (result.status === "image_pending") {
        setStyleFeedback("图片服务繁忙，旧图已保留。可稍后重试。");
        return;
      }
      const blobUrl = await getOrCreateBlobUrl(result.imageUrl);
      const updatedScene: Scene = {
        ...scene,
        imageUrl: result.imageUrl,
        imageUuid: result.imageUuid,
      };
      const updatedSession: Session = {
        ...next,
        history: next.history.map((entry) =>
          entry.scene.id === scene.id ? { ...entry, scene: updatedScene } : entry,
        ),
      };
      sessionRef.current = updatedSession;
      setSession(updatedSession);
      setCurrentScene(updatedScene);
      lastImageOriginalUrlRef.current = result.imageUrl;
      setImageUrl(blobUrl);
      setStyleFeedback(
        result.cacheStatus === "hit" ? "已切回缓存画面。" : "新风格画面已应用。",
      );
    } catch (error) {
      setStyleFeedback(
        error instanceof Error
          ? error.message
          : "重绘失败，旧图保持不变。可稍后重试。",
      );
    } finally {
      setStyleBusy(null);
    }
  }

  async function handleRewriteCurrent(selection: StyleSelection): Promise<void> {
    const activeSession = sessionRef.current;
    if (
      activeSession?.authoredStory?.authorLocked &&
      !isAuthoredAiContinuationAllowed(activeSession.authoredStory)
    ) {
      setStyleFeedback("作者锁定章节不允许 AI 改写原稿。");
      return;
    }
    const next = commitStyleSelection(selection);
    const scene = currentSceneRef.current;
    if (!next || !scene) return;
    setStyleBusy("narrative");
    setStyleFeedback("正在改写表达；剧情事实与选项保持不变。");
    try {
      const result = await applyStyleHotSwap({
        action: "rewrite-current",
        session: next,
        sceneId: scene.id,
      });
      if (result.action !== "rewrite-current") return;
      const updatedScene: Scene = {
        ...scene,
        canonicalBeats: scene.canonicalBeats ?? scene.beats,
        beats: result.beats,
      };
      const updatedSession: Session = {
        ...next,
        history: next.history.map((entry) =>
          entry.scene.id === scene.id ? { ...entry, scene: updatedScene } : entry,
        ),
      };
      cancelBeatAudioFetches();
      setBeatAudioMap((previous) => {
        for (const url of Object.values(previous)) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        }
        return {};
      });
      sessionRef.current = updatedSession;
      setSession(updatedSession);
      setCurrentScene(updatedScene);
      setStyleFeedback(
        result.cacheStatus === "hit" ? "已恢复缓存文风。" : "当前段落表达已更新。",
      );
    } catch (error) {
      setStyleFeedback(
        error instanceof Error
          ? error.message
          : "改写失败，当前文字保持不变。可稍后重试。",
      );
    } finally {
      setStyleBusy(null);
    }
  }

  async function handleReselectDecision(
    decision: TimelineDecision,
    choiceId: string,
  ): Promise<void> {
    const choice = decision.choices.find((item) => item.id === choiceId);
    const base = sessionRef.current;
    const scene = currentSceneRef.current;
    const beatId = currentBeatRef.current?.id;
    if (!base || !scene || !beatId || !choice) return;
    if (
      !window.confirm("将从此处创建新时间线，原路线仍会保留。")
    ) {
      return;
    }
    try {
      const preserved = updateActiveTimelineSnapshot(
        base,
        scene.id,
        beatId,
        visitedBeatsRef.current,
      );
      const forked = forkTimelineAtDecision(
        preserved,
        decision.id,
        choiceId,
      );
      if (
        forked.session.authoredStory &&
        !isAuthoredChoiceAvailable(
          choice,
          forked.session.authoredStory.variables,
        )
      ) {
        setError("该选项在此时间线的变量条件下不可用");
        return;
      }
      clearPool(poolRef.current);
      sessionRef.current = forked.session;
      setSession(forked.session);
      const restoredEntry = forked.session.history.at(-1);
      if (!restoredEntry) throw new Error("时间线快照缺少场景");
      visitedBeatsRef.current = [...restoredEntry.visitedBeatIds];

      if (forked.reused) {
        const restoredScene = restoredEntry.scene;
        if (!sceneHasRenderableMedia(restoredScene)) {
          throw new Error("该时间线的画面尚不可用");
        }
        const restoredImage = scenePosterUrl(restoredScene);
        const blobUrl = restoredImage
          ? await getOrCreateBlobUrl(restoredImage)
          : null;
        setCurrentScene(restoredScene);
        setCurrentBeatId(
          restoredEntry.visitedBeatIds.at(-1) || restoredScene.entryBeatId,
        );
        setImageUrl(blobUrl);
        lastImageOriginalUrlRef.current = restoredImage ?? null;
        setPhase("ready");
        void saveStory(forked.session);
        return;
      }

      if (choice.effect.kind !== "change-scene") {
        throw new Error("该选项不能创建新场景分支");
      }
      const exit: SceneExit = {
        kind: "choice",
        choiceId: choice.id,
        label: choice.label,
        nextSceneSeed: choice.effect.nextSceneSeed,
      };
      if (
        choice.effect.authoredTargetNodeId &&
        forked.session.authoredStory
      ) {
        await performAuthoredStoryTransition(
          forked.session,
          choice,
          exit,
          restoredEntry.visitedBeatIds,
        );
        return;
      }
      if (
        forked.session.authoredStory?.authorLocked &&
        !isAuthoredAiContinuationAllowed(forked.session.authoredStory)
      ) {
        throw new Error("作者锁定章节只能按原稿选项创建时间线");
      }
      const request: SceneRequest = {
        session: forked.session,
        clientTts: !!byoTtsRef.current,
        speculation:
          branchPrefetchDepth === 0
            ? undefined
            : {
                mode: "foreground",
                requestedDepth: branchPrefetchDepth,
                branchOrdinal: 0,
                includeAudio: false,
              },
      };
      await performSceneTransition(
        requestScene(request),
        exit,
        restoredEntry.visitedBeatIds,
        choice.label,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  const replayAllowedChoiceIds = recordedAllowedChoiceIds(currentBeat);
  const disabledReplayChoiceIds =
    replayAllowedChoiceIds && currentBeat?.next.type === "choice"
      ? currentBeat.next.choices
          .filter((choice) => !replayAllowedChoiceIds.has(choice.id))
          .map((choice) => choice.id)
      : [];
  const disabledConditionChoiceIds =
    currentBeat?.next.type === "choice" && session?.authoredStory
      ? currentBeat.next.choices
          .filter(
            (choice) =>
              !isAuthoredChoiceAvailable(
                choice,
                session.authoredStory!.variables,
              ),
          )
          .map((choice) => choice.id)
      : [];
  const disabledChoiceIds = [
    ...new Set([
      ...disabledReplayChoiceIds,
      ...disabledConditionChoiceIds,
    ]),
  ];
  const replayLocked = isRecordedReplayLockedAt(currentBeat);
  // Authored-locked scenes keep only their authored transitions. Freeform text
  // and vision/background clicks are plain AI continuations, so hide those
  // affordances in BOTH PlayCanvas layouts rather than letting them fall into a
  // handler that must reject the request afterwards.
  const authorLockedScene = isAuthorLockedScene(session);
  const recoveryCopy = playIssueRecoveryCopy(locale);
  const importRecoveryCopy = STORY_IMPORT_RECOVERY_COPY;

  if (customDraftIssue) {
    return (
      <div className="ui-page flex min-h-screen items-center justify-center px-5 py-10">
        <div className="ui-surface w-full max-w-xl rounded-2xl p-6 text-center shadow-[0_24px_70px_rgba(49,91,255,0.12)] sm:p-9">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ember-500/10 text-ember-500">
            <i className="fa-solid fa-file-circle-exclamation text-lg" />
          </span>
          <p className="mt-5 text-[10px] smallcaps text-clay-500">
            {recoveryCopy.customDraftEyebrow}
          </p>
          <h1 className="mt-3 font-serif text-2xl font-semibold text-clay-900">
            {recoveryCopy.customDraftTitle}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-clay-600">
            {recoveryCopy.customDraftBody}
          </p>
          <p className="mx-auto mt-3 max-w-md rounded-xl bg-cream-100 px-4 py-3 text-xs leading-6 text-clay-500">
            {customDraftIssue === "malformed"
              ? recoveryCopy.customDraftMalformedNote
              : recoveryCopy.customDraftMissingNote}
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href={safeReturn.href}
              className="ui-button-primary min-h-11 rounded-xl px-5 py-3 text-sm"
            >
              <i className="fa-solid fa-arrow-left" />
              {safeReturn.fromReturnTo
                ? safeReturn.label
                : recoveryCopy.customDraftHome}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (importIssue) {
    // Dedicated recovery for ?share=1 when this tab has no usable imported
    // story file. It deliberately renders before the generic first-load error
    // and never offers the settings/models route: the file is missing or
    // corrupt, so no provider retry could help and no paid generation is
    // started.
    return (
      <div className="ui-page flex min-h-screen items-center justify-center px-5 py-10">
        <div className="ui-surface w-full max-w-xl rounded-2xl p-6 text-center shadow-[0_24px_70px_rgba(49,91,255,0.12)] sm:p-9">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ember-500/10 text-ember-500">
            <i className="fa-solid fa-file-circle-exclamation text-lg" />
          </span>
          <p className="mt-5 text-[10px] smallcaps text-clay-500">
            {importRecoveryCopy.eyebrow}
          </p>
          <h1 className="mt-3 font-serif text-2xl font-semibold text-clay-900">
            {importIssue === "missing"
              ? importRecoveryCopy.missingTitle
              : importRecoveryCopy.malformedTitle}
          </h1>
          {/* Fixed copy only — the raw storage/parse error and any imported
              story content must never be rendered here. */}
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-clay-600">
            {importRecoveryCopy.body}
          </p>
          <p className="mx-auto mt-3 max-w-md rounded-xl bg-cream-100 px-4 py-3 text-xs leading-6 text-clay-500">
            {importIssue === "missing"
              ? importRecoveryCopy.missingNote
              : importIssue === "unavailable"
                ? importRecoveryCopy.unavailableNote
                : importRecoveryCopy.malformedNote}
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            {/* Intentionally the localized home, never an arbitrary returnTo:
                the story file has to be re-imported from home. */}
            <Link
              href={lp("/")}
              className="ui-button-primary min-h-11 rounded-xl px-5 py-3 text-sm"
            >
              <i className="fa-solid fa-arrow-left" />
              {importRecoveryCopy.homeImport}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (firstLoadAuthRequirement) {
    return (
      <div className="ui-page flex min-h-screen items-center justify-center px-5 py-10">
        <div className="ui-surface w-full max-w-xl rounded-2xl p-6 text-center shadow-[0_24px_70px_rgba(49,91,255,0.12)] sm:p-9">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ember-500/10 text-ember-500">
            <i className="fa-solid fa-lock text-lg" />
          </span>
          <p className="mt-5 text-[10px] smallcaps text-clay-500">
            {recoveryCopy.authPausedEyebrow}
          </p>
          <h1 className="mt-3 font-serif text-2xl font-semibold text-clay-900">
            {recoveryCopy.authPausedTitle}
          </h1>
          {/* The paused screen shows only fixed localized copy. The raw
              backend/AuthRequiredError text must never be rendered here; the
              requirement object is still handed to AuthModal, which owns
              sanitizing its own body. */}
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-clay-600">
            {recoveryCopy.authPausedBody}
          </p>
          <p className="mx-auto mt-3 max-w-md rounded-xl bg-cream-100 px-4 py-3 text-xs leading-6 text-clay-500">
            {recoveryCopy.authPausedDraftNote}
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => {
                setAuthRequirement(firstLoadAuthRequirement);
                setAuthModalOpen(true);
              }}
              className="ui-button-primary min-h-11 rounded-xl px-5 py-3 text-sm"
            >
              <i className="fa-solid fa-right-to-bracket" />
              {recoveryCopy.authReopenLogin}
            </button>
            <Link
              href={safeReturn.href}
              className="ui-button-secondary min-h-11 rounded-xl px-5 py-3 text-sm"
            >
              <i className="fa-solid fa-house" />
              {safeReturn.fromReturnTo ? safeReturn.label : recoveryCopy.authHome}
            </Link>
          </div>
        </div>
        {authModalOpen && (
          <AuthModal
            onClose={closeAuthModal}
            onSuccess={completeAuthModal}
            requirement={authRequirement}
          />
        )}
      </div>
    );
  }

  if (error && !hasPreservedCanvas) {
    if (platformGenerationUnavailable) {
      return (
        <div className="ui-page flex min-h-screen items-center justify-center px-5 py-10">
          <div className="ui-surface w-full max-w-xl rounded-2xl p-6 text-center shadow-[0_24px_70px_rgba(49,91,255,0.12)] sm:p-9">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ember-500/10 text-ember-500">
              <i className="fa-solid fa-wand-magic-sparkles text-lg" />
            </span>
            <p className="mt-5 text-[10px] smallcaps text-clay-500">
              {t("play.error.platformUnavailableEyebrow")}
            </p>
            <h1 className="mt-3 font-serif text-2xl font-semibold text-clay-900">
              {t("play.error.platformUnavailableTitle")}
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-clay-600">
              {t("play.error.platformUnavailableDescription")}
            </p>
            <p className="mx-auto mt-3 max-w-md rounded-xl bg-cream-100 px-4 py-3 text-xs leading-6 text-clay-500">
              {t("play.error.platformUnavailableSafety")}
            </p>
            <p className="mx-auto mt-3 max-w-md text-xs leading-6 text-clay-500">
              {firstLoadErrorCopy.safetyNote}
            </p>
            <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
              <Link
                href={lp("/stories")}
                className="ui-button-primary min-h-11 rounded-xl px-5 py-3 text-sm"
              >
                <i className="fa-solid fa-book-open" />
                {t("play.error.chooseFreeStory")}
              </Link>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="ui-button-secondary min-h-11 rounded-xl px-5 py-3 text-sm"
              >
                <i className="fa-solid fa-key" />
                {t("play.error.configureByok")}
              </button>
              <a
                href={safeReturn.href}
                className="ui-button-secondary min-h-11 rounded-xl px-5 py-3 text-sm"
              >
                <i className="fa-solid fa-arrow-left" />
                {firstLoadErrorCopy.backLabel}
              </a>
            </div>
          </div>
          {settingsOpen && (
            <SettingsModal
              initialTab="models"
              initialVisionClickEnabled={visionClickEnabled}
              onClose={() => setSettingsOpen(false)}
              onSaved={handleSettingsSaved}
              footerNote={t("play.settingsFooter")}
            />
          )}
        </div>
      );
    }
    return (
      <div className="ui-page min-h-screen flex flex-col items-center justify-center px-8">
        <div className="ui-surface max-w-md rounded-2xl p-8 text-center shadow-[0_24px_70px_rgba(49,91,255,0.1)] animate-fade-in">
          <p className="text-[10px] smallcaps text-clay-500 mb-6">
            {firstLoadErrorCopy.eyebrow}
          </p>
          <h1 className="font-serif text-clay-900 text-lg leading-[1.7]">
            {firstLoadErrorCopy.title}
          </h1>
          <p className="mt-3 font-serif text-clay-700 text-sm leading-7">
            {firstLoadErrorCopy.body}
          </p>
          <p className="mt-4 rounded-xl bg-cream-100 px-4 py-3 text-xs leading-6 text-clay-500">
            {firstLoadErrorCopy.safetyNote}
          </p>
          {/* First load has no canvas to preserve, so give the player a real
              next step: inspect the model/settings, or pick a ready demo. */}
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="ui-button-primary min-h-11 rounded-xl px-5 py-3 text-sm"
              data-first-load-action="settings"
            >
              <i className="fa-solid fa-sliders" />
              {PLAY_FIRST_LOAD_SETTINGS_LABEL}
            </button>
            <Link
              href={lp("/stories")}
              className="ui-button-secondary min-h-11 rounded-xl px-5 py-3 text-sm"
              data-first-load-action="demo"
            >
              <i className="fa-solid fa-book-open" />
              {PLAY_FIRST_LOAD_DEMO_LABEL}
            </Link>
            <a
              href={safeReturn.href}
              className="ui-button-secondary min-h-11 rounded-xl px-5 py-3 text-sm"
            >
              <i className="fa-solid fa-arrow-left" />
              {firstLoadErrorCopy.backLabel}
            </a>
          </div>
        </div>
        {settingsOpen && (
          <SettingsModal
            initialTab="models"
            initialVisionClickEnabled={visionClickEnabled}
            onClose={() => setSettingsOpen(false)}
            onSaved={handleSettingsSaved}
            footerNote={t("play.settingsFooter")}
          />
        )}
      </div>
    );
  }

  // Mobile portrait renders full-bleed by default — it sidesteps the iOS
  // Safari Fullscreen API (unsupported on iPhone) with a CSS full-viewport
  // layout instead. Desktop "presentation" mode shares the same immersive
  // canvas, toggled via the F key.
  const immersive = presentation || orientation === "portrait";

  if (immersive) {
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black">
        <div
          className={`flex min-h-full w-full flex-col items-center justify-center ${
            endOfDemoNotice ? "pb-4" : ""
          }`}
        >
        <SteamDesktopBridge enabled={steamChannel} />
        <PlayCanvas
          scene={currentScene}
          imageUrl={imageUrl}
          audioSrc={currentSceneMedia.kind === "video" && currentSceneMedia.hasAudio ? null : audioSrc}
          muted={muted}
          phase={phase}
          beat={currentBeat}
          pendingClick={pendingClick}
          onBackgroundClick={onBackgroundClick}
          onAdvance={onAdvance}
          onSelectChoice={onSelectChoice}
          onFreeformInput={authorLockedScene ? undefined : onFreeformInput}
          orientation={orientation}
          playerName={session?.playerName}
          characters={session?.characters ?? []}
          visionClickEnabled={
            !authorLockedScene &&
            visionClickEnabled &&
            (!currentScene || videoAllowsSceneInteraction(currentScene))
          }
          onOpenSettings={() => {
            setSettingsOpen(true);
            showPlayNotice("设置已打开");
          }}
          onOpenStyles={() => setStyleDrawerOpen(true)}
          onOpenCharacters={() => setCharactersOpen(true)}
          onImageReady={handleImageReady}
          fullViewport
          dialogueHistory={dialogueHistory}
          timelineDecisions={timelineDecisions}
          activeBranchId={session?.timeline?.activeBranchId}
          onReselectDecision={(decision, choiceId) =>
            void handleReselectDecision(decision, choiceId)
          }
          disabledChoiceIds={disabledChoiceIds}
          freeformDisabled={
            authorLockedScene ||
            replayLocked ||
            (!!currentScene && !videoAllowsSceneInteraction(currentScene))
          }
          loadingProgress={firstFrameProgress}
          videoInteractionUnlocked={videoInteractionUnlocked}
          onVideoComplete={onVideoComplete}
          endOfDemo={endOfDemoNotice}
          onReplayEndOfDemo={handleReplayEndOfDemo}
        />
        {canvasErrorBanner}
        {showSteamCompletion && (
          <SteamCompletionCta
            aboutHref={`${lp("/steam")}?view=about`}
            compact
          />
        )}
        {playNotice && <PlayNoticeToast message={playNotice} />}
        {roleNotice && <RoleToast message={roleNotice} />}
        {charactersOpen && (
          <StoryCharacterModal
            session={session}
            onClose={() => setCharactersOpen(false)}
            onSelect={handlePlayableRoleSelect}
            onRenameCharacter={handleCharacterRename}
          />
        )}
        <StyleSwitcherDrawer
          open={styleDrawerOpen}
          current={{
            styleGuide: session?.styleGuide || "auto",
            styleReferenceImage: session?.styleReferenceImage,
            narrativeStyle: session?.narrativeStyle || "自动",
          }}
          busy={styleBusy}
          feedback={styleFeedback}
          prefetchDepth={branchPrefetchDepth}
          onClose={() => setStyleDrawerOpen(false)}
          onApplyNext={handleApplyStyleNext}
          onRedrawCurrent={(selection) => void handleRedrawCurrent(selection)}
          onRewriteCurrent={(selection) => void handleRewriteCurrent(selection)}
        />
        {orientation === "portrait" && (
          <div
            className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 pointer-events-none"
            style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
          >
            <Link
              href={safeReturn.href}
              onClick={() => showPlayNotice("返回")}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur-sm transition-colors hover:text-white"
              aria-label={t("play.tooltips.back")}
            >
              <i className="fa-solid fa-arrow-left text-[13px]" />
            </Link>
            <button
              type="button"
              onClick={toggleMuted}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur-sm transition-colors hover:text-white"
              aria-label={muted ? t("play.tooltips.unmute") : t("play.tooltips.mute")}
            >
              <i
                className={`fa-solid ${muted ? "fa-volume-xmark" : "fa-volume-high"} text-[13px]`}
              />
            </button>
          </div>
        )}
        {settingsOpen && (
          <SettingsModal
            initialVisionClickEnabled={visionClickEnabled}
            onClose={() => setSettingsOpen(false)}
            onSaved={handleSettingsSaved}
            footerNote={t("play.settingsFooter")}
          />
        )}
        {authModalOpen && (
          <AuthModal
            onClose={closeAuthModal}
            onSuccess={completeAuthModal}
            requirement={authRequirement}
          />
        )}
        </div>
      </div>
    );
  }

  const sceneCount = session?.history.length ?? 0;
  const beatCount = visitedBeatsRef.current.length;

  // Surface the BYO-key nudge only to an unmuted, non-BYO player whose last few
  // beats came back silent (shared key rate-limited) — the exact pain BYO fixes.
  // Dismissible for the session.
  const showSilenceNudge =
    phase === "ready" &&
    !muted &&
    !byoTtsConfig &&
    !nudgeDismissed &&
    silenceStrikes >= SILENCE_NUDGE_THRESHOLD;

  return (
    <div className="min-h-screen flex flex-col">
      <SteamDesktopBridge enabled={steamChannel} />
      {canvasErrorBanner}
      {exportProgress && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-full bg-black/75 px-4 py-2 text-[11px] smallcaps text-white/95 backdrop-blur-sm shadow-lg flex items-center gap-2"
        >
          <i className="fa-solid fa-circle-notch animate-spin text-[11px] text-blue-300" />
          <span>{exportProgress.label}</span>
          {exportProgress.total > 0 && (
            <span className="num text-white/70">
              {exportProgress.done}/{exportProgress.total}
            </span>
          )}
        </div>
      )}
      {playNotice && <PlayNoticeToast message={playNotice} />}
      {roleNotice && <RoleToast message={roleNotice} />}
      <header className="px-5 md:px-12 pt-6 md:pt-8 flex items-center justify-between">
        <Link
          href={safeReturn.href}
          onClick={() => showPlayNotice("返回")}
          className="text-clay-600 hover:text-clay-900 transition-colors flex items-center gap-3"
        >
          <i className="fa-solid fa-arrow-left text-[12px]" />
          <span className="font-serif text-[22px] md:text-[26px] leading-none tracking-tight">
            AI<em className="italic font-light text-ember-500">story</em>
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <div className="text-[10px] smallcaps text-clay-500 num flex items-center gap-3">
            <span>{t("play.counter.scene", { n: String(sceneCount).padStart(3, "0") })}</span>
            <span className="text-clay-300">·</span>
            <span>{t("play.counter.beat", { n: String(beatCount).padStart(3, "0") })}</span>
          </div>
          <UserChip />
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 md:px-8 py-6 md:py-10">
        <PlayCanvas
          scene={currentScene}
          imageUrl={imageUrl}
          audioSrc={currentSceneMedia.kind === "video" && currentSceneMedia.hasAudio ? null : audioSrc}
          muted={muted}
          phase={phase}
          beat={currentBeat}
          pendingClick={pendingClick}
          onBackgroundClick={onBackgroundClick}
          onAdvance={onAdvance}
          onSelectChoice={onSelectChoice}
          onFreeformInput={authorLockedScene ? undefined : onFreeformInput}
          orientation={orientation}
          playerName={session?.playerName}
          characters={session?.characters ?? []}
          visionClickEnabled={
            !authorLockedScene &&
            visionClickEnabled &&
            (!currentScene || videoAllowsSceneInteraction(currentScene))
          }
          onOpenSettings={() => {
            setSettingsOpen(true);
            showPlayNotice("设置已打开");
          }}
          onOpenStyles={() => setStyleDrawerOpen(true)}
          onOpenCharacters={() => setCharactersOpen(true)}
          onImageReady={handleImageReady}
          dialogueHistory={dialogueHistory}
          timelineDecisions={timelineDecisions}
          activeBranchId={session?.timeline?.activeBranchId}
          onReselectDecision={(decision, choiceId) =>
            void handleReselectDecision(decision, choiceId)
          }
          disabledChoiceIds={disabledChoiceIds}
          freeformDisabled={
            authorLockedScene ||
            replayLocked ||
            (!!currentScene && !videoAllowsSceneInteraction(currentScene))
          }
          loadingProgress={firstFrameProgress}
          videoInteractionUnlocked={videoInteractionUnlocked}
          onVideoComplete={onVideoComplete}
          endOfDemo={endOfDemoNotice}
          onReplayEndOfDemo={handleReplayEndOfDemo}
          aboveCanvas={
            <button
              type="button"
              onClick={() => void togglePresentation()}
              className="text-[10px] smallcaps text-clay-500 hover:text-ember-500 transition-colors flex items-center gap-2"
              aria-label={t("play.tooltips.enterFullscreen")}
              title={t("play.tooltips.fullscreen")}
            >
              <i className="fa-solid fa-expand text-[10px]" />
              {t("play.buttons.fullscreen")}
            </button>
          }
          belowCanvas={
            session && session.history.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleExportGallery()}
                  disabled={!!exportProgress}
                  className="text-[10px] smallcaps text-clay-500 hover:text-ember-500 transition-colors flex items-center gap-2 disabled:opacity-50"
                  aria-label={t("play.tooltips.exportGalleryLabel")}
                  title={t("play.tooltips.exportGallery")}
                >
                  <i className="fa-solid fa-link text-[10px]" />
                  {t("play.buttons.exportGallery")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportStory()}
                  disabled={!!exportProgress}
                  className="text-[10px] smallcaps text-clay-500 hover:text-ember-500 transition-colors flex items-center gap-2 disabled:opacity-50"
                  aria-label={STORY_ARCHIVE_EXPORT_TITLE}
                  title={STORY_ARCHIVE_EXPORT_TITLE}
                >
                  <i className="fa-solid fa-share-nodes text-[10px]" />
                  {STORY_ARCHIVE_EXPORT_LABEL}
                </button>
              </>
            ) : null
          }
          aboveCanvasLeft={
            <>
              <button
                type="button"
                onClick={toggleMuted}
                className="text-[10px] smallcaps text-clay-500 hover:text-ember-500 transition-colors flex items-center gap-2"
                aria-label={muted ? t("play.tooltips.unmute") : t("play.tooltips.mute")}
                title={muted ? t("play.tooltips.unmute") : t("play.tooltips.mute")}
              >
                <i
                  className={`fa-solid ${muted ? "fa-volume-xmark" : "fa-volume-high"} text-[10px]`}
                />
                {muted ? t("play.buttons.muted") : t("play.buttons.sound")}
              </button>

              {/* Silence nudge — a compact pill right beside the mute toggle.
                  Triggers when the shared server key keeps coming back silent,
                  which usually means it's rate-limited; nudges the player to
                  enter their own API Key for a more stable experience.
                  Clicking opens the settings modal in place; the × dismisses
                  it for the session. */}
              {showSilenceNudge && (
                <span className="flex items-center gap-1 animate-fade-in">
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsOpen(true);
                      showPlayNotice("设置已打开");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-ember-500/40 bg-ember-500/10 px-2.5 py-1 text-[10px] text-ember-500 hover:bg-ember-500/20 transition-colors"
                    title={t("play.tooltips.silenceNudge")}
                  >
                    <i className="fa-solid fa-volume-xmark text-[9px]" />
                    {t("play.tooltips.silenceNudge")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNudgeDismissed(true)}
                    aria-label={t("play.tooltips.closeNudge")}
                    title={t("play.tooltips.closeNudge")}
                    className="text-clay-400 hover:text-clay-700 transition-colors"
                  >
                    <i className="fa-solid fa-xmark text-[10px]" />
                  </button>
                </span>
              )}
            </>
          }
        />

        {showSteamCompletion && (
          <SteamCompletionCta aboutHref={`${lp("/steam")}?view=about`} />
        )}

        {session && session.history.length > 0 ? (
          <div className="mt-4 w-full max-w-2xl px-4">
            <SharedStoryPublishPanel
              key={session.id}
              session={session}
            />
          </div>
        ) : null}

        <div className="mt-4 max-w-md w-full text-center min-h-[28px] flex items-center justify-center">
          {phase === "loading-first" && (
            <p className="text-[10px] smallcaps text-clay-500 animate-slow-pulse">
              {t("play.loading.loadingFirst")}
            </p>
          )}
          {phase === "ready" && lastExitLabel && (
            <p className="text-[9px] smallcaps text-clay-400 animate-fade-in">
              <span className="mr-2">{t("play.previousStep")}</span>
              <span className="text-clay-600">{lastExitLabel}</span>
            </p>
          )}
        </div>

      </main>

      {settingsOpen && (
        <SettingsModal
          initialVisionClickEnabled={visionClickEnabled}
          onClose={() => setSettingsOpen(false)}
          onSaved={handleSettingsSaved}
          footerNote={t("play.settingsFooter")}
        />
      )}
      {charactersOpen && (
        <StoryCharacterModal
          session={session}
          onClose={() => setCharactersOpen(false)}
          onSelect={handlePlayableRoleSelect}
          onRenameCharacter={handleCharacterRename}
        />
      )}
      <StyleSwitcherDrawer
        open={styleDrawerOpen}
        current={{
          styleGuide: session?.styleGuide || "auto",
          styleReferenceImage: session?.styleReferenceImage,
          narrativeStyle: session?.narrativeStyle || "自动",
        }}
        busy={styleBusy}
        feedback={styleFeedback}
        prefetchDepth={branchPrefetchDepth}
        onClose={() => setStyleDrawerOpen(false)}
        onApplyNext={handleApplyStyleNext}
        onRedrawCurrent={(selection) => void handleRedrawCurrent(selection)}
        onRewriteCurrent={(selection) => void handleRewriteCurrent(selection)}
      />
      {authModalOpen && (
        <AuthModal
          onClose={closeAuthModal}
          onSuccess={completeAuthModal}
          requirement={authRequirement}
        />
      )}
    </div>
  );
}

export default function PlayPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <i className="fa-solid fa-circle-notch fa-spin text-clay-500 text-xl" />
        </div>
      }
    >
      <PlayInner />
    </Suspense>
  );
}
