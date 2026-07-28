import type {
  ComfyUIGenerationJobInput,
  GenerationJob,
  LocalMiniDramaImageJobInput,
} from "./types";

export type StudioGenerationEngine = "comfyui" | "localminidrama";

export type StudioGenerationRequest =
  | { provider: "comfyui"; input: ComfyUIGenerationJobInput }
  | { provider: "localminidrama"; input: LocalMiniDramaImageJobInput };

export type StudioGenerationRequestOptions = {
  engine: StudioGenerationEngine;
  projectId: number | null;
  workflowId: string;
  prompt: string;
  negativePrompt?: string;
  orientation: "landscape" | "portrait";
  localMiniDramaStyle?: string;
  uploadedReference?: string;
  referenceRevision?: string;
  idempotencyKey: string;
};

function normalizedText(value: string | undefined): string | undefined {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || undefined;
}

export function buildStudioGenerationRequest(
  options: StudioGenerationRequestOptions,
): StudioGenerationRequest {
  const prompt = normalizedText(options.prompt);
  if (!prompt) throw new Error("图片描述不能为空。");
  const negativePrompt = normalizedText(options.negativePrompt);

  if (options.engine === "localminidrama") {
    if (
      !Number.isSafeInteger(options.projectId) ||
      Number(options.projectId) <= 0
    ) {
      throw new Error("请先选择 LocalMiniDrama 项目。");
    }
    const portrait = options.orientation === "portrait";
    return {
      provider: "localminidrama",
      input: {
        dramaId: Number(options.projectId),
        prompt,
        negativePrompt,
        frameType: "storyboard",
        size: portrait ? "768x1344" : "1344x768",
        aspectRatio: portrait ? "9:16" : "16:9",
        style: normalizedText(options.localMiniDramaStyle)?.slice(0, 160),
        idempotencyKey: options.idempotencyKey,
      },
    };
  }

  if (!options.workflowId) throw new Error("请选择 ComfyUI workflow 模板。");
  const portrait = options.orientation === "portrait";
  return {
    provider: "comfyui",
    input: {
      workflowId: options.workflowId,
      modality: "image",
      prompt,
      negativePrompt,
      referenceImages: options.uploadedReference
        ? { primary: options.uploadedReference }
        : undefined,
      faceReference: options.uploadedReference,
      width: portrait ? 768 : 1344,
      height: portrait ? 1344 : 768,
      orientation: options.orientation,
      referenceRevision: options.referenceRevision || "none",
      idempotencyKey: options.idempotencyKey,
    },
  };
}

export function studioEngineDisabledReason(options: {
  engine: StudioGenerationEngine;
  comfyReady: boolean;
  localMiniDramaReady: boolean;
  projectId: number | null;
  workflowId: string;
  prompt: string;
}): string | undefined {
  if (!options.prompt.trim()) return "请先填写图片描述。";
  if (options.engine === "comfyui") {
    if (!options.comfyReady) return "ComfyUI 未连接或未配置。";
    if (!options.workflowId) return "暂无已启用的 ComfyUI 图片模板。";
    return undefined;
  }
  if (!options.localMiniDramaReady) return "LocalMiniDrama 未连接。";
  if (!Number.isSafeInteger(options.projectId) || Number(options.projectId) <= 0) {
    return "请先选择 LocalMiniDrama 项目。";
  }
  return undefined;
}

export function studioVisibleJobs(jobs: GenerationJob[]): GenerationJob[] {
  return jobs.filter(
    (job) => job.provider === "comfyui" || job.provider === "localminidrama",
  );
}

export function studioJobLabel(job: GenerationJob): string {
  if (job.provider === "localminidrama") return "LocalMiniDrama · 项目图片";
  return job.workflowId
    ? `${job.workflowId} · v${job.workflowVersion ?? "?"}`
    : "ComfyUI · 图片";
}

export function studioJobNotice(job: GenerationJob): string | undefined {
  if (job.provider === "localminidrama" && job.cancelRequested) {
    return "已请求取消，生成端仍可能继续；AIstory 会等待终态或超时。";
  }
  if (job.notes?.includes("cancel_requested_but_completed")) {
    return "已请求取消，但生成端随后完成；产物已安全保留。";
  }
  return undefined;
}
