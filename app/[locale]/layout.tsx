import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { LOCALES, type Locale } from "@/lib/i18n/config";
import { createTranslator, loadTranslations } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/client";
import { isValidLocale } from "@/lib/i18n/utils";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  if (!isValidLocale(rawLocale)) return {};
  const translations = await loadTranslations(rawLocale as Locale);
  const t = createTranslator(translations);
  return {
    title: t("layout.metadata.title"),
    description: t("layout.metadata.description"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isValidLocale(locale)) notFound();

  const translations = await loadTranslations(locale as Locale);

  return (
    <I18nProvider initialLocale={locale as Locale} initialTranslations={translations}>
      {children}
    </I18nProvider>
  );
}
