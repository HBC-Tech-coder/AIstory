"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useLocalePath } from "@/lib/i18n/hooks";
import {
  isAllowedMediaUrl,
  parseSharedStoryDetail,
  type SharedStoryDetail,
} from "@/lib/shared-stories/clientProjection";

type ReaderState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: SharedStoryDetail };

function sceneAnchorId(sceneIndex: number): string {
  return `scene-${sceneIndex}`;
}

function beatAnchorId(sceneIndex: number, beatIndex: number): string {
  return `beat-${sceneIndex}-${beatIndex}`;
}

function beatKey(sceneId: string, beatId: string): string {
  return `${sceneId}\u0000${beatId}`;
}

export function SharedStoryReader({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const localePath = useLocalePath();
  const [state, setState] = useState<ReaderState>({ status: "loading" });

  useEffect(() => {
    if (!id) {
      setState({ status: "not-found" });
      return;
    }

    const controller = new AbortController();
    setState({ status: "loading" });

    void (async () => {
      try {
        const response = await fetch(
          `/api/shared-stories/${encodeURIComponent(id)}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );

        if (controller.signal.aborted) return;

        if (response.status === 404) {
          setState({ status: "not-found" });
          return;
        }
        if (response.status === 401) {
          setState({
            status: "error",
            message: "请先登录后再查看该作品。",
          });
          return;
        }
        if (!response.ok) {
          setState({
            status: "error",
            message:
              response.status === 503
                ? "分享服务繁忙，请稍后重试。"
                : "暂时无法加载该作品，请稍后重试。",
          });
          return;
        }

        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;

        const detail = parseSharedStoryDetail(payload);
        if (!detail) {
          setState({
            status: "error",
            message: "作品内容暂时无法确认，请稍后重试。",
          });
          return;
        }

        setState({ status: "ready", detail });
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: "网络异常，请稍后重试。" });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [id]);

  const backLink = (
    <Link
      href={localePath("/community")}
      className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-700 transition hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-200"
    >
      ← 返回社区
    </Link>
  );

  if (state.status === "loading") {
    return (
      <section
        aria-labelledby="shared-story-reader-heading"
        className={["w-full", className].filter(Boolean).join(" ")}
      >
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl border border-sky-100 bg-white px-4 py-6 text-sm text-slate-500"
        >
          正在加载故事…
        </p>
      </section>
    );
  }

  if (state.status === "not-found") {
    return (
      <section
        aria-labelledby="shared-story-reader-heading"
        className={["w-full", className].filter(Boolean).join(" ")}
      >
        <h1
          id="shared-story-reader-heading"
          className="font-serif text-2xl font-semibold text-slate-900"
        >
          作品不可用
        </h1>
        <p className="mt-3 rounded-xl border border-sky-100 bg-white px-4 py-6 text-sm leading-relaxed text-slate-600">
          该作品不存在，或已被作者设为隐藏。
        </p>
        <div className="mt-4">{backLink}</div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section
        aria-labelledby="shared-story-reader-heading"
        className={["w-full", className].filter(Boolean).join(" ")}
      >
        <h1
          id="shared-story-reader-heading"
          className="font-serif text-2xl font-semibold text-slate-900"
        >
          无法查看作品
        </h1>
        <p
          role="status"
          aria-live="polite"
          className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-6 text-sm leading-relaxed text-rose-800"
        >
          {state.message}
        </p>
        <div className="mt-4">{backLink}</div>
      </section>
    );
  }

  const { detail } = state;
  const scenes = detail.document.scenes;

  // The contract makes every scene image mandatory and valid. If a response
  // ever violates it, show an explicit error instead of silently blanking it.
  if (scenes.some((scene) => !isAllowedMediaUrl(scene.imageUrl))) {
    return (
      <section
        aria-labelledby="shared-story-reader-heading"
        className={["w-full", className].filter(Boolean).join(" ")}
      >
        <h1
          id="shared-story-reader-heading"
          className="font-serif text-2xl font-semibold text-slate-900"
        >
          无法查看作品
        </h1>
        <p
          role="status"
          aria-live="polite"
          className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-6 text-sm leading-relaxed text-rose-800"
        >
          作品图片数据无效，暂时无法展示。
        </p>
        <div className="mt-4">{backLink}</div>
      </section>
    );
  }

  const sceneIndexById = new Map<string, number>();
  const beatIndexById = new Map<string, number>();
  scenes.forEach((scene, sceneIndex) => {
    sceneIndexById.set(scene.id, sceneIndex);
    scene.beats.forEach((beat, beatIndex) => {
      beatIndexById.set(beatKey(scene.id, beat.id), beatIndex);
    });
  });

  return (
    <article
      aria-labelledby="shared-story-reader-heading"
      className={["w-full", className].filter(Boolean).join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            id="shared-story-reader-heading"
            className="font-serif text-2xl font-semibold leading-tight text-slate-900 sm:text-3xl"
          >
            {detail.title}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            共 {scenes.length} 幕 · 公开分享快照
          </p>
        </div>
        {backLink}
      </div>

      <p className="mt-4 rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-xs leading-relaxed text-slate-600">
        这是只读的静态剧情快照，仅展示已生成的画面与文字；不会继续生成剧情，也不会自动播放媒体。
      </p>

      {scenes.length === 0 ? (
        <p className="mt-4 rounded-xl border border-sky-100 bg-white px-4 py-6 text-sm text-slate-500">
          这个作品还没有可阅读的剧情内容。
        </p>
      ) : null}

      <div className="mt-5 grid gap-6">
        {scenes.map((scene, sceneIndex) => (
          <section
            key={`${scene.id}-${sceneIndex}`}
            id={sceneAnchorId(sceneIndex)}
            className="scroll-mt-24 overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm"
          >
            <div className="aspect-[16/9] w-full bg-sky-50">
              <img
                src={scene.imageUrl}
                alt={`第 ${sceneIndex + 1} 幕画面`}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>

            <div className="grid gap-4 p-4 sm:p-5">
              {scene.beats.map((beat, beatIndex) => {
                const choices =
                  beat.next.type === "choice" ? beat.next.choices : [];
                return (
                  <div
                    key={beat.id}
                    id={beatAnchorId(sceneIndex, beatIndex)}
                    className="grid scroll-mt-24 gap-2"
                  >
                    {beat.narration ? (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                        {beat.narration}
                      </p>
                    ) : null}
                    {beat.speaker || beat.line ? (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                        {beat.speaker ? (
                          <span className="font-serif font-semibold text-sky-800">
                            {beat.speaker}
                          </span>
                        ) : null}
                        {beat.speaker && beat.line ? "：" : ""}
                        {beat.line ?? ""}
                      </p>
                    ) : null}

                    {choices.length > 0 ? (
                      <ul className="mt-1 flex flex-wrap gap-2">
                        {choices.map((choice) => {
                          const targetSceneIndex = choice.target
                            ? sceneIndexById.get(choice.target.sceneId)
                            : undefined;
                          const targetBeatIndex = choice.target
                            ? beatIndexById.get(
                                beatKey(
                                  choice.target.sceneId,
                                  choice.target.beatId,
                                ),
                              )
                            : undefined;
                          const targetHref =
                            targetSceneIndex !== undefined &&
                            targetBeatIndex !== undefined
                              ? `#${beatAnchorId(targetSceneIndex, targetBeatIndex)}`
                              : targetSceneIndex !== undefined
                                ? `#${sceneAnchorId(targetSceneIndex)}`
                                : null;

                          if (targetHref) {
                            return (
                              <li key={choice.id}>
                                <a
                                  href={targetHref}
                                  className="inline-flex min-h-9 items-center rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm text-sky-700 transition hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-200"
                                >
                                  {choice.label}
                                </a>
                              </li>
                            );
                          }
                          return (
                            <li key={choice.id}>
                              <button
                                type="button"
                                disabled
                                aria-disabled="true"
                                className="inline-flex min-h-9 cursor-not-allowed items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-400"
                                title="该选项的后续内容未生成，暂不可用"
                              >
                                {choice.label}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-6">{backLink}</div>
    </article>
  );
}

export default SharedStoryReader;
