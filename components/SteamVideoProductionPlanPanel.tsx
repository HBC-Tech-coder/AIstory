"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  serializeSteamVideoProductionPlanCsv,
  serializeSteamVideoProductionPlanJson,
  STEAM_VIDEO_PRODUCTION_PLAN_CSV_FILENAME,
  STEAM_VIDEO_PRODUCTION_PLAN_JSON_FILENAME,
  STEAM_VIDEO_PRODUCTION_PLAN_STAGES,
  STEAM_VIDEO_PRODUCTION_PLAN_STATUSES,
  type SteamVideoProductionPlan,
  type SteamVideoProductionPlanStage,
  type SteamVideoProductionPlanStatus,
} from "@/lib/steam/productionPlan";

type TaskFilter = "all" | SteamVideoProductionPlanStatus;
type StageFilter = "all" | SteamVideoProductionPlanStage;

const STATUS_LABELS: Record<SteamVideoProductionPlanStatus, string> = {
  missing_source: "缺素材",
  blocked: "阻断",
  ready: "可排队",
  queued: "已排队",
  generated: "已生成",
  upscale_pending: "待升分",
  review_pending: "待审核",
  approved: "已批准",
  published: "已发布",
};

const STAGE_LABELS: Record<SteamVideoProductionPlanStage, string> = {
  original_video: "原始视频",
  upscale: "独立升分",
  subtitle_audio_attach: "字幕 / 音频挂接",
  review: "审核",
  publish: "发布",
};

const BLOCKER_LABELS: Record<string, string> = {
  release_story_not_designated: "尚未指定唯一首发剧情",
  authoritative_graph_invalid: "权威公开剧情图未通过校验",
  source_media_missing: "公开源素材缺失",
  workflow_capability_missing: "缺少精确注册的 workflow 能力",
  workflow_pin_missing: "历史任务缺少精确 workflow 固定",
  non_publishable_job: "现有 LAN LAB 结果不可发布",
  job_artifact_missing: "任务成功记录缺少可用产物",
  job_stage_mismatch: "任务媒体类型或阶段与计划不一致",
  ambiguous_job_binding: "任务绑定不唯一",
  ambiguous_asset_binding: "视频资产绑定不唯一",
  dependency_not_ready: "上游阶段尚未完成",
  video_asset_not_adopted: "尚未纳入视频资产审核链",
  attach_capability_missing: "字幕 / 音频挂接能力尚未注册",
  asset_offline: "视频资产已下线",
  release_policy_not_public: "资产发布策略不是 public",
};

function downloadText(filename: string, contentType: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: contentType }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="ui-surface-soft min-w-0 rounded-2xl border p-3">
      <div className="ui-muted text-xs">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SteamVideoProductionPlanPanel() {
  const [plan, setPlan] = useState<SteamVideoProductionPlan | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/steam/video-production-plan", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("production_plan_unavailable");
      const next = (await response.json()) as SteamVideoProductionPlan;
      setPlan(next);
      setState("ready");
    } catch {
      setPlan(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleTasks = useMemo(
    () =>
      (plan?.tasks ?? []).filter(
        (task) =>
          (statusFilter === "all" || task.status === statusFilter) &&
          (stageFilter === "all" || task.stage === stageFilter),
      ),
    [plan, stageFilter, statusFilter],
  );

  return (
    <section
      className="min-h-[calc(100vh-65px)] min-w-0 max-w-full overflow-x-hidden bg-[var(--background)] px-4 py-6 sm:px-6 lg:px-8"
      data-steam-video-production-plan
    >
      <div className="mx-auto min-w-0 max-w-7xl space-y-5">
        <header className="ui-surface rounded-3xl border p-5 sm:p-6">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">
                Steam launch · plan only
              </div>
              <h1 className="mt-2 break-words font-serif text-2xl sm:text-3xl">
                首发视频生产计划
              </h1>
              <p className="ui-muted mt-2 max-w-3xl text-sm leading-6">
                只读计划模式：未连接、未探测、未运行 GPU。这里不会提交模型任务、上传素材、审核或发布。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ui-button-secondary"
                onClick={() => void load()}
                disabled={state === "loading"}
                data-plan-refresh
              >
                {state === "loading" ? "读取中…" : "刷新快照"}
              </button>
              <button
                type="button"
                className="ui-button-secondary"
                disabled={!plan}
                onClick={() =>
                  plan &&
                  downloadText(
                    STEAM_VIDEO_PRODUCTION_PLAN_JSON_FILENAME,
                    "application/json;charset=utf-8",
                    serializeSteamVideoProductionPlanJson(plan),
                  )
                }
                data-plan-export-json
              >
                导出脱敏 JSON
              </button>
              <button
                type="button"
                className="ui-button-secondary"
                disabled={!plan}
                onClick={() =>
                  plan &&
                  downloadText(
                    STEAM_VIDEO_PRODUCTION_PLAN_CSV_FILENAME,
                    "text/csv;charset=utf-8",
                    serializeSteamVideoProductionPlanCsv(plan),
                  )
                }
                data-plan-export-csv
              >
                导出脱敏 CSV
              </button>
            </div>
          </div>
        </header>

        {state === "error" ? (
          <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            生产计划暂不可用；未执行任何任务或外部连接。
          </div>
        ) : null}

        {plan ? (
          <>
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
              <StatCard label="任务总数" value={plan.summary.total} />
              <StatCard label="可排队" value={plan.summary.ready} />
              <StatCard label="阻断" value={plan.summary.blocked} />
              <StatCard label="缺素材" value={plan.summary.missing_source} />
              <StatCard label="已生成" value={plan.summary.generated} />
              <StatCard label="待审核" value={plan.summary.review_pending} />
              <StatCard label="已批准" value={plan.summary.approved} />
              <StatCard label="已发布" value={plan.summary.published} />
            </div>

            <div className="ui-surface min-w-0 rounded-3xl border p-4 sm:p-5">
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="min-w-0">
                  <div className="ui-muted text-xs">首发内容</div>
                  <div className="mt-1 break-all text-sm font-semibold">
                    {plan.designation.status === "designated"
                      ? plan.designation.storyId
                      : plan.designation.blockedReason}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="ui-muted text-xs">版本</div>
                  <div className="mt-1 break-all text-sm font-semibold">
                    {plan.designation.status === "designated"
                      ? plan.designation.version
                      : "未指定"}
                  </div>
                </div>
                <div>
                  <div className="ui-muted text-xs">原片能力</div>
                  <div className="mt-1 text-sm font-semibold">
                    {plan.capabilities.originalVideo.state === "available"
                      ? `已注册 ${plan.capabilities.originalVideo.enabledTemplateCount}`
                      : "缺少已启用 video workflow"}
                  </div>
                </div>
                <div>
                  <div className="ui-muted text-xs">独立升分能力</div>
                  <div className="mt-1 text-sm font-semibold">
                    {plan.capabilities.upscale.state === "available"
                      ? `已注册 ${plan.capabilities.upscale.enabledTemplateCount}`
                      : "未登记可验证 purpose"}
                  </div>
                </div>
              </div>
              {plan.designation.status === "blocked" &&
              plan.designation.candidates.length > 0 ? (
                <div
                  className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                  data-plan-readonly-candidates
                >
                  <div className="font-semibold">可只读核对的候选内容</div>
                  <ul className="mt-2 space-y-1">
                    {plan.designation.candidates.map((candidate) => (
                      <li key={`${candidate.caseId}:${candidate.version}`} className="break-all">
                        {candidate.caseId} · {candidate.version} · {candidate.publicNodeCount} 个公开节点
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="ui-surface min-w-0 rounded-3xl border p-4 sm:p-5">
              <h2 className="font-serif text-xl">依赖批次</h2>
              <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {plan.batches.map((batch) => (
                  <div key={batch.batch} className="ui-surface-soft min-w-0 rounded-2xl border p-3">
                    <div className="text-xs font-semibold text-violet-700">
                      Batch {batch.batch}
                    </div>
                    <div className="mt-1 break-words text-sm font-semibold">
                      {STAGE_LABELS[batch.stage]}
                    </div>
                    <div className="ui-muted mt-2 text-xs">
                      {batch.taskIds.length} 个不可变任务
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="ui-surface min-w-0 rounded-3xl border p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="font-serif text-xl">任务清单</h2>
                  <p className="ui-muted mt-1 text-xs">
                    显示 {visibleTasks.length} / {plan.tasks.length}；不包含提示词、workflow、provider task 或路径。
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs">
                    <span className="ui-muted mb-1 block">阶段</span>
                    <select
                      className="ui-input min-w-0"
                      value={stageFilter}
                      onChange={(event) => setStageFilter(event.target.value as StageFilter)}
                      data-plan-stage-filter
                    >
                      <option value="all">全部阶段</option>
                      {STEAM_VIDEO_PRODUCTION_PLAN_STAGES.map((stage) => (
                        <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    <span className="ui-muted mb-1 block">状态</span>
                    <select
                      className="ui-input min-w-0"
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value as TaskFilter)}
                      data-plan-status-filter
                    >
                      <option value="all">全部状态</option>
                      {STEAM_VIDEO_PRODUCTION_PLAN_STATUSES.map((status) => (
                        <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
                {visibleTasks.map((task) => (
                  <article
                    key={task.taskId}
                    className="ui-surface-soft min-w-0 rounded-2xl border p-4"
                    data-plan-task={task.taskId}
                  >
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-violet-700">
                          Batch {task.batch} · {STAGE_LABELS[task.stage]}
                        </div>
                        <div className="mt-1 break-all text-sm font-semibold">
                          {task.nodeId}
                        </div>
                        <div className="ui-muted mt-1 break-all text-xs">
                          {task.sceneId} · {task.episodeId}
                        </div>
                      </div>
                      <span className="rounded-full border px-2.5 py-1 text-xs font-semibold">
                        {STATUS_LABELS[task.status]}
                      </span>
                    </div>
                    <div className="ui-muted mt-3 break-all font-mono text-[11px]">
                      {task.taskId}
                    </div>
                    {task.blockerCodes.length ? (
                      <ul className="mt-3 space-y-1 text-xs text-amber-800">
                        {task.blockerCodes.map((code) => (
                          <li key={code}>• {BLOCKER_LABELS[code] ?? code}</li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
