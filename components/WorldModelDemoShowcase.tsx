"use client";

import Image from "next/image";
import Link from "next/link";

import { useLocalePath } from "@/lib/i18n/hooks";
import {
  formatWorldModelDuration,
  WORLD_MODEL_DEMOS,
} from "@/lib/world-model-demos/catalog";

export function WorldModelDemoShowcase() {
  const lp = useLocalePath();

  return (
    <section
      className="mx-auto w-full max-w-[1640px] px-6 pb-2 pt-1 md:px-16 md:pb-3 md:pt-2"
      aria-labelledby="world-model-demo-title"
      data-world-model-demo-showcase
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 md:mb-5">
        <div>
          <p className="font-sans text-[11px] font-semibold tracking-[0.24em] text-blue-600 xl:text-xs">
            WORLD MODEL SHOWCASE
          </p>
          <h2
            id="world-model-demo-title"
            className="mt-1 font-serif text-2xl text-clay-900 md:text-[30px] xl:text-[33px] xl:leading-[35px]"
          >
            世界模型 · 第一视角互动体验
          </h2>
          <p className="mt-1 text-sm leading-6 text-clay-500 xl:text-[15.5px] xl:leading-[26px]">
            从一次触碰开始，看看画面之后的故事会怎样发展。
          </p>
        </div>
        <p className="rounded-full border border-blue-500/20 bg-blue-500/[0.06] px-3 py-1.5 text-xs text-blue-700 xl:text-[13px]">
          5 段视频 · 结尾可选择
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {WORLD_MODEL_DEMOS.map((demo) => (
          <Link
            key={demo.id}
            href={lp(demo.playPath)}
            prefetch={false}
            className="group overflow-hidden rounded-lg border border-blue-500/15 bg-white/65 shadow-[0_14px_38px_rgba(37,78,255,0.07)] transition duration-300 hover:-translate-y-1 hover:border-blue-500/35 hover:shadow-[0_18px_44px_rgba(37,78,255,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            data-world-model-demo-id={demo.id}
          >
            <div className="relative aspect-video overflow-hidden bg-clay-900">
              <Image
                src={demo.posterUrl}
                alt={`${demo.title}视频封面`}
                fill
                sizes="(min-width: 1024px) 19vw, (min-width: 640px) 48vw, 92vw"
                className="object-cover transition duration-500 group-hover:scale-[1.035]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-black/10" />
              <span className="absolute left-3 top-3 rounded-full border border-white/25 bg-black/45 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm xl:text-[11px]">
                世界模型生成
              </span>
              <span className="absolute right-3 top-3 rounded bg-black/55 px-2 py-1 text-[10px] tabular-nums text-white xl:text-[11px]">
                {formatWorldModelDuration(demo.durationMs)}
              </span>
              <span className="absolute bottom-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/45 bg-white/90 text-blue-600 shadow-lg transition group-hover:scale-110">
                <i className="fa-solid fa-play pl-0.5 text-xs" aria-hidden />
              </span>
            </div>
            <div className="p-4">
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-blue-600 xl:text-[11px]">
                <span>第一视角演示</span>
                <span className="h-px flex-1 bg-blue-500/15" />
              </div>
              <h3 className="font-serif text-lg text-clay-900 xl:text-xl">
                {demo.title}
              </h3>
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-clay-500 xl:text-[13px] xl:leading-[21px]">
                {demo.summary}
              </p>
              <span className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-blue-600 xl:text-[13px]">
                进入互动播放
                <i className="fa-solid fa-arrow-right text-[10px] transition-transform group-hover:translate-x-1" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
