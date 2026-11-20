"use client";

import { useMemo, useRef, useState } from "react";

import { SceneMediaCanvas } from "@/components/SceneMediaCanvas";
import type { SceneVideoMedia } from "@infiplot/types";
import { createVideoCompletionGate } from "@/lib/sceneMedia";
import {
  evaluateAuthoredVariableCondition,
  resolveVideoStoryPreviewCompletion,
} from "@/lib/video-stories/runtime";
import type {
  VideoStoryAssetProjection,
  VideoStoryDraft,
} from "@/lib/video-stories/types";

function applyDelta(
  variables: Record<string, number>,
  delta: Record<string, number> | undefined,
): Record<string, number> {
  if (!delta) return variables;
  const next = { ...variables };
  for (const [key, amount] of Object.entries(delta)) {
    next[key] = (next[key] ?? 0) + amount;
  }
  return next;
}

export function VideoStoryDraftPreview({
  draft,
  assets,
  onPlaybackTimeChange,
}: {
  draft: VideoStoryDraft;
  assets: readonly VideoStoryAssetProjection[];
  onPlaybackTimeChange?: (event: {
    nodeId: string;
    currentTimeMs: number;
    durationMs: number;
  }) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [currentNodeId, setCurrentNodeId] = useState(draft.startNodeId);
  const [unlocked, setUnlocked] = useState(false);
  const [completionText, setCompletionText] = useState("等待视频结束");
  const [variables, setVariables] = useState<Record<string, number>>(
    Object.fromEntries(
      draft.variables.map((variable) => [
        variable.id,
        variable.initialValue,
      ]),
    ),
  );
  const completionGateRef = useRef(
    createVideoCompletionGate(() => undefined),
  );
  const node =
    draft.nodes.find((candidate) => candidate.nodeId === currentNodeId) ??
    draft.nodes[0];
  const asset = assets.find((candidate) => candidate.id === node?.assetId);
  const media = useMemo<SceneVideoMedia | null>(() => {
    if (!node || !asset?.publicUrl) return null;
    return {
      kind: "video",
      url: asset.publicUrl,
      assetId: asset.id,
      ...(node.posterUrl ? { posterUrl: node.posterUrl } : {}),
      durationMs: asset.durationMs,
      hasAudio: asset.hasAudio,
      subtitles: node.subtitles?.length
        ? node.subtitles
        : asset.subtitles,
      ...(node.vttUrl ? { vttUrl: node.vttUrl } : {}),
      allowSkip: node.allowSkip,
      endBehavior:
        node.endedBehavior === "advance"
          ? "advance-beat"
          : node.endedBehavior === "hold"
            ? "hold"
            : "unlock-interaction",
      hotspotsEnabled: false,
    };
  }, [asset, node]);

  const activateNode = (nodeId: string) => {
    setCurrentNodeId(nodeId);
    setUnlocked(false);
    setCompletionText("等待视频结束");
    completionGateRef.current = createVideoCompletionGate(() => undefined);
  };

  if (!node) {
    return (
      <div className="rounded-xl border border-dashed border-stone-300 p-6 text-sm text-stone-500">
        先添加节点并绑定已审核视频，再进行预览。
      </div>
    );
  }

  return (
    <section className="min-w-0 space-y-3" aria-label="互动视频剧情预览">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="text-xs text-stone-500" htmlFor="preview-node">
          从节点预览
        </label>
        <select
          id="preview-node"
          value={node.nodeId}
          onChange={(event) => activateNode(event.target.value)}
          className="min-w-0 max-w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
        >
          {draft.nodes.map((candidate) => (
            <option key={candidate.nodeId} value={candidate.nodeId}>
              {candidate.nodeId} · {candidate.title}
            </option>
          ))}
        </select>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
          当前：{node.nodeId}
        </span>
        <span className="text-xs text-stone-500">{completionText}</span>
      </div>

      <div className="aspect-video min-w-0 overflow-hidden rounded-2xl border border-stone-300 bg-black shadow-sm">
        {media ? (
          <SceneMediaCanvas
            key={node.nodeId}
            media={media}
            fallbackImageUrl={node.posterUrl || null}
            imageRef={imageRef}
            intrinsicWidth={1280}
            intrinsicHeight={720}
            imageAlt={node.title}
            imageClassName="h-full w-full object-contain"
            imageStyle={{}}
            muted={false}
            dimmed={false}
            onImageClick={() => undefined}
            onVideoTimeChange={(event) =>
              onPlaybackTimeChange?.({ nodeId: node.nodeId, ...event })
            }
            onVideoComplete={(event) => {
              if (!completionGateRef.current(event.reason)) return;
              const transition = resolveVideoStoryPreviewCompletion(
                node,
                event.reason,
              );
              setCompletionText(
                `${event.reason} · ${
                  transition.targetNodeId
                    ? `进入 ${transition.targetNodeId}`
                    : "交互已解锁"
                }`,
              );
              setVariables((current) =>
                applyDelta(current, transition.variableDelta),
              );
              if (transition.targetNodeId) {
                activateNode(transition.targetNodeId);
              } else {
                setUnlocked(true);
              }
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/70">
            当前节点没有同项目、同故事且已审核公开的视频，预览已关闭。
          </div>
        )}
      </div>

      {unlocked && node.endedBehavior === "choices" ? (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {node.choices.map((choice) => {
            const available = (choice.conditions ?? []).every((condition) =>
              evaluateAuthoredVariableCondition(condition, variables),
            );
            return (
              <button
                key={choice.id}
                type="button"
                disabled={!available}
                onClick={() => {
                  setVariables((current) =>
                    applyDelta(current, choice.variableDelta),
                  );
                  activateNode(choice.targetNodeId);
                }}
                className="min-w-0 rounded-xl border border-stone-300 bg-white px-4 py-3 text-left text-sm text-stone-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="block break-words font-medium">
                  {choice.label}
                </span>
                <span className="mt-1 block break-all text-xs text-stone-500">
                  → {choice.targetNodeId}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <p className="break-words text-xs leading-5 text-stone-500">
        连接摘要：
        {node.terminal
          ? "终局"
          : node.endedBehavior === "advance"
            ? `视频完成后自动进入 ${node.endedTargetNodeId || "未设置"}`
            : node.choices.length
              ? node.choices
                  .map((choice) => `${choice.label} → ${choice.targetNodeId}`)
                  .join("；")
              : "尚未设置后续"}
      </p>
    </section>
  );
}
