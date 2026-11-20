"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
  LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
  LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES,
} from "@/lib/auth/linghaoPassportV4ProductionPublic";

const AUTHORIZATION_PATH = "/login/oauth/authorize";
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isLinghaoPassportV4PublicEntryCapability(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["enabled", "mode", "publicEntry"])
    && value.enabled === true
    && value.mode === "production"
    && value.publicEntry === true;
}

export function allowedLinghaoPassportV4AuthorizationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (
    url.protocol !== "https:" ||
    url.origin !== LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER ||
    url.pathname !== AUTHORIZATION_PATH ||
    url.username || url.password || url.hash
  ) return null;
  const required = new Map<string, string>([
    ["response_type", "code"],
    ["client_id", LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID],
    ["redirect_uri", LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK],
    ["scope", LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES.join(" ")],
    ["code_challenge_method", "S256"],
  ]);
  for (const [key, expected] of required) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expected) return null;
  }
  for (const key of ["state", "nonce", "code_challenge"]) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !OPAQUE.test(values[0] ?? "")) return null;
  }
  const known = new Set([...required.keys(), "state", "nonce", "code_challenge"]);
  for (const key of url.searchParams.keys()) if (!known.has(key)) return null;
  return url.href;
}

async function publicEntryAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/linghao-passport-v4/capabilities", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    return isLinghaoPassportV4PublicEntryCapability(await response.json());
  } catch {
    return false;
  }
}

function PassportStartButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/auth/linghao-passport-v4/start", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      });
      const body: unknown = await response.json().catch(() => null);
      const target = response.ok && isRecord(body)
        && hasExactKeys(body, ["authorizationUrl"])
        ? allowedLinghaoPassportV4AuthorizationUrl(body.authorizationUrl)
        : null;
      if (!target) {
        setNotice("灵号通行证登录暂不可用；没有执行导航。");
        return;
      }
      window.location.assign(target);
    } catch {
      setNotice("灵号通行证登录暂不可用；没有执行导航。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5" data-passport-v4-primary="true">
      <button
        type="button"
        disabled={busy}
        onClick={() => void start()}
        className="ui-button-primary w-full rounded-md px-4 py-2.5 text-[13px] font-medium disabled:opacity-50"
      >
        {busy ? "正在连接灵号通行证…" : "使用灵号通行证登录"}
      </button>
      {notice ? <p className="text-[11px] text-red-400/90" aria-live="polite">{notice}</p> : null}
    </div>
  );
}

export function LinghaoPassportV4LoginButton(): ReactNode {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void publicEntryAvailable().then((next) => { if (active) setAvailable(next); });
    return () => { active = false; };
  }, []);
  return available ? <PassportStartButton /> : null;
}

export function LinghaoPassportV4LoginBoundary({ children }: { children: ReactNode }): ReactNode {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void publicEntryAvailable().then((next) => { if (active) setAvailable(next); });
    return () => { active = false; };
  }, []);
  if (!available) return children;
  return (
    <>
      <PassportStartButton />
      <div className="rounded-md border border-clay-900/10 bg-clay-50/60 px-3 py-2 text-[11px] leading-relaxed text-clay-600">
        旧登录入口（回退）与灵号通行证账号完全隔离；不会读取、关联或迁移旧账号数据。
      </div>
      {children}
    </>
  );
}
