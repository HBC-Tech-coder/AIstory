import type { Character } from "@infiplot/types";

export const PLAYER_NAME_SLOT = "{{PLAYER_NAME}}";

const PLAYER_NAME_RE = /\{\{\s*PLAYER_NAME\s*\}\}/g;
const PLAYER_NAME_TEST_RE = /\{\{\s*PLAYER_NAME\s*\}\}/;
const CHARACTER_TOKEN_RE = /\{\{\s*CHARACTER:([A-Za-z0-9_-]+)\s*\}\}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderCharacterAliases(
  text: string,
  characters: readonly Character[] = [],
): string {
  if (!characters.length || !text) return text;
  const byId = new Map(
    characters
      .filter((character) => character.characterId)
      .map((character) => [character.characterId!, character]),
  );
  let rendered = text.replace(CHARACTER_TOKEN_RE, (token, id: string) => {
    const character = byId.get(id);
    return character?.alias?.trim()
      || character?.canonicalName
      || character?.name
      || token;
  });

  // Legacy generated prose may contain an old canonical display name rather
  // than a token. Replace only at punctuation/whitespace boundaries; never do
  // a raw global substring replacement that could damage ordinary words.
  for (const character of characters) {
    const alias = character.alias?.trim();
    const canonical = character.canonicalName || character.name;
    if (!alias || alias === canonical || !canonical) continue;
    const boundary = new RegExp(
      `(^|[^\\p{L}\\p{N}_])(${escapeRegExp(canonical)})(?=$|[^\\p{L}\\p{N}_])`,
      "gu",
    );
    rendered = rendered.replace(boundary, (_match, prefix: string) => `${prefix}${alias}`);
  }
  return rendered;
}

export function displayPlayerName(
  playerName?: string,
  fallbackName = "你",
): string {
  const trimmed = playerName?.trim();
  return trimmed || fallbackName;
}

export function hasPersonalizationSlot(text?: string | null): boolean {
  return typeof text === "string" && PLAYER_NAME_TEST_RE.test(text);
}

export function renderPersonalizedText(
  text: string | undefined | null,
  playerName?: string,
  fallbackName = "你",
  characters: readonly Character[] = [],
): string {
  if (!text) return "";
  return renderCharacterAliases(
    text.replace(PLAYER_NAME_RE, displayPlayerName(playerName, fallbackName)),
    characters,
  );
}

export function renderPersonalizedSpeaker(
  speaker: string | undefined,
  playerName?: string,
  fallbackName = "你",
  characters: readonly Character[] = [],
): string | undefined {
  if (!speaker) return undefined;
  if (speaker === "你") return displayPlayerName(playerName, fallbackName);
  const exact = characters.find((character) =>
    character.characterId === speaker
    || character.name === speaker
    || character.canonicalName === speaker,
  );
  if (exact) return exact.alias?.trim() || exact.canonicalName || exact.name;
  return renderPersonalizedText(speaker, playerName, fallbackName, characters);
}
