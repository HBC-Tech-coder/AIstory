"use client";

import Link from "next/link";

export function SteamCompletionCta({
  aboutHref,
  compact = false,
}: {
  aboutHref: string;
  compact?: boolean;
}) {
  return (
    <section
      data-steam-completion-cta
      aria-label="章节完成后的 AIstory 创作介绍"
      className={`rounded-2xl border border-blue-300/35 bg-slate-950/90 text-white shadow-2xl backdrop-blur-md ${
        compact
          ? "absolute inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 p-4"
          : "mt-4 w-full max-w-4xl px-5 py-4 md:px-7"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-300">
            Made with AIstory
          </p>
          <h2 className="mt-1 font-serif text-lg leading-snug md:text-xl">
            喜欢这个世界？使用 AIstory，创作属于你的互动影游。
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-300">
            这是章节完成后的可选介绍，不影响继续游玩，也不会提供点击或注册奖励。
          </p>
        </div>
        <Link
          href={aboutHref}
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-blue-300/60 bg-blue-500 px-5 text-sm font-semibold text-white transition hover:bg-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300"
        >
          了解 AIstory 创作引擎
        </Link>
      </div>
    </section>
  );
}
