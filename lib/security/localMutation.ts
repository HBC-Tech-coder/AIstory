import { isLoopbackHost } from "@/lib/admin/security";

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
    if (!isLoopbackHost(parsed.host)) return false;
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
