"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/client";
import type { Character, TimelineDecision } from "@infiplot/types";
import {
  renderPersonalizedSpeaker,
  renderPersonalizedText,
} from "@/lib/personalization";

export type DialogueHistoryItem = {
  id: string;
  sceneIndex: number;
  speaker?: string;
  body?: string;
  narration?: string;
  selectedChoice?: string;
  freeformAction?: string;
};

export function DialogueHistoryModal({
  items,
  portrait,
  onClose,
  playerName,
  characters = [],
  decisions = [],
  activeBranchId,
  onReselect,
}: {
  items: DialogueHistoryItem[];
  portrait: boolean;
  onClose: () => void;
  playerName?: string;
  characters?: Character[];
  decisions?: TimelineDecision[];
  activeBranchId?: string;
  onReselect?: (decision: TimelineDecision, choiceId: string) => void;
}) {
  const { t, locale } = useI18n();
  const defaultPlayerName =
    locale === "en" ? "You" : locale === "ja" ? "あなた" : "你";
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center px-4 py-6 pointer-events-auto"
      style={{ background: "rgba(0,0,0,0.38)" }}
      onClick={onClose}
    >
      <div
        className={`w-full ${
          portrait ? "max-w-[92vw]" : "max-w-2xl"
        } max-h-[72dvh] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "rgba(3, 8, 22, 0.9)",
          border: "1.5px solid rgba(88, 120, 255, 0.62)",
          borderRadius: "6px",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow:
            "0 10px 42px rgba(0,0,0,0.62), inset 0 1px 0 rgba(151,174,255,0.12)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t("history.ariaLabel")}
      >
        <div className="flex items-center justify-between border-b border-cream-50/10 px-4 py-3">
          <div className="flex items-center gap-2 text-[10px] smallcaps text-cream-50/70">
            <i className="fa-solid fa-clock-rotate-left text-[10px]" />
            {t("history.title")}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center text-cream-50/60 transition-colors hover:text-cream-50"
            aria-label={t("history.closeAriaLabel")}
            title={t("history.close")}
          >
            <i className="fa-solid fa-xmark text-[12px]" />
          </button>
        </div>

        <div
          ref={listRef}
          className={`vn-scrollbar overflow-y-auto px-4 py-3 ${
            portrait ? "max-h-[58dvh]" : "max-h-[60dvh]"
          }`}
        >
          {decisions.length > 0 && (
            <div className="mb-4 space-y-3">
              <p className="text-[10px] smallcaps text-[rgba(151,174,255,0.92)]">
                关键抉择 · {decisions.length}
              </p>
              {decisions.map((decision) => (
                <article
                  key={decision.id}
                  className="overflow-hidden rounded-md border border-cream-50/15 bg-black/15"
                >
                  <div className="flex gap-3 p-3">
                    {decision.sceneThumbnailUrl && (
                      <img
                        src={decision.sceneThumbnailUrl}
                        alt=""
                        className="h-16 w-24 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-[9px] text-cream-50/45">
                        <span>第 {decision.sceneIndex} 幕</span>
                        <span>·</span>
                        <span>{new Date(decision.createdAt).toLocaleString()}</span>
                        {decision.branchId === activeBranchId && (
                          <span className="rounded-full border border-blue-400/40 px-2 py-0.5 text-blue-200">
                            当前路线
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 font-serif text-[13px] text-cream-50/90">
                        {renderPersonalizedText(
                          decision.question,
                          playerName,
                          defaultPlayerName,
                          characters,
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-2 border-t border-cream-50/10 p-3 sm:grid-cols-2">
                    {decision.choices.map((choice) => {
                      const selected = choice.id === decision.selectedChoiceId;
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          disabled={!decision.restorable || selected || !onReselect}
                          onClick={() => onReselect?.(decision, choice.id)}
                          className={`min-w-0 rounded border px-3 py-2 text-left text-[12px] ${
                            selected
                              ? "border-blue-400/50 bg-blue-400/10 text-blue-100"
                              : "border-cream-50/15 text-cream-50/75 hover:border-blue-400/40"
                          } disabled:cursor-default disabled:opacity-65`}
                        >
                          <span className="block truncate">
                            {selected ? "已选择 · " : "重选 · "}
                            {renderPersonalizedText(
                              choice.label,
                              playerName,
                              defaultPlayerName,
                              characters,
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {!decision.restorable && (
                    <p className="px-3 pb-3 text-[10px] text-cream-50/40">
                      旧会话缺少选择前快照，仅可查看。
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}

          <details open={decisions.length === 0}>
            <summary className="mb-3 cursor-pointer text-[10px] smallcaps text-cream-50/55">
              详细对话记录
            </summary>
          {items.length === 0 ? (
            <p className="py-8 text-center font-serif text-[13px] text-cream-50/55">
              {t("history.noHistory")}
            </p>
          ) : (
            <div className="space-y-3">
              {items.map((item) => (
                <div key={item.id} className="text-left">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-[9px] smallcaps text-cream-50/35">
                      {t("history.scene", { n: String(item.sceneIndex).padStart(3, "0") })}
                    </span>
                    {item.speaker && (
                      <span className="font-serif text-[12px] text-[rgba(151,174,255,0.92)]">
                        {renderPersonalizedSpeaker(item.speaker, playerName, defaultPlayerName, characters)}
                      </span>
                    )}
                  </div>
                  {item.narration && (
                    <p
                      className={`font-serif leading-[1.7] ${
                        item.body ? "mb-1" : ""
                      } ${portrait ? "text-[14px]" : "text-[12px]"}`}
                      style={{ color: "rgba(221,229,255,0.85)" }}
                    >
                      {renderPersonalizedText(item.narration, playerName, defaultPlayerName, characters)}
                    </p>
                  )}
                  {item.body && (
                    <p
                      className={`font-serif leading-[1.75] ${
                        portrait ? "text-[15px]" : "text-[13px]"
                      }`}
                      style={{ color: "rgba(245,248,255,0.94)" }}
                    >
                      {renderPersonalizedText(item.body, playerName, defaultPlayerName, characters)}
                    </p>
                  )}
                  {item.selectedChoice && (
                    <p className="mt-2 inline-flex max-w-full items-start gap-2 rounded-[5px] border border-[rgba(88,120,255,0.35)] bg-[rgba(49,91,255,0.10)] px-2.5 py-1.5 font-serif text-[12px] leading-snug text-cream-50/85">
                      <span className="shrink-0 text-[rgba(151,174,255,0.92)]">
                        {t("history.choice")}
                      </span>
                      <span>{renderPersonalizedText(item.selectedChoice, playerName, defaultPlayerName, characters)}</span>
                    </p>
                  )}
                  {item.freeformAction && (
                    <p className="mt-2 inline-flex max-w-full items-start gap-2 rounded-[5px] border border-ember-500/30 bg-ember-500/10 px-2.5 py-1.5 font-serif text-[12px] leading-snug text-cream-50/85">
                      <span className="shrink-0 text-ember-300/90">
                        {t("history.action")}
                      </span>
                      <span>{item.freeformAction}</span>
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          </details>
        </div>
      </div>
    </div>
  );
}
