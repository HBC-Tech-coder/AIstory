"use client";

import type {
  LocalMiniDramaDrama,
  LocalMiniDramaProjectContext,
} from "@/lib/localminidrama/types";

type ProjectContextState = "idle" | "loading" | "ready" | "empty" | "error";

type CreatorProjectContextPanelProps = {
  projects: LocalMiniDramaDrama[];
  selectedProjectId: number | null;
  context: LocalMiniDramaProjectContext | null;
  aistoryAssetCount: number;
  state: ProjectContextState;
  onSelect: (projectId: number) => void;
  onRefresh: () => void;
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "未知",
};

function formatUpdatedAt(value?: string) {
  if (!value) return "尚无更新时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无更新时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function CreatorProjectContextPanel({
  projects,
  selectedProjectId,
  context,
  aistoryAssetCount,
  state,
  onSelect,
  onRefresh,
}: CreatorProjectContextPanelProps) {
  return (
    <section className="border-b border-[#6f4f2f]/15 bg-[#f8f3e9] px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[#6d5c48] sm:flex-none">
          当前项目
          <select
            value={selectedProjectId ?? ""}
            onChange={(event) => onSelect(Number(event.target.value))}
            disabled={projects.length === 0}
            className="h-9 min-w-0 flex-1 border border-[#6f4f2f]/25 bg-[#fffdf8] px-3 text-sm font-medium outline-none focus:border-[#8a5a2b] sm:w-60"
            aria-label="当前短剧项目"
          >
            {projects.length === 0 && <option value="">暂无项目</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                #{project.id} {project.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!selectedProjectId || state === "loading"}
          className="inline-flex h-9 items-center gap-2 border border-[#6f4f2f]/25 px-3 text-xs text-[#6d5134] hover:bg-white disabled:opacity-50"
        >
          <i
            className={`fa-solid fa-rotate ${state === "loading" ? "animate-spin" : ""}`}
          />
          刷新项目
        </button>
        {context && (
          <span className="text-xs text-[#7b6954]">
            最近更新 {formatUpdatedAt(context.lastUpdatedAt)}
          </span>
        )}
      </div>

      {state === "empty" && (
        <p className="mt-3 border border-dashed border-[#8a5a2b]/30 bg-white/45 px-3 py-2 text-sm text-[#756552]">
          本地制作引擎中暂无项目；可先回到“AIstory 剧本台”创建草稿。
        </p>
      )}
      {state === "error" && (
        <p className="mt-3 border border-red-800/20 bg-red-50 px-3 py-2 text-sm text-red-800">
          项目摘要暂不可用，专业画布仍可保留当前页面，稍后可重试。
        </p>
      )}
      {state === "loading" && !context && (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-14 animate-pulse border border-[#6f4f2f]/10 bg-white/55"
            />
          ))}
        </div>
      )}
      {context && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-7">
            {[
              ["角色", context.counts.characters],
              ["场景", context.counts.scenes],
              ["道具", context.counts.props],
              ["任务", context.counts.tasks],
              ["图片", context.counts.images],
              ["视频", context.counts.videos],
              ["本地素材", aistoryAssetCount],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="border border-[#6f4f2f]/15 bg-white/60 px-2 py-2"
              >
                <div className="text-lg font-semibold text-[#7b4e25]">
                  {value}
                </div>
                <div className="text-[11px] text-[#7b6954]">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-semibold text-[#6d5134]">
              {context.project.title}
            </span>
            <span className="border border-[#6f4f2f]/15 px-2 py-1 text-[#756552]">
              {context.project.status}
            </span>
            <span className="text-[#7b6954]">
              {context.project.episodeCount} 集
            </span>
            {context.state === "partial" && (
              <span className="border border-amber-700/20 bg-amber-50 px-2 py-1 text-amber-800">
                部分统计暂不可用
              </span>
            )}
            {context.activeTasks.slice(0, 4).map((task) => (
              <span
                key={task.id}
                className="border border-[#6f4f2f]/15 bg-white/55 px-2 py-1 text-[#6d5c48]"
                title={`${task.type} · ${task.progress}%`}
              >
                {TASK_STATUS_LABEL[task.status] ?? task.status} {task.progress}%
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
