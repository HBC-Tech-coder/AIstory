import { isLoopbackHost } from "@/lib/security/host";

function normalizedHost(value: string): string {
  return value.trim().toLowerCase();
}

export function isTrustedLoopbackMutationRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!isLoopbackHost(host)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const requestUrl = new URL(request.url);
    if (!isLoopbackHost(parsed.host)) return false;
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.protocol !== requestUrl.protocol ||
      normalizedHost(requestUrl.host) !== normalizedHost(host!)
    ) {
      return false;
    }
    return normalizedHost(parsed.host) === normalizedHost(host!);
  } catch {
    return false;
  }
}

export function isLoopbackReadRequest(request: Request): boolean {
  return isLoopbackHost(request.headers.get("host"));
}

export function assertTrustedLoopbackMutation(request: Request): void {
  if (!isTrustedLoopbackMutationRequest(request)) {
    throw new Error("Local GPU mutation is restricted to the loopback AIstory origin.");
  }
}

export function isTrustedSameOriginMutationRequest(
  request: Request,
  requireHttps = true,
): boolean {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !origin) return false;
  try {
    const parsed = new URL(origin);
    if (
      parsed.username ||
      parsed.password ||
      (requireHttps && parsed.protocol !== "https:")
    ) {
      return false;
    }
    return normalizedHost(parsed.host) === normalizedHost(host);
  } catch {
    return false;
  }
}

export function assertTrustedAdminMutation(
  request: Request,
  actorMode: "local" | "production",
): void {
  if (actorMode === "local") {
    assertTrustedLoopbackMutation(request);
    return;
  }
  if (!isTrustedSameOriginMutationRequest(request, true)) {
    throw new Error("Production admin mutation requires the HTTPS AIstory origin.");
  }
}
