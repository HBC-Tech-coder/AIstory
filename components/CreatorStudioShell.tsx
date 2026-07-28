"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CreatorProjectContextPanel } from "@/components/CreatorProjectContextPanel";
import { CaseAssetReviewPanel } from "@/components/CaseAssetReviewPanel";
import { LocalMiniDramaStudio } from "@/components/LocalMiniDramaStudio";
import { LocalGenerationPanel } from "@/components/LocalGenerationPanel";
import {
  CREATOR_STUDIO_MODULES,
  resolveCreatorStudioModuleUrl,
  type CreatorStudioModuleId,
} from "@/lib/creator-studio/capabilities";
import type {
  LocalMiniDramaCapabilityStatus,
  LocalMiniDramaDrama,
  LocalMiniDramaListResult,
  LocalMiniDramaProjectContext,
} from "@/lib/localminidrama/types";
import type { ComfyUIProviderStatus } from "@/lib/providers/comfyui/types";
import type { VolcengineAgentPlanStatus } from "@/lib/providers/volcengine-agent-plan/types";

type CreatorStudioShellProps = {
  initialTemplateId?: string;
  homeHref: string;
};

const SELECTED_PROJECT_STORAGE_KEY = "aistory:studio:selectedProjectId";

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json()) as T;
  return payload;
}

function statusTone(ready: boolean) {
  return ready
    ? "border-emerald-700/25 bg-emerald-50 text-emerald-800"
    : "border-amber-800/20 bg-amber-50 text-amber-900";
}

export function CreatorStudioShell({
  initialTemplateId,
  homeHref,
}: CreatorStudioShellProps) {
  const [activeModule, setActiveModule] =
    useState<CreatorStudioModuleId>("aistory-script");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<LocalMiniDramaDrama[]>([]);
  const [projectContext, setProjectContext] =
    useState<LocalMiniDramaProjectContext | null>(null);
  const [projectContextState, setProjectContextState] =
    useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [projectContextRevision, setProjectContextRevision] = useState(0);
  const [projectAssetRevision, setProjectAssetRevision] = useState(0);
  const [projectAssetCount, setProjectAssetCount] = useState(0);
  const [capabilities, setCapabilities] =
    useState<LocalMiniDramaCapabilityStatus | null>(null);
  const [comfyStatus, setComfyStatus] =
    useState<ComfyUIProviderStatus | null>(null);
  const [volcengineStatus, setVolcengineStatus] =
    useState<VolcengineAgentPlanStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [local, comfy, volcengine, projectList] = await Promise.all([
        readJson<LocalMiniDramaCapabilityStatus>(
          "/api/localminidrama/capabilities",
        ).catch(() => null),
        readJson<ComfyUIProviderStatus>("/api/providers/comfyui/status").catch(
          () => null,
        ),
        readJson<VolcengineAgentPlanStatus>(
          "/api/providers/volcengine-agent-plan/status",
        ).catch(() => null),
        readJson<{ ok: boolean; data?: LocalMiniDramaListResult }>(
          "/api/localminidrama/dramas?page=1&page_size=100",
        ).catch(() => null),
      ]);
      setCapabilities(local);
      setComfyStatus(comfy);
      setVolcengineStatus(volcengine);
      const items = projectList?.ok ? projectList.data?.items ?? [] : [];
      setProjects(items);
      setProjectId((current) => {
        if (current && items.some((project) => project.id === current)) return current;
        const stored = Number(localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY));
        if (
          Number.isSafeInteger(stored) &&
          stored > 0 &&
          items.some((project) => project.id === stored)
        ) {
          return stored;
        }
        return items[0]?.id ?? null;
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeDefinition = useMemo(
    () => CREATOR_STUDIO_MODULES.find((item) => item.id === activeModule),
    [activeModule],
  );
  const resolved = useMemo(
    () =>
      resolveCreatorStudioModuleUrl(
        capabilities?.frontendUrl || "http://127.0.0.1:4107",
        activeModule,
        projectId,
      ),
    [activeModule, capabilities?.frontendUrl, projectId],
  );
  const localReady = capabilities?.ok === true;

  const selectProject = useCallback((id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    setProjectId(id);
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, String(id));
  }, []);

  useEffect(() => {
    if (!localReady) {
      setProjectContext(null);
      setProjectContextState("idle");
      return;
    }
    if (projects.length === 0) {
      setProjectContext(null);
      setProjectContextState("empty");
      return;
    }
    if (!projectId) return;

    const controller = new AbortController();
    setProjectContextState("loading");
    void fetch(`/api/localminidrama/projects/${projectId}/context`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          data?: LocalMiniDramaProjectContext;
        };
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error("project-context-unavailable");
        }
        setProjectContext(payload.data);
        setProjectContextState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProjectContextState("error");
      });
    return () => controller.abort();
  }, [localReady, projectContextRevision, projectId, projects.length]);

  useEffect(() => {
    if (!projectId) {
      setProjectAssetCount(0);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/project-assets?projectId=${projectId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("project-assets-unavailable");
        const payload = (await response.json()) as { total?: number };
        setProjectAssetCount(Number(payload.total) || 0);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProjectAssetCount(0);
      });
    return () => controller.abort();
  }, [projectAssetRevision, projectId]);

  useEffect(() => {
    const frontendUrl = capabilities?.frontendUrl;
    if (!frontendUrl) return;
    let trustedOrigin: string;
    try {
      trustedOrigin = new URL(frontendUrl).origin;
    } catch {
      return;
    }
    const receiveProjectSelection = (event: MessageEvent) => {
      if (
        event.origin !== trustedOrigin ||
        event.source !== iframeRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "aistory:localminidrama:project-selected"
      ) {
        return;
      }
      const id = Number(event.data.projectId);
      if (Number.isSafeInteger(id) && id > 0) selectProject(id);
    };
    window.addEventListener("message", receiveProjectSelection);
    return () => window.removeEventListener("message", receiveProjectSelection);
  }, [capabilities?.frontendUrl, selectProject]);

  const sendHostContext = useCallback(() => {
    const frontendUrl = capabilities?.frontendUrl;
    if (!frontendUrl || !iframeRef.current?.contentWindow) return;
    try {
      iframeRef.current.contentWindow.postMessage(
        {
          type: "aistory:host-context",
          projectId,
          protocolVersion: 1,
        },
        new URL(frontendUrl).origin,
      );
    } catch {
      // The typed bridge remains optional while the read-only donor lacks messaging.
    }
  }, [capabilities?.frontendUrl, projectId]);

  const openCreatedProject = useCallback(
    (id: number, destination: "production" | "canvas") => {
      selectProject(id);
      setActiveModule(destination);
    },
    [selectProject],
  );

  return (
    <main className="min-h-screen bg-[#f4efe4] text-[#2b241b]">
      <header className="sticky top-0 z-40 border-b border-[#6f4f2f]/20 bg-[#f4efe4]/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1920px] flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
          <a
            href={homeHref}
            className="inline-flex h-10 w-10 items-center justify-center border border-[#6f4f2f]/25 text-[#8a5a2b] hover:bg-[#8a5a2b]/10"
            aria-label="返回 AIstory 首页"
          >
            <i className="fa-solid fa-house" />
          </a>
          <div className="mr-auto min-w-0">
            <div className="font-serif text-xl leading-none md:text-2xl">
              AIstory <span className="text-[#9b6a32]">创作者工作台</span>
            </div>
            <p className="mt-1 truncate text-xs text-[#756552]">
              剧本、资产、分镜、画布、任务与媒体在同一工作区完成
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`border px-2.5 py-1.5 ${statusTone(localReady)}`}
              title={capabilities?.message}
            >
              <i
                className={`fa-solid mr-1.5 ${localReady ? "fa-circle-check" : "fa-triangle-exclamation"}`}
              />
              本地制作引擎 {localReady ? "已连接" : "未连接"}
            </span>
            <span
              className={`border px-2.5 py-1.5 ${statusTone(comfyStatus?.available === true)}`}
              title={comfyStatus?.message}
            >
              ComfyUI{" "}
              {comfyStatus?.state === "ready"
                ? "已连接"
                : comfyStatus?.state === "disabled"
                  ? "未启用"
                  : "不可用"}
            </span>
            <span
              className={`border px-2.5 py-1.5 ${statusTone(volcengineStatus?.state === "contract_ready")}`}
              title={volcengineStatus?.message}
            >
              火山视频
              {volcengineStatus?.state === "contract_ready" ? " 契约就绪" : " 待配置"}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex h-8 items-center gap-1.5 border border-[#6f4f2f]/25 px-2.5 text-[#6d5134] hover:bg-white/60 disabled:opacity-50"
            >
              <i
                className={`fa-solid fa-rotate ${refreshing ? "animate-spin" : ""}`}
              />
              刷新状态
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1920px] lg:min-h-[calc(100vh-65px)] lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="min-w-0 max-w-full border-b border-[#6f4f2f]/15 bg-[#eee5d5] p-3 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-4">
          <div className="flex w-full max-w-full gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible">
            {CREATOR_STUDIO_MODULES.map((module) => {
              const selected = activeModule === module.id;
              return (
                <button
                  key={module.id}
                  type="button"
                  onClick={() => setActiveModule(module.id)}
                  className={`flex shrink-0 items-center gap-2 border px-3 py-2.5 text-left text-sm transition lg:w-full ${
                    selected
                      ? "border-[#8a5a2b] bg-[#8a5a2b] text-white"
                      : "border-transparent text-[#5e503f] hover:border-[#8a5a2b]/25 hover:bg-white/55"
                  }`}
                  title={module.description}
                >
                  <i className={`fa-solid w-4 ${module.icon}`} />
                  <span className="lg:hidden">{module.shortLabel}</span>
                  <span className="hidden lg:inline">{module.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 hidden border border-[#8a5a2b]/20 bg-white/45 p-3 text-xs leading-5 text-[#74614b] lg:block">
            <div className="font-semibold text-[#5c4127]">本地边界</div>
            <p className="mt-1">
              只连接 127.0.0.1 / localhost。素材与模型配置不经过公网桥接。
            </p>
          </div>
        </nav>

        <section className="min-w-0">
          {activeModule === "aistory-script" ? (
            <LocalMiniDramaStudio
              initialTemplateId={initialTemplateId}
              onOpenWorkspace={openCreatedProject}
            />
          ) : activeModule === "local-generation" ? (
            <div className="min-h-[calc(100vh-65px)]">
              <LocalGenerationPanel
                providerStatus={comfyStatus}
                localMiniDramaStatus={capabilities}
                volcengineStatus={volcengineStatus}
                projects={projects}
                projectId={projectId}
                onSelectProject={selectProject}
                onAssetAdopted={() =>
                  setProjectAssetRevision((revision) => revision + 1)
                }
              />
            </div>
          ) : activeModule === "case-review" ? (
            <CaseAssetReviewPanel />
          ) : (
            <div className="flex min-h-[calc(100vh-65px)] flex-col">
              <div className="flex flex-wrap items-center gap-3 border-b border-[#6f4f2f]/15 bg-white/45 px-4 py-3">
                <div className="mr-auto min-w-0">
                  <h1 className="font-serif text-xl">
                    {activeDefinition?.label}
                  </h1>
                  <p className="mt-0.5 text-xs text-[#756552]">
                    {activeDefinition?.description}
                  </p>
                </div>
                {activeModule === "models" && (
                  <span className="border border-[#8a5a2b]/20 bg-[#8a5a2b]/5 px-3 py-2 text-xs text-[#6f4f2f]">
                    ComfyUI workflow：{" "}
                    {comfyStatus?.configured ? "已配置" : "待配置"}
                  </span>
                )}
              </div>

              <CreatorProjectContextPanel
                projects={projects}
                selectedProjectId={projectId}
                context={projectContext}
                aistoryAssetCount={projectAssetCount}
                state={projectContextState}
                onSelect={selectProject}
                onRefresh={() =>
                  setProjectContextRevision((revision) => revision + 1)
                }
              />

              {resolved.needsProject && (
                <div className="border-b border-amber-700/20 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                  先在下方项目列表选择项目；进入后仍停留在
                  AIstory 工作台壳层内。
                </div>
              )}

              {!localReady ? (
                <div className="m-4 flex flex-1 items-center justify-center border border-amber-800/20 bg-white/55 p-8 text-center">
                  <div className="max-w-xl">
                    <i className="fa-solid fa-plug-circle-xmark text-4xl text-[#9b6a32]" />
                    <h2 className="mt-4 font-serif text-2xl">
                      本地制作引擎未完整连接
                    </h2>
                    <p className="mt-3 text-sm leading-6 text-[#756552]">
                      为避免误连外部服务，专业制作区已 fail-closed。AIstory
                      剧本台仍可继续编辑，不会触发生成或付费 API。
                    </p>
                    <code className="mt-4 block overflow-x-auto border border-[#6f4f2f]/20 bg-[#2d2924] px-4 py-3 text-left text-xs text-[#f2dfb5]">
                      powershell -File
                      scripts/start-aistory-local-stack.ps1
                    </code>
                  </div>
                </div>
              ) : (
                <iframe
                  ref={iframeRef}
                  key={`${activeModule}:${projectId ?? "none"}:${resolved.url}`}
                  src={resolved.url}
                  title={`AIstory ${activeDefinition?.label ?? "本地制作台"}`}
                  className="min-h-[760px] w-full flex-1 border-0 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups"
                  referrerPolicy="no-referrer"
                  allow="clipboard-read; clipboard-write"
                  onLoad={sendHostContext}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
