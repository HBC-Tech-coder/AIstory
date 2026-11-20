"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  INITIAL_CREDIT_GRANT,
  creditBalance,
  formatCredits,
  initializeCreditLedger,
} from "@/lib/credits";
import { useI18n } from "@/lib/i18n/client";
import {
  resolveAiUserLinkedBillingBalance,
  type AiUserPublicAccount,
} from "@/lib/auth/aiUserAccountPublic";
import type { LinghaoPassportV4PublicAccount } from "@/lib/auth/linghaoPassportV4ProductionPublic";

export type CreditBalanceDetails =
  | {
      balance: number;
      source: "browser_demo" | "server_account" | "aiuser_linked_phone";
    }
  | {
      balance: null;
      source: "unavailable";
      reason:
        | "aiuser_unlinked"
        | "aiuser_link_unknown"
        | "aiuser_billing_unavailable"
        | "passport_no_wallet"
        | "account_unavailable";
    };

export function useCreditBalance(): number | null {
  return useCreditBalanceDetails().balance;
}

export function useCreditBalanceDetails(): CreditBalanceDetails {
  const [details, setDetails] = useState<CreditBalanceDetails>({
    balance: null,
    source: "unavailable",
    reason: "account_unavailable",
  });
  const knownIsolatedIdentity = useRef(false);
  const requestEpoch = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const epoch = ++requestEpoch.current;
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        const result = await response.json() as {
          authenticated?: boolean;
          account?:
            | AiUserPublicAccount
            | LinghaoPassportV4PublicAccount
            | {
                balance?: number;
                authType?: "phone" | "supabase";
              }
            | null;
          code?: string;
        };
        if (cancelled || epoch !== requestEpoch.current) return;
        if (result.authenticated && result.account?.authType === "aiuser") {
          knownIsolatedIdentity.current = true;
          const linkedBalance = resolveAiUserLinkedBillingBalance(
            result.account,
          );
          if (linkedBalance !== null) {
            setDetails({
              balance: linkedBalance,
              source: "aiuser_linked_phone",
            });
            return;
          }
          setDetails({
            balance: null,
            source: "unavailable",
            reason:
              result.account.accountLinked === false
                ? "aiuser_unlinked"
                : result.account.accountLinked === null
                  ? "aiuser_link_unknown"
                  : "aiuser_billing_unavailable",
          });
          return;
        }
        if (result.authenticated && result.account?.authType === "passport_v4") {
          knownIsolatedIdentity.current = true;
          setDetails({
            balance: null,
            source: "unavailable",
            reason: "passport_no_wallet",
          });
          return;
        }
        if (
          result.code === "AIUSER_SESSION_UNAVAILABLE" ||
          result.code === "PASSPORT_V4_SESSION_UNAVAILABLE"
        ) {
          knownIsolatedIdentity.current = true;
          setDetails({
            balance: null,
            source: "unavailable",
            reason: "account_unavailable",
          });
          return;
        }
        if (!response.ok) throw new Error("ACCOUNT_UNAVAILABLE");
        knownIsolatedIdentity.current = false;
        if (
          !cancelled
          && result.authenticated
          && Number.isSafeInteger(result.account?.balance)
        ) {
          setDetails({
            balance: result.account!.balance!,
            source: "server_account",
          });
          return;
        }
        if (result.authenticated) {
          setDetails({
            balance: null,
            source: "unavailable",
            reason: "account_unavailable",
          });
          return;
        }
      } catch {
        // The browser demo ledger remains visible while the account API is down.
        if (cancelled || epoch !== requestEpoch.current) return;
        if (knownIsolatedIdentity.current) {
          setDetails({
            balance: null,
            source: "unavailable",
            reason: "account_unavailable",
          });
          return;
        }
      }
      try {
        const localBalance = creditBalance(initializeCreditLedger(localStorage));
        if (!cancelled) {
          setDetails({ balance: localBalance, source: "browser_demo" });
        }
      } catch {
        if (!cancelled) {
          setDetails({
            balance: INITIAL_CREDIT_GRANT,
            source: "browser_demo",
          });
        }
      }
    };
    void refresh();
    window.addEventListener("aistory:account-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("aistory:account-changed", refresh);
    };
  }, []);

  return details;
}

type CreditNoticeLocale = "zh-CN" | "en" | "ja";

type CreditNoticeCopy = {
  trigger: string;
  title: string;
  description: string;
  points: readonly string[];
  contact: string;
  close: string;
};

const CREDIT_NOTICE_COPY: Record<CreditNoticeLocale, CreditNoticeCopy> = {
  "zh-CN": {
    trigger: "查看测试积分说明",
    title: "测试积分说明",
    description:
      "请区分服务端测试积分与本机演示积分；是否可消费取决于当前服务和计费状态。",
    points: [
      "手机号账户显示的是服务端测试积分余额，实际余额以服务端为准。",
      "AIUser 只有完成显式关联且 Linked Billing 已开启，才可使用所关联手机号账户的余额。",
      "浏览器演示积分只保存在本机浏览器中，与服务端余额相互独立。",
      "积分是否可消费取决于当前服务与计费状态。",
      "后续充值功能暂不可用。",
    ],
    contact: "如对测试积分有疑问，请直接联系管理员。",
    close: "关闭",
  },
  en: {
    trigger: "View test credit information",
    title: "Test credit information",
    description:
      "Please distinguish server test credits from browser demo credits; whether they can be spent depends on the current service and billing status.",
    points: [
      "A phone account shows its server test-credit balance; the server-side balance is authoritative.",
      "AIUser can use the linked phone account balance only after explicit linking and Linked Billing are enabled.",
      "Browser demo credits stay in this browser and are separate from the server balance.",
      "Whether credits can be spent depends on the current service and billing status.",
      "Future recharge is currently unavailable.",
    ],
    contact: "If you have questions about test credits, contact the administrator.",
    close: "Close",
  },
  ja: {
    trigger: "テストクレジットの説明を見る",
    title: "テストクレジットのご案内",
    description:
      "サーバーのテストクレジットとこのブラウザのデモクレジットを区別してください。消費できるかどうかは、現在のサービスと課金状況によって異なります。",
    points: [
      "電話番号アカウントにはサーバーのテストクレジット残高が表示され、サーバー側の残高が基準です。",
      "AIUser が関連付けた電話番号アカウントの残高を使えるのは、明示的な関連付けと Linked Billing が有効な場合だけです。",
      "ブラウザのデモクレジットはこのブラウザ内にのみ保存され、サーバー残高とは独立しています。",
      "クレジットを消費できるかどうかは、現在のサービスと課金状況によって異なります。",
      "今後のチャージ機能は現在利用できません。",
    ],
    contact: "テストクレジットについてご不明な点は、管理者にお問い合わせください。",
    close: "閉じる",
  },
};

type CreditBalanceSourceCopy = {
  demo: string;
};

/** Visible balance suffix so browser-only demo credits are never mistaken for server credits. */
const CREDIT_BALANCE_SOURCE_COPY: Record<
  CreditNoticeLocale,
  CreditBalanceSourceCopy
> = {
  "zh-CN": { demo: "演示积分" },
  en: { demo: "Demo credits" },
  ja: { demo: "デモクレジット" },
};

const CREDIT_NOTICE_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function resolveCreditNoticeLocale(locale: string): CreditNoticeLocale {
  const normalized = locale.trim().toLowerCase();
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("ja")) return "ja";
  return "zh-CN";
}

export function CreditBalance({
  compact = false,
  showAdd = false,
}: {
  compact?: boolean;
  showAdd?: boolean;
  /**
   * Kept for backwards compatibility with existing callers.
   * The old misleading "add credits" toast is never triggered.
   */
  onAdd?: () => void;
}) {
  const { locale, t } = useI18n();
  const { balance, source } = useCreditBalanceDetails();
  const label = t("home.ui.credits");
  const noticeLocale = resolveCreditNoticeLocale(String(locale));
  const notice = CREDIT_NOTICE_COPY[noticeLocale];
  const balanceSource = CREDIT_BALANCE_SOURCE_COPY[noticeLocale];
  const [isNoticeOpen, setIsNoticeOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;
  const pointsId = `${dialogId}-points`;

  useEffect(() => {
    if (!isNoticeOpen) return;

    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = dialogRef.current?.querySelector<HTMLElement>(
        "[data-autofocus]",
      );
      (initialFocus ?? dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsNoticeOpen(false);
        return;
      }

      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(CREDIT_NOTICE_FOCUSABLE),
      );

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [isNoticeOpen]);

  const openNotice = () => setIsNoticeOpen(true);
  const closeNotice = () => setIsNoticeOpen(false);

  return (
    <>
      <div
        className={`credit-badge ${compact ? "credit-badge-compact" : ""}`}
        title={
          source === "unavailable"
            ? "当前独立账号没有可显示的平台积分；不可用不代表零余额或已赠分"
            : source === "aiuser_linked_phone"
              ? "AIUser Linked Billing：所关联手机号账户的服务端积分"
            : source === "server_account"
              ? "当前手机号账户的服务端测试积分"
              : "未登录：本机演示积分，与服务端余额相互独立"
        }
      >
        <span>
          {label}{" "}
          {source === "unavailable"
            ? "不可用"
            : formatCredits(balance, locale)}
          {source === "browser_demo" ? ` · ${balanceSource.demo}` : null}
        </span>
        {showAdd && source !== "unavailable" && (
          <button
            ref={triggerRef}
            type="button"
            onClick={openNotice}
            aria-label={notice.trigger}
            aria-haspopup="dialog"
            aria-expanded={isNoticeOpen}
            aria-controls={dialogId}
            title={notice.trigger}
            className="credit-add-button focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50"
          >
            <i
              className="fa-solid fa-circle-info text-[11px]"
              aria-hidden="true"
            />
          </button>
        )}
      </div>

      {isNoticeOpen &&
        createPortal(
          <div
            role="presentation"
            className="fixed inset-0 z-[90] flex items-end justify-center bg-clay-900/30 p-4 backdrop-blur-sm sm:items-center"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeNotice();
            }}
          >
            <div
              ref={dialogRef}
              id={dialogId}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={`${descriptionId} ${pointsId}`}
              tabIndex={-1}
              className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-md border border-clay-900/15 bg-white px-5 text-clay-900 shadow-2xl shadow-clay-900/25 sm:px-6"
              style={{
                paddingTop: "calc(1.25rem + env(safe-area-inset-top))",
                paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))",
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ember-500">
                    {label}
                  </p>
                  <h2
                    id={titleId}
                    className="mt-1 text-xl font-bold text-clay-900"
                  >
                    {notice.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={closeNotice}
                  data-autofocus
                  aria-label={notice.close}
                  title={notice.close}
                  className="-mr-1 inline-flex h-11 min-h-11 w-11 min-w-11 shrink-0 items-center justify-center rounded-sm border border-clay-900/15 text-lg leading-none text-clay-700 transition-colors hover:bg-cream-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              <p
                id={descriptionId}
                className="mt-3 text-sm leading-6 text-clay-700"
              >
                {notice.description}
              </p>

              <ul
                id={pointsId}
                className="mt-4 space-y-2.5 text-sm leading-6 text-clay-700"
              >
                {notice.points.map((point) => (
                  <li key={point} className="flex gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-ember-500"
                    />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-5 rounded-sm border border-clay-900/15 bg-cream-100 px-3.5 py-3 text-sm leading-6 text-clay-700">
                {notice.contact}
              </p>

              <button
                type="button"
                onClick={closeNotice}
                className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-sm bg-clay-900 px-5 py-2.5 text-sm font-semibold text-cream-50 transition-colors hover:bg-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                {notice.close}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
