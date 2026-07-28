import type { AiLoverCharacterProfile } from "./types";

export interface AiLoverCharacterRuntimePatch {
  avatarId?: string;
  voiceId?: string;
  personaPrompt?: string;
  displayName?: string;
}

export function toRuntimeCharacterPatch(character: AiLoverCharacterProfile): AiLoverCharacterRuntimePatch {
  return {
    avatarId: character.id,
    voiceId: character.voiceId,
    personaPrompt: character.identity,
    displayName: character.displayName,
  };
}

export function normalizeAiLoverCharacter(input: Partial<AiLoverCharacterProfile>): AiLoverCharacterProfile {
  const id = input.id?.trim() || "unknown";
  const displayName = input.displayName?.trim() || input.label?.trim() || id;
  return {
    id,
    label: input.label?.trim() || displayName,
    displayName,
    modelUrl: input.modelUrl,
    voiceId: input.voiceId,
    identity: input.identity,
    intro: input.intro,
    generated: Boolean(input.generated),
    hidden: Boolean(input.hidden),
  };
}
