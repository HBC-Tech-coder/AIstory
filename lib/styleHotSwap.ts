import type { Beat, Character, EngineConfig, Session } from "@infiplot/types";
import { coerceOrientation } from "@infiplot/types";
import { stableHash } from "@/lib/speculativeBranch";

export const NARRATIVE_STYLE_OPTIONS = [
  "自动",
  "电影化",
  "文学细腻",
  "简洁明快",
  "悬疑克制",
  "轻喜剧",
  "自定义",
] as const;

export type NarrativeStyleName = (typeof NARRATIVE_STYLE_OPTIONS)[number];

export const NARRATIVE_STYLE_GUIDES: Record<NarrativeStyleName, string> = {
  自动: "根据当前剧情自动选择最合适的叙事表达。",
  电影化: "电影化叙事：镜头感强，动作与环境切换清晰，节奏有张力。",
  文学细腻: "文学细腻：重视感官细节、微妙心理和含蓄而准确的意象。",
  简洁明快: "简洁明快：短句优先，信息清楚，推进迅速，避免冗长修饰。",
  悬疑克制: "悬疑克制：信息有限释放，语气冷静，利用留白维持不安与好奇。",
  轻喜剧: "轻喜剧：节奏轻盈，人物反应有反差和机锋，但不破坏剧情事实。",
  自定义: "",
};

export const VISUAL_STYLE_CHOICES = [
  { name: "自动", thumb: "/home/styles/auto.webp?v6" },
  { name: "吉卜力", thumb: "/home/styles/ghibli.webp?v6" },
  { name: "新海诚", thumb: "/home/styles/shinkai.webp?v6" },
  { name: "真实", thumb: "/home/styles/real.webp?v6" },
  { name: "水彩", thumb: "/home/styles/watercolor.webp?v6" },
  { name: "水墨", thumb: "/home/styles/ink.webp?v6" },
  { name: "赛博朋克", thumb: "/home/styles/cyberpunk.webp?v6" },
  { name: "黑白漫画", thumb: "/home/styles/manga.webp?v6" },
  { name: "自定义风格", thumb: "/home/styles/custom.webp?v6" },
] as const;

export function visualStyleRevision(
  styleGuide: string,
  styleReferenceImage?: string,
): string {
  return stableHash({
    styleGuide: styleGuide.trim(),
    styleReferenceImage: styleReferenceImage
      ? stableHash(styleReferenceImage)
      : null,
  });
}

export function narrativeStyleRevision(style: string | undefined): string {
  return stableHash((style || "自动").trim());
}

export function applyStyleToSession(
  session: Session,
  update: {
    styleGuide?: string;
    styleReferenceImage?: string;
    narrativeStyle?: string;
  },
): Session {
  const styleGuide = update.styleGuide ?? session.styleGuide;
  const styleReferenceImage =
    update.styleReferenceImage !== undefined
      ? update.styleReferenceImage || undefined
      : session.styleReferenceImage;
  const narrativeStyle = update.narrativeStyle ?? session.narrativeStyle ?? "自动";
  return {
    ...session,
    styleGuide,
    styleReferenceImage,
    visualStyleRevision: visualStyleRevision(styleGuide, styleReferenceImage),
    narrativeStyle,
    narrativeStyleRevision: narrativeStyleRevision(narrativeStyle),
  };
}

export function canonicalBeats(scene: { beats: Beat[]; canonicalBeats?: Beat[] }): Beat[] {
  return scene.canonicalBeats ?? scene.beats;
}

/**
 * Applies prose-only output while retaining canonical graph/state semantics.
 * Speaker, ids, active character state and next/choice objects are never
 * accepted from the model.
 */
export function applyExpressionRewrite(
  canonical: Beat[],
  rewritten: Array<Pick<Beat, "id" | "narration" | "line" | "lineDelivery">>,
): Beat[] {
  const byId = new Map(rewritten.map((beat) => [beat.id, beat]));
  return canonical.map((beat) => {
    const replacement = byId.get(beat.id);
    if (!replacement) return { ...beat };
    return {
      ...beat,
      narration: replacement.narration?.trim() || beat.narration,
      line: replacement.line?.trim() || beat.line,
      lineDelivery: replacement.lineDelivery?.trim() || beat.lineDelivery,
      activeCharacters: beat.activeCharacters,
      next: beat.next,
    };
  });
}

function characterIdentity(character: Character): unknown {
  return {
    name: character.name,
    visualDescription: character.visualDescription,
    basePortraitUuid: character.basePortraitUuid,
    basePortraitUrl: character.basePortraitUrl,
    currentState: character.currentState,
    voiceProfile: character.voiceProfile,
  };
}

export function currentStyleCacheKeys(
  session: Session,
  sceneId: string,
  config: Pick<EngineConfig, "text" | "image">,
): { textKey: string; imageKey: string } {
  const scene = session.history.find((entry) => entry.scene.id === sceneId)?.scene;
  const canonical = scene ? canonicalBeats(scene) : [];
  const textKey = stableHash({
    kind: "current-scene-expression-v1",
    sceneId,
    canonical: canonical.map((beat) => ({
      id: beat.id,
      narration: beat.narration,
      speaker: beat.speaker,
      line: beat.line,
      next: beat.next,
    })),
    language: session.language || "zh-CN",
    narrativeStyleRevision:
      session.narrativeStyleRevision ||
      narrativeStyleRevision(session.narrativeStyle),
    textProvider: config.text.provider || "openai_compatible",
    textModel: config.text.model,
  });
  const orientation = coerceOrientation(session.orientation);
  const imageKey = stableHash({
    kind: "current-scene-image-v1",
    sceneId,
    scenePrompt: scene?.scenePrompt,
    characters: session.characters.map(characterIdentity),
    visualStyleRevision:
      session.visualStyleRevision ||
      visualStyleRevision(session.styleGuide, session.styleReferenceImage),
    orientation,
    aspectRatio: orientation === "portrait" ? "9:16" : "16:9",
    imageProvider: config.image.provider || "auto",
    imageModel: config.image.model,
    imageVersion: process.env.AISTORY_IMAGE_MODEL_VERSION || config.image.model,
  });
  return { textKey, imageKey };
}

export function shouldReplaceCurrentImage(
  status: "ready" | "image_pending",
): boolean {
  return status === "ready";
}
