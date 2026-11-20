// Test-only entry. This file must never be imported by an app route or runtime module.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AiUserAccountPanel } from "../../components/AiUserAccountPanel";
import { AiUserLoginButton } from "../../components/AiUserLoginButton";

const STALE_RECOVERY_ACTION = "清理失效的 AIUser 登录状态";
const LOGIN_BUTTON = "使用 AIUser 登录";

function entryNavigation(value: string) {
  const target = new URL(value);
  if (target.origin !== "https://id.hibcglobal.com" || target.pathname !== "/v1/oauth/authorize") throw Error("test_authority");
  const local = new URL("/issuer/authorize", window.location.origin);
  local.search = target.search;
  window.location.assign(local.toString());
}

// Test-only, read-only observation seam for the synthetic stale-session browser
// regression. It reports rendered labels and control state only; it never reads
// cookies, storage, response bodies or any credential, and no app runtime imports it.
function syntheticSnapshot() {
  const text = (node: Element | null) => node?.textContent?.trim() ?? "";
  const buttons = Array.from(document.querySelectorAll("button"));
  const enabled = (label: string) => buttons.some((button) => text(button) === label && !(button as HTMLButtonElement).disabled);
  return {
    testOnly: true as const,
    pathname: window.location.pathname,
    search: window.location.search,
    statusTexts: Array.from(document.querySelectorAll('[role="status"]')).map((node) => text(node)),
    buttonLabels: buttons.map((button) => text(button)),
    cleanupActionVisible: buttons.some((button) => text(button) === STALE_RECOVERY_ACTION),
    cleanupActionEnabled: enabled(STALE_RECOVERY_ACTION),
    loginButtonVisible: buttons.some((button) => text(button) === LOGIN_BUTTON),
    loginButtonEnabled: enabled(LOGIN_BUTTON),
  };
}
(globalThis as unknown as { __aistoryStaleSessionHarness?: unknown }).__aistoryStaleSessionHarness = {
  scenario: "aiuser_stale_session_recovery",
  labels: { cleanup: STALE_RECOVERY_ACTION, login: LOGIN_BUTTON },
  snapshot: syntheticSnapshot,
};

function Entry() {
  const [visible, setVisible] = useState(true);
  return <main><h1>AIstory · 合成登录验收</h1><p>本机隔离环境，不连接真实 AIUser。</p>
    {visible && <AiUserLoginButton navigate={entryNavigation} />}
    <button type="button" onClick={() => setVisible(false)}>合成关闭登录入口</button></main>;
}
async function externalLogout() {
  const response = await fetch("/api/account/me", { method: "DELETE" });
  if (response.ok) window.dispatchEvent(new Event("aistory:account-changed"));
}
createRoot(document.getElementById("root")!).render(window.location.pathname === "/auth/aiuser"
  ? <><AiUserAccountPanel loginNavigate={entryNavigation} />
    <button type="button" onClick={() => window.dispatchEvent(new Event("aistory:account-changed"))}>合成刷新账户</button>
    <button type="button" onClick={() => void externalLogout()}>合成其他组件退出</button></>
  : <Entry />);
