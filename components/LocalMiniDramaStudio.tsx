"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { getFeaturedTemplate } from "@/lib/featuredStories";
import type {
  DreamFrameBranchDraft,
  DreamFrameMiniDramaDraft,
  LocalMiniDramaCharacter,
  LocalMiniDramaCreateResult,
  LocalMiniDramaDrama,
  LocalMiniDramaEpisode,
  LocalMiniDramaListResult,
  LocalMiniDramaStatus,
} from "@/lib/localminidrama/types";

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: string };

type StudioSettings = {
  targetEpisodes: number;
  firstBatchEpisodes: number;
  gender: string;
  artStyle: string;
  plotStyle: string;
  voice: string;
  pacing: string;
  keywords: string;
  releaseMode: string;
  adaptiveCrossFormat: boolean;
};

type StoredStudioDraft = {
  id: string;
  title: string;
  thumbnail?: string | null;
  thumbnailName?: string | null;
  updatedAt: string;
  backendDramaId?: number;
  draft: DreamFrameMiniDramaDraft;
  settings: StudioSettings;
  scriptText: string;
};

const STUDIO_DRAFTS_STORAGE_KEY = "aistory:studio:localminidrama-drafts";
const STUDIO_DRAFT_LIMIT = 12;

const DEFAULT_SCRIPT = `《雨巷回声》

故事梗概：一个年轻剪辑师在老城区修复一卷遗失的家庭录像，发现录像里的人会回应现实中的选择。每一次播放都会让她进入不同的时间支线，也让一段被隐藏十年的告别逐渐浮出水面。

人物卡：
苏晚：主角，纪录片剪辑师，敏感、克制，擅长从画面细节里寻找真相。
沈砚：旧案记者，理性、执着，与苏晚在调查中产生信任。
阿梨：录像中的少女，像是被困在某个夏夜，知道支线背后的秘密。

第 1 集：旧录像
苏晚收到一封没有署名的包裹，里面是一卷损坏的 DV 带。她修复第一段画面时，镜头里的少女忽然回头，像是听见了她的呼吸。

第 2 集：雨夜来电
沈砚查到这卷录像来自十年前的失踪案。深夜，苏晚接到一个来自空号的电话，电话另一端只有雨声和一句：“不要让他进入巷子。”

第 3 集：第一处分叉
苏晚必须决定，是独自前往雨巷寻找录像拍摄地，还是先把线索交给沈砚。不同选择会打开不同证词、场景与结局。`;

const GENDERS = ["男性向", "女性向", "X"];
const ART_STYLES = ["电影感水彩", "真实影像", "赛博朋克", "水墨", "2D 动画", "自动"];
const PLOT_STYLES = ["多线转折", "悬疑烧脑", "治愈日常", "平铺直叙"];
const VOICES = ["开启", "关闭"];
const PACINGS = ["紧凑爽快", "慢热细腻"];
const RELEASE_MODES = [
  "自动分端：PC横屏 / 手机竖屏",
  "PC横屏优先",
  "手机竖屏优先",
];
const DEFAULT_RELEASE_MODE = "自动分端：PC横屏 / 手机竖屏";
const COMMON_WORDS = new Set([
  "故事",
  "梗概",
  "角色",
  "人物",
  "主角",
  "配角",
  "旁白",
  "镜头",
  "画面",
  "地点",
  "时间",
]);

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function unique(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function compactText(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function xmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildThumbnailDataUri(title: string, style: string) {
  const safeTitle = xmlText((title || "DreamFrame").trim().slice(0, 18));
  const safeStyle = xmlText((style || "Interactive Story").trim().slice(0, 28));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900" viewBox="0 0 640 900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141b18"/>
      <stop offset="48%" stop-color="#2a2118"/>
      <stop offset="100%" stop-color="#d2ad5c"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="30%" r="55%">
      <stop offset="0%" stop-color="#f1d98f" stop-opacity=".42"/>
      <stop offset="100%" stop-color="#f1d98f" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="640" height="900" fill="url(#bg)"/>
  <rect width="640" height="900" fill="url(#glow)"/>
  <rect x="42" y="42" width="556" height="816" fill="none" stroke="#dec276" stroke-width="2" opacity=".55"/>
  <text x="72" y="120" fill="#dec276" font-family="Georgia, serif" font-size="28" letter-spacing="6">DREAMFRAME</text>
  <text x="72" y="456" fill="#fff7dd" font-family="serif" font-size="58" font-weight="700">${safeTitle}</text>
  <text x="72" y="522" fill="#d7c8a6" font-family="sans-serif" font-size="24">${safeStyle}</text>
  <text x="72" y="796" fill="#dec276" font-family="sans-serif" font-size="20" letter-spacing="5">AI INTERACTIVE FILM</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildPlatformVariants(settings: StudioSettings) {
  const mobileFirst = settings.releaseMode.includes("手机");
  const desktopFirst = settings.releaseMode.includes("PC");
  return [
    {
      platform: "desktop" as const,
      orientation: "landscape" as const,
      generationPolicy: mobileFirst ? "generate-on-demand" as const : "generate-first" as const,
      referenceStrategy: settings.adaptiveCrossFormat ? "follow-winning-format" as const : "native" as const,
    },
    {
      platform: "mobile" as const,
      orientation: "portrait" as const,
      generationPolicy: desktopFirst ? "generate-on-demand" as const : "generate-first" as const,
      referenceStrategy: settings.adaptiveCrossFormat ? "follow-winning-format" as const : "native" as const,
    },
  ];
}

function inferTitle(text: string) {
  const lines = compactText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const bracketed = lines[0]?.match(/^《(.{1,40})》$/);
  if (bracketed?.[1]) return bracketed[1].trim();
  const explicit = lines.find((line) => /^(标题|剧名|片名|项目名)[：:]/.test(line));
  if (explicit) return explicit.replace(/^(标题|剧名|片名|项目名)[：:]\s*/, "").slice(0, 40);
  return lines[0]?.replace(/^#+\s*/, "").slice(0, 40) || "DreamFrame 短剧草稿";
}

function inferSummary(text: string) {
  const cleaned = compactText(text);
  const explicit = cleaned.match(/(?:故事梗概|梗概|简介|大纲)[：:]\s*([\s\S]*?)(?=\n\s*(?:人物卡|角色|第\s*[0-9一二三四五六七八九十百千万]+\s*[集章幕]|EP|Episode)|$)/i);
  if (explicit?.[1]) return explicit[1].trim().slice(0, 1200);
  const paragraphs = cleaned.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return (paragraphs.find((part) => part.length > 40) || paragraphs[0] || cleaned).slice(0, 1200);
}

function inferCharacters(text: string): LocalMiniDramaCharacter[] {
  const candidates: LocalMiniDramaCharacter[] = [];
  const characterBlock = text.match(/(?:人物卡|角色表|角色设定)[：:]?\s*([\s\S]*?)(?=\n\s*(?:第\s*[0-9一二三四五六七八九十百千万]+\s*[集章幕]|EP|Episode)|$)/i)?.[1] || "";
  const lines = characterBlock.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([^：:，,、\s]{2,12})[：:，,、\s]+(.+)$/);
    if (!match?.[1]) continue;
    const name = match[1].replace(/^(角色|人物|姓名)/, "").trim();
    if (!name || COMMON_WORDS.has(name)) continue;
    const desc = match[2]?.trim() || "";
    candidates.push({
      name,
      role: candidates.length === 0 ? "主角" : "重要角色",
      description: desc.slice(0, 240),
      personality: desc.slice(0, 120),
      appearance: "",
      sort_order: candidates.length,
    });
  }

  const dialogueNames = Array.from(text.matchAll(/(?:^|\n)\s*([\u4e00-\u9fa5]{2,4})[：:]/g))
    .map((match) => match[1] || "")
    .filter((name) => !COMMON_WORDS.has(name));

  for (const name of unique(dialogueNames)) {
    if (candidates.some((item) => item.name === name)) continue;
    candidates.push({
      name,
      role: candidates.length === 0 ? "主角" : "角色",
      description: "从剧本文本中识别出的角色，等待创作者补充人物卡。",
      personality: "",
      appearance: "",
      sort_order: candidates.length,
    });
  }

  if (candidates.length === 0) {
    return [
      {
        name: "主角",
        role: "主角",
        description: "从导入剧本中继续细化的人物。",
        personality: "由创作者补充",
        appearance: "",
        sort_order: 0,
      },
    ];
  }
  return candidates.slice(0, 12);
}

function parseEpisodeChunks(text: string): LocalMiniDramaEpisode[] {
  const marker = /(?:^|\n)\s*((?:第\s*[\d一二三四五六七八九十百千万]+\s*[集章幕])|(?:EP(?:ISODE)?\s*\d+))\s*[：:、.\-\s]*(.*)/gi;
  const matches = Array.from(text.matchAll(marker));
  if (matches.length === 0) return [];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const chunk = text.slice(start, end).trim();
    const firstLineBreak = chunk.indexOf("\n");
    const content = firstLineBreak >= 0 ? chunk.slice(firstLineBreak + 1).trim() : "";
    const title = (match[2]?.trim() || match[1]?.trim() || `第 ${index + 1} 集`).slice(0, 80);
    return {
      episode_number: index + 1,
      title,
      script_content: content || chunk,
      description: (content || chunk).slice(0, 180),
      duration: 0,
      status: "draft",
    };
  });
}

function buildEpisodes(text: string, settings: StudioSettings): LocalMiniDramaEpisode[] {
  const parsed = parseEpisodeChunks(text);
  const firstBatch = clampInt(settings.firstBatchEpisodes, 1, 60);
  const target = clampInt(settings.targetEpisodes, 1, 999);
  const desired = Math.min(firstBatch, target);
  const keywords = unique([
    settings.gender,
    settings.artStyle,
    settings.plotStyle,
    settings.voice === "开启" ? "有声" : "无声",
    settings.pacing,
    ...settings.keywords.split(/[，,、\s]+/),
  ]).join(" / ");

  const episodes = parsed.length > 0
    ? parsed.slice(0, desired)
    : [
        {
          episode_number: 1,
          title: "第 1 集",
          script_content: text,
          description: inferSummary(text).slice(0, 180),
          duration: 0,
          status: "draft",
        },
      ];

  while (episodes.length < desired) {
    const next = episodes.length + 1;
    episodes.push({
      episode_number: next,
      title: `第 ${next} 集 AI续写草案`,
      script_content: `【待 AI 续写】围绕「${keywords}」继续推进主线，并在本集末尾保留 2-3 个可交互分支。`,
      description: `续写目标：承接上一集，保持 ${settings.plotStyle} 与 ${settings.pacing}。`,
      duration: 0,
      status: "draft",
    });
  }

  return episodes.map((episode, index) => ({ ...episode, episode_number: index + 1 }));
}

function buildBranches(settings: StudioSettings): DreamFrameBranchDraft[] {
  const styleKey = `${settings.artStyle}:${settings.pacing}`;
  return [
    {
      branchId: "branch-truth",
      parentEpisode: 1,
      choiceText: "追问真相",
      direction: "优先展开核心谜团，推动线索和人物关系快速碰撞。",
      cachePolicy: "reuse-story-cache",
      imageStyleCacheKey: styleKey,
    },
    {
      branchId: "branch-emotion",
      parentEpisode: 1,
      choiceText: "靠近人物",
      direction: "优先描写人物情绪、亲密关系、回忆和微妙试探。",
      cachePolicy: "reuse-story-cache",
      imageStyleCacheKey: styleKey,
    },
    {
      branchId: "branch-risk",
      parentEpisode: 1,
      choiceText: "冒险行动",
      direction: "让主角主动进入危险场景，制造更强节奏和反转。",
      cachePolicy: "reuse-story-cache",
      imageStyleCacheKey: styleKey,
    },
  ];
}

function buildDraftFromText(text: string, settings: StudioSettings): DreamFrameMiniDramaDraft {
  const sourceText = compactText(text) || DEFAULT_SCRIPT;
  const title = inferTitle(sourceText);
  const summary = inferSummary(sourceText);
  const keywords = unique([
    settings.gender,
    settings.artStyle,
    settings.plotStyle,
    settings.voice,
    settings.pacing,
    ...settings.keywords.split(/[，,、\s]+/),
  ]);
  return {
    title,
    summary,
    genre: "interactive-minidrama",
    style: settings.artStyle,
    tags: keywords,
    thumbnail: buildThumbnailDataUri(title, settings.artStyle),
    thumbnailName: "auto-cover.svg",
    sourceText,
    characters: inferCharacters(sourceText),
    episodes: buildEpisodes(sourceText, settings),
    branches: buildBranches(settings),
    platformVariants: buildPlatformVariants(settings),
    continuation: {
      targetEpisodes: clampInt(settings.targetEpisodes, 1, 999),
      firstBatchEpisodes: clampInt(settings.firstBatchEpisodes, 1, 60),
      keywords,
      gender: settings.gender,
      artStyle: settings.artStyle,
      plotStyle: settings.plotStyle,
      voice: settings.voice,
      pacing: settings.pacing,
      branchMode: "branch-overlay",
      releaseMode: settings.releaseMode,
      adaptiveCrossFormat: settings.adaptiveCrossFormat,
    },
  };
}

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function readStoredStudioDrafts(): StoredStudioDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STUDIO_DRAFTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is StoredStudioDraft =>
        !!item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        !!(item as StoredStudioDraft).draft &&
        !!(item as StoredStudioDraft).settings,
      )
      .slice(0, STUDIO_DRAFT_LIMIT);
  } catch {
    return [];
  }
}

function writeStoredStudioDrafts(drafts: StoredStudioDraft[]) {
  if (typeof window === "undefined") return drafts;
  const next = drafts.slice(0, STUDIO_DRAFT_LIMIT);
  try {
    window.localStorage.setItem(STUDIO_DRAFTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage may be full; keep the in-memory list so the current
    // session can still continue.
  }
  return next;
}

function upsertStoredStudioDraft(entry: StoredStudioDraft) {
  const current = readStoredStudioDrafts();
  const next = [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, STUDIO_DRAFT_LIMIT);
  return writeStoredStudioDrafts(next);
}

function buildStoredStudioDraft(
  draft: DreamFrameMiniDramaDraft,
  settings: StudioSettings,
  scriptText: string,
  backendDramaId?: number,
): StoredStudioDraft {
  const updatedAt = new Date().toISOString();
  return {
    id: backendDramaId ? `backend-${backendDramaId}` : `local-${Date.now().toString(36)}`,
    title: draft.title || "未命名短剧",
    thumbnail: draft.thumbnail,
    thumbnailName: draft.thumbnailName,
    updatedAt,
    backendDramaId,
    draft,
    settings,
    scriptText,
  };
}

function buildTemplateScript(templateId: string) {
  const template = getFeaturedTemplate(templateId);
  if (!template) return null;
  const tags = template.tags?.length ? `\n标签：${template.tags.join("、")}` : "";
  return {
    template,
    script: `《${template.title}》

故事梗概：${template.outline}
${tags}

人物卡：
主角：围绕“${template.title}”展开行动的人物，性格、外貌、声音和授权状态等待创作者在 studio 中补全。
关键角色：与主角形成选择压力、情感关系或冲突的人物，后续可继续拆分为多张人物卡。

第 1 集：开局
${template.outline}

第 2 集：第一次选择
主角必须在两个方向之间做出选择：继续追查隐藏线索，或先保护身边重要的人。不同选择会打开不同证词、场景与结局。

第 3 集：支线显影
世界线开始分叉，玩家的选择会影响角色关系、画面资产、后续短剧镜头和可公开的互动节点。`,
  };
}

export function LocalMiniDramaStudio({
  initialTemplateId,
  onOpenWorkspace,
}: {
  initialTemplateId?: string;
  onOpenWorkspace?: (projectId: number, destination: "production" | "canvas") => void;
} = {}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbnailRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<"night" | "day">("day");
  const [scriptText, setScriptText] = useState(DEFAULT_SCRIPT);
  const [customThumbnail, setCustomThumbnail] = useState(false);
  const [settings, setSettings] = useState<StudioSettings>({
    targetEpisodes: 10,
    firstBatchEpisodes: 10,
    gender: "女性向",
    artStyle: "电影感水彩",
    plotStyle: "多线转折",
    voice: "开启",
    pacing: "紧凑爽快",
    keywords: "支线选择 情感悬念 可缓存",
    releaseMode: DEFAULT_RELEASE_MODE,
    adaptiveCrossFormat: true,
  });
  const [draft, setDraft] = useState<DreamFrameMiniDramaDraft>(() =>
    buildDraftFromText(DEFAULT_SCRIPT, {
      targetEpisodes: 10,
      firstBatchEpisodes: 10,
      gender: "女性向",
      artStyle: "电影感水彩",
      plotStyle: "多线转折",
      voice: "开启",
      pacing: "紧凑爽快",
      keywords: "支线选择 情感悬念 可缓存",
      releaseMode: DEFAULT_RELEASE_MODE,
      adaptiveCrossFormat: true,
    }),
  );
  const [status, setStatus] = useState<LocalMiniDramaStatus | null>(null);
  const [dramas, setDramas] = useState<LocalMiniDramaDrama[]>([]);
  const [localDrafts, setLocalDrafts] = useState<StoredStudioDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<LocalMiniDramaCreateResult | null>(null);
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null);

  const shell = theme === "night"
    ? "bg-[#0c1110] text-[#e9dec8]"
    : "ui-page";
  const panel = theme === "night"
    ? "border-[#31403b] bg-[#121a18]"
    : "ui-surface";
  const muted = theme === "night" ? "text-[#b7aa92]" : "text-clay-600";
  const inputClass = theme === "night"
    ? "border-[#35463f] bg-[#0f1514] text-[#f3ead6] placeholder:text-[#837966]"
    : "ui-input";

  const branchScore = useMemo(() => {
    const episodeCount = draft.episodes.length || 1;
    const branchCount = draft.branches.length;
    return `${branchCount} 分支 / ${episodeCount} 集`;
  }, [draft.branches.length, draft.episodes.length]);

  async function refreshStatus() {
    try {
      const res = await fetch("/api/localminidrama/status", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as LocalMiniDramaStatus | null;
      setStatus(json);
      if (json?.ok) await refreshDramas();
    } catch (error) {
      setStatus({
        ok: false,
        backendUrl: "http://127.0.0.1:5679",
        frontendUrl: "http://127.0.0.1:4107",
        message: error instanceof Error ? error.message : "无法连接 LocalMiniDrama",
      });
    }
  }

  async function refreshDramas() {
    try {
      const res = await fetch("/api/localminidrama/dramas?page=1&page_size=6", { cache: "no-store" });
      const json = (await res.json()) as ApiEnvelope<LocalMiniDramaListResult>;
      if (!json.ok) throw new Error(json.error || "读取失败");
      setDramas(json.data?.items || []);
    } catch {
      setDramas([]);
    }
  }

  useEffect(() => {
    void refreshStatus();
    setLocalDrafts(readStoredStudioDrafts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialTemplateId || loadedTemplateId === initialTemplateId) return;
    const payload = buildTemplateScript(initialTemplateId);
    if (!payload) {
      setMessage(`未找到模板：${initialTemplateId}`);
      setLoadedTemplateId(initialTemplateId);
      return;
    }
    const { template, script } = payload;
    const nextSettings: StudioSettings = {
      ...settings,
      gender: template.gender,
      artStyle: ART_STYLES.includes(template.style) ? template.style : settings.artStyle,
      keywords: unique([...(template.tags || []), template.gender, template.style, "首页模板", "可编辑"]).join(" "),
      releaseMode: DEFAULT_RELEASE_MODE,
      adaptiveCrossFormat: true,
    };
    const nextDraft = buildDraftFromText(script, nextSettings);
    setSettings(nextSettings);
    setScriptText(script);
    setCustomThumbnail(true);
    setDraft({
      ...nextDraft,
      thumbnail: template.coverPath,
      thumbnailName: `template-${template.id}`,
      tags: unique([...(nextDraft.tags || []), ...(template.tags || []), template.gender]),
    });
    setCreated(null);
    setMessage(`已从剧本库载入模板《${template.title}》，可直接编辑、解析、创建短剧草稿。`);
    setLoadedTemplateId(initialTemplateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplateId, loadedTemplateId]);

  useEffect(() => {
    if (initialTemplateId && loadedTemplateId !== initialTemplateId) return;
    setDraft((prev) => ({
      ...prev,
      thumbnail: customThumbnail ? prev.thumbnail : buildThumbnailDataUri(prev.title, settings.artStyle),
      thumbnailName: customThumbnail ? prev.thumbnailName : "auto-cover.svg",
      platformVariants: buildPlatformVariants(settings),
      continuation: {
        ...prev.continuation,
        releaseMode: settings.releaseMode,
        adaptiveCrossFormat: settings.adaptiveCrossFormat,
      },
    }));
  }, [customThumbnail, initialTemplateId, loadedTemplateId, settings.adaptiveCrossFormat, settings.artStyle, settings.releaseMode]);

  function updateSettings(patch: Partial<StudioSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      if (patch.targetEpisodes != null) {
        next.targetEpisodes = clampInt(patch.targetEpisodes, 1, 999);
        next.firstBatchEpisodes = Math.min(next.firstBatchEpisodes, Math.min(next.targetEpisodes, 60));
      }
      if (patch.firstBatchEpisodes != null) {
        next.firstBatchEpisodes = clampInt(patch.firstBatchEpisodes, 1, Math.min(next.targetEpisodes, 60));
      }
      return next;
    });
  }

  function updateDraftTitle(title: string) {
    setDraft((prev) => ({
      ...prev,
      title,
      thumbnail: customThumbnail ? prev.thumbnail : buildThumbnailDataUri(title, settings.artStyle),
      thumbnailName: customThumbnail ? prev.thumbnailName : "auto-cover.svg",
    }));
  }

  function restoreAutoThumbnail() {
    setCustomThumbnail(false);
    setDraft((prev) => ({
      ...prev,
      thumbnail: buildThumbnailDataUri(prev.title, settings.artStyle),
      thumbnailName: "auto-cover.svg",
    }));
  }

  function parseScript() {
    const next = buildDraftFromText(scriptText, settings);
    setDraft((prev) =>
      customThumbnail
        ? { ...next, thumbnail: prev.thumbnail, thumbnailName: prev.thumbnailName }
        : next,
    );
    setCreated(null);
    setMessage(`已解析：${next.characters.length} 个角色、${next.episodes.length} 个首批分集、${next.branches.length} 个分支。`);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setScriptText(text);
    const next = buildDraftFromText(text, settings);
    setDraft((prev) =>
      customThumbnail
        ? { ...next, thumbnail: prev.thumbnail, thumbnailName: prev.thumbnailName }
        : next,
    );
    setMessage(`已导入 ${file.name}`);
  }

  async function readThumbnail(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage("缩略图需要选择图片文件。");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setMessage("缩略图暂时限制在 4MB 以内，后面会接入正式素材库。");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取缩略图失败"));
      reader.readAsDataURL(file);
    });
    setCustomThumbnail(true);
    setDraft((prev) => ({ ...prev, thumbnail: dataUrl, thumbnailName: file.name }));
    setMessage(`已设置缩略图：${file.name}`);
  }

  async function generateContinuationWithAI() {
    setAiLoading(true);
    setMessage("");
    try {
      const count = Math.min(20, settings.firstBatchEpisodes, settings.targetEpisodes);
      const res = await fetch("/api/localminidrama/continuation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          premise: `${draft.summary}\n\n续写关键词：${settings.keywords}`,
          style: settings.artStyle,
          type: `${settings.plotStyle} / ${settings.pacing}`,
          episode_count: count,
        }),
      });
      const json = (await res.json()) as ApiEnvelope<{ episodes: Array<{ episode: number; title: string; content: string }> }>;
      if (!json.ok) throw new Error(json.error || "AI续写失败");
      const episodes = (json.data?.episodes || []).map((episode, index) => ({
        episode_number: Number(episode.episode) || index + 1,
        title: episode.title || `第 ${index + 1} 集`,
        script_content: episode.content || "",
        description: (episode.content || "").slice(0, 180),
        duration: 0,
        status: "draft",
      }));
      if (episodes.length === 0) throw new Error("AI没有返回有效分集");
      setDraft((prev) => ({ ...prev, episodes }));
      setMessage(`AI已生成 ${episodes.length} 集。LocalMiniDrama 单次最多 20 集，长篇会按批次续写。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI续写失败");
    } finally {
      setAiLoading(false);
    }
  }

  async function createDrama() {
    setLoading(true);
    setMessage("");
    let localEntry: StoredStudioDraft | null = null;
    try {
      const normalizedDraft: DreamFrameMiniDramaDraft = {
        ...draft,
        thumbnail: draft.thumbnail || buildThumbnailDataUri(draft.title, settings.artStyle),
        thumbnailName: draft.thumbnailName || "auto-cover.svg",
        platformVariants: buildPlatformVariants(settings),
        continuation: {
          ...draft.continuation,
          targetEpisodes: settings.targetEpisodes,
          firstBatchEpisodes: settings.firstBatchEpisodes,
          keywords: unique([
            ...settings.keywords.split(/[，,、\s]+/),
            settings.gender,
            settings.artStyle,
            settings.plotStyle,
            settings.pacing,
          ]),
          gender: settings.gender,
          artStyle: settings.artStyle,
          plotStyle: settings.plotStyle,
          voice: settings.voice,
          pacing: settings.pacing,
          branchMode: "branch-overlay",
          releaseMode: settings.releaseMode,
          adaptiveCrossFormat: settings.adaptiveCrossFormat,
        },
      };
      localEntry = buildStoredStudioDraft(normalizedDraft, settings, scriptText);
      const res = await fetch("/api/localminidrama/dramas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalizedDraft),
      });
      const json = (await res.json()) as ApiEnvelope<LocalMiniDramaCreateResult>;
      if (!json.ok || !json.data) throw new Error(json.error || "创建失败");
      const savedEntry = buildStoredStudioDraft(
        { ...normalizedDraft, title: json.data.drama.title || normalizedDraft.title },
        settings,
        scriptText,
        json.data.drama.id,
      );
      setLocalDrafts(upsertStoredStudioDraft(savedEntry));
      setDraft(savedEntry.draft);
      setCreated(json.data);
      setMessage(`已创建 LocalMiniDrama 草稿：${json.data.drama.title}。本地过往数据也已保存，可随时重新打开。`);
      await refreshDramas();
    } catch (error) {
      if (localEntry) {
        setLocalDrafts(upsertStoredStudioDraft(localEntry));
        setCreated(null);
        const reason = error instanceof Error ? error.message : "创建失败";
        setMessage(`LocalMiniDrama 后端暂不可用，已先保存为本地草稿：${localEntry.title}。原因：${reason}`);
      } else {
        setMessage(error instanceof Error ? error.message : "创建失败");
      }
    } finally {
      setLoading(false);
    }
  }

  function openLocalDraft(item: StoredStudioDraft) {
    setDraft(item.draft);
    setSettings(item.settings);
    setScriptText(item.scriptText || item.draft.sourceText || DEFAULT_SCRIPT);
    setCustomThumbnail(!!item.draft.thumbnail && item.draft.thumbnailName !== "auto-cover.svg");
    setCreated(null);
    setLoadedTemplateId(null);
    setMessage(`已打开过往草稿：${item.title}`);
  }

  function updateCharacter(index: number, patch: Partial<LocalMiniDramaCharacter>) {
    setDraft((prev) => ({
      ...prev,
      characters: prev.characters.map((character, i) => (i === index ? { ...character, ...patch } : character)),
    }));
  }

  function updateEpisode(index: number, patch: Partial<LocalMiniDramaEpisode>) {
    setDraft((prev) => ({
      ...prev,
      episodes: prev.episodes.map((episode, i) => (i === index ? { ...episode, ...patch } : episode)),
    }));
  }

  function updateBranch(index: number, patch: Partial<DreamFrameBranchDraft>) {
    setDraft((prev) => ({
      ...prev,
      branches: prev.branches.map((branch, i) => (i === index ? { ...branch, ...patch } : branch)),
    }));
  }

  return (
    <main className={`min-h-screen ${shell} ${theme === "night" ? "aistory-night" : ""}`}>
      <div className="mx-auto flex min-h-screen w-full max-w-[1720px] flex-col px-5 py-5 md:px-8">
        <header className={`flex flex-wrap items-center justify-between gap-4 border ${panel} px-5 py-4`}>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className={`inline-flex h-11 w-11 items-center justify-center border ${theme === "night" ? "border-[#5e5338] text-[#d7b35f]" : "border-clay-900/20 text-ember-500"}`}
              aria-label="返回首页"
              title="返回首页"
            >
              <i className="fa-solid fa-house" />
            </Link>
            <div>
              <div className="font-serif text-2xl leading-none md:text-[32px]">
                AIstory <em className="text-ember-500">DreamFrame</em>
              </div>
              <div className={`mt-1 text-xs ${muted}`}>专业编辑 / LocalMiniDrama Bridge</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`border px-3 py-2 ${theme === "night" ? "border-[#40524c] text-[#9bd3c7]" : "border-clay-900/15 text-clay-600"}`}>
              {status?.ok ? "LocalMiniDrama 已连接" : "LocalMiniDrama 未连接"}
            </span>
            <button
              type="button"
              onClick={() => setTheme((value) => (value === "night" ? "day" : "night"))}
              className={`inline-flex items-center gap-2 border px-3 py-2 ${theme === "night" ? "border-[#40524c] hover:bg-[#1a2421]" : "border-clay-900/15 hover:bg-cream-100"}`}
            >
              <i className={`fa-solid ${theme === "night" ? "fa-sun" : "fa-moon"}`} />
              {theme === "night" ? "白天模式" : "夜晚模式"}
            </button>
            <button
              type="button"
              onClick={() => void refreshStatus()}
              className={`inline-flex items-center gap-2 border px-3 py-2 ${theme === "night" ? "border-[#40524c] hover:bg-[#1a2421]" : "border-clay-900/15 hover:bg-cream-100"}`}
            >
              <i className="fa-solid fa-rotate" />
              刷新
            </button>
          </div>
        </header>

        <div className="grid flex-1 gap-5 py-5 xl:grid-cols-[minmax(0,1.06fr)_minmax(420px,0.94fr)]">
          <section className={`border ${panel}`}>
            <div className="flex items-center justify-between border-b border-current/10 px-5 py-4">
              <h1 className="font-serif text-2xl">一键导入剧本</h1>
              <div className={`text-sm ${muted}`}>{branchScore}</div>
            </div>
            <div className="space-y-4 p-5">
              <div className={`grid gap-4 border p-4 md:grid-cols-[172px_minmax(0,1fr)] ${theme === "night" ? "border-[#35463f] bg-[#0f1514]" : "border-clay-900/15 bg-white/60"}`}>
                <button
                  type="button"
                  onClick={() => thumbnailRef.current?.click()}
                  className="group relative aspect-[3/4] overflow-hidden border border-current/20 bg-black/20 text-left"
                  aria-label="选择剧本缩略图"
                  title="选择剧本缩略图"
                >
                  {draft.thumbnail ? (
                    <img src={draft.thumbnail} alt={draft.title || "剧本缩略图"} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-4 text-center font-serif text-lg">
                      {draft.title || "DreamFrame"}
                    </div>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-black/65 px-3 py-2 text-xs text-white opacity-0 transition group-hover:opacity-100">
                    更换缩略图
                  </span>
                </button>
                <div className="flex min-w-0 flex-col justify-between gap-4">
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                    <label className="block min-w-0">
                      <span className={`mb-2 block text-xs ${muted}`}>剧本名称</span>
                      <input
                        value={draft.title}
                        onChange={(event) => updateDraftTitle(event.target.value)}
                        className={`h-12 w-full border px-3 text-lg font-semibold outline-none ${inputClass}`}
                      />
                    </label>
                    <div className="flex items-end gap-2">
                      <button
                        type="button"
                        onClick={() => thumbnailRef.current?.click()}
                        className="inline-flex h-12 items-center gap-2 border border-current/20 px-4 hover:bg-current/5"
                      >
                        <i className="fa-solid fa-image" />
                        上传封面
                      </button>
                      <button
                        type="button"
                        onClick={restoreAutoThumbnail}
                        className="inline-flex h-12 items-center gap-2 border border-current/20 px-4 hover:bg-current/5"
                      >
                        <i className="fa-solid fa-wand-magic-sparkles" />
                        自动封面
                      </button>
                    </div>
                  </div>
                  <div className={`grid gap-3 text-sm md:grid-cols-3 ${muted}`}>
                    <div className="border border-current/15 px-3 py-2">
                      <div className="font-semibold text-current">PC 版</div>
                      <div>首次播放生成横屏资产</div>
                    </div>
                    <div className="border border-current/15 px-3 py-2">
                      <div className="font-semibold text-current">手机端</div>
                      <div>首次播放生成竖屏资产</div>
                    </div>
                    <div className="border border-current/15 px-3 py-2">
                      <div className="font-semibold text-current">跨端跟随</div>
                      <div>高赞端画风会成为另一端参考</div>
                    </div>
                  </div>
                  <div className={`text-xs ${muted}`}>
                    当前缩略图：{draft.thumbnailName || "auto-cover.svg"}；缩略图会写入项目元数据，后续用于本地剧本库、推荐流和创作者中心。
                  </div>
                </div>
              </div>
              <textarea
                value={scriptText}
                onChange={(event) => setScriptText(event.target.value)}
                className={`h-[360px] w-full resize-none border p-4 font-serif text-base leading-7 outline-none ${inputClass}`}
                spellCheck={false}
              />
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.csv,.json,text/*"
                className="hidden"
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
              <input
                ref={thumbnailRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void readThumbnail(event.target.files?.[0])}
              />
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-2 border border-current/20 px-4 py-3 hover:bg-current/5"
                >
                  <i className="fa-solid fa-file-import" />
                  选择文本
                </button>
                <button
                  type="button"
                  onClick={parseScript}
                  className="inline-flex items-center gap-2 bg-ember-500 px-5 py-3 font-semibold text-cream-50 hover:bg-[rgb(var(--ui-primary-hover))]"
                >
                  <i className="fa-solid fa-wand-magic-sparkles" />
                  解析并填写
                </button>
                <button
                  type="button"
                  onClick={() => void generateContinuationWithAI()}
                  disabled={aiLoading || !status?.ok}
                  className="inline-flex items-center gap-2 border border-current/20 px-4 py-3 hover:bg-current/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <i className={`fa-solid ${aiLoading ? "fa-spinner animate-spin" : "fa-pen-nib"}`} />
                  AI续写批次
                </button>
                <button
                  type="button"
                  onClick={() => void createDrama()}
                  disabled={loading}
                  className="ml-auto inline-flex items-center gap-2 bg-ember-500 px-5 py-3 font-semibold text-cream-50 hover:bg-[rgb(var(--ui-primary-hover))] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <i className={`fa-solid ${loading ? "fa-spinner animate-spin" : "fa-clapperboard"}`} />
                  创建短剧草稿
                </button>
              </div>
              {message && <div className={`border px-4 py-3 text-sm ${theme === "night" ? "border-[#40524c] bg-[#0f1514] text-[#d8ceb9]" : "border-clay-900/15 bg-cream-100 text-clay-700"}`}>{message}</div>}
              {created && (
                <div className={`grid gap-3 border p-4 md:grid-cols-2 ${theme === "night" ? "border-[#40524c] bg-[#0f1514]" : "border-clay-900/15 bg-white/60"}`}>
                  {onOpenWorkspace ? (
                    <button type="button" onClick={() => onOpenWorkspace(created.drama.id, "production")} className="inline-flex items-center justify-center gap-2 bg-ember-500 px-4 py-3 font-semibold text-cream-50">
                      <i className="fa-solid fa-list-check" />
                      进入统一制作台
                    </button>
                  ) : (
                    <a href={created.detailUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 bg-ember-500 px-4 py-3 font-semibold text-cream-50">
                      <i className="fa-solid fa-list-check" />
                      剧集管理
                    </a>
                  )}
                  {onOpenWorkspace ? (
                    <button type="button" onClick={() => onOpenWorkspace(created.drama.id, "canvas")} className="inline-flex items-center justify-center gap-2 border border-current/20 px-4 py-3 hover:bg-current/5">
                      <i className="fa-solid fa-diagram-project" />
                      打开生产画布
                    </button>
                  ) : (
                    <a href={created.filmUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 border border-current/20 px-4 py-3 hover:bg-current/5">
                      <i className="fa-solid fa-film" />
                      短剧生成
                    </a>
                  )}
                </div>
              )}
            </div>
          </section>

          <aside className={`border ${panel}`}>
            <div className="flex items-center justify-between border-b border-current/10 px-5 py-4">
              <h2 className="font-serif text-2xl">开局配置</h2>
              <span className={`text-sm ${muted}`}>目标 {settings.targetEpisodes} 集</span>
            </div>
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              <SelectBox label="性向" value={settings.gender} options={GENDERS} onChange={(value) => updateSettings({ gender: value })} inputClass={inputClass} />
              <SelectBox label="画风" value={settings.artStyle} options={ART_STYLES} onChange={(value) => updateSettings({ artStyle: value })} inputClass={inputClass} />
              <SelectBox label="剧情风格" value={settings.plotStyle} options={PLOT_STYLES} onChange={(value) => updateSettings({ plotStyle: value })} inputClass={inputClass} />
              <SelectBox label="语音配音" value={settings.voice} options={VOICES} onChange={(value) => updateSettings({ voice: value })} inputClass={inputClass} />
              <SelectBox label="内容节奏" value={settings.pacing} options={PACINGS} onChange={(value) => updateSettings({ pacing: value })} inputClass={inputClass} />
              <SelectBox label="首发画幅" value={settings.releaseMode} options={RELEASE_MODES} onChange={(value) => updateSettings({ releaseMode: value })} inputClass={inputClass} />
              <label className="block">
                <span className={`mb-2 block text-xs ${muted}`}>总集数</span>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={settings.targetEpisodes}
                  onChange={(event) => updateSettings({ targetEpisodes: Number(event.target.value) })}
                  className={`h-11 w-full border px-3 outline-none ${inputClass}`}
                />
              </label>
              <label className="block">
                <span className={`mb-2 block text-xs ${muted}`}>首批入库</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={settings.firstBatchEpisodes}
                  onChange={(event) => updateSettings({ firstBatchEpisodes: Number(event.target.value) })}
                  className={`h-11 w-full border px-3 outline-none ${inputClass}`}
                />
              </label>
              <label className={`flex items-center gap-3 border px-3 py-3 text-sm sm:col-span-2 ${theme === "night" ? "border-[#35463f] bg-[#0f1514]" : "border-clay-900/15 bg-white/60"}`}>
                <input
                  type="checkbox"
                  checked={settings.adaptiveCrossFormat}
                  onChange={(event) => updateSettings({ adaptiveCrossFormat: event.target.checked })}
                  className="h-4 w-4 accent-ember-500"
                />
                <span>跨端画风跟随：如果横屏或竖屏某一端数据更好，另一端补生成时尽量贴近高赞端画风。</span>
              </label>
              <label className="block sm:col-span-2">
                <span className={`mb-2 block text-xs ${muted}`}>续写关键词</span>
                <input
                  value={settings.keywords}
                  onChange={(event) => updateSettings({ keywords: event.target.value })}
                  className={`h-11 w-full border px-3 outline-none ${inputClass}`}
                />
              </label>
            </div>

            <div className="border-t border-current/10 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-serif text-xl">LocalMiniDrama 最近项目</h3>
                {status?.frontendUrl && (
                  <a href={status.frontendUrl} target="_blank" rel="noreferrer" className={`text-sm ${muted} hover:text-ember-500`}>
                    打开原界面
                  </a>
                )}
              </div>
              <div className="space-y-2">
                {dramas.map((drama) => (
                  <a
                    key={drama.id}
                    href={`${status?.frontendUrl || "http://127.0.0.1:4107"}/drama/${drama.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className={`flex items-center justify-between gap-3 border px-3 py-2 text-sm hover:bg-current/5 ${theme === "night" ? "border-[#35463f]" : "border-clay-900/15"}`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      {drama.thumbnail ? (
                        <img src={drama.thumbnail} alt="" className="h-12 w-10 shrink-0 object-cover" />
                      ) : (
                        <span className="flex h-12 w-10 shrink-0 items-center justify-center bg-ember-500/20 text-ember-500">
                          <i className="fa-solid fa-clapperboard" />
                        </span>
                      )}
                      <span className="truncate pr-3">{drama.title}</span>
                    </span>
                    <span className={muted}>{formatDate(drama.updated_at)}</span>
                  </a>
                ))}
                {dramas.length === 0 && <div className={`border px-3 py-4 text-sm ${theme === "night" ? "border-[#35463f]" : "border-clay-900/15"} ${muted}`}>暂无可显示项目</div>}
              </div>

              <div className="mt-5 border-t border-current/10 pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-serif text-xl">AIstory 本地过往草稿</h3>
                  <span className={`text-xs ${muted}`}>{localDrafts.length} 条</span>
                </div>
                <div className="space-y-2">
                  {localDrafts.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openLocalDraft(item)}
                      className={`flex w-full items-center justify-between gap-3 border px-3 py-2 text-left text-sm hover:bg-current/5 ${theme === "night" ? "border-[#35463f]" : "border-clay-900/15"}`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        {item.thumbnail ? (
                          <img src={item.thumbnail} alt="" className="h-12 w-10 shrink-0 object-cover" />
                        ) : (
                          <span className="flex h-12 w-10 shrink-0 items-center justify-center bg-ember-500/20 text-ember-500">
                            <i className="fa-solid fa-file-pen" />
                          </span>
                        )}
                        <span className="min-w-0">
                          <span className="block truncate pr-3">{item.title}</span>
                          <span className={`mt-0.5 block text-xs ${muted}`}>
                            {item.settings.releaseMode} · {item.thumbnailName || "auto-cover.svg"}
                          </span>
                        </span>
                      </span>
                      <span className={`shrink-0 text-right ${muted}`}>
                        {formatDate(item.updatedAt)}
                        <span className="mt-1 block text-xs text-ember-500">打开</span>
                      </span>
                    </button>
                  ))}
                  {localDrafts.length === 0 && (
                    <div className={`border px-3 py-4 text-sm ${theme === "night" ? "border-[#35463f]" : "border-clay-900/15"} ${muted}`}>
                      暂无本地草稿。点击“创建短剧草稿”后会自动沉淀在这里。
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>

        <section className={`grid gap-5 pb-5 xl:grid-cols-[0.9fr_1.1fr_0.9fr]`}>
          <Panel title="故事梗概" panelClass={panel}>
            <input
              value={draft.title}
              onChange={(event) => updateDraftTitle(event.target.value)}
              className={`mb-3 h-11 w-full border px-3 text-lg font-semibold outline-none ${inputClass}`}
            />
            <textarea
              value={draft.summary}
              onChange={(event) => setDraft((prev) => ({ ...prev, summary: event.target.value }))}
              className={`h-[260px] w-full resize-none border p-3 leading-7 outline-none ${inputClass}`}
            />
          </Panel>

          <Panel title="分集大纲" panelClass={panel}>
            <div className="max-h-[360px] space-y-3 overflow-auto pr-1">
              {draft.episodes.map((episode, index) => (
                <div key={index} className={`border p-3 ${theme === "night" ? "border-[#35463f] bg-[#0f1514]" : "border-clay-900/15 bg-white/60"}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="inline-flex h-8 w-10 items-center justify-center bg-ember-500 text-sm font-semibold text-cream-50">{episode.episode_number}</span>
                    <input
                      value={episode.title}
                      onChange={(event) => updateEpisode(index, { title: event.target.value })}
                      className={`h-9 flex-1 border px-2 outline-none ${inputClass}`}
                    />
                  </div>
                  <textarea
                    value={episode.script_content || ""}
                    onChange={(event) => updateEpisode(index, { script_content: event.target.value, description: event.target.value.slice(0, 180) })}
                    className={`h-24 w-full resize-none border p-2 text-sm leading-6 outline-none ${inputClass}`}
                  />
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="人物卡" panelClass={panel}>
            <div className="max-h-[360px] space-y-3 overflow-auto pr-1">
              {draft.characters.map((character, index) => (
                <div key={index} className={`border p-3 ${theme === "night" ? "border-[#35463f] bg-[#0f1514]" : "border-clay-900/15 bg-white/60"}`}>
                  <div className="mb-2 grid grid-cols-[1fr_1fr] gap-2">
                    <input
                      value={character.name}
                      onChange={(event) => updateCharacter(index, { name: event.target.value })}
                      className={`h-9 border px-2 font-semibold outline-none ${inputClass}`}
                    />
                    <input
                      value={character.role || ""}
                      onChange={(event) => updateCharacter(index, { role: event.target.value })}
                      className={`h-9 border px-2 outline-none ${inputClass}`}
                    />
                  </div>
                  <textarea
                    value={character.description || ""}
                    onChange={(event) => updateCharacter(index, { description: event.target.value })}
                    className={`h-20 w-full resize-none border p-2 text-sm leading-6 outline-none ${inputClass}`}
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    characters: [
                      ...prev.characters,
                      { name: "新角色", role: "角色", description: "", personality: "", appearance: "", sort_order: prev.characters.length },
                    ],
                  }))
                }
                className="inline-flex items-center gap-2 border border-current/20 px-3 py-2 text-sm hover:bg-current/5"
              >
                <i className="fa-solid fa-plus" />
                新增角色
              </button>
            </div>
          </Panel>
        </section>

        <section className={`mb-2 border ${panel}`}>
          <div className="flex items-center justify-between border-b border-current/10 px-5 py-4">
            <h2 className="font-serif text-2xl">分支覆盖层</h2>
            <span className={`text-sm ${muted}`}>复用同剧本文字缓存，画风变化时重绘图像</span>
          </div>
          <div className="grid gap-3 p-5 md:grid-cols-3">
            {draft.branches.map((branch, index) => (
              <div key={branch.branchId} className={`border p-4 ${theme === "night" ? "border-[#35463f] bg-[#0f1514]" : "border-clay-900/15 bg-white/60"}`}>
                <input
                  value={branch.choiceText}
                  onChange={(event) => updateBranch(index, { choiceText: event.target.value })}
                  className={`mb-3 h-10 w-full border px-3 font-semibold outline-none ${inputClass}`}
                />
                <textarea
                  value={branch.direction}
                  onChange={(event) => updateBranch(index, { direction: event.target.value })}
                  className={`h-24 w-full resize-none border p-3 text-sm leading-6 outline-none ${inputClass}`}
                />
                <div className={`mt-3 flex items-center justify-between text-xs ${muted}`}>
                  <span>父级第 {branch.parentEpisode} 集</span>
                  <span>{branch.cachePolicy === "reuse-story-cache" ? "复用剧情缓存" : "新剧情缓存"}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function SelectBox({
  label,
  value,
  options,
  onChange,
  inputClass,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  inputClass: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs opacity-70">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`h-11 w-full border px-3 outline-none ${inputClass}`}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Panel({
  title,
  panelClass,
  children,
}: {
  title: string;
  panelClass: string;
  children: ReactNode;
}) {
  return (
    <div className={`min-w-0 border ${panelClass}`}>
      <div className="border-b border-current/10 px-5 py-4">
        <h2 className="font-serif text-2xl">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
