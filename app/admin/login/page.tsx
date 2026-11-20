import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  isLocalAdminEnabled,
  resolveAdminActor,
} from "@/lib/admin/security";
import { hasIndependentAdminPrincipalModeValue, independentAdminNavigationState,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE } from
  "@/lib/admin/independentPrincipalServer";
import { I18nProvider } from "@/lib/i18n/client";
import { DEFAULT_LOCALE } from "@/lib/i18n/config";
import { loadTranslations } from "@/lib/i18n/server";
import { AdminLoginForm } from "./AdminLoginForm";

export const metadata: Metadata = {
  title: "管理员登录 · AIstory",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await independentAdminNavigationState((await cookies()).get(INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE)?.value)
    === "password_change_required") redirect("/admin/password-change");
  if (await resolveAdminActor()) redirect("/admin");
  const translations = await loadTranslations(DEFAULT_LOCALE);
  const state = (await searchParams).state;
  const sessionEnded = state === "session-ended";
  return (
    <main className="ui-page min-h-screen px-5 py-16 text-stone-900">
      <section className="mx-auto max-w-md rounded-3xl border border-stone-200 bg-white p-8 shadow-[0_24px_80px_rgba(72,49,28,0.12)]">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-ember-500">
          AIstory Control
        </p>
        <h1 className="mt-3 text-3xl font-semibold">超级管理员登录</h1>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          此入口不会出现在普通导航中。管理员身份独立于普通用户账号；
          Loopback 本地开发入口仅在显式启用时出现。
        </p>
        <I18nProvider
          initialLocale={DEFAULT_LOCALE}
          initialTranslations={translations}
        >
          <AdminLoginForm
            localAdminAvailable={
              !hasIndependentAdminPrincipalModeValue()
              && isLocalAdminEnabled()
            }
            sessionEnded={sessionEnded}
            passwordChanged={state === "password-changed"}
          />
        </I18nProvider>
      </section>
    </main>
  );
}
