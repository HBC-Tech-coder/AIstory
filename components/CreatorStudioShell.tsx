"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CreatorProjectContextPanel } from "@/components/CreatorProjectContextPanel";
import { CaseAssetReviewPanel } from "@/components/CaseAssetReviewPanel";
import { LocalMiniDramaStudio } from "@/components/LocalMiniDramaStudio";
import { LocalGenerationPanel } from "@/components/LocalGenerationPanel";
import { CreatorWorkflowRegistryPanel } from "@/components/CreatorWorkflowRegistryPanel";
import { SteamVideoGenerationPreflightPanel } from "@/components/SteamVideoGenerationPreflightPanel";
import { SteamVideoProductionPlanPanel } from "@/components/SteamVideoProductionPlanPanel";
import {
  CREATOR_STUDIO_MODULES,
  resolveCreatorStudioModuleUrl,
  type CreatorStudioModuleId,
} from "@/lib/creator-studio/capabilities";
import {
  buildCreatorStudioHostContext,
  readRememberedCreatorStudioProject,
  rememberCreatorStudioProject,
  resolveCreatorStudioBridgeAction,
  type CreatorStudioOpenModuleIntent,
} from "@/lib/creator-studio/bridge";
import type {
  LocalMiniDramaCapabilityStatus,
  LocalMiniDramaDrama,
  LocalMiniDramaListResult,
  LocalMiniDramaProjectContext,
} from "@/lib/localminidrama/types";
import type { ComfyUIProviderStatus } from "@/lib/providers/comfyui/types";
import type { VolcengineAgentPlanStatus } from "@/lib/providers/volcengine-agent-plan/types";
import type { LanGpuCoordinatorStudioStatus } from "@/lib/gpu-coordinator/generationJobAdapter";

type CreatorStudioShellProps = {
  initialTemplateId?: string;
  initialModule?: CreatorStudioModuleId;
  homeHref: string;
};

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
  initialModule,
  homeHref,
}: CreatorStudioShellProps) {
  const [activeModule, setActiveModule] =
    useState<CreatorStudioModuleId>(initialModule ?? "aistory-script");
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
  const [lanGpuStatus, setLanGpuStatus] =
    useState<LanGpuCoordinatorStudioStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [readyIframeIdentity, setReadyIframeIdentity] = useState<string | null>(
    null,
  );
  const [bridgeIntent, setBridgeIntent] =
    useState<CreatorStudioOpenModuleIntent | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const refreshComfyStatus = useCallback(async () => {
    const status = await readJson<ComfyUIProviderStatus>(
      "/api/providers/comfyui/status",
    ).catch(() => null);
    setComfyStatus(status);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [local, volcengine, lanGpu, projectList] = await Promise.all([
        readJson<LocalMiniDramaCapabilityStatus>(
          "/api/localminidrama/capabilities",
        ).catch(() => null),
        readJson<VolcengineAgentPlanStatus>(
          "/api/providers/volcengine-agent-plan/status",
        ).catch(() => null),
        readJson<LanGpuCoordinatorStudioStatus>(
          "/api/providers/gpu-connector-lan/status",
        ).catch(() => null),
        readJson<{ ok: boolean; data?: LocalMiniDramaListResult }>(
          "/api/localminidrama/dramas?page=1&page_size=100",
        ).catch(() => null),
      ]);
      setCapabilities(local);
      setVolcengineStatus(volcengine);
      setLanGpuStatus(lanGpu);
      const items = projectList?.ok ? projectList.data?.items ?? [] : [];
      setProjects(items);
      setProjectId((current) => {
        if (current && items.some((project) => project.id === current)) return current;
        const stored = readRememberedCreatorStudioProject(
          localStorage,
          items.map((project) => project.id),
        );
        if (stored) return stored;
        return items[0]?.id ?? null;
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (activeModule === "steam-video-plan") return;
    void refresh();
  }, [activeModule, refresh]);

  useEffect(() => {
    if (activeModule === "local-generation") {
      void refreshComfyStatus();
    } else {
      setComfyStatus(null);
    }
  }, [activeModule, refreshComfyStatus]);

  const refreshVisibleState = useCallback(async () => {
    await Promise.all([
      refresh(),
      activeModule === "local-generation"
        ? refreshComfyStatus()
        : Promise.resolve(),
    ]);
  }, [activeModule, refresh, refreshComfyStatus]);

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
  const iframeIdentity = `${activeModule}:${projectId ?? "none"}:${resolved.url}`;
  const bridgeState =
    localReady && readyIframeIdentity === iframeIdentity
      ? "ready"
      : "awaiting_donor_sender";

  useEffect(() => {
    setReadyIframeIdentity((current) =>
      localReady && current === iframeIdentity ? current : null,
    );
  }, [iframeIdentity, localReady]);

  const selectProject = useCallback((id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    setProjectId(id);
    setBridgeIntent((current) =>
      current?.projectId === id ? current : null,
    );
    rememberCreatorStudioProject(localStorage, id);
  }, []);

  const openBridgeModule = useCallback(
    (intent: CreatorStudioOpenModuleIntent) => {
      if (
        intent.projectId !== projectId ||
        !projects.some((project) => project.id === intent.projectId)
      ) {
        return;
      }
      setBridgeIntent(intent);
      setActiveModule(intent.module);
    },
    [projectId, projects],
  );

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
    if (!frontendUrl || !localReady) return;
    let trustedOrigin: string;
    try {
      trustedOrigin = new URL(frontendUrl).origin;
    } catch {
      return;
    }
    const receiveBridgeMessage = (event: MessageEvent) => {
      const action = resolveCreatorStudioBridgeAction(event, {
        trustedOrigin,
        trustedSource: iframeRef.current?.contentWindow,
        knownProjectIds: projects.map((project) => project.id),
        currentProjectId: projectId,
      });
      if (!action) return;
      if (action.kind === "ready") {
        setReadyIframeIdentity(iframeIdentity);
        return;
      }
      if (action.kind === "project-selected") {
        selectProject(action.projectId);
        setProjectContextRevision((revision) => revision + 1);
        return;
      }
      openBridgeModule(action.intent);
    };
    window.addEventListener("message", receiveBridgeMessage);
    return () => window.removeEventListener("message", receiveBridgeMessage);
  }, [
    capabilities?.frontendUrl,
    iframeIdentity,
    localReady,
    openBridgeModule,
    projectId,
    projects,
    selectProject,
  ]);

  const sendHostContext = useCallback(() => {
    const frontendUrl = capabilities?.frontendUrl;
    if (!frontendUrl || !iframeRef.current?.contentWindow) return;
    const intent =
      bridgeIntent?.projectId === projectId && bridgeIntent.module === activeModule
        ? bridgeIntent
        : projectId && activeModule === "tasks"
          ? ({ projectId, module: "tasks" } satisfies CreatorStudioOpenModuleIntent)
          : projectId && activeModule === "media"
            ? ({
                projectId,
                module: "media",
                mediaKind: "all",
              } satisfies CreatorStudioOpenModuleIntent)
            : null;
    const message = buildCreatorStudioHostContext({ projectId, intent });
    if (!message) return;
    try {
      iframeRef.current.contentWindow.postMessage(message, new URL(frontendUrl).origin);
    } catch {
      // The typed bridge remains optional while the read-only donor lacks messaging.
    }
  }, [activeModule, bridgeIntent, capabilities?.frontendUrl, projectId]);

  useEffect(() => {
    if (activeModule === "tasks" || activeModule === "media") {
      sendHostContext();
    }
  }, [activeModule, sendHostContext]);

  const handleIframeLoad = useCallback(() => {
    sendHostContext();
  }, [sendHostContext]);

  const openCreatedProject = useCallback(
    (id: number, destination: "production" | "canvas") => {
      selectProject(id);
      setBridgeIntent(null);
      setActiveModule(destination);
    },
    [selectProject],
  );

  return (
    <main className="ui-page min-h-screen">
      <header className="ui-surface sticky top-0 z-40 border-b shadow-sm backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1920px] flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
          <a
            href={homeHref}
            className="ui-button-secondary inline-flex h-10 w-10 items-center justify-center border"
            aria-label="返回 AIstory 首页"
          >
            <i className="fa-solid fa-house" />
          </a>
          <div className="mr-auto min-w-0">
            <div className="font-serif text-xl leading-none md:text-2xl">
              AIstory <span className="ui-primary">创作者工作台</span>
            </div>
            <p className="ui-muted mt-1 truncate text-xs">
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
              {comfyStatus === null
                ? "未探测"
                : comfyStatus.state === "ready"
                ? "已连接"
                : comfyStatus.state === "disabled"
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
              onClick={() => void refreshVisibleState()}
              disabled={refreshing}
              className="ui-button-secondary inline-flex h-8 items-center gap-1.5 border px-2.5"
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
        <nav className="ui-surface-soft min-w-0 max-w-full border-b p-3 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-4">
          <div className="flex w-full max-w-full gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible">
            {CREATOR_STUDIO_MODULES.map((module) => {
              const selected = activeModule === module.id;
              return (
                <button
                  key={module.id}
                  type="button"
                  onClick={() => {
                    setBridgeIntent(null);
                    setActiveModule(module.id);
                  }}
                  aria-current={selected ? "page" : undefined}
                  className={`flex shrink-0 items-center gap-2 border px-3 py-2.5 text-left text-sm transition lg:w-full ${
                    selected
                      ? "border-ember-500 bg-ember-500 text-white"
                      : "border-transparent text-clay-600 hover:border-ember-500/25 hover:bg-cream-50/70"
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
          <div className="ui-surface mt-4 hidden border p-3 text-xs leading-5 text-clay-600 lg:block">
            <div className="font-semibold text-clay-700">本地边界</div>
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
                lanGpuStatus={lanGpuStatus}
                projects={projects}
                projectId={projectId}
                onSelectProject={selectProject}
                onAssetAdopted={() =>
                  setProjectAssetRevision((revision) => revision + 1)
                }
              />
            </div>
          ) : activeModule === "models" ? (
            <CreatorWorkflowRegistryPanel providerStatus={comfyStatus} />
          ) : activeModule === "case-review" ? (
            <CaseAssetReviewPanel />
          ) : activeModule === "steam-video-plan" ? (
            <>
              <SteamVideoProductionPlanPanel />
              <SteamVideoGenerationPreflightPanel />
            </>
          ) : (
            <div className="flex min-h-[calc(100vh-65px)] flex-col">
              <div className="ui-surface flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <div className="mr-auto min-w-0">
                  <h1 className="font-serif text-xl">
                    {activeDefinition?.label}
                  </h1>
                  <p className="ui-muted mt-0.5 text-xs">
                    {activeDefinition?.description}
                  </p>
                </div>
              </div>

              <div
                data-creator-bridge-state={bridgeState}
                role="status"
                aria-live="polite"
                className="ui-surface-soft ui-muted border-b px-4 py-2 text-xs leading-5"
              >
                {bridgeState === "ready"
                  ? "专业画布同步已就绪。"
                  : "等待专业画布同步支持；当前项目下拉与 AIstory 模块导航仍可用。"}
                {bridgeIntent?.projectId === projectId &&
                  bridgeIntent.module === activeModule && (
                    <span className="ml-2 font-medium text-clay-700">
                      {bridgeIntent.module === "media"
                        ? `导航意图：${bridgeIntent.mediaKind === "image" ? "图片" : bridgeIntent.mediaKind === "video" ? "视频" : bridgeIntent.mediaKind === "audio" ? "音频" : "全部媒体"}`
                        : bridgeIntent.module === "tasks"
                          ? `导航意图：${bridgeIntent.taskId ? "指定任务" : "任务"}`
                          : "导航意图：本地素材"}
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
                onOpenModule={openBridgeModule}
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
                <div className="ui-surface m-4 flex flex-1 items-center justify-center border p-8 text-center">
                  <div className="max-w-xl">
                    <i className="fa-solid fa-plug-circle-xmark ui-primary text-4xl" />
                    <h2 className="mt-4 font-serif text-2xl">
                      本地制作引擎未完整连接
                    </h2>
                    <p className="ui-muted mt-3 text-sm leading-6">
                      为避免误连外部服务，专业制作区已 fail-closed。AIstory
                      剧本台仍可继续编辑，不会触发生成或付费 API。
                    </p>
                    <code className="mt-4 block overflow-x-auto border border-blue-900/20 bg-[#07132f] px-4 py-3 text-left text-xs text-blue-100">
                      powershell -File
                      scripts/start-aistory-local-stack.ps1
                    </code>
                  </div>
                </div>
              ) : (
                <iframe
                  ref={iframeRef}
                  key={iframeIdentity}
                  src={resolved.url}
                  title={`AIstory ${activeDefinition?.label ?? "本地制作台"}`}
                  className="min-h-[760px] w-full flex-1 border-0 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups"
                  referrerPolicy="no-referrer"
                  allow="clipboard-read; clipboard-write"
                  onLoad={handleIframeLoad}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
