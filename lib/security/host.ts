export function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader
    .trim()
    .replace(/^\[/, "")
    .replace(/\](?::\d+)?$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
}
