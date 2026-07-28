"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/client";
import { syncOnLogin } from "@/lib/persistence/cloudSync";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { AuthModal } from "@/components/AuthModal";
import { useI18n } from "@/lib/i18n/client";

type LocalAccount = {
  userId: string;
  displayName: string;
  maskedContact?: string;
  balance: number;
};

export function UserChip() {
  const { t } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [localAccount, setLocalAccount] = useState<LocalAccount | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refreshLocalAccount = async () => {
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        const result = await response.json() as {
          authenticated?: boolean;
          account?: LocalAccount | null;
        };
        if (!cancelled) {
          setLocalAccount(result.authenticated ? result.account || null : null);
        }
      } catch {
        if (!cancelled) setLocalAccount(null);
      }
    };
    void refreshLocalAccount();
    window.addEventListener("aistory:account-changed", refreshLocalAccount);
    if (!AUTH_ENABLED) {
      return () => {
        cancelled = true;
        window.removeEventListener(
          "aistory:account-changed",
          refreshLocalAccount,
        );
      };
    }
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }: { data: { user: User | null } }) => setUser(data.user));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      setUser(session?.user ?? null);
      // A signed-in user — a fresh login (SIGNED_IN) OR an already-authed mount
      // (INITIAL_SESSION fires on subscribe with the current session) — triggers
      // a full reconcile. syncOnLogin serializes via its in-flight guard, so
      // overlapping events never run concurrent syncs (Req 4.1, 4.2, 4.3). This
      // is the single global trigger point; AuthModal instances don't duplicate it.
      if (session?.user && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        void syncOnLogin();
      }
    });
    return () => {
      cancelled = true;
      window.removeEventListener("aistory:account-changed", refreshLocalAccount);
      subscription.unsubscribe();
    };
  }, []);

  const handleLogout = useCallback(async () => {
    await fetch("/api/account/me", { method: "DELETE" }).catch(() => undefined);
    if (AUTH_ENABLED) {
      const supabase = createClient();
      await supabase.auth.signOut();
    }
    setUser(null);
    setLocalAccount(null);
    setMenuOpen(false);
    window.dispatchEvent(new Event("aistory:account-changed"));
  }, []);

  if (!user && !localAccount) {
    return (
      <>
        <button
          type="button"
          onClick={() => setLoginOpen(true)}
          className="flex min-h-8 items-center gap-2 rounded-full border border-cream-50/25 bg-cream-50/[0.1] px-3 py-1.5 text-xs font-medium text-cream-50/90 transition-colors hover:border-cream-50/40 hover:bg-cream-50/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(215,183,110,0.65)]"
          aria-label={t("auth.loginOrRegister")}
          title={t("auth.loginOrRegister")}
        >
          <i className="fa-solid fa-mobile-screen-button text-[11px]" />
          {t("auth.loginOrRegister")}
        </button>
        {loginOpen && (
          <AuthModal
            onClose={() => setLoginOpen(false)}
            onSuccess={() => {
              setLoginOpen(false);
              window.dispatchEvent(new Event("aistory:account-changed"));
            }}
          />
        )}
      </>
    );
  }

  const label =
    localAccount?.displayName
    ?? user?.user_metadata?.full_name
    ?? user?.email?.split("@")[0]
    ??
    "User";
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const initial = label.charAt(0).toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center justify-center rounded-full border border-cream-50/15 bg-cream-50/[0.06] p-0.5 text-cream-50/80 transition-colors hover:bg-cream-50/[0.12]"
        title={
          localAccount
            ? `${label} · ${localAccount.balance.toLocaleString("zh-CN")} 积分`
            : label
        }
      >
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt=""
            width={16}
            height={16}
            unoptimized
            className="h-4 w-4 rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[rgba(175,138,72,0.6)] text-[9px] font-medium text-cream-50">
            {initial}
          </span>
        )}
      </button>
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
          />
          <div
            className="absolute right-0 top-full z-50 mt-1 min-w-[120px] overflow-hidden rounded-md"
            style={{
              background: "rgba(14, 10, 6, 0.92)",
              border: "1px solid rgba(175, 138, 72, 0.5)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
          >
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-[12px] text-cream-50/70 transition-colors hover:bg-cream-50/[0.08] hover:text-cream-50/90"
            >
              <i className="fa-solid fa-right-from-bracket text-[11px]" />
              退出登录
            </button>
            {localAccount && (
              <p className="border-t border-cream-50/10 px-3.5 py-2 text-[10px] text-cream-50/45">
                {localAccount.maskedContact} ·{" "}
                {localAccount.balance.toLocaleString("zh-CN")} 积分
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
