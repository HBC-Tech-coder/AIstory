import type { ProviderProtocol } from "@infiplot/types";
import type { StoredModelConfig } from "@/lib/clientModelConfig";
import type { StoredTtsConfig } from "@/lib/clientTtsConfig";
import {
  DEFAULT_TTS_SPEECH_MODEL,
  findTtsPreset,
} from "@/lib/ttsPresets";

export type ByokCapability = "text" | "image" | "vision" | "tts" | "video";
export type ByokCapabilityStatus = "ready" | "missing-fields" | "optional";
export type ByokMissingField =
  | "baseUrl"
  | "apiKey"
  | "model"
  | "presetId";

export type ByokCapabilityDiagnostic = {
  capability: ByokCapability;
  status: ByokCapabilityStatus;
  requiredForCoreStory: boolean;
  provider: ProviderProtocol | "xiaomi" | "auto";
  providerConfigured: boolean;
  baseUrlConfigured: boolean;
  modelConfigured: boolean;
  missingFields: ByokMissingField[];
};

export type ByokCapabilityReport = {
  coreStoryReady: boolean;
  capabilities: ByokCapabilityDiagnostic[];
};

type ModelCapability = Exclude<ByokCapability, "tts">;

const CORE_CAPABILITIES = new Set<ByokCapability>(["text", "image"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function modelField(
  config: Partial<StoredModelConfig> | null | undefined,
  capability: ModelCapability,
  field: "BaseUrl" | "ApiKey" | "Model" | "Provider",
): unknown {
  return config?.[`${capability}${field}` as keyof StoredModelConfig];
}

function diagnoseModelCapability(
  config: Partial<StoredModelConfig> | null | undefined,
  capability: ModelCapability,
): ByokCapabilityDiagnostic {
  const baseUrl = text(modelField(config, capability, "BaseUrl"));
  const apiKey = text(modelField(config, capability, "ApiKey"));
  const model = text(modelField(config, capability, "Model"));
  const explicitProvider = modelField(config, capability, "Provider");
  const provider =
    typeof explicitProvider === "string" && explicitProvider
      ? explicitProvider as ProviderProtocol
      : "auto";
  const missingFields: ByokMissingField[] = [];
  if (!baseUrl) missingFields.push("baseUrl");
  if (!apiKey) missingFields.push("apiKey");
  if (!model) missingFields.push("model");
  const hasAnyField = Boolean(baseUrl || apiKey || model);
  const requiredForCoreStory = CORE_CAPABILITIES.has(capability);
  const status: ByokCapabilityStatus =
    missingFields.length === 0
      ? "ready"
      : !requiredForCoreStory && !hasAnyField
        ? "optional"
        : "missing-fields";

  return {
    capability,
    status,
    requiredForCoreStory,
    provider,
    // "Auto" is a deliberate provider resolution mode in the existing UI.
    providerConfigured: true,
    baseUrlConfigured: Boolean(baseUrl),
    modelConfigured: Boolean(model),
    missingFields,
  };
}

function diagnoseTtsCapability(
  config: Partial<StoredTtsConfig> | null | undefined,
): ByokCapabilityDiagnostic {
  const presetId = text(config?.presetId);
  const apiKey = text(config?.apiKey);
  const preset = findTtsPreset(presetId);
  const missingFields: ByokMissingField[] = [];
  if (!preset) missingFields.push("presetId");
  if (!apiKey) missingFields.push("apiKey");
  const hasAnyField = Boolean(presetId || apiKey);

  return {
    capability: "tts",
    status:
      missingFields.length === 0
        ? "ready"
        : !hasAnyField
          ? "optional"
          : "missing-fields",
    requiredForCoreStory: false,
    provider: "xiaomi",
    providerConfigured: Boolean(preset),
    baseUrlConfigured: Boolean(preset?.baseUrl),
    modelConfigured: Boolean(preset && DEFAULT_TTS_SPEECH_MODEL),
    missingFields,
  };
}

/**
 * Produces a browser-safe readiness report. It intentionally reports only
 * booleans, provider identity and missing field names; credential values and
 * endpoint values never leave the caller.
 */
export function diagnoseByokCapabilities(
  modelConfig: Partial<StoredModelConfig> | null | undefined,
  ttsConfig: Partial<StoredTtsConfig> | null | undefined,
): ByokCapabilityReport {
  const capabilities: ByokCapabilityDiagnostic[] = [
    diagnoseModelCapability(modelConfig, "text"),
    diagnoseModelCapability(modelConfig, "image"),
    diagnoseModelCapability(modelConfig, "vision"),
    diagnoseTtsCapability(ttsConfig),
    diagnoseModelCapability(modelConfig, "video"),
  ];
  return {
    coreStoryReady: capabilities
      .filter((item) => item.requiredForCoreStory)
      .every((item) => item.status === "ready"),
    capabilities,
  };
}

export function findByokCapability(
  report: ByokCapabilityReport,
  capability: ByokCapability,
): ByokCapabilityDiagnostic {
  return report.capabilities.find((item) => item.capability === capability)!;
}

export function hasAnyModelByokField(
  config: Partial<StoredModelConfig> | null | undefined,
): boolean {
  if (!config) return false;
  return (["text", "image", "vision", "video"] as ModelCapability[]).some(
    (capability) =>
      Boolean(
        text(modelField(config, capability, "BaseUrl"))
        || text(modelField(config, capability, "ApiKey"))
        || text(modelField(config, capability, "Model")),
      ),
  );
}
