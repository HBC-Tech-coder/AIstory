"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocalePath } from "@/lib/i18n/hooks";
import { loadStoryList, loadStorySession } from "@/lib/clientStoryPersistence";
import type { Session, TimelineBranch } from "@infiplot/types";
import { CreditBalance } from "@/components/CreditBalance";

const AISTORY_THEME_STORAGE_KEY = "aistory:theme";

type DashboardMode = "worldline" | "creator" | "revenue";

const NAV_ITEMS: Array<{ key: DashboardMode | "home" | "play" | "studio"; label: string; href: string }> = [
  { key: "home", label: "创作首页", href: "/" },
  { key: "play", label: "剧情播放", href: "/play?card=m18" },
  { key: "studio", label: "专业编辑", href: "/studio" },
  { key: "worldline", label: "世界线", href: "/worldline" },
  { key: "creator", label: "创作者中心", href: "/creator" },
  { key: "revenue", label: "收益中心", href: "/revenue" },
];

export function DreamFrameDashboardPage({ mode }: { mode: DashboardMode }) {
  const lp = useLocalePath();
  const [theme, setTheme] = useState<"day" | "night">("day");

  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem(AISTORY_THEME_STORAGE_KEY);
      if (storedTheme === "night" || storedTheme === "day") setTheme(storedTheme);
    } catch {
      /* ignore */
    }
  }, []);

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

  return (
    <main className={`min-h-screen overflow-x-hidden transition-colors duration-300 ${theme === "night" ? "aistory-night" : ""}`}>
      <header className="border-b border-clay-900/10 bg-cream-50/55 px-5 py-4 backdrop-blur-sm md:px-8">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-4">
          <Link href={lp("/")} className="font-serif text-2xl text-clay-900 md:text-[34px]">
            AIstory <em className="italic font-light text-ember-500">DreamFrame</em>
            <span className="ml-3 align-middle font-sans text-xs text-clay-500">PC 创作控制台</span>
          </Link>
          <nav className="flex flex-wrap items-center border border-clay-900/12 bg-cream-50/65">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={lp(item.href)}
                className={`px-4 py-3 text-sm transition-colors hover:bg-cream-100 hover:text-ember-500 ${
                  item.key === mode ? "bg-cream-100 text-ember-500" : "text-clay-600"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <CreditBalance />
            <span className="hidden text-sm text-clay-500 xl:inline">设备分流：PC 工作台　 本地模型：百炼 / DeepSeek</span>
            <button
              type="button"
              onClick={toggleTheme}
              className="border border-clay-900/15 px-4 py-2 text-sm font-semibold text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500"
            >
              <i className={`fa-solid ${theme === "night" ? "fa-sun" : "fa-moon"} mr-2 text-xs`} />
              {theme === "night" ? "白天" : "夜晚"}
            </button>
            <span className="flex h-10 w-10 items-center justify-center bg-ember-500/80 font-semibold text-cream-50">Y</span>
          </div>
        </div>
      </header>

      {mode === "worldline" && <PlayerWorldlineView />}
      {mode === "creator" && <CreatorView />}
      {mode === "revenue" && <RevenueView />}
    </main>
  );
}

function PlayerWorldlineView() {
  const lp = useLocalePath();
  const [stories, setStories] = useState<Session[]>([]);
  const [selectedStoryId, setSelectedStoryId] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void loadStoryList().then(async (items) => {
      const loaded = (
        await Promise.all(items.map((item) => loadStorySession(item.id)))
      ).filter((item): item is Session => !!item);
      if (cancelled) return;
      setStories(loaded);
      setSelectedStoryId((current) => current || loaded[0]?.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = stories.find((story) => story.id === selectedStoryId);
  const branches = selected?.timeline?.branches ?? [];
  const activeBranchId = selected?.timeline?.activeBranchId;

  const branchLabel = (branch: TimelineBranch): string => {
    if (!branch.parentBranchId) return "主时间线";
    const decision = selected?.timeline?.decisions.find(
      (item) => item.id === branch.forkDecisionId,
    );
    const choice = decision?.choices.find(
      (item) => item.id === branch.selectedChoiceId,
    );
    return choice ? `从「${choice.label}」分叉` : "个人分支";
  };

  return (
    <section className="grid gap-5 p-5 md:p-8 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="border border-clay-900/12 bg-cream-50/70">
        <div className="border-b border-clay-900/10 px-5 py-4">
          <h1 className="text-xl font-semibold text-clay-900">我的时间线</h1>
          <p className="mt-1 text-xs text-clay-500">旧路线永久保留，可随时切回</p>
        </div>
        <div className="space-y-2 p-3">
          {stories.length === 0 && (
            <p className="p-5 text-sm text-clay-500">尚无带时间线的本地剧情。</p>
          )}
          {stories.map((story) => (
            <button
              key={story.id}
              type="button"
              onClick={() => setSelectedStoryId(story.id)}
              className={`w-full border p-4 text-left ${
                selectedStoryId === story.id
                  ? "border-ember-500 bg-ember-500/5"
                  : "border-clay-900/10"
              }`}
            >
              <strong className="line-clamp-2 text-sm text-clay-900">
                {story.storyState?.logline || story.worldSetting}
              </strong>
              <span className="mt-2 block text-xs text-clay-500">
                {story.timeline?.branches.length ?? 1} 条路线 · {story.history.length} 幕
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="border border-clay-900/12 bg-cream-50/75">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-clay-900/10 px-5 py-4">
          <div>
            <h2 className="text-xl font-semibold text-clay-900">世界线分支</h2>
            <p className="text-xs text-clay-500">起点、最后进度与当前活跃路线</p>
          </div>
          {selected && (
            <Link
              href={lp(`/play?storyId=${encodeURIComponent(selected.id)}`)}
              className="bg-clay-900 px-4 py-2 text-sm text-cream-50"
            >
              继续当前路线
            </Link>
          )}
        </div>
        <div className="grid gap-4 p-5 md:grid-cols-2 2xl:grid-cols-3">
          {(branches.length > 0
            ? branches
            : selected
              ? [{
                  id: "legacy",
                  createdAt: selected.createdAt,
                  lastPlayedAt: selected.createdAt,
                  snapshot: {
                    history: selected.history,
                    characters: selected.characters,
                    storyState: selected.storyState,
                    worldSetting: selected.worldSetting,
                    styleGuide: selected.styleGuide,
                    currentSceneId: selected.history.at(-1)?.scene.id || "",
                    currentBeatId: selected.history.at(-1)?.scene.entryBeatId || "",
                    visitedBeatIds: selected.history.at(-1)?.visitedBeatIds || [],
                  },
                } satisfies TimelineBranch]
              : []
          ).map((branch) => {
            const last = branch.snapshot.history.at(-1);
            const active =
              branch.id === activeBranchId ||
              (branch.id === "legacy" && !activeBranchId);
            return (
              <article
                key={branch.id}
                className={`overflow-hidden border ${
                  active ? "border-ember-500" : "border-clay-900/12"
                }`}
              >
                {last?.scene.imageUrl && (
                  <img
                    src={last.scene.imageUrl}
                    alt=""
                    className="aspect-video w-full object-cover"
                  />
                )}
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <strong className="text-sm text-clay-900">
                      {branchLabel(branch)}
                    </strong>
                    {active && (
                      <span className="rounded-full bg-ember-500/10 px-2 py-1 text-[10px] text-ember-500">
                        当前活跃
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-clay-500">
                    最后进度：第 {branch.snapshot.history.length} 幕
                  </p>
                  <p className="mt-1 text-xs text-clay-400">
                    {new Date(branch.lastPlayedAt).toLocaleString()}
                  </p>
                  {selected && branch.id !== "legacy" && (
                    <Link
                      href={lp(
                        `/play?storyId=${encodeURIComponent(selected.id)}&branchId=${encodeURIComponent(branch.id)}`,
                      )}
                      className="mt-4 inline-flex border border-clay-900/15 px-3 py-2 text-xs text-clay-700 hover:border-ember-500"
                    >
                      切换到此时间线
                    </Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function WorldlineView() {
  const nodes = [
    { title: "雨夜信件", tag: "Node 01 · 主线", x: "12%", y: "24%", h: "50%" },
    { title: "旧车站追踪", tag: "Node 02 · 热门分支", x: "43%", y: "36%", h: "18%" },
    { title: "十年前的报纸", tag: "Node 03 · 作者推荐", x: "74%", y: "18%", h: "42%" },
    { title: "隐藏怀表", tag: "My Branch", x: "38%", y: "70%", h: "18%" },
    { title: "全场停电", tag: "Gift Event", x: "78%", y: "60%", h: "18%" },
  ];
  return (
    <section className="grid gap-5 p-5 md:p-8 xl:grid-cols-[410px_minmax(680px,1fr)_360px]">
      <aside className="border border-clay-900/12 bg-cream-50/65">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-6 py-5">
          <h1 className="text-xl font-semibold text-clay-900">分支列表</h1>
          <span className="text-sm text-clay-500">防剧透</span>
        </div>
        <div className="space-y-8 p-6">
          <BranchItem label="主线 A" title="打开怀表，时间倒回十年前" text="作者推荐路线，支持继续生成。" />
          <BranchItem label="热门分支" title="追踪送信人到旧车站" text="2.1 万次游玩，礼物触发率 18%。" />
          <BranchItem label="我的分支" title="隐藏怀表，反向审问沈砚" text="未发布，可继续编辑或导出。" />
          <BranchItem label="礼物事件" title="全场停电：所有角色被迫坦白" text="准实时事件，作用于当前世界线。" />
        </div>
      </aside>

      <section className="relative min-h-[680px] overflow-hidden border border-clay-900/12 bg-cream-50/80">
        <div className="absolute inset-0 opacity-70" style={{
          backgroundImage:
            "linear-gradient(rgba(45,24,16,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(45,24,16,0.06) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }} />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M23 37 C38 44, 46 46, 51 45 S69 33, 75 31" fill="none" stroke="rgba(178,147,73,.35)" strokeWidth="0.45" />
          <path d="M52 48 C58 55, 66 60, 75 65" fill="none" stroke="rgba(78,142,126,.3)" strokeWidth="0.45" />
          <path d="M42 48 C39 57, 37 65, 40 76" fill="none" stroke="rgba(178,147,73,.25)" strokeWidth="0.35" />
        </svg>
        {nodes.map((node) => (
          <div
            key={node.title}
            className="absolute border border-clay-900/12 bg-cream-50/92 p-6 shadow-sm"
            style={{ left: node.x, top: node.y, width: "230px", height: node.h }}
          >
            <p className="text-sm text-clay-500">{node.tag}</p>
            <h2 className="mt-2 text-xl font-semibold text-clay-900">{node.title}</h2>
          </div>
        ))}
      </section>

      <aside className="border border-clay-900/12 bg-cream-50/65">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-6 py-5">
          <h2 className="text-xl font-semibold text-clay-900">节点表现</h2>
          <span className="text-sm text-clay-500">近 7 天</span>
        </div>
        <div className="grid grid-cols-2 gap-1 p-6">
          <Metric value="68%" label="完播率" />
          <Metric value="41%" label="互动率" />
          <Metric value="18%" label="礼物触发" />
          <Metric value="2.4k" label="二创次数" />
        </div>
        <p className="px-6 pb-6 text-sm leading-7 text-clay-600">
          世界线页承担“理解结构”和“管理分支”的职责。玩家只看可游玩关系，创作者可切到收益、开放权限和节点升级视图。
        </p>
      </aside>
    </section>
  );
}

function CreatorView() {
  const tasks = [
    ["P0 可发布", "图文互动版本", "文本、关键帧、TTS、分支选择已满足最低可玩标准，可先发布收集真实数据。", 86],
    ["P1 建议升级", "HappyHorse 视频任务", "把高完播节点升级为 16:9 PC 版片段与 9:16 移动版片段，异步排队生成。", 62],
    ["P2 待审核", "角色一致性修复", "对视频片段做局部替换、风格统一和角色面容修正，保留素材血缘。", 39],
    ["P3 实验", "HappyOyster 可探索章节", "从一个命运节点启动世界模型会话，玩家移动、指令和事件回写为 WorldlineBranch。", 22],
  ] as const;
  return (
    <section className="grid gap-5 p-5 md:p-8 xl:grid-cols-[minmax(720px,1fr)_390px]">
      <section className="border border-clay-900/12 bg-cream-50/70">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-6 py-5">
          <h1 className="text-xl font-semibold text-clay-900">创作者中心 · 章节升级队列</h1>
          <span className="text-sm text-clay-500">图文 → 视频 → 可探索世界</span>
        </div>
        <div className="grid gap-4 p-6 lg:grid-cols-2">
          {tasks.map(([stage, title, text, progress]) => (
            <article key={title} className="min-h-[250px] border border-clay-900/12 bg-cream-50/70 p-6">
              <p className="font-semibold text-teal-700">{stage}</p>
              <h2 className="mt-4 text-2xl font-semibold text-clay-900">{title}</h2>
              <p className="mt-4 text-sm leading-7 text-clay-600">{text}</p>
              <div className="mt-6 h-2 bg-clay-900/5">
                <div className="h-full bg-gradient-to-r from-amber-700 to-teal-600" style={{ width: `${progress}%` }} />
              </div>
            </article>
          ))}
        </div>
      </section>
      <aside className="border border-clay-900/12 bg-cream-50/70">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-6 py-5">
          <h2 className="text-xl font-semibold text-clay-900">素材与收益</h2>
          <span className="text-sm text-clay-500">AssetLineage</span>
        </div>
        <div className="grid grid-cols-2 gap-1 p-6">
          <Metric value="¥318" label="预估回流" />
          <Metric value="76" label="可二创节点" />
        </div>
        <div className="space-y-4 px-6">
          <AssetLine title="旧车站关键帧" note="图片层 · 可转视频" img="/home/m8.webp" />
          <AssetLine title="沈砚角色卡" note="三生授权快照 · 只读" img="/home/m11.webp" />
          <AssetLine title="雨夜停电礼物" note="礼物事件 · 可剪片段" img="/home/m2.webp" />
        </div>
        <p className="p-6 text-sm leading-7 text-clay-600">
          PC 创作者中心需要把“是否升级视频”变成可计算的生产决策，而不是让创作者盲目消耗昂贵模型额度。
        </p>
      </aside>
    </section>
  );
}

function RevenueView() {
  const bars = [34, 48, 41, 64, 53, 71, 58];
  const rows = [
    ["分支解锁", "雨夜信件 · Node 02", "¥128", "已入账", "原作 60% / 分支 25%"],
    ["礼物事件", "全场停电", "¥86", "已入账", "原作 70% / 平台池 20%"],
    ["角色卡解锁", "沈砚 · 高级声线", "¥54", "待结算", "角色作者 50%"],
    ["二创分成", "旧车站追踪", "¥212", "审核中", "原作 40% / 二创 45%"],
  ];
  return (
    <section className="grid gap-5 p-5 md:p-8 xl:grid-cols-[minmax(760px,1fr)_410px]">
      <section className="border border-clay-900/12 bg-cream-50/70">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-6 py-5">
          <h1 className="text-xl font-semibold text-clay-900">收益中心 · 用户收入与分账账本</h1>
          <span className="text-sm text-clay-500">CreatorRevenueLedger</span>
        </div>
        <div className="grid grid-cols-2 gap-px p-6 md:grid-cols-4">
          <Metric value="¥3,186" label="本月预估收入" />
          <Metric value="¥892" label="待结算" />
          <Metric value="42%" label="分支消费占比" />
          <Metric value="18" label="可收益作品" />
        </div>
        <div className="flex h-56 items-end gap-4 px-6 pb-8 pt-4">
          {bars.map((bar, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-3">
              <div className="w-full bg-gradient-to-t from-teal-200 to-amber-700" style={{ height: `${bar}%` }} />
              <span className="text-sm text-clay-500">周{["一", "二", "三", "四", "五", "六", "日"][index]}</span>
            </div>
          ))}
        </div>
        <div className="px-6 pb-6">
          <div className="grid grid-cols-[1fr_1.2fr_0.7fr_0.7fr_1.2fr] border border-clay-900/12 bg-cream-50/70 font-semibold text-amber-800">
            {["来源", "作品/节点", "金额", "状态", "分账"].map((h) => <div key={h} className="px-4 py-3">{h}</div>)}
          </div>
          {rows.map((row) => (
            <div key={row[1]} className="grid grid-cols-[1fr_1.2fr_0.7fr_0.7fr_1.2fr] border-x border-b border-clay-900/12 text-sm text-clay-600">
              {row.map((cell) => <div key={cell} className="px-4 py-3">{cell}</div>)}
            </div>
          ))}
        </div>
      </section>
      <aside className="border border-clay-900/12 bg-cream-50/70">
        <div className="flex items-center justify-between border-b border-clay-900/10 px-6 py-5">
          <h2 className="text-xl font-semibold text-clay-900">收入规则</h2>
          <span className="text-sm text-clay-500">可配置</span>
        </div>
        <div className="space-y-8 p-6">
          <Rule title="积分消费" subtitle="观看、解锁、分支、礼物" text="手机端发生的每一次有效消费，PC 端都能追踪来源节点。" />
          <Rule title="分账规则" subtitle="原作者 / 分支作者 / 素材贡献者" text="每笔流水保留 splitRule，便于未来真实结算或积分闭环。" />
          <Rule title="提现/结算" subtitle="先积分闭环，后真实收益" text="开源早期可只做积分分账，企业版或平台版再接支付结算。" />
          <Rule title="风控" subtitle="刷量、版权、真人形象审批" text="收益释放前检查来源、审核状态和异常互动。" />
        </div>
      </aside>
    </section>
  );
}

function BranchItem({ label, title, text }: { label: string; title: string; text: string }) {
  return (
    <div>
      <p className="font-semibold text-amber-800">{label}</p>
      <h3 className="mt-2 text-lg font-semibold text-clay-900">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-clay-500">{text}</p>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-cream-100/45 p-5">
      <div className="text-2xl font-semibold text-clay-900">{value}</div>
      <p className="mt-2 text-sm text-clay-500">{label}</p>
    </div>
  );
}

function AssetLine({ title, note, img }: { title: string; note: string; img: string }) {
  return (
    <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-4 border border-clay-900/12 p-3">
      <img src={img} alt={title} className="h-20 w-full object-cover" />
      <div className="min-w-0 py-2">
        <h3 className="truncate font-semibold text-clay-900">{title}</h3>
        <p className="mt-2 text-sm text-clay-500">{note}</p>
      </div>
    </div>
  );
}

function Rule({ title, subtitle, text }: { title: string; subtitle: string; text: string }) {
  return (
    <div>
      <p className="font-semibold text-amber-800">{title}</p>
      <h3 className="mt-2 text-lg font-semibold text-clay-900">{subtitle}</h3>
      <p className="mt-3 text-sm leading-7 text-clay-600">{text}</p>
    </div>
  );
}
