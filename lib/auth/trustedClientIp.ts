import "server-only";

import { isIP } from "node:net";

const DIRECT_CLIENT_BUCKET = "direct-client";
const INVALID_TRUSTED_PROXY_BUCKET = "trusted-proxy-invalid";

function validIp(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && isIP(normalized) ? normalized : undefined;
}

export function resolveSmsRequestIp(
  headers: Headers,
  trustProxyHeaders = process.env.AISTORY_TRUST_PROXY_HEADERS === "true",
): string {
  if (!trustProxyHeaders) return DIRECT_CLIENT_BUCKET;

  const realIp = validIp(headers.get("x-real-ip"));
  if (realIp) return realIp;

  const forwarded = headers.get("x-forwarded-for")
    ?.split(",")
    .map((value) => validIp(value))
    .filter((value): value is string => Boolean(value));

  // For the supported single local reverse-proxy topology, the proxy appends
  // or overwrites the actual peer address at the right edge. Never trust the
  // client-controlled left-most value.
  return forwarded?.at(-1) || INVALID_TRUSTED_PROXY_BUCKET;
}
