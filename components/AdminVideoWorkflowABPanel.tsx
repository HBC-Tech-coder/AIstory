"use client";

import { useEffect, useMemo, useState } from "react";

import { VideoStoryPlayer } from "@/components/VideoStoryPlayer";
import type {
  VideoWorkflowABCapabilityStatus,
  VideoWorkflowABExperimentDto,
  VideoWorkflowABReviewScores,
  VideoWorkflowABRunDto,
} from "@/lib/video-workflow-ab/types";

const SCORE_FIELDS: Array<{
  key: keyof VideoWorkflowABReviewScores;
  label: string;
}> = [
  { key: "firstFrameFidelity", label: "首帧参考忠实度" },
  { key: "lastFrameIdentityFidelity", label: "尾帧人物忠实度" },
  { key: "characterConsistency", label: "全程人物一致性" },
  { key: "motionCoherence", label: "运动连贯自然度" },
  { key: "artifactCleanliness", label: "伪影洁净度" },
];

const DEFAULT_SCORES: VideoWorkflowABReviewScores = {
  firstFrameFidelity: 3,
  lastFrameIdentityFidelity: 3,
  characterConsistency: 3,
  motionCoherence: 3,
  artifactCleanliness: 3,
};

type ReviewDraft = {
  scores: VideoWorkflowABReviewScores;
  note: string;
};

function statusLabel(status: VideoWorkflowABExperimentDto["status"]): string {
  return {
    planned: "计划中",
    completed: "已导入，待盲评",
    reviewed: "盲评完成",
    approved: "已批准",
    rejected: "已拒绝",
    offline: "已下线",
  }[status];
}

function RunPlayer({
  experimentId,
  run,
  selected,
  onSelect,
}: {
  experimentId: string;
  run: VideoWorkflowABRunDto;
  selected: boolean;
  onSelect: () => void;
}) {
  const output = run.output;
  return (
    <article
      className={`min-w-0 rounded-2xl border p-3 ${
        selected
          ? "border-ember-500 bg-ember-500/5"
          : "border-stone-200 bg-white"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {run.variantId
              ? `Variant ${run.variantId}`
              : `盲样 ${run.blindSlot === "left" ? "左" : "右"}`}
          </p>
          <p className="text-xs text-stone-500">
            {run.warmup ? "暖机，不计分" : `测量对 ${run.pairIndex}`} · 顺序{" "}
            {run.executionOrder}
          </p>
        </div>
        {!run.warmup && run.status === "succeeded" ? (
          <label className="flex items-center gap-2 text-xs text-stone-600">
            <input
              type="radio"
              name={`approved-run-${experimentId}`}
              checked={selected}
              onChange={onSelect}
            />
            作为候选
          </label>
        ) : null}
      </div>
      {output ? (
        <VideoStoryPlayer
          media={{
            kind: "video",
            url: output.previewUrl,
            durationMs: output.durationMs,
            hasAudio: output.hasAudio,
            allowSkip: true,
            hotspotsEnabled: false,
            endBehavior: "hold",
          }}
          muted
          dimmed={false}
          onComplete={() => undefined}
        />
      ) : (
        <div className="grid aspect-video place-items-center rounded-xl bg-stone-950 px-4 text-center text-sm text-stone-300">
          {run.status === "oom" ? "运行 OOM，无可播放产物" : "运行失败，无可播放产物"}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-stone-600 sm:grid-cols-4">
        <span>排队 {run.queuedMs}ms</span>
        <span>生成 {run.generationMs}ms</span>
        <span>总耗时 {run.totalMs}ms</span>
        <span>峰值 {run.peakVramMiB}MiB</span>
      </div>
    </article>
  );
}

export function AdminVideoWorkflowABPanel() {
  const [capability, setCapability] =
    useState<VideoWorkflowABCapabilityStatus | null>(null);
  const [experiments, setExperiments] = useState<
    VideoWorkflowABExperimentDto[]
  >([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedPair, setSelectedPair] = useState(0);
  const [selectedBlindRunId, setSelectedBlindRunId] = useState("");
  const [reason, setReason] = useState("");
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await fetch("/api/admin/video-workflow-ab", {
      cache: "no-store",
    });
    const result = (await response.json()) as {
      capability?: VideoWorkflowABCapabilityStatus;
      experiments?: VideoWorkflowABExperimentDto[];
      error?: string;
    };
    if (result.capability) setCapability(result.capability);
    if (result.experiments) {
      setExperiments(result.experiments);
      setSelectedId((current) => current || result.experiments?.[0]?.id || "");
    }
    if (!response.ok && result.error) setMessage(result.error);
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = useMemo(
    () => experiments.find((experiment) => experiment.id === selectedId),
    [experiments, selectedId],
  );
  const pairs = useMemo(
    () =>
      selected
        ? [...new Set(selected.runs.map((run) => run.pairIndex))].sort(
            (left, right) => left - right,
          )
        : [],
    [selected],
  );
  const visibleRuns = useMemo(
    () =>
      selected?.runs
        .filter((run) => run.pairIndex === selectedPair)
        .sort((left, right) => left.blindSlot.localeCompare(right.blindSlot)) ??
      [],
    [selected, selectedPair],
  );

  useEffect(() => {
    if (!pairs.includes(selectedPair)) setSelectedPair(pairs[0] ?? 0);
  }, [pairs, selectedPair]);

  function replaceExperiment(next: VideoWorkflowABExperimentDto) {
    setExperiments((current) => [
      next,
      ...current.filter((item) => item.id !== next.id),
    ]);
    setSelectedId(next.id);
  }

  async function importPackage(event: React.FormEvent) {
    event.preventDefault();
    if (!packageFile || reason.trim().length < 3) return;
    setBusy(true);
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", packageFile);
      form.set("reason", reason);
      const response = await fetch("/api/admin/video-workflow-ab", {
        method: "POST",
        headers: {
          "X-Idempotency-Key": `video-ab-import:${crypto.randomUUID()}`,
          "X-Request-Id": crypto.randomUUID(),
        },
        body: form,
      });
      const result = (await response.json()) as {
        experiment?: VideoWorkflowABExperimentDto;
        error?: string;
      };
      if (!response.ok || !result.experiment) {
        setMessage(result.error || "A/B 回传包导入失败。");
        return;
      }
      replaceExperiment(result.experiment);
      setPackageFile(null);
      setReason("");
      setMessage("回传包已进入实验暂存区，尚未纳入项目素材库。");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    if (!selected || reason.trim().length < 3) {
      setMessage("请填写至少 3 个字符的操作原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/video-workflow-ab/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Idempotency-Key": `video-ab:${action}:${crypto.randomUUID()}`,
            "X-Request-Id": crypto.randomUUID(),
          },
          body: JSON.stringify({ action, reason, ...extra }),
        },
      );
      const result = (await response.json()) as {
        experiment?: VideoWorkflowABExperimentDto;
        error?: string;
      };
      if (!response.ok || !result.experiment) {
        setMessage(result.error || "A/B 实验操作失败。");
        return;
      }
      replaceExperiment(result.experiment);
      setMessage(
        action === "adopt"
          ? "获批产物已加入项目素材库；进入剧情前仍需视频资产审核与发布。"
          : "A/B 实验状态已更新并写入审计。",
      );
    } finally {
      setBusy(false);
    }
  }

  function draftFor(run: VideoWorkflowABRunDto): ReviewDraft {
    return (
      reviewDrafts[run.blindId] ?? {
        scores: run.review?.scores ?? DEFAULT_SCORES,
        note: run.review?.note ?? "",
      }
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      <div>
        <h2 className="text-2xl font-semibold">A/B 视频实验</h2>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-stone-500">
          仅导入 GPU 电脑返回的固定格式 ZIP。基础 A/B 必须使用相同官方权重和生成语义，
          禁止第三方 LoRA 与混入后处理；导入不会自动进入素材库或公开剧情。
        </p>
      </div>

      {!capability?.available ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {capability?.reason || "A/B 实验能力未配置。"}生产仓储不会回落本地 JSON。
        </div>
      ) : (
        <form
          onSubmit={importPackage}
          className="grid gap-3 rounded-2xl border border-stone-200 bg-white p-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,1fr)_auto]"
        >
          <label className="min-w-0 text-sm">
            <span className="mb-1 block text-xs text-stone-500">A/B ZIP 回传包</span>
            <input
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              onChange={(event) => setPackageFile(event.target.files?.[0] ?? null)}
              className="block w-full min-w-0 text-xs"
            />
          </label>
          <label className="min-w-0 text-sm">
            <span className="mb-1 block text-xs text-stone-500">导入原因</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="必填，用于 append-only 审计"
              className="w-full rounded-xl border border-stone-300 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !packageFile || reason.trim().length < 3}
            className="self-end rounded-xl bg-ember-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            安全导入暂存区
          </button>
        </form>
      )}

      {message ? (
        <p className="rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm">
          {message}
        </p>
      ) : null}

      {experiments.length ? (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-2">
            {experiments.map((experiment) => (
              <button
                key={experiment.id}
                type="button"
                onClick={() => {
                  setSelectedId(experiment.id);
                  setSelectedPair(
                    Math.min(...experiment.runs.map((run) => run.pairIndex)),
                  );
                  setSelectedBlindRunId("");
                }}
                className={`w-full rounded-2xl border p-4 text-left ${
                  selectedId === experiment.id
                    ? "border-ember-500 bg-ember-500/5"
                    : "border-stone-200 bg-white"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{experiment.title}</span>
                  {experiment.synthetic ? (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-800">
                      SYNTHETIC
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  {statusLabel(experiment.status)} · 项目 {experiment.projectId}
                </p>
              </button>
            ))}
          </aside>

          {selected ? (
            <section className="min-w-0 space-y-4">
              <div className="rounded-2xl border border-stone-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{selected.title}</h3>
                    <p className="mt-1 text-xs text-stone-500">
                      {selected.environment.gpuModel} · ComfyUI{" "}
                      {selected.environment.comfyuiVersion} · seed{" "}
                      {selected.input.seed}
                    </p>
                  </div>
                  <span className="rounded-full border border-stone-300 px-3 py-1 text-xs">
                    {statusLabel(selected.status)}
                  </span>
                </div>
                {selected.synthetic ? (
                  <p className="mt-3 rounded-xl bg-violet-50 p-3 text-xs leading-5 text-violet-900">
                    这是合成测试夹具，只用于验证契约和界面，不能批准或纳入真实素材。
                  </p>
                ) : null}
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-[760px] text-left text-xs">
                    <thead className="text-stone-500">
                      <tr>
                        {[
                          "输入 SHA",
                          "采样语义",
                          "尺寸",
                          "帧/FPS",
                          "权重",
                          "后处理层",
                        ].map((label) => (
                          <th key={label} className="pr-5 font-medium">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="pr-5">{selected.input.imageSha256.slice(0, 12)}</td>
                        <td className="pr-5">
                          {selected.input.samplingSemanticsSha256.slice(0, 12)}
                        </td>
                        <td className="pr-5">
                          {selected.input.width}×{selected.input.height}
                        </td>
                        <td className="pr-5">
                          {selected.input.frameCount} / {selected.input.fps}
                        </td>
                        <td className="pr-5">{selected.weights.length} 个官方记录</td>
                        <td>{selected.postprocessLayerCount}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
                {pairs.map((pair) => (
                  <button
                    key={pair}
                    type="button"
                    onClick={() => setSelectedPair(pair)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${
                      selectedPair === pair
                        ? "bg-ember-500 text-white"
                        : "border border-stone-300 bg-white"
                    }`}
                  >
                    对照 {pair}
                  </button>
                ))}
              </div>

              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                {visibleRuns.map((run) => (
                  <RunPlayer
                    key={run.blindId}
                    experimentId={selected.id}
                    run={run}
                    selected={selectedBlindRunId === run.blindId}
                    onSelect={() => setSelectedBlindRunId(run.blindId)}
                  />
                ))}
              </div>

              {visibleRuns
                .filter(
                  (run) =>
                    !run.warmup &&
                    run.status === "succeeded" &&
                    selected.status === "completed",
                )
                .map((run) => {
                  const draft = draftFor(run);
                  return (
                    <form
                      key={`review-${run.blindId}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void mutate("review_run", {
                          blindRunId: run.blindId,
                          scores: draft.scores,
                          note: draft.note,
                        });
                      }}
                      className="rounded-2xl border border-stone-200 bg-white p-4"
                    >
                      <p className="font-medium">
                        {run.variantId
                          ? `Variant ${run.variantId}`
                          : `盲样 ${run.blindSlot === "left" ? "左" : "右"}`}{" "}
                        评分
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                        {SCORE_FIELDS.map((field) => (
                          <label key={field.key} className="text-xs text-stone-600">
                            {field.label}
                            <select
                              value={draft.scores[field.key]}
                              onChange={(event) =>
                                setReviewDrafts((current) => ({
                                  ...current,
                                  [run.blindId]: {
                                    ...draft,
                                    scores: {
                                      ...draft.scores,
                                      [field.key]: Number(event.target.value),
                                    },
                                  },
                                }))
                              }
                              className="mt-1 block w-full rounded-lg border border-stone-300 px-2 py-2"
                            >
                              {[1, 2, 3, 4, 5].map((score) => (
                                <option key={score} value={score}>
                                  {score}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                        <input
                          value={draft.note}
                          onChange={(event) =>
                            setReviewDrafts((current) => ({
                              ...current,
                              [run.blindId]: {
                                ...draft,
                                note: event.target.value,
                              },
                            }))
                          }
                          placeholder="可选盲评备注"
                          className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2 text-sm"
                        />
                        <button
                          type="submit"
                          disabled={busy || reason.trim().length < 3}
                          className="rounded-xl border border-ember-500 px-4 py-2 text-sm text-ember-500 disabled:opacity-40"
                        >
                          保存此盲样评分
                        </button>
                      </div>
                    </form>
                  );
                })}

              <div className="flex flex-wrap gap-2 rounded-2xl border border-stone-200 bg-white p-4">
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="必填操作原因"
                  className="min-w-[220px] flex-1 rounded-xl border border-stone-300 px-3 py-2 text-sm"
                />
                {selected.status === "completed" ? (
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !selected.eligibleForApproval ||
                      reason.trim().length < 3
                    }
                    onClick={() => void mutate("finalize_review")}
                    className="rounded-xl bg-ember-500 px-4 py-2 text-sm text-white disabled:opacity-40"
                  >
                    完成盲评
                  </button>
                ) : null}
                {selected.status === "reviewed" && !selected.revealed ? (
                  <button
                    type="button"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => void mutate("reveal")}
                    className="rounded-xl border border-ember-500 px-4 py-2 text-sm text-ember-500"
                  >
                    揭盲
                  </button>
                ) : null}
                {selected.status === "reviewed" && selected.revealed ? (
                  <>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        selected.synthetic ||
                        !selectedBlindRunId ||
                        reason.trim().length < 3
                      }
                      onClick={() =>
                        void mutate("approve", {
                          blindRunId: selectedBlindRunId,
                        })
                      }
                      className="rounded-xl bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-40"
                    >
                      批准所选 run
                    </button>
                    <button
                      type="button"
                      disabled={busy || reason.trim().length < 3}
                      onClick={() => void mutate("reject")}
                      className="rounded-xl border border-red-300 px-4 py-2 text-sm text-red-700 disabled:opacity-40"
                    >
                      拒绝实验
                    </button>
                  </>
                ) : null}
                {selected.status === "approved" ? (
                  <>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        selected.synthetic ||
                        Boolean(selected.adoptedProjectAssetId) ||
                        reason.trim().length < 3
                      }
                      onClick={() => void mutate("adopt")}
                      className="rounded-xl bg-ember-500 px-4 py-2 text-sm text-white disabled:opacity-40"
                    >
                      {selected.adoptedProjectAssetId
                        ? "已加入项目素材库"
                        : "加入项目素材库"}
                    </button>
                    <button
                      type="button"
                      disabled={busy || reason.trim().length < 3}
                      onClick={() => void mutate("offline")}
                      className="rounded-xl border border-stone-400 px-4 py-2 text-sm"
                    >
                      下线实验
                    </button>
                  </>
                ) : null}
              </div>
              <p className="text-xs leading-5 text-stone-500">
                获批结果加入项目素材库后仍不是玩家可见视频；绑定互动剧情前必须进入“视频资产”
                完成草稿、审核和可发布状态门。
              </p>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center">
          <p className="font-medium text-stone-800">暂无 A/B 实验</p>
          <p className="mt-2 text-sm text-stone-500">
            本页面不会连接 ComfyUI；只有通过安全导入器的本地回传包才会出现。
          </p>
        </div>
      )}
    </div>
  );
}
