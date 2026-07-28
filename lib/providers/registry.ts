export type AIstoryProviderId =
  | "bailian"
  | "comfyui"
  | "localminidrama"
  | "volcengine-agent-plan";

export type AIstoryProviderModality = "text" | "image" | "tts" | "video";

export type ProviderCapabilityLevel =
  | "supported"
  | "async_contract"
  | "selection_only"
  | "unsupported";

export type ProviderDescriptor = {
  id: AIstoryProviderId;
  label: string;
  productLayer: "cloud" | "local";
  capabilities: Record<AIstoryProviderModality, ProviderCapabilityLevel>;
};

export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] = [
  {
    id: "bailian",
    label: "阿里百炼",
    productLayer: "cloud",
    capabilities: {
      text: "supported",
      image: "supported",
      tts: "supported",
      video: "unsupported",
    },
  },
  {
    id: "volcengine-agent-plan",
    label: "火山引擎 Agent Plan",
    productLayer: "cloud",
    capabilities: {
      text: "selection_only",
      image: "selection_only",
      tts: "selection_only",
      video: "async_contract",
    },
  },
  {
    id: "comfyui",
    label: "ComfyUI 本地工作流",
    productLayer: "local",
    capabilities: {
      text: "unsupported",
      image: "supported",
      tts: "unsupported",
      video: "supported",
    },
  },
  {
    id: "localminidrama",
    label: "LocalMiniDrama",
    productLayer: "local",
    capabilities: {
      text: "unsupported",
      image: "supported",
      tts: "unsupported",
      video: "selection_only",
    },
  },
] as const;

export function getProviderDescriptor(
  id: AIstoryProviderId,
): ProviderDescriptor {
  const descriptor = PROVIDER_REGISTRY.find((provider) => provider.id === id);
  if (!descriptor) throw new Error(`Unknown AIstory provider: ${id}`);
  return descriptor;
}
