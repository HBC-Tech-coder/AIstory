"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import LinghaoPassportV4LocalPanel from "@/components/LinghaoPassportV4LocalPanel";
import { LinghaoPassportV4LoginButton } from "@/components/LinghaoPassportV4LoginButton";
import { LINGHAO_PASSPORT_V4_PRODUCTION_RETURN_PATH } from "@/lib/auth/linghaoPassportV4ProductionPublic";

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

type ProductionCapability = Readonly<{
  enabled: boolean;
  mode: "production";
  publicEntry: boolean;
}>;

type ProductionAccount = Readonly<{
  displayName: "灵号通行证用户";
  expiresAt: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function productionCapability(value: unknown): ProductionCapability | null {
  if (!isRecord(value) || !exact(value, ["enabled", "mode", "publicEntry"])) return null;
  if (typeof value.enabled !== "boolean" || value.mode !== "production" || typeof value.publicEntry !== "boolean") return null;
  if (!value.enabled && value.publicEntry) return null;
  return value as unknown as ProductionCapability;
}

function isLocalCapability(value: unknown): boolean {
  return isRecord(value)
    && exact(value, ["enabled"])
    && typeof value.enabled === "boolean";
}

function safeAccount(value: unknown): ProductionAccount | null {
  if (!isRecord(value) || !exact(value, [
    "authType", "displayName", "status", "expiresAt", "balance", "ledger", "capabilities",
  ])) return null;
  if (
    value.authType !== "passport_v4" || value.displayName !== "灵号通行证用户" ||
    value.status !== "active" || !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= Date.now() || value.balance !== null ||
    !Array.isArray(value.ledger) || value.ledger.length !== 0 || !isRecord(value.capabilities)
  ) return null;
  const capabilities = value.capabilities;
  const expected: Record<string, boolean> = {
    ordinaryProductAccess: true,
    newContentNamespace: true,
    legacyAccountRead: false,
    legacyAccountLink: false,
    administrator: false,
    phoneAccount: false,
    formalWallet: false,
    platformPaidGeneration: false,
    cloudProgress: false,
    hostedByok: false,
  };
  if (!exact(capabilities, Object.keys(expected))) return null;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (capabilities[key] !== expectedValue) return null;
  }
  return { displayName: value.displayName, expiresAt: value.expiresAt as number };
}

function safeLogoutNotice(value: unknown): string | null {
  if (!isRecord(value) || !exact(value, [
    "status", "localLoggedOut", "revocationConfirmed", "upstreamReturnConfirmed",
  ])) return null;
  if (
    value.status !== "consumed" || value.localLoggedOut !== true ||
    typeof value.revocationConfirmed !== "boolean" ||
    typeof value.upstreamReturnConfirmed !== "boolean"
  ) return null;
  if (!value.revocationConfirmed) return "本地会话已撤销；上游令牌撤销尚未确认。";
  return value.upstreamReturnConfirmed
    ? "本地会话与上游令牌撤销已确认，并已从上游登出返回。"
    : "本地会话与上游令牌撤销已确认。";
}

function ProductionPanel({ capability }: { capability: ProductionCapability }) {
  const [account, setAccount] = useState<ProductionAccount | null>(null);
  const [notice, setNotice] = useState("");
  const logoutReceiptRef = useRef<{ state: string; promise: Promise<string> } | null>(null);

  useEffect(() => {
    let active = true;
    const readLogoutReceipt = (state: string): Promise<string> => {
      const existing = logoutReceiptRef.current;
      if (existing?.state === state) return existing.promise;
      const promise = fetch(
        `/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(state)}`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
        },
      ).then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        return response.ok
          ? safeLogoutNotice(body) ?? "登出结果无法验证。"
          : "登出结果无效、已过期或已被使用。";
      }).catch(() => "登出结果校验暂不可用。");
      logoutReceiptRef.current = { state, promise };
      return promise;
    };

    const initialize = async (): Promise<void> => {
      const current = new URL(window.location.href);
      const state = current.pathname === LINGHAO_PASSPORT_V4_PRODUCTION_RETURN_PATH
        ? current.searchParams.get("state")
        : null;
      if (state && OPAQUE.test(state)) {
        const logoutNotice = await readLogoutReceipt(state);
        window.history.replaceState(null, "", `${current.pathname}${current.hash}`);
        if (active) setNotice(logoutNotice);
      }
      try {
        const response = await fetch("/api/auth/linghao-passport-v4/session", {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json().catch(() => null);
        if (!active) return;
        if (
          response.ok && isRecord(body) && exact(body, ["authenticated", "account"])
          && body.authenticated === true
        ) {
          setAccount(safeAccount(body.account));
        } else {
          setAccount(null);
        }
      } catch {
        if (active) setAccount(null);
      }
    };
    void initialize();
    return () => { active = false; };
  }, []);

  return (
    <section className="mx-auto max-w-2xl space-y-5 p-6 text-sm">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-neutral-500">AIstory account sign-in</p>
        <h1 className="text-2xl font-semibold">灵号通行证</h1>
        <p className="text-neutral-600">
          新账号空间与旧手机号、AIUser、Supabase 账号完全隔离；不会读取、关联或迁移旧账号数据。
        </p>
      </header>

      {account ? (
        <div className="space-y-3 rounded border border-neutral-300 p-3">
          <p><strong>{account.displayName}</strong></p>
          <p className="text-neutral-600">当前为独立的新账号空间，不含旧余额、旧作品、管理员或托管 BYOK 权限。</p>
          <form method="post" action="/api/auth/linghao-passport-v4/logout">
            <button type="submit" className="rounded border border-neutral-400 px-3 py-2">退出灵号通行证</button>
          </form>
        </div>
      ) : !capability.enabled || !capability.publicEntry ? (
        <div className="rounded border border-neutral-300 p-3">
          正式入口尚未开放。生产配置、身份提供方登记和灰度部署全部验收后才会显示主登录按钮。
        </div>
      ) : (
        <LinghaoPassportV4LoginButton />
      )}

      <div className="rounded border border-dashed border-neutral-300 p-3 text-neutral-600">
        <p>旧登录入口（回退）</p>
        <p className="mt-1 text-xs">退出灵号通行证后，可继续使用旧 AIUser/手机号入口；两套账号不会自动合并。</p>
        <Link href="/auth/aiuser" className="mt-2 inline-block underline">前往旧账号入口</Link>
      </div>
      {notice ? <p aria-live="polite" className="rounded bg-neutral-100 p-3">{notice}</p> : null}
    </section>
  );
}

export default function LinghaoPassportV4EntryPanel() {
  const [state, setState] = useState<"checking" | "local" | "unavailable" | ProductionCapability>("checking");
  useEffect(() => {
    let active = true;
    void fetch("/api/auth/linghao-passport-v4/capabilities", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      const body: unknown = await response.json().catch(() => null);
      if (!active) return;
      if (!response.ok) return setState("unavailable");
      if (isLocalCapability(body)) return setState("local");
      const production = productionCapability(body);
      setState(production ?? "unavailable");
    }).catch(() => { if (active) setState("unavailable"); });
    return () => { active = false; };
  }, []);
  if (state === "local") return <LinghaoPassportV4LocalPanel />;
  if (typeof state === "object") return <ProductionPanel capability={state} />;
  return (
    <section className="mx-auto max-w-2xl p-6 text-sm">
      {state === "checking" ? "正在检查登录能力…" : "登录能力暂不可用；没有发起任何旧认证或导航。"}
    </section>
  );
}
