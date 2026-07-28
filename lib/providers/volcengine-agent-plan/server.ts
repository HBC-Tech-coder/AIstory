import "server-only";

import { getProviderDescriptor } from "@/lib/providers/registry";

import type {
  VolcengineAgentPlanConfig,
  VolcengineAgentPlanStatus,
} from "./types";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const SECRET_REF = "VOLCENGINE_AGENT_PLAN_API_KEY" as const;
const CLOUD_CHOICES = new Set(["bailian", "volcengine-agent-plan"]);

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function timeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000
    ? Math.round(parsed)
    : 15_000;
}

function cloudRoute(
  value: string | undefined,
  fallback: "bailian" | "volcengine-agent-plan",
): "bailian" | "volcengine-agent-plan" {
  const normalized = value?.trim().toLowerCase();
  return normalized && CLOUD_CHOICES.has(normalized)
    ? (normalized as "bailian" | "volcengine-agent-plan")
    : fallback;
}

export function getVolcengineAgentPlanConfig(
  env: NodeJS.ProcessEnv = process.env,
): VolcengineAgentPlanConfig {
  return {
    enabled: enabled(env.VOLCENGINE_AGENT_PLAN_ENABLED),
    baseUrl: env.VOLCENGINE_AGENT_PLAN_BASE_URL?.trim() || DEFAULT_BASE_URL,
    videoModel: env.VOLCENGINE_AGENT_PLAN_VIDEO_MODEL?.trim() || "",
    apiKeyEnvName: SECRET_REF,
    credentialConfigured: Boolean(env[SECRET_REF]?.trim()),
    networkEnabled: false,
    timeoutMs: timeout(env.VOLCENGINE_AGENT_PLAN_TIMEOUT_MS),
  };
}

export function validateVolcengineAgentPlanConfig(
  config: VolcengineAgentPlanConfig,
): string[] {
  const issues: string[] = [];
  let base: URL | undefined;
  try {
    base = new URL(config.baseUrl);
  } catch {
    issues.push("baseUrl must be a valid URL");
  }
  if (
    base &&
    (base.protocol !== "https:" ||
      base.hostname !== "ark.cn-beijing.volces.com" ||
      !/^\/api\/plan\/v3\/?$/.test(base.pathname))
  ) {
    issues.push("baseUrl must use the official Agent Plan HTTPS v3 endpoint");
  }
  if (config.enabled && !config.credentialConfigured) {
    issues.push(`${SECRET_REF} is not configured`);
  }
  if (config.enabled && !config.videoModel) {
    issues.push("VOLCENGINE_AGENT_PLAN_VIDEO_MODEL is not configured");
  }
  return issues;
}

export function getVolcengineAgentPlanVideoEndpoints(
  config: VolcengineAgentPlanConfig,
  providerTaskId?: string,
): { collection: string; task?: string } {
  const issues = validateVolcengineAgentPlanConfig({
    ...config,
    enabled: false,
  });
  if (issues.length > 0) throw new Error(issues.join("; "));
  const collection = `${config.baseUrl.replace(/\/$/, "")}/contents/generations/tasks`;
  if (!providerTaskId) return { collection };
  if (!/^cgt-[a-z0-9-]{6,96}$/i.test(providerTaskId)) {
    throw new Error("Invalid Volcengine provider task id.");
  }
  return { collection, task: `${collection}/${providerTaskId}` };
}

export function discoverVolcengineAgentPlanStatus(
  env: NodeJS.ProcessEnv = process.env,
): VolcengineAgentPlanStatus {
  const config = getVolcengineAgentPlanConfig(env);
  const issues = validateVolcengineAgentPlanConfig(config);
  const descriptor = getProviderDescriptor("volcengine-agent-plan");
  const invalidRoute = [
    env.AISTORY_TEXT_PRODUCT_PROVIDER,
    env.AISTORY_IMAGE_PRODUCT_PROVIDER,
    env.AISTORY_TTS_PRODUCT_PROVIDER,
  ].some(
    (value) => value && !CLOUD_CHOICES.has(value.trim().toLowerCase()),
  );
  if (invalidRoute) issues.push("one or more modality provider routes are invalid");

  const state: VolcengineAgentPlanStatus["state"] = !config.enabled
    ? "disabled"
    : issues.some((issue) => issue.includes("baseUrl") || issue.includes("routes"))
      ? "invalid_config"
      : issues.length > 0
        ? "not_configured"
        : "contract_ready";
  const configured = state === "contract_ready";
  return {
    provider: "volcengine-agent-plan",
    enabled: config.enabled,
    configured,
    available: false,
    state,
    credential: {
      configured: config.credentialConfigured,
      secretRef: SECRET_REF,
    },
    baseUrl: config.baseUrl,
    videoModelConfigured: Boolean(config.videoModel),
    networkEnabled: false,
    capabilities: descriptor.capabilities,
    routing: {
      text: cloudRoute(env.AISTORY_TEXT_PRODUCT_PROVIDER, "bailian"),
      image: cloudRoute(env.AISTORY_IMAGE_PRODUCT_PROVIDER, "bailian"),
      tts: cloudRoute(env.AISTORY_TTS_PRODUCT_PROVIDER, "bailian"),
      video: "volcengine-agent-plan",
      automaticFallback: false,
    },
    message:
      state === "disabled"
        ? "火山 Agent Plan 未启用；未发送任何网络请求。"
        : state === "not_configured"
          ? "火山 Agent Plan 缺少服务端凭据引用或视频模型配置。"
          : state === "invalid_config"
            ? "火山 Agent Plan 配置未通过安全校验。"
            : "异步视频契约已配置；P1 生产网络 transport 仍关闭，未执行付费请求。",
    checkedAt: new Date().toISOString(),
  };
}
