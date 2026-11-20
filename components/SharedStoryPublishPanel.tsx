"use client";

import { useState } from "react";

import type { Session } from "@infiplot/types";
import { useLocalePath } from "@/lib/i18n/hooks";
import {
  DEFAULT_SHARED_TITLE,
  DEFAULT_SHARED_VISIBILITY,
  SharedStoryProjectionError,
  buildSharedStoryDocument,
  buildSharedStoryPostBody,
  parseSharedList,
  parseSharedSummary,
  type SharedDocument,
  type SharedStoryPostBody,
  type SharedStoryVisibility,
  type SharedSummary,
} from "@/lib/shared-stories/clientProjection";
import {
  resolvePublishSubmission,
  type PublishLookup,
} from "@/lib/shared-stories/publishPolicy";
import {
  SHARED_STORY_DISABLED_MESSAGE,
  readSharingDisabled,
} from "@/lib/shared-stories/shareAvailability";

const LIST_ENDPOINT = "/api/shared-stories";
const SAVE_ENDPOINT = "/api/shared-stories";
const MINE_PAGE_LIMIT = 20;

type NoticeTone = "info" | "success" | "warning" | "error";

type Notice = {
  tone: NoticeTone;
  text: string;
};

type ExistingLookup =
  | { status: "found"; item: SharedSummary }
  | { status: "missing" }
  | { status: "login" }
  | { status: "disabled" }
  | { status: "unknown" };

function noticeClassName(tone: NoticeTone): string {
  switch (tone) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "error":
      return "border-rose-200 bg-rose-50 text-rose-800";
    default:
      return "border-sky-200 bg-sky-50 text-sky-800";
  }
}

function failureForStatus(status: number): Notice {
  switch (status) {
    case 400:
      return { tone: "error", text: "分享内容格式不正确，请稍后重试。" };
    case 404:
      return { tone: "error", text: "作品不存在或已被删除，请刷新「我的作品」后重试。" };
    case 409:
      return {
        tone: "warning",
        text: "作品已在其他窗口更新，请先刷新「我的作品」后重试。",
      };
    case 413:
      return { tone: "error", text: "内容过大，暂时无法保存。请减少场景数量后重试。" };
    case 503:
      return { tone: "error", text: "分享服务繁忙，请稍后重试。" };
    default:
      return { tone: "error", text: "暂时无法完成操作，请稍后重试。" };
  }
}

function successFor(
  visibility: SharedStoryVisibility,
  mode: "save" | "patch",
): Notice {
  if (visibility === "hidden") {
    return {
      tone: "success",
      text:
        mode === "save"
          ? "已保存（当前为隐藏）。旧分享链接会返回 404；已下载或截图的内容无法收回。"
          : "已设为隐藏。旧分享链接会返回 404；已下载或截图的内容无法收回。",
    };
  }
  return mode === "save"
    ? { tone: "success", text: "已保存并公开，所有人可在社区看到。" }
    : { tone: "success", text: "已设为公开，所有人可在社区看到。" };
}

/** Projection failures are safe Chinese copy; never leak raw exceptions. */
function projectionErrorMessage(error: unknown): string {
  if (error instanceof SharedStoryProjectionError) return error.message;
  return "当前故事包含暂不支持分享的内容，无法保存。";
}

async function fetchMinePage(
  cursor: string | null,
): Promise<
  { ok: true; payload: unknown } | { ok: false; status: number; disabled: boolean }
> {
  const params = new URLSearchParams({ mine: "1" });
  if (cursor) params.set("cursor", cursor);
  try {
    const response = await fetch(`${LIST_ENDPOINT}?${params.toString()}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        disabled: await readSharingDisabled(response),
      };
    }
    const payload: unknown = await response.json().catch(() => null);
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 0, disabled: false };
  }
}

/**
 * Explicit, paginated owner lookup used only when the user presses Save.
 * Matching `sourceId` lets us reuse the existing revision and preserve an
 * existing hidden state. Any failure other than a clean 401 is `unknown` and
 * aborts the save before it is submitted.
 */
async function findExistingWork(sourceId: string): Promise<ExistingLookup> {
  let cursor: string | null = null;
  for (let page = 0; page < MINE_PAGE_LIMIT; page += 1) {
    const result = await fetchMinePage(cursor);
    if (!result.ok) {
      if (result.status === 401) return { status: "login" };
      if (result.disabled) return { status: "disabled" };
      return { status: "unknown" };
    }
    const parsed = parseSharedList(result.payload);
    if (!parsed) return { status: "unknown" };
    const match = parsed.items.find((item) => item.sourceId === sourceId);
    if (match) return { status: "found", item: match };
    if (!parsed.nextCursor) return { status: "missing" };
    cursor = parsed.nextCursor;
  }
  return { status: "unknown" };
}

function toPolicyLookup(lookup: ExistingLookup): PublishLookup {
  if (lookup.status === "found") {
    return {
      status: "found",
      item: { visibility: lookup.item.visibility, revision: lookup.item.revision },
    };
  }
  // A disabled environment cannot verify ownership either: treat it like any
  // other unverified lookup so the untouched policy aborts before POST.
  if (lookup.status === "disabled") return { status: "unknown" };
  return lookup;
}

type PanelProps = {
  session: Session | null;
  className?: string;
};

export function SharedStoryPublishPanel({ session, className }: PanelProps) {
  // Remounting the body on every session identity change guarantees a pending
  // request from the previous session can never write into the new session's
  // UI or saved id state.
  const sessionKey = session?.id ?? "no-session";
  return (
    <SharedStoryPublishPanelBody
      key={sessionKey}
      session={session}
      className={className}
    />
  );
}

function SharedStoryPublishPanelBody({ session, className }: PanelProps) {
  const localePath = useLocalePath();
  const [title, setTitle] = useState(DEFAULT_SHARED_TITLE);
  const [visibility, setVisibility] = useState<SharedStoryVisibility>(
    DEFAULT_SHARED_VISIBILITY,
  );
  const [visibilityTouched, setVisibilityTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SharedSummary | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loginRequired, setLoginRequired] = useState(false);

  async function applyResponse(
    response: Response,
    mode: "save" | "patch",
  ): Promise<void> {
    if (!response.ok) {
      if (response.status === 401) {
        setLoginRequired(true);
        setNotice({
          tone: "warning",
          text: "请先登录后再保存或修改作品。当前故事不会被清除。",
        });
        return;
      }
      if (await readSharingDisabled(response)) {
        setNotice({ tone: "info", text: SHARED_STORY_DISABLED_MESSAGE });
        return;
      }
      setNotice(failureForStatus(response.status));
      return;
    }

    const payload: unknown = await response.json().catch(() => null);
    const item = parseSharedSummary(payload);
    if (!item) {
      setNotice({
        tone: "error",
        text: "保存结果暂时无法确认，请稍后刷新「我的作品」查看。",
      });
      return;
    }

    setSaved(item);
    setTitle(item.title);
    setVisibility(item.visibility);
    setVisibilityTouched(false);
    setLoginRequired(false);
    setNotice(successFor(item.visibility, mode));
  }

  async function refreshSavedFromServer(
    sourceId: string | undefined,
  ): Promise<boolean> {
    if (!sourceId) return false;
    const lookup = await findExistingWork(sourceId);
    if (lookup.status !== "found") return false;
    setSaved(lookup.item);
    setTitle(lookup.item.title);
    setVisibility(lookup.item.visibility);
    setVisibilityTouched(false);
    setLoginRequired(false);
    return true;
  }

  async function handleSave(): Promise<void> {
    if (!session) {
      setNotice({
        tone: "info",
        text: "先在故事中生成内容，再来保存与分享。",
      });
      return;
    }

    // Validate the projection BEFORE any lookup or POST. Authored/video/
    // invalid-image snapshots surface a clear Chinese error here.
    let document: SharedDocument;
    try {
      document = buildSharedStoryDocument(session);
    } catch (error) {
      setNotice({ tone: "error", text: projectionErrorMessage(error) });
      return;
    }
    if (document.scenes.length === 0) {
      setNotice({
        tone: "info",
        text: "当前故事还没有可保存的剧情内容。",
      });
      return;
    }

    setSaving(true);
    setNotice(null);
    setLoginRequired(false);

    try {
      const lookup = await findExistingWork(session.id);
      const submission = resolvePublishSubmission(
        toPolicyLookup(lookup),
        visibility,
        visibilityTouched,
      );

      if (submission.type === "abort") {
        if (submission.reason === "login") {
          setLoginRequired(true);
          setNotice({
            tone: "warning",
            text: "请先登录后再保存作品。当前故事不会被清除。",
          });
        } else if (lookup.status === "disabled") {
          setNotice({ tone: "info", text: SHARED_STORY_DISABLED_MESSAGE });
        } else {
          setNotice({
            tone: "error",
            text: "无法确认「我的作品」列表，为避免误将隐藏作品公开，已取消本次保存。请稍后刷新重试。",
          });
        }
        return;
      }

      let body: SharedStoryPostBody;
      try {
        body = buildSharedStoryPostBody(
          session,
          title,
          submission.visibility,
        );
      } catch (error) {
        setNotice({ tone: "error", text: projectionErrorMessage(error) });
        return;
      }

      if (!submission.includeVisibility) {
        // Existing work whose select was untouched: let the server preserve
        // the saved visibility instead of re-applying the default "public".
        delete body.visibility;
      }
      if (submission.expectedRevision !== undefined) {
        body.expectedRevision = submission.expectedRevision;
      }

      const response = await fetch(SAVE_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 409) {
        const refreshed = await refreshSavedFromServer(session.id);
        setNotice({
          tone: "warning",
          text: refreshed
            ? "作品已在其他窗口更新，已刷新作品信息，请确认后重试。"
            : failureForStatus(409).text,
        });
        return;
      }

      await applyResponse(response, "save");
    } catch {
      // The POST may have reached the server; never claim the work was not
      // saved. Tell the user the result is unknown and to verify first.
      setNotice({
        tone: "error",
        text: "网络异常，保存结果未知。请先刷新「我的作品」确认，避免重复公开或重复保存。",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleApplyVisibility(): Promise<void> {
    if (!saved) {
      setNotice({
        tone: "info",
        text: "请先保存作品，再修改可见性。",
      });
      return;
    }
    if (saved.visibility === visibility) {
      setNotice({ tone: "info", text: "当前可见性无需修改。" });
      return;
    }

    setSaving(true);
    setNotice(null);
    setLoginRequired(false);

    try {
      const response = await fetch(
        `${SAVE_ENDPOINT}/${encodeURIComponent(saved.id)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            visibility,
            expectedRevision: saved.revision,
          }),
        },
      );
      if (response.status === 409) {
        const refreshed = await refreshSavedFromServer(session?.id);
        setNotice({
          tone: "warning",
          text: refreshed
            ? "作品已在其他窗口更新，已刷新作品信息，请确认后重试。"
            : failureForStatus(409).text,
        });
        return;
      }
      await applyResponse(response, "patch");
    } catch {
      setNotice({
        tone: "error",
        text: "网络异常，可见性修改结果未知。请先刷新「我的作品」确认，避免重复操作。",
      });
    } finally {
      setSaving(false);
    }
  }

  const hasPendingVisibilityChange =
    saved !== null && saved.visibility !== visibility;
  const hiddenSelected = visibility === "hidden";
  const saveLabel =
    visibility === "hidden" ? "保存作品（隐藏）" : "保存作品（默认公开）";

  return (
    <section
      aria-labelledby="shared-story-publish-heading"
      className={[
        "rounded-2xl border border-sky-200 bg-white/95 p-5 shadow-sm sm:p-6",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex flex-col gap-1">
        <h2
          id="shared-story-publish-heading"
          className="font-serif text-xl font-semibold text-slate-900"
        >
          保存并分享作品
        </h2>
        <p className="text-sm leading-relaxed text-slate-600">
          保存后所有人可见，可改为隐藏
        </p>
      </div>

      <div className="mt-4 grid gap-4">
        <label className="grid gap-1.5 text-sm text-slate-700">
          <span className="font-medium">作品标题</span>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={DEFAULT_SHARED_TITLE}
            maxLength={120}
            className="w-full rounded-lg border border-sky-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
          />
        </label>

        <label className="grid gap-1.5 text-sm text-slate-700">
          <span className="font-medium">可见性</span>
          <select
            value={visibility}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "public" || next === "hidden") {
                setVisibility(next);
                setVisibilityTouched(true);
              }
            }}
            className="w-full rounded-lg border border-sky-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
          >
            <option value="public">公开 — 所有人可在社区看到</option>
            <option value="hidden">隐藏 — 仅自己可见</option>
          </select>
        </label>

        <p className="rounded-lg border border-sky-100 bg-sky-50/70 px-3 py-2 text-xs leading-relaxed text-slate-600">
          分享内容是只读的已生成剧情快照，不包含提示词、设定或生成能力。包含视频或作者锁定内容的故事，以及缺少有效图片的幕，会在此处直接提示并不能保存。设为隐藏后，旧分享链接会返回 404；已下载或截图的内容无法收回。
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !session}
            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-sky-500 bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "正在保存…" : saveLabel}
          </button>

          {hasPendingVisibilityChange ? (
            <button
              type="button"
              onClick={() => void handleApplyVisibility()}
              disabled={saving}
              className="inline-flex min-h-10 items-center justify-center rounded-lg border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-700 transition hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              更新可见性
            </button>
          ) : null}
        </div>

        {!session ? (
          <p className="text-sm leading-relaxed text-slate-500">
            当前没有可分享的故事。先在故事中生成内容，再来保存与分享。
          </p>
        ) : null}

        {saved ? (
          <p className="text-xs leading-relaxed text-slate-500">
            已保存版本：{saved.visibility === "public" ? "公开" : "隐藏"} · 修订{" "}
            {saved.revision}
          </p>
        ) : null}

        {hiddenSelected || saved?.visibility === "hidden" ? (
          <p className="text-xs leading-relaxed text-amber-700">
            隐藏仅在操作成功后才生效。隐藏后旧链接会返回 404，但已下载或截图的内容无法收回。
          </p>
        ) : null}

        {loginRequired ? (
          <p className="text-sm leading-relaxed text-amber-800">
            需要登录后才能保存或修改作品。{" "}
            <a
              href={localePath("/")}
              className="font-medium text-sky-700 underline underline-offset-2 hover:text-sky-800"
            >
              返回首页登录
            </a>
          </p>
        ) : null}

        {notice ? (
          <p
            role="status"
            aria-live="polite"
            className={[
              "rounded-lg border px-3 py-2 text-sm leading-relaxed",
              noticeClassName(notice.tone),
            ].join(" ")}
          >
            {notice.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default SharedStoryPublishPanel;
