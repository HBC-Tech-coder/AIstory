import { isLoopbackServiceUrl } from "@/lib/creator-studio/capabilities";
import type {
  ComfyUIControlNetConfig,
  ComfyUILoRAConfig,
  ComfyUIModality,
  ComfyUINodeInputBinding,
  ComfyUIProviderConfig,
  ComfyUIValidationIssue,
  ComfyUIValidationResult,
  ComfyUIWorkflowConfig,
  ComfyUIWorkflowDocument,
  ComfyUIWorkflowRequest,
} from "./types";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MODALITIES: readonly ComfyUIModality[] = ["image", "video"];

function issue(issues: ComfyUIValidationIssue[], path: string, message: string) {
  issues.push({ path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeWorkflowIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !/^\\\\/.test(value) &&
    !/^\//.test(value) &&
    !/(^|[\\/])\.\.([\\/]|$)/.test(value)
  );
}

function validateBinding(
  binding: ComfyUINodeInputBinding | undefined,
  path: string,
  workflow: ComfyUIWorkflowDocument,
  issues: ComfyUIValidationIssue[],
) {
  if (!binding) return;
  const boundNode = workflow[binding.nodeId];
  if (!binding.nodeId || !boundNode) {
    issue(issues, `${path}.nodeId`, "绑定的节点不存在于 workflow。");
  }
  if (!binding.input?.trim()) {
    issue(issues, `${path}.input`, "输入字段名不能为空。");
  } else if (
    boundNode &&
    (!isRecord(boundNode.inputs) ||
      !Object.prototype.hasOwnProperty.call(boundNode.inputs, binding.input))
  ) {
    issue(issues, `${path}.input`, "绑定的节点输入不存在。");
  }
}

function validateWeights(
  loras: ComfyUILoRAConfig[] | undefined,
  controlNets: ComfyUIControlNetConfig[] | undefined,
  issues: ComfyUIValidationIssue[],
) {
  loras?.forEach((lora, index) => {
    if (!lora.name?.trim()) issue(issues, `loras.${index}.name`, "LoRA 名称不能为空。");
    if (!Number.isFinite(lora.modelWeight) || Math.abs(lora.modelWeight) > 4) {
      issue(issues, `loras.${index}.modelWeight`, "LoRA modelWeight 必须在 -4 到 4 之间。");
    }
    if (
      lora.clipWeight !== undefined &&
      (!Number.isFinite(lora.clipWeight) || Math.abs(lora.clipWeight) > 4)
    ) {
      issue(issues, `loras.${index}.clipWeight`, "LoRA clipWeight 必须在 -4 到 4 之间。");
    }
  });
  controlNets?.forEach((control, index) => {
    if (!control.model?.trim()) {
      issue(issues, `controlNets.${index}.model`, "ControlNet 模型名称不能为空。");
    }
    if (!Number.isFinite(control.strength) || control.strength < 0 || control.strength > 2) {
      issue(issues, `controlNets.${index}.strength`, "ControlNet strength 必须在 0 到 2 之间。");
    }
    const start = control.startPercent ?? 0;
    const end = control.endPercent ?? 1;
    if (start < 0 || start > 1 || end < 0 || end > 1 || start > end) {
      issue(issues, `controlNets.${index}`, "ControlNet 起止百分比必须满足 0 ≤ start ≤ end ≤ 1。");
    }
  });
}

function validateWorkflow(
  modality: ComfyUIModality,
  config: ComfyUIWorkflowConfig,
  issues: ComfyUIValidationIssue[],
): number {
  const path = `workflows.${modality}`;
  const workflow = config?.workflow;
  if (!isRecord(workflow) || Object.keys(workflow).length === 0) {
    issue(issues, `${path}.workflow`, "workflow 必须是非空的 ComfyUI API JSON 对象。");
    return 0;
  }

  try {
    if (Buffer.byteLength(JSON.stringify(workflow), "utf8") > MAX_WORKFLOW_BYTES) {
      issue(issues, `${path}.workflow`, "workflow JSON 不能超过 2 MB。");
    }
  } catch {
    issue(issues, `${path}.workflow`, "workflow JSON 无法序列化。");
  }

  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (
      nodeId === "__proto__" ||
      nodeId === "prototype" ||
      nodeId === "constructor" ||
      !isSafeWorkflowIdentifier(nodeId)
    ) {
      issue(issues, `${path}.workflow.${nodeId}`, "不允许危险节点标识。");
      continue;
    }
    if (!isRecord(rawNode)) {
      issue(issues, `${path}.workflow.${nodeId}`, "节点必须是对象。");
      continue;
    }
    if (!isSafeWorkflowIdentifier(rawNode.class_type)) {
      issue(issues, `${path}.workflow.${nodeId}.class_type`, "节点缺少 class_type。");
    }
    if (!isRecord(rawNode.inputs)) {
      issue(issues, `${path}.workflow.${nodeId}.inputs`, "节点 inputs 必须是对象。");
      continue;
    }
    for (const value of Object.values(rawNode.inputs)) {
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string" &&
        Number.isInteger(value[1]) &&
        !workflow[value[0]]
      ) {
        issue(
          issues,
          `${path}.workflow.${nodeId}.inputs`,
          `节点引用 ${value[0]} 不存在。`,
        );
      }
    }
  }

  if (!Array.isArray(config.outputNodeIds) || config.outputNodeIds.length === 0) {
    issue(issues, `${path}.outputNodeIds`, "至少声明一个输出节点。");
  } else {
    config.outputNodeIds.forEach((nodeId, index) => {
      if (!isSafeWorkflowIdentifier(nodeId) || !workflow[nodeId]) {
        issue(issues, `${path}.outputNodeIds.${index}`, "输出节点不存在于 workflow。");
      }
    });
  }

  const bindings = config.bindings;
  if (bindings) {
    validateBinding(bindings.positivePrompt, `${path}.bindings.positivePrompt`, workflow, issues);
    validateBinding(bindings.negativePrompt, `${path}.bindings.negativePrompt`, workflow, issues);
    validateBinding(bindings.checkpoint, `${path}.bindings.checkpoint`, workflow, issues);
    validateBinding(bindings.faceReference, `${path}.bindings.faceReference`, workflow, issues);
    validateBinding(bindings.seed, `${path}.bindings.seed`, workflow, issues);
    validateBinding(bindings.width, `${path}.bindings.width`, workflow, issues);
    validateBinding(bindings.height, `${path}.bindings.height`, workflow, issues);
    bindings.loras?.forEach((binding, index) => {
      validateBinding(binding.name, `${path}.bindings.loras.${index}.name`, workflow, issues);
      validateBinding(binding.modelWeight, `${path}.bindings.loras.${index}.modelWeight`, workflow, issues);
      validateBinding(binding.clipWeight, `${path}.bindings.loras.${index}.clipWeight`, workflow, issues);
    });
    bindings.controlNets?.forEach((binding, index) => {
      validateBinding(binding.model, `${path}.bindings.controlNets.${index}.model`, workflow, issues);
      validateBinding(binding.strength, `${path}.bindings.controlNets.${index}.strength`, workflow, issues);
      validateBinding(binding.startPercent, `${path}.bindings.controlNets.${index}.startPercent`, workflow, issues);
      validateBinding(binding.endPercent, `${path}.bindings.controlNets.${index}.endPercent`, workflow, issues);
      validateBinding(binding.referenceImage, `${path}.bindings.controlNets.${index}.referenceImage`, workflow, issues);
    });
    bindings.videoNodes?.forEach((binding, index) =>
      validateBinding(binding, `${path}.bindings.videoNodes.${index}`, workflow, issues),
    );
    Object.entries(bindings.referenceImages ?? {}).forEach(([slot, binding]) =>
      validateBinding(binding, `${path}.bindings.referenceImages.${slot}`, workflow, issues),
    );
  }
  return Object.keys(workflow).length;
}

export function validateComfyUIProviderConfig(
  value: unknown,
): ComfyUIValidationResult {
  const issues: ComfyUIValidationIssue[] = [];
  const config = (isRecord(value) ? value : {}) as Partial<ComfyUIProviderConfig>;
  const enabled = config.enabled === true;
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";

  if (!isLoopbackServiceUrl(baseUrl)) {
    issue(
      issues,
      "baseUrl",
      "P1 仅允许 localhost / 127.0.0.1 / ::1 的 HTTP(S) ComfyUI 地址。",
    );
  }

  validateWeights(config.loras, config.controlNets, issues);
  const modalities: ComfyUIModality[] = [];
  const workflowNodeCounts: Partial<Record<ComfyUIModality, number>> = {};
  for (const modality of MODALITIES) {
    const workflow = config.workflows?.[modality];
    if (!workflow) continue;
    modalities.push(modality);
    workflowNodeCounts[modality] = validateWorkflow(modality, workflow, issues);
  }

  const configuredWorkflows = MODALITIES.map(
    (modality) => config.workflows?.[modality],
  ).filter((workflow): workflow is ComfyUIWorkflowConfig => Boolean(workflow));
  if (
    config.checkpoint?.trim() &&
    !configuredWorkflows.some((workflow) => workflow.bindings?.checkpoint)
  ) {
    issue(issues, "checkpoint", "配置默认 checkpoint 时必须声明 checkpoint binding。");
  }
  if (
    (config.loras?.length ?? 0) > 0 &&
    !configuredWorkflows.some(
      (workflow) =>
        (workflow.bindings?.loras?.length ?? 0) >= (config.loras?.length ?? 0),
    )
  ) {
    issue(issues, "loras", "每个可配置 LoRA 必须有对应 workflow binding。");
  }
  if (
    (config.controlNets?.length ?? 0) > 0 &&
    !configuredWorkflows.some(
      (workflow) =>
        (workflow.bindings?.controlNets?.length ?? 0) >=
        (config.controlNets?.length ?? 0),
    )
  ) {
    issue(issues, "controlNets", "每个可配置 ControlNet 必须有对应 workflow binding。");
  }
  if (
    config.faceContinuity?.enabled &&
    !configuredWorkflows.some((workflow) => workflow.bindings?.faceReference)
  ) {
    issue(issues, "faceContinuity", "启用人脸连续性时必须声明 faceReference binding。");
  }

  if (enabled && modalities.length === 0) {
    issue(issues, "workflows", "启用 ComfyUI 时至少配置 image 或 video workflow。");
  }
  if (config.timeoutMs !== undefined) {
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 300_000) {
      issue(issues, "timeoutMs", "timeoutMs 必须在 1000 到 300000 之间。");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      enabled,
      loopbackOnly: true,
      modalities,
      workflowNodeCounts,
    },
  };
}

export function validateComfyUIBaseProviderConfig(
  value: unknown,
): { ok: boolean; issues: ComfyUIValidationIssue[] } {
  const issues: ComfyUIValidationIssue[] = [];
  const config = (isRecord(value) ? value : {}) as Partial<ComfyUIProviderConfig>;
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
  if (!isLoopbackServiceUrl(baseUrl)) {
    issue(
      issues,
      "baseUrl",
      "P1 仅允许 localhost / 127.0.0.1 / ::1 的 HTTP(S) ComfyUI 地址。",
    );
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) ||
      config.timeoutMs < 1_000 ||
      config.timeoutMs > 300_000)
  ) {
    issue(issues, "timeoutMs", "timeoutMs 必须在 1000 到 300000 之间。");
  }
  return { ok: issues.length === 0, issues };
}

export function validateComfyUIWorkflowRequest(
  value: unknown,
): { ok: boolean; issues: ComfyUIValidationIssue[] } {
  const issues: ComfyUIValidationIssue[] = [];
  const request = (isRecord(value) ? value : {}) as Partial<ComfyUIWorkflowRequest> & {
    purpose?: unknown;
  };
  if (request.purpose !== "foreground") {
    issue(
      issues,
      "purpose",
      "ComfyUI P1 只接受 foreground；speculative prefetch（包括 0 层关闭时）不可提交。",
    );
  }
  if (request.modality !== "image" && request.modality !== "video") {
    issue(issues, "modality", "modality 必须是 image 或 video。");
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    issue(issues, "prompt", "prompt 不能为空。");
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim().length < 8) {
    issue(issues, "idempotencyKey", "必须提供至少 8 个字符的幂等键。");
  }
  if (
    request.seed !== undefined &&
    (!Number.isSafeInteger(request.seed) || request.seed < 0)
  ) {
    issue(issues, "seed", "seed 必须是非负安全整数。");
  }
  for (const dimension of ["width", "height"] as const) {
    const value = request[dimension];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 64 || value > 8192)
    ) {
      issue(issues, dimension, `${dimension} 必须是 64 到 8192 的整数。`);
    }
  }
  return { ok: issues.length === 0, issues };
}
