"use client";

import { useEffect, useRef, useState } from "react";

export function AiUserLoginButton({ navigate = (url: string) => window.location.assign(url) }: {
  /** Navigation seam for an isolated issuer fixture; server validation never depends on it. */
  navigate?: (url: string) => void;
} = {}) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void fetch("/api/auth/aiuser/capabilities", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => { const value = await response.json(); if (active) setEnabled(response.ok && value.enabled === true); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; mounted.current = false; };
  }, []);
  if (!enabled) return null;
  async function login() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailed(false);
    try {
      const response = await fetch("/api/auth/aiuser/start", { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("LOGIN_UNAVAILABLE");
      const data = await response.json();
      if (!mounted.current) return;
      if (typeof data.authorizationUrl !== "string") throw new Error("LOGIN_UNAVAILABLE");
      const target = new URL(data.authorizationUrl);
      if (target.origin !== "https://id.hibcglobal.com" || target.pathname !== "/v1/oauth/authorize"
        || target.username || target.password || target.hash) throw new Error("LOGIN_UNAVAILABLE");
      // Top-level navigation, never a cross-origin fetch, iframe or client-side token store.
      navigate(target.toString());
    } catch { if (mounted.current) { setFailed(true); setBusy(false); } inFlight.current = false; }
  }
  return <div className="space-y-2">
    <button type="button" disabled={busy} onClick={() => void login()}
      className="w-full rounded border border-clay-500/40 px-4 py-2 text-sm disabled:opacity-50">
      {busy ? "正在前往 AIUser…" : "使用 AIUser 登录"}
    </button>
    <p className="text-xs leading-relaxed">将前往 AIUser。首次使用需在该站明确加入 AIstory；不会自动关联旧账户或赠送积分。</p>
    {failed && <p role="alert">暂时无法登录，请稍后重试。当前剧情未被清除。</p>}
  </div>;
}
