import type {
  AiPartnerDeviceBinding,
  AiPartnerMemory,
  AiPartnerRecord,
  AiPartnerSkillBinding,
  AiPartnerStorySession,
} from "./types";
import type { AiPartnerRepository } from "./repository";
import { touchAiPartnerRecord } from "./repository";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function replaceById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [next, ...items];
  return items.map((item) => (item.id === next.id ? next : item));
}

export class InMemoryAiPartnerRepository implements AiPartnerRepository {
  private readonly records = new Map<string, AiPartnerRecord>();

  async listPartners(): Promise<AiPartnerRecord[]> {
    return Array.from(this.records.values()).map(clone);
  }

  async getPartner(partnerId: string): Promise<AiPartnerRecord | null> {
    const record = this.records.get(partnerId);
    return record ? clone(record) : null;
  }

  async savePartner(record: AiPartnerRecord): Promise<AiPartnerRecord> {
    const next = touchAiPartnerRecord(record);
    this.records.set(next.profile.id, clone(next));
    return clone(next);
  }

  async deletePartner(partnerId: string): Promise<boolean> {
    return this.records.delete(partnerId);
  }

  async upsertMemory(partnerId: string, memory: AiPartnerMemory): Promise<AiPartnerMemory> {
    const record = await this.requirePartner(partnerId);
    const nextMemory = { ...memory, partnerId };
    await this.savePartner({ ...record, memories: replaceById(record.memories, nextMemory) });
    return clone(nextMemory);
  }

  async listMemories(partnerId: string): Promise<AiPartnerMemory[]> {
    const record = await this.getPartner(partnerId);
    return record ? clone(record.memories) : [];
  }

  async bindDevice(partnerId: string, device: AiPartnerDeviceBinding): Promise<AiPartnerDeviceBinding> {
    const record = await this.requirePartner(partnerId);
    const nextDevice = { ...device, partnerId };
    await this.savePartner({ ...record, devices: replaceById(record.devices, nextDevice) });
    return clone(nextDevice);
  }

  async bindSkill(partnerId: string, skill: AiPartnerSkillBinding): Promise<AiPartnerSkillBinding> {
    const record = await this.requirePartner(partnerId);
    const nextSkill = { ...skill, partnerId };
    await this.savePartner({ ...record, skills: replaceById(record.skills, nextSkill) });
    return clone(nextSkill);
  }

  async upsertStorySession(partnerId: string, session: AiPartnerStorySession): Promise<AiPartnerStorySession> {
    const record = await this.requirePartner(partnerId);
    const nextSession = { ...session, partnerId };
    await this.savePartner({ ...record, storySessions: replaceById(record.storySessions, nextSession) });
    return clone(nextSession);
  }

  async listStorySessions(partnerId: string): Promise<AiPartnerStorySession[]> {
    const record = await this.getPartner(partnerId);
    return record ? clone(record.storySessions) : [];
  }

  private async requirePartner(partnerId: string): Promise<AiPartnerRecord> {
    const record = await this.getPartner(partnerId);
    if (!record) throw new Error(`AI partner not found: ${partnerId}`);
    return record;
  }
}
