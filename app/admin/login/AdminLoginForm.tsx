"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function AdminLoginForm({
  localAdminAvailable,
  sessionEnded = false,
  passwordChanged = false,
}: {
  localAdminAvailable: boolean;
  sessionEnded?: boolean;
  passwordChanged?: boolean;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submitIndependent(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? "登录尝试过多，请稍后重试。"
            : response.status === 503
              ? "管理员登录当前不可用。"
              : "管理员账号或密码无效。",
        );
        return;
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("state" in body)
        || (body.state !== "console" && body.state !== "password_change_required")) {
        setError("管理员登录当前不可用。"); return;
      }
      setUsername("");
      router.replace(body.state === "password_change_required" ? "/admin/password-change" : "/admin");
      router.refresh();
    } catch {
      setError("管理员登录当前不可用。");
    } finally {
      setPassword("");
      busy.current = false;
      setPending(false);
    }
  }

  async function submitLocal(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (!response.ok) {
        setError("本地管理员登录失败：模式未启用或密钥无效。");
        return;
      }
      setSecret("");
      router.replace("/admin");
      router.refresh();
    } catch {
      setError("本地管理员登录当前不可用。");
    } finally {
      setPending(false);
      busy.current = false;
    }
  }

  return (
    <div className="mt-8 space-y-6">
      {sessionEnded ? (
        <p
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          管理员会话已结束，请重新登录。
        </p>
      ) : null}
      {passwordChanged ? (
        <p role="status" className="rounded-xl border border-stone-300 bg-stone-50 p-3 text-sm">
          密码已修改并退出，请使用新密码重新登录。
        </p>
      ) : null}

      <form onSubmit={submitIndependent} className="space-y-4">
        <div>
          <h2 className="text-base font-medium text-stone-900">
            独立管理员账号
          </h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            仅使用独立管理员账号，不会使用手机号或映射普通用户身份。
            已激活账号使用高熵密码；待激活账号登录后只能改密，没有后台权限。
          </p>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            首次已初始化的默认账号为 admin / admin888。待激活账号没有认领倒计时；
            临时会话过期或关闭页面后，可重新登录继续改密。
          </p>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            公开默认凭据采用先到先得（first-claim-wins）：任何先访问者都可能抢先激活，
            待激活状态与限流不能证明部署者所有权。
          </p>
        </div>
        <label className="block">
          <span className="text-sm text-stone-600">管理员登录名</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            disabled={pending}
            className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-ember-500 focus:ring-2 focus:ring-ember-500/20 disabled:bg-stone-100"
          />
        </label>
        <label className="block">
          <span className="text-sm text-stone-600">管理员密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={pending}
            className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-ember-500 focus:ring-2 focus:ring-ember-500/20 disabled:bg-stone-100"
          />
        </label>
        <button
          type="submit"
          disabled={pending || !username || !password}
          className="w-full rounded-xl bg-ember-500 px-4 py-3 font-medium text-white transition hover:bg-[rgb(var(--ui-primary-hover))] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {pending ? "验证中…" : "登录"}
        </button>
      </form>

      {localAdminAvailable ? (
        <form
          onSubmit={submitLocal}
          className="space-y-4 rounded-xl border border-stone-200 bg-stone-50 p-4"
        >
          <h2 className="text-base font-medium text-stone-900">
            Loopback 本地开发入口
          </h2>
          <label className="block">
            <span className="text-sm text-stone-600">本地管理员密钥</span>
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="current-password"
              disabled={pending}
              className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-ember-500 focus:ring-2 focus:ring-ember-500/20 disabled:bg-stone-100"
            />
          </label>
          <button
            type="submit"
            disabled={pending || !secret}
            className="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 font-medium text-stone-800 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pending ? "验证中…" : "进入本地控制台"}
          </button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" aria-live="polite" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
