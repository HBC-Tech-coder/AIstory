import Link from "next/link";
import { headers } from "next/headers";

type Locale = "zh-CN" | "en" | "ja";

type NotFoundCopy = {
  eyebrow: string;
  title: string;
  description: string;
  hint: string;
  homeLabel: string;
  storiesLabel: string;
  navLabel: string;
};

const COPY: Record<Locale, NotFoundCopy> = {
  "zh-CN": {
    eyebrow: "404 · 页面未找到",
    title: "这条故事线走丢了",
    description:
      "你访问的页面不存在，可能已经被移动或删除。回到首页，或者去故事广场继续探索。",
    hint: "如果你是从站内链接来到这里的，可以稍后重试。",
    homeLabel: "返回首页",
    storiesLabel: "浏览故事",
    navLabel: "404 页面导航",
  },
  en: {
    eyebrow: "404 · Page not found",
    title: "This story trail wandered off",
    description:
      "The page you requested does not exist. It may have moved or been removed. Head back home, or keep exploring in Stories.",
    hint: "If you arrived from a link inside the app, try again a little later.",
    homeLabel: "Back home",
    storiesLabel: "Browse stories",
    navLabel: "404 page navigation",
  },
  ja: {
    eyebrow: "404 · ページが見つかりません",
    title: "この物語の道に迷いました",
    description:
      "お探しのページは存在しません。移動または削除された可能性があります。ホームに戻るか、ストーリーで探索を続けてください。",
    hint: "アプリ内のリンクから来た場合は、しばらくしてからもう一度お試しください。",
    homeLabel: "ホームへ戻る",
    storiesLabel: "ストーリーを見る",
    navLabel: "404 ページのナビゲーション",
  },
};

function resolveLocale(value: string | null): Locale {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("ja")) return "ja";
  return "zh-CN";
}

function homeHref(locale: Locale): string {
  return locale === "zh-CN" ? "/" : `/${locale}`;
}

function storiesHref(locale: Locale): string {
  return locale === "zh-CN" ? "/stories" : `/${locale}/stories`;
}

const primaryLinkClass =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-sm bg-clay-900 px-6 py-3 text-sm font-semibold text-cream-50 shadow-lg shadow-clay-900/15 transition-colors hover:bg-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50";

const secondaryLinkClass =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-sm border border-clay-900/15 bg-white px-6 py-3 text-sm font-semibold text-clay-700 transition-colors hover:border-ember-500 hover:text-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-50";

export default async function NotFound() {
  const headerList = await headers();
  const locale = resolveLocale(headerList.get("x-locale"));
  const copy = COPY[locale];

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-cream-50 px-5 py-16 text-clay-900 sm:px-8">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-[-6rem] h-72 w-72 rounded-full bg-ember-500/10 blur-3xl" />
        <div className="absolute -right-20 bottom-[-5rem] h-80 w-80 rounded-full bg-clay-900/5 blur-3xl" />
      </div>

      <section className="relative w-full max-w-xl rounded-md border border-clay-900/15 bg-white p-7 shadow-2xl shadow-clay-900/10 sm:p-10">
        <p className="inline-flex items-center gap-2 rounded-sm border border-clay-900/15 bg-cream-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-ember-500">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ember-500" />
          {copy.eyebrow}
        </p>

        <h1 className="mt-6 flex flex-wrap items-baseline gap-3 text-4xl font-black leading-none tracking-tight text-clay-900 sm:text-5xl">
          <span className="text-ember-500">404</span>
          <span className="text-balance text-2xl font-bold sm:text-3xl">
            {copy.title}
          </span>
        </h1>

        <p className="mt-4 text-base leading-7 text-clay-700">
          {copy.description}
        </p>

        <p className="mt-4 rounded-md border border-clay-900/15 bg-cream-100 px-4 py-3 text-sm leading-6 text-clay-700">
          {copy.hint}
        </p>

        <nav
          aria-label={copy.navLabel}
          className="mt-8 flex flex-col gap-3 sm:flex-row"
        >
          <Link href={homeHref(locale)} className={primaryLinkClass}>
            {copy.homeLabel}
          </Link>
          <Link href={storiesHref(locale)} className={secondaryLinkClass}>
            {copy.storiesLabel}
          </Link>
        </nav>
      </section>
    </main>
  );
}
