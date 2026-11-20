"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useLocalePath } from "@/lib/i18n/hooks";
import {
  parseSharedList,
  parseSharedSummary,
  safeMediaUrl,
  type SharedStoryVisibility,
  type SharedSummary,
} from "@/lib/shared-stories/clientProjection";
import {
  SHARED_STORY_DISABLED_MESSAGE,
  readSharingDisabled,
} from "@/lib/shared-stories/shareAvailability";

const ENDPOINT = "/api/shared-stories";

type Tab = "public" | "mine";

type ListState =
  | { status: "loading" }
  | { status: "error"; kind: "login" | "network" | "server" | "disabled" }
  | { status: "ready"; items: SharedSummary[]; nextCursor: string | null };

type NoticeTone = "info" | "success" | "warning" | "error";

type Notice = {
  tone: NoticeTone;
  text: string;
};

type ListResult =
  | { ok: true; items: SharedSummary[]; nextCursor: string | null }
  | { ok: false; kind: "login" | "network" | "server" | "disabled" };

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

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

function listErrorText(
  kind: "login" | "network" | "server" | "disabled",
): string {
  switch (kind) {
    case "login":
      return "「我的作品」需要登录后查看。";
    case "network":
      return "网络异常，暂时无法加载共享故事。";
    case "disabled":
      return SHARED_STORY_DISABLED_MESSAGE;
    default:
      return "共享故事服务暂时不可用，请稍后重试。";
  }
}

async function requestList(
  tab: Tab,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ListResult> {
  const params = new URLSearchParams();
  if (tab === "mine") params.set("mine", "1");
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  const url = query ? `${ENDPOINT}?${query}` : ENDPOINT;

  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status === 401) return { ok: false, kind: "login" };
    if (!response.ok) {
      if (await readSharingDisabled(response)) {
        return { ok: false, kind: "disabled" };
      }
      return { ok: false, kind: "server" };
    }
    const payload: unknown = await response.json().catch(() => null);
    const parsed = parseSharedList(payload);
    if (!parsed) return { ok: false, kind: "server" };
    return { ok: true, items: parsed.items, nextCursor: parsed.nextCursor };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function SharedStoryLibrary({ className }: { className?: string }) {
  const localePath = useLocalePath();
  const [tab, setTab] = useState<Tab>("public");
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const listController = useRef<AbortController | null>(null);

  useEffect(() => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoadingMore(false);
    setState({ status: "loading" });

    void requestList(tab, null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setState({
          status: "ready",
          items: result.items,
          nextCursor: result.nextCursor,
        });
      } else {
        setState({ status: "error", kind: result.kind });
      }
    });

    return () => {
      controller.abort();
    };
  }, [tab, refreshKey]);

  async function handleLoadMore(): Promise<void> {
    if (state.status !== "ready" || !state.nextCursor || loadingMore) return;

    setLoadingMore(true);
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;

    try {
      const result = await requestList(tab, state.nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setNotice({
          tone: result.kind === "disabled" ? "info" : "error",
          text: listErrorText(result.kind),
        });
        if (result.kind === "disabled") {
          // The environment will not serve further pages; drop the futile
          // "load more" action instead of offering a retry.
          setState((previous) =>
            previous.status === "ready"
              ? { ...previous, nextCursor: null }
              : previous,
          );
        }
        return;
      }
      setState((previous) => {
        if (previous.status !== "ready") return previous;
        return {
          status: "ready",
          items: [...previous.items, ...result.items],
          nextCursor: result.nextCursor,
        };
      });
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  async function handleToggleVisibility(item: SharedSummary): Promise<void> {
    const nextVisibility: SharedStoryVisibility =
      item.visibility === "public" ? "hidden" : "public";
    setActionId(item.id);
    setNotice(null);

    try {
      const response = await fetch(
        `${ENDPOINT}/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            visibility: nextVisibility,
            expectedRevision: item.revision,
          }),
        },
      );

      if (response.status === 401) {
        setNotice({
          tone: "warning",
          text: "请先登录后再修改作品可见性。",
        });
        return;
      }
      if (response.status === 404) {
        setNotice({
          tone: "error",
          text: "作品不存在或已被删除，正在刷新列表。",
        });
        setRefreshKey((key) => key + 1);
        return;
      }
      if (response.status === 409) {
        setNotice({
          tone: "warning",
          text: "作品已在其他窗口更新，正在刷新列表，请重试。",
        });
        setRefreshKey((key) => key + 1);
        return;
      }
      if (response.status === 413) {
        setNotice({ tone: "error", text: "内容过大，暂时无法保存。" });
        return;
      }
      if (response.status === 503) {
        setNotice(
          (await readSharingDisabled(response))
            ? { tone: "info", text: SHARED_STORY_DISABLED_MESSAGE }
            : { tone: "error", text: "分享服务繁忙，请稍后重试。" },
        );
        return;
      }
      if (!response.ok) {
        setNotice({ tone: "error", text: "暂时无法修改可见性，请稍后重试。" });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const updated = parseSharedSummary(payload);
      if (!updated) {
        setNotice({
          tone: "error",
          text: "可见性修改结果暂时无法确认，正在刷新列表。",
        });
        setRefreshKey((key) => key + 1);
        return;
      }

      setNotice({
        tone: "success",
        text:
          updated.visibility === "hidden"
            ? "已设为隐藏。旧分享链接会返回 404；已下载或截图的内容无法收回。"
            : "已设为公开，所有人可在社区看到。",
      });
      setRefreshKey((key) => key + 1);
    } catch {
      setNotice({
        tone: "error",
        text: "网络异常，暂时无法确认可见性修改，请稍后刷新列表。",
      });
    } finally {
      setActionId(null);
    }
  }

  const isMine = tab === "mine";

  return (
    <section
      aria-labelledby="shared-story-library-heading"
      className={["w-full", className].filter(Boolean).join(" ")}
    >
      <div className="flex flex-col gap-2">
        <h2
          id="shared-story-library-heading"
          className="font-serif text-2xl font-semibold text-slate-900"
        >
          共享故事社区
        </h2>
        <p className="text-sm leading-relaxed text-slate-600">
          看看大家公开分享的故事，也可以管理自己的作品。
        </p>
      </div>

      <div
        role="tablist"
        aria-label="共享故事视图"
        className="mt-4 inline-flex rounded-xl border border-sky-200 bg-sky-50/70 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={!isMine}
          onClick={() => setTab("public")}
          className={[
            "min-h-9 rounded-lg px-4 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sky-200",
            isMine
              ? "text-slate-600 hover:text-slate-900"
              : "bg-white text-sky-700 shadow-sm",
          ].join(" ")}
        >
          社区故事
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isMine}
          onClick={() => setTab("mine")}
          className={[
            "min-h-9 rounded-lg px-4 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sky-200",
            isMine
              ? "bg-white text-sky-700 shadow-sm"
              : "text-slate-600 hover:text-slate-900",
          ].join(" ")}
        >
          我的作品
        </button>
      </div>

      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className={[
            "mt-4 rounded-lg border px-3 py-2 text-sm leading-relaxed",
            noticeClassName(notice.tone),
          ].join(" ")}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="mt-4">
        {state.status === "loading" ? (
          <p
            role="status"
            aria-live="polite"
            className="rounded-xl border border-sky-100 bg-white px-4 py-6 text-sm text-slate-500"
          >
            正在加载{isMine ? "我的作品" : "社区故事"}…
          </p>
        ) : null}

        {state.status === "error" ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-6 text-sm text-rose-800">
            <p className="leading-relaxed">{listErrorText(state.kind)}</p>
            {state.kind === "login" ? (
              <Link
                href={localePath("/")}
                className="mt-2 inline-block font-medium text-sky-700 underline underline-offset-2 hover:text-sky-800"
              >
                返回首页登录
              </Link>
            ) : state.kind === "disabled" ? null : (
              <button
                type="button"
                onClick={() => setRefreshKey((key) => key + 1)}
                className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-medium text-rose-700 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-200"
              >
                重试
              </button>
            )}
          </div>
        ) : null}

        {state.status === "ready" && state.items.length === 0 ? (
          <div className="rounded-xl border border-sky-100 bg-white px-4 py-8 text-center text-sm text-slate-500">
            <p>
              {isMine
                ? "你还没有保存作品。保存后会在这里看到。"
                : "还没有公开作品，来分享第一个故事吧。"}
            </p>
            {!isMine ? (
              <Link
                href={localePath("/")}
                className="mt-3 inline-block font-medium text-sky-700 underline underline-offset-2 hover:text-sky-800"
              >
                去创作新故事
              </Link>
            ) : null}
          </div>
        ) : null}

        {state.status === "ready" && state.items.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.items.map((item) => {
              const coverUrl = safeMediaUrl(item.coverUrl); // string | null
              const updatedAt = formatDate(item.updatedAt);
              return (
                <li key={item.id}>
                  <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm">
                    <Link
                      href={localePath(`/shared/${encodeURIComponent(item.id)}`)}
                      className="group block focus:outline-none focus:ring-2 focus:ring-sky-200"
                    >
                      <div className="aspect-[16/9] w-full overflow-hidden bg-sky-50">
                        {coverUrl ? (
                          <img
                            src={coverUrl}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
                            暂无封面
                          </div>
                        )}
                      </div>
                      <div className="p-4">
                        <h3 className="font-serif text-lg font-semibold leading-snug text-slate-900 group-hover:text-sky-700">
                          {item.title}
                        </h3>
                        <p className="mt-1 text-xs text-slate-500">
                          {item.sceneCount} 幕
                          {updatedAt ? ` · 更新于 ${updatedAt}` : ""}
                        </p>
                      </div>
                    </Link>

                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-sky-100 px-4 py-3">
                      <span
                        className={[
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                          item.visibility === "public"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-600",
                        ].join(" ")}
                      >
                        {item.visibility === "public" ? "公开" : "隐藏"}
                      </span>

                      {isMine ? (
                        <button
                          type="button"
                          onClick={() => void handleToggleVisibility(item)}
                          disabled={actionId !== null}
                          className="inline-flex min-h-8 items-center rounded-lg border border-sky-300 bg-white px-3 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {actionId === item.id
                            ? "正在更新…"
                            : item.visibility === "public"
                              ? "设为隐藏"
                              : "设为公开"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {state.status === "ready" && state.nextCursor ? (
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            onClick={() => void handleLoadMore()}
            disabled={loadingMore}
            className="inline-flex min-h-10 items-center rounded-lg border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-700 transition hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "正在加载更多…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default SharedStoryLibrary;
