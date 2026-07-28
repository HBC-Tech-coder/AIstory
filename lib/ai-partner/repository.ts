import type {
  AiPartnerDeviceBinding,
  AiPartnerMemory,
  AiPartnerRecord,
  AiPartnerSkillBinding,
  AiPartnerStorySession,
} from "./types";

export interface AiPartnerRepository {
  listPartners(): Promise<AiPartnerRecord[]>;
  getPartner(partnerId: string): Promise<AiPartnerRecord | null>;
  savePartner(record: AiPartnerRecord): Promise<AiPartnerRecord>;
  deletePartner(partnerId: string): Promise<boolean>;
  upsertMemory(partnerId: string, memory: AiPartnerMemory): Promise<AiPartnerMemory>;
  listMemories(partnerId: string): Promise<AiPartnerMemory[]>;
  bindDevice(partnerId: string, device: AiPartnerDeviceBinding): Promise<AiPartnerDeviceBinding>;
  bindSkill(partnerId: string, skill: AiPartnerSkillBinding): Promise<AiPartnerSkillBinding>;
  upsertStorySession(partnerId: string, session: AiPartnerStorySession): Promise<AiPartnerStorySession>;
  listStorySessions(partnerId: string): Promise<AiPartnerStorySession[]>;
}

export function touchAiPartnerRecord(record: AiPartnerRecord, updatedAt = new Date().toISOString()): AiPartnerRecord {
  return {
    ...record,
    profile: {
      ...record.profile,
      updatedAt,
    },
  };
}
