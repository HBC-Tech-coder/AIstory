import type { SteamVideoGenerationPreflightPackage } from "@/lib/steam/productionSpec";

export const STEAM_VIDEO_GENERATION_PREFLIGHT_JSON_FILENAME =
  "aistory-steam-video-generation-preflight-v2.json";
export const STEAM_VIDEO_GENERATION_PREFLIGHT_CSV_FILENAME =
  "aistory-steam-video-generation-preflight-v2.csv";

export function serializeSteamVideoGenerationPreflightJson(
  value: SteamVideoGenerationPreflightPackage,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function csvCell(value: unknown): string {
  const raw = Array.isArray(value) ? value.join("|") : String(value ?? "");
  const protectedValue = /^[=+\-@\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function serializeSteamVideoGenerationPreflightCsv(
  value: SteamVideoGenerationPreflightPackage,
): string {
  const header = [
    "specId",
    "status",
    "nodeId",
    "sceneId",
    "episodeId",
    "shotId",
    "sourceContentHash",
    "releaseDiscriminator",
    "releasePolicyVersion",
    "releasePolicyHash",
    "releaseCompatible",
    "orientation",
    "durationSeconds",
    "aspectRatio",
    "width",
    "height",
    "fps",
    "audioIntent",
    "subtitleIntent",
    "labDiscriminator",
    "labPolicyVersion",
    "labPolicyHash",
    "labReleaseCompatible",
    "labOriginalSpecId",
    "labOriginalOutputRef",
    "labOriginalCompatible",
    "labOriginalWidth",
    "labOriginalHeight",
    "labOriginalFrameCount",
    "labOriginalFps",
    "labOriginalDurationMs",
    "labOriginalHasAudio",
    "labOriginalBlockers",
    "labUpscaleSpecId",
    "labUpscaleOutputRef",
    "labUpscaleSourceSpecId",
    "labUpscaleSourceOutputRef",
    "labUpscaleCompatible",
    "labUpscaleWidth",
    "labUpscaleHeight",
    "labUpscaleFrameCount",
    "labUpscaleFps",
    "labUpscaleDurationMs",
    "labUpscaleHasAudio",
    "labUpscaleOverwritesOriginal",
    "labUpscaleBlockers",
    "originalTaskId",
    "originalOutputRef",
    "upscaleSpecId",
    "upscaleOutputRef",
    "workflowTemplateId",
    "workflowVersion",
    "workflowFingerprint",
    "missingFields",
    "blockerCodes",
  ];
  const rows = value.specs.map((spec) => [
    spec.specId,
    spec.status,
    spec.nodeId,
    spec.sceneId,
    spec.episodeId,
    spec.shotId,
    spec.sourceContentHash,
    spec.releaseTarget.discriminator,
    spec.releaseTarget.policyVersion,
    spec.releaseTarget.policyHash,
    spec.releaseTarget.compatible,
    spec.videoPolicy.orientation,
    spec.videoPolicy.durationSeconds,
    spec.videoPolicy.aspectRatio,
    spec.videoPolicy.width,
    spec.videoPolicy.height,
    spec.videoPolicy.fps,
    spec.audioSubtitleIntent.audio,
    spec.audioSubtitleIntent.subtitles,
    spec.labPreview.discriminator,
    spec.labPreview.policyVersion,
    spec.labPreview.policyHash,
    spec.labPreview.releaseCompatible,
    spec.labPreview.original.specId,
    spec.labPreview.original.outputRef,
    spec.labPreview.original.compatible,
    spec.labPreview.original.width,
    spec.labPreview.original.height,
    spec.labPreview.original.frameCount,
    spec.labPreview.original.fps,
    spec.labPreview.original.durationMs,
    spec.labPreview.original.hasAudio,
    spec.labPreview.original.blockerCodes,
    spec.labPreview.upscale.specId,
    spec.labPreview.upscale.outputRef,
    spec.labPreview.upscale.sourceSpecId,
    spec.labPreview.upscale.sourceOutputRef,
    spec.labPreview.upscale.compatible,
    spec.labPreview.upscale.width,
    spec.labPreview.upscale.height,
    spec.labPreview.upscale.frameCount,
    spec.labPreview.upscale.fps,
    spec.labPreview.upscale.durationMs,
    spec.labPreview.upscale.hasAudio,
    spec.labPreview.upscale.overwritesOriginal,
    spec.labPreview.upscale.blockerCodes,
    spec.original.taskId,
    spec.original.outputRef,
    spec.upscale.specId,
    spec.upscale.outputRef,
    spec.workflow.pin?.templateId,
    spec.workflow.pin?.version,
    spec.workflow.pin?.fingerprint,
    spec.missingFields,
    spec.blockerCodes,
  ]);
  return `${[header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}
