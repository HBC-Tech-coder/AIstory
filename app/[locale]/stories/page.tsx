"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadStoryList, deleteStory } from "@/lib/clientStoryPersistence";
import type { StoryMeta } from "@/lib/persistence/types";
import { coerceEpoch } from "@/lib/persistence/types";
import { getFeaturedStoryTemplates, type FeaturedStoryTemplate } from "@/lib/featuredStories";
import { useLocalePath } from "@/lib/i18n/hooks";
import { useI18n } from "@/lib/i18n/client";

const AISTORY_THEME_STORAGE_KEY = "aistory:theme";
const LIBRARY_GENDERS: Array<"男性向" | "女性向"> = ["男性向", "女性向"];

type ItemStatus = {
  pinned?: boolean;
  hidden?: boolean;
  offline?: boolean;
};

function stableNumber(seed: string, min: number, max: number) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return min + (hash % (max - min + 1));
}

function formatDate(value: Date | string | number, locale: string) {
  const ms = coerceEpoch(value, NaN);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function templateStats(template: FeaturedStoryTemplate, index: number) {
  const plays = stableNumber(template.id, 860, 68_000);
  const players = Math.max(1, Math.round(plays * stableNumber(`${template.id}:rate`, 34, 82) / 100));
  const revenue = plays * stableNumber(`${template.id}:revenue`, 2, 18) / 100;
  const daysAgo = stableNumber(`${template.id}:days`, 0, 42);
  return {
    plays,
    players,
    revenue,
    updatedAt: Date.now() - daysAgo * 86_400_000,
    rank: index + 1,
  };
}

function storyTitle(story: StoryMeta) {
  const value = story.worldSetting.trim();
  if (!value) return "未命名互动剧";
  return value.length > 36 ? `${value.slice(0, 36)}...` : value;
}

export default function StoriesPage() {
  const lp = useLocalePath();
  const { locale } = useI18n();
  const [stories, setStories] = useState<StoryMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"day" | "night">("day");
  const [statusMap, setStatusMap] = useState<Record<string, ItemStatus>>({});
  const [toast, setToast] = useState("");

  const templates = useMemo(
    () =>
      LIBRARY_GENDERS.flatMap((gender) => getFeaturedStoryTemplates(gender)),
    [],
  );

  useEffect(() => {
    loadStoryList()
      .then(setStories)
      .catch(() => setStories([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem(AISTORY_THEME_STORAGE_KEY);
      if (storedTheme === "night" || storedTheme === "day") setTheme(storedTheme);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const setItemStatus = (id: string, patch: ItemStatus, label: string) => {
    setStatusMap((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
    setToast(label);
  };

  const toggleTheme = () => {
    setTheme((value) => {
      const next = value === "night" ? "day" : "night";
      try {
        localStorage.setItem(AISTORY_THEME_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const handleDelete = async (storyId: string) => {
    if (!confirm("确认删除这个本地剧本记录吗？")) return;
    setDeletingId(storyId);
    const success = await deleteStory(storyId);
    if (success) {
      setStories((prev) => prev.filter((story) => story.id !== storyId));
      setToast("已删除本地剧本记录。");
    } else {
      alert("删除失败，请稍后再试。");
    }
    setDeletingId(null);
  };

  const totalTemplatePlays = templates.reduce((sum, template, index) => sum + templateStats(template, index).plays, 0);
  const totalRevenue = templates.reduce((sum, template, index) => sum + templateStats(template, index).revenue, 0);

  return (
    <div className={`min-h-screen flex flex-col overflow-x-hidden transition-colors duration-300 ${theme === "night" ? "aistory-night" : ""}`}>
      <header className="mx-auto flex w-full max-w-[1640px] flex-wrap items-center justify-between gap-4 px-6 pt-7 md:px-16 md:pt-10">
        <Link
          href={lp("/")}
          className="flex items-center gap-3 font-serif text-2xl text-clay-900 transition-colors hover:text-ember-500 md:text-[34px]"
        >
          <i className="fa-solid fa-arrow-left text-sm" />
          AI<em className="italic font-light text-ember-500">story</em>
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={lp("/studio")}
            className="inline-flex items-center gap-2 border border-clay-900/15 bg-cream-50/70 px-4 py-2 text-sm text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500"
          >
            <i className="fa-solid fa-pen-nib text-xs" />
            新建 / 编辑
          </Link>
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex items-center gap-2 border border-clay-900/15 bg-cream-50/70 px-4 py-2 text-sm text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500"
          >
            <i className={`fa-solid ${theme === "night" ? "fa-sun" : "fa-moon"} text-xs`} />
            {theme === "night" ? "白天模式" : "夜晚模式"}
          </button>
        </div>
      </header>

      {toast && (
        <div className="fixed right-6 top-24 z-50 border border-clay-900/15 bg-cream-50 px-4 py-3 text-sm text-clay-700 shadow-lg shadow-clay-900/10">
          {toast}
        </div>
      )}

      <main className="mx-auto w-full max-w-[1640px] flex-1 px-6 py-10 md:px-16 md:py-14">
        <section className="mb-8">
          <p className="text-[10px] smallcaps text-clay-500">Story Library Control</p>
          <h1 className="mt-3 font-serif text-4xl text-clay-900 md:text-5xl">剧本库管理</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-clay-600">
            首页展示的模板剧本、用户自己生成的剧、以及看过但没有读完的剧情都进入这里管理。后续真实上线时，这里会接播放人数、收益、推荐、上下架和审核后台。
          </p>
        </section>

        <section className="mb-9 grid gap-3 md:grid-cols-4">
          <SummaryCard label="首页模板" value={`${templates.length}`} note="男性向 / 女性向" />
          <SummaryCard label="我的剧本" value={`${stories.length}`} note="本机 IndexedDB" />
          <SummaryCard label="累计播放" value={totalTemplatePlays.toLocaleString("zh-CN")} note="演示统计口径" />
          <SummaryCard label="预估收益" value={`¥ ${formatMoney(totalRevenue)}`} note="后续接收益中心" />
        </section>

        <section className="mb-12 border border-clay-900/12 bg-cream-50/45">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-clay-900/10 px-5 py-4">
            <div>
              <h2 className="font-serif text-2xl text-clay-900">我的剧集 / 继续观看</h2>
              <p className="mt-1 text-sm text-clay-500">用户自己生成的剧，以及看过但没有读完的剧情。</p>
            </div>
            <Link
              href={lp("/studio")}
              className="inline-flex items-center gap-2 bg-clay-900 px-4 py-2 text-sm text-cream-50 transition-colors hover:bg-ember-500"
            >
              创建新剧本
              <i className="fa-solid fa-plus text-xs" />
            </Link>
          </div>
          <div className="p-5">
            {loading ? (
              <div className="py-12 text-center text-[10px] smallcaps text-clay-500">正在读取本地剧本...</div>
            ) : stories.length === 0 ? (
              <div className="border border-dashed border-clay-900/15 px-5 py-10 text-center">
                <i className="fa-solid fa-book-open mb-4 text-3xl text-clay-300" />
                <p className="font-serif text-lg text-clay-500">暂无用户自己的剧本记录</p>
                <p className="mt-2 text-sm text-clay-500">开始玩一部互动剧，或从 studio 创建短剧草稿后，这里会显示继续观看和管理入口。</p>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {stories.map((story, index) => {
                  const id = `local:${story.id}`;
                  const status = statusMap[id] || {};
                  const plays = Math.max(1, story.sceneCount * 7 + index * 11);
                  const players = Math.max(1, Math.round(plays / 2.4));
                  const revenue = plays * 0.03;
                  return (
                    <LibraryCard
                      key={story.id}
                      title={storyTitle(story)}
                      subtitle={story.styleGuide || "自定义互动剧"}
                      image={null}
                      badge="我的剧"
                      stats={[
                        ["玩了多少", `${plays.toLocaleString("zh-CN")} 次`],
                        ["多少人玩", `${players.toLocaleString("zh-CN")} 人`],
                        ["更新时间", formatDate(story.updatedAt, locale)],
                        ["收益", `¥ ${formatMoney(revenue)}`],
                      ]}
                      status={status}
                      actions={
                        <>
                          <Link href={lp(`/play?storyId=${encodeURIComponent(story.id)}`)} className="library-action primary">继续</Link>
                          <Link href={lp("/studio")} className="library-action">编辑</Link>
                          <button type="button" className="library-action" onClick={() => setItemStatus(id, { pinned: !status.pinned }, status.pinned ? "已取消置顶。" : "已置顶为热门。")}>
                            {status.pinned ? "取消置顶" : "置顶热门"}
                          </button>
                          <button type="button" className="library-action" onClick={() => setItemStatus(id, { hidden: !status.hidden }, status.hidden ? "已取消隐藏。" : "已隐藏该剧本。")}>
                            {status.hidden ? "取消隐藏" : "隐藏"}
                          </button>
                          <button type="button" className="library-action" onClick={() => setItemStatus(id, { offline: !status.offline }, status.offline ? "已恢复上架。" : "已下架该剧本。")}>
                            {status.offline ? "恢复上架" : "下架"}
                          </button>
                          <button type="button" className="library-action danger" disabled={deletingId === story.id} onClick={() => void handleDelete(story.id)}>
                            {deletingId === story.id ? "删除中" : "删除本地"}
                          </button>
                        </>
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="border border-clay-900/12 bg-cream-50/45">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-clay-900/10 px-5 py-4">
            <div>
              <h2 className="font-serif text-2xl text-clay-900">首页模板剧本库</h2>
              <p className="mt-1 text-sm text-clay-500">首页所有模板剧本都进入库管理；点击“编辑剧本”会用 studio 模式打开。</p>
            </div>
            <span className="text-sm text-clay-500">{templates.length} 个模板</span>
          </div>
          <div className="grid gap-4 p-5 lg:grid-cols-2 xl:grid-cols-3">
            {templates.map((template, index) => {
              const id = `template:${template.id}`;
              const status = statusMap[id] || {};
              const stats = templateStats(template, index);
              return (
                <LibraryCard
                  key={template.id}
                  title={template.title}
                  subtitle={template.outline}
                  image={template.coverPath}
                  badge={template.assetStatus === "pending" ? `${template.gender} · 画面待生成` : template.gender}
                  stats={[
                    ["玩了多少", `${stats.plays.toLocaleString("zh-CN")} 次`],
                    ["多少人玩", `${stats.players.toLocaleString("zh-CN")} 人`],
                    ["更新时间", formatDate(stats.updatedAt, locale)],
                    ["收益", `¥ ${formatMoney(stats.revenue)}`],
                  ]}
                  status={status}
                  actions={
                    <>
                      <Link href={lp(template.playPath || `/play?card=${template.id}`)} className="library-action primary">试玩</Link>
                      <Link href={lp(`/studio?template=${encodeURIComponent(template.id)}`)} className="library-action">编辑剧本</Link>
                      <button type="button" className="library-action" onClick={() => setItemStatus(id, { pinned: !status.pinned }, status.pinned ? "已取消置顶。" : "已置顶为热门。")}>
                        {status.pinned ? "取消置顶" : "置顶热门"}
                      </button>
                      <button type="button" className="library-action" onClick={() => setItemStatus(id, { hidden: !status.hidden }, status.hidden ? "已取消隐藏。" : "已隐藏该模板。")}>
                        {status.hidden ? "取消隐藏" : "隐藏"}
                      </button>
                      <button type="button" className="library-action" onClick={() => setItemStatus(id, { offline: !status.offline }, status.offline ? "已恢复上架。" : "已下架该模板。")}>
                        {status.offline ? "恢复上架" : "下架"}
                      </button>
                    </>
                  }
                />
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="border border-clay-900/12 bg-cream-100/55 p-4">
      <p className="text-[10px] smallcaps text-clay-500">{label}</p>
      <div className="mt-3 font-serif text-3xl text-clay-900">{value}</div>
      <p className="mt-2 text-xs text-clay-500">{note}</p>
    </div>
  );
}

function LibraryCard({
  title,
  subtitle,
  image,
  badge,
  stats,
  status,
  actions,
}: {
  title: string;
  subtitle: string;
  image: string | null;
  badge: string;
  stats: Array<[string, string]>;
  status: ItemStatus;
  actions: ReactNode;
}) {
  return (
    <article className={`border bg-cream-100/55 p-4 ${status.offline ? "border-ember-500/40 opacity-70" : "border-clay-900/12"}`}>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-4">
        <div className="relative aspect-[3/4] overflow-hidden border border-clay-900/12 bg-clay-900/85">
          {image ? (
            <img src={image} alt={title} loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-cream-50">
              <i className="fa-solid fa-clapperboard text-2xl" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="border border-clay-900/12 px-2 py-1 text-[10px] text-clay-500">{badge}</span>
            {status.pinned && <span className="border border-ember-500/40 px-2 py-1 text-[10px] text-ember-500">热门置顶</span>}
            {status.hidden && <span className="border border-clay-900/12 px-2 py-1 text-[10px] text-clay-500">已隐藏</span>}
            {status.offline && <span className="border border-ember-500/40 px-2 py-1 text-[10px] text-ember-500">已下架</span>}
          </div>
          <h3 className="line-clamp-2 font-serif text-xl leading-snug text-clay-900">{title}</h3>
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-clay-600">{subtitle}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-clay-900/10 pt-4">
        {stats.map(([label, value]) => (
          <div key={label} className="border border-clay-900/10 px-3 py-2">
            <p className="text-[10px] text-clay-500">{label}</p>
            <p className="mt-1 font-sans text-sm font-semibold text-clay-900">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
    </article>
  );
}
