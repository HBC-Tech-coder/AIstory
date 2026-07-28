"use client";

import { useEffect, useState } from "react";
import {
  INITIAL_CREDIT_GRANT,
  creditBalance,
  formatCredits,
  initializeCreditLedger,
} from "@/lib/credits";
import { useI18n } from "@/lib/i18n/client";

export function useCreditBalance(): number {
  return useCreditBalanceDetails().balance;
}

export function useCreditBalanceDetails(): {
  balance: number;
  source: "browser_demo" | "server_account";
} {
  const [balance, setBalance] = useState(INITIAL_CREDIT_GRANT);
  const [source, setSource] =
    useState<"browser_demo" | "server_account">("browser_demo");

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const localBalance = creditBalance(initializeCreditLedger(localStorage));
        if (!cancelled) {
          setBalance(localBalance);
          setSource("browser_demo");
        }
      } catch {
        if (!cancelled) setBalance(INITIAL_CREDIT_GRANT);
      }
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        const result = await response.json() as {
          authenticated?: boolean;
          account?: { balance?: number } | null;
        };
        if (
          !cancelled
          && result.authenticated
          && Number.isSafeInteger(result.account?.balance)
        ) {
          setBalance(result.account!.balance!);
          setSource("server_account");
        }
      } catch {
        // The browser demo ledger remains visible while the account API is down.
      }
    };
    void refresh();
    window.addEventListener("aistory:account-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("aistory:account-changed", refresh);
    };
  }, []);

  return { balance, source };
}

export function CreditBalance({
  compact = false,
  showAdd = false,
  onAdd,
}: {
  compact?: boolean;
  showAdd?: boolean;
  onAdd?: () => void;
}) {
  const { locale, t } = useI18n();
  const { balance, source } = useCreditBalanceDetails();
  const label = t("home.ui.credits");

  return (
    <div
      className={`credit-badge ${compact ? "credit-badge-compact" : ""}`}
      title={
        source === "server_account"
          ? "服务端账户积分"
          : "未登录：本机演示积分，不代表正式服务端余额"
      }
    >
      <span>
        {label} {formatCredits(balance, locale)}
      </span>
      {showAdd && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={t("home.ui.addCredits")}
          title={t("home.ui.addCredits")}
          className="credit-add-button"
        >
          <i className="fa-solid fa-plus text-[11px]" />
        </button>
      )}
    </div>
  );
}
