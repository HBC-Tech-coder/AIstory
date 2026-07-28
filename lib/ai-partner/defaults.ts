import type { AiPartnerProfile, AiPartnerRecord } from "./types";

export interface CreateAiPartnerProfileInput extends Partial<AiPartnerProfile> {
  id?: string;
}

export function createDefaultAiPartnerProfile(input: CreateAiPartnerProfileInput = {}): AiPartnerProfile {
  const now = new Date().toISOString();
  const id = input.id ?? "ai-partner-default";
  return {
    id,
    name: input.name ?? id,
    displayName: input.displayName ?? "AI Partner",
    locale: input.locale ?? "zh-CN",
    personaPrompt: input.personaPrompt ?? "",
    safetyPolicyId: input.safetyPolicyId,
    avatarId: input.avatarId,
    voiceProfileId: input.voiceProfileId,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

export function createEmptyAiPartnerRecord(input: CreateAiPartnerProfileInput = {}): AiPartnerRecord {
  return {
    profile: createDefaultAiPartnerProfile(input),
    memories: [],
    devices: [],
    storySessions: [],
    skills: [],
  };
}
