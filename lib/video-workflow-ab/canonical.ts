import { createHash } from "node:crypto";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalize(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON does not allow non-finite numbers.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error("Canonical JSON contains a forbidden object key.");
      }
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error("Canonical JSON does not allow undefined values.");
      }
      result[key] = normalize(child);
    }
    return result;
  }
  throw new Error("Canonical JSON contains an unsupported value.");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseCanonicalJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.startsWith("\uFEFF") || text.trim() !== text) {
    throw new Error("JSON file is not canonical.");
  }
  const parsed = JSON.parse(text) as unknown;
  if (canonicalJson(parsed) !== text) {
    throw new Error("JSON file is not canonical.");
  }
  return parsed;
}
