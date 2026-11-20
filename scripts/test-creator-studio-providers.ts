import assert from "node:assert/strict";

import {
  isLoopbackServiceUrl,
  resolveCreatorStudioModuleUrl,
} from "../lib/creator-studio/capabilities.ts";
import {
  validateComfyUIProviderConfig,
  validateComfyUIWorkflowRequest,
} from "../lib/providers/comfyui/validation.ts";
import { shouldSchedulePrefetch } from "../lib/speculativeBranch.ts";

const dynamicImageWorkflow = {
  "load-checkpoint-any-id": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "user-selected.safetensors" },
  },
  "positive-text-node": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "placeholder",
      clip: ["load-checkpoint-any-id", 1],
      lora_name: "",
      lora_model_weight: 1,
      lora_clip_weight: 1,
      control_model: "",
      control_strength: 1,
      control_start: 0,
      control_end: 1,
      identity_image: "",
      pose_image: "",
      face_reference: "",
    },
  },
  "custom-output": {
    class_type: "SaveImage",
    inputs: { images: ["positive-text-node", 0] },
  },
};

const dynamicVideoWorkflow = {
  "user-video-loader": {
    class_type: "AnyCommunityVideoModelLoader",
    inputs: { model: "selected-at-runtime" },
  },
  "user-video-output": {
    class_type: "AnyCommunityVideoOutput",
    inputs: { samples: ["user-video-loader", 0] },
  },
};

const validConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8188",
  checkpoint: "user-selected.safetensors",
  loras: [{ name: "character-continuity.safetensors", modelWeight: 0.75 }],
  controlNets: [
    {
      model: "user-selected-controlnet.safetensors",
      strength: 0.8,
      startPercent: 0,
      endPercent: 0.9,
      referenceSlot: "pose",
    },
  ],
  faceContinuity: { enabled: true, referenceSlot: "identity" },
  workflows: {
    image: {
      workflow: dynamicImageWorkflow,
      outputNodeIds: ["custom-output"],
      bindings: {
        positivePrompt: { nodeId: "positive-text-node", input: "text" },
        checkpoint: {
          nodeId: "load-checkpoint-any-id",
          input: "ckpt_name",
        },
        loras: [
          {
            name: { nodeId: "positive-text-node", input: "lora_name" },
            modelWeight: {
              nodeId: "positive-text-node",
              input: "lora_model_weight",
            },
            clipWeight: {
              nodeId: "positive-text-node",
              input: "lora_clip_weight",
            },
          },
        ],
        controlNets: [
          {
            model: { nodeId: "positive-text-node", input: "control_model" },
            strength: {
              nodeId: "positive-text-node",
              input: "control_strength",
            },
            startPercent: {
              nodeId: "positive-text-node",
              input: "control_start",
            },
            endPercent: {
              nodeId: "positive-text-node",
              input: "control_end",
            },
            referenceImage: {
              nodeId: "positive-text-node",
              input: "pose_image",
            },
          },
        ],
        referenceImages: {
          identity: { nodeId: "positive-text-node", input: "identity_image" },
          pose: { nodeId: "positive-text-node", input: "pose_image" },
        },
        faceReference: {
          nodeId: "positive-text-node",
          input: "face_reference",
        },
      },
    },
    video: {
      workflow: dynamicVideoWorkflow,
      outputNodeIds: ["user-video-output"],
      bindings: {
        videoNodes: [
          { nodeId: "user-video-loader", input: "model" },
        ],
      },
    },
  },
};

assert.equal(isLoopbackServiceUrl("http://127.0.0.1:8188"), true);
assert.equal(isLoopbackServiceUrl("http://localhost:8188"), true);
assert.equal(isLoopbackServiceUrl("https://comfy.example.com"), false);

const validation = validateComfyUIProviderConfig(validConfig);
assert.equal(validation.ok, true, JSON.stringify(validation.issues));
assert.deepEqual(validation.summary.modalities, ["image", "video"]);
assert.equal(validation.summary.workflowNodeCounts.image, 3);
assert.equal(validation.summary.workflowNodeCounts.video, 2);

const remoteConfig = validateComfyUIProviderConfig({
  ...validConfig,
  baseUrl: "https://remote.example.com",
});
assert.equal(remoteConfig.ok, false);
assert.equal(remoteConfig.issues.some((item) => item.path === "baseUrl"), true);

const missingWorkflow = validateComfyUIProviderConfig({
  enabled: true,
  baseUrl: "http://localhost:8188",
});
assert.equal(missingWorkflow.ok, false);
assert.equal(
  missingWorkflow.issues.some((item) => item.path === "workflows"),
  true,
);

const danglingReference = validateComfyUIProviderConfig({
  ...validConfig,
  workflows: {
    image: {
      workflow: {
        output: {
          class_type: "SaveImage",
          inputs: { images: ["missing-node", 0] },
        },
      },
      outputNodeIds: ["output"],
    },
  },
});
assert.equal(danglingReference.ok, false);
assert.equal(
  danglingReference.issues.some((item) =>
    item.message.includes("missing-node"),
  ),
  true,
);

const foregroundRequest = validateComfyUIWorkflowRequest({
  modality: "image",
  purpose: "foreground",
  prompt: "A consistent character portrait",
  idempotencyKey: "request-123",
});
assert.equal(foregroundRequest.ok, true);

const speculativeRequest = validateComfyUIWorkflowRequest({
  modality: "image",
  purpose: "prefetch",
  prompt: "Must never queue",
  idempotencyKey: "request-456",
});
assert.equal(speculativeRequest.ok, false);
assert.equal(
  speculativeRequest.issues.some((item) => item.path === "purpose"),
  true,
);

assert.equal(shouldSchedulePrefetch(0, 0, 2, 0, 8), false);
assert.equal(shouldSchedulePrefetch(0, 1, 2, 0, 8), true);

assert.deepEqual(
  resolveCreatorStudioModuleUrl(
    "http://127.0.0.1:4107",
    "canvas",
    42,
  ),
  {
    url: "http://127.0.0.1:4107/film/42/canvas",
    needsProject: false,
  },
);
assert.deepEqual(
  resolveCreatorStudioModuleUrl(
    "http://127.0.0.1:4107",
    "storyboards",
    null,
  ),
  {
    url: "http://127.0.0.1:4107/",
    needsProject: true,
  },
);
assert.deepEqual(
  resolveCreatorStudioModuleUrl(
    "http://127.0.0.1:4107",
    "media",
  ),
  {
    url: "http://127.0.0.1:4107/media-library",
    needsProject: false,
  },
);

process.env.COMFYUI_ENABLED = "true";
process.env.COMFYUI_BASE_URL = "http://127.0.0.1:8188";
process.env.COMFYUI_IMAGE_WORKFLOW_JSON = JSON.stringify({
  workflow: dynamicImageWorkflow,
  outputNodeIds: ["custom-output"],
  bindings: {
    positivePrompt: { nodeId: "positive-text-node", input: "text" },
  },
});
let submitCount = 0;
const mockComfyFetch: typeof fetch = async () => {
  submitCount += 1;
  await Promise.resolve();
  return new Response(JSON.stringify({ prompt_id: "prompt-one" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const { queueComfyUIWorkflow } = await import(
  "../lib/providers/comfyui/server.ts"
);
const queueRequest = {
  modality: "image" as const,
  purpose: "foreground" as const,
  prompt: "single-flight portrait",
  idempotencyKey: "single-flight-key",
};
const [queuedA, queuedB] = await Promise.all([
  queueComfyUIWorkflow(queueRequest, mockComfyFetch),
  queueComfyUIWorkflow(queueRequest, mockComfyFetch),
]);
assert.equal(submitCount, 1);
assert.equal(queuedA.promptId, "prompt-one");
assert.equal(queuedB.requestFingerprint, queuedA.requestFingerprint);

console.log("creator studio + ComfyUI provider tests: ok");
