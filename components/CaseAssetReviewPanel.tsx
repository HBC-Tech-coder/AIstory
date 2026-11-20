"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  CaseReviewAsset,
  CaseReviewDecision,
  CaseReviewSnapshot,
} from "@/lib/case-studies/reviewAssets";

const STATUS_LABEL: Record<CaseReviewDecision, string> = {
  review_pending: "待审核",
  approved_candidate: "可发布候选",
  rejected_for_publication: "不进入公开作品",
};

const STATUS_TONE: Record<CaseReviewDecision, string> = {
  review_pending: "border-amber-700/25 bg-amber-50 text-amber-900",
  approved_candidate: "border-emerald-700/25 bg-emerald-50 text-emerald-800",
  rejected_for_publication: "border-rose-700/20 bg-rose-50 text-rose-800",
};

const FILTERS: Array<{ id: "all" | CaseReviewDecision; label: string }> = [
  { id: "all", label: "全部" },
  { id: "review_pending", label: "待审核" },
  { id: "approved_candidate", label: "可发布候选" },
  { id: "rejected_for_publication", label: "不公开" },
];

function qualityTone(value: string) {
  if (value.startsWith("pass") || value === "not_applicable") {
    return "border-emerald-700/20 bg-emerald-50 text-emerald-800";
  }
  if (value.startsWith("fail")) {
    return "border-rose-700/20 bg-rose-50 text-rose-800";
  }
  return "border-amber-700/20 bg-amber-50 text-amber-900";
}

function ReviewAssetCard({
  item,
  busy,
  onDecision,
}: {
  item: CaseReviewAsset;
  busy: boolean;
  onDecision: (item: CaseReviewAsset, decision: CaseReviewDecision) => void;
}) {
  const qualities: Array<[string, string]> = [
    ["画面", item.review.sceneQuality],
    ["角色", item.review.characterContinuity],
    ["人脸", item.review.referenceFaceFidelity],
    ["服装", item.review.clothingContinuity],
    ["动作", item.review.actionFit],
    ["公开安全", item.review.publicSafety],
  ];
  return (
    <article className="ui-surface min-w-0 border">
      <div className="aspect-video overflow-hidden bg-[#07132f]">
        {item.modality === "video" ? (
          <video
            src={item.previewUrl}
            controls
            preload="metadata"
            className="h-full w-full object-contain"
          />
        ) : (
          // The review API streams hash-verified local assets and is not a public CDN.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.previewUrl}
            alt={item.label}
            className="h-full w-full object-contain"
          />
        )}
      </div>
      <div className="p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate font-serif text-lg">{item.label}</h2>
            <p className="ui-muted mt-0.5 text-[11px]">
              {item.modality === "video" ? "视频" : "图片"} · {item.width}×
              {item.height}
              {item.durationSeconds ? ` · ${item.durationSeconds.toFixed(2)} 秒` : ""}
            </p>
          </div>
          <span
            className={`shrink-0 border px-2 py-1 text-[11px] ${STATUS_TONE[item.review.publicationStatus]}`}
          >
            {STATUS_LABEL[item.review.publicationStatus]}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {qualities.map(([label, value]) => (
            <span
              key={label}
              className={`border px-1.5 py-0.5 text-[10px] ${qualityTone(value)}`}
              title={value}
            >
              {label}：{value}
            </span>
          ))}
        </div>
        <p className="ui-copy mt-3 min-h-12 text-xs leading-5">
          {item.review.notes || "尚无审核备注。"}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {(
            [
              ["review_pending", "保留待审"],
              ["approved_candidate", "可发布候选"],
              ["rejected_for_publication", "不公开"],
            ] as const
          ).map(([decision, label]) => (
            <button
              key={decision}
              type="button"
              disabled={busy || item.review.publicationStatus === decision}
              onClick={() => onDecision(item, decision)}
              className="ui-button-secondary min-h-9 border px-1 text-[11px]"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

export function CaseAssetReviewPanel() {
  const [snapshot, setSnapshot] = useState<CaseReviewSnapshot | null>(null);
  const [filter, setFilter] = useState<"all" | CaseReviewDecision>("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/case-studies/review-assets", {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        data?: CaseReviewSnapshot;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || "本地审核清单不可用");
      }
      setSnapshot(payload.data);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "本地审核清单不可用");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleItems = useMemo(
    () =>
      snapshot?.items.filter(
        (item) => filter === "all" || item.review.publicationStatus === filter,
      ) ?? [],
    [filter, snapshot?.items],
  );

  const setDecision = async (
    item: CaseReviewAsset,
    decision: CaseReviewDecision,
  ) => {
    setBusyId(item.id);
    setMessage("");
    try {
      const response = await fetch("/api/case-studies/review-assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          decision,
          note: item.review.notes,
        }),
      });
      const payload = (await response.json()) as {
        data?: CaseReviewSnapshot;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || "审核状态更新失败");
      }
      setSnapshot(payload.data);
      setMessage(
        decision === "approved_candidate"
          ? "已标记为可发布候选；尚未复制到公开作品。"
          : "审核状态已保存到本机清单。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "审核状态更新失败");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="min-h-[calc(100vh-65px)]">
      <header className="ui-surface border-b px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="ui-primary text-[11px] font-semibold uppercase">
              AIstory Local Review
            </p>
            <h1 className="mt-1 font-serif text-2xl">《她不在出厂设定里》案例审片</h1>
            <p className="ui-muted mt-1 max-w-3xl text-xs leading-5">
              候选素材仅保存在本机作者锁定目录。审核标签不会自动改写公开
              story.json，也不会把原始人脸参考、提示词或本地路径暴露给玩家。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="ui-button-secondary inline-flex h-9 items-center gap-2 border px-3 text-xs"
          >
            <i className={`fa-solid fa-rotate ${loading ? "animate-spin" : ""}`} />
            刷新清单
          </button>
        </div>
        <div className="mt-4 grid max-w-2xl grid-cols-3 gap-2 text-center text-xs">
          <div className="border border-amber-700/20 bg-amber-50 p-2 text-amber-900">
            待审核 {snapshot?.counts.review_pending ?? 0}
          </div>
          <div className="border border-emerald-700/20 bg-emerald-50 p-2 text-emerald-800">
            可发布候选 {snapshot?.counts.approved_candidate ?? 0}
          </div>
          <div className="border border-rose-700/20 bg-rose-50 p-2 text-rose-800">
            不公开 {snapshot?.counts.rejected_for_publication ?? 0}
          </div>
        </div>
      </header>

      <div className="px-4 py-4 lg:px-6">
        <div className="ui-border flex max-w-full gap-1 overflow-x-auto border-b pb-2">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`shrink-0 border px-3 py-2 text-xs ${
                filter === item.id
                  ? "border-ember-500 bg-ember-500 text-white"
                  : "border-ember-500/25 bg-cream-50/70 text-clay-700"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {message && (
          <p className="mt-3 border border-ember-500/20 bg-cream-50/70 px-3 py-2 text-xs text-clay-700">
            {message}
          </p>
        )}
        {loading && !snapshot ? (
          <div className="ui-muted ui-border mt-4 border border-dashed p-8 text-center text-sm">
            正在读取本机审核清单…
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="ui-muted ui-border mt-4 border border-dashed p-8 text-center text-sm">
            当前筛选没有素材。
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {visibleItems.map((item) => (
              <ReviewAssetCard
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onDecision={(asset, nextDecision) =>
                  void setDecision(asset, nextDecision)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
