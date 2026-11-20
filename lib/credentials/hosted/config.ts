import "server-only";

import type { CredentialModality } from "@/lib/credentials/types";
import type {
  HostedCredentialFeatureCode,
  HostedCredentialFeatureStatus,
  HostedCredentialProvider,
} from "./types";
import { inspectProductionDatabaseGate } from "@/lib/production/databaseGate";

const PROVIDERS = new Set<HostedCredentialProvider>([
  "openai",
  "openai_compatible",
  "dashscope",
  "runware",
  "stepfun",
]);
const CAPABILITIES = new Set<CredentialModality>([
  "text",
  "image",
  "vision",
  "tts",
  "video",
]);
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type HostedCredentialProviderRule = {
  provider: HostedCredentialProvider;
  capabilities: CredentialModality[];
  baseUrlOrigins: string[];
  models: string[];
};

export type HostedCredentialKeyRing = {
  activeVersion: string;
  keys: ReadonlyMap<string, Buffer>;
};

export type HostedCredentialConfig = {
  keyRing: HostedCredentialKeyRing;
  providerRules: HostedCredentialProviderRule[];
  stepUpMaxAgeMs: number;
};

export class HostedCredentialUnavailableError extends Error {
  readonly code: HostedCredentialFeatureCode;
  readonly status: 401 | 403 | 409 | 503;

  constructor(
    code: HostedCredentialFeatureCode,
    status: 401 | 403 | 409 | 503 = 503,
  ) {
    super("托管凭据当前不可用，请继续使用仅此浏览器模式。");
    this.name = "HostedCredentialUnavailableError";
    this.code = code;
    this.status = status;
  }
}

type HostedCredentialEnvironment = NodeJS.ProcessEnv;
const SMS_TEMPLATE_CODE = /^SMS_[A-Za-z0-9]{4,64}$/;

function parseOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function parseProviderRules(raw: string | undefined): HostedCredentialProviderRule[] {
  if (!raw?.trim()) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
      return [];
    }
    const rules = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const source = item as Record<string, unknown>;
      const provider = source.provider;
      if (typeof provider !== "string" || !PROVIDERS.has(provider as HostedCredentialProvider)) {
        return [];
      }
      const capabilities = Array.isArray(source.capabilities)
        ? source.capabilities.filter(
            (capability): capability is CredentialModality =>
              typeof capability === "string"
              && CAPABILITIES.has(capability as CredentialModality),
          )
        : [];
      const baseUrlOrigins = Array.isArray(source.baseUrlOrigins)
        ? source.baseUrlOrigins.map(parseOrigin).filter((origin): origin is string => !!origin)
        : [];
      const models = Array.isArray(source.models)
        ? source.models.filter(
            (model): model is string => typeof model === "string" && SAFE_MODEL.test(model),
          )
        : [];
      if (
        capabilities.length === 0
        || baseUrlOrigins.length === 0
        || models.length === 0
        || capabilities.length !== new Set(capabilities).size
        || baseUrlOrigins.length !== new Set(baseUrlOrigins).size
        || models.length !== new Set(models).size
      ) return [];
      return [{
        provider: provider as HostedCredentialProvider,
        capabilities,
        baseUrlOrigins,
        models,
      }];
    });
    return rules.length === value.length ? rules : [];
  } catch {
    return [];
  }
}

function parseKeyRing(
  activeVersion: string | undefined,
  raw: string | undefined,
): HostedCredentialKeyRing | undefined {
  const active = activeVersion?.trim() || "";
  if (!SAFE_VERSION.test(active) || !raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 8) return undefined;
    const keys = new Map<string, Buffer>();
    for (const [version, encoded] of entries) {
      if (!SAFE_VERSION.test(version) || typeof encoded !== "string") return undefined;
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32 || key.toString("base64") !== encoded) return undefined;
      keys.set(version, key);
    }
    if (!keys.has(active)) return undefined;
    return { activeVersion: active, keys };
  } catch {
    return undefined;
  }
}

function parseStepUpMs(raw: string | undefined): number {
  const seconds = Number(raw || 300);
  return Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 900
    ? seconds * 1000
    : 300_000;
}

function hasUsableAliyunSmsConfig(env: HostedCredentialEnvironment): boolean {
  return env.AISTORY_SMS_PROVIDER === "aliyun_dysms"
    && !!env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim()
    && !!env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim()
    && !!env.ALIYUN_SMS_SIGN_NAME?.trim()
    && SMS_TEMPLATE_CODE.test(env.ALIYUN_SMS_TEMPLATE_CODE_LOGIN?.trim() || "");
}

export function inspectHostedCredentialFeature(
  env: HostedCredentialEnvironment = process.env,
): HostedCredentialFeatureStatus {
  let code: HostedCredentialFeatureCode = "ready";
  if (env.AISTORY_HOSTED_BYOK_ENABLED !== "true") code = "disabled";
  else if (!inspectProductionDatabaseGate(
    env as Parameters<typeof inspectProductionDatabaseGate>[0],
  ).ready) code = "identity_gate_unavailable";
  else if (env.AISTORY_HOSTED_BYOK_REPOSITORY !== "supabase") code = "repository_unavailable";
  else if (!parseKeyRing(
    env.AISTORY_HOSTED_BYOK_ACTIVE_KEK_VERSION,
    env.AISTORY_HOSTED_BYOK_KEK_RING_JSON,
  )) code = "encryption_unavailable";
  else if (parseProviderRules(env.AISTORY_HOSTED_BYOK_PROVIDER_ALLOWLIST_JSON).length === 0) {
    code = "provider_allowlist_unavailable";
  } else if (
    env.AISTORY_HOSTED_BYOK_STEP_UP_ENABLED !== "true"
    || !hasUsableAliyunSmsConfig(env)
  ) code = "step_up_unavailable";
  return {
    enabled: code === "ready",
    writable: code === "ready",
    code,
    requiresPhoneLogin: true,
    requiresRecentVerification: true,
  };
}

export function readHostedCredentialConfig(
  env: HostedCredentialEnvironment = process.env,
): HostedCredentialConfig {
  const status = inspectHostedCredentialFeature(env);
  if (!status.enabled) throw new HostedCredentialUnavailableError(status.code);
  const keyRing = parseKeyRing(
    env.AISTORY_HOSTED_BYOK_ACTIVE_KEK_VERSION,
    env.AISTORY_HOSTED_BYOK_KEK_RING_JSON,
  );
  const providerRules = parseProviderRules(
    env.AISTORY_HOSTED_BYOK_PROVIDER_ALLOWLIST_JSON,
  );
  if (!keyRing) throw new HostedCredentialUnavailableError("encryption_unavailable");
  if (providerRules.length === 0) {
    throw new HostedCredentialUnavailableError("provider_allowlist_unavailable");
  }
  return {
    keyRing,
    providerRules,
    stepUpMaxAgeMs: parseStepUpMs(env.AISTORY_HOSTED_BYOK_STEP_UP_MAX_AGE_SECONDS),
  };
}

export function findHostedCredentialRule(
  config: HostedCredentialConfig,
  provider: HostedCredentialProvider,
): HostedCredentialProviderRule {
  const rule = config.providerRules.find((item) => item.provider === provider);
  if (!rule) throw new HostedCredentialUnavailableError("provider_allowlist_unavailable", 403);
  return rule;
}

export function isAllowedHostedCredentialTarget(
  rule: HostedCredentialProviderRule,
  baseUrl: string,
  model: string,
): boolean {
  try {
    const target = new URL(baseUrl);
    return target.protocol === "https:"
      && !target.username
      && !target.password
      && !target.search
      && !target.hash
      && rule.baseUrlOrigins.includes(target.origin)
      && rule.models.includes(model);
  } catch {
    return false;
  }
}
