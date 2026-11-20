"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/client";
import { syncOnLogin } from "@/lib/persistence/cloudSync";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { AuthModal } from "@/components/AuthModal";
import { useI18n } from "@/lib/i18n/client";
import {
  applyAnonymousClaimResult,
  resetClaimClientStateOnLogout,
} from "@/lib/auth/anonymousClaimClient";
import type { AnonymousClaimResult } from "@/lib/auth/anonymousClaim";
import { setActiveStoryNamespace } from "@/lib/persistence/storyNamespace";
import {
  resolveAiUserLinkedBillingBalance,
  type AiUserPublicAccount,
} from "@/lib/auth/aiUserAccountPublic";
import type { LinghaoPassportV4PublicAccount } from "@/lib/auth/linghaoPassportV4ProductionPublic";

type LocalAccount = {
  authType: "phone" | "supabase";
  userId: string;
  displayName: string;
  maskedContact?: string;
  balance: number;
} | AiUserPublicAccount | LinghaoPassportV4PublicAccount;

export function UserChip() {
  const { t } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [localAccount, setLocalAccount] = useState<LocalAccount | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const aiuserActive = useRef(false);
  const passportActive = useRef(false);
  const suppressLegacy = useRef(false);
  const requestEpoch = useRef(0);
  const logoutPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const refreshLocalAccount = async () => {
      if (logoutPending.current) return;
      const epoch = ++requestEpoch.current;
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        const result = await response.json() as {
          authenticated?: boolean;
          account?: LocalAccount | null;
          claim?: AnonymousClaimResult;
          code?: string;
        };
        if (!cancelled && epoch === requestEpoch.current) {
          const account = result.authenticated ? result.account || null : null;
          setLocalAccount(account);
          aiuserActive.current = account?.authType === "aiuser";
          passportActive.current = account?.authType === "passport_v4";
          if (
            aiuserActive.current || passportActive.current ||
            result.code === "AIUSER_SESSION_UNAVAILABLE" ||
            result.code === "PASSPORT_V4_SESSION_UNAVAILABLE"
          ) {
            suppressLegacy.current = true; setUser(null);
          }
          if (account && (account.authType === "phone" || account.authType === "supabase")) {
            setActiveStoryNamespace(account.userId);
            if (result.claim) {
              void applyAnonymousClaimResult(
                account.userId,
                result.claim,
              ).catch(() => undefined);
            }
          } else {
            setActiveStoryNamespace();
          }
        }
      } catch {
        if (!cancelled && epoch === requestEpoch.current) setLocalAccount(null);
      }
    };
    const initialAccount = refreshLocalAccount();
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
    void initialAccount.then(async () => {
      if (cancelled || suppressLegacy.current) return;
      const { data } = await supabase.auth.getUser();
      if (!cancelled && !suppressLegacy.current) setUser(data.user);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      void initialAccount.then(() => { if (!cancelled && !suppressLegacy.current) setUser(session?.user ?? null); });
      // A signed-in user — a fresh login (SIGNED_IN) OR an already-authed mount
      // (INITIAL_SESSION fires on subscribe with the current session) — triggers
      // a full reconcile. syncOnLogin serializes via its in-flight guard, so
      // overlapping events never run concurrent syncs (Req 4.1, 4.2, 4.3). This
      // is the single global trigger point; AuthModal instances don't duplicate it.
      if (session?.user && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        void initialAccount.then(() => { if (!cancelled && !suppressLegacy.current) void syncOnLogin(); });
      }
    });
    return () => {
      cancelled = true;
      window.removeEventListener("aistory:account-changed", refreshLocalAccount);
      subscription.unsubscribe();
    };
  }, []);

  const handleLogout = useCallback(async () => {
    if (logoutPending.current) return;
    logoutPending.current = true; requestEpoch.current++;
    setLogoutFailed(false);
    const response = await fetch("/api/account/me", { method: "DELETE" }).catch(() => null);
    if (!response?.ok) { setLogoutFailed(true); logoutPending.current = false; return; }
    const wasPassport = passportActive.current;
    if (AUTH_ENABLED && !aiuserActive.current && !wasPassport) {
      const supabase = createClient();
      await supabase.auth.signOut().catch(() => undefined);
    }
    aiuserActive.current = false;
    passportActive.current = false;
    if (wasPassport) suppressLegacy.current = false;
    setUser(null);
    setLocalAccount(null);
    resetClaimClientStateOnLogout();
    setMenuOpen(false);
    logoutPending.current = false;
    window.dispatchEvent(new Event("aistory:account-changed"));
  }, []);

  if (!user && !localAccount) {
    return (
      <>
        <button
          type="button"
          onClick={() => setLoginOpen(true)}
          className="flex min-h-8 items-center gap-2 rounded-full border border-ember-500/30 bg-ember-500/10 px-3 py-1.5 text-xs font-semibold text-ember-500 transition-colors hover:border-ember-500/55 hover:bg-ember-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/35"
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
  const avatarUrl = localAccount?.authType === "aiuser" || localAccount?.authType === "passport_v4"
    ? undefined
    : user?.user_metadata?.avatar_url as string | undefined;
  const aiUserLinkedBalance = localAccount?.authType === "aiuser"
    ? resolveAiUserLinkedBillingBalance(localAccount)
    : null;
  const aiUserAccountLabel = localAccount?.authType !== "aiuser"
    ? null
    : aiUserLinkedBalance !== null
      ? `AIUser · Linked Billing · ${aiUserLinkedBalance.toLocaleString("zh-CN")} 积分`
      : localAccount.accountLinked === false
        ? "AIUser · 未关联手机号账户"
        : localAccount.accountLinked === null
          ? "AIUser · 关联与积分状态暂不可用"
          : "AIUser · 已关联手机号 · Linked Billing 未开通";
  const initial = label.charAt(0).toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center justify-center rounded-full border border-ember-500/25 bg-ember-500/10 p-0.5 text-ember-500 transition-colors hover:border-ember-500/45 hover:bg-ember-500/15"
        title={
          localAccount?.authType === "aiuser"
            ? aiUserAccountLabel ?? label
            : localAccount?.authType === "passport_v4"
              ? "灵号通行证 · 独立新账号空间 · 无旧积分"
            : localAccount
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
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-500/70 text-[9px] font-medium text-white">
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
              background: "rgba(3, 8, 22, 0.94)",
              border: "1px solid rgba(88, 120, 255, 0.55)",
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
            {logoutFailed && <p role="alert" className="px-3.5 py-2 text-xs">退出尚未确认，请重试。</p>}
            {localAccount?.authType === "aiuser" && <Link href="/auth/aiuser" className="block px-3.5 py-2 text-xs">{aiUserAccountLabel}</Link>}
            {localAccount?.authType === "passport_v4" && <Link href="/auth/linghao-passport-v4" className="block px-3.5 py-2 text-xs">灵号通行证 · 独立新账号空间 · 无旧积分</Link>}
            {localAccount?.authType === "phone" && <Link href="/auth/aiuser" className="block px-3.5 py-2 text-xs">当前手机号账户 · AIUser 显式关联</Link>}
            {localAccount && (localAccount.authType === "phone" || localAccount.authType === "supabase") && (
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
