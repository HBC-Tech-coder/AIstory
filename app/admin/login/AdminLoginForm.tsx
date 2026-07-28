"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function AdminLoginForm({
  localAdminAvailable,
}: {
  localAdminAvailable: boolean;
}) {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    setPending(false);
    if (!response.ok) {
      setError("登录失败。本地管理员模式可能未启用，或密钥无效。");
      return;
    }
    setSecret("");
    router.replace("/admin");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <label className="block">
        <span className="text-sm text-stone-600">本地管理员密钥</span>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          autoComplete="current-password"
          disabled={!localAdminAvailable || pending}
          className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-[#8A5A2B] focus:ring-2 focus:ring-[#8A5A2B]/20 disabled:bg-stone-100"
        />
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        type="submit"
        disabled={!localAdminAvailable || pending || !secret}
        className="w-full rounded-xl bg-[#8A5A2B] px-4 py-3 font-medium text-white transition hover:bg-[#714820] disabled:cursor-not-allowed disabled:opacity-45"
      >
        {pending ? "验证中…" : "进入本地控制台"}
      </button>
      {!localAdminAvailable ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          本地管理员默认关闭。请在仅本机开发进程中配置
          AISTORY_LOCAL_ADMIN_ENABLED 与随机密钥后重启 4200；系统不会提供默认密码。
        </p>
      ) : null}
    </form>
  );
}
