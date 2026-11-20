"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AiUserLoginButton } from "./AiUserLoginButton";
import { AuthModal } from "./AuthModal";
import type { AiUserPublicAccount } from "@/lib/auth/aiUserAccountPublic";
import { shouldOfferLinkPhoneProof } from "../lib/auth/aiUserLinkPhoneProofUi";

export function AiUserAccountPanel({ loginNavigate }: { loginNavigate?: (url: string) => void } = {}) {
  const [account, setAccount] = useState<AiUserPublicAccount | null>(null);
  const [status, setStatus] = useState("正在检查登录状态…");
  const [busy, setBusy] = useState(false);
  const [phoneReady, setPhoneReady] = useState(false);
  const [linkState, setLinkState] = useState<"unavailable" | "unlinked" | "linked" | "confirm">("unavailable");
  const [confirmed, setConfirmed] = useState(false);
  const [linkMessage, setLinkMessage] = useState("");
  const [linkingEnabled, setLinkingEnabled] = useState(false);
  const [linkReauthAvailable, setLinkReauthAvailable] = useState(false);
  const [linkReauthFailed, setLinkReauthFailed] = useState(false);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const [billingReadiness, setBillingReadiness] = useState<
    { state: "loading" | "unavailable" } | { state: "ready"; estimatedCredits: number }
  >({ state: "loading" });
  const [recoveryOffered, setRecoveryOffered] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const accountExpiresAt = account?.expiresAt;
  const requestEpoch = useRef(0);
  const linkEpoch = useRef(0);
  const logoutPending = useRef(false);
  const callbackFailure = useRef(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/auth/aiuser/capabilities", { cache: "no-store" }).then(async (response) => {
      const value = await response.json();
      if (active) {
        setLinkingEnabled(response.ok && value.enabled === true && value.linkingEnabled === true);
        setLinkReauthAvailable(response.ok && value.enabled === true && value.linkReauthAvailable === true);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [capabilityRevision]);
  useEffect(() => { callbackFailure.current = new URLSearchParams(window.location.search).get("status") === "failed"; }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (logoutPending.current) return;
      const callbackFailed = callbackFailure.current;
      const epoch = ++requestEpoch.current;
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        const result = await response.json();
        if (!active || epoch !== requestEpoch.current) return;
        if (response.ok && result.authenticated === true && result.account?.authType === "aiuser"
          && Number.isSafeInteger(result.account.expiresAt) && result.account.expiresAt > Date.now()) {
          setAccount(result.account); setStatus("已登录 AIstory");
          setPhoneReady(false);
          setRecoveryOffered(false); setRecoveryMessage("");
        } else {
          setAccount(null);
          const phoneAccount = response.ok && result.authenticated === true && result.account?.authType === "phone";
          setPhoneReady(phoneAccount);
          const offered = !phoneAccount && (callbackFailed || result.code === "AIUSER_SESSION_UNAVAILABLE");
          setRecoveryOffered(offered);
          if (!offered) setRecoveryMessage("");
          setStatus(callbackFailed ? "登录未完成或已取消，请重新登录。" : "未登录或会话已到期，请重新登录。");
          if (phoneAccount) setStatus("已登录原手机号账户；AIUser 尚未登录。");
        }
      } catch { if (active && epoch === requestEpoch.current) {
        setAccount(null); setRecoveryOffered(callbackFailed);
        if (!callbackFailed) setRecoveryMessage("");
        setStatus("暂时无法检查账户，请稍后重试。");
      } }
    };
    void refresh();
    const changed = () => {
      requestEpoch.current++; linkEpoch.current++; setAccount(null); setPhoneReady(false); setLinkState("unavailable");
      setConfirmed(false); setBusy(false); setRecoveryOffered(false);
      if (!logoutPending.current) { setStatus("正在重新检查登录状态…"); void refresh(); }
    };
    window.addEventListener("aistory:account-changed", changed);
    const id = window.setInterval(() => void refresh(), 30000);
    return () => { active = false; window.removeEventListener("aistory:account-changed", changed); window.clearInterval(id); };
  }, []);
  useEffect(() => {
    let active = true;
    setConfirmed(false);
    if (!accountExpiresAt || !linkingEnabled) { setLinkState("unavailable"); return; }
    void fetch("/api/auth/aiuser/account-link", { cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (active && !logoutPending.current) setLinkState(response.ok && result.available === true
        ? result.linked === true ? "linked" : "unlinked" : "unavailable");
    }).catch(() => { if (active) setLinkState("unavailable"); });
    return () => { active = false; };
  }, [accountExpiresAt, linkingEnabled]);
  useEffect(() => {
    if (!account?.capabilities.platformBilling) return;
    let active = true;
    setBillingReadiness({ state: "loading" });
    void fetch("/api/account/generation-readiness", { cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!active) return;
      setBillingReadiness(response.ok && result.scope === "story.start" && result.available === true
        && result.reason === "ready" && Number.isSafeInteger(result.estimatedCredits)
        && result.estimatedCredits >= 0
        ? { state: "ready", estimatedCredits: result.estimatedCredits }
        : { state: "unavailable" });
    }).catch(() => { if (active) setBillingReadiness({ state: "unavailable" }); });
    return () => { active = false; };
  }, [account?.capabilities.platformBilling, accountExpiresAt]);
  useEffect(() => {
    if (!account) return;
    const id = window.setTimeout(() => { setAccount(null); setStatus("会话已到期，请重新登录。当前剧情仍保留在本机。");
      window.dispatchEvent(new Event("aistory:account-changed")); }, Math.max(0, account.expiresAt - Date.now()));
    return () => window.clearTimeout(id);
  }, [account]);
  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true; requestEpoch.current++; linkEpoch.current++;
    setBusy(true);
    try {
      const response = await fetch("/api/account/me", { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("LOGOUT_UNAVAILABLE");
      setAccount(null); setStatus("已退出 AIstory；这不会注销其他产品或 AIUser。");
      setPhoneReady(false); setLinkState("unavailable"); setConfirmed(false); setLinkMessage(""); setPhoneModalOpen(false);
      window.dispatchEvent(new Event("aistory:account-changed"));
    } catch { setStatus("退出暂未确认，请重试；不要在共享设备上离开。"); }
    finally { logoutPending.current = false; setBusy(false); }
  }
  async function cleanStaleAiUserSession() {
    if (busy || logoutPending.current) return;
    logoutPending.current = true; requestEpoch.current++; linkEpoch.current++;
    setBusy(true); setRecoveryMessage("");
    try {
      const response = await fetch("/api/account/me", { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error("AIUSER_CLEANUP_UNAVAILABLE");
      callbackFailure.current = false;
      setAccount(null); setPhoneReady(false); setLinkState("unavailable"); setConfirmed(false); setLinkMessage("");
      setRecoveryOffered(false);
      window.dispatchEvent(new Event("aistory:account-changed"));
      setRecoveryMessage("已确认清理本网站上失效的 AIUser 登录状态；不会注销或删除 AIUser 账户，也不影响本机剧情。可重新登录。");
    } catch { setRecoveryOffered(true); setRecoveryMessage("清理结果尚未确认，请重试；这不会影响本机剧情。"); }
    finally { logoutPending.current = false; setBusy(false); }
  }
  async function link(action: "prepare" | "confirm") {
    if (!linkingEnabled || busy || logoutPending.current || (action === "confirm" && !confirmed)) return;
    const epoch = ++linkEpoch.current; setBusy(true); setLinkMessage("");
    try {
      const response = await fetch("/api/auth/aiuser/account-link", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: action === "prepare" ? '{"action":"prepare"}' : '{"action":"confirm","confirmLink":true}' });
      const result = await response.json();
      if (epoch !== linkEpoch.current || logoutPending.current) return;
      if (!response.ok) throw Error("LINK_UNAVAILABLE");
      if (action === "prepare" && result.readyToConfirm === true) { setLinkState("confirm"); setConfirmed(false); }
      else if (action === "confirm" && result.ok === true && ["linked", "already_linked"].includes(result.status)) {
        setLinkState("linked"); setConfirmed(false); setLinkMessage("关联已确认；没有合并资产或新增积分。可用积分状态以账户余额和生成前报价为准。");
        window.dispatchEvent(new Event("aistory:account-changed"));
      } else throw Error("LINK_UNAVAILABLE");
    } catch {
      if (epoch !== linkEpoch.current || logoutPending.current) return;
      // The mutation may have committed even when its response was interrupted.
      // Reconcile from the authoritative mapping before showing a failure.
      try {
        const snapshotResponse = await fetch("/api/auth/aiuser/account-link", { cache: "no-store" });
        const snapshot = await snapshotResponse.json();
        if (epoch !== linkEpoch.current || logoutPending.current) return;
        if (snapshotResponse.ok && snapshot.available === true && snapshot.linked === true) {
          setLinkState("linked"); setConfirmed(false);
          setLinkMessage("关联已确认；没有合并资产或新增积分。可用积分状态以账户余额和生成前报价为准。");
          window.dispatchEvent(new Event("aistory:account-changed"));
          return;
        }
      } catch { /* Keep the outcome explicitly unconfirmed. */ }
      if (epoch === linkEpoch.current) {
        setLinkState("unlinked"); setConfirmed(false);
        setLinkMessage("关联结果尚未确认。请确认本浏览器先完成原手机号登录、再完成近期 AIUser 身份验证；账户冲突或服务未开放时也会拒绝。");
      }
    } finally { if (epoch === linkEpoch.current) setBusy(false); }
  }
  async function startLinkReauth() {
    if (!linkReauthAvailable || busy || logoutPending.current) return;
    setBusy(true); setLinkReauthFailed(false);
    try {
      const response = await fetch("/api/auth/aiuser/account-link/reauth", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw Error("LINK_REAUTH_UNAVAILABLE");
      const data = await response.json();
      if (typeof data.authorizationUrl !== "string") throw Error("LINK_REAUTH_UNAVAILABLE");
      const target = new URL(data.authorizationUrl);
      if (target.origin !== "https://id.hibcglobal.com" || target.pathname !== "/v1/oauth/authorize"
        || target.username || target.password || target.hash || target.searchParams.get("max_age") !== "0") {
        throw Error("LINK_REAUTH_UNAVAILABLE");
      }
      if (loginNavigate) loginNavigate(target.toString());
      else window.location.assign(target.toString());
    } catch {
      setLinkReauthFailed(true);
      setCapabilityRevision((value) => value + 1);
      setBusy(false);
    }
  }
  return <main className="mx-auto max-w-xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">AIstory 账户</h1>
    <p role="status" aria-live="polite">{status}</p>
    {account ? <>
      <p>AIUser 普通用户 · {account.accountLinked === true || linkState === "linked" ? "已显式关联旧手机号账户" : linkState === "unavailable" ? "关联条件尚未满足或服务暂不可用" : "未关联旧手机号账户"}</p>
      <p>{account.capabilities.platformBilling && typeof account.balance === "number"
        ? `原手机号账户现有积分：${account.balance}。`
        : "积分消费未开通。"} 云存档和管理员权限未开通；不会自动迁移余额或本机剧情。</p>
      {account.capabilities.platformBilling && <p role="status" aria-live="polite">{
        billingReadiness.state === "loading" ? "正在检查平台生成状态…"
          : billingReadiness.state === "ready"
            ? `开始新故事预计 ${billingReadiness.estimatedCredits} 积分；实际消费仍以生成前校验为准。`
            : "平台生成状态暂不可用，请稍后再试。"
      }</p>}
      <p>会话最长 15 分钟，不自动续期。上游会员撤销可能要到本次会话到期才可见。</p>
      {shouldOfferLinkPhoneProof(account.accountLinked, linkState) && <section className="space-y-2 rounded border p-4">
        <p>关联原手机号账户需要在同一浏览器完成原手机号验证码登录，并在 AIUser 完成新的身份验证。手机号验证应在五分钟内完成；两个登录状态会分别保留。</p>
        <button type="button" disabled={busy} onClick={() => setPhoneModalOpen(true)} className="rounded border px-4 py-2">验证原手机号</button>
        {linkReauthAvailable && <button type="button" disabled={busy} onClick={() => void startLinkReauth()}
          className="rounded border px-4 py-2">重新验证 AIUser 以关联原手机号账户</button>}
        {linkReauthFailed && <p role="alert">AIUser 重新验证未能启动。请确认已在此浏览器输入短信验证码并验证成功。如果刚刚验证成功仍遇到此提示，请稍后重试。</p>}
        {linkingEnabled && <button type="button" disabled={busy} onClick={() => void link("prepare")} className="rounded border px-4 py-2">检查并准备关联原手机号账户</button>}
      </section>}
      {linkState === "confirm" && <section className="space-y-3 rounded border p-4">
        <p>仅关联本浏览器近期验证的两个账户。不会合并存档、余额或内容归属，也不会新增积分。若平台积分功能已开放，AIUser 登录可使用原手机号账户现有积分。</p>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我明确同意关联当前两个账户</label>
        <button type="button" disabled={busy || !confirmed} onClick={() => void link("confirm")} className="rounded border px-4 py-2">确认关联</button>
        <p>确认步骤 60 秒内有效；到期可重新准备，不会改变任一账户。</p>
      </section>}
      {linkMessage && <p role="status">{linkMessage}</p>}
      <button type="button" disabled={busy} onClick={() => void logout()} className="rounded border px-4 py-2">退出 AIstory</button>
    </> : <>{phoneReady && <p>请先登录 AIUser 查看账户关联状态。关联需要验证并确认，登录本身不会迁移积分。</p>}
      {recoveryOffered && <section className="space-y-3 rounded border p-4">
        <p id="aiuser-stale-session-note">清理只会移除本网站上失效的 AIUser 登录状态，不会注销或删除 AIUser 账户，也不会影响本机保存的剧情数据。</p>
        <button type="button" disabled={busy} aria-describedby="aiuser-stale-session-note" onClick={() => void cleanStaleAiUserSession()} className="rounded border px-4 py-2">清理失效的 AIUser 登录状态</button>
      </section>}
      {recoveryMessage && <p role="status">{recoveryMessage}</p>}
      <AiUserLoginButton navigate={loginNavigate} /></>}
    <p><Link href="/" className="underline">返回首页</Link></p>
    {phoneModalOpen && <AuthModal phoneProofOnly onClose={() => setPhoneModalOpen(false)} onSuccess={() => {
      setPhoneModalOpen(false);
      setCapabilityRevision((value) => value + 1);
      setLinkMessage("原手机号验证已完成。请在五分钟内重新验证 AIUser，然后检查并准备关联。");
    }} />}
  </main>;
}
