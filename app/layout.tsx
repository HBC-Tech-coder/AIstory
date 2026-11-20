import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Analytics } from "@/components/Analytics";
import { LOCALES } from "@/lib/i18n/config";
import { localePath } from "@/lib/i18n/navigation";
import { stripLocalePrefix } from "@/lib/i18n/navigation";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIstory — AI 实时交互剧情游戏",
  description: "AIstory 是一款用 AI 实时生成图片、语音与剧情分支的交互式剧情游戏 Demo。",
};

// viewportFit:cover lets the immersive /play portrait layout extend under the
// iOS notch / home-indicator and exposes env(safe-area-inset-*) to the
// floating controls. device-width + initialScale keep mobile rendering 1:1.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const locale = headersList.get("x-locale") || "zh-CN";

  const origin =
    process.env.NEXT_PUBLIC_BASE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "https://infiplot.com");
  const pathname = headersList.get("x-pathname") || "/";
  const barePath = stripLocalePrefix(pathname);

  return (
    <html
      lang={locale}
      suppressHydrationWarning
    >
      <head>
        {LOCALES.map((l) => (
          <link
            key={l}
            rel="alternate"
            hrefLang={l}
            href={`${origin}${localePath(barePath, l)}`}
          />
        ))}
        <link rel="alternate" hrefLang="x-default" href={`${origin}${barePath}`} />
      </head>
      <body className="aistory-app bg-cream-50 text-clay-900 font-sans antialiased min-h-screen overflow-x-hidden">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
