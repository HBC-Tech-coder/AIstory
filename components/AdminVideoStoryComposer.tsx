"use client";

import { useEffect, useMemo, useState } from "react";

import { VideoStoryDraftPreview } from "@/components/VideoStoryDraftPreview";
import {
  VideoStoryChoiceEditor,
  VideoStorySubtitleEditor,
} from "@/components/VideoStoryStructuredEditors";
import {
  deleteVideoStoryNode,
  duplicateVideoStoryNode,
  moveVideoStoryItem,
  renameVideoStoryNode,
} from "@/lib/video-stories/editor";
import type {
  VideoStoryAssetProjection,
  VideoStoryDraft,
  VideoStoryNodeDraft,
  VideoStoryValidationResult,
} from "@/lib/video-stories/types";

type ListResponse = {
  capability: {
    adapter: "local_development" | "production_repository";
    available: boolean;
    reason?: string;
  };
  drafts: VideoStoryDraft[];
  assets: VideoStoryAssetProjection[];
};

type GpuStudioStatus = {
  state: "disabled" | "offline" | "online";
  ready: boolean;
  releaseClassification: "non_publishable";
};

function newNode(index: number, assetId = ""): VideoStoryNodeDraft {
  return {
    nodeId: index === 0 ? "start" : `node-${index + 1}`,
    title: index === 0 ? "起点" : `节点 ${index + 1}`,
    assetId,
    allowSkip: true,
    endedBehavior: "choices",
    terminal: false,
    choices: [],
    releasePolicy: "public",
  };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseJson<T>(value: string, fallback: T, label: string): T {
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} JSON 不合法。`);
  }
}

export function AdminVideoStoryComposer() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<VideoStoryDraft | null>(null);
  const [reason, setReason] = useState("本地互动视频剧情编排");
  const [projectId, setProjectId] = useState("");
  const [storyId, setStoryId] = useState("");
  const [title, setTitle] = useState("");
  const [variablesJson, setVariablesJson] = useState("[]");
  const [gpuStatus, setGpuStatus] = useState<GpuStudioStatus>();
  const [playback, setPlayback] = useState<{
    nodeId: string;
    currentTimeMs: number;
    durationMs: number;
  }>();
  const [validation, setValidation] =
    useState<VideoStoryValidationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取视频剧情仓储…");

  const refresh = async (preferId?: string) => {
    const response = await fetch("/api/admin/video-stories", {
      cache: "no-store",
    });
    const body = (await response.json()) as ListResponse & { error?: string };
    if (!response.ok) {
      setData({
        capability: body.capability ?? {
          adapter: "production_repository",
          available: false,
          reason: body.error || "视频剧情仓储不可用。",
        },
        drafts: [],
        assets: [],
      });
      setMessage(body.error || body.capability?.reason || "视频剧情仓储不可用。");
      return;
    }
    setData(body);
    const nextId =
      preferId ||
      selectedId ||
      body.drafts[0]?.id ||
      "";
    setSelectedId(nextId);
    const next = body.drafts.find((item) => item.id === nextId) ?? null;
    setDraft(next ? structuredClone(next) : null);
    if (next) {
      setVariablesJson(pretty(next.variables));
    }
    setPlayback(undefined);
    setMessage(body.drafts.length ? "本地开发数据" : "暂无视频剧情草稿");
  };

  useEffect(() => {
    void refresh();
    void fetch("/api/providers/gpu-connector-lan/status", {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("gpu_status_unavailable");
        setGpuStatus((await response.json()) as GpuStudioStatus);
      })
      .catch(() =>
        setGpuStatus({
          state: "offline",
          ready: false,
          releaseClassification: "non_publishable",
        }),
      );
    // The panel owns its refresh lifecycle; selection changes are handled explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const assetsForDraft = useMemo(
    () =>
      data?.assets.filter(
        (asset) =>
          asset.status === "publishable" &&
          asset.releasePolicy === "public" &&
          asset.projectId === draft?.projectId &&
          asset.storyId === draft?.storyId &&
          !!asset.publicUrl,
      ) ?? [],
    [data?.assets, draft?.projectId, draft?.storyId],
  );

  const selectDraft = (id: string) => {
    const next = data?.drafts.find((item) => item.id === id) ?? null;
    setSelectedId(id);
    setDraft(next ? structuredClone(next) : null);
    setValidation(null);
    if (next) {
      setVariablesJson(pretty(next.variables));
    }
    setPlayback(undefined);
  };

  const mutate = async (
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    setBusy(true);
    setMessage("正在保存…");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": `video-story:${crypto.randomUUID()}`,
          "X-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        error?: string;
        draft?: VideoStoryDraft;
        validation?: VideoStoryValidationResult;
      };
      if (!response.ok) throw new Error(result.error || "操作失败。");
      if (result.validation) {
        setValidation(result.validation);
        setMessage(
          result.validation.ok
            ? `校验通过，${result.validation.warnings.length} 条提醒`
            : `校验失败，${result.validation.errors.length} 个问题`,
        );
        return;
      }
      await refresh(result.draft?.id || selectedId);
      setMessage("操作已完成并写入 append-only 本地审计。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  };

  const normalizedDraft = (): VideoStoryDraft => {
    if (!draft) throw new Error("请先选择草稿。");
    const variables = parseJson(
      variablesJson,
      draft.variables,
      "变量",
    );
    return { ...draft, variables };
  };

  const focusNode = (nodeId: string) => {
    const element = document.querySelector<HTMLElement>(
      `[data-video-story-node="${CSS.escape(nodeId)}"]`,
    );
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.focus({ preventScroll: true });
  };

  if (!data) {
    return <p className="text-sm text-stone-500">{message}</p>;
  }

  if (!data.capability.available) {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h2 className="text-xl font-semibold text-stone-900">互动视频剧情</h2>
        <p className="mt-2 text-sm leading-6 text-amber-900">
          {data.capability.reason || "视频剧情仓储不可用。"}
        </p>
        <p className="mt-2 text-xs text-stone-500">
          生产仓储未配置时严格关闭，不会回落到本地 JSON。
        </p>
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-5">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">互动视频剧情</h2>
          <p className="mt-1 text-sm text-stone-500">
            本地开发编排 · 草稿、审核与发布互相独立
          </p>
        </div>
        <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-800">
          {message}
        </span>
      </header>

      <div
        className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm"
        data-video-generation-status
      >
        <div className="min-w-0">
          <p className="font-medium text-slate-900">生成视频 · GPU Connector</p>
          <p className="mt-0.5 break-words text-xs text-slate-600">
            {gpuStatus?.ready && gpuStatus.state === "online"
              ? "连接器在线；生成仍须在 GPU Connector 管理区单独受控提交，完成后再纳管、审核。"
              : "当前不可用，等待 Connector 完成安全联调。这里不会提交假任务。"}
          </p>
        </div>
        <span className="rounded-full border border-blue-200 bg-white px-3 py-1 text-xs font-medium text-blue-700">
          {gpuStatus?.state === "online" ? "在线" : "等待 Connector"}
        </span>
      </div>

      <div className="grid min-w-0 gap-3 rounded-2xl border border-stone-200 bg-white p-4 md:grid-cols-[120px_1fr_1fr_auto]">
        <input
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          inputMode="numeric"
          placeholder="项目 ID"
          className="min-w-0 rounded-xl border border-stone-300 px-3 py-2.5"
        />
        <input
          value={storyId}
          onChange={(event) => setStoryId(event.target.value)}
          placeholder="稳定 storyId"
          className="min-w-0 rounded-xl border border-stone-300 px-3 py-2.5"
        />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="故事标题"
          className="min-w-0 rounded-xl border border-stone-300 px-3 py-2.5"
        />
        <button
          type="button"
          disabled={busy || !projectId || !storyId || !title.trim()}
          onClick={() =>
            void mutate("/api/admin/video-stories", {
              action: "create",
              projectId,
              storyId,
              title,
              version: "v1",
              orientation: "landscape",
              reason,
            })
          }
          className="rounded-xl bg-ember-500 px-4 py-2.5 text-white disabled:opacity-40"
        >
          创建草稿
        </button>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-2xl border border-stone-200 bg-white p-3">
          <div className="max-h-[70vh] space-y-2 overflow-y-auto">
            {data.drafts.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectDraft(item.id)}
                className={`w-full min-w-0 rounded-xl border px-3 py-3 text-left ${
                  item.id === selectedId
                    ? "border-ember-500 bg-ember-500/5"
                    : "border-stone-200"
                }`}
              >
                <span className="block truncate font-medium">{item.title}</span>
                <span className="mt-1 block break-all text-xs text-stone-500">
                  {item.storyId} · {item.status} · r{item.revision}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {draft ? (
          <div className="min-w-0 space-y-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5">
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              <label className="min-w-0 text-sm">
                标题
                <input
                  value={draft.title}
                  disabled={draft.status !== "draft"}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                  className="mt-1 w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2"
                />
              </label>
              <label className="min-w-0 text-sm">
                版本
                <input
                  value={draft.version}
                  disabled={draft.status !== "draft"}
                  onChange={(event) =>
                    setDraft({ ...draft, version: event.target.value })
                  }
                  className="mt-1 w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2"
                />
              </label>
              <label className="min-w-0 text-sm md:col-span-2">
                简介
                <textarea
                  value={draft.summary}
                  disabled={draft.status !== "draft"}
                  onChange={(event) =>
                    setDraft({ ...draft, summary: event.target.value })
                  }
                  rows={2}
                  className="mt-1 w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2"
                />
              </label>
              <label className="min-w-0 text-sm">
                起点
                <select
                  value={draft.startNodeId}
                  disabled={draft.status !== "draft"}
                  onChange={(event) =>
                    setDraft({ ...draft, startNodeId: event.target.value })
                  }
                  className="mt-1 w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2"
                >
                  {draft.nodes.map((node) => (
                    <option key={node.nodeId} value={node.nodeId}>
                      {node.nodeId}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-sm">
                画幅
                <select
                  value={draft.orientation}
                  disabled={draft.status !== "draft"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      orientation:
                        event.target.value === "portrait"
                          ? "portrait"
                          : "landscape",
                    })
                  }
                  className="mt-1 w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2"
                >
                  <option value="landscape">横屏</option>
                  <option value="portrait">竖屏</option>
                </select>
              </label>
            </div>

            <label className="block min-w-0 text-sm">
              变量定义（JSON）
              <textarea
                value={variablesJson}
                disabled={draft.status !== "draft"}
                onChange={(event) => setVariablesJson(event.target.value)}
                rows={4}
                className="mt-1 w-full min-w-0 resize-y rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs"
              />
            </label>

            <div className="space-y-3">
              {draft.nodes.map((node, index) => {
                const nodeIssues = validation
                  ? [...validation.errors, ...validation.warnings].filter(
                      (item) => item.nodeId === node.nodeId,
                    )
                  : [];
                const asset = assetsForDraft.find(
                  (candidate) => candidate.id === node.assetId,
                );
                return (
                  <article
                    key={`${node.nodeId}:${index}`}
                    data-video-story-node={node.nodeId}
                    tabIndex={-1}
                    className={`min-w-0 rounded-xl border p-3 outline-none focus:ring-2 focus:ring-blue-400 ${
                      nodeIssues.some((item) =>
                        validation?.errors.includes(item),
                      )
                        ? "border-red-300 bg-red-50/35"
                        : "border-stone-200"
                    }`}
                  >
                  {nodeIssues.length ? (
                    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                      {nodeIssues.map((item) => (
                        <p key={`${item.code}:${item.message}`}>{item.message}</p>
                      ))}
                    </div>
                  ) : null}
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <input
                      value={node.nodeId}
                      disabled={draft.status !== "draft"}
                      onChange={(event) =>
                        setDraft(
                          renameVideoStoryNode(draft, index, event.target.value),
                        )
                      }
                      aria-label="节点 ID"
                      className="min-w-0 rounded-lg border border-stone-300 px-2.5 py-2"
                    />
                    <input
                      value={node.title}
                      disabled={draft.status !== "draft"}
                      onChange={(event) => {
                        const nodes = [...draft.nodes];
                        nodes[index] = { ...node, title: event.target.value };
                        setDraft({ ...draft, nodes });
                      }}
                      aria-label="节点标题"
                      className="min-w-0 rounded-lg border border-stone-300 px-2.5 py-2"
                    />
                    <select
                      value={node.assetId}
                      disabled={draft.status !== "draft"}
                      onChange={(event) => {
                        const nodes = [...draft.nodes];
                        nodes[index] = { ...node, assetId: event.target.value };
                        setDraft({ ...draft, nodes });
                      }}
                      aria-label="已审核视频资产"
                      className="min-w-0 rounded-lg border border-stone-300 px-2.5 py-2"
                    >
                      <option value="">选择已审核视频</option>
                      {assetsForDraft.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.id} · {Math.round(asset.durationMs / 1000)}s
                        </option>
                      ))}
                    </select>
                    <select
                      value={node.endedBehavior}
                      disabled={draft.status !== "draft"}
                      onChange={(event) => {
                        const behavior = event.target.value as
                          VideoStoryNodeDraft["endedBehavior"];
                        const nodes = [...draft.nodes];
                        nodes[index] = {
                          ...node,
                          endedBehavior: behavior,
                          terminal: behavior === "hold",
                        };
                        setDraft({ ...draft, nodes });
                      }}
                      aria-label="结束行为"
                      className="min-w-0 rounded-lg border border-stone-300 px-2.5 py-2"
                    >
                      <option value="choices">显示选项</option>
                      <option value="advance">自动推进</option>
                      <option value="hold">终局停留</option>
                    </select>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3 text-xs">
                    <label>
                      <input
                        type="checkbox"
                        checked={node.allowSkip}
                        disabled={draft.status !== "draft"}
                        onChange={(event) => {
                          const nodes = [...draft.nodes];
                          nodes[index] = {
                            ...node,
                            allowSkip: event.target.checked,
                          };
                          setDraft({ ...draft, nodes });
                        }}
                      />{" "}
                      允许跳到结尾
                    </label>
                    {node.endedBehavior === "advance" ? (
                      <select
                        value={node.endedTargetNodeId || ""}
                        disabled={draft.status !== "draft"}
                        onChange={(event) => {
                          const nodes = [...draft.nodes];
                          nodes[index] = {
                            ...node,
                            endedTargetNodeId: event.target.value,
                          };
                          setDraft({ ...draft, nodes });
                        }}
                        className="min-w-0 rounded border border-stone-300 px-2 py-1"
                      >
                        <option value="">自动推进目标</option>
                        {draft.nodes
                          .filter((candidate) => candidate.nodeId !== node.nodeId)
                          .map((candidate) => (
                            <option key={candidate.nodeId} value={candidate.nodeId}>
                              {candidate.nodeId}
                            </option>
                          ))}
                      </select>
                    ) : null}
                    <button
                      type="button"
                      disabled={draft.status !== "draft" || index === 0}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          nodes: moveVideoStoryItem(
                            draft.nodes,
                            index,
                            index - 1,
                          ),
                        })
                      }
                      className="rounded border border-stone-300 px-2 py-1 disabled:opacity-35"
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      disabled={
                        draft.status !== "draft" ||
                        index === draft.nodes.length - 1
                      }
                      onClick={() =>
                        setDraft({
                          ...draft,
                          nodes: moveVideoStoryItem(
                            draft.nodes,
                            index,
                            index + 1,
                          ),
                        })
                      }
                      className="rounded border border-stone-300 px-2 py-1 disabled:opacity-35"
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      disabled={draft.status !== "draft"}
                      onClick={() => setDraft(duplicateVideoStoryNode(draft, index))}
                      className="rounded border border-stone-300 px-2 py-1 disabled:opacity-35"
                    >
                      复制节点
                    </button>
                    <button
                      type="button"
                      disabled={
                        draft.status !== "draft" || draft.nodes.length <= 1
                      }
                      onClick={() => setDraft(deleteVideoStoryNode(draft, index))}
                      className="rounded border border-red-200 px-2 py-1 text-red-700 disabled:opacity-35"
                    >
                      删除节点
                    </button>
                  </div>
                  <div className="mt-4 min-w-0 space-y-4">
                    <VideoStorySubtitleEditor
                      cues={node.subtitles ?? []}
                      durationMs={asset?.durationMs ?? 0}
                      playbackTimeMs={
                        playback?.nodeId === node.nodeId
                          ? playback.currentTimeMs
                          : undefined
                      }
                      readOnly={draft.status !== "draft"}
                      onChange={(subtitles) => {
                        const nodes = [...draft.nodes];
                        nodes[index] = { ...node, subtitles };
                        setDraft({ ...draft, nodes });
                      }}
                    />
                    {node.endedBehavior === "choices" ? (
                      <VideoStoryChoiceEditor
                        choices={node.choices}
                        nodes={draft.nodes}
                        variables={draft.variables}
                        readOnly={draft.status !== "draft"}
                        onChange={(choices) => {
                          const nodes = [...draft.nodes];
                          nodes[index] = { ...node, choices };
                          setDraft({ ...draft, nodes });
                        }}
                      />
                    ) : null}
                  </div>
                </article>
                );
              })}
            </div>

            {draft.status === "draft" ? (
              <button
                type="button"
                onClick={() => {
                  const node = newNode(
                    draft.nodes.length,
                    assetsForDraft[0]?.id,
                  );
                  setDraft({
                    ...draft,
                    nodes: [...draft.nodes, node],
                    startNodeId: draft.nodes.length
                      ? draft.startNodeId
                      : node.nodeId,
                  });
                }}
                className="rounded-xl border border-dashed border-stone-400 px-4 py-2 text-sm"
              >
                + 添加节点
              </button>
            ) : null}

            <label className="block text-sm">
              管理员操作原因
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="mt-1 w-full min-w-0 rounded-lg border border-stone-300 px-3 py-2"
              />
            </label>

            <div className="flex min-w-0 flex-wrap gap-2">
              {draft.status === "draft" ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      try {
                        const value = normalizedDraft();
                        void mutate(`/api/admin/video-stories/${draft.id}`, {
                          action: "save",
                          title: value.title,
                          summary: value.summary,
                          version: value.version,
                          orientation: value.orientation,
                          startNodeId: value.startNodeId,
                          variables: value.variables,
                          nodes: value.nodes,
                          reason,
                        });
                      } catch (error) {
                        setMessage(
                          error instanceof Error ? error.message : "表单不合法。",
                        );
                      }
                    }}
                    className="rounded-xl bg-ember-500 px-4 py-2 text-white disabled:opacity-40"
                  >
                    保存草稿
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/api/admin/video-stories/${draft.id}`, {
                        action: "validate",
                        reason,
                      })
                    }
                    className="rounded-xl border border-stone-300 px-4 py-2"
                  >
                    校验
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/api/admin/video-stories/${draft.id}`, {
                        action: "submit_review",
                        reason,
                      })
                    }
                    className="rounded-xl border border-amber-500 px-4 py-2 text-amber-800"
                  >
                    提交审核
                  </button>
                </>
              ) : null}
              {draft.status === "review_pending" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(`/api/admin/video-stories/${draft.id}`, {
                      action: "publish",
                      reason,
                    })
                  }
                  className="rounded-xl bg-emerald-700 px-4 py-2 text-white"
                >
                  重新校验并发布
                </button>
              ) : null}
              {draft.status === "published" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(`/api/admin/video-stories/${draft.id}`, {
                      action: "offline",
                      reason,
                    })
                  }
                  className="rounded-xl border border-red-300 px-4 py-2 text-red-700"
                >
                  下线
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void mutate("/api/admin/video-stories", {
                    action: "copy",
                    sourceId: draft.id,
                    projectId: draft.projectId,
                    storyId: draft.storyId,
                    title: `${draft.title}（副本）`,
                    summary: draft.summary,
                    version: draft.version,
                    orientation: draft.orientation,
                    reason,
                  })
                }
                className="rounded-xl border border-stone-300 px-4 py-2"
              >
                复制为草稿
              </button>
            </div>

            {validation ? (
              <div
                className={`rounded-xl border p-3 text-sm ${
                  validation.ok
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-red-200 bg-red-50"
                }`}
              >
                {[...validation.errors, ...validation.warnings].map((item) => (
                  <div
                    key={`${item.code}:${item.nodeId || ""}:${item.message}`}
                    className="flex min-w-0 items-start gap-2"
                  >
                    {item.nodeId ? (
                      <button
                        type="button"
                        onClick={() => focusNode(item.nodeId!)}
                        className="shrink-0 font-semibold underline underline-offset-2"
                      >
                        定位 {item.nodeId}
                      </button>
                    ) : null}
                    <p className="min-w-0 break-words">{item.message}</p>
                  </div>
                ))}
                {!validation.errors.length && !validation.warnings.length ? (
                  <p>图结构、字幕、资产和发布边界校验通过。</p>
                ) : null}
              </div>
            ) : null}

            <VideoStoryDraftPreview
              key={draft.id}
              draft={draft}
              assets={data.assets}
              onPlaybackTimeChange={setPlayback}
            />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-stone-300 p-10 text-center text-sm text-stone-500">
            创建或选择草稿后开始编排。
          </div>
        )}
      </div>
    </section>
  );
}
