"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  VideoAssetCapabilityStatus,
  VideoAssetDto,
} from "@/lib/video-assets/types";
import type {
  ComfyUIProviderStatus,
} from "@/lib/providers/comfyui/types";
import type { GenerationJob } from "@/lib/generation-jobs/types";

type WorkflowSummary = {
  id: string;
  name: string;
  modality: "image" | "video";
  enabled: boolean;
  activeVersion: number;
};

type AssetResponse = {
  capability: VideoAssetCapabilityStatus;
  assets: VideoAssetDto[];
};

function isAssetResponse(value: unknown): value is AssetResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AssetResponse>;
  return !!record.capability
    && typeof record.capability === "object"
    && typeof record.capability.available === "boolean"
    && typeof record.capability.uploadAvailable === "boolean"
    && Array.isArray(record.assets);
}

const STATUS_LABEL: Record<VideoAssetDto["status"], string> = {
  draft: "草稿",
  review_pending: "待审核",
  publishable: "可发布",
  offline: "已下线",
};

function idempotency(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function AdminVideoAssetsPanel() {
  const [data, setData] = useState<AssetResponse | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [providerStatus, setProviderStatus] =
    useState<ComfyUIProviderStatus | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [storyId, setStoryId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [releasePolicy, setReleasePolicy] =
    useState<"public" | "internal" | "enterprise">("public");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [workflowId, setWorkflowId] = useState("");
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");

  const reload = useCallback(async () => {
    const [assetsResult, statusResult, workflowResult, jobsResult] =
      await Promise.all([
        fetch("/api/admin/video-assets", { cache: "no-store" }),
        fetch("/api/providers/comfyui/status", { cache: "no-store" }),
        fetch("/api/providers/comfyui/workflows", { cache: "no-store" }),
        fetch("/api/generation-jobs", { cache: "no-store" }),
      ]);
    const assetsPayload = await assetsResult.json().catch(() => null);
    setData(isAssetResponse(assetsPayload) ? assetsPayload : null);
    if (!assetsResult.ok) {
      setMessage("视频资产状态不可用。");
    }
    const statusPayload = (await statusResult.json().catch(() => null)) as
      | ComfyUIProviderStatus
      | null;
    setProviderStatus(statusPayload);
    if (workflowResult.ok) {
      const payload = (await workflowResult.json()) as {
        templates?: WorkflowSummary[];
      };
      const videoWorkflows = (payload.templates || []).filter(
        (template) => template.enabled && template.modality === "video",
      );
      setWorkflows(videoWorkflows);
      setWorkflowId((previous) => previous || videoWorkflows[0]?.id || "");
    } else {
      setWorkflows([]);
    }
    if (jobsResult.ok) {
      const payload = (await jobsResult.json()) as { jobs?: GenerationJob[] };
      setJobs((payload.jobs || []).filter((job) => job.modality === "video"));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!jobs.some((job) => ["queued", "running", "pending"].includes(job.status))) {
      return;
    }
    const timer = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(timer);
  }, [jobs, reload]);

  const generationAvailable =
    providerStatus?.state === "ready" &&
    providerStatus.modalities.video &&
    workflows.length > 0;
  const productionProjectRequired =
    data?.capability.adapter === "production_object_storage";
  const parsedProjectId = Number(projectId);
  const validProjectId = Number.isSafeInteger(parsedProjectId)
    && parsedProjectId > 0;

  const bindingPayload = useMemo(
    () => ({
      projectId: projectId ? Number(projectId) : undefined,
      storyId: storyId || undefined,
      nodeId: nodeId || undefined,
      releasePolicy,
    }),
    [nodeId, projectId, releasePolicy, storyId],
  );

  async function upload() {
    if (
      !uploadFile
      || !title.trim()
      || (productionProjectRequired && !validProjectId)
    ) return;
    setBusy(true);
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", uploadFile);
      form.set("title", title.trim());
      if (subtitleFile) form.set("subtitle", subtitleFile);
      if (bindingPayload.projectId) {
        form.set("projectId", String(bindingPayload.projectId));
      }
      if (bindingPayload.storyId) form.set("storyId", bindingPayload.storyId);
      if (bindingPayload.nodeId) form.set("nodeId", bindingPayload.nodeId);
      form.set("releasePolicy", releasePolicy);
      const response = await fetch("/api/admin/video-assets", {
        method: "POST",
        headers: { "X-Idempotency-Key": idempotency("video-upload") },
        body: form,
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "上传失败。");
      setUploadFile(null);
      setSubtitleFile(null);
      setMessage("视频已作为草稿入库，仍需提交审核并批准。");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败。");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(
    asset: VideoAssetDto,
    action:
      | "submit_review"
      | "approve"
      | "offline"
      | "restore_draft"
      | "bind",
  ) {
    const reason = window.prompt("请输入本次操作原因（会进入审计记录）");
    if (!reason?.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/video-assets/${encodeURIComponent(asset.id)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Idempotency-Key": idempotency(`video-${action}`),
          },
          body: JSON.stringify({
            action,
            reason,
            ...(action === "bind"
              ? { ...bindingPayload, title: title.trim() || asset.title }
              : {}),
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "操作失败。");
      setMessage("视频资产状态已更新。");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!generationAvailable || !workflowId || !generationPrompt.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/generation-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "comfyui",
          input: {
            workflowId,
            modality: "video",
            prompt: generationPrompt.trim(),
            negativePrompt: negativePrompt.trim() || undefined,
            orientation: "landscape",
            idempotencyKey: idempotency("admin-video-generation"),
          },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "视频任务提交失败。");
      setMessage("视频生成中，故事继续。完成后还需纳管、审核和发布。");
      await reload();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "视频任务提交失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function adopt(job: GenerationJob) {
    if (
      !data?.capability.uploadAvailable
      || !title.trim()
      || (productionProjectRequired && !validProjectId)
    ) {
      setMessage("请先填写资产标题和绑定信息，再纳管生成结果。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/video-assets/adopt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": `video-adopt:${job.id}`,
        },
        body: JSON.stringify({
          jobId: job.id,
          title: title.trim(),
          ...bindingPayload,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "纳管失败。");
      setMessage("生成结果已纳管为草稿，尚未自动上线。");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "纳管失败。");
    } finally {
      setBusy(false);
    }
  }

  async function changeJob(job: GenerationJob, action: "cancel" | "retry") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/generation-jobs/${encodeURIComponent(job.id)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "任务操作失败。");
      setMessage(
        action === "cancel"
          ? "已请求取消；若生成端已开始，任务会按实际能力结束或标记取消。"
          : "任务已重新排队。",
      );
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务操作失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">视频资产</h2>
        <p className="mt-1 text-sm leading-6 text-stone-500">
          上传或生成的内容必须经过“草稿 → 待审核 → 可发布”；不会自动写入
          public，也不会自动进入玩家剧情。
        </p>
      </div>

      {message && (
        <p className="rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm">
          {message}
        </p>
      )}

      {!data?.capability.available ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
          <p className="font-semibold">视频资产写入当前不可用</p>
          <p className="mt-1">
            {data?.capability.reason ||
              "正在读取能力状态。生产对象存储或本地 ffprobe 未配置时系统会保持关闭。"}
          </p>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <h3 className="font-semibold">上传视频草稿</h3>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            仅 MP4/WebM；服务端校验内容、编码、时长和分辨率，不信任扩展名。
          </p>
          {productionProjectRequired && (
            <p className="mt-1 text-xs leading-5 text-amber-800">
              生产对象存储上传必须绑定有效项目 ID。
            </p>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="资产标题"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              inputMode="numeric"
              placeholder="项目 ID"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={storyId}
              onChange={(event) => setStoryId(event.target.value)}
              placeholder="作品 ID"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
              placeholder="剧情节点 ID"
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <select
              value={releasePolicy}
              onChange={(event) =>
                setReleasePolicy(
                  event.target.value as "public" | "internal" | "enterprise",
                )
              }
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="public">公开</option>
              <option value="internal">内部</option>
              <option value="enterprise">企业</option>
            </select>
            <label className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
              <span className="block text-xs text-stone-500">视频文件</span>
              <input
                type="file"
                accept="video/mp4,video/webm"
                onChange={(event) =>
                  setUploadFile(event.target.files?.[0] || null)
                }
                className="mt-1 block w-full text-xs"
              />
            </label>
            <label className="rounded-lg border border-stone-300 px-3 py-2 text-sm sm:col-span-2">
              <span className="block text-xs text-stone-500">
                可选 WebVTT 字幕
              </span>
              <input
                type="file"
                accept=".vtt,text/vtt"
                onChange={(event) =>
                  setSubtitleFile(event.target.files?.[0] || null)
                }
                className="mt-1 block w-full text-xs"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={
              busy ||
              !data?.capability.uploadAvailable ||
              !uploadFile ||
              !title.trim() ||
              (productionProjectRequired && !validProjectId)
            }
            onClick={() => void upload()}
            className="mt-4 rounded-lg bg-ember-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            上传为草稿
          </button>
        </section>

        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <h3 className="font-semibold">生成视频草稿</h3>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            仅使用已注册且启用的安全 workflow。生成成功后仍需手动纳管、审核和发布。
          </p>
          <select
            value={workflowId}
            onChange={(event) => setWorkflowId(event.target.value)}
            className="mt-4 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          >
            <option value="">选择视频 workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name} · v{workflow.activeVersion}
              </option>
            ))}
          </select>
          <textarea
            value={generationPrompt}
            onChange={(event) => setGenerationPrompt(event.target.value)}
            placeholder="视频画面描述"
            className="mt-3 min-h-24 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <textarea
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
            placeholder="可选：排除内容"
            className="mt-3 min-h-16 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={
              busy ||
              !generationAvailable ||
              !workflowId ||
              !generationPrompt.trim()
            }
            onClick={() => void generate()}
            className="mt-3 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            生成视频
          </button>
          {!generationAvailable && (
            <p className="mt-3 text-xs text-amber-800">
              ComfyUI 视频能力或安全 workflow 不可用，生成入口已关闭。
            </p>
          )}
        </section>
      </div>

      {jobs.length > 0 && (
        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <h3 className="font-semibold">视频生成任务</h3>
          <div className="mt-3 space-y-2">
            {jobs.slice(0, 12).map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-200 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs">{job.id.slice(0, 12)}</span>
                <span>{job.status}</span>
                <span className="text-stone-500">{job.progress}%</span>
                {["queued", "running", "pending"].includes(job.status) && (
                  <>
                    <span className="text-amber-700">
                      视频生成中，故事继续
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void changeJob(job, "cancel")}
                      className="ml-auto rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50"
                    >
                      取消
                    </button>
                  </>
                )}
                {(job.status === "failed" ||
                  job.status === "interrupted") &&
                  job.retryable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void changeJob(job, "retry")}
                      className="ml-auto rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50"
                    >
                      重试
                    </button>
                  )}
                {job.status === "succeeded" && job.artifact && (
                  <button
                    type="button"
                    disabled={
                      busy
                      || !data?.capability.uploadAvailable
                      || !title.trim()
                      || (productionProjectRequired && !validProjectId)
                    }
                    onClick={() => void adopt(job)}
                    className="ml-auto rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50"
                  >
                    纳管为草稿
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">资产列表</h3>
          <span className="text-xs text-stone-500">
            {data?.assets.length || 0} 项
          </span>
        </div>
        {data?.assets.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.assets.map((asset) => (
              <article
                key={asset.id}
                className="min-w-0 rounded-2xl border border-stone-200 bg-white p-4"
              >
                <video
                  controls
                  preload="metadata"
                  src={asset.previewUrl}
                  className="aspect-video w-full rounded-xl bg-black object-contain"
                />
                <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate font-medium">{asset.title}</h4>
                    <p className="mt-1 text-xs text-stone-500">
                      {asset.width}×{asset.height} ·{" "}
                      {Math.round(asset.durationMs / 1000)} 秒 ·{" "}
                      {asset.videoCodec}
                      {asset.audioCodec ? `/${asset.audioCodec}` : ""}
                    </p>
                  </div>
                  <span className="rounded-full bg-stone-100 px-2 py-1 text-xs">
                    {STATUS_LABEL[asset.status]}
                  </span>
                </div>
                <p className="mt-2 break-all text-xs text-stone-500">
                  项目 {asset.projectId || "未绑定"} · 作品{" "}
                  {asset.storyId || "未绑定"} · 节点 {asset.nodeId || "未绑定"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {asset.status === "draft" && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void mutate(asset, "bind")}
                        className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50"
                      >
                        更新绑定
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void mutate(asset, "submit_review")}
                        className="rounded-lg border border-amber-500 px-3 py-1.5 text-xs text-amber-800"
                      >
                        提交审核
                      </button>
                    </>
                  )}
                  {asset.status === "review_pending" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(asset, "approve")}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs text-white"
                    >
                      批准发布候选
                    </button>
                  )}
                  {asset.status === "publishable" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(asset, "offline")}
                      className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs text-white"
                    >
                      下线
                    </button>
                  )}
                  {asset.status === "offline" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(asset, "restore_draft")}
                      className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs"
                    >
                      恢复草稿
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-10 text-center text-sm text-stone-500">
            尚无视频资产。未配置存储时这里保持真实空状态。
          </div>
        )}
      </section>
    </div>
  );
}
