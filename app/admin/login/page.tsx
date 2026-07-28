import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  isLocalAdminEnabled,
  resolveAdminActor,
} from "@/lib/admin/security";
import { AdminLoginForm } from "./AdminLoginForm";

export const metadata: Metadata = {
  title: "管理员登录 · AIstory",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage() {
  if (await resolveAdminActor()) redirect("/admin");
  return (
    <main className="min-h-screen bg-[#F7F2E8] px-5 py-16 text-stone-900">
      <section className="mx-auto max-w-md rounded-3xl border border-stone-200 bg-white p-8 shadow-[0_24px_80px_rgba(72,49,28,0.12)]">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#8A5A2B]">
          AIstory Control
        </p>
        <h1 className="mt-3 text-3xl font-semibold">超级管理员登录</h1>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          此入口不出现在普通导航。生产环境使用 Supabase 身份与管理员角色；
          本地模式仅允许 localhost，并使用 HttpOnly 签名会话。
        </p>
        <AdminLoginForm localAdminAvailable={isLocalAdminEnabled()} />
      </section>
    </main>
  );
}
