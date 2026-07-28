import type { EngineConfig, ProviderProtocol } from "@infiplot/types";
import type { ByokPersistence } from "@/lib/credentials/types";

// Bring-your-own model keys — stored CLIENT-SIDE ONLY.
//
// When a user supplies their own text/image/vision API credentials, we persist
// them in localStorage and the browser talks to providers directly. The keys
// are therefore never sent to our server: no request body, no header, no log.

const STORAGE_KEY = "infiplot:model";
const PERSISTENCE_KEY = "infiplot:byokPersistence";

const VALID_PROTOCOLS: ProviderProtocol[] = [
  "openai_compatible",
  "openai",
  "runware",
  "dashscope",
];

export type ModelSettingsMode = "unified" | "split";

export type StoredModelConfig = {
  settingsMode?: ModelSettingsMode;
  unifiedBaseUrl?: string;
  unifiedApiKey?: string;
  unifiedProvider?: ProviderProtocol;
  textBaseUrl: string;
  textApiKey: string;
  textModel: string;
  textProvider?: ProviderProtocol;
  imageBaseUrl: string;
  imageApiKey: string;
  imageModel: string;
  imageProvider?: ProviderProtocol;
  visionBaseUrl: string;
  visionApiKey: string;
  visionModel: string;
  visionProvider?: ProviderProtocol;
  videoBaseUrl?: string;
  videoApiKey?: string;
  videoModel?: string;
  videoProvider?: ProviderProtocol;
};

export type StoredModelCapability = "text" | "image" | "vision" | "video";

function readMode(raw: unknown): ModelSettingsMode | undefined {
  return raw === "unified" || raw === "split" ? raw : undefined;
}

function isValidProtocol(p: string): p is ProviderProtocol {
  return (VALID_PROTOCOLS as readonly string[]).includes(p);
}

function readProtocol(raw: unknown): ProviderProtocol | undefined {
  if (typeof raw === "string" && isValidProtocol(raw)) return raw;
  return undefined;
}

/** Read the persisted model form, including incomplete optional capabilities.
 *  Capability-specific callers perform their own readiness checks. */
export function readStoredModelConfig(): StoredModelConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.sessionStorage.getItem(STORAGE_KEY)
      ?? window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredModelConfig>;

    const textBaseUrl = typeof parsed.textBaseUrl === "string" ? parsed.textBaseUrl.trim() : "";
    const textApiKey = typeof parsed.textApiKey === "string" ? parsed.textApiKey.trim() : "";
    const textModel = typeof parsed.textModel === "string" ? parsed.textModel.trim() : "";
    const imageBaseUrl = typeof parsed.imageBaseUrl === "string" ? parsed.imageBaseUrl.trim() : "";
    const imageApiKey = typeof parsed.imageApiKey === "string" ? parsed.imageApiKey.trim() : "";
    const imageModel = typeof parsed.imageModel === "string" ? parsed.imageModel.trim() : "";
    const visionBaseUrl = typeof parsed.visionBaseUrl === "string" ? parsed.visionBaseUrl.trim() : "";
    const visionApiKey = typeof parsed.visionApiKey === "string" ? parsed.visionApiKey.trim() : "";
    const visionModel = typeof parsed.visionModel === "string" ? parsed.visionModel.trim() : "";
    const videoBaseUrl = typeof parsed.videoBaseUrl === "string" ? parsed.videoBaseUrl.trim() : "";
    const videoApiKey = typeof parsed.videoApiKey === "string" ? parsed.videoApiKey.trim() : "";
    const videoModel = typeof parsed.videoModel === "string" ? parsed.videoModel.trim() : "";
    const unifiedBaseUrl = typeof parsed.unifiedBaseUrl === "string" ? parsed.unifiedBaseUrl.trim() : "";
    const unifiedApiKey = typeof parsed.unifiedApiKey === "string" ? parsed.unifiedApiKey.trim() : "";

    const hasRecognizedField = Boolean(
      textBaseUrl ||
      textApiKey ||
      textModel ||
      imageBaseUrl ||
      imageApiKey ||
      imageModel ||
      visionBaseUrl ||
      visionApiKey ||
      visionModel ||
      videoBaseUrl ||
      videoApiKey ||
      videoModel ||
      unifiedBaseUrl ||
      unifiedApiKey
    );
    if (!hasRecognizedField) {
      return null;
    }

    return {
      settingsMode: readMode(parsed.settingsMode),
      unifiedBaseUrl: unifiedBaseUrl || undefined,
      unifiedApiKey: unifiedApiKey || undefined,
      unifiedProvider: readProtocol(parsed.unifiedProvider),
      textBaseUrl,
      textApiKey,
      textModel,
      textProvider: readProtocol(parsed.textProvider),
      imageBaseUrl,
      imageApiKey,
      imageModel,
      imageProvider: readProtocol(parsed.imageProvider),
      visionBaseUrl,
      visionApiKey,
      visionModel,
      visionProvider: readProtocol(parsed.visionProvider),
      videoBaseUrl: videoBaseUrl || undefined,
      videoApiKey: videoApiKey || undefined,
      videoModel: videoModel || undefined,
      videoProvider: readProtocol(parsed.videoProvider),
    };
  } catch {
    return null;
  }
}

function capabilityLabel(capability: StoredModelCapability): string {
  return {
    text: "文字",
    image: "图片",
    vision: "识图",
    video: "视频",
  }[capability];
}

export function resolveStoredProviderConfig(
  model: StoredModelConfig,
  capability: StoredModelCapability,
): import("@infiplot/types").ProviderConfig {
  const baseUrl = model[`${capability}BaseUrl`]?.trim() ?? "";
  const apiKey = model[`${capability}ApiKey`]?.trim() ?? "";
  const modelName = model[`${capability}Model`]?.trim() ?? "";
  const missing: string[] = [];
  if (!baseUrl) missing.push("Base URL");
  if (!apiKey) missing.push("API Key");
  if (!modelName) missing.push("Model");
  if (missing.length > 0) {
    throw new Error(`${capabilityLabel(capability)}能力未配置：缺少 ${missing.join("、")}`);
  }
  return {
    baseUrl,
    apiKey,
    model: modelName,
    provider: model[`${capability}Provider`],
  };
}

/** Persist the model config. Trims all string fields so trailing whitespace
 *  from pastes never breaks headers. */
export function writeStoredModelConfig(
  config: StoredModelConfig,
  persistence: ByokPersistence = "session",
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredModelConfig = {
      settingsMode: config.settingsMode,
      unifiedBaseUrl: config.unifiedBaseUrl?.trim() || undefined,
      unifiedApiKey: config.unifiedApiKey?.trim() || undefined,
      unifiedProvider: config.unifiedProvider,
      textBaseUrl: config.textBaseUrl.trim(),
      textApiKey: config.textApiKey.trim(),
      textModel: config.textModel.trim(),
      textProvider: config.textProvider,
      imageBaseUrl: config.imageBaseUrl.trim(),
      imageApiKey: config.imageApiKey.trim(),
      imageModel: config.imageModel.trim(),
      imageProvider: config.imageProvider,
      visionBaseUrl: config.visionBaseUrl.trim(),
      visionApiKey: config.visionApiKey.trim(),
      visionModel: config.visionModel.trim(),
      visionProvider: config.visionProvider,
      videoBaseUrl: config.videoBaseUrl?.trim() || undefined,
      videoApiKey: config.videoApiKey?.trim() || undefined,
      videoModel: config.videoModel?.trim() || undefined,
      videoProvider: config.videoProvider,
    };
    const target = persistence === "local"
      ? window.localStorage
      : window.sessionStorage;
    const other = persistence === "local"
      ? window.sessionStorage
      : window.localStorage;
    target.setItem(STORAGE_KEY, JSON.stringify(payload));
    other.removeItem(STORAGE_KEY);
    window.localStorage.setItem(PERSISTENCE_KEY, persistence);
  } catch {
    // Storage disabled / quota / private mode — BYO simply stays off.
  }
}

export function clearStoredModelConfig(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(PERSISTENCE_KEY);
  } catch {
    // ignore
  }
}

export function readByokPersistence(): ByokPersistence {
  if (typeof window === "undefined") return "session";
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY)) return "session";
    return window.localStorage.getItem(PERSISTENCE_KEY) === "local"
      ? "local"
      : "session";
  } catch {
    return "session";
  }
}

/** Build a full EngineConfig from stored model config + optional TTS config.
 *  Throws when model config is missing so callers can surface a friendly
 *  "please configure" message. */
export function resolveEngineConfig(
  model: StoredModelConfig | null,
  tts: import("@infiplot/types").TtsConfig | null,
): EngineConfig {
  if (!model) {
    throw new Error("模型配置未设置。请返回首页，点击「模型设置」配置 API 参数。");
  }
  const text = resolveStoredProviderConfig(model, "text");
  const image = resolveStoredProviderConfig(model, "image");
  const vision = model.visionBaseUrl.trim() &&
      model.visionApiKey.trim() &&
      model.visionModel.trim()
    ? resolveStoredProviderConfig(model, "vision")
    : text;
  return {
    text,
    image,
    vision,
    tts: tts ?? undefined,
    mockImage: false,
  };
}
