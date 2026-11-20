import type { Beat, Scene } from "@infiplot/types";

// ──────────────────────────────────────────────────────────────────────
//  Player review policy
//
//  Pure, framework-free helpers shared by the play page, the canvas and the
//  gallery. Everything here is intentionally free of Next/React imports so a
//  plain `tsx` script can assert the security- and honesty-critical rules:
//   - returnTo is an EXACT allowlist (only /mobile), never an open redirect;
//   - an authored/demo terminal state is reported honestly instead of
//     pretending a stuck scene is still interactive;
//   - first-load and mid-session errors use fixed Chinese, actionable copy and
//     never surface raw English backend errors.
// ──────────────────────────────────────────────────────────────────────

/** Exactly one non-root path may be used as a safe `returnTo` target. */
export const ALLOWED_RETURN_TO_PATHS = ["/mobile"] as const;

/**
 * `returnTo` is accepted only as the exact string `/mobile`.
 * Trailing slashes, case variants, query/hash, protocol-relative and absolute
 * URLs are all rejected (and therefore fall back to the home page).
 */
export function isAllowedReturnTo(
  raw: string | null | undefined,
): raw is (typeof ALLOWED_RETURN_TO_PATHS)[number] {
  return raw === "/mobile";
}

export type SafeReturnResolution = {
  /** Locale-aware, already-prefixed href safe to use in a link. */
  href: string;
  /** True when the href came from an accepted `returnTo` value. */
  fromReturnTo: boolean;
  /** Localized label matching the destination. */
  label: string;
};

/**
 * Resolve a `returnTo` query value to a link that is safe by construction.
 * The caller supplies locale-aware hrefs, so no locale logic leaks in here and
 * no caller-controlled string is ever written into an href.
 */
export function resolveSafeReturn(input: {
  returnTo: string | null | undefined;
  homeHref: string;
  mobileHref: string;
  homeLabel?: string;
  mobileLabel?: string;
}): SafeReturnResolution {
  if (isAllowedReturnTo(input.returnTo)) {
    return {
      href: input.mobileHref,
      fromReturnTo: true,
      label: input.mobileLabel ?? "返回手机端",
    };
  }
  return {
    href: input.homeHref,
    fromReturnTo: false,
    label: input.homeLabel ?? "回到首页",
  };
}

// ── Terminal / end-of-demo detection ───────────────────────────────────

export type PlayTerminalReason =
  | "authored-ending"
  | "empty-choice"
  | "dangling-continue"
  | "missing-beat";

const AUTHORED_ENDING_KINDS = new Set([
  "ending",
  "end",
  "terminal",
  "finale",
  "demo-end",
  "end-of-demo",
]);

function isAuthoredEndingKind(kind: string | null | undefined): boolean {
  return (
    typeof kind === "string" &&
    AUTHORED_ENDING_KINDS.has(kind.toLowerCase())
  );
}

/**
 * Detect an authored terminal branch that would otherwise look "stuck":
 * no choice button, no continue arrow, nothing to click.
 *
 * Ordering matters: an authored `ending` node kind must NOT override a beat
 * that still has a real forward path. If the beat has a nonempty choice list,
 * or a `continue` whose target beat actually exists, the player can still move
 * forward and `null` is returned. The authored kind is only consulted after
 * those forward paths are ruled out.
 *
 * Deliberately conservative — a normal interactive beat returns `null`, so the
 * player is never told the demo ended while a forward path still exists.
 */
export function detectPlayTerminal(input: {
  scene: Pick<Scene, "beats"> | null | undefined;
  beat: Beat | null | undefined;
  currentBeatId?: string | null;
  authoredNodeKind?: string | null;
  authoredLocked?: boolean;
}): PlayTerminalReason | null {
  const { scene, beat, currentBeatId, authoredNodeKind, authoredLocked } = input;
  if (!scene) return null;

  if (!beat) {
    // A scene whose current beat id is missing has no way to advance.
    return currentBeatId ? "missing-beat" : null;
  }

  // ── Valid forward paths win over any authored "ending" label ─────────
  if (beat.next.type === "choice") {
    if (beat.next.choices.length > 0) return null;
  } else if (beat.next.type === "continue") {
    const target = beat.next.nextBeatId;
    const exists =
      typeof target === "string" &&
      target.length > 0 &&
      scene.beats.some((candidate) => candidate.id === target);
    if (exists) return null;
  }

  if (isAuthoredEndingKind(authoredNodeKind)) {
    return "authored-ending";
  }

  if (beat.next.type === "choice") {
    // Empty choices are only terminal when the author lock forbids the
    // freeform/AI continuation affordance. Otherwise the player still has the
    // freeform button and must not be told the demo ended.
    return authoredLocked === true ? "empty-choice" : null;
  }

  if (beat.next.type === "continue") {
    return "dangling-continue";
  }

  return null;
}

/**
 * `missing-beat` and `dangling-continue` mean the story data is incomplete or
 * points at a beat that does not exist. They are NOT a normal authored ending,
 * so their copy must not describe the story as having successfully concluded.
 */
export function isIncompleteStoryDataReason(
  reason: PlayTerminalReason,
): boolean {
  return reason === "missing-beat" || reason === "dangling-continue";
}

export type PlayEndOfDemoNotice = {
  reason: PlayTerminalReason;
  eyebrow: string;
  title: string;
  body: string;
  safetyNote: string;
  backHref: string;
  backLabel: string;
  replayLabel: string;
  /** True when the stop comes from incomplete story data, not an authored end. */
  incompleteStoryData: boolean;
};

/**
 * Fixed, honest end-of-demo copy. `back` is the already-resolved safe return
 * (see resolveSafeReturn) so the notice can never carry an arbitrary URL.
 *
 * A missing beat or a dangling `continue` pointer is a data problem, so it is
 * described as incomplete story data — never as a normal/successful ending.
 */
export function buildPlayEndOfDemoNotice(
  reason: PlayTerminalReason,
  back: SafeReturnResolution,
): PlayEndOfDemoNotice {
  const incompleteStoryData = isIncompleteStoryDataReason(reason);
  if (incompleteStoryData) {
    const missingBeat = reason === "missing-beat";
    return {
      reason,
      eyebrow: "剧情数据不完整 · 非正常结局",
      title: missingBeat
        ? "这一幕的剧情数据缺失"
        : "这条分支指向了不存在的后续",
      body: missingBeat
        ? "当前节点引用了一个不存在的剧情段落，属于剧情数据不完整，所以没有可以继续的画面。这不是作者写好的正式结局，也不代表故事已经正常走完。"
        : "当前分支的「继续」指向一个缺失的剧情节点，所以没有可以继续的内容。这属于剧情数据不完整，不是作者写好的正常结局。",
      safetyNote:
        "这是剧情数据不完整导致的中断，不是生成失败，也不会自动生成新的剧情或结局。",
      backHref: back.href,
      backLabel: back.label,
      replayLabel: "重看本幕",
      incompleteStoryData: true,
    };
  }

  return {
    reason,
    eyebrow: "演示终点 · 非故障",
    title:
      reason === "authored-ending"
        ? "作者写好的这段演示到这里结束"
        : "这条分支已经走到终点",
    body: "画面和已读剧情都保留着。当前版本没有后续内容，也不会自动生成新的剧情或结局。",
    safetyNote: "这是作者标记的终点，不是生成失败，也不会触发生成。",
    backHref: back.href,
    backLabel: back.label,
    replayLabel: "重看本幕",
    incompleteStoryData: false,
  };
}

// ── Error copy (fixed Chinese, never raw backend text) ─────────────────

export type PlayErrorCopy = {
  eyebrow: string;
  title: string;
  body: string;
  safetyNote: string;
  dismissLabel: string;
  backLabel: string;
};

/**
 * Mid-session failure: the canvas still holds a valid scene/session, so the
 * player keeps it and gets a dismissible, actionable Chinese explanation.
 */
export function buildPlaySceneErrorCopy(back: SafeReturnResolution): PlayErrorCopy {
  return {
    eyebrow: "当前画面已保留",
    title: "刚才这一步没有成功",
    body: "剧情仍然停在当前画面，已读内容没有丢失。可以关闭这条提示继续查看当前画面，或稍后再试一次。",
    // Closing the notice only stops this failed step from re-running. It does
    // not (and must not) claim the failed generation itself was free.
    safetyNote: "关闭提示只会保留当前画面，不会重新生成这一步。",
    dismissLabel: "关闭提示，继续查看画面",
    backLabel: back.label,
  };
}

/** Actionable controls offered on a first-load failure. */
export const PLAY_FIRST_LOAD_SETTINGS_LABEL = "检查设置与模型";
export const PLAY_FIRST_LOAD_DEMO_LABEL = "选择一个可用演示";

/**
 * First-load failure: there is no canvas to preserve, so explain safely and
 * offer actionable next steps (check the model/settings or pick a ready demo)
 * instead of rendering an English provider error. No internal governance copy.
 */
export function buildPlayFirstLoadErrorCopy(
  back: SafeReturnResolution,
): PlayErrorCopy {
  return {
    eyebrow: "第一幕还没有准备好",
    title: "第一幕暂时没有加载出来",
    body: "内容服务或生成服务暂时不可用，也可能当前环境的模型配置还不完整。可以检查设置里的模型与密钥，或先选一个已就绪的演示剧本。这不是你的操作问题。",
    safetyNote:
      "下一步可以打开设置检查模型与密钥，或回到首页选择一个可用演示。",
    dismissLabel: "",
    backLabel: back.label,
  };
}

// ── Export / import copy ───────────────────────────────────────────────

export const STORY_ARCHIVE_EXPORT_LABEL = "导出剧情存档";
export const STORY_ARCHIVE_EXPORT_TITLE =
  "导出 .infiplot 剧情存档；导入请回首页使用「载入剧情」，视频播放器不能导入存档。";
export const STORY_ARCHIVE_EXPORT_DONE =
  "剧情存档（.infiplot）已生成。要导入，请回首页使用「载入剧情」，不是视频播放器。";
export const STORY_ARCHIVE_EMPTY = "暂无可导出的剧情存档";
export const STORY_ARCHIVE_PACKING = "正在打包剧情存档…";

// ── Video player saved volume ──────────────────────────────────────────

export const DEFAULT_PLAYER_VOLUME = 1;

/**
 * Validate a persisted player volume.
 *
 * The old `Number(parsed.volume) || 1` treated an explicit saved `0` as falsy
 * and silently restored full volume. An explicit, finite `0..1` value (number,
 * or a numeric string from older localStorage payloads) is preserved exactly;
 * anything else falls back to the default. Out-of-range values are rejected
 * rather than clamped so corrupt payloads cannot masquerade as valid.
 */
export function coerceSavedPlayerVolume(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 && raw <= 1
      ? raw
      : DEFAULT_PLAYER_VOLUME;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : DEFAULT_PLAYER_VOLUME;
  }
  return DEFAULT_PLAYER_VOLUME;
}

// ── Gallery stage sizing ───────────────────────────────────────────────

export type GalleryStageMetrics = {
  /** Bounded, responsive stage style (no auto-width collapse). */
  style: {
    width: string;
    height: string;
    aspectRatio?: string;
    maxWidth: string;
    maxHeight: string;
  };
  imageFit: "cover" | "contain";
  missingImageNote: string;
};

/**
 * The gallery image used to be `w-auto h-auto` inside an `inline-block`, so a
 * missing/failed image collapsed the stage to text width on a black page. The
 * stage now owns a bounded aspect ratio and the image fills it with
 * object-fit; a failed image gets an explicit, same-sized fallback.
 */
export function resolveGalleryStageMetrics(
  orientation: "portrait" | "landscape",
): GalleryStageMetrics {
  if (orientation === "portrait") {
    return {
      style: {
        width: "100vw",
        height: "100dvh",
        maxWidth: "100vw",
        maxHeight: "100dvh",
      },
      imageFit: "cover",
      missingImageNote: "这一幕的画面暂时无法显示，但本幕对话和选项仍可查看。",
    };
  }
  return {
    style: {
      width: "min(100vw, calc(100dvh * 16 / 9))",
      height: "min(calc(100vw * 9 / 16), 100dvh)",
      aspectRatio: "16 / 9",
      maxWidth: "100vw",
      maxHeight: "100dvh",
    },
    imageFit: "contain",
    missingImageNote: "这一幕的画面暂时无法显示，但本幕对话和选项仍可查看。",
  };
}
