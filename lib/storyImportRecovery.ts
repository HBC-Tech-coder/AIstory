// First-load recovery for the ?share=1 story import.
//
// The imported story document lives in the *current* tab's sessionStorage
// (STORY_SHARE_STORAGE_KEY). A new tab, a reopened browser, or a privacy
// restricted tab may lack a usable copy (opener cloning and session restore
// can preserve it). That is a recoverable import problem — not a
// provider/model/key failure — so this helper classifies it without throwing
// and without carrying the raw error or any imported data.
//
// Deliberately dependency-free (no React, no browser globals) so the
// regression script can exercise it under plain tsx.

/** A storage-like reader; only getItem is needed. */
export type StoryImportStorage = {
  getItem(key: string): string | null;
};

/**
 * - `missing`     — this tab may not have the imported copy (new tab, cleared,
 *                   or never imported here).
 * - `malformed`   — the stored value is not parseable into a story document.
 * - `unavailable` — browser storage itself could not be read at all.
 */
export type StoryImportIssue = "missing" | "malformed" | "unavailable";

export type StoryImportReadResult<TDoc> =
  | { status: "ok"; doc: TDoc }
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "unavailable" };

/**
 * Read and parse a tab-local imported story document.
 *
 * `getStorage` is a getter (not a storage instance) because accessing
 * `window.sessionStorage` can itself throw in restricted tabs. Parser
 * exceptions are folded into `malformed`, and no raw error text or document
 * content escapes this function. The stored value is never mutated.
 */
export function readStoryImportDoc<TDoc>(
  getStorage: () => StoryImportStorage | null | undefined,
  key: string,
  parse: (raw: string) => TDoc,
): StoryImportReadResult<TDoc> {
  let raw: string | null;
  try {
    const storage = getStorage();
    if (!storage) return { status: "missing" };
    raw = storage.getItem(key);
  } catch {
    return { status: "unavailable" };
  }

  if (raw === null || raw.trim() === "") return { status: "missing" };

  let doc: TDoc;
  try {
    doc = parse(raw);
  } catch {
    return { status: "malformed" };
  }
  return { status: "ok", doc };
}

export type StoryImportRecoveryCopy = {
  eyebrow: string;
  missingTitle: string;
  malformedTitle: string;
  body: string;
  missingNote: string;
  malformedNote: string;
  unavailableNote: string;
  homeImport: string;
};

/**
 * Fixed Chinese copy. The import entry point is Chinese-first, and this screen
 * intentionally never mentions providers, models, keys, or paid retries.
 */
export const STORY_IMPORT_RECOVERY_COPY: StoryImportRecoveryCopy = {
  eyebrow: "导入未完成",
  missingTitle: "当前标签没有已导入故事",
  malformedTitle: "剧情存档无法载入",
  body: "此入口需先从首页载入剧情文件（.infiplot）。这个链接本身不包含剧情内容；如果已在另一个标签页载入，请回到那个标签页继续，或返回首页重新载入。",
  missingNote: "没有在当前标签页找到已导入的剧情文件。",
  malformedNote: "当前标签页的剧情文件无法解析或已损坏。",
  unavailableNote: "当前标签页的浏览器存储无法读取。请回到首页重新载入剧情文件。",
  homeImport: "返回首页载入剧情",
};
