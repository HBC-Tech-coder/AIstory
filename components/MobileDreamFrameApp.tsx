"use client";

/* eslint-disable @next/next/no-img-element -- story art and local previews use dynamic provider/cache URLs */

import Link from "next/link";
import type { KeyboardEvent, TouchEvent, WheelEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildFallbackCards, type FeaturedCard } from "@/lib/featuredStories";
import { useLocalePath } from "@/lib/i18n/hooks";
import { useI18n } from "@/lib/i18n/client";
import { useCreditBalanceDetails } from "@/components/CreditBalance";
import {
  readStoredBranchPrefetchDepth,
  SettingsModal,
} from "@/components/SettingsModal";
import { UsageDisclosureNote } from "@/components/UsageDisclosureNote";
import { UserChip } from "@/components/UserChip";
import { formatCredits } from "@/lib/credits";
import {
  previewFeatureState,
  previewMetricLabel,
  resolveRoleCard,
  rewriteDraftNotice,
  withMobileReturnTo,
  type StoryCharacter,
} from "@/lib/mobilePreviewPolicy";
import { WORLD_MODEL_DEMOS } from "@/lib/world-model-demos/catalog";
import type { BranchPrefetchDepth } from "@infiplot/types";

const MOBILE_ASSET_ROOT = "/aistory/mobile-v1";
const AISTORY_THEME_STORAGE_KEY = "aistory:theme";

type MobileTab =
  | "feed"
  | "worldline"
  | "create"
  | "discover"
  | "history"
  | "messages"
  | "me";

type Sheet = null | "rewrite" | "role" | "worldline";
type WorldMode = "player" | "creator";
type Theme = "day" | "night";

type MobileHistoryStory = {
  id: string;
  title: string;
  subtitle: string;
  outline: string;
  cover: string;
  href: string;
  progress: string;
  heat: string;
  choiceLabels?: readonly [string, string];
  character?: StoryCharacter;
};

const prototypeStories: MobileHistoryStory[] = [
  {
    id: "rain-reunion",
    outline: "雨声贴着玻璃往下滑，沈知遥的手机屏幕亮起。那条十年前不该出现的短信只有一行：不要打开今晚的合影。",
    title: "雨夜同学会",
    subtitle: "示例剧集 · 群像 · 作者推荐",
    cover: `${MOBILE_ASSET_ROOT}/history-rain-reunion.png`,
    href: "/play?card=f6",
    progress: "预览",
    heat: "示例",
  },
  {
    id: "future-letter",
    outline: "你收到一封写着十年后日期的信，信里准确预告了今天将要发生的第一件小事。",
    title: "十年后的来信",
    subtitle: "示例剧集 · 热搜 · AI替身线",
    cover: `${MOBILE_ASSET_ROOT}/history-future-letter.png`,
    href: "/play?card=f8",
    progress: "预览",
    heat: "示例",
  },
  {
    id: "midnight-archive",
    outline: "档案室的旧灯忽明忽暗，所有被删掉的采访记录都指向同一个没有登记过的名字。",
    title: "午夜档案室",
    subtitle: "示例剧集 · 推理 · 双视角",
    cover: `${MOBILE_ASSET_ROOT}/history-midnight-archive.png`,
    href: "/play?card=m18",
    progress: "预览",
    heat: "示例",
  },
  {
    id: "mirror-visitor",
    outline: "镜子里的人比你慢半拍抬头，却先一步说出了你正准备隐瞒的秘密。",
    title: "镜中来客",
    subtitle: "示例剧集 · 惊悚 · 多结局",
    cover: `${MOBILE_ASSET_ROOT}/history-mirror-visitor.png`,
    href: "/play?card=f12",
    progress: "预览",
    heat: "示例",
  },
  {
    id: "missing-graduation",
    outline: "毕业照里多出一个你不认识的人，而所有同学都坚称她曾经和你同桌三年。",
    title: "消失的毕业照",
    subtitle: "示例剧集 · 悬疑 · 多世界线演示",
    cover: `${MOBILE_ASSET_ROOT}/history-missing-graduation.png`,
    href: "/play?custom=1",
    progress: "预览",
    heat: "示例",
  },
];

const createActions = [
  { icon: "fa-image", title: "上传图片", text: "从人物、地点、情绪和线索进入故事。" },
  { icon: "fa-film", title: "上传视频", text: "把短片结尾扩成互动影游。" },
  { icon: "fa-pen-nib", title: "写一句故事", text: "生成标题、角色和首个节点。" },
  { icon: "fa-id-card", title: "使用角色", text: "用收藏角色快速开新故事。" },
  { icon: "fa-book-open", title: "导入小说", text: "自动拆章、提取角色和关键选择点。" },
];

const friendItems = [
  { name: "Coco", text: "把停车场分支改成公开世界线了。" },
  { name: "Mia", text: "角色卡收益已经进账。" },
  { name: "沈知遥", text: "当前角色卡被引用 18 次。" },
];

function cardToHistory(card: FeaturedCard): MobileHistoryStory {
  return {
    id: card.id,
    title: card.title,
    outline: card.outline,
    subtitle: card.assetStatus === "pending"
      ? `画面待生成 · ${card.outline.slice(0, 18)}...`
      : `预览剧集 · ${card.outline.slice(0, 18)}...`,
    cover: card.coverPath,
    href: card.playPath || `/play?card=${encodeURIComponent(card.id)}`,
    progress: "预览",
    heat: card.assetStatus === "pending" ? "画面待生成" : "预览",
  };
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="mobile-df-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function MobileDreamFrameApp() {
  const { locale, t } = useI18n();
  const { balance: creditBalance, source: creditSource } = useCreditBalanceDetails();
  const lp = useLocalePath();
  const [tab, setTab] = useState<MobileTab>("feed");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [worldMode, setWorldMode] = useState<WorldMode>("player");
  const [theme, setTheme] = useState<Theme>("night");
  const [tip, setTip] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [branchPrefetchDepth, setBranchPrefetchDepth] =
    useState<BranchPrefetchDepth>(1);
  const [storySeed, setStorySeed] = useState("毕业照 / 沈知遥 / 十年后短信");
  const [rewriteSeed, setRewriteSeed] = useState("我想让沈知遥在宴会开始前离开，并收到另一个自己的短信。");
  const [activeStoryIndex, setActiveStoryIndex] = useState(0);
  const touchStartYRef = useRef<number | null>(null);
  const wheelLockedRef = useRef(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(AISTORY_THEME_STORAGE_KEY);
      if (stored === "day" || stored === "night") setTheme(stored);
    } catch {
      /* ignore */
    }
    setBranchPrefetchDepth(readStoredBranchPrefetchDepth());
  }, []);

  useEffect(() => {
    if (!tip) return;
    const timer = window.setTimeout(() => setTip(""), 2200);
    return () => window.clearTimeout(timer);
  }, [tip]);

  const templateStories = useMemo(() => {
    const male = buildFallbackCards("男性向");
    const female = buildFallbackCards("女性向");
    return [...female, ...male].map(cardToHistory);
  }, []);

  const stories = useMemo<MobileHistoryStory[]>(
    () => [
      ...WORLD_MODEL_DEMOS.map((demo) => ({
        id: demo.id,
        title: demo.title,
        subtitle: "世界模型 · 第一视角互动演示",
        outline: demo.summary,
        cover: demo.posterUrl,
        href: demo.playPath,
        progress: "视频演示",
        heat: "新体验",
        choiceLabels: [demo.choices[0].label, demo.choices[1].label] as const,
      })),
      ...templateStories,
      ...prototypeStories,
    ],
    [templateStories],
  );
  const storyCount = stories.length;

  const activeStory = stories[activeStoryIndex % storyCount] ?? prototypeStories[0]!;
  const activeChoiceLabels = activeStory.choiceLabels ?? ["打开短信", "删除短信"];
  const feedImage =
    activeStory.id === "missing-graduation"
      ? `${MOBILE_ASSET_ROOT}/story-banquet.png`
      : activeStory.cover;

  const roleCard = resolveRoleCard(activeStory.character);
  const followState = previewFeatureState("follow");
  const nearbyState = previewFeatureState("nearby");
  const likeState = previewFeatureState("like");
  const commentState = previewFeatureState("comment");
  const playHref = withMobileReturnTo(lp(activeStory.href));

  function go(nextTab: MobileTab) {
    setTab(nextTab);
    setSheet(null);
  }

  function toggleTheme() {
    const next = theme === "night" ? "day" : "night";
    setTheme(next);
    try {
      localStorage.setItem(AISTORY_THEME_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  function showStory(delta: 1 | -1) {
    if (!storyCount) return;
    setSheet(null);
    setActiveStoryIndex((index) => (index + delta + storyCount) % storyCount);
  }

  function handleFeedTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    touchStartYRef.current = touch ? touch.clientY : null;
  }

  function handleFeedTouchEnd(event: TouchEvent<HTMLElement>) {
    const startY = touchStartYRef.current;
    touchStartYRef.current = null;
    const touch = event.changedTouches[0];
    if (startY === null || !touch) return;
    const deltaY = startY - touch.clientY;
    if (Math.abs(deltaY) < 46) return;
    showStory(deltaY > 0 ? 1 : -1);
  }

  function handleFeedWheel(event: WheelEvent<HTMLElement>) {
    if (Math.abs(event.deltaY) < 38 || wheelLockedRef.current) return;
    wheelLockedRef.current = true;
    showStory(event.deltaY > 0 ? 1 : -1);
    window.setTimeout(() => {
      wheelLockedRef.current = false;
    }, 560);
  }

  function handleFeedKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      showStory(1);
    }
    if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      showStory(-1);
    }
  }

  const nav = [
    { key: "feed" as const, icon: "fa-play", label: "剧场" },
    { key: "worldline" as const, icon: "fa-timeline", label: "世界线" },
    { key: "create" as const, icon: "fa-plus", label: "创作" },
    { key: "discover" as const, icon: "fa-magnifying-glass", label: "发现" },
    { key: "me" as const, icon: "fa-user", label: "我的" },
  ];

  return (
    <main className={`mobile-df-page ${theme === "day" ? "mobile-df-day" : ""}`}>
      <div className="mobile-df-phone">
        <div className="mobile-df-status" aria-hidden>
          <span>9:41</span>
          <span className="mobile-df-signal">
            <i className="fa-solid fa-signal" />
            <i className="fa-solid fa-wifi" />
            <i className="fa-solid fa-battery-three-quarters" />
          </span>
        </div>

        {tab === "feed" && (
          <section
            className="mobile-df-feed-screen"
            tabIndex={0}
            aria-label="互动剧推荐流"
            onTouchStart={handleFeedTouchStart}
            onTouchEnd={handleFeedTouchEnd}
            onWheel={handleFeedWheel}
            onKeyDown={handleFeedKeyDown}
          >
            <img className="mobile-df-feed-media" src={feedImage} alt={activeStory.title} />
            <div className="mobile-df-feed-gradient" />
            <header className="mobile-df-feed-top">
              <div>
                <span className="mobile-df-brand">AIstory</span>
                <p>{activeStory.progress} · {activeStoryIndex + 1}/{storyCount}</p>
              </div>
              <button type="button" onClick={() => go("messages")} aria-label="消息">
                <i className="fa-regular fa-bell" />
              </button>
            </header>

            <div className="mobile-df-watch-tabs">
              <button className="active" type="button" title="当前预览版仅提供推荐流">推荐</button>
              <button type="button" title={followState.notice} onClick={() => setTip(followState.notice)}>关注</button>
              <button type="button" title={nearbyState.notice} onClick={() => setTip(nearbyState.notice)}>附近</button>
            </div>

            <button
              type="button"
              className="mobile-df-feed-index"
              onClick={() => showStory(1)}
              aria-label="切换下一部互动剧"
            >
              <span>{activeStoryIndex + 1}</span>
              <small>/{storyCount}</small>
              <i className="fa-solid fa-chevron-up" />
            </button>

            <aside className="mobile-df-action-rail" aria-label="快捷操作">
              <button type="button" onClick={() => setSheet("worldline")}>
                <i className="fa-solid fa-code-branch" />
                <span>世界线</span>
              </button>
              <button type="button" title={likeState.notice} onClick={() => setTip(likeState.notice)}>
                <i className="fa-regular fa-heart" />
                <span>{previewMetricLabel("like")}</span>
              </button>
              <button type="button" title={commentState.notice} onClick={() => setTip(commentState.notice)}>
                <i className="fa-regular fa-comment" />
                <span>{previewMetricLabel("comment")}</span>
              </button>
              <button type="button" onClick={() => setSheet("role")}>
                <i className="fa-solid fa-id-card" />
                <span>角色卡</span>
              </button>
            </aside>

            <div className="mobile-df-feed-copy">
              <div className="mobile-df-chapter-row">
                <span>{activeStory.progress} · 封面预览 · 进入完整播放器播放</span>
              </div>
              <h1>{activeStory.title}</h1>
              <p>{activeStory.outline}</p>
              <div className="mobile-df-choice-stack">
                <button type="button" onClick={() => { window.location.href = playHref; }}>
                  {activeChoiceLabels[0]}
                  <small>进入完整播放器选择</small>
                </button>
                <button type="button" onClick={() => { window.location.href = playHref; }}>
                  {activeChoiceLabels[1]}
                  <small>进入完整播放器选择</small>
                </button>
              </div>
              <div className="mobile-df-rewrite-bar">
                <button type="button" onClick={() => setSheet("rewrite")}>
                  <i className="fa-solid fa-wand-magic-sparkles" />
                  一句话改写剧情
                </button>
                <Link href={playHref}>
                  播放 <i className="fa-solid fa-arrow-right" />
                </Link>
              </div>
            </div>
          </section>
        )}

        {tab === "worldline" && (
          <section className="mobile-df-scroll-screen">
            <PageHead
              title="我的世界线"
              pill={worldMode === "player" ? "玩家视角 · 防剧透" : "创作者视角 · 全量管理"}
              onBack={() => go("feed")}
            />
            <div className="mobile-df-segment">
              <button
                type="button"
                className={worldMode === "player" ? "active" : ""}
                onClick={() => setWorldMode("player")}
              >
                玩家视角
              </button>
              <button
                type="button"
                className={worldMode === "creator" ? "active" : ""}
                onClick={() => setWorldMode("creator")}
              >
                创作者视角
              </button>
            </div>

            {worldMode === "player" ? (
              <div className="mobile-df-list">
                <WorldItem
                  state="公开分支 · 预览"
                  title="Coco 的分支：她在宴会开始前离开"
                  text="从“收到短信”节点变化，分支详情为示例展示，尚未接入实时数据。"
                  meta={["示例数据", "可试玩", "收益未接入"]}
                />
                <WorldItem
                  state="作者推荐 · 预览"
                  title="Mia 的分支：周远其实是 AI 生成的人物"
                  text="解锁第2章后可见完整节点，当前只显示无剧透摘要。"
                  meta={["数据未接入", "第2章", "角色卡联动"]}
                />
                <WorldItem
                  state="第4章 · 未解锁"
                  title="隐藏分支：毕业照里真正消失的人"
                  text="未解锁章节已屏蔽，完成第3章后显示分支摘要。"
                  meta={["防剧透", "待解锁"]}
                  locked
                />
              </div>
            ) : (
              <div className="mobile-df-list">
                <WorldItem
                  state="创作者可见 · 全量节点"
                  title="第2章分支池"
                  text="当前公开 36 条分支，推荐位 3 条，作者钦定 1 条。"
                  meta={["主线回流 +8,420", "分支收益 +390", "待审核 6"]}
                />
                <WorldItem
                  state="可升级视频"
                  title="Coco 的停车场分支"
                  text="高赞分支可排队生成视频资产，横屏/竖屏分开缓存。"
                  meta={["完播数据未接入", "点赞待上线", "预览"]}
                />
                <WorldItem
                  state="隐藏节点 · 后台可编辑"
                  title="第4章隐藏分支"
                  text="创作者可查看完整标题、解锁条件和收益预测。"
                  meta={["未公开", "审核中"]}
                  locked
                />
              </div>
            )}
            <Link className="mobile-df-wide-link" href={lp("/worldline")}>
              打开 PC 世界线工作台 <i className="fa-solid fa-arrow-right" />
            </Link>
          </section>
        )}

        {tab === "create" && (
          <section className="mobile-df-scroll-screen mobile-df-create-screen">
            <PageHead title="＋创作" pill="先轻后重" onBack={() => go("feed")} />
            <div className="mobile-df-create-grid">
              {createActions.map((action) => (
                <button
                  key={action.title}
                  type="button"
                  className={action.title === "导入小说" ? "wide" : ""}
                  onClick={() => {
                    if (action.title === "导入小说") setTip("小说导入为预览入口：尚未接入自动拆章与节点提取。");
                    else setTip(`${action.title}：预览入口，尚未接入生成流程。`);
                  }}
                >
                  <i className={`fa-solid ${action.icon}`} />
                  <span>
                    <strong>{action.title}</strong>
                    <small>{action.text}</small>
                  </span>
                </button>
              ))}
            </div>
            <UsageDisclosureNote
              action="start_custom"
              audioEnabled
              prefetchDepth={branchPrefetchDepth}
              refreshKey={usageRefreshKey}
              className="mx-4 mt-3"
            />

            <div className="mobile-df-panel">
              <div className="mobile-df-panel-head">
                <h3>导入小说生成互动影游</h3>
                <span>示例结构</span>
              </div>
              <textarea
                value={storySeed}
                onChange={(event) => setStorySeed(event.target.value)}
                rows={5}
                aria-label="小说或故事文本"
              />
              <div className="mobile-df-mini-stats">
                <span><strong>示例</strong>角色卡</span>
                <span><strong>示例</strong>关键节点</span>
                <span><strong>示例</strong>横竖屏资产</span>
              </div>
              <div className="mobile-df-row-actions mobile-df-single-action">
                <button type="button" onClick={() => setTip("支持粘贴文本或上传小说文档")}>
                  上传文档
                </button>
              </div>
            </div>
          </section>
        )}

        {tab === "discover" && (
          <section className="mobile-df-scroll-screen">
            <PageHead title="发现" pill="热榜 / 搜索" onBack={() => go("feed")} />
            <button className="mobile-df-search" type="button" onClick={() => setTip("搜索支持剧名、角色、剧情关键词")}>
              <span>沈知遥 十年后短信</span>
              <i className="fa-solid fa-magnifying-glass" />
            </button>

            <div className="mobile-df-panel">
              <h3>搜索历史</h3>
              <div className="mobile-df-history-terms">
                {["Coco分支", "作者推荐世界线", "沈知遥角色卡", "雨夜同学会"].map((term) => (
                  <button key={term} type="button" onClick={() => setTip(`已搜索：${term}`)}>
                    {term}
                  </button>
                ))}
              </div>
            </div>

            <div className="mobile-df-list">
              {stories.slice(0, 5).map((story, index) => (
                <button
                  key={story.id}
                  type="button"
                  className="mobile-df-rank-item"
                  onClick={() => {
                    setActiveStoryIndex(index);
                    go("feed");
                  }}
                >
                  <span className="rank">{index + 1}</span>
                  <span>
                    <strong>{story.title}</strong>
                    <small>{story.subtitle}</small>
                  </span>
                  <b>{story.heat}</b>
                </button>
              ))}
            </div>
          </section>
        )}

        {tab === "history" && (
          <section className="mobile-df-scroll-screen">
            <PageHead title="历史观看" pill="全部记录" onBack={() => go("feed")} />
            <div className="mobile-df-history-list">
              {stories.slice(0, 8).map((story, index) => (
                <article key={story.id} className="mobile-df-history-row">
                  <img src={story.cover} alt={story.title} />
                  <div>
                    <h3>{story.title}</h3>
                    <p>{story.subtitle}</p>
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveStoryIndex(index);
                          go("feed");
                        }}
                      >
                        预览
                      </button>
                      <Link href={withMobileReturnTo(lp(story.href))}>继续观看</Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {tab === "messages" && (
          <section className="mobile-df-scroll-screen">
            <PageHead title="消息" pill="分支引用" onBack={() => go("feed")} />
            <div className="mobile-df-list">
              <WorldItem
                state="二创"
                title="Coco 继续了你的分支"
                text="她从“另一个自己”节点创建了公开世界线，你获得 +24 积分。"
                meta={["刚刚", "可查看"]}
              />
              <WorldItem
                state="角色卡"
                title="沈知遥被 18 个故事引用"
                text="今日角色回流 +12，声音与视觉授权仍沿用原角色卡。"
                meta={["收益 +12", "已结算"]}
              />
              <WorldItem
                state="系统"
                title="高赞分支进入视频升级候选"
                text="横屏和竖屏资产将分别排队，先保留图文互动体验。"
                meta={["待确认", "成本预估"]}
              />
            </div>
          </section>
        )}

        {tab === "me" && (
          <section className="mobile-df-scroll-screen">
            <PageHead title="我的" pill="创作者数据" onBack={() => go("feed")} />
            <div className="mobile-df-profile">
              <div className="mobile-df-avatar">Y</div>
              <div>
                <h2>雨桐创作号</h2>
                <p>玩家 / 创作者双身份 · 白名单内测</p>
              </div>
              <button type="button" onClick={toggleTheme} aria-label="切换白天夜晚模式">
                <i className={`fa-solid ${theme === "night" ? "fa-sun" : "fa-moon"}`} />
              </button>
              <UserChip />
            </div>

            <div className="mobile-df-stat-grid">
              <StatPill
                label={t("home.ui.credits")}
                value={creditSource === "unavailable" ? "未开通" : formatCredits(creditBalance, locale)}
              />
              <StatPill label="今日收益" value="+36" />
              <StatPill label="分支游玩" value="+24" />
              <StatPill label="角色使用" value="+12" />
            </div>

            <div className="mobile-df-panel">
              <h3>消耗记录</h3>
              <div className="mobile-df-ledger">
                <span>新分支生成</span><b className="minus">-15</b>
                <span>角色图缓存命中</span><b>0</b>
                <span>高赞分支升级候选</span><b className="plus">+1</b>
              </div>
            </div>

            <div className="mobile-df-panel">
              <h3>好友与角色动态</h3>
              {friendItems.map((item) => (
                <button key={item.name} type="button" className="mobile-df-friend" onClick={() => setTip(`打开 ${item.name} 动态`)}>
                  <i>{item.name[0]}</i>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.text}</small>
                  </span>
                </button>
              ))}
            </div>

            <div className="mobile-df-panel">
              <h3>我的 API（BYOK）</h3>
              <p>
                配置自己的文字、绘图、识图、配音与视频服务。费用由对应服务商账户承担。
              </p>
              <button
                type="button"
                className="mobile-df-wide-link"
                onClick={() => setSettingsOpen(true)}
              >
                <i className="fa-solid fa-key" aria-hidden="true" />
                打开我的 API 设置
              </button>
            </div>
            <div className="mobile-df-row-actions">
              <Link href={lp("/creator")}>创作者中心</Link>
              <Link href={lp("/revenue")}>收益中心</Link>
            </div>
          </section>
        )}

        <nav className="mobile-df-bottom-nav" aria-label="手机端主导航">
          {nav.map((item) => (
            <button
              key={item.key}
              type="button"
              className={tab === item.key ? "active" : ""}
              onClick={() => go(item.key)}
            >
              <i className={`fa-solid ${item.icon}`} />
              <span>{item.label}</span>
            </button>
          ))}
          <button
            type="button"
            className={tab === "history" ? "active" : ""}
            onClick={() => go("history")}
          >
            <i className="fa-solid fa-clock-rotate-left" />
            <span>历史</span>
          </button>
        </nav>

        {sheet && (
          <div className="mobile-df-sheet-backdrop" onClick={() => setSheet(null)}>
            <section className="mobile-df-sheet" onClick={(event) => event.stopPropagation()}>
              <div className="mobile-df-sheet-handle" />
              {sheet === "rewrite" && (
                <>
                  <h2>一句话改写（草稿，未生成）</h2>
                  <textarea
                    value={rewriteSeed}
                    onChange={(event) => setRewriteSeed(event.target.value)}
                    rows={4}
                    aria-label="一句话改写剧情草稿"
                  />
                  <div className="mobile-df-preview-box">
                    <strong>当前页面草稿（未生成分支或关键画面）：</strong>
                    <p>
                      改写内容只留在当前页面，收起后不会写入本地存储；刷新或离开后不会保留。
                      预览版不会调用付费模型，也不会生成新的世界线。
                    </p>
                  </div>
                  <div className="mobile-df-row-actions">
                    <button type="button" onClick={() => setSheet(null)}>继续原剧情</button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        const draft = rewriteDraftNotice(rewriteSeed);
                        setSheet(null);
                        setTip(draft.message);
                      }}
                    >
                      收起草稿
                    </button>
                  </div>
                </>
              )}
              {sheet === "role" && (
                <>
                  <h2>{roleCard.available ? `${roleCard.name} · 当前角色卡` : "当前剧集角色卡"}</h2>
                  {roleCard.available ? (
                    <div className="mobile-df-role-card">
                      <div>
                        <p>{roleCard.description}</p>
                        <div className="mobile-df-mini-stats">
                          {roleCard.traits.map((trait) => (
                            <span key={trait}>{trait}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mobile-df-preview-box">
                        <strong>{roleCard.title}</strong>
                        <p>{roleCard.description}</p>
                      </div>
                      <div className="mobile-df-row-actions">
                        <button type="button" disabled>收藏</button>
                        <button type="button" className="primary" disabled>加入故事</button>
                      </div>
                    </>
                  )}
                </>
              )}
              {sheet === "worldline" && (
                <>
                  <h2>我的世界线</h2>
                  <WorldItem
                    state="玩家公开分支 · 预览"
                    title="Coco 的分支：宴会开始前离开"
                    text="从“收到短信”节点变化，分支详情以预热示例展示，尚未接入实时数据。"
                    meta={["示例分支", "数据未接入"]}
                  />
                  <WorldItem
                    state="防剧透分支 · 未解锁"
                    title="隐藏分支：毕业照里真正消失的人"
                    text="完成对应章节后才会显示分支摘要，预览版不展示隐藏内容。"
                    meta={["防剧透", "未解锁"]}
                    locked
                  />
                  <Link className="mobile-df-wide-link" href={playHref}>
                    继续播放 {activeStory.title}
                  </Link>
                  <Link className="mobile-df-wide-link" href={lp("/worldline")}>
                    打开完整世界线
                  </Link>
                </>
              )}
            </section>
          </div>
        )}

        {tip && <div className="mobile-df-toast">{tip}</div>}
      </div>
      {settingsOpen ? (
        <SettingsModal
          initialTab="models"
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setBranchPrefetchDepth(readStoredBranchPrefetchDepth());
            setUsageRefreshKey((value) => value + 1);
            setTip("我的 API 设置已保存在当前浏览器");
          }}
        />
      ) : null}
    </main>
  );
}

function PageHead({
  title,
  pill,
  onBack,
}: {
  title: string;
  pill: string;
  onBack: () => void;
}) {
  return (
    <header className="mobile-df-page-head">
      <button type="button" onClick={onBack} aria-label="返回剧场">
        <i className="fa-solid fa-chevron-left" />
      </button>
      <div>
        <h2>{title}</h2>
        <span>{pill}</span>
      </div>
    </header>
  );
}

function WorldItem({
  state,
  title,
  text,
  meta,
  locked = false,
}: {
  state: string;
  title: string;
  text: string;
  meta: string[];
  locked?: boolean;
}) {
  return (
    <article className={`mobile-df-world-item ${locked ? "locked" : ""}`}>
      <span>{state}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      <div>
        {meta.map((item) => (
          <small key={item}>{item}</small>
        ))}
      </div>
      {locked && <b>未解锁章节已屏蔽</b>}
    </article>
  );
}
