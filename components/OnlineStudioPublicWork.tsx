"use client";

import { useEffect, useState } from "react";

import type { StudioPublicProject } from "@/lib/creator-studio/online/types";

export function OnlineStudioPublicWork({
  id,
  studioHref,
}: {
  id: string;
  studioHref: string;
}) {
  const [work, setWork] = useState<StudioPublicProject | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "unavailable">("loading");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/studio/public/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 404) {
        setState("missing");
        return;
      }
      if (!response.ok) {
        setState("unavailable");
        return;
      }
      const payload = (await response.json()) as StudioPublicProject;
      setWork(payload);
      setState("ready");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState("unavailable");
    });
    return () => controller.abort();
  }, [id]);

  return (
    <main className="ui-page min-h-screen p-4 lg:p-8">
      <div className="mx-auto max-w-3xl">
        <a href={studioHref} className="ui-primary text-sm underline">返回创作者工作台</a>
        {state === "loading" ? <p className="ui-muted mt-8">正在读取作品…</p> : null}
        {state === "missing" ? <p className="ui-muted mt-8">作品不存在或已隐藏。</p> : null}
        {state === "unavailable" ? <p className="ui-muted mt-8">作品暂时无法读取，请稍后重试。</p> : null}
        {state === "ready" && work ? (
          <article className="ui-surface mt-6 border p-5 lg:p-8">
            <h1 className="font-serif text-3xl">{work.title}</h1>
            {work.synopsis ? <p className="ui-muted mt-3 whitespace-pre-wrap leading-7">{work.synopsis}</p> : null}
            <div className="mt-8 space-y-8">
              {work.scenes.map((scene) => (
                <section key={scene.id}>
                  <h2 className="font-serif text-xl">{scene.heading}</h2>
                  <p className="mt-3 whitespace-pre-wrap leading-8">{scene.body}</p>
                </section>
              ))}
            </div>
          </article>
        ) : null}
      </div>
    </main>
  );
}
