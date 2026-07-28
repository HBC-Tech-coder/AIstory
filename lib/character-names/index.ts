import type { Character } from "@infiplot/types";
import { stableHash } from "@/lib/speculativeBranch";
import { NAME_PACKS } from "./packs";

export const CHARACTER_NAME_GENERATOR_VERSION = "namegen-v1";
const RECENT_NAMES_KEY = "aistory:recent-character-names:v1";
const NAME_METRICS_KEY = "aistory:character-name-metrics:v1";
const MAX_RECENT = 120;

export type NameGenerationContext = {
  locale?: string;
  culture?: string;
  gender?: "male" | "female" | "neutral";
  existingNames?: string[];
  recentNames?: string[];
  surnameLock?: string;
  count?: number;
};

export type NameCandidate = {
  name: string;
  meaning?: string;
  source: "random" | "ai" | "fallback";
  generatorVersion: string;
  locale: string;
  culture: string;
};

export type CharacterNameMetrics = {
  generated_count: number;
  repeated_count: number;
  similarity_reject_count: number;
  ai_name_fallback_count: number;
};

export function stableCharacterId(
  canonicalName: string,
  storyId = "story",
): string {
  return `char_${stableHash({ storyId, canonicalName }).slice(0, 12)}`;
}

export function sanitizeCharacterName(value: string): string | null {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\{\{|\}\}|<\s*\/?\s*(system|assistant|user)\b/gi, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 40) return null;
  if (
    /^(system|assistant|developer)$/i.test(cleaned)
    || /(ignore\s+(all\s+)?previous|system\s*prompt|系统提示)/i.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let previous = rows[0]!;
    rows[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const old = rows[i]!;
      rows[i] = Math.min(
        rows[i]! + 1,
        rows[i - 1]! + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  return rows[a.length]!;
}

export function areNamesTooSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2) {
    if (a[0] === b[0] && a.at(-1) === b.at(-1)) return true;
    const overlap = [...new Set(a)].filter((char) => b.includes(char)).length;
    if (overlap / Math.min(a.length, b.length) >= 0.75) return true;
  }
  return editDistance(a.toLowerCase(), b.toLowerCase()) <= 1;
}

function pickPack(locale?: string, culture?: string) {
  return (
    NAME_PACKS.find((pack) => culture && pack.culture === culture) ||
    NAME_PACKS.find((pack) => pack.locale === locale) ||
    (locale?.startsWith("en")
      ? NAME_PACKS.find((pack) => pack.locale === "en")
      : NAME_PACKS[0])!
  );
}

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export function generateLocalNames(
  context: NameGenerationContext = {},
): NameCandidate[] {
  const pack = pickPack(context.locale, context.culture);
  const count = Math.min(12, Math.max(1, context.count ?? 6));
  const blocked = [
    ...(context.existingNames ?? []),
    // A rolling window lowers consecutive-start repeats without permanently
    // exhausting a locale pack for long-time users.
    ...(context.recentNames ?? []).slice(0, 18),
  ];
  const output: NameCandidate[] = [];
  const given =
    context.gender === "male"
      ? pack.givenMale
      : context.gender === "female"
        ? pack.givenFemale
        : pack.givenNeutral;
  const attemptBudget = Math.max(600, count * 200);
  for (let attempts = 0; output.length < count && attempts < attemptBudget; attempts++) {
    const surname =
      context.surnameLock?.trim() ||
      (pack.locale === "zh-CN" ? randomItem(pack.surnames) : randomItem(pack.surnames));
    const first = randomItem(given);
    const name = pack.locale === "zh-CN" ? `${surname}${first}` : `${first} ${surname}`;
    if (
      [...blocked, ...output.map((candidate) => candidate.name)].some((existing) =>
        areNamesTooSimilar(name, existing),
      )
    ) {
      continue;
    }
    output.push({
      name,
      source: "random",
      generatorVersion: CHARACTER_NAME_GENERATOR_VERSION,
      locale: pack.locale,
      culture: pack.culture,
    });
  }
  return output;
}

export function readRecentCharacterNames(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_NAMES_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberCharacterName(name: string): void {
  if (typeof window === "undefined") return;
  try {
    const next = [name, ...readRecentCharacterNames().filter((item) => item !== name)]
      .slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_NAMES_KEY, JSON.stringify(next));
  } catch {
    /* local metrics/history are best effort */
  }
}

export function readCharacterNameMetrics(): CharacterNameMetrics {
  const empty: CharacterNameMetrics = {
    generated_count: 0,
    repeated_count: 0,
    similarity_reject_count: 0,
    ai_name_fallback_count: 0,
  };
  if (typeof window === "undefined") return empty;
  try {
    const parsed = JSON.parse(localStorage.getItem(NAME_METRICS_KEY) || "{}");
    return {
      generated_count: Number(parsed.generated_count) || 0,
      repeated_count: Number(parsed.repeated_count) || 0,
      similarity_reject_count: Number(parsed.similarity_reject_count) || 0,
      ai_name_fallback_count: Number(parsed.ai_name_fallback_count) || 0,
    };
  } catch {
    return empty;
  }
}

export function recordCharacterNameMetric(
  key: keyof CharacterNameMetrics,
  amount = 1,
): void {
  if (typeof window === "undefined") return;
  try {
    const current = readCharacterNameMetrics();
    localStorage.setItem(NAME_METRICS_KEY, JSON.stringify({
      ...current,
      [key]: current[key] + amount,
    }));
  } catch {
    /* best-effort local product metric */
  }
}

export function withCharacterIdentity(
  character: Character,
  storyId?: string,
): Character {
  return {
    ...character,
    characterId:
      character.characterId ||
      stableCharacterId(character.canonicalName || character.name, storyId),
    canonicalName: character.canonicalName || character.name,
    nameMeta: character.nameMeta || { source: "author" },
  };
}

export function displayCharacterName(character: Character): string {
  return character.alias?.trim() || character.canonicalName || character.name;
}
