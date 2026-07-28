import assert from "node:assert/strict";

import {
  buildStudioGenerationRequest,
  studioEngineDisabledReason,
  studioJobLabel,
  studioJobNotice,
  studioVisibleJobs,
} from "../lib/generation-jobs/studioRequest";
import type { GenerationJob } from "../lib/generation-jobs/types";

const lmd = buildStudioGenerationRequest({
  engine: "localminidrama",
  projectId: 37,
  workflowId: "must-not-leak",
  prompt: "  rain-soaked alley  ",
  negativePrompt: " blur ",
  orientation: "portrait",
  localMiniDramaStyle: "cinematic watercolor",
  uploadedReference: "aistory/should-not-leak.png",
  referenceRevision: "should-not-leak",
  idempotencyKey: "lmd-selector-test",
});
assert.equal(lmd.provider, "localminidrama");
assert.deepEqual(Object.keys(lmd.input).sort(), [
  "aspectRatio",
  "dramaId",
  "frameType",
  "idempotencyKey",
  "negativePrompt",
  "prompt",
  "size",
  "style",
].sort());
assert.equal(lmd.input.dramaId, 37);
assert.equal(lmd.input.size, "768x1344");
assert.equal(lmd.input.aspectRatio, "9:16");
const serializedLmd = JSON.stringify(lmd.input);
for (const forbidden of [
  "workflow",
  "reference",
  "provider",
  "model",
  "local_path",
  "aistory/should-not-leak.png",
]) {
  assert.equal(serializedLmd.includes(forbidden), false, forbidden);
}

const comfy = buildStudioGenerationRequest({
  engine: "comfyui",
  projectId: 37,
  workflowId: "portrait-v2",
  prompt: "character close-up",
  orientation: "landscape",
  uploadedReference: "aistory/00000000-0000-0000-0000-000000000000.png",
  referenceRevision: "project-asset:v1:id:hash",
  idempotencyKey: "comfy-selector-test",
});
assert.equal(comfy.provider, "comfyui");
assert.equal(comfy.input.workflowId, "portrait-v2");
assert.equal(comfy.input.width, 1344);
assert.equal(comfy.input.referenceRevision, "project-asset:v1:id:hash");

assert.equal(
  studioEngineDisabledReason({
    engine: "localminidrama",
    comfyReady: false,
    localMiniDramaReady: false,
    projectId: 37,
    workflowId: "",
    prompt: "ready",
  }),
  "LocalMiniDrama 未连接。",
);
assert.equal(
  studioEngineDisabledReason({
    engine: "localminidrama",
    comfyReady: false,
    localMiniDramaReady: true,
    projectId: null,
    workflowId: "",
    prompt: "ready",
  }),
  "请先选择 LocalMiniDrama 项目。",
);
assert.equal(
  studioEngineDisabledReason({
    engine: "localminidrama",
    comfyReady: false,
    localMiniDramaReady: true,
    projectId: 37,
    workflowId: "",
    prompt: "ready",
  }),
  undefined,
);

const now = new Date().toISOString();
function publicJob(provider: "comfyui" | "localminidrama"): GenerationJob {
  return {
    id: `${provider}-job`,
    provider,
    modality: "image",
    status: "pending",
    progress: 50,
    requestFingerprint: `${provider}-fingerprint`,
    idempotencyKey: `${provider}-idempotency`,
    attempts: 1,
    maxAttempts: 2,
    retryable: false,
    cancelRequested: provider === "localminidrama",
    provenance: {
      purpose: "foreground",
      source: "aistory-studio",
      provider,
    },
    createdAt: now,
    updatedAt: now,
  };
}
const both = studioVisibleJobs([
  publicJob("comfyui"),
  publicJob("localminidrama"),
]);
assert.deepEqual(both.map((job) => job.provider), [
  "comfyui",
  "localminidrama",
]);
assert.equal(studioJobLabel(both[1]!), "LocalMiniDrama · 项目图片");
assert.equal(
  studioJobNotice(both[1]!),
  "已请求取消，生成端仍可能继续；AIstory 会等待终态或超时。",
);

console.log("Studio generation engine selector tests passed.");
