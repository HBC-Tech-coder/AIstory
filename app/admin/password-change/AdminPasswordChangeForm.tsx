"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { independentAdminPasswordPolicyViolation } from "@/lib/admin/independentPasswordPolicy";

export function AdminPasswordChangeForm() {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      if (newPassword !== confirmation) { setError("两次新密码不一致。"); return; }
      const policyViolation = independentAdminPasswordPolicyViolation(newPassword);
      if (policyViolation) {
        setError(policyViolation === "public_default_password"
          ? "新密码不能使用公开临时初始密码。"
          : "新密码须至少 9 个 Unicode 字符、最多 512 个 UTF-8 字节，并在大写字母、小写字母、数字、特殊字符中至少包含三类。");
        return;
      }
      const response = await fetch("/api/admin/password-change", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Aistory-Admin-Action": "first-password-change-v1" },
        body: JSON.stringify({ currentPassword, newPassword }) });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || !("state" in body)
        || body.state !== "signed_out" || !("freshLoginRequired" in body) || body.freshLoginRequired !== true) {
        setError(response.status === 429 ? "尝试过多，请稍后重试。" : "密码修改失败，请检查当前密码或重新登录。"); return;
      }
      router.replace("/admin/login?state=password-changed"); router.refresh();
    } catch { setError("密码修改当前不可用。"); }
    finally { setCurrent(""); setNew(""); setConfirmation(""); busy.current = false; setPending(false); }
  }
  async function logout() {
    if (busy.current) return;
    busy.current = true; setPending(true);
    try {
      const response = await fetch("/api/admin/session", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (response.ok) { router.replace("/admin/login?state=session-ended"); router.refresh(); }
      else setError("退出失败，请稍后重试。");
    } catch { setError("退出当前不可用。"); }
    finally { setCurrent(""); setNew(""); setConfirmation(""); busy.current = false; setPending(false); }
  }
  return <form onSubmit={submit} className="space-y-4">
    <p role="status" className="text-sm">当前仅有改密权限，没有管理员角色或后台数据访问权限。改密成功立即退出，必须用新密码重新登录。</p>
    <p className="text-sm">待激活账号没有认领截止时间。临时会话过期可退出后重新登录，不会重置或激活账号。</p>
    <p className="text-sm text-amber-900">公开默认凭据是先到先得（first-claim-wins），任何先访问者可能抢先激活；受限会话不能证明部署者所有权。</p>
    <p className="text-sm">新密码至少 9 个 Unicode 字符、最多 512 个 UTF-8 字节；大写英文字母、小写英文字母、数字、特殊字符（非 ASCII 字母数字）四类中至少包含三类，且不得与公开临时初始密码相同。</p>
    {[
      { label: "当前临时密码", value: currentPassword, set: setCurrent, autocomplete: "current-password" },
      { label: "新密码", value: newPassword, set: setNew, autocomplete: "new-password" },
      { label: "确认新密码", value: confirmation, set: setConfirmation, autocomplete: "new-password" },
    ].map(field => <label key={field.label} className="block">{field.label}<input type="password" value={field.value}
      onChange={event => field.set(event.target.value)} autoComplete={field.autocomplete} maxLength={512}
      disabled={pending} className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3" /></label>)}
    <button disabled={pending || !currentPassword || !newPassword || !confirmation} type="submit"
      className="w-full rounded-xl bg-ember-500 px-4 py-3 text-white disabled:opacity-45">修改密码并退出</button>
    <button disabled={pending} type="button" onClick={logout}>退出临时登录</button>
    <Link className="block text-sm underline" href="/admin/login" prefetch={false}>返回登录</Link>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </form>;
}
