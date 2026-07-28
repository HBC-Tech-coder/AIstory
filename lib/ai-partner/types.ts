export type AiPartnerRuntimeStatus = "offline" | "starting" | "online" | "degraded" | "stopping" | "error";

export interface AiPartnerProfile {
  id: string;
  name: string;
  displayName: string;
  locale: string;
  personaPrompt: string;
  safetyPolicyId?: string;
  avatarId?: string;
  voiceProfileId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiPartnerMemory {
  id: string;
  partnerId: string;
  type: "user_preference" | "relationship" | "story" | "fact" | "skill" | "system";
  content: string;
  source: "chat" | "story" | "tool" | "import" | "manual";
  importance: number;
  createdAt: string;
  updatedAt?: string;
}

export interface AiPartnerRuntime {
  partnerId: string;
  status: AiPartnerRuntimeStatus;
  provider: "ai-lover" | "hermes" | "infiplot" | "openhuman" | "fay" | "custom";
  graphName?: string;
  channelName?: string;
  websocketPort?: number;
  sessionId?: string;
  lastSeenAt?: string;
  error?: string;
}

export interface AiPartnerDeviceBinding {
  id: string;
  partnerId: string;
  deviceType: "head" | "hand" | "camera" | "microphone" | "live2d" | "local_connector" | "avatar_video" | "custom";
  endpoint?: string;
  enabled: boolean;
  permissions: string[];
  lastHealth?: "unknown" | "online" | "offline" | "degraded";
}

export interface AiPartnerStorySession {
  id: string;
  partnerId: string;
  storyId: string;
  engine: "infiplot" | "ink" | "yarn" | "renpy" | "webgal" | "custom";
  currentNode?: string;
  branchState: Record<string, unknown>;
  endingState?: string;
  updatedAt: string;
}

export interface AiPartnerSkillBinding {
  id: string;
  partnerId: string;
  skillId: string;
  provider: "hermes" | "mcp" | "local" | "cloud" | "custom";
  scope: "chat" | "story" | "device" | "memory" | "video" | "admin";
  enabled: boolean;
  configRef?: string;
}

export interface AiPartnerRecord {
  profile: AiPartnerProfile;
  runtime?: AiPartnerRuntime;
  memories: AiPartnerMemory[];
  devices: AiPartnerDeviceBinding[];
  storySessions: AiPartnerStorySession[];
  skills: AiPartnerSkillBinding[];
}
