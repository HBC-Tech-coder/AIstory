import type { Metadata } from "next";
import { Suspense } from "react";

import { SteamLaunchExperience } from "@/components/SteamLaunchExperience";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";
import { localePath } from "@/lib/i18n/navigation";
import { isValidLocale } from "@/lib/i18n/utils";
import { STEAM_LAUNCH_CASE_ID } from "@/lib/steam/releaseContent";

export const metadata: Metadata = {
  title: "AIstory · Steam 本地互动影游",
  description:
    "AIstory Windows x64、Linux x64 与 Steam Deck 候选入口；真实 Steamworks 尚未接入。",
};

export default async function SteamPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale)
    ? rawLocale
    : DEFAULT_LOCALE;
  const lp = (path: string) => localePath(path, locale);

  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#070b18] text-white">
          <p className="text-sm text-slate-300">正在载入本地互动影游…</p>
        </main>
      }
    >
      <SteamLaunchExperience
        locale={locale}
        homeHref={lp("/")}
        storiesHref={`${lp("/stories")}?channel=steam`}
        playHref={`${lp("/play")}?case=${STEAM_LAUNCH_CASE_ID}&channel=steam`}
      />
    </Suspense>
  );
}
