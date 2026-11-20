import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE } from "./lib/auth/linghaoPassportV4ProductionCookies";

// Locale prefixes that appear in the URL (default zh-CN has no prefix).
const LOCALE_PREFIXES = ["en", "ja"] as const;
const DEFAULT_LOCALE = "zh-CN";

function detectLocaleFromPath(pathname: string): { locale: string; stripped: string } | null {
  for (const prefix of LOCALE_PREFIXES) {
    if (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`)) {
      const stripped = pathname.slice(prefix.length + 1) || "/";
      return { locale: prefix, stripped };
    }
  }
  return null;
}

// Next.js 16 deprecated `middleware` in favor of `proxy`, but `proxy` is locked
// to the Node.js runtime. OpenNext for Cloudflare rejects Node.js middleware at
// build time ("Node.js middleware is not currently supported"), so we keep the
// `middleware` convention, which itself selects the Edge runtime. Do not export
// the retired `experimental-edge` runtime value: Next 16 repeatedly re-analyzes
// it in development. Revisit once OpenNext supports Node.js proxy execution.
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Locale routing ─────────────────────────────────────────────────
  // Skip locale logic for API routes, auth, and static assets.
  const skipLocale =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/home/") ||
    pathname.startsWith("/docs/") ||
    /\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|woff2?|ttf|otf|json|xml|txt|map|mp4|webm|mp3|m4a|wav|ogg|vtt)$/i.test(pathname);

  let locale = DEFAULT_LOCALE;
  let response: NextResponse;

  if (!skipLocale) {
    // If someone visits /zh-CN/... explicitly, redirect to bare path (keep clean URLs).
    if (pathname === "/zh-CN" || pathname.startsWith("/zh-CN/")) {
      const bare = pathname.slice(6) || "/";
      const url = request.nextUrl.clone();
      url.pathname = bare;
      return NextResponse.next({ request });
    }

    const detected = detectLocaleFromPath(pathname);
    if (detected) {
      // URL has a locale prefix (e.g. /en/play) — pass through with locale header.
      locale = detected.locale;
      response = NextResponse.next({ request });
    } else {
      // Preserve Next's original origin so this stays an internal rewrite.
      // nextUrl.clone() normalizes 127.0.0.1 to localhost, which can turn an
      // HTTPS-forwarded request into a TLS proxy call to an HTTP-only listener.
      // Paired with skipProxyUrlNormalize in next.config; never derive an origin
      // from Host/forwarded headers or downgrade the external HTTPS protocol.
      const url = new URL(request.url);
      url.pathname = `/${DEFAULT_LOCALE}${pathname}`;
      response = NextResponse.rewrite(url);
    }
  } else {
    response = NextResponse.next({ request });
  }

  // Set locale + pathname headers so root layout can read them for
  // <html lang> and <link rel="alternate" hreflang>.
  response.headers.set("x-locale", locale);
  response.headers.set("x-pathname", pathname);

  // The default-off Linghao Passport v4 local test surface owns only these
  // exact paths. Preserve the locale/pathname response headers above and never
  // branch on cookie presence for an arbitrary request.
  if (
    pathname.startsWith("/api/auth/linghao-passport-v4/") ||
    pathname === "/auth/linghao-passport-v4"
  ) {
    return response;
  }

  // ── Supabase auth token refresh ────────────────────────────────────
  // AIUser owns these exact independent auth boundaries, including their disabled path.
  // Never refresh or map a legacy Supabase session as an OIDC side effect.
  if (pathname === "/api/auth/aiuser/start" || pathname === "/api/auth/aiuser/callback") return response;
  if (pathname.startsWith("/api/auth/aiuser/") || pathname === "/auth/aiuser"
    || request.cookies.has("__Host-aistory_aiuser_user_v1")) return response;
  // A present Passport product cookie owns identity resolution even when it is
  // stale, malformed, or the production gate is unavailable. Never refresh a
  // legacy Supabase session that the request is not allowed to fall through to.
  if (request.cookies.has(LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE)) return response;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return response;

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  try {
    await supabase.auth.getUser();
  } catch {
    return response;
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|woff2?|ttf|otf|html|xml|txt|map|mp4|webm|mp3|m4a|wav|ogg|vtt)).*)",
  ],
};
