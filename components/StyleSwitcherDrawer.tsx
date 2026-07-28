"use client";

import { useEffect, useRef, useState } from "react";

import { STYLE_MAP } from "@/lib/options";
import {
  NARRATIVE_STYLE_GUIDES,
  NARRATIVE_STYLE_OPTIONS,
  VISUAL_STYLE_CHOICES,
} from "@/lib/styleHotSwap";
import { UsageDisclosureNote } from "@/components/UsageDisclosureNote";
import type { BranchPrefetchDepth } from "@infiplot/types";

export type StyleSelection = {
  styleGuide: string;
  styleReferenceImage?: string;
  narrativeStyle: string;
};

async function resizeReference(file: File, maxDim = 512): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取参考图"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取参考图"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const value = new Image();
    value.onload = () => resolve(value);
    value.onerror = () => reject(new Error("参考图格式不受支持"));
    value.src = source;
  });
  const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function StyleSwitcherDrawer({
  open,
  current,
  busy,
  feedback,
  prefetchDepth,
  onClose,
  onApplyNext,
  onRedrawCurrent,
  onRewriteCurrent,
}: {
  open: boolean;
  current: StyleSelection;
  busy: "visual" | "narrative" | null;
  feedback?: string;
  prefetchDepth: BranchPrefetchDepth;
  onClose: () => void;
  onApplyNext: (selection: StyleSelection) => void;
  onRedrawCurrent: (selection: StyleSelection) => void;
  onRewriteCurrent: (selection: StyleSelection) => void;
}) {
  const [selectedVisual, setSelectedVisual] = useState("自动");
  const [customVisual, setCustomVisual] = useState("");
  const [referenceImage, setReferenceImage] = useState<string | undefined>(
    current.styleReferenceImage,
  );
  const [selectedNarrative, setSelectedNarrative] = useState("自动");
  const [customNarrative, setCustomNarrative] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const matched = VISUAL_STYLE_CHOICES.find(
      (choice) =>
        (choice.name === "自动" && current.styleGuide === "auto") ||
        STYLE_MAP[choice.name] === current.styleGuide,
    );
    setSelectedVisual(matched?.name ?? "自定义风格");
    setCustomVisual(matched ? "" : current.styleGuide);
    setReferenceImage(current.styleReferenceImage);
    const narrative =
      NARRATIVE_STYLE_OPTIONS.find(
        (name) =>
          name === current.narrativeStyle ||
          NARRATIVE_STYLE_GUIDES[name] === current.narrativeStyle,
      ) ?? "自定义";
    setSelectedNarrative(narrative);
    setCustomNarrative(narrative === "自定义" ? current.narrativeStyle : "");
  }, [current, open]);

  if (!open) return null;

  const selection = (): StyleSelection => {
    const styleGuide =
      selectedVisual === "自动"
        ? "auto"
        : selectedVisual === "自定义风格"
          ? customVisual.trim() || current.styleGuide
          : STYLE_MAP[selectedVisual] || current.styleGuide;
    const narrativeStyle =
      selectedNarrative === "自定义"
        ? customNarrative.trim() || current.narrativeStyle || "自动"
        : NARRATIVE_STYLE_GUIDES[
            selectedNarrative as keyof typeof NARRATIVE_STYLE_GUIDES
          ] || selectedNarrative;
    return { styleGuide, styleReferenceImage: referenceImage, narrativeStyle };
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/30 backdrop-blur-[2px]" onMouseDown={onClose}>
      <aside
        className="absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-2xl bg-cream-50 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[430px] md:rounded-none md:border-l md:border-clay-900/10"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center border-b border-clay-900/10 bg-cream-50/95 px-5 py-4 backdrop-blur">
          <i className="fa-solid fa-palette mr-3 text-ember-500" />
          <div>
            <h2 className="font-serif text-lg text-clay-900">风格热切换</h2>
            <p className="text-[11px] text-clay-400">剧情进度、关系与角色状态保持不变</p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto h-8 w-8 text-clay-500">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="space-y-6 p-5">
          <section>
            <div className="mb-3 flex items-end justify-between">
              <div>
                <h3 className="font-serif text-base text-clay-900">视觉风格</h3>
                <p className="text-[11px] text-clay-400">沿用角色参考与当前服装、伤势、道具状态</p>
              </div>
              <span className="text-[10px] text-clay-400">重绘约 1 张图</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {VISUAL_STYLE_CHOICES.map((choice) => (
                <button
                  key={choice.name}
                  type="button"
                  onClick={() => setSelectedVisual(choice.name)}
                  className={`overflow-hidden rounded-md border text-left transition ${
                    selectedVisual === choice.name
                      ? "border-ember-500 ring-1 ring-ember-500/30"
                      : "border-clay-900/10"
                  }`}
                >
                  <img src={choice.thumb} alt="" className="aspect-[4/3] w-full object-cover" />
                  <span className="block truncate px-2 py-1.5 text-[11px] text-clay-700">
                    {choice.name}
                  </span>
                </button>
              ))}
            </div>
            {selectedVisual === "自定义风格" && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={customVisual}
                  onChange={(event) => setCustomVisual(event.target.value)}
                  placeholder="描述画面质感、色彩、镜头与材质…"
                  className="h-20 w-full resize-none rounded-md border border-clay-900/15 bg-white p-3 text-sm outline-none focus:border-ember-500"
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void resizeReference(file).then(setReferenceImage);
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="rounded-md border border-clay-900/15 px-3 py-2 text-xs text-clay-600"
                >
                  <i className="fa-solid fa-image mr-2" />
                  {referenceImage ? "更换参考图" : "添加参考图"}
                </button>
              </div>
            )}
            <UsageDisclosureNote
              action="redraw_current"
              refreshKey={open}
              className="mt-3"
            />
          </section>

          <section className="border-t border-clay-900/10 pt-5">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <h3 className="font-serif text-base text-clay-900">叙事文风</h3>
                <p className="text-[11px] text-clay-400">只改措辞与节奏，不改事实和选项语义</p>
              </div>
              <span className="text-[10px] text-clay-400">改写约 1 次文本</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {NARRATIVE_STYLE_OPTIONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setSelectedNarrative(name)}
                  className={`rounded-full border px-3 py-2 text-xs ${
                    selectedNarrative === name
                      ? "border-ember-500 bg-ember-500/5 text-clay-900"
                      : "border-clay-900/12 text-clay-600"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
            {selectedNarrative === "自定义" && (
              <textarea
                value={customNarrative}
                onChange={(event) => setCustomNarrative(event.target.value)}
                placeholder="描述希望的叙述语气、句式与节奏…"
                className="mt-3 h-20 w-full resize-none rounded-md border border-clay-900/15 bg-white p-3 text-sm outline-none focus:border-ember-500"
              />
            )}
            <UsageDisclosureNote
              action="rewrite_current"
              refreshKey={open}
              className="mt-3"
            />
          </section>

          {feedback && (
            <p className="rounded-md bg-clay-900/5 px-3 py-2 text-xs text-clay-600">
              {feedback}
            </p>
          )}

          <UsageDisclosureNote
            action="apply_next_style"
            prefetchDepth={prefetchDepth}
            refreshKey={open}
          />

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onApplyNext(selection())}
              className="rounded-md bg-clay-900 px-3 py-2.5 text-xs text-cream-50 disabled:opacity-50"
            >
              从下一段开始
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onRedrawCurrent(selection())}
              className="rounded-md border border-clay-900/15 px-3 py-2.5 text-xs text-clay-700 disabled:opacity-50"
            >
              {busy === "visual" ? "新风格生成中…" : "重做当前画面"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onRewriteCurrent(selection())}
              className="rounded-md border border-clay-900/15 px-3 py-2.5 text-xs text-clay-700 disabled:opacity-50"
            >
              {busy === "narrative" ? "改写中…" : "重做当前段落"}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
