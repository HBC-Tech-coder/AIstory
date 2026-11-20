"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LINGHAO_PASSPORT_V4_CLIENT_ID,
  LINGHAO_PASSPORT_V4_DISPLAY_NAME,
  LINGHAO_PASSPORT_V4_ISSUER,
  LINGHAO_PASSPORT_V4_REDIRECT_URI,
  LINGHAO_PASSPORT_V4_RETURN_PATH,
} from "@/lib/auth/linghaoPassportV4Public";

type SafeProfile = {
  readonly profileId: string;
  readonly displayName: typeof LINGHAO_PASSPORT_V4_DISPLAY_NAME;
  readonly localTestOnly: true;
  readonly balance: null;
  readonly ledger: readonly [];
  readonly capabilities: {
    readonly administrator: false;
    readonly phoneAccount: false;
    readonly formalWallet: false;
    readonly legacyWorks: false;
    readonly cloudProgress: false;
    readonly hostedByok: false;
  };
};

type SafeSession = {
  readonly authenticated: true;
  readonly profile: SafeProfile;
  readonly session: {
    readonly idleExpiresAt: number;
    readonly absoluteExpiresAt: number;
  };
};

type LogoutOutcome = {
  readonly localLoggedOut: true;
  readonly revocationConfirmed: boolean;
  readonly upstreamReturnConfirmed: boolean;
};

type CapabilityState = "checking" | "disabled" | "ready" | "unavailable";

const DRAFT_MAX_BYTES = 4096;
const OPAQUE_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTHORIZATION_PATH = "/login/oauth/authorize";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isSafeExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeSession(value: unknown): SafeSession | null {
  if (!isRecord(value) || !hasExactKeys(value, ["authenticated", "profile", "session"])) {
    return null;
  }
  if (value.authenticated !== true || !isRecord(value.profile)) return null;
  if (
    !hasExactKeys(value.profile, [
      "localTestOnly",
      "displayName",
      "profileId",
      "balance",
      "ledger",
      "capabilities",
    ])
  ) {
    return null;
  }
  if (
    value.profile.localTestOnly !== true ||
    value.profile.displayName !== LINGHAO_PASSPORT_V4_DISPLAY_NAME ||
    value.profile.balance !== null ||
    !Array.isArray(value.profile.ledger) ||
    value.profile.ledger.length !== 0 ||
    typeof value.profile.profileId !== "string" ||
    !UUID_PATTERN.test(value.profile.profileId) ||
    !isRecord(value.profile.capabilities)
  ) {
    return null;
  }
  const capabilityKeys = [
    "administrator",
    "phoneAccount",
    "formalWallet",
    "legacyWorks",
    "cloudProgress",
    "hostedByok",
  ] as const;
  if (!hasExactKeys(value.profile.capabilities, capabilityKeys)) return null;
  for (const key of capabilityKeys) {
    if (value.profile.capabilities[key] !== false) return null;
  }
  if (!isRecord(value.session) || !hasExactKeys(value.session, ["idleExpiresAt", "absoluteExpiresAt"])) {
    return null;
  }
  if (
    !isSafeExpiry(value.session.idleExpiresAt) ||
    !isSafeExpiry(value.session.absoluteExpiresAt) ||
    value.session.absoluteExpiresAt < value.session.idleExpiresAt
  ) {
    return null;
  }
  return value as unknown as SafeSession;
}

function safeRenewedSession(value: unknown): SafeSession | null {
  if (!isRecord(value) || value.renewed !== true) return null;
  const session = { ...value };
  delete session.renewed;
  return safeSession(session);
}

function isConfirmedUnauthenticated(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["authenticated"]) &&
    value.authenticated === false
  );
}

function allowedAuthorizationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.origin !== LINGHAO_PASSPORT_V4_ISSUER ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== AUTHORIZATION_PATH
    ) {
      return null;
    }
    const required = new Map<string, string>([
      ["response_type", "code"],
      ["client_id", LINGHAO_PASSPORT_V4_CLIENT_ID],
      ["redirect_uri", LINGHAO_PASSPORT_V4_REDIRECT_URI],
      ["scope", "openid profile email"],
      ["code_challenge_method", "S256"],
    ]);
    for (const [key, expected] of required) {
      const values = url.searchParams.getAll(key);
      if (values.length !== 1 || values[0] !== expected) return null;
    }
    for (const key of ["state", "nonce", "code_challenge"]) {
      const values = url.searchParams.getAll(key);
      if (values.length !== 1 || !OPAQUE_STATE_PATTERN.test(values[0] ?? "")) {
        return null;
      }
    }
    const known = new Set([
      ...required.keys(),
      "state",
      "nonce",
      "code_challenge",
    ]);
    for (const key of url.searchParams.keys()) {
      if (!known.has(key)) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeLogoutOutcome(value: unknown): LogoutOutcome | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "localLoggedOut",
      "revocationConfirmed",
      "upstreamReturnConfirmed",
    ])
  ) {
    return null;
  }
  if (
    value.localLoggedOut !== true ||
    typeof value.revocationConfirmed !== "boolean" ||
    typeof value.upstreamReturnConfirmed !== "boolean"
  ) {
    return null;
  }
  return value as unknown as LogoutOutcome;
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export default function LinghaoPassportV4LocalPanel() {
  const [capability, setCapability] = useState<CapabilityState>("checking");
  const [session, setSession] = useState<SafeSession | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState(
    "仅用于本机默认关闭的 Linghao Passport v4 集成验证。",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const logoutNoticeRequestRef = useRef<{
    readonly state: string;
    readonly promise: Promise<string>;
  } | null>(null);

  const applySession = useCallback((next: SafeSession | null): void => {
    setSession(next);
    if (!next) setDraft("");
  }, []);

  const loadSession = useCallback(async (): Promise<SafeSession | null> => {
    const response = await fetch(
      "/api/auth/linghao-passport-v4/session",
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
    const body = await readJsonObject(response);
    const next = response.ok ? safeSession(body) : null;
    applySession(next);
    return next;
  }, [applySession]);

  const loadDraft = useCallback(async (): Promise<boolean> => {
    const response = await fetch("/api/auth/linghao-passport-v4/draft", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = await readJsonObject(response);
    if (
      response.ok &&
      body &&
      hasExactKeys(body, ["text"]) &&
      typeof body.text === "string" &&
      new TextEncoder().encode(body.text).byteLength <= DRAFT_MAX_BYTES
    ) {
      setDraft(body.text);
      return true;
    }
    if (
      response.status === 401 &&
      isConfirmedUnauthenticated(body)
    ) {
      applySession(null);
      setNotice("服务器拒绝了该会话的草稿读取；本地会话已按服务器确认清除。");
    } else {
      setNotice("草稿数据格式无效；未渲染任何未经验证的内容。");
    }
    return false;
  }, [applySession]);

  useEffect(() => {
    let active = true;

    const requestLogoutNotice = (state: string): Promise<string> => {
      const existing = logoutNoticeRequestRef.current;
      if (existing?.state === state) return existing.promise;

      const promise = (async (): Promise<string> => {
        try {
          const response = await fetch(
            `/api/auth/linghao-passport-v4/logged-out?state=${encodeURIComponent(state)}`,
            {
              method: "POST",
              cache: "no-store",
              credentials: "same-origin",
              headers: { Accept: "application/json" },
            },
          );
          const body = await readJsonObject(response);
          const outcome = response.ok ? safeLogoutOutcome(body) : null;
          if (!outcome) {
            return "本地登出状态无效、已过期或已被使用；未声明上游登出。";
          }
          if (!outcome.revocationConfirmed) {
            return "服务器已确认本地登出，但上游令牌撤销未确认；未发起上游登出。";
          }
          if (outcome.upstreamReturnConfirmed) {
            return "本地登出与令牌撤销已确认，且已从上游 end-session 返回；不额外声明全局上游登出。";
          }
          return "本地登出与令牌撤销已确认；未声明上游登出。";
        } catch {
          return "本地登出状态校验请求失败；未声明上游登出。";
        }
      })();
      logoutNoticeRequestRef.current = { state, promise };
      return promise;
    };

    const validatePostLogout = async (): Promise<string | null> => {
      const url = new URL(window.location.href);
      if (url.pathname !== LINGHAO_PASSPORT_V4_RETURN_PATH) return null;
      const queryState = url.searchParams.get("state");
      const state =
        queryState && OPAQUE_STATE_PATTERN.test(queryState)
          ? queryState
          : logoutNoticeRequestRef.current?.state ?? null;
      try {
        if (state) {
          return await requestLogoutNotice(state);
        }
        if (url.searchParams.get("status") === "local-only") {
          return "本地登出结果缺少一次性服务器证明；未声明本地或上游登出。";
        }
        return null;
      } finally {
        window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
      }
    };

    const initialize = async (): Promise<void> => {
      const postLogoutNotice = await validatePostLogout();
      if (!active) return;
      try {
        const capabilityResponse = await fetch(
          "/api/auth/linghao-passport-v4/capabilities",
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          },
        );
        const body = await readJsonObject(capabilityResponse);
        if (!active) return;
        if (!capabilityResponse.ok || body?.enabled !== true) {
          setCapability("disabled");
          applySession(null);
          if (postLogoutNotice) setNotice(postLogoutNotice);
          return;
        }
        setCapability("ready");
        const authenticated = await loadSession();
        if (active && authenticated) {
          await loadDraft();
          setNotice("已载入本地测试会话与私有测试草稿。");
        } else if (active && postLogoutNotice) {
          setNotice(postLogoutNotice);
        }
      } catch {
        if (active) {
          setCapability("unavailable");
          applySession(null);
          if (postLogoutNotice) setNotice(postLogoutNotice);
        }
      }
    };

    void initialize();
    return () => {
      active = false;
    };
  }, [applySession, loadDraft, loadSession]);

  const startLogin = async (): Promise<void> => {
    if (capability !== "ready" || busy) return;
    setBusy("start");
    try {
      const response = await fetch(
        "/api/auth/linghao-passport-v4/start",
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const body = await readJsonObject(response);
      const target =
        response.ok && body
          ? allowedAuthorizationUrl(body.authorizationUrl)
          : null;
      if (!target) {
        setNotice("登录初始化被拒绝；未执行任何导航。");
        return;
      }
      setNotice("正在前往本机 Linghao Passport v4 授权页。");
      window.location.assign(target);
    } catch {
      setNotice("登录初始化失败；未执行任何导航。");
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async (): Promise<void> => {
    if (!session || busy) return;
    const bytes = new TextEncoder().encode(draft).byteLength;
    if (bytes > DRAFT_MAX_BYTES) {
      setNotice(`草稿超过 ${DRAFT_MAX_BYTES} 字节，未发送。`);
      return;
    }
    setBusy("draft");
    try {
      const response = await fetch(
        "/api/auth/linghao-passport-v4/draft",
        {
          method: "PUT",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: draft }),
        },
      );
      const body = await readJsonObject(response);
      if (
        response.ok &&
        body &&
        hasExactKeys(body, ["text"]) &&
        body.text === draft
      ) {
        setNotice("私有测试草稿已保存到当前本地会话。");
      } else {
        const cleared =
          response.status === 401 &&
          isConfirmedUnauthenticated(body);
        if (cleared) applySession(null);
        setNotice(
          cleared
            ? "服务器拒绝了该会话；本地会话已按服务器确认清除。"
            : "草稿保存响应不可验证；未声明服务器会话已清除。",
        );
      }
    } catch {
      setNotice("草稿保存请求失败。");
    } finally {
      setBusy(null);
    }
  };

  const renew = async (): Promise<void> => {
    if (!session || busy) return;
    setBusy("renew");
    try {
      const response = await fetch(
        "/api/auth/linghao-passport-v4/renew",
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const body = await readJsonObject(response);
      const next = response.ok ? safeRenewedSession(body) : null;
      if (next) {
        applySession(next);
        setNotice("会话已通过单飞刷新续期。");
      } else if (
        response.status === 401 &&
        isConfirmedUnauthenticated(body)
      ) {
        applySession(null);
        setNotice("续期失败，服务器已确认清除本地测试会话。");
      } else {
        setNotice("续期响应不可验证；保留当前界面状态且不声明服务器会话已清除。");
      }
    } catch {
      setNotice("续期请求失败。");
    } finally {
      setBusy(null);
    }
  };

  const draftBytes = new TextEncoder().encode(draft).byteLength;
  const disabled = capability === "disabled";
  const unavailable = capability === "unavailable";

  return (
    <section className="mx-auto max-w-2xl space-y-5 p-6 text-sm">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-neutral-500">
          Hidden local integration test surface
        </p>
        <h1 className="text-2xl font-semibold">Linghao Passport v4</h1>
        <p className="text-neutral-600">
          默认关闭。仅在本机 exact selector 与本地 loopback tuple 同时成立时可用。
          这不是正式账号、钱包、管理员、旧作品、云同步或托管 BYOK 能力。
        </p>
      </header>

      <div className="rounded border border-neutral-300 p-3">
        <p>
          能力状态：
          <strong>
            {capability === "checking"
              ? "检查中"
              : capability === "ready"
                ? "仅本地测试可用"
                : disabled
                  ? "默认关闭 / 配置不可用"
                  : "本地 API 不可达"}
          </strong>
        </p>
        {unavailable ? (
          <p className="mt-2 text-neutral-600">
            无法连接本地能力端点；没有发起登录或旧认证调用。
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded bg-black px-3 py-2 text-white disabled:opacity-40"
          disabled={capability !== "ready" || Boolean(busy)}
          onClick={() => void startLogin()}
        >
          开始本地登录
        </button>
        <button
          type="button"
          className="rounded border border-neutral-400 px-3 py-2 disabled:opacity-40"
          disabled={capability !== "ready" || Boolean(busy)}
          onClick={() =>
            void loadSession().then((next) => {
              if (next) {
                void loadDraft();
                setNotice("已重新载入本地测试会话。");
              } else {
                setNotice("没有可用的本地测试会话。");
              }
            })
          }
        >
          载入会话
        </button>
        <button
          type="button"
          className="rounded border border-neutral-400 px-3 py-2 disabled:opacity-40"
          disabled={!session || Boolean(busy)}
          onClick={() => void renew()}
        >
          显式续期
        </button>
        <form method="post" action="/api/auth/linghao-passport-v4/logout">
          <button
            type="submit"
            className="rounded border border-neutral-400 px-3 py-2 disabled:opacity-40"
            disabled={Boolean(busy)}
          >
            本地登出
          </button>
        </form>
      </div>

      {session ? (
        <div className="space-y-3 rounded border border-neutral-300 p-3">
          <p>
            固定本地测试标签：<strong>{session.profile.displayName}</strong>
          </p>
          <p className="break-all font-mono text-xs">
            profileId: {session.profile.profileId}
          </p>
          <p>
            balance: {String(session.profile.balance)} · ledger:{" "}
            {session.profile.ledger.length}
          </p>
          <ul className="grid grid-cols-2 gap-1 text-xs text-neutral-600">
            <li>administrator: false</li>
            <li>phone account: false</li>
            <li>formal wallet: false</li>
            <li>legacy works: false</li>
            <li>cloud progress: false</li>
            <li>hosted BYOK: false</li>
          </ul>
          <label className="block space-y-1">
            <span>当前 profile 的私有测试草稿（≤4096 UTF-8 字节）</span>
            <textarea
              className="min-h-32 w-full rounded border border-neutral-400 p-2 font-mono text-xs"
              value={draft}
              maxLength={8192}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded bg-black px-3 py-2 text-white disabled:opacity-40"
              disabled={Boolean(busy) || draftBytes > DRAFT_MAX_BYTES}
              onClick={() => void saveDraft()}
            >
              保存私有草稿
            </button>
            <span className="text-xs text-neutral-600">
              {draftBytes}/{DRAFT_MAX_BYTES} bytes
            </span>
          </div>
        </div>
      ) : (
        <p className="rounded border border-dashed border-neutral-400 p-3 text-neutral-600">
          当前没有经过验证的本地测试会话。
        </p>
      )}

      <p aria-live="polite" className="rounded bg-neutral-100 p-3">
        {notice}
      </p>
      <p className="text-xs text-neutral-500">
        进程内会话在服务重启后失效；令牌不进入浏览器 JS、URL fragment、DTO 或
        cookie。页面只在服务器确认后描述本地会话状态，且不会仅凭本地页面声明上游已登出。
      </p>
    </section>
  );
}

