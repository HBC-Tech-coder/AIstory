"use client";

import type {
  LocalMiniDramaDrama,
  LocalMiniDramaProjectContext,
} from "@/lib/localminidrama/types";
import type {
  CreatorStudioMediaKind,
  CreatorStudioOpenModuleIntent,
} from "@/lib/creator-studio/bridge";

type ProjectContextState = "idle" | "loading" | "ready" | "empty" | "error";

type CreatorProjectContextPanelProps = {
  projects: LocalMiniDramaDrama[];
  selectedProjectId: number | null;
  context: LocalMiniDramaProjectContext | null;
  aistoryAssetCount: number;
  state: ProjectContextState;
  onSelect: (projectId: number) => void;
  onOpenModule: (intent: CreatorStudioOpenModuleIntent) => void;
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
  onOpenModule,
  onRefresh,
}: CreatorProjectContextPanelProps) {
  const openTasks = (taskId?: string) => {
    if (!selectedProjectId) return;
    onOpenModule(
      taskId
        ? { projectId: selectedProjectId, module: "tasks", taskId }
        : { projectId: selectedProjectId, module: "tasks" },
    );
  };
  const openMedia = (mediaKind: CreatorStudioMediaKind) => {
    if (!selectedProjectId) return;
    onOpenModule({ projectId: selectedProjectId, module: "media", mediaKind });
  };
  const openLocalAssets = () => {
    if (!selectedProjectId) return;
    onOpenModule({ projectId: selectedProjectId, module: "local-generation" });
  };
  const interactiveCountClass =
    "ui-surface group min-w-0 border px-2 py-2 text-center transition hover:border-ember-500/40 hover:bg-cream-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-500 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section className="ui-surface-soft border-b px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="ui-copy flex min-w-0 flex-1 items-center gap-2 text-xs sm:flex-none">
          当前项目
          <select
            value={selectedProjectId ?? ""}
            onChange={(event) => onSelect(Number(event.target.value))}
            disabled={projects.length === 0}
            className="ui-input h-9 min-w-0 flex-1 border px-3 text-sm font-medium sm:w-60"
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
          className="ui-button-secondary inline-flex h-9 items-center gap-2 border px-3 text-xs"
        >
          <i
            className={`fa-solid fa-rotate ${state === "loading" ? "animate-spin" : ""}`}
          />
          刷新项目
        </button>
        {context && (
          <span className="ui-muted text-xs">
            最近更新 {formatUpdatedAt(context.lastUpdatedAt)}
          </span>
        )}
      </div>

      {state === "empty" && (
        <p className="ui-surface ui-muted mt-3 border border-dashed px-3 py-2 text-sm">
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
              className="ui-surface h-14 animate-pulse border"
            />
          ))}
        </div>
      )}
      {context && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-7">
            {([
              ["角色", context.counts.characters],
              ["场景", context.counts.scenes],
              ["道具", context.counts.props],
            ] as const).map(([label, value]) => (
              <div
                key={label}
                className="ui-surface min-w-0 border px-2 py-2"
              >
                <div className="ui-primary text-lg font-semibold">
                  {value}
                </div>
                <div className="ui-muted text-[11px]">{label}</div>
              </div>
            ))}
            <button
              type="button"
              data-studio-context-target="tasks"
              onClick={() => openTasks()}
              disabled={!selectedProjectId}
              className={interactiveCountClass}
              aria-label={`打开任务模块，共 ${context.counts.tasks} 项`}
            >
              <div className="ui-primary text-lg font-semibold">
                {context.counts.tasks}
              </div>
              <div className="ui-muted text-[11px]">任务</div>
            </button>
            <button
              type="button"
              data-studio-context-target="media"
              data-studio-media-kind="image"
              onClick={() => openMedia("image")}
              disabled={!selectedProjectId}
              className={interactiveCountClass}
              aria-label={`打开图片媒体，共 ${context.counts.images} 项`}
            >
              <div className="ui-primary text-lg font-semibold">
                {context.counts.images}
              </div>
              <div className="ui-muted text-[11px]">图片</div>
            </button>
            <button
              type="button"
              data-studio-context-target="media"
              data-studio-media-kind="video"
              onClick={() => openMedia("video")}
              disabled={!selectedProjectId}
              className={interactiveCountClass}
              aria-label={`打开视频媒体，共 ${context.counts.videos} 项`}
            >
              <div className="ui-primary text-lg font-semibold">
                {context.counts.videos}
              </div>
              <div className="ui-muted text-[11px]">视频</div>
            </button>
            <button
              type="button"
              data-studio-context-target="local-generation"
              onClick={openLocalAssets}
              disabled={!selectedProjectId}
              className={interactiveCountClass}
              aria-label={`打开本地素材模块，共 ${aistoryAssetCount} 项`}
            >
              <div className="ui-primary text-lg font-semibold">
                {aistoryAssetCount}
              </div>
              <div className="ui-muted text-[11px]">本地素材</div>
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-semibold text-clay-700">
              {context.project.title}
            </span>
            <span className="ui-muted ui-border border px-2 py-1">
              {context.project.status}
            </span>
            <span className="ui-muted">
              {context.project.episodeCount} 集
            </span>
            {context.state === "partial" && (
              <span className="border border-amber-700/20 bg-amber-50 px-2 py-1 text-amber-800">
                部分统计暂不可用
              </span>
            )}
            {context.activeTasks.slice(0, 4).map((task) => (
              <button
                key={task.id}
                type="button"
                data-studio-context-target="tasks"
                data-studio-active-task={task.id}
                onClick={() => openTasks(task.id)}
                className="ui-button-secondary min-w-0 max-w-full border px-2 py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-500"
                title={`${task.type} · ${task.progress}%`}
                aria-label={`打开任务模块：${task.type}，${TASK_STATUS_LABEL[task.status] ?? task.status}，进度 ${task.progress}%`}
              >
                {TASK_STATUS_LABEL[task.status] ?? task.status} {task.progress}%
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
