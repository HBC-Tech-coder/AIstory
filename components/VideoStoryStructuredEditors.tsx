"use client";

import type { AuthoredVariableCondition } from "@infiplot/types";
import type { VideoSubtitleCue } from "@/lib/video-assets/types";
import {
  clampVideoStoryTimeMs,
  createVideoStorySubtitleCue,
  duplicateVideoStorySubtitleCue,
  moveVideoStoryItem,
  nextVideoStoryEditorId,
} from "@/lib/video-stories/editor";
import type {
  VideoStoryChoiceDraft,
  VideoStoryNodeDraft,
  VideoStoryVariableDefinition,
} from "@/lib/video-stories/types";

const CONDITION_OPERATORS: Array<{
  value: AuthoredVariableCondition["operator"];
  label: string;
}> = [
  { value: "eq", label: "等于" },
  { value: "neq", label: "不等于" },
  { value: "gte", label: "大于等于" },
  { value: "lte", label: "小于等于" },
  { value: "gt", label: "大于" },
  { value: "lt", label: "小于" },
];

function seconds(ms: number): number {
  return Number((ms / 1_000).toFixed(3));
}

function milliseconds(value: string, durationMs: number): number {
  return clampVideoStoryTimeMs(Number(value) * 1_000, durationMs);
}

export function VideoStorySubtitleEditor({
  cues,
  durationMs,
  playbackTimeMs,
  readOnly,
  onChange,
}: {
  cues: readonly VideoSubtitleCue[];
  durationMs: number;
  playbackTimeMs?: number;
  readOnly: boolean;
  onChange: (cues: VideoSubtitleCue[]) => void;
}) {
  const currentTime = playbackTimeMs === undefined
    ? undefined
    : clampVideoStoryTimeMs(playbackTimeMs, durationMs);

  const patchCue = (index: number, patch: Partial<VideoSubtitleCue>) => {
    onChange(
      cues.map((cue, cueIndex) =>
        cueIndex === index ? { ...cue, ...patch } : cue,
      ),
    );
  };

  return (
    <section className="min-w-0 space-y-2" aria-label="字幕时间线编辑">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">字幕时间线</p>
          <p className="text-xs text-stone-500">
            视频 {seconds(durationMs)} 秒
            {currentTime !== undefined
              ? ` · 当前 ${seconds(currentTime)} 秒`
              : " · 播放预览后可取当前时间"}
          </p>
        </div>
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            onChange([
              ...cues,
              createVideoStorySubtitleCue(cues, durationMs, currentTime),
            ])
          }
          className="rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 disabled:opacity-40"
        >
          + 新增字幕
        </button>
      </div>

      <div className="max-w-full overflow-x-auto rounded-xl border border-stone-200">
        <div className="min-w-[820px] space-y-2 p-2">
          {cues.length ? cues.map((cue, index) => (
            <article
              key={`${cue.id}:${index}`}
              className="grid grid-cols-[120px_100px_100px_120px_minmax(220px,1fr)_auto] items-start gap-2 rounded-lg bg-stone-50 p-2"
            >
              <label className="text-[11px] text-stone-500">
                cue ID
                <input
                  value={cue.id}
                  disabled={readOnly}
                  onChange={(event) => patchCue(index, { id: event.target.value })}
                  className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                />
              </label>
              <label className="text-[11px] text-stone-500">
                起点（秒）
                <input
                  type="number"
                  min={0}
                  max={seconds(durationMs)}
                  step={0.05}
                  value={seconds(cue.startMs)}
                  disabled={readOnly}
                  onChange={(event) =>
                    patchCue(index, {
                      startMs: milliseconds(event.target.value, durationMs),
                    })
                  }
                  className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                />
                <button
                  type="button"
                  disabled={readOnly || currentTime === undefined}
                  onClick={() => patchCue(index, { startMs: currentTime })}
                  className="mt-1 text-[11px] text-blue-700 disabled:text-stone-400"
                >
                  当前时间→起点
                </button>
              </label>
              <label className="text-[11px] text-stone-500">
                终点（秒）
                <input
                  type="number"
                  min={0}
                  max={seconds(durationMs)}
                  step={0.05}
                  value={seconds(cue.endMs)}
                  disabled={readOnly}
                  onChange={(event) =>
                    patchCue(index, {
                      endMs: milliseconds(event.target.value, durationMs),
                    })
                  }
                  className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                />
                <button
                  type="button"
                  disabled={readOnly || currentTime === undefined}
                  onClick={() => patchCue(index, { endMs: currentTime })}
                  className="mt-1 text-[11px] text-blue-700 disabled:text-stone-400"
                >
                  当前时间→终点
                </button>
              </label>
              <label className="text-[11px] text-stone-500">
                说话人
                <input
                  value={cue.speaker ?? ""}
                  disabled={readOnly}
                  onChange={(event) =>
                    patchCue(index, {
                      speaker: event.target.value || undefined,
                    })
                  }
                  className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                />
              </label>
              <label className="text-[11px] text-stone-500">
                字幕文字
                <textarea
                  value={cue.text}
                  disabled={readOnly}
                  rows={2}
                  onChange={(event) => patchCue(index, { text: event.target.value })}
                  className="mt-1 w-full resize-y rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                />
              </label>
              <div className="flex w-24 flex-wrap justify-end gap-1 pt-5">
                <button
                  type="button"
                  disabled={readOnly || index === 0}
                  onClick={() => onChange(moveVideoStoryItem(cues, index, index - 1))}
                  className="rounded border border-stone-300 px-2 py-1 text-[11px] disabled:opacity-35"
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={readOnly || index === cues.length - 1}
                  onClick={() => onChange(moveVideoStoryItem(cues, index, index + 1))}
                  className="rounded border border-stone-300 px-2 py-1 text-[11px] disabled:opacity-35"
                >
                  下移
                </button>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange(duplicateVideoStorySubtitleCue(cues, index, durationMs))}
                  className="rounded border border-stone-300 px-2 py-1 text-[11px] disabled:opacity-35"
                >
                  复制
                </button>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange(cues.filter((_, cueIndex) => cueIndex !== index))}
                  className="rounded border border-red-200 px-2 py-1 text-[11px] text-red-700 disabled:opacity-35"
                >
                  删除
                </button>
              </div>
            </article>
          )) : (
            <p className="p-3 text-center text-xs text-stone-500">
              当前节点沿用视频资产字幕；新增后将使用节点级字幕。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function VideoStoryChoiceEditor({
  choices,
  nodes,
  variables,
  readOnly,
  onChange,
}: {
  choices: readonly VideoStoryChoiceDraft[];
  nodes: readonly VideoStoryNodeDraft[];
  variables: readonly VideoStoryVariableDefinition[];
  readOnly: boolean;
  onChange: (choices: VideoStoryChoiceDraft[]) => void;
}) {
  const patchChoice = (index: number, patch: Partial<VideoStoryChoiceDraft>) => {
    onChange(
      choices.map((choice, choiceIndex) =>
        choiceIndex === index ? { ...choice, ...patch } : choice,
      ),
    );
  };

  return (
    <section className="min-w-0 space-y-2" aria-label="分支选择编辑">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">视频结束后的选择</p>
          <p className="text-xs text-stone-500">仅在真实播放器完成门触发后解锁。</p>
        </div>
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            onChange([
              ...choices,
              {
                id: nextVideoStoryEditorId(
                  "choice",
                  choices.map((choice) => choice.id),
                ),
                label: "新选择",
                targetNodeId: nodes[0]?.nodeId ?? "",
              },
            ])
          }
          className="rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 disabled:opacity-40"
        >
          + 新增选择
        </button>
      </div>

      <div className="max-w-full overflow-x-auto rounded-xl border border-stone-200">
        <div className="min-w-[760px] space-y-2 p-2">
          {choices.length ? choices.map((choice, index) => (
            <article key={`${choice.id}:${index}`} className="rounded-lg bg-stone-50 p-2">
              <div className="grid grid-cols-[140px_minmax(220px,1fr)_180px_auto] items-end gap-2">
                <label className="text-[11px] text-stone-500">
                  choice ID
                  <input
                    value={choice.id}
                    disabled={readOnly}
                    onChange={(event) => patchChoice(index, { id: event.target.value })}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                  />
                </label>
                <label className="text-[11px] text-stone-500">
                  显示文案
                  <input
                    value={choice.label}
                    disabled={readOnly}
                    onChange={(event) => patchChoice(index, { label: event.target.value })}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                  />
                </label>
                <label className="text-[11px] text-stone-500">
                  目标节点
                  <select
                    value={choice.targetNodeId}
                    disabled={readOnly}
                    onChange={(event) => patchChoice(index, { targetNodeId: event.target.value })}
                    className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900"
                  >
                    <option value="">选择目标</option>
                    {nodes.map((node) => (
                      <option key={node.nodeId} value={node.nodeId}>
                        {node.nodeId} · {node.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-1">
                  <button type="button" disabled={readOnly || index === 0} onClick={() => onChange(moveVideoStoryItem(choices, index, index - 1))} className="rounded border border-stone-300 px-2 py-1.5 text-[11px] disabled:opacity-35">上移</button>
                  <button type="button" disabled={readOnly || index === choices.length - 1} onClick={() => onChange(moveVideoStoryItem(choices, index, index + 1))} className="rounded border border-stone-300 px-2 py-1.5 text-[11px] disabled:opacity-35">下移</button>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      const copy = structuredClone(choice);
                      copy.id = nextVideoStoryEditorId("choice", choices.map((item) => item.id));
                      copy.label = `${choice.label}（副本）`;
                      onChange([...choices, copy]);
                    }}
                    className="rounded border border-stone-300 px-2 py-1.5 text-[11px] disabled:opacity-35"
                  >复制</button>
                  <button type="button" disabled={readOnly} onClick={() => onChange(choices.filter((_, choiceIndex) => choiceIndex !== index))} className="rounded border border-red-200 px-2 py-1.5 text-[11px] text-red-700 disabled:opacity-35">删除</button>
                </div>
              </div>

              {variables.length ? (
                <details className="mt-2 rounded border border-stone-200 bg-white p-2 text-xs">
                  <summary className="cursor-pointer font-medium text-stone-700">条件与变量更新</summary>
                  <div className="mt-2 space-y-2">
                    {(choice.conditions ?? []).map((condition, conditionIndex) => (
                      <div key={`${condition.variableId}:${conditionIndex}`} className="grid grid-cols-[1fr_130px_120px_auto] gap-2">
                        <select
                          value={condition.variableId}
                          disabled={readOnly}
                          onChange={(event) => {
                            const conditions = [...(choice.conditions ?? [])];
                            conditions[conditionIndex] = { ...condition, variableId: event.target.value };
                            patchChoice(index, { conditions });
                          }}
                          className="min-w-0 rounded border border-stone-300 px-2 py-1.5"
                        >
                          {variables.map((variable) => <option key={variable.id} value={variable.id}>{variable.label} · {variable.id}</option>)}
                        </select>
                        <select
                          value={condition.operator}
                          disabled={readOnly}
                          onChange={(event) => {
                            const conditions = [...(choice.conditions ?? [])];
                            conditions[conditionIndex] = { ...condition, operator: event.target.value as AuthoredVariableCondition["operator"] };
                            patchChoice(index, { conditions });
                          }}
                          className="rounded border border-stone-300 px-2 py-1.5"
                        >
                          {CONDITION_OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                        </select>
                        <input
                          type="number"
                          value={condition.value}
                          disabled={readOnly}
                          onChange={(event) => {
                            const conditions = [...(choice.conditions ?? [])];
                            conditions[conditionIndex] = { ...condition, value: Number(event.target.value) };
                            patchChoice(index, { conditions });
                          }}
                          className="rounded border border-stone-300 px-2 py-1.5"
                          aria-label="条件值"
                        />
                        <button type="button" disabled={readOnly} onClick={() => patchChoice(index, { conditions: (choice.conditions ?? []).filter((_, itemIndex) => itemIndex !== conditionIndex) })} className="rounded border border-red-200 px-2 text-red-700">删除条件</button>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={readOnly || !variables.length}
                      onClick={() => patchChoice(index, { conditions: [...(choice.conditions ?? []), { variableId: variables[0]!.id, operator: "gte", value: variables[0]!.initialValue }] })}
                      className="rounded border border-stone-300 px-2 py-1"
                    >+ 条件</button>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {variables.map((variable) => (
                        <label key={variable.id} className="text-[11px] text-stone-500">
                          {variable.label} 更新量
                          <input
                            type="number"
                            value={choice.variableDelta?.[variable.id] ?? ""}
                            disabled={readOnly}
                            placeholder="不更新"
                            onChange={(event) => {
                              const delta = { ...(choice.variableDelta ?? {}) };
                              if (event.target.value === "") delete delta[variable.id];
                              else delta[variable.id] = Number(event.target.value);
                              patchChoice(index, { variableDelta: Object.keys(delta).length ? delta : undefined });
                            }}
                            className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 text-xs"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </details>
              ) : null}
            </article>
          )) : (
            <p className="p-3 text-center text-xs text-stone-500">尚未设置选择。</p>
          )}
        </div>
      </div>
    </section>
  );
}
