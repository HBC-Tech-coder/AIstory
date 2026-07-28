import "server-only";

import { createHash } from "crypto";

import type {
  ComfyUIModality,
  ComfyUIProviderConfig,
  ComfyUIProviderStatus,
  ComfyUIQueuedJob,
  ComfyUIWorkflowConfig,
  ComfyUIWorkflowDocument,
  ComfyUIWorkflowRequest,
} from "./types";
import {
  validateComfyUIBaseProviderConfig,
  validateComfyUIProviderConfig,
  validateComfyUIWorkflowRequest,
} from "./validation";
import {
  getComfyUIWorkflowTemplate,
  listComfyUIWorkflowTemplates,
} from "./registry";
import { requestComfyUI } from "./transport";

const DEFAULT_BASE_URL = "http://127.0.0.1:8188";

function readWorkflowJson(value: string | undefined): ComfyUIWorkflowConfig | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as {
      workflow?: ComfyUIWorkflowDocument;
      outputNodeIds?: string[];
      bindings?: ComfyUIWorkflowConfig["bindings"];
    };
    if (parsed.workflow && Array.isArray(parsed.outputNodeIds)) {
      return {
        workflow: parsed.workflow,
        outputNodeIds: parsed.outputNodeIds,
        bindings: parsed.bindings,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getComfyUIProviderConfig(): ComfyUIProviderConfig {
  return {
    enabled: process.env.COMFYUI_ENABLED === "true",
    baseUrl: process.env.COMFYUI_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL,
    checkpoint: process.env.COMFYUI_CHECKPOINT || undefined,
    workflows: {
      image: readWorkflowJson(process.env.COMFYUI_IMAGE_WORKFLOW_JSON),
      video: readWorkflowJson(process.env.COMFYUI_VIDEO_WORKFLOW_JSON),
    },
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS) || 5_000,
  };
}

function statusBase(
  config: ComfyUIProviderConfig,
  state: ComfyUIProviderStatus["state"],
  message: string,
  registryTemplates: Awaited<ReturnType<typeof listComfyUIWorkflowTemplates>> = [],
): ComfyUIProviderStatus {
  const active = registryTemplates.filter((template) => template.enabled);
  const imageTemplates = active.filter((template) => template.modality === "image");
  const videoTemplates = active.filter((template) => template.modality === "video");
  const image = Boolean(config.workflows?.image) || imageTemplates.length > 0;
  const video = Boolean(config.workflows?.video) || videoTemplates.length > 0;
  return {
    provider: "comfyui",
    enabled: config.enabled,
    configured: image || video,
    available: state === "ready",
    state,
    baseUrl: config.baseUrl,
    modalities: { image, video },
    workflowNodeCounts: {
      image: config.workflows?.image
        ? Object.keys(config.workflows.image.workflow).length
        : imageTemplates.reduce((sum, item) => sum + item.nodeCount, 0) || undefined,
      video: config.workflows?.video
        ? Object.keys(config.workflows.video.workflow).length
        : videoTemplates.reduce((sum, item) => sum + item.nodeCount, 0) || undefined,
    },
    activeTemplateCounts: {
      image: imageTemplates.length,
      video: videoTemplates.length,
    },
    message,
    checkedAt: new Date().toISOString(),
  };
}

export async function discoverComfyUIProviderStatus(
  fetcher: typeof fetch = fetch,
): Promise<ComfyUIProviderStatus> {
  const config = getComfyUIProviderConfig();
  const registryTemplates = await listComfyUIWorkflowTemplates().catch(() => []);
  if (!config.enabled) {
    return statusBase(
      config,
      "disabled",
      "ComfyUI 本地 provider 未启用。",
      registryTemplates,
    );
  }
  const baseValidation = validateComfyUIBaseProviderConfig(config);
  if (!baseValidation.ok) {
    return statusBase(
      config,
      "invalid_config",
      "ComfyUI 基础配置无效，已 fail-closed。",
      registryTemplates,
    );
  }
  const hasRegistryTemplate = registryTemplates.some((item) => item.enabled);
  const hasEnvWorkflow = Boolean(config.workflows?.image || config.workflows?.video);
  if (!hasRegistryTemplate && !hasEnvWorkflow) {
    return statusBase(
      config,
      "not_configured",
      "ComfyUI 已启用，但尚无已启用 workflow 模板。",
      registryTemplates,
    );
  }
  if (!hasRegistryTemplate && !validateComfyUIProviderConfig(config).ok) {
    return statusBase(
      config,
      "invalid_config",
      "ComfyUI 环境 workflow 配置无效，已 fail-closed。",
      registryTemplates,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 5_000);
  try {
    const [statsResponse, objectInfoResponse] = await Promise.all([
      fetcher(`${config.baseUrl}/system_stats`, {
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }),
      fetcher(`${config.baseUrl}/object_info`, {
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }),
    ]);
    if (!statsResponse.ok || !objectInfoResponse.ok) {
      return statusBase(
        config,
        "offline",
        `ComfyUI 能力探测失败（HTTP ${statsResponse.status}/${objectInfoResponse.status}）。`,
        registryTemplates,
      );
    }
    const objectInfo = (await objectInfoResponse.json()) as Record<string, unknown>;
    const stats = (await statsResponse.json()) as {
      queue_remaining?: number;
      exec_info?: { queue_remaining?: number };
    };
    return {
      ...statusBase(
        config,
        "ready",
        "ComfyUI 已连接，已启用 workflow 模板可用。",
        registryTemplates,
      ),
      objectTypeCount: Object.keys(objectInfo ?? {}).length,
      queueRemaining: stats.exec_info?.queue_remaining ?? stats.queue_remaining,
    };
  } catch {
    return statusBase(
      config,
      "offline",
      "ComfyUI 未连接；不会提交任何生成请求。",
      registryTemplates,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function cloneWorkflow(workflow: ComfyUIWorkflowDocument): ComfyUIWorkflowDocument {
  return structuredClone(workflow);
}

function setBoundInput(
  workflow: ComfyUIWorkflowDocument,
  binding: { nodeId: string; input: string } | undefined,
  value: unknown,
) {
  if (!binding || value === undefined) return;
  const node = workflow[binding.nodeId];
  if (!node) throw new Error(`ComfyUI binding node not found: ${binding.nodeId}`);
  node.inputs[binding.input] = value;
}

function buildWorkflow(
  workflowConfig: ComfyUIWorkflowConfig,
  request: ComfyUIWorkflowRequest,
  providerConfig: ComfyUIProviderConfig,
): ComfyUIWorkflowDocument {
  const workflow = cloneWorkflow(workflowConfig.workflow);
  const bindings = workflowConfig.bindings;
  setBoundInput(workflow, bindings?.positivePrompt, request.prompt);
  setBoundInput(workflow, bindings?.negativePrompt, request.negativePrompt);
  setBoundInput(
    workflow,
    bindings?.checkpoint,
    request.checkpoint ?? providerConfig.checkpoint,
  );
  providerConfig.loras?.forEach((lora, index) => {
    const binding = bindings?.loras?.[index];
    setBoundInput(workflow, binding?.name, lora.name);
    setBoundInput(workflow, binding?.modelWeight, lora.modelWeight);
    setBoundInput(
      workflow,
      binding?.clipWeight,
      lora.clipWeight ?? lora.modelWeight,
    );
  });
  providerConfig.controlNets?.forEach((control, index) => {
    const binding = bindings?.controlNets?.[index];
    setBoundInput(workflow, binding?.model, control.model);
    setBoundInput(workflow, binding?.strength, control.strength);
    setBoundInput(workflow, binding?.startPercent, control.startPercent ?? 0);
    setBoundInput(workflow, binding?.endPercent, control.endPercent ?? 1);
    setBoundInput(
      workflow,
      binding?.referenceImage,
      control.referenceSlot
        ? request.referenceImages?.[control.referenceSlot]
        : undefined,
    );
  });
  for (const [slot, image] of Object.entries(request.referenceImages ?? {})) {
    setBoundInput(workflow, bindings?.referenceImages?.[slot], image);
  }
  setBoundInput(workflow, bindings?.faceReference, request.faceReference);
  setBoundInput(workflow, bindings?.seed, request.seed);
  setBoundInput(workflow, bindings?.width, request.width);
  setBoundInput(workflow, bindings?.height, request.height);
  return workflow;
}

const inFlightSubmissions = new Map<string, Promise<ComfyUIQueuedJob>>();

function requestFingerprint(
  modality: ComfyUIModality,
  workflow: ComfyUIWorkflowDocument,
  idempotencyKey: string,
  variant: Record<string, unknown> = {},
): string {
  return createHash("sha256")
    .update(JSON.stringify({ modality, workflow, idempotencyKey, ...variant }))
    .digest("hex");
}

async function queueWithConfig(
  request: ComfyUIWorkflowRequest,
  config: ComfyUIProviderConfig,
  workflowConfig: ComfyUIWorkflowConfig,
  fetcher: typeof fetch,
  registry?: { id: string; version: number },
): Promise<ComfyUIQueuedJob> {
  const workflow = buildWorkflow(workflowConfig, request, config);
  const fingerprint = requestFingerprint(
    request.modality,
    workflow,
    request.idempotencyKey,
    {
      workflowId: registry?.id,
      workflowVersion: registry?.version,
      orientation: request.orientation,
      visualStyleRevision: request.visualStyleRevision,
      characterStateRevision: request.characterStateRevision,
      referenceRevision: request.referenceRevision,
    },
  );
  const existing = inFlightSubmissions.get(fingerprint);
  if (existing) return existing;

  const submission = (async (): Promise<ComfyUIQueuedJob> => {
    const response = await requestComfyUI(config, "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: `aistory-${fingerprint.slice(0, 24)}`,
        extra_data: {
          aistory: {
            modality: request.modality,
            requestFingerprint: fingerprint,
            purpose: "foreground",
            workflowId: registry?.id,
            workflowVersion: registry?.version,
          },
        },
      }),
    }, fetcher, { retryMode: "rate_limit_only" });
    if (!response.ok) {
      throw new Error(`ComfyUI queue rejected: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { prompt_id?: string };
    if (!payload.prompt_id) throw new Error("ComfyUI 未返回 prompt_id。");
    return {
      provider: "comfyui",
      modality: request.modality,
      promptId: payload.prompt_id,
      requestFingerprint: fingerprint,
      workflowId: registry?.id,
      workflowVersion: registry?.version,
      status: "queued",
    };
  })();
  inFlightSubmissions.set(fingerprint, submission);
  try {
    return await submission;
  } finally {
    if (inFlightSubmissions.get(fingerprint) === submission) {
      inFlightSubmissions.delete(fingerprint);
    }
  }
}

export async function queueComfyUIWorkflow(
  request: ComfyUIWorkflowRequest,
  fetcher: typeof fetch = fetch,
): Promise<ComfyUIQueuedJob> {
  const requestValidation = validateComfyUIWorkflowRequest(request);
  if (!requestValidation.ok) {
    throw new Error(requestValidation.issues.map((item) => item.message).join(" "));
  }
  const config = getComfyUIProviderConfig();
  const configValidation = validateComfyUIProviderConfig(config);
  const workflowConfig = config.workflows?.[request.modality];
  if (!config.enabled || !configValidation.ok || !workflowConfig) {
    throw new Error("ComfyUI provider 未启用或未配置对应 workflow。");
  }

  return queueWithConfig(request, config, workflowConfig, fetcher);
}

export async function queueRegisteredComfyUIWorkflow(
  workflowId: string,
  request: ComfyUIWorkflowRequest,
  fetcher: typeof fetch = fetch,
): Promise<ComfyUIQueuedJob> {
  const requestValidation = validateComfyUIWorkflowRequest(request);
  if (!requestValidation.ok) {
    throw new Error(requestValidation.issues.map((item) => item.message).join(" "));
  }
  const registered = await getComfyUIWorkflowTemplate(workflowId);
  if (!registered || registered.template.modality !== request.modality) {
    throw new Error("ComfyUI workflow template is unavailable for this modality.");
  }
  const base = getComfyUIProviderConfig();
  const config: ComfyUIProviderConfig = {
    ...base,
    checkpoint: registered.version.checkpoint,
    loras: registered.version.loras,
    controlNets: registered.version.controlNets,
    faceContinuity: registered.version.faceContinuity,
    workflows: { [request.modality]: registered.version.workflow },
  };
  const configValidation = validateComfyUIProviderConfig(config);
  if (!config.enabled || !configValidation.ok) {
    throw new Error("ComfyUI provider 未启用或注册 workflow 配置无效。");
  }
  return queueWithConfig(
    request,
    config,
    registered.version.workflow,
    fetcher,
    { id: registered.template.id, version: registered.version.version },
  );
}
