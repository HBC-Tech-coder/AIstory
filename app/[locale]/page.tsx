"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import {
  ART_STYLES,
  GENDERS,
  PACINGS,
  PLOT_STYLES,
  STYLE_MAP,
  type Gender,
} from "@/lib/options";
import { buildFallbackCards, type FeaturedCard, type StoryContent } from "@/lib/featuredStories";
import { readStoredTtsConfig } from "@/lib/clientTtsConfig";
import {
  SettingsModal,
  readStoredBranchPrefetchDepth,
  readStoredPlayerName,
  readStoredVisionClick,
} from "@/components/SettingsModal";
import { analyzeImageDataUrl } from "@infiplot/ai-client";
import { readStoredModelConfig, resolveEngineConfig } from "@/lib/clientModelConfig";
import { STYLE_EXTRACTION_PROMPT } from "@/lib/styleExtraction";
import { STORY_SHARE_STORAGE_KEY, parseStoryShareDoc } from "@/lib/storyShare";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { isAuthed } from "@/lib/authResume";
import {
  AuthModal,
  type AuthRequirement,
} from "@/components/AuthModal";
import { AuthRequiredError } from "@/lib/engineClient";
import { UserChip } from "@/components/UserChip";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MobileDreamFrameApp } from "@/components/MobileDreamFrameApp";
import { CreditBalance } from "@/components/CreditBalance";
import { PlatformGenerationNotice } from "@/components/PlatformGenerationNotice";
import { UsageDisclosureNote } from "@/components/UsageDisclosureNote";
import { WorldModelDemoShowcase } from "@/components/WorldModelDemoShowcase";
import { useI18n } from "@/lib/i18n/client";
import { useLocalePath } from "@/lib/i18n/hooks";
import { loadStoryList } from "@/lib/clientStoryPersistence";
import type { StoryMeta } from "@/lib/persistence/types";
import { coerceEpoch } from "@/lib/persistence/types";
import type {
  BranchPrefetchDepth,
  ParseStyleImageResponse,
} from "@infiplot/types";

// Option value → i18n key suffix maps. The Chinese strings from lib/options.ts
// stay as the underlying identifier (so analytics unions and STYLE_MAP keys
// stay byte-stable); we look up the display label per locale at render time.
const GENDER_KEYS: Record<Gender, "male" | "female" | "x"> = {
  男性向: "male",
  女性向: "female",
  X: "x",
};

const ART_STYLE_KEYS: Record<string, string> = {
  "自动": "auto",
  "自定义风格": "custom",
  "京阿尼": "kyoani",
  "新海诚": "shinkai",
  "吉卜力": "ghibli",
  "黑白漫画": "manga",
  "真实": "realistic",
  "3D 动画": "3d",
  "水墨": "ink",
  "仙侠玄幻": "xianxia",
  "浮世绘": "ukiyoe",
  "敦煌壁画": "dunhuang",
  "古典油画": "oil",
  "莫奈": "monet",
  "水彩": "watercolor",
  "细密画": "miniature",
  "镶嵌画": "mosaic",
  "彩绘玻璃": "stainedGlass",
  "赛博朋克": "cyberpunk",
  "蒸汽朋克": "steampunk",
  "哥特": "gothic",
  "废土": "wasteland",
  "暗黑童话": "darkFairytale",
  "都市幻想": "urbanFantasy",
  "像素风": "pixel",
  "蒸汽波": "vaporwave",
  "矢量插画": "vector",
  "低多边形": "lowpoly",
  "波普艺术": "popart",
  "故障艺术": "glitch",
  "彩铅": "pencil",
  "手绘素描": "sketch",
  "剪纸艺术": "papercut",
  "儿童绘本": "children",
  "儿童涂鸦": "crayon",
  "黏土手工": "clay",
};

const PLOT_STYLE_KEYS: Record<string, string> = {
  "平铺直叙": "straightforward",
  "多线转折": "twist",
  "悬疑烧脑": "suspense",
  "治愈日常": "healing",
};

const PACING_KEYS: Record<string, string> = {
  "慢热细腻": "slow",
  "紧凑爽快": "fast",
};

const VOICE_KEYS: Record<string, string> = {
  "关闭": "off",
  "开启": "on",
};

const AISTORY_THEME_STORAGE_KEY = "aistory:theme";

/* ============================================================================
   AIstory · 首页（编辑式视觉风格 · 居中构图，呼应低保真原型）
   - 顶部 Header：左上角衬线 wordmark logo
   - Hero 控制区（居中）：标题 / prompt 输入框 + 开始 / 5 个类别选择器
   - 统一瀑布流（居中定宽）：7 张主推 + 16 张画廊，按性向整体 crossfade 切换
   - 项目介绍（题跋式排版）
   ========================================================================== */


// EXAMPLE_PHRASES is now sourced from i18n (home.examples.{male,female,x}).
// The Chinese values below are kept as gender identifiers only — they're the
// underlying session value and flow into analytics as a stable literal union.

type Opt = {
  label: string;
  items: string[];
  defaultIndex?: number;
  modal?: boolean;
  // i18n key suffixes — used to render localized display labels for each item.
  itemKey: string;
  labelKey: string;
};

const OPTS: Opt[] = [
  { label: "性向", items: [...GENDERS], labelKey: "home.options.gender", itemKey: "home.genders" },
  { label: "绘画风格", modal: true, items: [...ART_STYLES], labelKey: "home.options.artStyle", itemKey: "home.artStyles" },
  { label: "剧情风格", items: [...PLOT_STYLES], defaultIndex: 1, labelKey: "home.options.plotStyle", itemKey: "home.plotStyles" },
  { label: "语音配音", items: ["关闭", "开启"], defaultIndex: 1, labelKey: "home.options.voice", itemKey: "home.voiceOptions" },
  { label: "内容节奏", items: [...PACINGS], defaultIndex: 1, labelKey: "home.options.pacing", itemKey: "home.pacings" },
];


type StoriesI18n = { male: StoryContent[]; female: StoryContent[] };

async function loadStoriesI18n(locale: string): Promise<StoriesI18n | null> {
  if (locale === "zh-CN") return null;
  try {
    const mod = locale === "en"
      ? await import("@/lib/i18n/stories-en.json")
      : locale === "ja"
        ? await import("@/lib/i18n/stories-ja.json")
        : null;
    return mod ? (mod.default as StoriesI18n) : null;
  } catch { return null; }
}

function localizeCards(cards: FeaturedCard[], i18n: StoriesI18n | null): FeaturedCard[] {
  if (!i18n) return cards;
  return cards.map((card) => {
    const m = card.id.match(/^([mf])(\d+)$/);
    if (!m) return card;
    const gender = m[1] === "f" ? "female" : "male";
    const idx = parseInt(m[2]!, 10);
    const translated = i18n[gender]?.[idx];
    if (!translated) return card;
    return { ...card, title: translated.title, outline: translated.outline };
  });
}

/* ---------- typewriter ---------- */

// 父组件持有当前 phrase 的索引（这样 start() 不输入时能用当前闪动的那句
// 作为默认故事种子，所见即所玩）。Typewriter 只负责单句的打字+删除动画，
// 删完后通过 onCycle 回调让父组件切到下一句。
function Typewriter({
  phrase,
  onCycle,
}: {
  phrase: string;
  onCycle: () => void;
}) {
  const [txt, setTxt] = useState("");
  const onCycleRef = useRef(onCycle);
  useEffect(() => {
    onCycleRef.current = onCycle;
  });

  useEffect(() => {
    let i = 0;
    let del = false;
    let timer: ReturnType<typeof setTimeout>;
    setTxt("");
    const tick = () => {
      if (!del) {
        i++;
        setTxt(phrase.slice(0, i));
        if (i >= phrase.length) {
          del = true;
          timer = setTimeout(tick, 1700);
          return;
        }
        timer = setTimeout(tick, 70);
      } else {
        i--;
        setTxt(phrase.slice(0, i));
        if (i <= 0) {
          timer = setTimeout(() => onCycleRef.current(), 450);
          return;
        }
        timer = setTimeout(tick, 28);
      }
    };
    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, [phrase]);

  const visibleText = txt || phrase;

  return (
    <>
      <span>{visibleText}</span>
      <span className="inline-block w-px h-[1.05em] bg-clay-400 ml-0.5 align-middle animate-pulse" />
    </>
  );
}

/* ---------- masonry story card ---------- */

function StoryCard({
  title,
  outline,
  image,
  assetStatus,
  onClick,
}: {
  title: string;
  outline: string;
  image: string;
  assetStatus?: "ready" | "pending";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ aspectRatio: "4 / 5" }}
      className="group relative block w-full overflow-hidden rounded-sm border border-clay-900/10 bg-cream-100 text-left transition-transform duration-300 ease-out hover:-translate-y-1 hover:shadow-md hover:shadow-clay-900/5"
    >
      <img
        src={image}
        alt={title}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
      />
      {assetStatus === "pending" && (
        <span className="absolute left-3 top-3 border border-blue-300/40 bg-black/65 px-2.5 py-1 text-[10px] tracking-[0.14em] text-blue-100 xl:text-[11px]">
          画面待生成
        </span>
      )}
      {/* hover 浮层：展示故事标题与大纲内容 */}
      <div
        className="absolute inset-0 opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100 flex flex-col justify-end p-4 md:p-5"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.45) 45%, rgba(0,0,0,0) 100%)",
        }}
      >
        <h4 className="font-serif text-cream-50 text-base md:text-lg xl:text-[20px] leading-snug mb-1 [text-shadow:0_1px_8px_rgba(20,10,4,0.7)]">
          {title}
        </h4>
        <p className="font-serif italic text-cream-50/95 text-xs md:text-[13px] xl:text-[14px] leading-relaxed line-clamp-4 [text-shadow:0_1px_6px_rgba(20,10,4,0.6)]">
          {outline}
        </p>
      </div>
    </button>
  );
}

function getStoryDisplayTitle(story: StoryMeta) {
  const title = (story.worldSetting || "").trim();
  if (!title) return "未命名互动剧";
  return title.length > 28 ? `${title.slice(0, 28)}...` : title;
}

function formatHomeStoryTime(story: StoryMeta, locale: string) {
  const ms = coerceEpoch(story.updatedAt, NaN);
  if (!Number.isFinite(ms)) return "刚刚";
  const diffDays = Math.floor((Date.now() - ms) / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  return new Date(ms).toLocaleDateString(locale, { month: "2-digit", day: "2-digit" });
}

/* ---------- collapsible category selector ---------- */

function CategorySelect({
  label,
  items,
  itemLabels,
  value,
  open,
  onToggle,
  onPick,
}: {
  label: string;
  items: string[];
  itemLabels: string[];
  value: number;
  open: boolean;
  onToggle: () => void;
  onPick: (i: number) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="group flex items-center gap-2.5 pb-1.5 border-b border-clay-900/20 hover:border-clay-900/45 transition-colors"
      >
        <span className="text-[10px] smallcaps text-clay-500 xl:text-[11px]">{label}</span>
        <span className={"font-serif text-base md:text-lg xl:text-xl " + (open ? "text-ember-500" : "text-clay-900")}>
          {itemLabels[value] ?? items[value]}
        </span>
        <i
          className={
            "fa-solid fa-chevron-down text-[9px] text-clay-400 transition-transform duration-200 " +
            (open ? "rotate-180" : "")
          }
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-30 min-w-[150px] max-w-[calc(100vw-2rem)] py-1.5 bg-cream-50 border border-clay-900/15 rounded-sm shadow-xl shadow-clay-900/10">
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(i)}
              className={
                "flex w-full items-center justify-between gap-3 px-4 py-1.5 text-sm font-serif transition-colors hover:bg-cream-100 xl:text-[15.5px] xl:leading-[22px] " +
                (i === value ? "text-ember-500" : "text-clay-700")
              }
            >
              {itemLabels[i] ?? it}
              {i === value && <i className="fa-solid fa-check text-[10px]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- style picker modal ---------- */

const PENDING_START_KEY = "infiplot:pending-start";
const PENDING_PARSE_KEY = "infiplot:pending-parse";

function parseVisionJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]!);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {
        // Fall through to raw-text compatibility.
      }
    }
    return { stylePrompt: raw };
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeImageAnalysis(raw: Record<string, unknown>): ParseStyleImageResponse {
  const stylePrompt = optionalText(raw.stylePrompt) ?? "";
  const props = Array.isArray(raw.props)
    ? raw.props
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          label: optionalText(item.label),
          face: optionalText(item.face),
          clothing: optionalText(item.clothing),
          expression: optionalText(item.expression),
          pose: optionalText(item.pose),
          relationship: optionalText(item.relationship),
        }))
        .filter((item) => Object.values(item).some(Boolean))
    : undefined;

  return {
    stylePrompt,
    storySeed: optionalText(raw.storySeed),
    subjectPrompt: optionalText(raw.subjectPrompt),
    characterPrompt: optionalText(raw.characterPrompt),
    scenePrompt: optionalText(raw.scenePrompt),
    setting: optionalText(raw.setting),
    mood: optionalText(raw.mood),
    props: props?.length ? props : undefined,
    characters: characters?.length ? characters : undefined,
  };
}

async function resizeImageToDataUrl(file: File, maxDim = 768): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Cannot read image file"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Cannot decode image"));
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  let out = canvas.toDataURL("image/webp", 0.85);
  if (!out.startsWith("data:image/webp")) {
    out = canvas.toDataURL("image/jpeg", 0.85);
  }
  return out;
}

// Shared by the StyleModal uploader, homepage image-start uploader, and the
// post-login resume path. BYO model config runs fully in-browser; otherwise
// the server route uses the configured vision provider.
async function analyzeStoryImageFromDataUrl(resized: string): Promise<ParseStyleImageResponse> {
  const modelCfg = readStoredModelConfig();
  if (modelCfg) {
    const config = resolveEngineConfig(modelCfg, null);
    const raw = await analyzeImageDataUrl(
      config.vision,
      resized,
      STYLE_EXTRACTION_PROMPT,
    );
    return normalizeImageAnalysis(parseVisionJson(raw));
  }
  const r = await fetch("/api/parse-style-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": `generation:${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ imageDataUrl: resized }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      error?: string;
      quote?: AuthRequiredError["quote"];
    };
    if (r.status === 401) {
      throw new AuthRequiredError(data.error, data.quote);
    }
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const data = (await r.json()) as Record<string, unknown>;
  return normalizeImageAnalysis(data);
}

async function extractStylePromptFromImage(resized: string): Promise<string> {
  const analysis = await analyzeStoryImageFromDataUrl(resized);
  return analysis.stylePrompt.trim();
}

function buildImageStorySeed(analysis: ParseStyleImageResponse): string {
  const characters = (analysis.characters ?? [])
    .map((c, i) => {
      const parts = [
        c.label ?? `角色${i + 1}`,
        c.face && `面部/发型：${c.face}`,
        c.clothing && `穿着：${c.clothing}`,
        c.expression && `表情：${c.expression}`,
        c.pose && `动作：${c.pose}`,
        c.relationship && `关系：${c.relationship}`,
      ].filter(Boolean);
      return parts.join("；");
    })
    .join("\n");

  return [
    "【上传图片识别出的开局锚点】",
    analysis.storySeed,
    analysis.setting && `场景：${analysis.setting}`,
    analysis.mood && `情绪：${analysis.mood}`,
    analysis.props?.length ? `关键道具：${analysis.props.join("、")}` : undefined,
    characters && `人物与关系：\n${characters}`,
    analysis.characterPrompt && `Character continuity: ${analysis.characterPrompt}`,
    analysis.scenePrompt && `Scene continuity: ${analysis.scenePrompt}`,
  ].filter(Boolean).join("\n");
}

function mergeImageStyleGuide(base: string, analysis: ParseStyleImageResponse): string {
  const anchors = [
    analysis.stylePrompt,
    analysis.subjectPrompt && `REFERENCE SUBJECT LOCK: ${analysis.subjectPrompt}`,
    analysis.characterPrompt && `CHARACTER LOCK: ${analysis.characterPrompt}`,
    analysis.scenePrompt && `SCENE LOCK: ${analysis.scenePrompt}`,
    "Keep later generated frames visually consistent with the uploaded reference image unless the story explicitly changes time, outfit, location, or emotional state.",
  ].filter(Boolean).join("\n");
  if (!anchors.trim()) return base;
  if (!base || base === "auto") return anchors;
  return `${base}\n\n${anchors}`;
}

function StyleModal({
  items,
  itemLabels,
  value,
  onPick,
  onClose,
  customStyleGuide,
  setCustomStyleGuide,
  customStyleRefImage,
  setCustomStyleRefImage,
  onRequireAuth,
}: {
  items: string[];
  itemLabels: string[];
  value: number;
  onPick: (i: number) => void;
  onClose: () => void;
  customStyleGuide: string;
  setCustomStyleGuide: (s: string) => void;
  customStyleRefImage: string;
  setCustomStyleRefImage: (s: string) => void;
  onRequireAuth: (requirement?: AuthRequirement) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(false);
  const [view, setView] = useState<"grid" | "custom">("grid");
  const [draft, setDraft] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbV = "v6";
  const STYLE_THUMB: Record<string, string> = {
    "自动": `/home/styles/auto.webp?${thumbV}`,
    "自定义风格": `/home/styles/custom.webp?${thumbV}`,
    "京阿尼": `/home/styles/kyoani.webp?${thumbV}`,
    "新海诚": `/home/styles/shinkai.webp?${thumbV}`,
    "吉卜力": `/home/styles/ghibli.webp?${thumbV}`,
    "3D 动画": `/home/styles/3d.webp?${thumbV}`,
    "赛博朋克": `/home/styles/cyberpunk.webp?${thumbV}`,
    "哥特": `/home/styles/gothic.webp?${thumbV}`,
    "废土": `/home/styles/wasteland.webp?${thumbV}`,
    "像素风": `/home/styles/pixel.webp?${thumbV}`,
    "真实": `/home/styles/real.webp?${thumbV}`,
    "古典油画": `/home/styles/oil.webp?${thumbV}`,
    "莫奈": `/home/styles/monet.webp?${thumbV}`,
    "水彩": `/home/styles/watercolor.webp?${thumbV}`,
    "水墨": `/home/styles/ink.webp?${thumbV}`,
    "浮世绘": `/home/styles/ukiyoe.webp?${thumbV}`,
    "彩铅": `/home/styles/pencil.webp?${thumbV}`,
    "手绘素描": `/home/styles/sketch.webp?${thumbV}`,
    "黑白漫画": `/home/styles/manga.webp?${thumbV}`,
    "儿童绘本": `/home/styles/children.webp?${thumbV}`,
    "儿童涂鸦": `/home/styles/crayon.webp?${thumbV}`,
    "黏土手工": `/home/styles/clay.webp?${thumbV}`,
    "敦煌壁画": `/home/styles/dunhuang.webp?${thumbV}`,
    "细密画": `/home/styles/miniature.webp?${thumbV}`,
    "镶嵌画": `/home/styles/mosaic.webp?${thumbV}`,
    "彩绘玻璃": `/home/styles/stainedglass.webp?${thumbV}`,
    "蒸汽波": `/home/styles/vaporwave.webp?${thumbV}`,
    "矢量插画": `/home/styles/vector.webp?${thumbV}`,
    "低多边形": `/home/styles/lowpoly.webp?${thumbV}`,
    "波普艺术": `/home/styles/popart.webp?${thumbV}`,
    "故障艺术": `/home/styles/glitch.webp?${thumbV}`,
    "剪纸艺术": `/home/styles/papercut.webp?${thumbV}`,
    "蒸汽朋克": `/home/styles/steampunk.webp?${thumbV}`,
    "仙侠玄幻": `/home/styles/xianxia.webp?${thumbV}`,
    "暗黑童话": `/home/styles/darkfairytale.webp?${thumbV}`,
    "都市幻想": `/home/styles/urbanfantasy.webp?${thumbV}`,
  };
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const closeRef = useRef<() => void>(null);
  const close = () => {
    setShown(false);
    setTimeout(onClose, 280);
  };
  closeRef.current = close;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current?.(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);
  const customIdx = items.indexOf("自定义风格");
  const openCustomView = (prefill: string) => {
    setDraft(prefill);
    setView("custom");
  };
  const saveCustom = () => {
    const t = draft.trim();
    if (!t) return;
    setCustomStyleGuide(t);
    if (customIdx >= 0) onPick(customIdx);
    close();
  };

  const resizeImageToDataUrl = async (file: File): Promise<string> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error(t("home.styleModal.fileReadError")));
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(t("home.styleModal.imageDecodeError")));
      i.src = dataUrl;
    });
    const MAX_DIM = 512;
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    let out = canvas.toDataURL("image/webp", 0.85);
    if (!out.startsWith("data:image/webp")) {
      out = canvas.toDataURL("image/jpeg", 0.85);
    }
    return out;
  };

  const handleUploadStyleImage = async (file: File) => {
    setParseError(null);
    if (!file.type.startsWith("image/")) {
      setParseError(t("home.styleModal.uploadError"));
      return;
    }
    setParsing(true);
    try {
      const resized = await resizeImageToDataUrl(file);
      const stylePrompt = await extractStylePromptFromImage(resized);
      if (!stylePrompt) throw new Error(t("home.styleModal.visionError"));
      setDraft(stylePrompt);
      setCustomStyleRefImage(resized);
      track("style_image_upload", { ok: true });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        try {
          const resized = await resizeImageToDataUrl(file);
          sessionStorage.setItem(PENDING_PARSE_KEY, resized);
        } catch {
          /* user can re-upload after login */
        }
        onRequireAuth({ message: err.message, quote: err.quote });
        return;
      }
      const msg = err instanceof Error ? err.message : t("home.styleModal.parseError");
      setParseError(msg);
      track("style_image_upload", { ok: false });
    } finally {
      setParsing(false);
    }
  };

  const removeStyleRefImage = () => {
    setCustomStyleRefImage("");
    setParseError(null);
  };

  const q2 = q.trim();
  const list = items.map((name, i) => ({ name, label: itemLabels[i] ?? name, i })).filter((x) => {
    if (!q2) return true;
    const needle = q2.toLowerCase();
    return x.name.toLowerCase().includes(needle) || x.label.toLowerCase().includes(needle);
  });
  return (
    <div
      onMouseDown={close}
      className={
        "fixed inset-0 z-[60] flex items-center justify-center p-6 md:p-10 transition-all duration-300 " +
        (shown ? "bg-clay-900/30 backdrop-blur-md" : "bg-clay-900/0 backdrop-blur-0")
      }
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={
          "flex w-[1400px] max-w-[94vw] h-[86vh] flex-col overflow-hidden rounded-sm border border-clay-900/15 bg-cream-50 shadow-2xl shadow-clay-900/25 transition-all duration-300 " +
          (shown ? "opacity-100 scale-100" : "opacity-0 scale-95")
        }
      >
        <div className="flex items-center gap-3 md:gap-5 px-5 md:px-8 py-4 md:py-5 border-b border-clay-900/10">
          {view === "custom" ? (
            <div className="flex flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() => setView("grid")}
                className="flex h-8 w-8 items-center justify-center rounded-sm text-clay-500 hover:bg-cream-100 hover:text-clay-900 transition-colors"
                aria-label={t("home.ui.back")}
              >
                <i className="fa-solid fa-arrow-left text-sm" />
              </button>
              <span className="font-serif text-xl md:text-2xl text-clay-900">{t("home.styleModal.customTitle")}</span>
            </div>
          ) : (
            <>
              <div className="flex flex-1 flex-col">
                <span className="font-serif text-xl md:text-2xl text-clay-900">{t("home.styleModal.title")}</span>
                <span className="hidden md:block text-[11px] text-clay-500 mt-1 tracking-wide">
                  {t("home.styleModal.subtitle")}
                </span>
              </div>
              <div className="relative w-[150px] max-w-[40vw] md:w-[280px] md:max-w-[46vw]">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("home.ui.searchPlaceholder")}
                  autoFocus
                  className="h-10 w-full rounded-sm border border-clay-900/15 bg-cream-100 pl-4 pr-10 font-sans text-sm text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
                />
                <i className="fa-solid fa-magnifying-glass absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-clay-400 pointer-events-none" />
              </div>
            </>
          )}
          <button
            type="button"
            onClick={close}
            aria-label={t("home.ui.close")}
            className="text-xl leading-none text-clay-500 hover:text-clay-900 transition-colors"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        {view === "custom" ? (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-6 md:px-8">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUploadStyleImage(f);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              rows={6}
              placeholder={t("home.styleModal.customPlaceholder")}
              className="w-full flex-1 resize-y rounded-sm border border-clay-900/15 bg-cream-50 px-3 py-2.5 font-sans text-[13px] leading-relaxed text-clay-900 outline-none transition-colors focus:border-ember-500 placeholder:text-clay-400"
            />
            {parseError && (
              <span className="font-sans text-[11px] text-rose-500">
                <i className="fa-solid fa-circle-exclamation mr-1" />
                {parseError}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {customStyleRefImage ? (
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={customStyleRefImage}
                    alt={t("home.styleModal.refImageAlt")}
                    className="h-8 w-8 shrink-0 rounded-sm border border-clay-900/10 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={parsing}
                    className="font-sans text-[11px] text-clay-500 hover:text-ember-500 transition-colors disabled:opacity-50"
                  >
                    {t("home.styleModal.changeImage")}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStyleRefImage()}
                    className="font-sans text-[11px] text-clay-400 hover:text-clay-900 transition-colors"
                  >
                    {t("home.styleModal.remove")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={parsing}
                  className={
                    "flex items-center gap-1.5 rounded-sm border px-3 py-1.5 font-sans text-[12px] transition-colors " +
                    (parsing
                      ? "border-clay-900/15 text-clay-400 cursor-wait"
                      : "border-clay-900/15 text-clay-700 hover:border-ember-500 hover:text-ember-500")
                  }
                >
                  {parsing ? (
                    <>
                      <i className="fa-solid fa-circle-notch fa-spin text-[11px]" />
                      {t("home.styleModal.parsing")}
                    </>
                  ) : (
                    <>
                      <i className="fa-regular fa-image text-[11px]" />
                      {t("home.styleModal.uploadImage")}
                    </>
                  )}
                </button>
              )}
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && STYLE_MAP[v]) setDraft(STYLE_MAP[v]);
                }}
                className="h-8 w-36 md:w-44 rounded-sm border border-clay-900/15 bg-cream-50 px-2 font-sans text-[12px] text-clay-700 outline-none transition-colors focus:border-ember-500"
              >
                <option value="">{t("home.styleModal.importFromPreset")}</option>
                {Object.keys(STYLE_MAP).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setView("grid")}
                className="rounded-sm border border-clay-900/15 px-4 py-1.5 font-sans text-xs text-clay-700 hover:border-clay-900/30 hover:text-clay-900 transition-colors"
              >
                {t("home.ui.cancel")}
              </button>
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={saveCustom}
                className={
                  "rounded-sm px-4 py-1.5 font-sans text-xs transition-colors " +
                  (draft.trim()
                    ? "bg-clay-900 text-cream-50 hover:bg-ember-500"
                    : "bg-clay-900/20 text-clay-500 cursor-not-allowed")
                }
              >
                {t("home.ui.saveAndSelect")}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 overflow-y-auto px-6 py-6 md:grid-cols-4 md:gap-4 md:px-8">
            {list.map(({ name, label, i }) => {
              const isCustom = name === "自定义风格";
              const thumb = STYLE_THUMB[name];
              return (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (isCustom) {
                      openCustomView(customStyleGuide);
                      return;
                    }
                    onPick(i);
                    close();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (isCustom) { openCustomView(customStyleGuide); return; }
                      onPick(i);
                      close();
                    }
                  }}
                  className={
                    "group cursor-pointer rounded-sm border transition-all outline-none focus-visible:ring-2 focus-visible:ring-ember-500 " +
                    (i === value
                      ? "border-ember-500 ring-2 ring-ember-500"
                      : "border-clay-900/12 hover:border-ember-500/50 hover:ring-2 hover:ring-ember-500/25")
                  }
                >
                  <div className="relative w-full overflow-hidden" style={{ paddingBottom: "100%" }}>
                    {thumb ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={thumb} alt={label} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <div className="absolute inset-0 bg-cream-100" />
                    )}
                  </div>
                  <span className={"block px-2 py-2 text-center font-serif text-sm " + (i === value ? "text-ember-500" : "text-clay-700")}>
                    {label}
                  </span>
                </div>
              );
            })}
            {list.length === 0 && (
              <div className="col-span-full py-12 text-center font-serif text-sm text-clay-400">
                {t("home.ui.noMatchingStyle")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- page ---------- */

export default function HomePage() {
  const router = useRouter();
  const { t, locale, tArray } = useI18n();
  const lp = useLocalePath();

  const [sel, setSel] = useState<number[]>(OPTS.map((o) => o.defaultIndex ?? 0));
  const [open, setOpen] = useState<number>(-1);
  const [styleOpen, setStyleOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [customStyleGuide, setCustomStyleGuide] = useState("");
  const [customStyleRefImage, setCustomStyleRefImage] = useState<string>("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const storyImportRef = useRef<HTMLInputElement>(null);
  const imageStoryRef = useRef<HTMLInputElement>(null);
  const [storyImportError, setStoryImportError] = useState<string | null>(null);
  const [imageStoryPreview, setImageStoryPreview] = useState("");
  const [imageStoryAnalysis, setImageStoryAnalysis] = useState<ParseStyleImageResponse | null>(null);
  const [imageStoryLoading, setImageStoryLoading] = useState(false);
  const [imageStoryError, setImageStoryError] = useState<string | null>(null);

  // 顶部使用说明默认展开；用户可收起，并随时从信息卡内恢复。
  const [hintClosed, setHintClosed] = useState(false);

  // 统一设置弹窗（通用 + 模型）：可选增强，数据只存浏览器。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "models">("general");
  const [ttsConfigured, setTtsConfigured] = useState(false);
  const [playerName, setPlayerName] = useState("");
  const [visionClickEnabled, setVisionClickEnabled] = useState(true);
  const [branchPrefetchDepth, setBranchPrefetchDepth] =
    useState<BranchPrefetchDepth>(1);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authRequirement, setAuthRequirement] =
    useState<AuthRequirement | undefined>();
  const [pendingAction, setPendingAction] = useState<"start" | null>(null);
  const [theme, setTheme] = useState<"day" | "night">("day");
  const [localStories, setLocalStories] = useState<StoryMeta[]>([]);
  const [homeNotice, setHomeNotice] = useState("");


  const styleRow = OPTS.findIndex((o) => o.modal);
  const voiceRow = OPTS.findIndex((o) => o.label === "语音配音");
  const paceRow = OPTS.findIndex((o) => o.label === "内容节奏");
  const genderIndex = sel[0] ?? 0;
  const gender = (OPTS[0]!.items[genderIndex] as Gender) ?? "男性向";
  const selectedAudioEnabled =
    OPTS[voiceRow]!.items[sel[voiceRow] ?? 1] === "开启";
  // Display labels for each option category — localized at render time. The
  // underlying `items` are kept as Chinese literal identifiers because they
  // flow into analytics unions and `STYLE_MAP` keys.
  const optItemLabels = OPTS.map((o) => {
    if (o.itemKey === "home.genders") {
      return o.items.map((v) => t(`home.genders.${GENDER_KEYS[v as Gender] ?? "male"}`));
    }
    if (o.itemKey === "home.artStyles") {
      return o.items.map((v) => {
        const k = ART_STYLE_KEYS[v];
        return k ? t(`home.artStyles.${k}`) : v;
      });
    }
    if (o.itemKey === "home.plotStyles") {
      return o.items.map((v) => {
        const k = PLOT_STYLE_KEYS[v];
        return k ? t(`home.plotStyles.${k}`) : v;
      });
    }
    if (o.itemKey === "home.pacings") {
      return o.items.map((v) => {
        const k = PACING_KEYS[v];
        return k ? t(`home.pacings.${k}`) : v;
      });
    }
    if (o.itemKey === "home.voiceOptions") {
      return o.items.map((v) => {
        const k = VOICE_KEYS[v];
        return k ? t(`home.voiceOptions.${k}`) : v;
      });
    }
    return o.items;
  });
  const optLabels = OPTS.map((o) => t(o.labelKey));
  const phrasesKey = GENDER_KEYS[gender] ?? "male";
  const phrases = tArray(`home.examples.${phrasesKey}`);
  // 当前 Typewriter 闪动到第几句——start() 空输入时会拿它做默认故事种子，
  // 实现「所见即所玩」。切性向时重置，否则索引可能越界。
  const [phraseIdx, setPhraseIdx] = useState(0);
  useEffect(() => {
    setPhraseIdx(0);
  }, [gender]);

  // 性向切换时，整片瀑布流做淡出→换图→淡入的过渡（而非瞬切）。
  const [galleryGender, setGalleryGender] = useState<Gender>(gender);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (gender === galleryGender) return;
    setFading(true);
    const t = setTimeout(() => {
      setGalleryGender(gender);
      setFading(false);
    }, 280);
    return () => clearTimeout(t);
  }, [gender, galleryGender]);

  // Featured 卡片来自硬编码 STORIES 的本地化结果。惰性初始化确保首屏即有内容
  //（SSR + hydration 一致），locale/gender 变化时重算本地化。
  const storiesI18nRef = useRef<{ locale: string; data: StoriesI18n | null }>({ locale: "", data: null });
  const [featuredCards, setFeaturedCards] = useState<FeaturedCard[]>(() =>
    buildFallbackCards(galleryGender),
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (storiesI18nRef.current.locale !== locale) {
        storiesI18nRef.current = { locale, data: await loadStoriesI18n(locale) };
      }
      const i18n = storiesI18nRef.current.data;
      if (cancelled) return;
      // Featured cards come from the local template manifest, then localize for
      // the active locale. The D1 /api/stories/featured route was removed — it
      // had no real data and always degraded to this same static path.
      setFeaturedCards(localizeCards(buildFallbackCards(galleryGender), i18n));
    })();
    return () => { cancelled = true; };
  }, [galleryGender, locale]);

  /* close any open dropdown on outside click */
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.("[data-cat]")) setOpen(-1);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem("infiplot:hintClosed") === "1") setHintClosed(true);
      const storedTheme = localStorage.getItem(AISTORY_THEME_STORAGE_KEY);
      if (storedTheme === "night" || storedTheme === "day") setTheme(storedTheme);
    } catch {
      /* ignore */
    }
  }, []);

  // 启动时回填配置状态——读 localStorage 判断用户是否已存过 Key / 名字。
  useEffect(() => {
    setTtsConfigured(readStoredTtsConfig() != null);
    setPlayerName(readStoredPlayerName());
    setVisionClickEnabled(readStoredVisionClick());
    setBranchPrefetchDepth(readStoredBranchPrefetchDepth());
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadStoryList()
      .then((items) => {
        if (!cancelled) setLocalStories(items);
      })
      .catch(() => {
        if (!cancelled) setLocalStories([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!homeNotice) return;
    const timer = window.setTimeout(() => setHomeNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [homeNotice]);

  // 输入框随内容自动增高：长文本整段可见（打字与点卡片填入都覆盖）。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  const closeHint = () => {
    setHintClosed(true);
    try {
      localStorage.setItem("infiplot:hintClosed", "1");
    } catch {
      /* ignore */
    }
  };

  const openHint = () => {
    setHintClosed(false);
    try {
      localStorage.removeItem("infiplot:hintClosed");
    } catch {
      /* ignore */
    }
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

  // Backward compatibility for pre-phone-login OAuth resume snapshots.
  const [autoStartPending, setAutoStartPending] = useState(false);

  const resumePendingParse = async () => {
    const resized = sessionStorage.getItem(PENDING_PARSE_KEY);
    if (!resized) return;
    sessionStorage.removeItem(PENDING_PARSE_KEY);
    try {
      const stylePrompt = await extractStylePromptFromImage(resized);
      if (!stylePrompt) return;
      setCustomStyleGuide(stylePrompt);
      setCustomStyleRefImage(resized);
      const customIdx = ART_STYLES.indexOf("自定义风格");
      if (styleRow >= 0 && customIdx >= 0) {
        setSel((s) => s.map((v, j) => (j === styleRow ? customIdx : v)));
      }
      track("style_image_upload", { ok: true });
    } catch {
      /* resume parse failed — stay silent, user can re-upload */
    }
  };

  const resumePendingStart = () => {
    const raw = sessionStorage.getItem(PENDING_START_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_START_KEY);
    try {
      const snap = JSON.parse(raw) as {
        prompt?: string;
        sel?: number[];
        customStyleGuide?: string;
        customStyleRefImage?: string;
        imageStoryPreview?: string;
        imageStoryAnalysis?: ParseStyleImageResponse | null;
        playerName?: string;
      };
      setPrompt(snap.prompt ?? "");
      if (Array.isArray(snap.sel)) setSel(snap.sel);
      setCustomStyleGuide(snap.customStyleGuide ?? "");
      setCustomStyleRefImage(snap.customStyleRefImage ?? "");
      setImageStoryPreview(snap.imageStoryPreview ?? "");
      setImageStoryAnalysis(snap.imageStoryAnalysis ?? null);
      if (snap.playerName) setPlayerName(snap.playerName);
      // Defer start() to the next render so it reads the restored state.
      setAutoStartPending(true);
    } catch {
      /* corrupt snapshot — ignore */
    }
  };

  // Consume an older persisted login snapshot once, then remove it.
  useEffect(() => {
    if (!AUTH_ENABLED) return;
    const hasStart = sessionStorage.getItem(PENDING_START_KEY) !== null;
    const hasParse = sessionStorage.getItem(PENDING_PARSE_KEY) !== null;
    if (!hasStart && !hasParse) return;
    let cancelled = false;
    void (async () => {
      // Gate BOTH snapshots on auth: a stale leftover from an abandoned login
      // must not resurrect a half-flow. The parse key stores a raw data URL
      // with its own restore path (resumePendingParse), so both are gated
      // manually here rather than via consumeResumeSnapshot.
      if (!(await isAuthed())) {
        sessionStorage.removeItem(PENDING_START_KEY);
        sessionStorage.removeItem(PENDING_PARSE_KEY);
        return;
      }
      if (cancelled) return;
      await resumePendingParse();
      resumePendingStart();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run the resumed start() only after restored form state has committed.
  useEffect(() => {
    if (!autoStartPending) return;
    setAutoStartPending(false);
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartPending]);

  const start = async () => {
    // 空输入时落回 Typewriter 当前闪动的示例——用户看到啥就玩啥，
    // 不会再出现「点开始 → 剧情和占位文字毫无关系」的体验断层。
    const typedPrompt = prompt.trim();
    const imageSeed = imageStoryAnalysis ? buildImageStorySeed(imageStoryAnalysis) : "";
    const typedPromptIsGeneratedSeed =
      Boolean(imageStoryAnalysis?.storySeed?.trim()) &&
      typedPrompt === imageStoryAnalysis?.storySeed?.trim();
    const userPrompt =
      [
        imageSeed,
        typedPrompt && !typedPromptIsGeneratedSeed ? `【用户文字指引】\n${typedPrompt}` : "",
      ].filter(Boolean).join("\n\n") ||
      (phrases[phraseIdx] ?? "").trim();
    const artStyle = ART_STYLES[sel[1] ?? 0] ?? "自动";
    const plotStyle = PLOT_STYLES[sel[2] ?? 1] ?? "多线转折";
    const voice = OPTS[voiceRow]!.items[sel[voiceRow] ?? 1]!;
    const audioEnabled = voice === "开启";
    const pace = PACINGS[sel[paceRow] ?? 1] ?? "紧凑爽快";

    // 将 "X" 映射为 "通用性别" 供 AI 理解
    const genderForAI = gender === "X" ? "通用性别" : gender;

    // worldSetting 顺序很重要：玩家输入若存在，必须放在最前面、单独成段、
    // 用强指令包住，否则模型会把它当成夹在风格说明里的背景参考、扩写出
    // 完全无关的剧情。Architect 看 worldSetting 时第一段权重最高。
    const worldSetting = (
      userPrompt
        ? [
            `【玩家给出的故事内核 — 必须以此为剧情主线，全篇紧扣，不要偏离到其他题材】`,
            `「${userPrompt}」`,
            ``,
            `面向：${genderForAI}观众。剧情风格：${plotStyle}。内容节奏：${pace}。`,
            `请在上述故事内核之上，以极致的戏剧张力与细腻的情感起伏，为玩家编织精彩的故事分支与对话。`,
          ]
        : [
            `这是一款面向【${genderForAI}】观众的 AI 交互剧情游戏。`,
            `剧情风格：${plotStyle}。内容节奏：${pace}。`,
            `请依据上述设定，以极致的戏剧张力与细腻的情感起伏，为玩家编织精彩的故事分支与对话。`,
          ]
    ).join("\n");

    // 「自动」→ pass "auto" to the server; the engine will run a parallel
    // LLM call to pick the best style based on the story prompt.
    // 「自定义风格」→ 用用户在弹窗里填的原始 styleGuide，原样喂给 LLM；空内容时
    // 退化到默认（避免传入空字符串导致 /api/start 报缺字段）。
    const DEFAULT_STYLE = "吉卜力";
    let styleGuide: string;
    if (artStyle === "自动") {
      styleGuide = "auto";
    } else if (artStyle === "自定义风格" && customStyleGuide.trim()) {
      styleGuide = customStyleGuide.trim();
    } else {
      const effectiveStyle =
        artStyle === "自定义风格" ? DEFAULT_STYLE : artStyle;
      styleGuide = STYLE_MAP[effectiveStyle] ?? STYLE_MAP[DEFAULT_STYLE]!;
    }
    if (imageStoryAnalysis) {
      styleGuide = mergeImageStyleGuide(styleGuide, imageStoryAnalysis);
    }
    // 以图开局时，即使用户随后改了预设画风，也保留这张图作为身份/场景 reference；
    // 纯自定义画风上传也沿用同一个字段。
    const styleReferenceImage =
      imageStoryPreview ||
      (artStyle === "自定义风格" && customStyleRefImage ? customStyleRefImage : undefined);

    track("game_start", {
      source: "prompt",
      gender,
      art_style: artStyle,
      plot_style: plotStyle,
      pacing: pace,
      tts: audioEnabled,
      has_prompt: typedPrompt.length > 0,
      has_image_story: Boolean(imageStoryAnalysis),
      has_style_ref: Boolean(styleReferenceImage),
    });

    sessionStorage.setItem(
      "infiplot:custom",
      JSON.stringify({ worldSetting, styleGuide, audioEnabled, styleReferenceImage, playerName: playerName || undefined }),
    );
    router.push(lp("/play?custom=1"));
  };

  const handleImageStoryUpload = async (file: File | undefined) => {
    setImageStoryError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImageStoryError("请选择图片文件");
      return;
    }
    if (file.size > 12_000_000) {
      setImageStoryError("图片过大，请先压缩到 12MB 以内");
      return;
    }

    setImageStoryLoading(true);
    let resizedForResume = "";
    try {
      const resized = await resizeImageToDataUrl(file, 768);
      resizedForResume = resized;
      const analysis = await analyzeStoryImageFromDataUrl(resized);
      if (!analysis.stylePrompt.trim()) {
        throw new Error("视觉模型没有返回可用的画风描述");
      }

      setImageStoryPreview(resized);
      setImageStoryAnalysis(analysis);
      setCustomStyleRefImage(resized);
      setCustomStyleGuide(analysis.stylePrompt.trim());
      const customIdx = ART_STYLES.indexOf("自定义风格");
      if (styleRow >= 0 && customIdx >= 0) {
        setSel((s) => s.map((v, j) => (j === styleRow ? customIdx : v)));
      }
      if (!prompt.trim() && analysis.storySeed?.trim()) {
        setPrompt(analysis.storySeed.trim());
      }
      setHomeNotice("已识别图片开局，可补充文字后开始");
      track("image_story_upload", { ok: true, has_story_seed: Boolean(analysis.storySeed) });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        try {
          if (resizedForResume) {
            sessionStorage.setItem(PENDING_PARSE_KEY, resizedForResume);
          }
        } catch {
          /* user can re-upload after login */
        }
        setPendingAction(null);
        setAuthRequirement({ message: err.message, quote: err.quote });
        setAuthModalOpen(true);
        setImageStoryError(err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : "图片识别失败";
      setImageStoryError(msg);
      track("image_story_upload", { ok: false });
    } finally {
      setImageStoryLoading(false);
      if (imageStoryRef.current) imageStoryRef.current.value = "";
    }
  };

  const removeImageStory = () => {
    const previousPreview = imageStoryPreview;
    const previousStyle = imageStoryAnalysis?.stylePrompt.trim();
    setImageStoryPreview("");
    setImageStoryAnalysis(null);
    setImageStoryError(null);
    setCustomStyleRefImage((current) => current === previousPreview ? "" : current);
    setCustomStyleGuide((current) => previousStyle && current.trim() === previousStyle ? "" : current);
  };

  const handleStoryImport = async (file: File | undefined) => {
    setStoryImportError(null);
    if (!file) return;
    if (file.size <= 0) {
      setStoryImportError(t("home.errors.emptyFile"));
      return;
    }
    const isJson = file.name.toLowerCase().endsWith(".json") || file.type === "application/json";
    const maxImportBytes = isJson ? 12_000_000 : 13_000_000;
    if (file.size > maxImportBytes) {
      setStoryImportError(t("home.errors.fileTooLarge"));
      return;
    }
    try {
      let text: string;
      if (isJson) {
        text = await file.text();
      } else {
        const r = await fetch("/api/story-unpack", {
          method: "POST",
          body: await file.arrayBuffer(),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? t("home.errors.unpackFailed"));
        }
        const j = (await r.json()) as { docStr?: unknown };
        if (typeof j.docStr !== "string") throw new Error(t("home.errors.unpackFailed"));
        text = j.docStr;
      }
      const doc = parseStoryShareDoc(JSON.parse(text));
      window.sessionStorage.setItem(STORY_SHARE_STORAGE_KEY, JSON.stringify(doc));
      router.push(lp("/play?share=1"));
    } catch (e) {
      setStoryImportError(e instanceof Error ? e.message : t("home.errors.parseFailed"));
    } finally {
      if (storyImportRef.current) storyImportRef.current.value = "";
    }
  };

  const analyticsOn = Boolean(
    process.env.NEXT_PUBLIC_UMAMI_SRC && process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID,
  );

  // 点卡片 = 直接开始这张卡的故事，零等待：跳 /play?card=m0/f0... 由 /play
  // 页面从 /home/firstact/{name}.json 静态文件加载预烘焙好的首幕（含 scene /
  // 角色 / 图片 URL / storyState），整张图都已在 FLUX 上画好且 URL 缓存命中。
  // 「语音配音」选项仍然生效：把 audioEnabled 经 sessionStorage 传给 /play。
  // 其余选项（剧情风格 / 内容节奏）在预烘焙时已锁成「多线转折 / 紧凑爽快」
  // 的红果默认基调，对精选卡不再生效。
  const onCardClick = (card: FeaturedCard) => {
    const voice = OPTS[voiceRow]!.items[sel[voiceRow] ?? 1]!;
    const audioEnabled = voice === "开启";
    sessionStorage.setItem(
      "infiplot:custom",
      JSON.stringify({ worldSetting: "", styleGuide: "", audioEnabled, playerName }),
    );
    track("game_start", {
      source: "curated",
      gender: galleryGender,
      tts: audioEnabled,
      card: card.id as `${"m" | "f"}${number}`,
    });
    router.push(lp(card.playPath || `/play?card=${card.id}`));
  };

  // overflow-x-hidden 在 wrapper 层兜底：body 的 overflow-x-hidden 在移动端会因
  // 规范的 overflow 传播而失效，wrapper 是最靠近溢出源（右下操作集群）的块级剪裁点。
  return (
    <>
      <div className="md:hidden">
        <div className="relative z-10 flex justify-end px-4 pt-3">
          <Link
            href={lp("/community")}
            aria-label="共享故事社区"
            title="共享故事社区"
            className="inline-flex items-center gap-1 text-sm text-clay-500 hover:text-ember-500 transition-colors"
          >
            <i className="fa-solid fa-users" />
            <span>共享故事社区</span>
          </Link>
        </div>
        <MobileDreamFrameApp />
      </div>
      <div className={`hidden min-h-screen flex-col overflow-x-hidden transition-colors duration-300 md:flex ${theme === "night" ? "aistory-night" : "aistory-home-day"}`}>
      {/* ================== HEADER ================== */}
      <header className="mx-auto flex w-full max-w-[1640px] flex-wrap items-center justify-between gap-4 px-6 pt-7 md:px-16 md:pt-8">
        <span className="font-serif text-2xl md:text-[34px] leading-none tracking-tight text-clay-900">
          AI<em className="italic font-light text-ember-500">story</em>
        </span>
        <div className="flex flex-wrap items-center justify-end gap-3 md:gap-4">
          <div className="flex items-center gap-4 md:gap-5">
            <LanguageSwitcher variant="compact" />
            {/* "我的剧情" — entry to the browser-local story list (IndexedDB).
               Needs no auth; the /[locale]/stories page reads the local store. */}
            <button
              type="button"
              onClick={() => router.push(lp("/stories"))}
              aria-label="剧本库管理"
              title="剧本库管理"
              className="text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-book" />
            </button>
            <Link
              href={lp("/mobile")}
              aria-label="手机端预览"
              title="手机端预览"
              className="inline-flex text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-mobile-screen-button" />
            </Link>
            <Link
              href={lp("/studio")}
              aria-label="专业编辑"
              title="专业编辑"
              className="inline-flex text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-clapperboard" />
            </Link>
            <Link
              href={lp("/worldline")}
              aria-label="世界线"
              title="世界线"
              className="inline-flex text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-timeline" />
            </Link>
            <Link
              href={lp("/community")}
              aria-label="共享故事社区"
              title="共享故事社区"
              className="inline-flex text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-users" />
            </Link>
            <Link
              href={lp("/creator")}
              aria-label="创作者中心"
              title="创作者中心"
              className="inline-flex text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-chart-line" />
            </Link>
            <Link
              href={lp("/revenue")}
              aria-label="收益中心"
              title="收益中心"
              className="inline-flex text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-wallet" />
            </Link>
            <button
              type="button"
              onClick={() => {
                setSettingsTab("general");
                setSettingsOpen(true);
              }}
              aria-label={t("home.ui.settings")}
              title={t("home.ui.settings")}
              className="text-base text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-solid fa-gear" />
            </button>
            <a
              href="https://github.com/HBC-Tech-coder/AIstory"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="AIstory on GitHub"
              title="AIstory on GitHub"
              className="inline-flex text-lg text-clay-500 hover:text-ember-500 transition-colors"
            >
              <i className="fa-brands fa-github" />
            </a>
          </div>
          <CreditBalance
            compact
            showAdd
            onAdd={() => setHomeNotice(t("home.ui.addCredits"))}
          />
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex h-10 items-center gap-2 border border-clay-900/15 bg-cream-50/70 px-4 font-sans text-sm font-semibold text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500"
            aria-label={theme === "night" ? "切换白天模式" : "切换夜晚模式"}
            title={theme === "night" ? "切换白天模式" : "切换夜晚模式"}
          >
            <i className={`fa-solid ${theme === "night" ? "fa-sun" : "fa-moon"} text-xs`} />
            {theme === "night" ? "白天" : "夜晚"}
          </button>
          <UserChip />
        </div>
      </header>
      {homeNotice && (
        <div className="fixed right-6 top-24 z-50 border border-clay-900/15 bg-cream-50 px-4 py-3 text-sm text-clay-700 shadow-lg shadow-clay-900/10">
          {homeNotice}
        </div>
      )}

      {/* ================== HERO 控制区（居中，呼应原型布局） ================== */}
      <section className="px-6 pb-8 pt-10 md:px-16 md:pb-9 md:pt-16">
        <div className="mx-auto max-w-[1100px] text-center">
          <h1 className="font-serif font-light text-[32px] md:text-[56px] xl:text-[62px] leading-[1.12] tracking-tight text-clay-900">
            {t("home.hero.title")}
          </h1>

          {/* prompt 输入（居中） */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
            className="mx-auto mt-7 max-w-[760px] md:mt-9"
          >
            <div className="relative text-left">
              <textarea
                data-home-story-prompt
                ref={inputRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void start();
                  }
                }}
                rows={1}
                placeholder=" "
                spellCheck={false}
                className="block w-full resize-none overflow-hidden border-b border-clay-900/25 bg-transparent py-3 md:py-4 pr-48 md:pr-56 font-serif text-lg md:text-2xl xl:text-[26px] xl:leading-[35px] lining-nums text-clay-900 outline-none transition-colors focus:border-ember-500"
              />
              {!prompt && (
                <div className="pointer-events-none absolute left-0 right-0 top-0 overflow-hidden whitespace-nowrap py-3 md:py-4 pr-48 md:pr-56 font-serif text-lg md:text-2xl xl:text-[26px] xl:leading-[35px] text-clay-400">
                  <Typewriter
                    phrase={phrases[phraseIdx] ?? ""}
                    onCycle={() =>
                      setPhraseIdx((i) => (i + 1) % phrases.length)
                    }
                  />
                </div>
              )}
              <input
                ref={imageStoryRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleImageStoryUpload(e.target.files?.[0])}
              />
              <input
                ref={storyImportRef}
                type="file"
                accept=".infiplot,application/octet-stream,.json,application/json"
                className="hidden"
                onChange={(e) => void handleStoryImport(e.target.files?.[0])}
              />
              {/* 右下操作集群：载入剧情 + 开始，统一锚定 right-0，杜绝 right-[-...]
                  负偏移导致的移动端横向溢出。 */}
              <div className="absolute right-0 bottom-2 md:bottom-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => imageStoryRef.current?.click()}
                  disabled={imageStoryLoading}
                  aria-label="上传图片开局"
                  className="group relative inline-flex items-center justify-center rounded-sm border border-clay-900/15 bg-cream-50/70 backdrop-blur-sm px-2 py-2 md:py-2.5 text-clay-400 transition-colors hover:border-ember-500 hover:bg-cream-50/90 hover:text-ember-500 disabled:cursor-wait disabled:opacity-60"
                >
                  <i className={`fa-solid ${imageStoryLoading ? "fa-spinner animate-spin" : "fa-image"} text-sm`} />
                  <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-clay-900 px-2 py-1 font-sans text-[11px] text-cream-50 opacity-0 transition-opacity group-hover:opacity-100">
                    上传图片开局
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => storyImportRef.current?.click()}
                  className="group relative inline-flex items-center justify-center rounded-sm border border-clay-900/15 bg-cream-50/70 backdrop-blur-sm px-2 py-2 md:py-2.5 text-clay-400 transition-colors hover:border-ember-500 hover:bg-cream-50/90 hover:text-ember-500"
                >
                  <i className="fa-solid fa-file-import text-sm" />
                  <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-clay-900 px-2 py-1 font-sans text-[11px] text-cream-50 opacity-0 transition-opacity group-hover:opacity-100">
                    {t("home.ui.loadStory")}
                  </span>
                </button>
                <a
                  href={lp("/play?custom=1")}
                  onClick={(e) => {
                    if (AUTH_ENABLED) e.preventDefault();
                    void start();
                  }}
                  className="inline-flex items-center gap-2 rounded-sm bg-clay-900 px-5 py-2 md:py-2.5 font-sans text-sm md:text-[15px] text-cream-50 transition-colors hover:bg-ember-500"
                >
                  {t("home.ui.start")}
                  <i className="fa-solid fa-arrow-right text-xs" />
                </a>
              </div>
            </div>
            {imageStoryPreview && (
              <div className="mt-3 flex items-center gap-3 rounded-sm border border-clay-900/10 bg-cream-100/50 p-2 text-left">
                <img
                  src={imageStoryPreview}
                  alt="上传图片开局预览"
                  className="h-12 w-16 flex-none rounded-sm object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-clay-700 xl:text-[13px]">
                    已作为故事开局和画面参考
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-clay-400 xl:text-xs">
                    {imageStoryAnalysis?.setting || imageStoryAnalysis?.mood || imageStoryAnalysis?.stylePrompt || "后续画面会参考这张图"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={removeImageStory}
                  className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-sm text-clay-400 transition-colors hover:bg-clay-900/5 hover:text-ember-500"
                  aria-label="移除图片开局"
                >
                  <i className="fa-solid fa-xmark text-xs" />
                </button>
              </div>
            )}
            {imageStoryError && (
              <p className="mt-2 text-right text-xs leading-relaxed text-ember-500 xl:text-[13px]">
                {imageStoryError}
              </p>
            )}
            {storyImportError && (
              <p className="mt-2 text-right text-xs leading-relaxed text-ember-500 xl:text-[13px]">
                {storyImportError}
              </p>
            )}
            {prompt && (
              <p className="mt-2 text-right text-xs text-clay-400 xl:text-[13px]">
                {t("home.hero.enterHint")}
              </p>
            )}
          </form>

          {/* 类别选择器（居中） */}
          <div className="mt-7 flex flex-wrap justify-center gap-x-8 gap-y-5 md:mt-8">
            {OPTS.map((o, r) => (
              <div data-cat key={r} className="text-left">
                <CategorySelect
                  label={optLabels[r] ?? o.label}
                  items={o.items}
                  itemLabels={optItemLabels[r] ?? o.items}
                  value={sel[r] ?? 0}
                  open={open === r}
                  onToggle={() => {
                    if (o.modal) {
                      setStyleOpen(true);
                    } else {
                      setOpen(open === r ? -1 : r);
                    }
                  }}
                  onPick={(i) => {
                    setSel((s) => s.map((v, j) => (j === r ? i : v)));
                    setOpen(-1);
                  }}
                />
              </div>
            ))}
          </div>

          {/* 平台积分生成状态：始终显示在可收起的提示卡之外，不随 hintClosed 隐藏。 */}
          <PlatformGenerationNotice className="mx-auto mt-5 w-full max-w-full md:max-w-[1066px]" />

          <div
            data-home-information-card
            className="relative mx-auto mt-5 w-full max-w-full rounded-md border border-clay-900/10 bg-cream-100/50 px-6 py-4 text-left md:max-w-[1066px] md:px-8 md:py-5"
          >
            {/* 可选引导沿用 localStorage:infiplot:hintClosed；强制调用披露始终保留。 */}
            {!hintClosed && (
              <>
                <p className="pr-10 font-serif text-lg font-medium leading-7 text-clay-700 md:text-xl xl:text-[22px] xl:leading-[31px]">
                  <span className="text-clay-800">AIstory</span>{" "}
                  {t("home.about.description")}
                </p>
                <button
                  type="button"
                  onClick={closeHint}
                  aria-label={t("home.hint.collapseAriaLabel")}
                  title={t("home.hint.collapseAriaLabel")}
                  className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-full text-clay-400 transition-colors hover:bg-clay-900/5 hover:text-clay-700"
                >
                  <i className="fa-solid fa-xmark text-xs" />
                </button>
              </>
            )}

            <div className={!hintClosed ? "mt-4 border-t border-clay-900/10 pt-3" : ""}>
              <UsageDisclosureNote
                action="start_custom"
                audioEnabled={selectedAudioEnabled}
                prefetchDepth={branchPrefetchDepth}
                refreshKey={settingsOpen}
                variant="plain"
                className="text-xs leading-relaxed text-clay-600 xl:text-[13px]"
              />
              {hintClosed && (
                <button
                  type="button"
                  onClick={openHint}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-clay-900/10 bg-cream-50/70 px-3 py-1.5 text-xs font-medium text-clay-700 transition-colors hover:border-clay-900/20 hover:bg-cream-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/50 xl:text-[13px]"
                >
                  <i className="fa-solid fa-chevron-down text-[10px]" aria-hidden="true" />
                  {t("home.hint.expand")}
                </button>
              )}
            </div>

            {!hintClosed && (
              <div className="mt-3 border-t border-clay-900/10 pt-3">
                <p
                  className="pr-6 font-serif text-[13px] leading-relaxed text-clay-500 xl:text-[14.5px]"
                  dangerouslySetInnerHTML={{ __html: t("home.hint.text", { authEnabled: AUTH_ENABLED }) }}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      <WorldModelDemoShowcase />

      {/* ================== 统一瀑布流（每性向 30 篇预设剧情） ================== */}
      <section className="mx-auto w-full max-w-[1640px] px-6 pb-16 pt-7 md:px-16 md:pb-24 md:pt-10">
        <div
          className={
            "transition-[opacity,filter] duration-300 ease-out " +
            (fading ? "opacity-0 blur-[3px]" : "opacity-100 blur-0")
          }
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 md:gap-5">
            {featuredCards.map((card) => (
              <StoryCard
                key={card.id}
                title={card.title}
                outline={card.outline}
                image={card.coverPath}
                assetStatus={card.assetStatus}
                onClick={() => onCardClick(card)}
              />
            ))}
          </div>
        </div>
        {localStories.length > 0 && (
          <div className="mt-8 md:mt-10 border-t border-clay-900/10 pt-7 md:pt-8">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-serif text-2xl text-clay-900 xl:text-[26px]">我的剧集 / 继续观看</h2>
                <p className="mt-1 text-sm text-clay-500 xl:text-[15.5px]">
                  这里显示用户自己生成的剧，以及看过但还没有读完的互动剧情。
                </p>
              </div>
              <Link
                href={lp("/stories")}
                className="inline-flex items-center gap-2 border border-clay-900/15 bg-cream-50/70 px-4 py-2 text-sm text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500"
              >
                剧本库管理
                <i className="fa-solid fa-arrow-right text-xs" />
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {localStories.slice(0, 4).map((story, index) => (
                <div key={story.id} className="border border-clay-900/10 bg-cream-100/55 p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-14 w-11 shrink-0 items-center justify-center border border-clay-900/15 bg-clay-900 text-cream-50">
                        <span className="font-serif text-lg">{index + 1}</span>
                      </div>
                      <div className="min-w-0">
                        <h3 className="truncate font-serif text-lg text-clay-900 xl:text-[20px]">{getStoryDisplayTitle(story)}</h3>
                        <p className="text-xs text-clay-500 xl:text-[13px]">
                          {story.sceneCount} 幕 · {formatHomeStoryTime(story, locale)}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-sm border border-clay-900/10 px-2 py-1 text-[10px] text-clay-500 xl:text-[11px]">
                      未读完
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Link
                      href={lp(`/play?storyId=${encodeURIComponent(story.id)}`)}
                      className="inline-flex flex-1 items-center justify-center gap-2 bg-clay-900 px-3 py-2 text-cream-50 transition-colors hover:bg-ember-500"
                    >
                      继续
                      <i className="fa-solid fa-play text-[10px]" />
                    </Link>
                    <Link
                      href={lp("/studio")}
                      className="inline-flex items-center justify-center border border-clay-900/15 px-3 py-2 text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500"
                    >
                      编辑
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ================== 项目介绍（居中题跋） ================== */}
      <section id="about" className="mx-auto w-full max-w-[1640px] px-6 md:px-16 pb-12 md:pb-16">
        <div className="hairline-full mb-8 w-full md:mb-10" />

        <p
          className="mx-auto max-w-3xl text-center font-sans text-xs md:text-[13px] xl:text-[14.5px] leading-[1.85] text-clay-500"
          dangerouslySetInnerHTML={{ __html: t("home.about.legalNotice", { analyticsOn }) }}
        />
      </section>

      <footer className="mx-auto w-full max-w-[1640px] px-6 md:px-16 pb-10 mt-auto">
        <div className="hairline-full w-full mb-5" />
        <div className="flex flex-col items-center gap-2 text-[10px] smallcaps text-clay-500 xl:text-[11px]">
          <span>{t("home.about.copyright")}</span>
          <span className="flex items-center gap-3 normal-case tracking-normal text-[11px] xl:text-xs">
            <a href={lp("/privacy")} className="hover:text-ember-500 transition-colors">{t("home.about.privacyPolicy")}</a>
            <span className="text-clay-300">·</span>
            <a href={lp("/terms")} className="hover:text-ember-500 transition-colors">{t("home.about.terms")}</a>
          </span>
        </div>
      </footer>


      {styleOpen && styleRow >= 0 && (
        <StyleModal
          items={OPTS[styleRow]!.items}
          itemLabels={optItemLabels[styleRow] ?? OPTS[styleRow]!.items}
          value={sel[styleRow] ?? 0}
          onPick={(i) => {
            track("art_style_select", { style: ART_STYLES[i] ?? "自动" });
            setSel((s) => s.map((v, j) => (j === styleRow ? i : v)));
          }}
          onClose={() => setStyleOpen(false)}
          customStyleGuide={customStyleGuide}
          setCustomStyleGuide={setCustomStyleGuide}
          customStyleRefImage={customStyleRefImage}
          setCustomStyleRefImage={setCustomStyleRefImage}
          onRequireAuth={(requirement) => {
            setAuthRequirement(requirement);
            setAuthModalOpen(true);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          initialTab={settingsTab}
          initialVisionClickEnabled={visionClickEnabled}
          onClose={() => setSettingsOpen(false)}
          onSaved={(settings) => {
            setPlayerName(settings.playerName);
            setVisionClickEnabled(settings.visionClickEnabled);
            setBranchPrefetchDepth(settings.branchPrefetchDepth);
            setTtsConfigured(settings.ttsConfigured);
            if (settings.ttsConfigured && voiceRow >= 0) {
              const onIdx = OPTS[voiceRow]!.items.indexOf("开启");
              if (onIdx >= 0)
                setSel((s) => s.map((v, j) => (j === voiceRow ? onIdx : v)));
            }
          }}
        />
      )}
      {authModalOpen && (
        <AuthModal
          onClose={() => {
            setAuthModalOpen(false);
            setAuthRequirement(undefined);
            setPendingAction(null);
            try {
              sessionStorage.removeItem(PENDING_START_KEY);
              sessionStorage.removeItem(PENDING_PARSE_KEY);
            } catch {
              /* ignore */
            }
          }}
          onSuccess={() => {
            setAuthModalOpen(false);
            setAuthRequirement(undefined);
            // Phone OTP stays on the page, so resume the gated action inline.
            void resumePendingParse();
            if (pendingAction === "start") {
              setPendingAction(null);
              try {
                sessionStorage.removeItem(PENDING_START_KEY);
              } catch {
                /* ignore */
              }
              void start();
            }
          }}
          requirement={authRequirement}
        />
      )}
      </div>
    </>
  );
}
