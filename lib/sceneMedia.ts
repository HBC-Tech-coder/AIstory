import type {
  Scene,
  SceneImageMedia,
  SceneMedia,
  SceneVideoMedia,
  SceneVideoSubtitleCue,
} from "@infiplot/types";

const CONTROLLED_MEDIA_PREFIXES = [
  "/api/video-assets/",
  "/api/aistory-cache/media/",
  "/case-studies/",
] as const;

export function isControlledSceneMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  if (trimmed.includes("\\") || trimmed.includes("\0")) return false;
  try {
    const parsed = new URL(trimmed, "https://aistory.invalid");
    if (parsed.origin !== "https://aistory.invalid") return false;
    if (decodeURIComponent(parsed.pathname).split("/").includes("..")) {
      return false;
    }
    return CONTROLLED_MEDIA_PREFIXES.some((prefix) =>
      parsed.pathname.startsWith(prefix),
    );
  } catch {
    return false;
  }
}

function finiteMs(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

export function coerceSceneVideoCue(
  value: unknown,
  index = 0,
): SceneVideoSubtitleCue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const startMs = finiteMs(record.startMs);
  const endMs = finiteMs(record.endMs);
  if (!text || endMs <= startMs) return null;
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim().slice(0, 80)
        : `cue-${index + 1}`,
    startMs,
    endMs,
    text: text.slice(0, 500),
    ...(typeof record.speaker === "string" && record.speaker.trim()
      ? { speaker: record.speaker.trim().slice(0, 80) }
      : {}),
  };
}

export function coerceSceneMedia(
  scene: Pick<Scene, "media" | "imageUrl">,
): SceneMedia {
  const media = scene.media;
  if (media?.kind === "video" && isControlledSceneMediaUrl(media.url)) {
    const video: SceneVideoMedia = {
      kind: "video",
      url: media.url,
      ...(typeof media.assetId === "string" && media.assetId.trim()
        ? { assetId: media.assetId.trim().slice(0, 120) }
        : {}),
      ...(isControlledSceneMediaUrl(media.posterUrl)
        ? { posterUrl: media.posterUrl }
        : {}),
      ...(Number.isFinite(media.durationMs) && Number(media.durationMs) > 0
        ? { durationMs: Math.round(Number(media.durationMs)) }
        : {}),
      hasAudio: media.hasAudio === true,
      subtitles: Array.isArray(media.subtitles)
        ? media.subtitles
            .map((cue, index) => coerceSceneVideoCue(cue, index))
            .filter((cue): cue is SceneVideoSubtitleCue => cue !== null)
        : [],
      ...(isControlledSceneMediaUrl(media.vttUrl)
        ? { vttUrl: media.vttUrl }
        : {}),
      endBehavior:
        media.endBehavior === "advance-beat" || media.endBehavior === "hold"
          ? media.endBehavior
          : "unlock-interaction",
      allowSkip: media.allowSkip !== false,
      ...(typeof media.authoredTargetNodeId === "string" &&
      media.authoredTargetNodeId.trim()
        ? {
            authoredTargetNodeId: media.authoredTargetNodeId
              .trim()
              .slice(0, 120),
          }
        : {}),
      ...(media.authoredVariableDelta &&
      typeof media.authoredVariableDelta === "object" &&
      !Array.isArray(media.authoredVariableDelta)
        ? {
            authoredVariableDelta: Object.fromEntries(
              Object.entries(media.authoredVariableDelta)
                .filter(
                  ([key, value]) =>
                    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(key) &&
                    Number.isFinite(value),
                )
                .map(([key, value]) => [key, Number(value)]),
            ),
          }
        : {}),
      hotspotsEnabled: media.hotspotsEnabled === true,
    };
    return video;
  }

  const image: SceneImageMedia = {
    kind: "image",
    ...(media?.kind === "image" && typeof media.url === "string"
      ? { url: media.url }
      : typeof scene.imageUrl === "string"
        ? { url: scene.imageUrl }
        : {}),
  };
  return image;
}

export function scenePosterUrl(
  scene: Pick<Scene, "media" | "imageUrl">,
): string | undefined {
  const media = coerceSceneMedia(scene);
  return media.kind === "video"
    ? media.posterUrl || scene.imageUrl
    : media.url || scene.imageUrl;
}

export function sceneHasRenderableMedia(
  scene: Pick<Scene, "media" | "imageUrl"> | null | undefined,
): boolean {
  if (!scene) return false;
  const media = coerceSceneMedia(scene);
  return media.kind === "video" || !!media.url || !!scene.imageUrl;
}

export function sceneUsesEmbeddedAudio(
  scene: Pick<Scene, "media" | "imageUrl"> | null | undefined,
): boolean {
  if (!scene) return false;
  const media = coerceSceneMedia(scene);
  return media.kind === "video" && media.hasAudio === true;
}

export function activeVideoCue(
  cues: readonly SceneVideoSubtitleCue[] | undefined,
  currentTimeMs: number,
): SceneVideoSubtitleCue | null {
  if (!cues?.length || !Number.isFinite(currentTimeMs)) return null;
  return (
    cues.find(
      (cue) =>
        currentTimeMs >= cue.startMs && currentTimeMs < cue.endMs,
    ) ?? null
  );
}

export type VideoFallbackSubtitle = {
  speaker?: string;
  text: string;
};

export type VideoSubtitlePresentation =
  | {
      source: "inline";
      overlay: SceneVideoSubtitleCue | null;
      trackUrl: null;
    }
  | {
      source: "vtt";
      overlay: null;
      trackUrl: string;
    }
  | {
      source: "beat";
      overlay: VideoFallbackSubtitle;
      trackUrl: null;
    }
  | {
      source: "none";
      overlay: null;
      trackUrl: null;
    };

export function resolveVideoSubtitlePresentation({
  inlineCues,
  vttUrl,
  fallbackSubtitle,
  currentTimeMs,
}: {
  inlineCues: readonly unknown[] | undefined;
  vttUrl: unknown;
  fallbackSubtitle?: VideoFallbackSubtitle | null;
  currentTimeMs: number;
}): VideoSubtitlePresentation {
  const sanitizedInlineCues = Array.isArray(inlineCues)
    ? inlineCues
        .map((cue, index) => coerceSceneVideoCue(cue, index))
        .filter((cue): cue is SceneVideoSubtitleCue => cue !== null)
    : [];

  if (sanitizedInlineCues.length > 0) {
    return {
      source: "inline",
      overlay: activeVideoCue(sanitizedInlineCues, currentTimeMs),
      trackUrl: null,
    };
  }

  if (isControlledSceneMediaUrl(vttUrl)) {
    return { source: "vtt", overlay: null, trackUrl: vttUrl };
  }

  const fallback = fallbackSubtitle
    ? coerceSceneVideoCue(
        {
          id: "beat-fallback",
          startMs: 0,
          endMs: 1,
          text: fallbackSubtitle.text,
          speaker: fallbackSubtitle.speaker,
        },
        0,
      )
    : null;
  if (fallback) {
    return {
      source: "beat",
      overlay: {
        ...(fallback.speaker ? { speaker: fallback.speaker } : {}),
        text: fallback.text,
      },
      trackUrl: null,
    };
  }

  return { source: "none", overlay: null, trackUrl: null };
}

export type VideoSkipControlMode = "normal-skip" | "error-recovery" | "hidden";

export function resolveVideoSkipControlMode(
  allowSkip: boolean | undefined,
  mediaFailed: boolean,
): VideoSkipControlMode {
  if (mediaFailed) return "error-recovery";
  return allowSkip === false ? "hidden" : "normal-skip";
}

export type VideoCompletionReason = "completed" | "skipped" | "seeked";

export type VideoPlaybackTerminalState = "active" | "failed" | "completed";

export type VideoCompletionGate = ((reason: VideoCompletionReason) => boolean) & {
  markFailed: () => boolean;
  state: () => VideoPlaybackTerminalState;
};

export function createVideoCompletionGate(
  onComplete: (reason: VideoCompletionReason) => void,
): VideoCompletionGate {
  let state: VideoPlaybackTerminalState = "active";
  const gate = ((reason: VideoCompletionReason) => {
    if (state === "completed") return false;
    if (state === "failed" && reason !== "skipped") return false;
    state = "completed";
    onComplete(reason);
    return true;
  }) as VideoCompletionGate;
  gate.markFailed = () => {
    if (state !== "active") return false;
    state = "failed";
    return true;
  };
  gate.state = () => state;
  return gate;
}

export function videoAllowsSceneInteraction(
  scene: Pick<Scene, "media" | "imageUrl">,
): boolean {
  const media = coerceSceneMedia(scene);
  return media.kind !== "video" || media.hotspotsEnabled === true;
}
