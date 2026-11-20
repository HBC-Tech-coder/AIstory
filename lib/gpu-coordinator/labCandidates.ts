import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

const LTX23_R0_BINDINGS = {
  prompt: [{ nodeId: "6", input: "text" }],
  negativePrompt: [{ nodeId: "7", input: "text" }],
  seed: [{ nodeId: "12", input: "noise_seed" }],
  width: [{ nodeId: "9", input: "width" }],
  height: [{ nodeId: "9", input: "height" }],
  frames: [
    { nodeId: "9", input: "length" },
    { nodeId: "10", input: "frames_number" },
  ],
  fps: [
    { nodeId: "8", input: "frame_rate" },
    { nodeId: "10", input: "frame_rate" },
    { nodeId: "20", input: "fps" },
  ],
} as const;

export type FrozenLanGpuWorkflowCandidate = {
  evidenceId: string;
  workflowId: string;
  workflowSha256: string;
  purpose: "generate" | "upscale";
  modality: "video";
  classification: "non_publishable";
  productionEligible: false;
  mechanicallyVerified: true;
  parameterBindings: Readonly<
    Record<string, readonly { nodeId: string; input: string }[]>
  >;
  parameterBindingSha256: string;
  fixedParameters: {
    width: number;
    height: number;
    frames: number;
    fps: number;
    seed?: number;
    preserveAudio?: true;
  };
  inputSlots: readonly (
    | "referenceImage"
    | "firstFrame"
    | "lastFrame"
    | "sourceVideo"
  )[];
  outputSlots: Array<{
    nodeId: string;
    slot: number;
    mimeType: "video/mp4";
  }>;
};

export const LTX23_R0_LAN_LAB_CANDIDATE: FrozenLanGpuWorkflowCandidate = {
  evidenceId: "AIstory-GPU-LAB-R0-20260730",
  workflowId: "ltx23-original-av-lab",
  workflowSha256:
    "f3465cacbf88e139a0f4708ed887d875edab72cc5d28c0c6b40c91519362794e",
  purpose: "generate",
  modality: "video",
  classification: "non_publishable",
  productionEligible: false,
  mechanicallyVerified: true,
  parameterBindings: LTX23_R0_BINDINGS,
  parameterBindingSha256: createHash("sha256")
    .update(canonical(LTX23_R0_BINDINGS), "utf8")
    .digest("hex"),
  fixedParameters: {
    width: 768,
    height: 480,
    frames: 81,
    fps: 24,
    seed: 40902000,
  },
  inputSlots: [],
  outputSlots: [{ nodeId: "21", slot: 0, mimeType: "video/mp4" }],
};

export const LTX23_1280X800_UPSCALE_WORKFLOW_REQUEST = {
  workflowId: "ltx23-video-upscale-1280x800-lab",
  purpose: "upscale",
  classification: "non_publishable",
  productionEligible: false,
  source: { width: 768, height: 480, frames: 81, fps: 24 },
  target: { width: 1280, height: 800, frames: 81, fps: 24 },
  inputSlot: "sourceVideo",
  preserveAudio: true,
  subtitlePolicy: "runtime_overlay_not_burned_in",
  status: "waiting_for_4090_frozen_workflow_identity",
} as const;

export const FROZEN_LAN_GPU_WORKFLOW_CANDIDATES = [
  LTX23_R0_LAN_LAB_CANDIDATE,
] as const;

export function findFrozenLanGpuWorkflowCandidate(
  workflowId: string,
  workflowSha256: string,
): FrozenLanGpuWorkflowCandidate | undefined {
  return FROZEN_LAN_GPU_WORKFLOW_CANDIDATES.find(
    (item) =>
      item.workflowId === workflowId &&
      item.workflowSha256 === workflowSha256,
  );
}
