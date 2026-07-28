export type CreatorStudioModuleId =
  | "aistory-script"
  | "local-generation"
  | "case-review"
  | "projects"
  | "production"
  | "characters"
  | "scenes-props"
  | "storyboards"
  | "canvas"
  | "tasks"
  | "media"
  | "models";

export type CreatorStudioModuleSource = "aistory" | "localminidrama";

export type CreatorStudioModuleDefinition = {
  id: CreatorStudioModuleId;
  label: string;
  shortLabel: string;
  description: string;
  icon: string;
  source: CreatorStudioModuleSource;
  requiresProject: boolean;
};

export const CREATOR_STUDIO_MODULES: readonly CreatorStudioModuleDefinition[] = [
  {
    id: "aistory-script",
    label: "AIstory 剧本台",
    shortLabel: "剧本",
    description: "导入、解析并续写互动短剧草稿。",
    icon: "fa-pen-ruler",
    source: "aistory",
    requiresProject: false,
  },
  {
    id: "local-generation",
    label: "AIstory 本地生成",
    shortLabel: "生成",
    description: "使用受控 ComfyUI 模板生成图片并查看统一任务状态。",
    icon: "fa-wand-magic-sparkles",
    source: "aistory",
    requiresProject: false,
  },
  {
    id: "case-review",
    label: "案例审片",
    shortLabel: "审片",
    description: "审核案例候选图片与视频；审核结论不会自动发布到公开作品。",
    icon: "fa-film",
    source: "aistory",
    requiresProject: false,
  },
  {
    id: "projects",
    label: "短剧项目",
    shortLabel: "项目",
    description: "管理本地短剧项目并进入完整生产流程。",
    icon: "fa-folder-open",
    source: "localminidrama",
    requiresProject: false,
  },
  {
    id: "production",
    label: "角色 / 场景 / 道具",
    shortLabel: "资产",
    description: "在同一项目中管理角色、场景、道具与生成素材。",
    icon: "fa-masks-theater",
    source: "localminidrama",
    requiresProject: true,
  },
  {
    id: "characters",
    label: "角色连续性",
    shortLabel: "角色",
    description: "维护角色形象、四视图、参考图和连续性锚点。",
    icon: "fa-users",
    source: "localminidrama",
    requiresProject: true,
  },
  {
    id: "scenes-props",
    label: "场景与道具",
    shortLabel: "场景",
    description: "组织场景、道具、素材库和参考关系。",
    icon: "fa-mountain-sun",
    source: "localminidrama",
    requiresProject: true,
  },
  {
    id: "storyboards",
    label: "分镜与镜头",
    shortLabel: "分镜",
    description: "拆分剧集分镜、提示词、图像、音频和视频。",
    icon: "fa-table-cells-large",
    source: "localminidrama",
    requiresProject: true,
  },
  {
    id: "canvas",
    label: "生产画布",
    shortLabel: "画布",
    description: "在节点画布中编排生成、重跑和资源依赖。",
    icon: "fa-diagram-project",
    source: "localminidrama",
    requiresProject: true,
  },
  {
    id: "tasks",
    label: "任务队列",
    shortLabel: "任务",
    description: "查看项目生成任务、进度、失败和重试。",
    icon: "fa-list-check",
    source: "localminidrama",
    requiresProject: true,
  },
  {
    id: "media",
    label: "媒体库",
    shortLabel: "媒体",
    description: "统一浏览本地图片、视频、音频和项目素材。",
    icon: "fa-photo-film",
    source: "localminidrama",
    requiresProject: false,
  },
  {
    id: "models",
    label: "模型配置",
    shortLabel: "模型",
    description: "配置本地生产模型；密钥由原系统安全边界管理。",
    icon: "fa-sliders",
    source: "localminidrama",
    requiresProject: false,
  },
] as const;

export function isLoopbackServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function normalizedProjectId(projectId?: number | string | null): string | null {
  const value = Number(projectId);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

export function resolveCreatorStudioModuleUrl(
  frontendUrl: string,
  moduleId: CreatorStudioModuleId,
  projectId?: number | string | null,
): { url: string; needsProject: boolean } {
  const base = frontendUrl.replace(/\/+$/, "");
  const id = normalizedProjectId(projectId);
  const definition = CREATOR_STUDIO_MODULES.find((item) => item.id === moduleId);

  if (moduleId === "media") return { url: `${base}/media-library`, needsProject: false };
  if (moduleId === "models") return { url: `${base}/ai-config`, needsProject: false };
  if (moduleId === "projects") return { url: `${base}/`, needsProject: false };
  if (
    moduleId === "aistory-script"
    || moduleId === "local-generation"
    || moduleId === "case-review"
  ) {
    return { url: "", needsProject: false };
  }
  if (!id) return { url: `${base}/`, needsProject: Boolean(definition?.requiresProject) };
  if (moduleId === "canvas") {
    return { url: `${base}/film/${id}/canvas`, needsProject: false };
  }
  return { url: `${base}/film/${id}`, needsProject: false };
}
