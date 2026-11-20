import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { independentAdminNavigationState, INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE } from "@/lib/admin/independentPrincipalServer";
import { AdminPasswordChangeForm } from "./AdminPasswordChangeForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "首次修改管理员密码 · AIstory", robots: { index: false, follow: false } };
export default async function AdminPasswordChangePage() {
  const token = (await cookies()).get(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE)?.value;
  const state = await independentAdminNavigationState(token);
  if (state === "signed_out") redirect(token ? "/admin/login?state=session-ended" : "/admin/login");
  if (state === "console") redirect("/admin");
  return <main className="ui-page min-h-screen px-5 py-16 text-stone-900">
    <section className="mx-auto max-w-md rounded-3xl border border-stone-200 bg-white p-8">
      <h1 className="mb-6 text-2xl font-semibold">账号待激活 · 首次修改密码</h1>
      <AdminPasswordChangeForm />
    </section>
  </main>;
}
