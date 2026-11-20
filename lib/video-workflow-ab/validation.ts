import {
  VIDEO_WORKFLOW_AB_OPTIMIZATIONS,
  VIDEO_WORKFLOW_AB_SCHEMA_VERSION,
  type VideoWorkflowABFileReference,
  type VideoWorkflowABPackageManifest,
  type VideoWorkflowABRunManifest,
  type VideoWorkflowABVariantManifest,
  type VideoWorkflowABWeightRole,
} from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_ERROR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WEIGHT_ROLES: VideoWorkflowABWeightRole[] = [
  "diffusion",
  "vae",
  "text_encoder",
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 500): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>\\]/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 120);
  if (!SAFE_ID.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const result = Number(value);
  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function decimal(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function assertSafePackagePath(value: unknown): string {
  const candidate = text(value, "Package path", 240);
  if (
    candidate.startsWith("/") ||
    candidate.startsWith("\\") ||
    candidate.includes("\\") ||
    candidate.includes(":") ||
    candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Package path is unsafe.");
  }
  return candidate;
}

function httpsUrl(value: unknown, label: string): string {
  const candidate = text(value, label, 600);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed.toString();
}

function fileReference(
  value: unknown,
  label: string,
): VideoWorkflowABFileReference {
  const item = record(value, label);
  return {
    path: assertSafePackagePath(item.path),
    sha256: sha(item.sha256, `${label} SHA`),
    bytes: integer(item.bytes, `${label} bytes`, 1, 512 * 1024 * 1024),
    contentType: text(item.contentType, `${label} content type`, 80),
  };
}

function extensionForContentType(
  contentType: string,
  kind: "frame" | "video",
): string {
  const extensions: Record<string, string> =
    kind === "video"
      ? { "video/mp4": "mp4", "video/webm": "webm" }
      : {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
        };
  const extension = extensions[contentType];
  if (!extension) throw new Error(`A/B ${kind} content type is unsupported.`);
  return extension;
}

function validateVariant(
  value: unknown,
  expectedId: "A" | "B",
): VideoWorkflowABVariantManifest {
  const item = record(value, `Variant ${expectedId}`);
  if (item.id !== expectedId) throw new Error(`Variant ${expectedId} is missing.`);
  const kind =
    expectedId === "A" ? "official_baseline" : "aistory_4090_optimized";
  if (item.kind !== kind) throw new Error(`Variant ${expectedId} kind is invalid.`);
  const optimizationChanges = Array.isArray(item.optimizationChanges)
    ? item.optimizationChanges.map((entry) => text(entry, "Optimization", 80))
    : [];
  if (
    optimizationChanges.some(
      (entry) =>
        !(VIDEO_WORKFLOW_AB_OPTIMIZATIONS as readonly string[]).includes(entry),
    ) ||
    new Set(optimizationChanges).size !== optimizationChanges.length
  ) {
    throw new Error("Variant optimization change is not allowlisted.");
  }
  if (expectedId === "A" && optimizationChanges.length) {
    throw new Error("Official baseline cannot declare optimizations.");
  }
  const thirdPartyLoras = Array.isArray(item.thirdPartyLoras)
    ? item.thirdPartyLoras
    : [];
  if (thirdPartyLoras.length !== 0) {
    throw new Error("Third-party LoRA is forbidden in the A/B experiment.");
  }
  const postprocess = record(item.postprocess, "Variant postprocess");
  if (postprocess.enabled !== false) {
    throw new Error("Base A/B variants cannot include postprocessing.");
  }
  const weights = record(item.weightSha256ByRole, "Variant weights");
  const workflowPath = assertSafePackagePath(item.workflowPath);
  if (workflowPath !== `workflows/${expectedId}.json`) {
    throw new Error("A/B workflow path does not match the package layout.");
  }
  return {
    id: expectedId,
    kind,
    workflowPath,
    workflowSha256: sha(item.workflowSha256, "Workflow SHA"),
    ...(item.parentWorkflowSha256
      ? {
          parentWorkflowSha256: sha(
            item.parentWorkflowSha256,
            "Parent workflow SHA",
          ),
        }
      : {}),
    workflowSourceUrl: httpsUrl(item.workflowSourceUrl, "Workflow source URL"),
    workflowSourceRevision: text(
      item.workflowSourceRevision,
      "Workflow source revision",
      160,
    ),
    weightSha256ByRole: {
      diffusion: sha(weights.diffusion, "Diffusion weight SHA"),
      vae: sha(weights.vae, "VAE weight SHA"),
      text_encoder: sha(weights.text_encoder, "Text encoder weight SHA"),
    },
    thirdPartyLoras: [],
    optimizationChanges: optimizationChanges as VideoWorkflowABVariantManifest["optimizationChanges"],
    postprocess: { enabled: false },
  };
}

function validateRun(value: unknown): VideoWorkflowABRunManifest {
  const item = record(value, "Run");
  const status = item.status;
  if (!["succeeded", "failed", "oom"].includes(String(status))) {
    throw new Error("Run status is invalid.");
  }
  const result: VideoWorkflowABRunManifest = {
    id: id(item.id, "Run id"),
    variantId:
      item.variantId === "A" || item.variantId === "B"
        ? item.variantId
        : (() => {
            throw new Error("Run variant is invalid.");
          })(),
    pairIndex: integer(item.pairIndex, "Pair index", 0, 10_000),
    executionOrder: integer(item.executionOrder, "Execution order", 1, 100_000),
    warmup: item.warmup === true,
    status: status as VideoWorkflowABRunManifest["status"],
    queuedMs: integer(item.queuedMs, "Queue duration", 0, 7 * 24 * 60 * 60 * 1000),
    generationMs: integer(
      item.generationMs,
      "Generation duration",
      0,
      7 * 24 * 60 * 60 * 1000,
    ),
    totalMs: integer(item.totalMs, "Total duration", 0, 7 * 24 * 60 * 60 * 1000),
    peakVramMiB: integer(item.peakVramMiB, "Peak VRAM", 0, 1024 * 1024),
    ...(item.errorCode
      ? { errorCode: text(item.errorCode, "Run error code", 80) }
      : {}),
  };
  if (result.totalMs < result.generationMs) {
    throw new Error("Run total duration is shorter than generation duration.");
  }
  if (result.errorCode && !SAFE_ERROR.test(result.errorCode)) {
    throw new Error("Run error code is invalid.");
  }
  if (result.status === "succeeded") {
    const rawOutput = record(item.output, "Run output");
    const outputRef = fileReference(rawOutput, "Run output");
    const rawProbe = record(rawOutput, "Run output");
    result.output = {
      ...outputRef,
      durationMs: integer(
        rawProbe.durationMs,
        "Output duration",
        100,
        2 * 60 * 60 * 1000,
      ),
      width: integer(rawProbe.width, "Output width", 64, 7680),
      height: integer(rawProbe.height, "Output height", 64, 7680),
      videoCodec: text(rawProbe.videoCodec, "Video codec", 40).toLowerCase(),
      ...(rawProbe.audioCodec
        ? {
            audioCodec: text(
              rawProbe.audioCodec,
              "Audio codec",
              40,
            ).toLowerCase(),
          }
        : {}),
      hasAudio: rawProbe.hasAudio === true,
      frameCount: integer(rawProbe.frameCount, "Output frame count", 1, 100_000),
      fps: decimal(rawProbe.fps, "Output FPS", 0.1, 240),
    };
    result.firstFrame = fileReference(item.firstFrame, "First frame");
    result.lastFrame = fileReference(item.lastFrame, "Last frame");
    const runRoot = `runs/${result.id}`;
    if (
      result.output.path !==
        `${runRoot}/output.${extensionForContentType(result.output.contentType, "video")}` ||
      result.firstFrame.path !==
        `${runRoot}/first-frame.${extensionForContentType(result.firstFrame.contentType, "frame")}` ||
      result.lastFrame.path !==
        `${runRoot}/last-frame.${extensionForContentType(result.lastFrame.contentType, "frame")}`
    ) {
      throw new Error("A/B run files do not match the package layout.");
    }
  } else {
    if (!result.errorCode) {
      throw new Error("Failed and OOM runs require a redacted error code.");
    }
    if (item.output || item.firstFrame || item.lastFrame) {
      throw new Error("Failed and OOM runs cannot declare output files.");
    }
  }
  return result;
}

export function validateVideoWorkflowABManifest(
  value: unknown,
): VideoWorkflowABPackageManifest {
  const source = record(value, "A/B manifest");
  if (source.schemaVersion !== VIDEO_WORKFLOW_AB_SCHEMA_VERSION) {
    throw new Error("A/B manifest schema version is unsupported.");
  }
  const experiment = record(source.experiment, "Experiment");
  const input = record(source.input, "Experiment input");
  const environment = record(source.environment, "Environment");
  const rawWeights = Array.isArray(source.weights) ? source.weights : [];
  if (rawWeights.length !== 3) {
    throw new Error("Exactly three official weight records are required.");
  }
  const roles = new Set<VideoWorkflowABWeightRole>();
  const weights = rawWeights.map((entry) => {
    const item = record(entry, "Weight");
    const role = String(item.role) as VideoWorkflowABWeightRole;
    if (!WEIGHT_ROLES.includes(role) || roles.has(role)) {
      throw new Error("Weight roles must be unique and complete.");
    }
    roles.add(role);
    return {
      role,
      fileName: text(item.fileName, "Weight filename", 200),
      sha256: sha(item.sha256, "Weight SHA"),
      sourceUrl: httpsUrl(item.sourceUrl, "Weight source URL"),
      sourceRevision: text(item.sourceRevision, "Weight source revision", 160),
      licenseId: text(item.licenseId, "Weight license id", 80),
      licenseUrl: httpsUrl(item.licenseUrl, "Weight license URL"),
    };
  });
  const rawVariants = Array.isArray(source.variants) ? source.variants : [];
  if (rawVariants.length !== 2) throw new Error("Exactly two variants are required.");
  const variants: [
    VideoWorkflowABVariantManifest,
    VideoWorkflowABVariantManifest,
  ] = [
    validateVariant(rawVariants.find((item) => record(item, "Variant").id === "A"), "A"),
    validateVariant(rawVariants.find((item) => record(item, "Variant").id === "B"), "B"),
  ];
  if (variants[1].parentWorkflowSha256 !== variants[0].workflowSha256) {
    throw new Error("Variant B must name Variant A as its workflow parent.");
  }
  for (const variant of variants) {
    for (const weight of weights) {
      if (variant.weightSha256ByRole[weight.role] !== weight.sha256) {
        throw new Error("Variants must use the identical official weight hashes.");
      }
    }
  }
  const runs = Array.isArray(source.runs)
    ? source.runs.map(validateRun)
    : [];
  if (runs.length < 2 || runs.length > 100) {
    throw new Error("A/B package must contain 2 to 100 runs.");
  }
  if (
    new Set(runs.map((run) => run.id)).size !== runs.length ||
    new Set(runs.map((run) => run.executionOrder)).size !== runs.length
  ) {
    throw new Error("Run ids and execution order must be unique.");
  }
  const pairKeys = new Set(runs.map((run) => `${run.pairIndex}:${run.warmup}`));
  for (const key of pairKeys) {
    const [pairText, warmupText] = key.split(":");
    const pair = runs.filter(
      (run) =>
        run.pairIndex === Number(pairText) &&
        run.warmup === (warmupText === "true"),
    );
    if (
      pair.length !== 2 ||
      new Set(pair.map((run) => run.variantId)).size !== 2
    ) {
      throw new Error("Each warmup or measured pair must contain one A and one B run.");
    }
  }
  const postprocessLayers = Array.isArray(source.postprocessLayers)
    ? source.postprocessLayers.map((entry) => {
        const item = record(entry, "Postprocess layer");
        const rawOutput = record(item.output, "Postprocess output");
        const layerId = id(item.id, "Postprocess layer id");
        const output = {
          ...fileReference(rawOutput, "Postprocess output"),
          durationMs: integer(
            rawOutput.durationMs,
            "Postprocess duration",
            100,
            2 * 60 * 60 * 1000,
          ),
          width: integer(rawOutput.width, "Postprocess width", 64, 7680),
          height: integer(rawOutput.height, "Postprocess height", 64, 7680),
          videoCodec: text(
            rawOutput.videoCodec,
            "Postprocess video codec",
            40,
          ),
          ...(rawOutput.audioCodec
            ? {
                audioCodec: text(
                  rawOutput.audioCodec,
                  "Postprocess audio codec",
                  40,
                ),
              }
            : {}),
          hasAudio: rawOutput.hasAudio === true,
          frameCount: integer(
            rawOutput.frameCount,
            "Postprocess frame count",
            1,
            100_000,
          ),
          fps: decimal(rawOutput.fps, "Postprocess FPS", 0.1, 240),
        };
        if (
          output.path !==
          `postprocess/${layerId}/output.${extensionForContentType(output.contentType, "video")}`
        ) {
          throw new Error(
            "A/B postprocess file does not match the package layout.",
          );
        }
        return {
          id: layerId,
          parentOutputSha256: sha(
            item.parentOutputSha256,
            "Postprocess parent SHA",
          ),
          operations: Array.isArray(item.operations)
            ? item.operations.map((operation) =>
                text(operation, "Postprocess operation", 120),
              )
            : [],
          output,
        };
      })
    : [];
  const manifest: VideoWorkflowABPackageManifest = {
    schemaVersion: VIDEO_WORKFLOW_AB_SCHEMA_VERSION,
    experiment: {
      id: id(experiment.id, "Experiment id"),
      projectId: integer(experiment.projectId, "Project id", 1, 2_147_483_647),
      title: text(experiment.title, "Experiment title", 160),
      synthetic: experiment.synthetic === true,
      createdAt: text(experiment.createdAt, "Experiment created time", 80),
    },
    input: {
      imageAssetId: id(input.imageAssetId, "Input asset id"),
      imageSha256: sha(input.imageSha256, "Input image SHA"),
      promptSha256: sha(input.promptSha256, "Prompt SHA"),
      ...(input.negativePromptSha256
        ? {
            negativePromptSha256: sha(
              input.negativePromptSha256,
              "Negative prompt SHA",
            ),
          }
        : {}),
      seed: integer(input.seed, "Seed", 0, 2_147_483_647),
      width: integer(input.width, "Width", 64, 7680),
      height: integer(input.height, "Height", 64, 7680),
      frameCount: integer(input.frameCount, "Frame count", 1, 100_000),
      fps: decimal(input.fps, "FPS", 0.1, 240),
      samplingSemanticsSha256: sha(
        input.samplingSemanticsSha256,
        "Sampling semantics SHA",
      ),
    },
    environment: {
      comfyuiVersion: text(environment.comfyuiVersion, "ComfyUI version", 120),
      comfyuiCommit: text(environment.comfyuiCommit, "ComfyUI commit", 160),
      gpuModel: text(environment.gpuModel, "GPU model", 160),
      gpuVramMiB: integer(
        environment.gpuVramMiB,
        "GPU VRAM",
        1024,
        1024 * 1024,
      ),
      driverVersion: text(environment.driverVersion, "Driver version", 120),
      ...(environment.cudaVersion
        ? { cudaVersion: text(environment.cudaVersion, "CUDA version", 120) }
        : {}),
      ...(environment.pytorchVersion
        ? {
            pytorchVersion: text(
              environment.pytorchVersion,
              "PyTorch version",
              120,
            ),
          }
        : {}),
    },
    weights,
    variants,
    runs,
    ...(postprocessLayers.length ? { postprocessLayers } : {}),
  };
  for (const run of manifest.runs) {
    if (run.status === "succeeded") {
      if (
        run.output!.width !== manifest.input.width ||
        run.output!.height !== manifest.input.height ||
        run.output!.frameCount !== manifest.input.frameCount ||
        Math.abs(run.output!.fps - manifest.input.fps) > 0.001
      ) {
        throw new Error("Run output does not match the shared A/B dimensions or timing.");
      }
    }
  }
  return manifest;
}

export function measuredSuccessfulRunsByVariant(
  runs: VideoWorkflowABRunManifest[],
): { A: VideoWorkflowABRunManifest[]; B: VideoWorkflowABRunManifest[] } {
  return {
    A: runs.filter(
      (run) => !run.warmup && run.status === "succeeded" && run.variantId === "A",
    ),
    B: runs.filter(
      (run) => !run.warmup && run.status === "succeeded" && run.variantId === "B",
    ),
  };
}
