/**
 * Pure, dependency-free policy helpers for the mobile preview.
 *
 * The mobile app is a thin preview shell: it must never fake chapter progress,
 * engagement metrics, generated branches or character cards. These helpers keep
 * that wording and the `returnTo=/mobile` hand-off testable in isolation.
 */

export const MOBILE_RETURN_TO = "/mobile";

export type KeyedPreviewFeature =
  | "follow"
  | "nearby"
  | "like"
  | "comment"
  | "branch"
  | "rewrite";

export type PreviewFeatureState = {
  available: boolean;
  label: string;
  notice: string;
};

const PREVIEW_FEATURES: Record<KeyedPreviewFeature, PreviewFeatureState> = {
  follow: {
    available: false,
    label: "关注",
    notice: "关注流尚未上线：当前为预览版，不会展示任何关注内容。",
  },
  nearby: {
    available: false,
    label: "附近",
    notice: "附近功能尚未上线：当前为预览版，没有同城内容可展示。",
  },
  like: {
    available: false,
    label: "待上线",
    notice: "点赞尚未上线：本次操作不会被记录，也不会产生真实数据。",
  },
  comment: {
    available: false,
    label: "待上线",
    notice: "评论尚未上线：当前版本无法发布评论。",
  },
  branch: {
    available: false,
    label: "预览",
    notice: "分支选择仅为本地预览：尚未写入服务器，也未生成新的世界线。",
  },
  rewrite: {
    available: false,
    label: "草稿",
    notice: "改写仅为当前页面草稿：只留在当前页面，收起后不会写入本地存储，刷新或离开后不会保留；不会生成分支或关键画面，也不会调用付费模型。",
  },
};

export function previewFeatureState(feature: KeyedPreviewFeature): PreviewFeatureState {
  return PREVIEW_FEATURES[feature];
}

/** Short rail/toast labels for engagement that is not implemented. */
export function previewMetricLabel(feature: "like" | "comment"): string {
  return PREVIEW_FEATURES[feature].label;
}

/**
 * Accepts only same-origin absolute paths (single leading slash). Rejects
 * protocol-relative URLs, schemes, whitespace/control characters and
 * backslashes, so the returnTo hand-off can never leave the app.
 */
export function isSafeLocalHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  const value = href.trim();
  if (value.length === 0 || value !== href) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return false;
  return true;
}

function encodeQueryParam(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Appends `returnTo=/mobile` to a playable local URL while preserving the
 * existing query string and hash. Unsafe or external hrefs are returned
 * unchanged (the caller keeps its original navigation behavior); an existing
 * `returnTo` value is replaced instead of duplicated.
 */
export function withMobileReturnTo(
  href: string,
  returnTo: string = MOBILE_RETURN_TO,
): string {
  if (!isSafeLocalHref(href)) return href;
  const safeReturnTo = isSafeLocalHref(returnTo) ? returnTo : MOBILE_RETURN_TO;

  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);

  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);

  const kept: string[] = [];
  for (const pair of rawQuery.split("&")) {
    if (!pair) continue;
    const key = pair.split("=")[0] ?? "";
    let decodedKey = key;
    try {
      decodedKey = decodeURIComponent(key);
    } catch {
      decodedKey = key;
    }
    if (decodedKey === "returnTo") continue;
    kept.push(pair);
  }
  kept.push(`returnTo=${encodeQueryParam(safeReturnTo)}`);

  return `${pathname}?${kept.join("&")}${hash}`;
}

export type VideoProgressInput = {
  hasVideo: boolean;
  currentTimeSeconds?: number | null;
  durationSeconds?: number | null;
};

export type PreviewProgress =
  | {
      mode: "video";
      percent: number;
      label: string;
      currentTimeSeconds: number;
      durationSeconds: number;
    }
  | {
      mode: "preview";
      percent: null;
      label: string;
      reason: "no-video" | "metadata-pending";
    };

/** `92` -> `1:32`; invalid values -> `--:--`. */
export function formatPlaybackTime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Real playback progress is only reported when a video element has both a
 * usable `currentTime` and `duration`. Everything else is explicitly labeled a
 * preview, so static decorative bars can never impersonate real progress.
 */
export function resolvePreviewProgress(input: VideoProgressInput): PreviewProgress {
  const duration = input.durationSeconds;
  const currentTime = input.currentTimeSeconds;
  const validDuration =
    typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  const validCurrent =
    typeof currentTime === "number" && Number.isFinite(currentTime) && currentTime >= 0;

  if (input.hasVideo && validDuration && validCurrent) {
    const clampedCurrent = Math.min(currentTime, duration);
    const percent = Math.max(0, Math.min(100, (clampedCurrent / duration) * 100));
    return {
      mode: "video",
      percent,
      label: `${formatPlaybackTime(clampedCurrent)} / ${formatPlaybackTime(duration)}`,
      currentTimeSeconds: clampedCurrent,
      durationSeconds: duration,
    };
  }

  if (input.hasVideo) {
    return {
      mode: "preview",
      percent: null,
      label: "预览 · 等待视频时长",
      reason: "metadata-pending",
    };
  }

  return {
    mode: "preview",
    percent: null,
    label: "预览 · 无播放进度",
    reason: "no-video",
  };
}

export type ProgressSegmentState = "done" | "now" | "rest";

/**
 * Maps a real percentage onto fixed-width segments. `null` (preview mode)
 * yields all-rest segments so callers can choose to hide the bar entirely.
 */
export function progressSegments(
  percent: number | null,
  total = 5,
): ProgressSegmentState[] {
  const count = Math.max(1, Math.floor(total));
  const states: ProgressSegmentState[] = [];
  const safePercent =
    typeof percent === "number" && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : null;

  for (let index = 0; index < count; index += 1) {
    if (safePercent === null) {
      states.push("rest");
      continue;
    }
    const start = (index / count) * 100;
    const end = ((index + 1) / count) * 100;
    if (safePercent >= end) states.push("done");
    else if (safePercent > start) states.push("now");
    else states.push("rest");
  }
  return states;
}

export type StoryCharacter = {
  name: string;
  description: string;
  traits?: readonly string[];
};

export type RoleCardState =
  | {
      available: true;
      name: string;
      description: string;
      traits: readonly string[];
    }
  | {
      available: false;
      title: string;
      description: string;
    };

/**
 * Only shows a character card when the current story actually publishes
 * structured character info. Otherwise it says so instead of borrowing an
 * unrelated story's character.
 */
export function resolveRoleCard(character?: StoryCharacter | null): RoleCardState {
  if (
    character &&
    typeof character.name === "string" &&
    character.name.trim().length > 0 &&
    typeof character.description === "string" &&
    character.description.trim().length > 0
  ) {
    return {
      available: true,
      name: character.name.trim(),
      description: character.description.trim(),
      traits: (character.traits ?? []).filter(
        (trait) => typeof trait === "string" && trait.trim().length > 0,
      ),
    };
  }
  return {
    available: false,
    title: "暂无已发布的角色卡",
    description:
      "当前剧集还没有公开发布的角色卡，预览版不会用其他故事的角色代替。",
  };
}

export type RewriteDraftState = {
  status: "draft";
  executed: false;
  charged: false;
  message: string;
};

/**
 * The rewrite sheet only keeps the seed in React state for the current page.
 * It is never written to local storage, never claims generation and never
 * triggers paid model calls.
 */
export function rewriteDraftNotice(seed: string): RewriteDraftState {
  const hasSeed = typeof seed === "string" && seed.trim().length > 0;
  return {
    status: "draft",
    executed: false,
    charged: false,
    message: hasSeed
      ? "草稿留在当前页面：刷新或离开后不会保留；未生成分支与关键画面，未调用任何付费模型。"
      : "草稿为空：请先写下改写内容；预览版不会自动生成分支。",
  };
}
