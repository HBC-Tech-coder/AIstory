import "server-only";

import type {
  DreamFrameMiniDramaDraft,
  LocalMiniDramaCapabilityStatus,
  LocalMiniDramaCreateResult,
  LocalMiniDramaDrama,
  LocalMiniDramaListResult,
  LocalMiniDramaProjectContext,
  LocalMiniDramaStatus,
  LocalMiniDramaTaskSummary,
} from "./types";
import {
  CREATOR_STUDIO_MODULES,
  isLoopbackServiceUrl,
} from "@/lib/creator-studio/capabilities";

type LocalMiniDramaEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
  timestamp?: string;
};

const DEFAULT_BACKEND_URL = "http://127.0.0.1:5679";
const DEFAULT_FRONTEND_URL = "http://127.0.0.1:4107";

export function getLocalMiniDramaConfig() {
  const backendUrl =
    process.env.LOCAL_MINIDRAMA_BACKEND_URL?.replace(/\/+$/, "") ||
    DEFAULT_BACKEND_URL;
  const frontendUrl =
    process.env.LOCAL_MINIDRAMA_FRONTEND_URL?.replace(/\/+$/, "") ||
    DEFAULT_FRONTEND_URL;
  return { backendUrl, frontendUrl };
}

function jsonHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return headers;
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: LocalMiniDramaEnvelope<T> | T | null = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as LocalMiniDramaEnvelope<T> | T;
    } catch {
      payload = null;
    }
  }

  const envelope = payload as LocalMiniDramaEnvelope<T> | null;
  if (!response.ok || envelope?.success === false) {
    const message =
      envelope?.error?.message ||
      (text ? text.slice(0, 240) : `HTTP ${response.status}`);
    throw new Error(message);
  }

  if (envelope && "data" in envelope) return envelope.data as T;
  return payload as T;
}

async function callLocalMiniDrama<T>(
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const { backendUrl } = getLocalMiniDramaConfig();
  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const response = await fetcher(`${backendUrl}/api/v1${apiPath}`, {
    ...init,
    headers: jsonHeaders(init),
    cache: "no-store",
  });
  return readResponse<T>(response);
}

type LocalMiniDramaPaged<T> = {
  items?: T[];
  pagination?: { total?: number };
};

type LocalMiniDramaRawTask = {
  id?: string;
  type?: string;
  status?: string;
  progress?: number;
  updated_at?: string;
};

function normalizeTaskStatus(status: string | undefined): LocalMiniDramaTaskSummary["status"] {
  const value = String(status || "").toLowerCase();
  if (value === "pending" || value === "queued") return "queued";
  if (value === "processing" || value === "running") return "running";
  if (value === "completed" || value === "succeeded" || value === "success") {
    return "succeeded";
  }
  if (value === "failed" || value === "error") return "failed";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "unknown";
}

function totalFromPage<T>(value: LocalMiniDramaPaged<T> | undefined): number {
  const total = Number(value?.pagination?.total);
  return Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : value?.items?.length ?? 0;
}

function latestIso(values: Array<string | undefined>): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value;
}

function toSafeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function toLocalMiniDramaStyle(style: string): string {
  const s = style.toLowerCase();
  if (s.includes("赛博") || s.includes("cyber")) return "cyberpunk";
  if (s.includes("真实") || s.includes("real")) return "realistic";
  if (s.includes("水墨") || s.includes("ink")) return "ink";
  if (s.includes("水彩") || s.includes("watercolor")) return "watercolor";
  if (s.includes("动画") || s.includes("anime")) return "2d animation";
  return "cinematic";
}

function normalizeDraft(draft: DreamFrameMiniDramaDraft): DreamFrameMiniDramaDraft {
  const title = draft.title?.trim() || "DreamFrame 短剧草稿";
  const summary = draft.summary?.trim() || draft.sourceText?.slice(0, 500) || title;
  const targetEpisodes = Math.max(
    1,
    Math.min(999, Number(draft.continuation?.targetEpisodes) || draft.episodes.length || 1),
  );
  const firstBatchEpisodes = Math.max(
    1,
    Math.min(60, Number(draft.continuation?.firstBatchEpisodes) || draft.episodes.length || 1),
  );
  const episodes = draft.episodes
    .slice(0, firstBatchEpisodes)
    .map((episode, index) => ({
      episode_number: Number(episode.episode_number) || index + 1,
      title: episode.title?.trim() || `第 ${index + 1} 集`,
      script_content: episode.script_content?.trim() || episode.description || "",
      description: episode.description?.trim() || episode.script_content?.slice(0, 160) || "",
      duration: Number(episode.duration) || 0,
    }));

  return {
    ...draft,
    title,
    summary,
    genre: draft.genre?.trim() || "interactive-drama",
    style: toLocalMiniDramaStyle(draft.style || draft.continuation?.artStyle || ""),
    tags: toSafeTags(draft.tags || []),
    characters: (draft.characters || [])
      .filter((character) => character.name?.trim())
      .slice(0, 80)
      .map((character, index) => ({
        ...character,
        name: character.name.trim(),
        role: character.role || (index === 0 ? "主角" : "角色"),
        sort_order: index,
      })),
    episodes:
      episodes.length > 0
        ? episodes
        : [
            {
              episode_number: 1,
              title: "第 1 集",
              script_content: summary,
              description: summary.slice(0, 160),
              duration: 0,
            },
          ],
    continuation: {
      ...draft.continuation,
      targetEpisodes,
      firstBatchEpisodes,
      branchMode: draft.continuation?.branchMode || "branch-overlay",
    },
  };
}

export async function getLocalMiniDramaStatus(): Promise<LocalMiniDramaStatus> {
  const { backendUrl, frontendUrl } = getLocalMiniDramaConfig();
  try {
    const response = await fetch(`${backendUrl}/health`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    const health = await readResponse<unknown>(response);
    return { ok: true, backendUrl, frontendUrl, health };
  } catch (error) {
    return {
      ok: false,
      backendUrl,
      frontendUrl,
      message: error instanceof Error ? error.message : "LocalMiniDrama 不可用",
    };
  }
}

export async function discoverLocalMiniDramaCapabilities(): Promise<LocalMiniDramaCapabilityStatus> {
  const { backendUrl, frontendUrl } = getLocalMiniDramaConfig();
  const localBoundary =
    isLoopbackServiceUrl(backendUrl) && isLoopbackServiceUrl(frontendUrl);
  const checkedAt = new Date().toISOString();
  if (!localBoundary) {
    return {
      ok: false,
      failClosed: true,
      backend: "blocked",
      frontend: "blocked",
      backendUrl,
      frontendUrl,
      modules: CREATOR_STUDIO_MODULES.map((module) => ({
        id: module.id,
        available: module.source === "aistory",
        source: module.source,
      })),
      message: "P1 仅允许连接本机 LocalMiniDrama，非 loopback 地址已阻止。",
      checkedAt,
    };
  }

  const [backendStatus, frontendReady] = await Promise.all([
    getLocalMiniDramaStatus(),
    fetch(frontendUrl, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    })
      .then((response) => response.ok)
      .catch(() => false),
  ]);
  const ok = backendStatus.ok && frontendReady;
  return {
    ok,
    failClosed: !ok,
    backend: backendStatus.ok ? "ready" : "offline",
    frontend: frontendReady ? "ready" : "offline",
    backendUrl,
    frontendUrl,
    modules: CREATOR_STUDIO_MODULES.map((module) => ({
      id: module.id,
      available: module.source === "aistory" || ok,
      source: module.source,
    })),
    message: ok
      ? "AIstory 本地制作能力已连接。"
      : "LocalMiniDrama 未完整连接；嵌入式制作功能已 fail-closed。",
    checkedAt,
  };
}

export async function getLocalMiniDramaProjectContext(
  projectId: number,
  fetcher: typeof fetch = fetch,
): Promise<LocalMiniDramaProjectContext> {
  const id = Number(projectId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("LocalMiniDrama project id must be a positive integer.");
  }
  const { backendUrl, frontendUrl } = getLocalMiniDramaConfig();
  if (!isLoopbackServiceUrl(backendUrl) || !isLoopbackServiceUrl(frontendUrl)) {
    throw new Error("LocalMiniDrama project context is restricted to loopback services.");
  }

  const read = <T>(path: string) =>
    callLocalMiniDrama<T>(
      path,
      {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      },
      fetcher,
    );
  const drama = await read<LocalMiniDramaDrama & { scenes?: unknown[] }>(
    `/dramas/${id}`,
  );
  const [charactersResult, propsResult, tasksResult, assetsResult, imagesResult, videosResult] =
    await Promise.allSettled([
      read<unknown[]>(`/dramas/${id}/characters`),
      read<unknown[]>(`/dramas/${id}/props`),
      read<LocalMiniDramaRawTask[]>(`/tasks?resource_id=${id}`),
      read<LocalMiniDramaPaged<{ updated_at?: string }>>(
        `/assets?drama_id=${id}&page=1&page_size=1`,
      ),
      read<LocalMiniDramaPaged<{ updated_at?: string }>>(
        `/images?drama_id=${id}&page=1&page_size=1`,
      ),
      read<LocalMiniDramaPaged<{ updated_at?: string }>>(
        `/videos?drama_id=${id}&page=1&page_size=1`,
      ),
    ]);

  const warnings: string[] = [];
  const unavailable = (name: string, result: PromiseSettledResult<unknown>) => {
    if (result.status === "rejected") warnings.push(`${name}-unavailable`);
  };
  unavailable("characters", charactersResult);
  unavailable("props", propsResult);
  unavailable("tasks", tasksResult);
  unavailable("assets", assetsResult);
  unavailable("images", imagesResult);
  unavailable("videos", videosResult);

  const characters =
    charactersResult.status === "fulfilled" && Array.isArray(charactersResult.value)
      ? charactersResult.value
      : drama.characters ?? [];
  const props =
    propsResult.status === "fulfilled" && Array.isArray(propsResult.value)
      ? propsResult.value
      : [];
  const rawTasks =
    tasksResult.status === "fulfilled" && Array.isArray(tasksResult.value)
      ? tasksResult.value
      : [];
  const assets = assetsResult.status === "fulfilled" ? assetsResult.value : undefined;
  const images = imagesResult.status === "fulfilled" ? imagesResult.value : undefined;
  const videos = videosResult.status === "fulfilled" ? videosResult.value : undefined;
  const activeTasks = rawTasks.slice(0, 8).map((task): LocalMiniDramaTaskSummary => ({
    id: String(task.id || "unknown"),
    type: String(task.type || "unknown"),
    status: normalizeTaskStatus(task.status),
    progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
    updatedAt: task.updated_at,
  }));
  const imageCount = totalFromPage(images);
  const videoCount = totalFromPage(videos);
  const assetCount = totalFromPage(assets);
  const lastUpdatedAt = latestIso([
    drama.updated_at,
    ...rawTasks.map((task) => task.updated_at),
    assets?.items?.[0]?.updated_at,
    images?.items?.[0]?.updated_at,
    videos?.items?.[0]?.updated_at,
  ]);

  return {
    state: warnings.length > 0 ? "partial" : "ready",
    project: {
      id: drama.id,
      title: String(drama.title || `Project ${id}`).slice(0, 160),
      status: String(drama.status || "unknown"),
      genre: drama.genre || undefined,
      style: drama.style || undefined,
      episodeCount: Array.isArray(drama.episodes)
        ? drama.episodes.length
        : Math.max(0, Number(drama.total_episodes) || 0),
      updatedAt: drama.updated_at,
    },
    counts: {
      characters: characters.length,
      scenes: Array.isArray(drama.scenes) ? drama.scenes.length : 0,
      props: props.length,
      tasks: rawTasks.length,
      media: assetCount + imageCount + videoCount,
      images: imageCount,
      videos: videoCount,
    },
    activeTasks,
    lastUpdatedAt,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

export async function listLocalMiniDramaDramas(
  params: { page?: number; pageSize?: number; keyword?: string } = {},
): Promise<LocalMiniDramaListResult> {
  const search = new URLSearchParams();
  search.set("page", String(params.page || 1));
  search.set("page_size", String(params.pageSize || 8));
  if (params.keyword?.trim()) search.set("keyword", params.keyword.trim());
  const data = await callLocalMiniDrama<{
    items: LocalMiniDramaDrama[];
    pagination: LocalMiniDramaListResult["pagination"];
  }>(`/dramas?${search.toString()}`, { method: "GET" });
  return {
    items: (data.items || []).map((drama) => ({
      id: drama.id,
      title: drama.title,
      description: drama.description,
      genre: drama.genre,
      style: drama.style,
      total_episodes: drama.total_episodes ?? drama.episodes?.length ?? 0,
      status: drama.status,
      thumbnail: drama.thumbnail,
      tags: drama.tags,
      metadata: {
        source: drama.metadata?.source,
        thumbnail_name: drama.metadata?.thumbnail_name,
        platform_variants: drama.metadata?.platform_variants,
        aistory_branch_mode: drama.metadata?.aistory_branch_mode,
        aistory_continuation: drama.metadata?.aistory_continuation,
      },
      created_at: drama.created_at,
      updated_at: drama.updated_at,
    })),
    pagination: data.pagination,
  };
}

export async function createLocalMiniDramaDraft(
  rawDraft: DreamFrameMiniDramaDraft,
): Promise<LocalMiniDramaCreateResult> {
  const { frontendUrl } = getLocalMiniDramaConfig();
  const draft = normalizeDraft(rawDraft);
  const created = await callLocalMiniDrama<LocalMiniDramaDrama>("/dramas", {
    method: "POST",
    body: JSON.stringify({
      title: draft.title,
      description: draft.summary,
      genre: draft.genre,
      style: draft.style,
      thumbnail: draft.thumbnail || undefined,
      metadata: {
        source: "aistory-dreamframe",
        source_version: "localminidrama-bridge-v1",
        imported_at: new Date().toISOString(),
        thumbnail_name: draft.thumbnailName,
        platform_variants: draft.platformVariants,
        source_text_excerpt: draft.sourceText.slice(0, 1600),
        aistory_branch_mode: draft.continuation.branchMode,
        aistory_branches: draft.branches,
        aistory_continuation: draft.continuation,
      },
    }),
  });

  await callLocalMiniDrama(`/dramas/${created.id}/outline`, {
    method: "PUT",
    body: JSON.stringify({
      title: draft.title,
      summary: draft.summary,
      genre: draft.genre,
      tags: draft.tags,
      style: draft.style,
      thumbnail: draft.thumbnail || undefined,
      metadata: {
        aistory_tags: draft.tags,
        thumbnail_name: draft.thumbnailName,
        platform_variants: draft.platformVariants,
        aistory_branch_mode: draft.continuation.branchMode,
        aistory_branches: draft.branches,
        aistory_continuation: draft.continuation,
      },
    }),
  });

  if (draft.characters.length > 0) {
    await callLocalMiniDrama(`/dramas/${created.id}/characters`, {
      method: "PUT",
      body: JSON.stringify({ characters: draft.characters }),
    });
  }

  if (draft.episodes.length > 0) {
    await callLocalMiniDrama(`/dramas/${created.id}/episodes`, {
      method: "PUT",
      body: JSON.stringify({ episodes: draft.episodes }),
    });
  }

  const drama = await callLocalMiniDrama<LocalMiniDramaDrama>(`/dramas/${created.id}`, {
    method: "GET",
  });

  return {
    drama,
    frontendUrl,
    detailUrl: `${frontendUrl}/drama/${created.id}`,
    filmUrl: `${frontendUrl}/film/${created.id}`,
  };
}

export async function requestLocalMiniDramaStoryGeneration(input: {
  premise: string;
  style?: string;
  type?: string;
  episode_count?: number;
  model?: string;
}) {
  const episodeCount = Math.max(1, Math.min(20, Number(input.episode_count) || 1));
  return callLocalMiniDrama<{ episodes: Array<{ episode: number; title: string; content: string }> }>(
    "/generation/story",
    {
      method: "POST",
      body: JSON.stringify({ ...input, episode_count: episodeCount }),
    },
  );
}
