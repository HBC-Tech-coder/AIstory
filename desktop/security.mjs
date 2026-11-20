import { URL } from "node:url";

export const DEFAULT_EXTERNAL_TARGETS = Object.freeze([
  {
    id: "aistory-github",
    label: "AIstory 项目主页",
    url: "https://github.com/HBC-Tech-coder/AIstory",
  },
]);

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

export function parseLoopbackHttpUrl(input) {
  try {
    const parsed = new URL(String(input || ""));
    if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function canonicalExternalUrl(input) {
  try {
    const parsed = new URL(String(input || ""));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

export function decideExternalTarget(
  input,
  allowlist = DEFAULT_EXTERNAL_TARGETS,
) {
  const parsed = canonicalExternalUrl(input);
  if (!parsed) return { allowed: false, reason: "invalid-target" };
  for (const target of allowlist) {
    const allowed = canonicalExternalUrl(target.url);
    if (!allowed) continue;
    if (
      parsed.origin === allowed.origin &&
      parsed.pathname === allowed.pathname &&
      parsed.search === allowed.search
    ) {
      return {
        allowed: true,
        id: target.id,
        label: target.label,
        url: parsed.toString(),
        domain: parsed.hostname,
      };
    }
  }
  return { allowed: false, reason: "not-allowlisted" };
}

export function isTrustedRendererUrl(input, expectedOrigin) {
  try {
    const parsed = new URL(String(input || ""));
    return (
      parseLoopbackHttpUrl(parsed.toString()) !== null &&
      parsed.origin === expectedOrigin
    );
  } catch {
    return false;
  }
}
