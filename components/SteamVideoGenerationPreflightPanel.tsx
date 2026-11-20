"use client";

import { useCallback, useEffect, useState } from "react";

import {
  serializeSteamVideoGenerationPreflightCsv,
  serializeSteamVideoGenerationPreflightJson,
  STEAM_VIDEO_GENERATION_PREFLIGHT_CSV_FILENAME,
  STEAM_VIDEO_GENERATION_PREFLIGHT_JSON_FILENAME,
} from "@/lib/steam/productionSpecPublic";
import type {
  SteamVideoGenerationLabBlocker,
  SteamVideoGenerationMissingField,
  SteamVideoGenerationPreflightBlocker,
  SteamVideoGenerationPreflightPackage,
} from "@/lib/steam/productionSpec";

const BLOCKER_LABELS: Record<SteamVideoGenerationPreflightBlocker, string> = {
  authoritative_spec_invalid: "权威镜头规格不完整或不一致",
  missing_shot_spec: "缺少结构化镜头参数",
  plan_task_not_ready: "P1.4 原片任务当前不可预检映射",
  source_reference_not_prepared: "公开源图尚未准备为受控 workflow 引用",
  publishable_workflow_missing: "缺少已验证的可发布 video workflow",
  workflow_ambiguous: "存在多个可发布 workflow，无法唯一固定",
  workflow_disabled: "目标 workflow 未启用",
  workflow_wrong_modality: "目标 workflow 不是 video 模态",
  workflow_capability_mismatch: "workflow 缺少声明的发布级能力",
  workflow_pin_stale: "workflow 版本或 fingerprint 已变化",
  workflow_duration_unsupported: "workflow 不支持精确 30 秒发布时长",
  workflow_release_policy_mismatch: "workflow 与发布分辨率、帧率或音画策略不一致",
  non_publishable_workflow: "workflow 被标记为不可发布",
  release_target_mismatch: "权威镜头与 Steam 发布目标不一致",
  upscale_adapter_unavailable: "尚无已验证的发布级独立升分适配器",
};

const LAB_BLOCKER_LABELS: Record<SteamVideoGenerationLabBlocker, string> = {
  lab_candidate_missing: "当前只读快照没有对应的 LAB candidate",
  lab_candidate_ambiguous: "LAB candidate 不唯一",
  lab_candidate_mismatch: "LAB candidate 与固定试片规格不一致",
};

const MISSING_LABELS: Record<SteamVideoGenerationMissingField, string> = {
  aspect_ratio: "宽高比",
  width: "目标宽度",
  height: "目标高度",
  fps: "帧率",
  audio_intent: "音轨意图",
  subtitle_intent: "字幕意图",
};

function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
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

function hashPrefix(value: string): string {
  return `${value.slice(0, 12)}…`;
}

export function SteamVideoGenerationPreflightPanel() {
  const [value, setValue] =
    useState<SteamVideoGenerationPreflightPackage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/steam/video-generation-preflight", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("generation_preflight_unavailable");
      const next = (await response.json()) as SteamVideoGenerationPreflightPackage;
      setValue(next);
      setState("ready");
    } catch {
      setValue(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section
      className="min-w-0 border-t border-clay-200 bg-[var(--surface-soft)] px-3 py-6 sm:px-6"
      data-steam-generation-preflight
    >
      <div className="mx-auto min-w-0 max-w-7xl space-y-4">
        <header className="ui-surface min-w-0 rounded-3xl border p-4 sm:p-6">
          <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-700">
                P1.6 · read-only dual gate
              </div>
              <h2 className="mt-2 font-serif text-2xl sm:text-3xl">
                Steam 发布目标 vs 3090 内测 LAB
              </h2>
              <p className="ui-muted mt-2 max-w-3xl text-sm leading-6">
                计划模式，未连接、未探测、未运行 GPU。这里分别核对发布规格与
                LAB 试片规格；不会提交、入队、上传、审核或发布。
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <button
                type="button"
                className="ui-button-secondary"
                onClick={() => void refresh()}
                disabled={state === "loading"}
                data-preflight-refresh
              >
                {state === "loading" ? "读取中…" : "刷新预检"}
              </button>
              <button
                type="button"
                className="ui-button-secondary"
                disabled={!value}
                onClick={() =>
                  value &&
                  downloadText(
                    STEAM_VIDEO_GENERATION_PREFLIGHT_JSON_FILENAME,
                    "application/json;charset=utf-8",
                    serializeSteamVideoGenerationPreflightJson(value),
                  )
                }
                data-preflight-export-json
              >
                导出脱敏 JSON
              </button>
              <button
                type="button"
                className="ui-button-secondary"
                disabled={!value}
                onClick={() =>
                  value &&
                  downloadText(
                    STEAM_VIDEO_GENERATION_PREFLIGHT_CSV_FILENAME,
                    "text/csv;charset=utf-8",
                    serializeSteamVideoGenerationPreflightCsv(value),
                  )
                }
                data-preflight-export-csv
              >
                导出脱敏 CSV
              </button>
            </div>
          </div>
        </header>

        <div
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-semibold leading-6 text-amber-950"
          data-preflight-lab-warning
        >
          3090 LAB 试片不等于 Steam 发布成片。LAB original 与 upscale 永远保持
          LAB_NON_PUBLISHABLE，不能提升发布兼容性或执行权限。
        </div>

        {state === "error" ? (
          <div
            role="status"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          >
            预检暂不可用；未写入任务，也未连接任何外部服务。
          </div>
        ) : null}

        {value ? (
          <>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="ui-surface min-w-0 rounded-2xl border p-3">
                <div className="ui-muted text-xs">规格总数</div>
                <div className="mt-1 text-2xl font-semibold" data-preflight-total>
                  {value.summary.total}
                </div>
              </div>
              <div className="ui-surface min-w-0 rounded-2xl border p-3">
                <div className="ui-muted text-xs">可映射</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-700">
                  {value.summary.ready}
                </div>
              </div>
              <div className="ui-surface min-w-0 rounded-2xl border p-3">
                <div className="ui-muted text-xs">阻断</div>
                <div className="mt-1 text-2xl font-semibold text-amber-700">
                  {value.summary.blocked}
                </div>
              </div>
            </div>

            <div className="grid min-w-0 gap-4">
              {value.specs.map((spec) => (
                <article
                  key={spec.specId}
                  className="ui-surface min-w-0 rounded-3xl border p-4 sm:p-5"
                  data-preflight-spec={spec.nodeId}
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-violet-700">
                        {spec.episodeId} · {spec.shotId}
                      </div>
                      <h3 className="mt-1 break-all text-base font-semibold">
                        {spec.nodeId}
                      </h3>
                      <div className="ui-muted mt-1 break-all text-xs">
                        {spec.sceneId}
                      </div>
                    </div>
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">
                      {spec.status === "ready" ? "预检通过" : "阻断"}
                    </span>
                  </div>

                  <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3 text-xs">
                    <div className="min-w-0">
                      <dt className="ui-muted">方向 / 时长</dt>
                      <dd className="mt-1 break-words font-semibold">
                        {spec.videoPolicy.orientation} · {spec.videoPolicy.durationSeconds}s
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="ui-muted">源图引用</dt>
                      <dd className="mt-1 font-semibold">
                        {spec.references.filter((item) => item.prepared).length} / {spec.references.length} 已准备
                      </dd>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <dt className="ui-muted">specId</dt>
                      <dd className="mt-1 break-all font-mono text-[11px]">
                        {spec.specId}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="ui-muted">source hash</dt>
                      <dd className="mt-1 font-mono text-[11px]">
                        {hashPrefix(spec.sourceContentHash)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="ui-muted">workflow pin</dt>
                      <dd className="mt-1 break-all font-semibold">
                        {spec.workflow.pin
                          ? `${spec.workflow.pin.templateId}@${spec.workflow.pin.version}`
                          : "未固定"}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-3">
                    <section
                      className="min-w-0 rounded-2xl border border-violet-200 bg-violet-50 p-3 text-xs"
                      data-preflight-release-target
                    >
                      <div className="break-all font-semibold text-violet-900">
                        {spec.releaseTarget.discriminator}
                      </div>
                      <div className="mt-1 break-all font-mono text-[10px] text-violet-700">
                        {spec.releaseTarget.policyVersion} · {hashPrefix(spec.releaseTarget.policyHash)}
                      </div>
                      <div className="mt-2 leading-5 text-violet-950">
                        {spec.releaseTarget.orientation} · {spec.releaseTarget.aspectRatio} · {spec.releaseTarget.width}×{spec.releaseTarget.height} · {spec.releaseTarget.fps}fps · {spec.releaseTarget.durationSeconds}s
                        <br />
                        {spec.releaseTarget.audioIntent} audio · {spec.releaseTarget.subtitleIntent}
                      </div>
                      <div className="mt-2 font-semibold">
                        {spec.releaseTarget.compatible ? "release candidate exact" : "release candidate blocked"}
                      </div>
                    </section>

                    <section
                      className="min-w-0 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-xs"
                      data-preflight-lab-original
                    >
                      <div className="break-all font-semibold text-sky-900">
                        {spec.labPreview.discriminator} · {spec.labPreview.original.stage}
                      </div>
                      <div className="mt-1 break-all font-mono text-[10px] text-sky-700">
                        {spec.labPreview.original.specId}
                      </div>
                      <div className="mt-2 leading-5 text-sky-950">
                        {spec.labPreview.original.aspectRatio} · {spec.labPreview.original.width}×{spec.labPreview.original.height} · {spec.labPreview.original.frameCount} frames · {spec.labPreview.original.fps}fps · {spec.labPreview.original.durationMs}ms · {spec.labPreview.original.hasAudio ? "audio" : "silent"}
                      </div>
                      <div className="mt-2 font-semibold">
                        {spec.labPreview.original.compatible ? "LAB candidate exact" : "LAB candidate blocked"}
                      </div>
                      {spec.labPreview.original.blockerCodes.map((code) => (
                        <div key={code} className="mt-1 break-words text-sky-900">
                          {LAB_BLOCKER_LABELS[code]}
                        </div>
                      ))}
                    </section>

                    <section
                      className="min-w-0 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-xs"
                      data-preflight-lab-upscale
                    >
                      <div className="break-all font-semibold text-sky-900">
                        {spec.labPreview.discriminator} · {spec.labPreview.upscale.stage}
                      </div>
                      <div className="mt-1 break-all font-mono text-[10px] text-sky-700">
                        {spec.labPreview.upscale.specId}
                      </div>
                      <div className="mt-2 leading-5 text-sky-950">
                        {spec.labPreview.upscale.aspectRatio} · {spec.labPreview.upscale.width}×{spec.labPreview.upscale.height} · {spec.labPreview.upscale.frameCount} frames · {spec.labPreview.upscale.fps}fps · {spec.labPreview.upscale.durationMs}ms · {spec.labPreview.upscale.hasAudio ? "audio" : "silent"}
                        <br />
                        {spec.labPreview.upscale.overwritesOriginal
                          ? "覆盖 LAB original（策略拒绝）"
                          : "独立 output，不覆盖 LAB original"}
                      </div>
                      <div className="mt-2 font-semibold">
                        {spec.labPreview.upscale.compatible ? "LAB upscale exact" : "LAB upscale blocked"}
                      </div>
                      {spec.labPreview.upscale.blockerCodes.map((code) => (
                        <div key={code} className="mt-1 break-words text-sky-900">
                          {LAB_BLOCKER_LABELS[code]}
                        </div>
                      ))}
                    </section>
                  </div>

                  {spec.missingFields.length > 0 ? (
                    <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                      <div className="font-semibold">缺失的权威字段</div>
                      <div className="mt-1 break-words leading-5">
                        {spec.missingFields.map((field) => MISSING_LABELS[field]).join("、")}
                      </div>
                    </div>
                  ) : null}

                  <ul className="mt-4 space-y-1 text-xs leading-5 text-clay-700">
                    {spec.blockerCodes.map((code) => (
                      <li key={code} className="break-words">
                        · {BLOCKER_LABELS[code]}
                      </li>
                    ))}
                    {spec.upscale.blockerCodes.map((code) => (
                      <li key={`upscale:${code}`} className="break-words">
                        · 独立升分：{BLOCKER_LABELS[code]}
                      </li>
                    ))}
                  </ul>

                  <div className="ui-muted mt-4 border-t pt-3 text-[11px] leading-5">
                    原片与升分使用不同 specId、taskId 与 outputRef；升分绝不覆盖原片。
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
