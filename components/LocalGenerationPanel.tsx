"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildStudioGenerationRequest,
  studioEngineDisabledReason,
  studioJobLabel,
  studioJobNotice,
  studioVisibleJobs,
  type StudioGenerationEngine,
} from "@/lib/generation-jobs/studioRequest";
import type { GenerationJob } from "@/lib/generation-jobs/types";
import type {
  LocalMiniDramaCapabilityStatus,
  LocalMiniDramaDrama,
} from "@/lib/localminidrama/types";
import type { ProjectAsset } from "@/lib/project-assets/types";
import type { ComfyUIProviderStatus } from "@/lib/providers/comfyui/types";
import {
  VOLCENGINE_VIDEO_PENDING_MESSAGE,
  type VolcengineAgentPlanStatus,
} from "@/lib/providers/volcengine-agent-plan/types";

type WorkflowSummary = {
  id: string;
  name: string;
  modality: "image" | "video";
  activeVersion: number;
  enabled: boolean;
};

const STATUS_LABEL: Record<GenerationJob["status"], string> = {
  queued: "排队中",
  running: "正在提交",
  pending: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "服务重启后已中断",
};

export function LocalGenerationPanel({
  providerStatus,
  localMiniDramaStatus,
  volcengineStatus,
  projects,
  projectId,
  onSelectProject,
  onAssetAdopted,
}: {
  providerStatus: ComfyUIProviderStatus | null;
  localMiniDramaStatus: LocalMiniDramaCapabilityStatus | null;
  volcengineStatus: VolcengineAgentPlanStatus | null;
  projects: LocalMiniDramaDrama[];
  projectId: number | null;
  onSelectProject: (projectId: number) => void;
  onAssetAdopted: () => void;
}) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [engine, setEngine] =
    useState<StudioGenerationEngine>("comfyui");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [localMiniDramaStyle, setLocalMiniDramaStyle] = useState("");
  const [orientation, setOrientation] =
    useState<"landscape" | "portrait">("landscape");
  const [reference, setReference] = useState<File | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [adoptingJobId, setAdoptingJobId] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const [workflowResponse, jobResponse, assetResponse] = await Promise.all([
      fetch("/api/providers/comfyui/workflows", { cache: "no-store" }),
      fetch("/api/generation-jobs", { cache: "no-store" }),
      projectId
        ? fetch(`/api/project-assets?projectId=${projectId}`, {
            cache: "no-store",
          })
        : Promise.resolve(null),
    ]);
    if (workflowResponse.ok) {
      const payload = (await workflowResponse.json()) as {
        templates?: WorkflowSummary[];
      };
      setWorkflows(payload.templates ?? []);
    }
    if (jobResponse.ok) {
      const payload = (await jobResponse.json()) as { jobs?: GenerationJob[] };
      setJobs(payload.jobs ?? []);
    }
    if (assetResponse?.ok) {
      const payload = (await assetResponse.json()) as {
        items?: ProjectAsset[];
      };
      setAssets(payload.items ?? []);
    } else if (assetResponse || !projectId) {
      setAssets([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const imageWorkflows = useMemo(
    () => workflows.filter((item) => item.modality === "image"),
    [workflows],
  );

  useEffect(() => {
    if (!imageWorkflows.some((item) => item.id === workflowId)) {
      setWorkflowId(imageWorkflows[0]?.id ?? "");
    }
  }, [imageWorkflows, workflowId]);

  const comfyReady =
    providerStatus?.state === "ready" && providerStatus.modalities.image;
  const localMiniDramaReady =
    localMiniDramaStatus?.ok === true &&
    localMiniDramaStatus.backend === "ready";

  useEffect(() => {
    if (engine === "comfyui" && !comfyReady && localMiniDramaReady) {
      setEngine("localminidrama");
    } else if (
      engine === "localminidrama" &&
      !localMiniDramaReady &&
      comfyReady
    ) {
      setEngine("comfyui");
    }
  }, [comfyReady, engine, localMiniDramaReady]);

  const selectedProjectStyle =
    projects.find((project) => project.id === projectId)?.style ?? "";

  useEffect(() => {
    setSelectedAssetId("");
    setLocalMiniDramaStyle(selectedProjectStyle);
  }, [projectId, selectedProjectStyle]);

  useEffect(() => {
    if (
      selectedAssetId &&
      !assets.some((asset) => asset.id === selectedAssetId)
    ) {
      setSelectedAssetId("");
    }
  }, [assets, selectedAssetId]);

  const disabledReason = studioEngineDisabledReason({
    engine,
    comfyReady: Boolean(comfyReady),
    localMiniDramaReady,
    projectId,
    workflowId,
    prompt,
  });
  const visibleJobs = useMemo(() => studioVisibleJobs(jobs), [jobs]);

  const submit = async () => {
    if (disabledReason) {
      setMessage(disabledReason);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      let uploadedReference: string | undefined;
      let referenceRevision = "none";
      if (engine === "comfyui" && selectedAssetId && projectId) {
        const prepared = await fetch(
          "/api/providers/comfyui/project-asset-reference",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId, assetId: selectedAssetId }),
          },
        );
        const payload = (await prepared.json()) as {
          reference?: {
            name?: string;
            subfolder?: string;
            referenceRevision?: string;
          };
          error?: string;
        };
        if (!prepared.ok || !payload.reference?.name || !payload.reference.referenceRevision) {
          throw new Error(payload.error || "项目素材参考图准备失败");
        }
        uploadedReference = payload.reference.subfolder
          ? `${payload.reference.subfolder}/${payload.reference.name}`
          : payload.reference.name;
        referenceRevision = payload.reference.referenceRevision;
      } else if (engine === "comfyui" && reference) {
        const form = new FormData();
        form.set("image", reference);
        const upload = await fetch("/api/providers/comfyui/references", {
          method: "POST",
          body: form,
        });
        if (!upload.ok) throw new Error("参考图上传失败");
        const payload = (await upload.json()) as {
          reference?: { name?: string; subfolder?: string };
        };
        const name = payload.reference?.name;
        if (!name) throw new Error("参考图上传结果无效");
        uploadedReference = payload.reference?.subfolder
          ? `${payload.reference.subfolder}/${name}`
          : name;
        referenceRevision = `${reference.name}:${reference.size}:${reference.lastModified}`;
      }
      const request = buildStudioGenerationRequest({
        engine,
        projectId,
        workflowId,
        prompt,
        negativePrompt,
        orientation,
        localMiniDramaStyle,
        uploadedReference,
        referenceRevision,
        idempotencyKey: crypto.randomUUID(),
      });
      const response = await fetch("/api/generation-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "本地生成任务提交失败");
      }
      setMessage(
        engine === "localminidrama"
          ? "LocalMiniDrama 图片任务已进入 AIstory 统一单并发队列。"
          : "ComfyUI 图片任务已进入 AIstory 统一单并发队列。",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  const act = async (jobId: string, action: "cancel" | "retry") => {
    setMessage("");
    const response = await fetch(`/api/generation-jobs/${jobId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setMessage(response.ok ? "操作已提交。" : "当前任务无法执行该操作。");
    await refresh();
  };

  const adopt = async (jobId: string) => {
    if (!projectId) return;
    setAdoptingJobId(jobId);
    setMessage("");
    try {
      const response = await fetch("/api/project-assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, jobId }),
      });
      const payload = (await response.json()) as {
        created?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "加入素材库失败");
      setMessage(payload.created ? "已加入当前项目素材库。" : "该产物已在当前项目素材库中。");
      await refresh();
      onAssetAdopted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加入素材库失败");
    } finally {
      setAdoptingJobId("");
    }
  };

  const adoptedJobIds = new Set(assets.map((asset) => asset.jobId));
  const projectSelector = (
    <label className="block text-xs text-[#6d5c48]">
      当前项目
      <select
        value={projectId ?? ""}
        onChange={(event) => onSelectProject(Number(event.target.value))}
        disabled={projects.length === 0}
        className="mt-1 h-10 w-full border border-[#6f4f2f]/25 bg-[#fffdf8] px-3 text-sm"
      >
        {projects.length === 0 && <option value="">暂无可用项目</option>}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            #{project.id} {project.title}
          </option>
        ))}
      </select>
    </label>
  );
  const assetLibrary = (
    <div className="border border-[#6f4f2f]/15 bg-[#fffdf8] p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-lg">AIstory 项目素材</h3>
        <span className="text-xs text-[#756552]">{assets.length} 项</span>
      </div>
      {engine === "localminidrama" && (
        <p className="mt-1 text-[11px] text-[#8a6745]">
          LocalMiniDrama 安全模式不传递项目素材 URL；已选 ComfyUI 参考会保留但本次不使用。
        </p>
      )}
      {assets.length === 0 ? (
        <p className="mt-2 border border-dashed border-[#6f4f2f]/20 px-3 py-4 text-xs text-[#756552]">
          {projectId ? "暂无本地素材；生成成功后可一键加入。" : "请先选择当前项目。"}
        </p>
      ) : (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {assets.map((asset) => (
            <article
              key={asset.id}
              className={`w-32 shrink-0 border bg-white p-2 ${
                selectedAssetId === asset.id
                  ? "border-[#8a5a2b] ring-1 ring-[#8a5a2b]"
                  : "border-[#6f4f2f]/15"
              }`}
              title={`${asset.provider} · ${asset.contentType} · ${asset.bytes.toLocaleString()} bytes`}
            >
              <div className="aspect-square overflow-hidden bg-[#eee5d5]">
                {asset.modality === "video" ? (
                  <video src={asset.url} className="h-full w-full object-cover" muted />
                ) : (
                  <Image
                    src={asset.url}
                    alt={asset.name}
                    width={112}
                    height={112}
                    unoptimized
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <p className="mt-1 truncate text-[11px] font-medium text-[#6d5134]">
                {asset.name}
              </p>
              <p className="truncate text-[10px] text-[#806f5b]">
                {asset.provider} · {asset.orientation}
              </p>
              {asset.modality === "image" ? (
                <button
                  type="button"
                  disabled={engine === "localminidrama"}
                  onClick={() => {
                    setSelectedAssetId((current) =>
                      current === asset.id ? "" : asset.id,
                    );
                    setReference(null);
                    setMessage(
                      selectedAssetId === asset.id
                        ? "已取消项目素材参考图。"
                        : "已选择项目素材作为下一次生成参考图。",
                    );
                  }}
                  className="mt-2 h-7 w-full border border-[#8a5a2b]/40 px-1 text-[10px] text-[#7b4e25] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {engine === "localminidrama"
                    ? "仅 ComfyUI 可用"
                    : selectedAssetId === asset.id
                      ? "取消参考"
                      : "用作参考图"}
                </button>
              ) : (
                <p className="mt-2 text-[10px] text-[#8a7560]">视频不可作图片参考</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className="grid gap-4 p-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="border border-[#6f4f2f]/20 bg-white/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-serif text-2xl">本地生成</h1>
          <span className="text-xs text-[#756552]">
            ComfyUI {comfyReady ? "已连接" : "不可用"} · LocalMiniDrama{" "}
            {localMiniDramaReady ? "已连接" : "不可用"}
          </span>
        </div>
        <div className="mt-2 border border-[#6f4f2f]/15 bg-[#8a5a2b]/5 px-3 py-2 text-xs text-[#6d5c48]">
          火山 Agent Plan：
          {volcengineStatus?.state === "contract_ready" ? "异步契约就绪" : "待配置"}
          ；视频任务不阻塞剧情，状态文案为“{VOLCENGINE_VIDEO_PENDING_MESSAGE}”。
        </div>
        <div
          className="mt-4 grid grid-cols-2 gap-1 border border-[#6f4f2f]/20 bg-[#eee5d5] p-1"
          aria-label="本地生成引擎"
        >
          {(
            [
              ["comfyui", "ComfyUI"],
              ["localminidrama", "LocalMiniDrama"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setEngine(value);
                setMessage("");
              }}
              className={`min-w-0 px-2 py-2 text-xs font-semibold transition ${
                engine === value
                  ? "bg-[#8a5a2b] text-white"
                  : "bg-white/60 text-[#6d5134]"
              }`}
              aria-pressed={engine === value}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[#756552]">
          {engine === "comfyui"
            ? "使用管理员注册的本机 workflow，可使用受控参考图。"
            : "使用当前项目和 donor 安全字段；不传 provider、model、路径或素材 URL。"}
        </p>
        <div className="mt-4">{projectSelector}</div>
        {engine === "comfyui" ? (
          <label className="mt-4 block text-xs text-[#6d5c48]">
            Workflow 模板
            <select
              value={workflowId}
              onChange={(event) => setWorkflowId(event.target.value)}
              className="mt-1 h-10 w-full border border-[#6f4f2f]/25 bg-[#fffdf8] px-3 text-sm"
            >
              {imageWorkflows.length === 0 && (
                <option value="">暂无已启用图片模板</option>
              )}
              {imageWorkflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name} · v{workflow.activeVersion}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="mt-4 block text-xs text-[#6d5c48]">
            画面风格（可选）
            <input
              value={localMiniDramaStyle}
              onChange={(event) => setLocalMiniDramaStyle(event.target.value)}
              maxLength={160}
              className="mt-1 h-10 w-full border border-[#6f4f2f]/25 bg-[#fffdf8] px-3 text-sm"
              placeholder="沿用项目风格或填写简短风格描述"
            />
          </label>
        )}
        <label className="mt-3 block text-xs text-[#6d5c48]">
          图片描述
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            maxLength={4_000}
            className="mt-1 w-full resize-y border border-[#6f4f2f]/25 bg-[#fffdf8] p-3 text-sm"
            placeholder="描述画面、角色状态与构图"
          />
        </label>
        <label className="mt-3 block text-xs text-[#6d5c48]">
          避免内容（可选）
          <input
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
            maxLength={1_000}
            className="mt-1 h-10 w-full border border-[#6f4f2f]/25 bg-[#fffdf8] px-3 text-sm"
          />
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-[#6d5c48]">
            画幅
            <select
              value={orientation}
              onChange={(event) =>
                setOrientation(event.target.value as "landscape" | "portrait")
              }
              className="mt-1 h-10 w-full border border-[#6f4f2f]/25 bg-[#fffdf8] px-3 text-sm"
            >
              <option value="landscape">横屏 16:9</option>
              <option value="portrait">竖屏 9:16</option>
            </select>
          </label>
          {engine === "comfyui" ? (
            <label className="block text-xs text-[#6d5c48]">
              参考图（可选）
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                onChange={(event) => {
                  setReference(event.target.files?.[0] ?? null);
                  setSelectedAssetId("");
                }}
                className="mt-1 block h-10 w-full text-xs file:mr-2 file:h-10 file:border-0 file:bg-[#8a5a2b]/10 file:px-3"
              />
            </label>
          ) : (
            <div className="border border-[#6f4f2f]/15 bg-[#8a5a2b]/5 p-3 text-xs leading-5 text-[#756552]">
              输出尺寸：{orientation === "portrait" ? "768×1344" : "1344×768"}
              <br />
              当前引擎不使用 ComfyUI 参考图或项目素材 URL。
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || Boolean(disabledReason)}
          title={disabledReason}
          className="mt-4 h-11 w-full bg-[#8a5a2b] px-4 text-sm font-semibold text-white disabled:opacity-45"
        >
          {busy
            ? "正在提交…"
            : engine === "localminidrama"
              ? "使用 LocalMiniDrama 生成"
              : "使用 ComfyUI 生成"}
        </button>
        {message && <p className="mt-2 text-xs text-[#7b4e25]">{message}</p>}
        {!message && disabledReason && (
          <p className="mt-2 text-xs text-amber-800">{disabledReason}</p>
        )}
        <p className="mt-3 text-[11px] leading-5 text-[#7b6954]">
          两种引擎都通过 AIstory GenerationJob 单并发队列。专业旧工作区的直提任务暂不受本队列控制。
        </p>
      </div>

      <div className="min-w-0 border border-[#6f4f2f]/20 bg-white/45 p-4">
        {assetLibrary}
        <h2 className="font-serif text-xl">生成任务</h2>
        <div className="mt-3 space-y-3">
          {visibleJobs.length === 0 && (
            <p className="border border-dashed border-[#6f4f2f]/25 p-5 text-sm text-[#756552]">
              尚无 AIstory 本地生成任务。
            </p>
          )}
          {visibleJobs.map((job) => (
            <article
              key={job.id}
              className="grid gap-3 border border-[#6f4f2f]/15 bg-[#fffdf8] p-3 sm:grid-cols-[96px_minmax(0,1fr)_auto]"
            >
              <div className="flex aspect-square items-center justify-center overflow-hidden bg-[#eee5d5]">
                {job.artifact?.url ? (
                  <Image
                    src={job.artifact.url}
                    alt="本地生成输出预览"
                    width={96}
                    height={96}
                    unoptimized
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <i className="fa-solid fa-image text-2xl text-[#9b8061]" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-[#6d5134]">
                    {STATUS_LABEL[job.status]}
                  </span>
                  <span className="text-[#7b6954]">{job.progress}%</span>
                  <span className="text-[#7b6954]">
                    {studioJobLabel(job)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden bg-[#8a5a2b]/10">
                  <div
                    className="h-full bg-[#8a5a2b] transition-all"
                    style={{ width: `${job.progress}%` }}
                  />
                </div>
                {job.errorCode && (
                  <p className="mt-2 text-xs text-red-700">
                    本段暂未完成，可重试（{job.errorCode}）
                  </p>
                )}
                {studioJobNotice(job) && (
                  <p className="mt-2 text-xs text-amber-800">
                    {studioJobNotice(job)}
                  </p>
                )}
                {job.notes?.includes("artifact_unavailable") && (
                  <p className="mt-2 text-xs text-[#756552]">
                    任务已完成，但产物未通过本地安全镜像校验。
                  </p>
                )}
              </div>
              <div className="flex gap-2 sm:flex-col">
                {job.status === "succeeded" && job.artifact && projectId && (
                  <button
                    type="button"
                    onClick={() => void adopt(job.id)}
                    disabled={
                      adoptedJobIds.has(job.id) || adoptingJobId === job.id
                    }
                    className="h-8 border border-[#8a5a2b] px-3 text-xs text-[#8a5a2b] disabled:opacity-50"
                  >
                    {adoptedJobIds.has(job.id)
                      ? "已入素材库"
                      : adoptingJobId === job.id
                        ? "正在加入…"
                        : "加入素材库"}
                  </button>
                )}
                {["queued", "running", "pending"].includes(job.status) &&
                  !job.cancelRequested && (
                  <button
                    type="button"
                    onClick={() => void act(job.id, "cancel")}
                    className="h-8 border border-[#6f4f2f]/25 px-3 text-xs"
                  >
                    取消
                  </button>
                )}
                {job.retryable &&
                  ["failed", "cancelled", "interrupted"].includes(job.status) && (
                    <button
                      type="button"
                      onClick={() => void act(job.id, "retry")}
                      className="h-8 border border-[#8a5a2b] px-3 text-xs text-[#8a5a2b]"
                    >
                      重试
                    </button>
                  )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
