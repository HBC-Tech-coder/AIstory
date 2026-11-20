import { AiUserAccountPanel } from "@/components/AiUserAccountPanel";
import { I18nProvider } from "@/lib/i18n/client";
import { loadTranslations } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
export default async function AiUserAccountPage() {
  const translations = await loadTranslations("zh-CN");
  return <I18nProvider initialLocale="zh-CN" initialTranslations={translations}>
    <AiUserAccountPanel />
  </I18nProvider>;
}
