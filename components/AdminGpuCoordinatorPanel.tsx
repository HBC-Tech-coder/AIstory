"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Capability = {
  enabled: boolean;
  ready: boolean;
  mode: "disabled" | "lan_lab";
  reason: string;
  workflowCount: number;
  concurrency: 1;
  speculativePrefetch: false;
};

type RecentJob = {
  jobId: string;
  taskType: "generate" | "upscale";
  status: string;
  progress: number;
  artifactUrl?: string;
  sourceJobId?: string;
  createdAt: string;
};

type Status = {
  mode: "disabled" | "lan_lab";
  state: "offline" | "online";
  lastHeartbeatAt?: string;
  activeJob?: {
    jobId: string;
    status: string;
    progress: number;
    cancelRequested: boolean;
  };
  recentJobs: RecentJob[];
  workflowCount: number;
  concurrency: 1;
  speculativePrefetch: false;
};

type Workflow = {
  workflowId: string;
  workflowSha256: string;
  purpose: "generate" | "upscale";
  modality: "video";
  fixedParameters: {
    width: number;
    height: number;
    frames: number;
    fps: number;
    seed?: number;
    preserveAudio?: true;
  };
  inputSlots: readonly (
    | "referenceImage"
    | "firstFrame"
    | "lastFrame"
    | "sourceVideo"
  )[];
};

export function AdminGpuCoordinatorPanel() {
  const [capability, setCapability] = useState<Capability>();
  const [status, setStatus] = useState<Status>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [prompt, setPrompt] = useState("");

  const generateWorkflows = useMemo(
    () => workflows.filter((item) => item.purpose === "generate"),
    [workflows],
  );
  const upscaleWorkflow = useMemo(
    () => workflows.find((item) => item.purpose === "upscale"),
    [workflows],
  );

  const refresh = useCallback(async () => {
    const response = await fetch("/api/admin/gpu-coordinator", {
      cache: "no-store",
    });
    if (!response.ok) {
      setMessage("协调器状态暂不可用。");
      return;
    }
    const result = (await response.json()) as {
      capability: Capability;
      status: Status;
      workflows: Workflow[];
    };
    setCapability(result.capability);
    setStatus(result.status);
    setWorkflows(result.workflows);
    const firstGenerate = result.workflows.find(
      (item) => item.purpose === "generate",
    );
    setWorkflowId((current) => current || firstGenerate?.workflowId || "");
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function cancel() {
    if (!status?.activeJob) return;
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/gpu-coordinator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "cancel",
        jobId: status.activeJob.jobId,
      }),
    });
    setBusy(false);
    setMessage(
      response.ok
        ? "已请求取消；Connector 将在下一次轮询时收到。"
        : "取消请求未被接受。",
    );
    await refresh();
  }

  async function submitGenerate() {
    const workflow = generateWorkflows.find(
      (item) => item.workflowId === workflowId,
    );
    if (
      !workflow ||
      !prompt.trim() ||
      workflow.fixedParameters.seed === undefined
    ) {
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/gpu-coordinator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "submit-generate",
        input: {
          workflowId: workflow.workflowId,
          workflowSha256: workflow.workflowSha256,
          prompt,
          seed: workflow.fixedParameters.seed,
          width: workflow.fixedParameters.width,
          height: workflow.fixedParameters.height,
          frames: workflow.fixedParameters.frames,
          fps: workflow.fixedParameters.fps,
          idempotencyKey: crypto.randomUUID(),
        },
      }),
    });
    setBusy(false);
    setMessage(
      response.ok
        ? "原始视频任务已进入 AIstory LAN LAB 单并发队列。"
        : "任务未提交；请检查 Connector 与工作流准入配置。",
    );
    await refresh();
  }

  async function submitUpscale(sourceJobId: string) {
    if (!upscaleWorkflow) return;
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/gpu-coordinator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "submit-upscale",
        input: {
          workflowId: upscaleWorkflow.workflowId,
          workflowSha256: upscaleWorkflow.workflowSha256,
          sourceJobId,
          width: upscaleWorkflow.fixedParameters.width,
          height: upscaleWorkflow.fixedParameters.height,
          frames: upscaleWorkflow.fixedParameters.frames,
          fps: upscaleWorkflow.fixedParameters.fps,
          preserveAudio: true,
          idempotencyKey: crypto.randomUUID(),
        },
      }),
    });
    setBusy(false);
    setMessage(
      response.ok
        ? "独立超分任务已进入队列；原视频不会被覆盖。"
        : "超分任务未提交。",
    );
    await refresh();
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold">GPU Connector LAN LAB</h2>
        <p className="mt-1 text-sm text-stone-500">
          默认关闭、单连接器、单并发。原视频生成与视频超分是两个独立任务。
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl border border-stone-200 bg-white p-5">
          <p className="text-xs text-stone-500">连接状态</p>
          <p className="mt-2 text-xl font-semibold">
            {status?.state === "online" ? "在线" : "离线"}
          </p>
        </article>
        <article className="rounded-2xl border border-stone-200 bg-white p-5">
          <p className="text-xs text-stone-500">配置状态</p>
          <p className="mt-2 text-xl font-semibold">
            {capability?.ready ? "可联调" : "未就绪"}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            {capability?.reason ?? "loading"}
          </p>
        </article>
        <article className="rounded-2xl border border-stone-200 bg-white p-5">
          <p className="text-xs text-stone-500">已准入工作流</p>
          <p className="mt-2 text-xl font-semibold">
            {status?.workflowCount ?? 0}
          </p>
        </article>
        <article className="rounded-2xl border border-stone-200 bg-white p-5">
          <p className="text-xs text-stone-500">视频超分</p>
          <p className="mt-2 text-xl font-semibold">
            {upscaleWorkflow ? "可联调" : "等待 4090"}
          </p>
          <p className="mt-1 text-xs text-stone-500">独立任务，不改原工作流</p>
        </article>
      </div>
      <article className="rounded-2xl border border-stone-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">当前任务</p>
            {status?.activeJob ? (
              <p className="mt-1 text-sm text-stone-500">
                {status.activeJob.status} · {status.activeJob.progress}%
                {status.activeJob.cancelRequested ? " · 已请求取消" : ""}
              </p>
            ) : (
              <p className="mt-1 text-sm text-stone-500">无活动任务</p>
            )}
          </div>
          <button
            type="button"
            disabled={busy || !status?.activeJob}
            onClick={cancel}
            className="rounded-xl border border-red-300 px-4 py-2 text-sm text-red-700 disabled:opacity-40"
          >
            请求取消
          </button>
        </div>
        {status?.lastHeartbeatAt ? (
          <p className="mt-3 text-xs text-stone-500">
            最近心跳：{new Date(status.lastHeartbeatAt).toLocaleString()}
          </p>
        ) : null}
        {message ? <p className="mt-3 text-sm text-stone-600">{message}</p> : null}
      </article>
      <article className="rounded-2xl border border-stone-200 bg-white p-5">
        <h3 className="font-medium">提交原始视频任务</h3>
        <p className="mt-1 text-xs text-stone-500">
          参数由冻结工作流固定；当前原版保持 768×480、81 帧、24 FPS。
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(180px,260px)_minmax(0,1fr)_auto]">
          <select
            value={workflowId}
            onChange={(event) => setWorkflowId(event.target.value)}
            className="min-w-0 rounded-xl border border-stone-300 px-3 py-2.5 text-sm"
          >
            <option value="">无已准入生成工作流</option>
            {generateWorkflows.map((item) => (
              <option key={item.workflowId} value={item.workflowId}>
                {item.workflowId}
              </option>
            ))}
          </select>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="视频提示词（仅发送给已认证 Connector）"
            className="min-w-0 rounded-xl border border-stone-300 px-3 py-2.5 text-sm"
          />
          <button
            type="button"
            disabled={
              busy ||
              !capability?.ready ||
              !workflowId ||
              !prompt.trim() ||
              Boolean(status?.activeJob)
            }
            onClick={submitGenerate}
            className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm text-white disabled:opacity-40"
          >
            开始生成
          </button>
        </div>
      </article>
      <article className="rounded-2xl border border-stone-200 bg-white p-5">
        <h3 className="font-medium">最近视频与独立超分</h3>
        <p className="mt-1 text-xs text-stone-500">
          超分会生成新文件并保留音轨；游戏字幕仍由播放器叠加，不烧进视频。
        </p>
        <div className="mt-4 space-y-2">
          {(status?.recentJobs ?? []).length ? (
            status!.recentJobs.map((job) => {
              const canUpscale =
                job.taskType === "generate" &&
                job.status === "succeeded" &&
                Boolean(job.artifactUrl) &&
                Boolean(upscaleWorkflow) &&
                !status?.activeJob;
              return (
                <div
                  key={job.jobId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {job.taskType === "generate" ? "原视频" : "超分视频"} · {job.status}
                    </p>
                    <p className="truncate text-xs text-stone-500">{job.jobId}</p>
                  </div>
                  {job.artifactUrl ? (
                    <a
                      href={job.artifactUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-blue-700"
                    >
                      查看视频
                    </a>
                  ) : null}
                  {job.taskType === "generate" ? (
                    <button
                      type="button"
                      disabled={busy || !canUpscale}
                      onClick={() => submitUpscale(job.jobId)}
                      className="rounded-lg border border-blue-300 px-3 py-1.5 text-sm text-blue-700 disabled:opacity-40"
                    >
                      {upscaleWorkflow ? "升至 720p" : "等待超分工作流"}
                    </button>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="text-sm text-stone-500">暂无 LAN LAB 视频任务。</p>
          )}
        </div>
      </article>
    </div>
  );
}
