import type {
  AiLoverAvatarRegistryItem,
  AiLoverDeviceHealth,
  AiLoverRuntimeStatus,
} from "../../ai-lover-control/types";
import { createEmptyAiPartnerRecord } from "../defaults";
import type {
  AiPartnerDeviceBinding,
  AiPartnerRecord,
  AiPartnerRuntimeStatus,
} from "../types";

export interface AiLoverPartnerAdapterInput {
  partnerId?: string;
  avatar?: Partial<AiLoverAvatarRegistryItem> | null;
  runtime?: AiLoverRuntimeStatus | null;
  devices?: AiLoverDeviceHealth[];
  now?: string;
}

export function aiLoverRuntimeToPartnerStatus(
  runtime: AiLoverRuntimeStatus | null | undefined,
): AiPartnerRuntimeStatus {
  if (!runtime) return "offline";
  if (runtime.ok) return "online";
  if (runtime.listeners?.length) return "degraded";
  return "offline";
}

export function aiLoverDeviceToBinding(
  partnerId: string,
  device: AiLoverDeviceHealth,
): AiPartnerDeviceBinding {
  return {
    id: device.name,
    partnerId,
    deviceType: deviceTypeForAiLoverDevice(device.name),
    endpoint: device.url,
    enabled: true,
    permissions: permissionsForAiLoverDevice(device.name),
    lastHealth: device.ok ? "online" : device.reachable ? "degraded" : "offline",
  };
}

export function createAiPartnerRecordFromAiLover(input: AiLoverPartnerAdapterInput = {}): AiPartnerRecord {
  const now = input.now ?? new Date().toISOString();
  const partnerId = input.partnerId ?? "ai-lover-default";
  const avatar = input.avatar ?? {};
  const record = createEmptyAiPartnerRecord({
    id: partnerId,
    name: "AI-Lover Local Partner",
    displayName: avatar.displayName ?? avatar.label ?? "AI Partner",
    locale: "zh-CN",
    personaPrompt: avatar.identity ?? "",
    avatarId: avatar.id,
    voiceProfileId: avatar.voiceId,
    createdAt: now,
    updatedAt: now,
  });

  return {
    ...record,
    runtime: {
      partnerId,
      status: aiLoverRuntimeToPartnerStatus(input.runtime),
      provider: "ai-lover",
      channelName: "standalone-9120",
      websocketPort: input.runtime?.port,
      lastSeenAt: input.runtime?.generated_at,
    },
    devices: (input.devices ?? []).map((device) => aiLoverDeviceToBinding(partnerId, device)),
    skills: [
      {
        id: "ai-lover-chat",
        partnerId,
        skillId: "ai-lover-chat",
        provider: "local",
        scope: "chat",
        enabled: true,
      },
      {
        id: "ai-lover-live2d-generation",
        partnerId,
        skillId: "live2d-generation",
        provider: "local",
        scope: "video",
        enabled: true,
      },
      {
        id: "infiplot-story-session",
        partnerId,
        skillId: "infiplot-story-session",
        provider: "custom",
        scope: "story",
        enabled: false,
      },
    ],
  };
}

function deviceTypeForAiLoverDevice(name: string): AiPartnerDeviceBinding["deviceType"] {
  if (name === "head") return "head";
  if (name === "hand") return "hand";
  if (name === "live2d-worker") return "live2d";
  if (name === "local-connector") return "local_connector";
  return "custom";
}

function permissionsForAiLoverDevice(name: string): string[] {
  if (name === "head") return ["expression", "speak", "servo"];
  if (name === "hand") return ["gesture"];
  if (name === "live2d-worker") return ["avatar_generation", "preview"];
  if (name === "local-connector") return ["browser_runtime", "bridge"];
  return ["custom"];
}
