// Small, pure helpers shared by /play's first-load recovery screens.
//
// These are deliberately dependency-free so the regression test can exercise
// them without a browser or the Next.js runtime.

export const CUSTOM_PLAY_DRAFT_STORAGE_KEY = "infiplot:custom";

export type CustomPlayDraft = {
  worldSetting: string;
  styleGuide: string;
  audioEnabled?: boolean;
  styleReferenceImage?: string;
  playerName?: string;
};

export type CustomPlayDraftUnavailableReason = "missing" | "malformed";

export type CustomPlayDraftReadResult =
  | { status: "ok"; draft: CustomPlayDraft }
  | { status: "missing" }
  | { status: "malformed" };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse the tab-local custom-story draft without ever throwing.
 *
 * The draft lives in sessionStorage so it is intentionally tab-local and is
 * never placed in the URL. A missing entry, corrupt JSON, or a JSON value that
 * is not an object with the required story fields all surface as a recoverable
 * result instead of an exception escaping the bootstrap effect.
 */
export function parseCustomPlayDraft(
  raw: string | null | undefined,
): CustomPlayDraftReadResult {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { status: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(record.worldSetting) ||
    !isNonEmptyString(record.styleGuide)
  ) {
    return { status: "malformed" };
  }

  const draft: CustomPlayDraft = {
    worldSetting: record.worldSetting,
    styleGuide: record.styleGuide,
  };
  if (typeof record.audioEnabled === "boolean") {
    draft.audioEnabled = record.audioEnabled;
  }
  if (isNonEmptyString(record.styleReferenceImage)) {
    draft.styleReferenceImage = record.styleReferenceImage;
  }
  if (isNonEmptyString(record.playerName)) {
    draft.playerName = record.playerName;
  }
  return { status: "ok", draft };
}

export type CustomPlayDraftStorage = {
  getItem(key: string): string | null;
};

/**
 * Safe reader for the custom draft. Storage access itself can throw in
 * privacy-restricted tabs, so that failure is folded into the same
 * recoverable "malformed" result the UI already knows how to explain.
 */
export function readCustomPlayDraft(
  storage: CustomPlayDraftStorage | null | undefined,
  key: string = CUSTOM_PLAY_DRAFT_STORAGE_KEY,
): CustomPlayDraftReadResult {
  if (!storage) return { status: "missing" };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "malformed" };
  }
  return parseCustomPlayDraft(raw);
}

export type PlayIssueRecoveryCopy = {
  authPausedEyebrow: string;
  authPausedTitle: string;
  authPausedBody: string;
  authPausedDraftNote: string;
  authReopenLogin: string;
  authHome: string;
  customDraftEyebrow: string;
  customDraftTitle: string;
  customDraftBody: string;
  customDraftMissingNote: string;
  customDraftMalformedNote: string;
  customDraftHome: string;
};

const RECOVERY_COPY: Record<string, PlayIssueRecoveryCopy> = {
  "zh-CN": {
    authPausedEyebrow: "已暂停 · 等待登录",
    authPausedTitle: "登录后才能继续生成",
    authPausedBody: "首幕生成已暂停。登录后可继续，或返回首页。",
    authPausedDraftNote:
      "你的输入没有被清除。登录后，本页会重试一次首幕生成。",
    authReopenLogin: "重新打开登录",
    authHome: "返回首页",
    customDraftEyebrow: "草稿不可用",
    customDraftTitle: "当前标签页的自定义草稿已不可用",
    customDraftBody:
      "当前标签页找不到可用的自定义故事草稿。请回到原来的标签页，或返回首页重新输入你的故事。",
    customDraftMissingNote: "没有在当前标签页找到可用的自定义草稿。",
    customDraftMalformedNote: "当前标签页的自定义草稿无法安全解析。",
    customDraftHome: "回到首页重新编辑",
  },
  en: {
    authPausedEyebrow: "Paused · sign-in required",
    authPausedTitle: "Sign in to continue generating",
    authPausedBody:
      "Opening scene generation is paused. Sign in to continue or return home.",
    authPausedDraftNote:
      "Your inputs have not been cleared. After signing in, this page will retry the opening scene once.",
    authReopenLogin: "Reopen sign-in",
    authHome: "Back to home",
    customDraftEyebrow: "Draft unavailable",
    customDraftTitle: "This tab's custom draft is unavailable",
    customDraftBody:
      "This tab could not find a usable custom story draft. Return to the original tab or return home and enter your story again.",
    customDraftMissingNote:
      "No usable custom draft was found in this browser tab.",
    customDraftMalformedNote:
      "The custom draft in this browser tab could not be parsed safely.",
    customDraftHome: "Go home to edit again",
  },
  ja: {
    authPausedEyebrow: "一時停止 · ログイン待ち",
    authPausedTitle: "続行するにはログインが必要です",
    authPausedBody:
      "最初のシーン生成を一時停止しています。続けるにはログインするか、ホームに戻ってください。",
    authPausedDraftNote:
      "入力内容は削除されていません。ログイン後、このページで最初のシーン生成を一度だけ再試行します。",
    authReopenLogin: "ログインを開き直す",
    authHome: "ホームに戻る",
    customDraftEyebrow: "草案を利用できません",
    customDraftTitle: "このタブのカスタム草案は利用できません",
    customDraftBody:
      "このタブでは利用できるカスタムストーリー草案が見つかりませんでした。元のタブに戻るか、ホームに戻って物語を入力し直してください。",
    customDraftMissingNote:
      "このブラウザタブに利用可能なカスタム草案が見つかりません。",
    customDraftMalformedNote:
      "このブラウザタブのカスタム草案を安全に解析できませんでした。",
    customDraftHome: "ホームで編集し直す",
  },
};

export function playIssueRecoveryCopy(locale: string): PlayIssueRecoveryCopy {
  return RECOVERY_COPY[locale] ?? RECOVERY_COPY["zh-CN"]!;
}
