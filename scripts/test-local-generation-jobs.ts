import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const testRoot = path.join(
  process.cwd(),
  `.aistory-local-generation-test-${process.pid}`,
);
if (!path.resolve(testRoot).startsWith(path.resolve(process.cwd()) + path.sep)) {
  throw new Error("Unsafe test directory.");
}
await rm(testRoot, { recursive: true, force: true });
await mkdir(testRoot, { recursive: true });
process.env.AISTORY_COMFYUI_REGISTRY_DIR = path.join(testRoot, "registry");
process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs");
process.env.AISTORY_CACHE_DIR = path.join(testRoot, "cache");
process.env.COMFYUI_ENABLED = "true";
process.env.COMFYUI_BASE_URL = "http://127.0.0.1:8188";
delete process.env.COMFYUI_IMAGE_WORKFLOW_JSON;
delete process.env.COMFYUI_VIDEO_WORKFLOW_JSON;

const {
  configureComfyUIWorkflowTemplate,
  getComfyUIWorkflowTemplate,
  importComfyUIWorkflowTemplate,
  listComfyUIWorkflowTemplates,
} = await import("../lib/providers/comfyui/registry.ts");
const {
  cancelComfyUIJob,
  getComfyUIHistory,
  mirrorComfyUIHistoryOutput,
  requestComfyUI,
  uploadComfyUIImage,
} = await import("../lib/providers/comfyui/transport.ts");
const { GenerationJobScheduler } = await import(
  "../lib/generation-jobs/server.ts"
);
const {
  getStoredGenerationJob,
  hasActiveComfyUIWorkflowSelection,
  saveStoredGenerationJob,
} = await import("../lib/generation-jobs/store.ts");
const { discoverComfyUIProviderStatus } = await import(
  "../lib/providers/comfyui/server.ts"
);
const { isTrustedLoopbackMutationRequest } = await import(
  "../lib/security/localMutation.ts"
);

const workflow = (marker: string) => ({
  workflow: {
    prompt: {
      class_type: "CLIPTextEncode",
      inputs: { text: marker },
    },
    output: {
      class_type: "SaveImage",
      inputs: { images: ["prompt", 0] },
    },
  },
  outputNodeIds: ["output"],
  bindings: {
    positivePrompt: { nodeId: "prompt", input: "text" },
  },
});

const first = await importComfyUIWorkflowTemplate({
  id: "portrait-safe",
  name: "安全人像",
  modality: "image",
  enabled: true,
  workflow: workflow("v1"),
});
assert.equal(first.activeVersion, 1);
const second = await importComfyUIWorkflowTemplate({
  id: "portrait-safe",
  name: "安全人像",
  modality: "image",
  enabled: true,
  workflow: workflow("v2"),
});
assert.equal(second.activeVersion, 2);
const rolledBack = await configureComfyUIWorkflowTemplate("portrait-safe", {
  activeVersion: 1,
});
assert.equal(rolledBack.activeVersion, 1);
assert.equal(rolledBack.versions.length, 2);
const listed = await listComfyUIWorkflowTemplates();
assert.equal(listed[0]?.versionCount, 2);
assert.equal(listed[0]?.activeVersion, 1);
assert.equal(
  (await getComfyUIWorkflowTemplate("portrait-safe"))?.version.workflow
    .workflow.prompt?.inputs.text,
  "v1",
);
const registryDisk = JSON.parse(
  await readFile(
    path.join(testRoot, "registry", "registry.json"),
    "utf8",
  ),
) as { templates?: unknown[] };
assert.equal(registryDisk.templates?.length, 1);
assert.equal(
  await readFile(
    path.join(testRoot, "registry", "registry.previous.json"),
    "utf8",
  ).then((value) => value.length > 0),
  true,
);

const statusFetch = (async (input, init) => {
  assert.equal(init?.redirect, "error");
  const url = String(input);
  return new Response(
    JSON.stringify(
      url.endsWith("/object_info")
        ? { SaveImage: {}, CLIPTextEncode: {} }
        : { exec_info: { queue_remaining: 0 } },
    ),
  );
}) as typeof fetch;
const registryOnlyStatus = await discoverComfyUIProviderStatus(statusFetch);
assert.equal(registryOnlyStatus.state, "ready");
assert.equal(registryOnlyStatus.modalities.image, true);
assert.equal(registryOnlyStatus.activeTemplateCounts?.image, 1);

await configureComfyUIWorkflowTemplate("portrait-safe", { enabled: false });
const noTemplateStatus = await discoverComfyUIProviderStatus(statusFetch);
assert.equal(noTemplateStatus.state, "not_configured");
process.env.COMFYUI_IMAGE_WORKFLOW_JSON = JSON.stringify(workflow("env-only"));
const envOnlyStatus = await discoverComfyUIProviderStatus(statusFetch);
assert.equal(envOnlyStatus.state, "ready");
assert.equal(envOnlyStatus.modalities.image, true);
delete process.env.COMFYUI_IMAGE_WORKFLOW_JSON;
await configureComfyUIWorkflowTemplate("portrait-safe", { enabled: true });

const providerConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8188",
  workflows: { image: workflow("transport") },
};

let uploadCalled = false;
await assert.rejects(() =>
  uploadComfyUIImage(
    providerConfig,
    {
      bytes: new Uint8Array([1, 2, 3]),
      filename: "unsafe.svg",
      mimeType: "image/svg+xml",
    },
    (async () => {
      uploadCalled = true;
      return new Response();
    }) as typeof fetch,
  ),
);
assert.equal(uploadCalled, false);

const redirected: RequestRedirect[] = [];
let retryCalls = 0;
const retried = await requestComfyUI(
  providerConfig,
  "/prompt",
  { method: "POST" },
  (async (_input, init) => {
    redirected.push(init?.redirect ?? "follow");
    retryCalls += 1;
    return retryCalls === 1
      ? new Response("busy", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      : new Response(JSON.stringify({ prompt_id: "retry-ok" }), {
          status: 200,
        });
  }) as typeof fetch,
  { attempts: 2, wait: async () => undefined },
);
assert.equal(retried.ok, true);
assert.equal(retryCalls, 2);
assert.deepEqual(redirected, ["error", "error"]);

const history = await getComfyUIHistory(
  providerConfig,
  "prompt-safe",
  (async (_input, init) => {
    assert.equal(init?.redirect, "error");
    return new Response(
      JSON.stringify({
        "prompt-safe": {
          status: { completed: true },
          outputs: {
            output: {
              images: [
                { filename: "valid.png", subfolder: "safe/output", type: "output" },
                { filename: "../secret.png", subfolder: "", type: "output" },
              ],
              gifs: [
                { filename: "clip.webp", subfolder: "", type: "output" },
              ],
            },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch,
);
assert.equal(history.state, "succeeded");
assert.equal(history.outputs.length, 2);
assert.equal(history.outputs.some((item) => item.filename.includes("..")), false);

process.env.COMFYUI_MAX_OUTPUT_BYTES = "8";
const tooLargeStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array(6));
    controller.enqueue(new Uint8Array(6));
    controller.close();
  },
});
await assert.rejects(() =>
  mirrorComfyUIHistoryOutput(
    providerConfig,
    {
      filename: "large.png",
      subfolder: "",
      type: "output",
      mediaKind: "image",
      nodeId: "output",
    },
    (async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(tooLargeStream, {
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch,
  ),
);
delete process.env.COMFYUI_MAX_OUTPUT_BYTES;
await assert.rejects(() =>
  mirrorComfyUIHistoryOutput(
    providerConfig,
    {
      filename: "fake.png",
      subfolder: "",
      type: "output",
      mediaKind: "image",
      nodeId: "output",
    },
    (async () =>
      new Response("<html>not an image</html>", {
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
  ),
);

let interruptCalls = 0;
const cancelResult = await cancelComfyUIJob(
  providerConfig,
  "someone-elses-running-job",
  { runningPromptId: "our-running-job" },
  (async (input) => {
    const url = String(input);
    if (url.endsWith("/queue")) {
      return new Response(
        JSON.stringify({
          queue_running: [[1, "someone-elses-running-job"]],
          queue_pending: [],
        }),
      );
    }
    if (url.endsWith("/interrupt")) interruptCalls += 1;
    return new Response();
  }) as typeof fetch,
);
assert.equal(cancelResult, "not_found");
assert.equal(interruptCalls, 0);

const trusted = new Request("http://127.0.0.1:4200/api/generation-jobs", {
  method: "POST",
  headers: {
    host: "127.0.0.1:4200",
    origin: "http://127.0.0.1:4200",
  },
});
assert.equal(isTrustedLoopbackMutationRequest(trusted), true);
assert.equal(
  isTrustedLoopbackMutationRequest(
    new Request("http://192.168.1.10:4200/api/generation-jobs", {
      method: "POST",
      headers: {
        host: "192.168.1.10:4200",
        origin: "http://192.168.1.10:4200",
      },
    }),
  ),
  false,
);
assert.equal(
  isTrustedLoopbackMutationRequest(
    new Request("http://127.0.0.1:4200/api/generation-jobs", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4200",
        origin: "https://evil.example",
      },
    }),
  ),
  false,
);

let promptSubmissions = 0;
const generationFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/prompt")) {
    promptSubmissions += 1;
    return new Response(JSON.stringify({ prompt_id: "job-prompt-1" }));
  }
  if (url.endsWith("/history/job-prompt-1")) {
    return new Response(
      JSON.stringify({
        "job-prompt-1": {
          status: { completed: true },
          outputs: {
            output: {
              images: [
                {
                  filename: "result.png",
                  subfolder: "aistory",
                  type: "output",
                },
              ],
            },
          },
        },
      }),
    );
  }
  if (url.includes("/view?")) {
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  }
  throw new Error(`Unexpected generation URL: ${url}`);
}) as typeof fetch;

const scheduler = new GenerationJobScheduler({
  fetcher: generationFetch,
  pollIntervalMs: 10,
  maxPolls: 5,
});
const input = {
  workflowId: "portrait-safe",
  modality: "image" as const,
  prompt: "同一幂等生成",
  width: 768,
  height: 1344,
  orientation: "portrait" as const,
  referenceRevision: "none",
  idempotencyKey: "same-request-123",
};
const [jobA, jobB] = await Promise.all([
  scheduler.submitComfyUI(input),
  scheduler.submitComfyUI(input),
]);
assert.equal(jobA.id, jobB.id);
for (let index = 0; index < 100; index += 1) {
  const current = await scheduler.get(jobA.id);
  if (current?.status === "succeeded") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const completed = await scheduler.get(jobA.id);
assert.equal(completed?.status, "succeeded");
assert.equal(completed?.artifact?.contentType, "image/png");
assert.equal(promptSubmissions, 1);
assert.equal(JSON.stringify(completed).includes("同一幂等生成"), false);
assert.equal(JSON.stringify(completed).includes("workflowFingerprint"), false);
const persistedCompleted = await getStoredGenerationJob(jobA.id);
assert.match(persistedCompleted?.workflowFingerprint ?? "", /^[a-f0-9]{64}$/);

const pinnedV1 = await getComfyUIWorkflowTemplate("portrait-safe");
assert.ok(pinnedV1);
if (!pinnedV1) throw new Error("Pinned workflow v1 is missing.");
process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-pinned-version");
const pinnedNow = new Date().toISOString();
await saveStoredGenerationJob({
  id: "pinned-version-job",
  provider: "comfyui",
  modality: "image",
  status: "queued",
  progress: 0,
  requestFingerprint: "pinned-version-request",
  idempotencyKey: "pinned-version-idempotency",
  workflowId: pinnedV1.template.id,
  workflowVersion: pinnedV1.version.version,
  workflowFingerprint: pinnedV1.version.fingerprint,
  attempts: 0,
  maxAttempts: 2,
  retryable: false,
  provenance: {
    purpose: "foreground",
    source: "aistory-studio",
    provider: "comfyui",
  },
  createdAt: pinnedNow,
  updatedAt: pinnedNow,
  input: {
    ...input,
    prompt: "execute the pinned v1 workflow",
    idempotencyKey: "pinned-version-idempotency",
  },
});
const pinnedV3Workflow = structuredClone(workflow("v3"));
const pinnedV3Nodes = pinnedV3Workflow.workflow as Record<string, unknown>;
pinnedV3Nodes["output-v3"] = pinnedV3Nodes.output;
delete pinnedV3Nodes.output;
pinnedV3Workflow.outputNodeIds = ["output-v3"];
const importedV3 = await importComfyUIWorkflowTemplate({
  id: "portrait-safe",
  name: "安全人像",
  modality: "image",
  enabled: true,
  workflow: pinnedV3Workflow,
});
assert.equal(importedV3.activeVersion, 3);
let pinnedPromptSubmissions = 0;
const pinnedScheduler = new GenerationJobScheduler({
  fetcher: (async (requestInput, init) => {
    const url = String(requestInput);
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/prompt")) {
      pinnedPromptSubmissions += 1;
      const body = JSON.parse(String(init?.body)) as {
        prompt?: Record<string, unknown>;
        extra_data?: { aistory?: { workflowVersion?: number } };
      };
      assert.equal(body.extra_data?.aistory?.workflowVersion, 1);
      assert.equal("output" in (body.prompt ?? {}), true);
      assert.equal("output-v3" in (body.prompt ?? {}), false);
      return new Response(JSON.stringify({ prompt_id: "pinned-v1-prompt" }));
    }
    if (url.endsWith("/history/pinned-v1-prompt")) {
      return new Response(JSON.stringify({
        "pinned-v1-prompt": {
          status: { completed: true },
          outputs: {
            output: {
              images: [{ filename: "pinned.png", subfolder: "", type: "output" }],
            },
          },
        },
      }));
    }
    if (url.includes("/view?")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`Unexpected pinned workflow URL: ${url}`);
  }) as typeof fetch,
  pollIntervalMs: 10,
  maxPolls: 5,
});
await pinnedScheduler.initialize();
for (let index = 0; index < 100; index += 1) {
  if ((await pinnedScheduler.get("pinned-version-job"))?.status === "succeeded") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(
  (await pinnedScheduler.get("pinned-version-job"))?.status,
  "succeeded",
);
assert.equal(pinnedPromptSubmissions, 1);
await configureComfyUIWorkflowTemplate("portrait-safe", { activeVersion: 1 });

const occupancyJob = (
  id: string,
  status: "queued" | "running" | "pending" | "succeeded" | "failed" | "cancelled" | "interrupted",
  workflowId = "portrait-safe",
) => ({
  id,
  provider: "comfyui" as const,
  modality: "image" as const,
  status,
  progress: 0,
  requestFingerprint: `${id}-fingerprint`,
  idempotencyKey: `${id}-idempotency`,
  workflowId,
  workflowVersion: 1,
  attempts: 0,
  maxAttempts: 2,
  retryable: false,
  provenance: {
    purpose: "foreground" as const,
    source: "aistory-studio" as const,
    provider: "comfyui" as const,
  },
  createdAt: pinnedNow,
  updatedAt: pinnedNow,
  input: { ...input, workflowId, idempotencyKey: `${id}-idempotency` },
});
for (const status of ["queued", "running", "pending"] as const) {
  process.env.AISTORY_GENERATION_JOB_DIR = path.join(
    testRoot,
    `jobs-occupancy-${status}`,
  );
  await saveStoredGenerationJob(occupancyJob(`occupancy-${status}`, status));
  assert.equal(await hasActiveComfyUIWorkflowSelection("portrait-safe"), true);
  assert.equal(await hasActiveComfyUIWorkflowSelection("other-workflow"), false);
}
process.env.AISTORY_GENERATION_JOB_DIR = path.join(
  testRoot,
  "jobs-occupancy-terminal",
);
for (const status of [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const) {
  await saveStoredGenerationJob(occupancyJob(`terminal-${status}`, status));
}
assert.equal(await hasActiveComfyUIWorkflowSelection("portrait-safe"), false);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-unpinned");
await saveStoredGenerationJob({
  ...occupancyJob("legacy-unpinned", "queued"),
  workflowFingerprint: undefined,
});
await saveStoredGenerationJob({
  ...occupancyJob("tampered-pin", "queued"),
  workflowFingerprint: "0".repeat(64),
});
await saveStoredGenerationJob({
  ...occupancyJob("missing-version", "queued"),
  workflowVersion: 999,
  workflowFingerprint: pinnedV1.version.fingerprint,
});
let invalidPinFetches = 0;
const invalidPinScheduler = new GenerationJobScheduler({
  fetcher: (async () => {
    invalidPinFetches += 1;
    throw new Error("Pinned-selection failures must precede provider fetch.");
  }) as typeof fetch,
  pollIntervalMs: 10,
});
await invalidPinScheduler.initialize();
for (let index = 0; index < 100; index += 1) {
  const jobs = await invalidPinScheduler.list();
  if (jobs.length === 3 && jobs.every((job) => job.status === "failed")) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const invalidPinJobs = await invalidPinScheduler.list();
assert.equal(invalidPinJobs.length, 3);
for (const invalidJob of invalidPinJobs) {
  assert.equal(invalidJob.status, "failed");
  assert.equal(invalidJob.errorCode, "workflow_selection_unavailable");
  assert.equal(invalidJob.retryable, false);
  assert.equal(JSON.stringify(invalidJob).includes("workflowFingerprint"), false);
}
assert.equal(invalidPinFetches, 0);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-race");
let enterIdle!: () => void;
let releaseIdle!: () => void;
const idleEntered = new Promise<void>((resolve) => {
  enterIdle = resolve;
});
const idleReleased = new Promise<void>((resolve) => {
  releaseIdle = resolve;
});
let blockIdleOnce = true;
const raceFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/prompt")) {
    return new Response(JSON.stringify({ prompt_id: "race-prompt" }));
  }
  if (url.endsWith("/history/race-prompt")) {
    return new Response(JSON.stringify({
      "race-prompt": {
        status: { completed: true },
        outputs: {
          output: {
            images: [{ filename: "race.png", subfolder: "", type: "output" }],
          },
        },
      },
    }));
  }
  if (url.includes("/view?")) {
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
  }
  throw new Error(`Unexpected race URL: ${url}`);
}) as typeof fetch;
const raceScheduler = new GenerationJobScheduler({
  fetcher: raceFetch,
  pollIntervalMs: 10,
  maxPolls: 5,
  beforeIdle: async () => {
    if (!blockIdleOnce) return;
    blockIdleOnce = false;
    enterIdle();
    await idleReleased;
  },
});
await raceScheduler.initialize();
await idleEntered;
const raceJob = await raceScheduler.submitComfyUI({
  ...input,
  prompt: "lost wakeup regression",
  idempotencyKey: "lost-wakeup-123",
});
releaseIdle();
for (let index = 0; index < 100; index += 1) {
  if ((await raceScheduler.get(raceJob.id))?.status === "succeeded") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal((await raceScheduler.get(raceJob.id))?.status, "succeeded");

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-cancel");
let promptStartedResolve!: () => void;
let promptReturnResolve!: () => void;
const promptStarted = new Promise<void>((resolve) => {
  promptStartedResolve = resolve;
});
const promptReturn = new Promise<void>((resolve) => {
  promptReturnResolve = resolve;
});
let queueDeleteCalls = 0;
const cancelWindowFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/prompt")) {
    promptStartedResolve();
    await promptReturn;
    return new Response(JSON.stringify({ prompt_id: "cancel-prompt" }));
  }
  if (url.endsWith("/queue") && (init?.method ?? "GET") === "GET") {
    return new Response(JSON.stringify({
      queue_running: [],
      queue_pending: [[1, "cancel-prompt"]],
    }));
  }
  if (url.endsWith("/queue") && init?.method === "POST") {
    queueDeleteCalls += 1;
    return new Response(JSON.stringify({ ok: true }));
  }
  throw new Error(`Unexpected cancel URL: ${url}`);
}) as typeof fetch;
const cancelScheduler = new GenerationJobScheduler({
  fetcher: cancelWindowFetch,
  pollIntervalMs: 10,
  maxPolls: 5,
});
const cancelJob = await cancelScheduler.submitComfyUI({
  ...input,
  prompt: "cancel before prompt id",
  idempotencyKey: "cancel-window-123",
});
await promptStarted;
const cancelRequestedJob = await cancelScheduler.cancel(cancelJob.id);
assert.equal(cancelRequestedJob.cancelRequested, true);
assert.equal(cancelRequestedJob.status, "running");
promptReturnResolve();
for (let index = 0; index < 100; index += 1) {
  if ((await cancelScheduler.get(cancelJob.id))?.status === "cancelled") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal((await cancelScheduler.get(cancelJob.id))?.status, "cancelled");
assert.equal(queueDeleteCalls, 1);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-lmd");
let lmdSubmitCount = 0;
let lmdSubmittedBody: Record<string, unknown> | undefined;
const lmdFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/api/v1/images") && init?.method === "POST") {
    lmdSubmitCount += 1;
    lmdSubmittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      success: true,
      data: { id: 11, task_id: "lmd-task-1", status: "pending" },
    }));
  }
  if (url.endsWith("/api/v1/tasks/lmd-task-1")) {
    return new Response(JSON.stringify({
      success: true,
      data: {
        id: "lmd-task-1",
        status: "completed",
        progress: 100,
        result: {
          image_generation_id: 11,
          image_url: "http://127.0.0.1:5679/media/result.png",
          local_path: "D:/private/never-return.png",
          status: "completed",
        },
      },
    }));
  }
  if (url.endsWith("/media/result.png")) {
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  }
  throw new Error(`Unexpected LocalMiniDrama URL: ${url}`);
}) as typeof fetch;
const lmdScheduler = new GenerationJobScheduler({
  fetcher: lmdFetch,
  pollIntervalMs: 10,
});
const lmdJob = await lmdScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "安全白名单图片",
  negativePrompt: "模糊",
  aspectRatio: "16:9",
  style: "cinematic",
  idempotencyKey: "lmd-image-123",
  provider: "untrusted-provider",
  model: "D:/must-not-leak.safetensors",
} as Parameters<typeof lmdScheduler.submitLocalMiniDramaImage>[0] & {
  provider: string;
  model: string;
});
for (let index = 0; index < 100; index += 1) {
  if ((await lmdScheduler.get(lmdJob.id))?.status === "succeeded") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const lmdCompleted = await lmdScheduler.get(lmdJob.id);
assert.equal(lmdCompleted?.status, "succeeded");
assert.equal(lmdCompleted?.artifact?.url.startsWith("/api/aistory-cache/media/"), true);
assert.equal(lmdCompleted?.artifact?.contentType, "image/png");
assert.equal(lmdCompleted?.artifact?.bytes, 4);
assert.equal(lmdSubmitCount, 1);
assert.equal("provider" in (lmdSubmittedBody ?? {}), false);
assert.equal("model" in (lmdSubmittedBody ?? {}), false);
assert.equal(JSON.stringify(lmdCompleted).includes("local_path"), false);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-lmd-cancel-after-submit");
let lmdCancelSubmitCount = 0;
let lmdPollStartedResolve!: () => void;
let lmdPollReleaseResolve!: () => void;
const lmdPollStarted = new Promise<void>((resolve) => {
  lmdPollStartedResolve = resolve;
});
const lmdPollRelease = new Promise<void>((resolve) => {
  lmdPollReleaseResolve = resolve;
});
const lmdCancelFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/api/v1/images")) {
    lmdCancelSubmitCount += 1;
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "lmd-cancel-terminal" },
    }));
  }
  if (url.endsWith("/api/v1/tasks/lmd-cancel-terminal")) {
    lmdPollStartedResolve();
    await lmdPollRelease;
    return new Response(JSON.stringify({
      success: true,
      data: {
        status: "completed",
        progress: 100,
        result: {
          status: "completed",
          image_url: "/media/cancel-completed.png",
        },
      },
    }));
  }
  if (url.endsWith("/media/cancel-completed.png")) {
    return new Response(new Uint8Array([1, 3, 5, 7]), {
      headers: { "content-type": "image/webp" },
    });
  }
  throw new Error(`Unexpected LMD cancel URL: ${url}`);
}) as typeof fetch;
const lmdCancelScheduler = new GenerationJobScheduler({
  fetcher: lmdCancelFetch,
  pollIntervalMs: 10,
  localMiniDramaMaxPolls: 5,
  localMiniDramaMaxDurationMs: 2_000,
});
const lmdCancelJob = await lmdCancelScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "cancel after donor submission",
  idempotencyKey: "lmd-cancel-after-post",
});
await lmdPollStarted;
const lmdCancelRequested = await lmdCancelScheduler.cancel(lmdCancelJob.id);
assert.equal(lmdCancelRequested.cancelRequested, true);
assert.equal(lmdCancelRequested.status, "pending");
lmdPollReleaseResolve();
for (let index = 0; index < 100; index += 1) {
  if ((await lmdCancelScheduler.get(lmdCancelJob.id))?.status === "succeeded") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const lmdCancelCompleted = await lmdCancelScheduler.get(lmdCancelJob.id);
assert.equal(lmdCancelCompleted?.status, "succeeded");
assert.equal(
  lmdCancelCompleted?.notes?.includes("cancel_requested_but_completed"),
  true,
);
assert.equal(lmdCancelCompleted?.artifact?.contentType, "image/webp");
assert.equal(lmdCancelSubmitCount, 1);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-lmd-timeout");
let lmdTimeoutSubmitCount = 0;
const lmdTimeoutFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/api/v1/images")) {
    lmdTimeoutSubmitCount += 1;
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "lmd-timeout-task" },
    }));
  }
  if (url.endsWith("/api/v1/tasks/lmd-timeout-task")) {
    return new Response(JSON.stringify({
      success: true,
      data: { status: "processing", progress: 20 },
    }));
  }
  throw new Error(`Unexpected LMD timeout URL: ${url}`);
}) as typeof fetch;
const lmdTimeoutScheduler = new GenerationJobScheduler({
  fetcher: lmdTimeoutFetch,
  pollIntervalMs: 10,
  localMiniDramaMaxPollIntervalMs: 20,
  localMiniDramaMaxPolls: 3,
  localMiniDramaMaxDurationMs: 2_000,
});
const lmdTimeoutJob = await lmdTimeoutScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "must time out without resubmit",
  idempotencyKey: "lmd-timeout-once",
});
for (let index = 0; index < 100; index += 1) {
  if ((await lmdTimeoutScheduler.get(lmdTimeoutJob.id))?.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const lmdTimedOut = await lmdTimeoutScheduler.get(lmdTimeoutJob.id);
assert.equal(lmdTimedOut?.status, "failed");
assert.equal(lmdTimedOut?.retryable, true);
assert.equal(lmdTimedOut?.providerTaskId, "lmd-timeout-task");
assert.equal(lmdTimedOut?.errorMessage?.includes("lmd-timeout-task"), true);
assert.equal(lmdTimeoutSubmitCount, 1);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-lmd-errors");
let lmdErrorSubmitCount = 0;
let lmdPollErrorCount = 0;
const lmdErrorFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/api/v1/images")) {
    lmdErrorSubmitCount += 1;
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "lmd-network-errors" },
    }));
  }
  if (url.endsWith("/api/v1/tasks/lmd-network-errors")) {
    lmdPollErrorCount += 1;
    throw new Error("connection reset");
  }
  throw new Error(`Unexpected LMD error URL: ${url}`);
}) as typeof fetch;
const lmdErrorScheduler = new GenerationJobScheduler({
  fetcher: lmdErrorFetch,
  pollIntervalMs: 10,
  localMiniDramaMaxPolls: 10,
  localMiniDramaMaxDurationMs: 2_000,
  localMiniDramaMaxConsecutiveErrors: 2,
});
const lmdErrorJob = await lmdErrorScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "network errors are bounded",
  idempotencyKey: "lmd-error-bounded",
});
for (let index = 0; index < 100; index += 1) {
  if ((await lmdErrorScheduler.get(lmdErrorJob.id))?.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const lmdErrorFailed = await lmdErrorScheduler.get(lmdErrorJob.id);
assert.equal(lmdErrorFailed?.status, "failed");
assert.equal(lmdErrorFailed?.retryable, true);
assert.equal(lmdErrorFailed?.errorMessage?.includes("lmd-network-errors"), true);
assert.equal(lmdErrorSubmitCount, 1);
assert.equal(lmdPollErrorCount, 2);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-lmd-path");
let unsafeArtifactFetches = 0;
const lmdPathFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/api/v1/images")) {
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "lmd-path-task" },
    }));
  }
  if (url.endsWith("/api/v1/tasks/lmd-path-task")) {
    return new Response(JSON.stringify({
      success: true,
      data: {
        status: "completed",
        result: {
          status: "completed",
          image_url: "D:\\private\\secret.png",
          local_path: "D:\\private\\secret.png",
        },
      },
    }));
  }
  unsafeArtifactFetches += 1;
  throw new Error(`Unsafe artifact fetch attempted: ${url}`);
}) as typeof fetch;
const lmdPathScheduler = new GenerationJobScheduler({
  fetcher: lmdPathFetch,
  pollIntervalMs: 10,
});
const lmdPathJob = await lmdPathScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "absolute path must not escape",
  idempotencyKey: "lmd-path-reject",
});
for (let index = 0; index < 100; index += 1) {
  if ((await lmdPathScheduler.get(lmdPathJob.id))?.status === "succeeded") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const lmdPathCompleted = await lmdPathScheduler.get(lmdPathJob.id);
assert.equal(lmdPathCompleted?.status, "succeeded");
assert.equal(lmdPathCompleted?.artifact, undefined);
assert.equal(lmdPathCompleted?.notes?.includes("artifact_unavailable"), true);
assert.equal(JSON.stringify(lmdPathCompleted).includes("D:\\\\private"), false);
assert.equal(unsafeArtifactFetches, 0);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-fingerprint");
let fingerprintPromptCount = 0;
const fingerprintFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/prompt")) {
    fingerprintPromptCount += 1;
    return new Response(JSON.stringify({
      prompt_id: `fingerprint-prompt-${fingerprintPromptCount}`,
    }));
  }
  if (url.includes("/history/fingerprint-prompt-")) {
    const id = url.split("/").at(-1)!;
    return new Response(JSON.stringify({
      [id]: {
        status: { completed: true },
        outputs: {
          output: {
            images: [{ filename: `${id}.png`, subfolder: "", type: "output" }],
          },
        },
      },
    }));
  }
  if (url.includes("/view?")) {
    return new Response(new Uint8Array([7, 8, 9]), {
      headers: { "content-type": "image/png" },
    });
  }
  throw new Error(`Unexpected fingerprint URL: ${url}`);
}) as typeof fetch;
const fingerprintScheduler = new GenerationJobScheduler({
  fetcher: fingerprintFetch,
  pollIntervalMs: 10,
});
const semanticBase = {
  ...input,
  prompt: "stable semantic content",
  seed: 4242,
};
const semanticA = await fingerprintScheduler.submitComfyUI({
  ...semanticBase,
  idempotencyKey: "semantic-comfy-a",
});
const semanticB = await fingerprintScheduler.submitComfyUI({
  ...semanticBase,
  idempotencyKey: "semantic-comfy-b",
});
assert.equal(semanticA.id, semanticB.id);
assert.equal(semanticA.requestFingerprint, semanticB.requestFingerprint);
const replayChangedBody = await fingerprintScheduler.submitComfyUI({
  ...semanticBase,
  prompt: "changed body but same submit id",
  idempotencyKey: "semantic-comfy-a",
});
assert.equal(replayChangedBody.id, semanticA.id);
const randomSeedA = await fingerprintScheduler.submitComfyUI({
  ...input,
  prompt: "random seed request",
  seed: undefined,
  idempotencyKey: "random-comfy-a",
});
const randomSeedB = await fingerprintScheduler.submitComfyUI({
  ...input,
  prompt: "random seed request",
  seed: undefined,
  idempotencyKey: "random-comfy-b",
});
assert.notEqual(randomSeedA.id, randomSeedB.id);
const randomStoredA = await getStoredGenerationJob(randomSeedA.id);
const randomStoredB = await getStoredGenerationJob(randomSeedB.id);
assert.equal(randomStoredA?.provider, "comfyui");
assert.equal(randomStoredB?.provider, "comfyui");
if (randomStoredA?.provider === "comfyui" && randomStoredB?.provider === "comfyui") {
  assert.equal(Number.isSafeInteger(randomStoredA.input.seed), true);
  assert.notEqual(randomStoredA.input.seed, randomStoredB.input.seed);
}
const forcedComfy = await fingerprintScheduler.submitComfyUI({
  ...semanticBase,
  force: true,
  idempotencyKey: "semantic-comfy-force",
});
assert.notEqual(forcedComfy.id, semanticA.id);
for (let index = 0; index < 300; index += 1) {
  const states = await Promise.all(
    [semanticA.id, randomSeedA.id, randomSeedB.id, forcedComfy.id].map((id) =>
      fingerprintScheduler.get(id),
    ),
  );
  if (states.every((job) => job?.status === "succeeded")) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal((await fingerprintScheduler.get(forcedComfy.id))?.status, "succeeded");

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-lmd-fingerprint");
let lmdFingerprintTask = 0;
const lmdFingerprintFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/api/v1/images")) {
    lmdFingerprintTask += 1;
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: `lmd-fingerprint-${lmdFingerprintTask}` },
    }));
  }
  if (url.includes("/api/v1/tasks/lmd-fingerprint-")) {
    return new Response(JSON.stringify({
      success: true,
      data: { status: "completed", progress: 100, result: { status: "completed" } },
    }));
  }
  throw new Error(`Unexpected LMD fingerprint URL: ${url}`);
}) as typeof fetch;
const lmdFingerprintScheduler = new GenerationJobScheduler({
  fetcher: lmdFingerprintFetch,
  pollIntervalMs: 10,
});
const lmdSemanticA = await lmdFingerprintScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "stable donor content",
  seed: 31337,
  idempotencyKey: "semantic-lmd-a",
});
const lmdSemanticB = await lmdFingerprintScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "stable donor content",
  seed: 31337,
  idempotencyKey: "semantic-lmd-b",
});
assert.equal(lmdSemanticA.id, lmdSemanticB.id);
const lmdRandomA = await lmdFingerprintScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "random donor content",
  idempotencyKey: "random-lmd-a",
});
const lmdRandomB = await lmdFingerprintScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "random donor content",
  idempotencyKey: "random-lmd-b",
});
assert.notEqual(lmdRandomA.id, lmdRandomB.id);
const lmdRandomStoredA = await getStoredGenerationJob(lmdRandomA.id);
const lmdRandomStoredB = await getStoredGenerationJob(lmdRandomB.id);
if (
  lmdRandomStoredA?.provider === "localminidrama" &&
  lmdRandomStoredB?.provider === "localminidrama"
) {
  assert.equal(Number.isSafeInteger(lmdRandomStoredA.input.seed), true);
  assert.notEqual(lmdRandomStoredA.input.seed, lmdRandomStoredB.input.seed);
}
const lmdForced = await lmdFingerprintScheduler.submitLocalMiniDramaImage({
  dramaId: 3,
  prompt: "stable donor content",
  seed: 31337,
  force: true,
  idempotencyKey: "semantic-lmd-force",
});
assert.notEqual(lmdForced.id, lmdSemanticA.id);
for (let index = 0; index < 300; index += 1) {
  const states = await Promise.all(
    [lmdSemanticA.id, lmdRandomA.id, lmdRandomB.id, lmdForced.id].map((id) =>
      lmdFingerprintScheduler.get(id),
    ),
  );
  if (states.every((job) => job?.status === "succeeded")) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal((await lmdFingerprintScheduler.get(lmdForced.id))?.status, "succeeded");

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-5xx");
let prompt5xxCalls = 0;
const noRetry5xxScheduler = new GenerationJobScheduler({
  fetcher: (async (input, init) => {
    assert.equal(init?.redirect, "error");
    if (String(input).endsWith("/prompt")) {
      prompt5xxCalls += 1;
      return new Response("uncertain", { status: 500 });
    }
    throw new Error(`Unexpected 5xx URL: ${String(input)}`);
  }) as typeof fetch,
  pollIntervalMs: 10,
});
const noRetryJob = await noRetry5xxScheduler.submitComfyUI({
  ...input,
  prompt: "no automatic 5xx resubmit",
  idempotencyKey: "no-5xx-retry-123",
});
for (let index = 0; index < 100; index += 1) {
  if ((await noRetry5xxScheduler.get(noRetryJob.id))?.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal((await noRetry5xxScheduler.get(noRetryJob.id))?.status, "failed");
assert.equal(prompt5xxCalls, 1);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-network-ambiguous");
let promptNetworkCalls = 0;
const networkAmbiguousScheduler = new GenerationJobScheduler({
  fetcher: (async (input, init) => {
    assert.equal(init?.redirect, "error");
    if (String(input).endsWith("/prompt")) {
      promptNetworkCalls += 1;
      throw new Error("socket disconnected after write");
    }
    throw new Error(`Unexpected network URL: ${String(input)}`);
  }) as typeof fetch,
  pollIntervalMs: 10,
});
const networkAmbiguousJob = await networkAmbiguousScheduler.submitComfyUI({
  ...input,
  prompt: "network ambiguity must not resubmit",
  idempotencyKey: "network-ambiguous-123",
});
for (let index = 0; index < 100; index += 1) {
  if ((await networkAmbiguousScheduler.get(networkAmbiguousJob.id))?.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(
  (await networkAmbiguousScheduler.get(networkAmbiguousJob.id))?.status,
  "failed",
);
assert.equal(promptNetworkCalls, 1);

process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs-restart");
const restartNow = new Date().toISOString();
await saveStoredGenerationJob({
  id: "restart-running-job",
  provider: "comfyui",
  modality: "image",
  status: "running",
  progress: 40,
  requestFingerprint: "restart-fingerprint",
  idempotencyKey: "restart-idempotency",
  workflowId: "portrait-safe",
  workflowVersion: 1,
  providerTaskId: "provider-before-restart",
  attempts: 1,
  maxAttempts: 2,
  retryable: false,
  provenance: {
    purpose: "foreground",
    source: "aistory-studio",
    provider: "comfyui",
  },
  createdAt: restartNow,
  updatedAt: restartNow,
  input: {
    ...input,
    seed: 99,
    idempotencyKey: "restart-idempotency",
  },
});
const restartedScheduler = new GenerationJobScheduler({
  fetcher: (async () => {
    throw new Error("Recovered running jobs must not call provider automatically.");
  }) as typeof fetch,
});
const recovered = (await restartedScheduler.list()).find(
  (job) => job.id === "restart-running-job",
);
assert.equal(recovered?.status, "interrupted");
assert.equal(recovered?.retryable, true);
assert.equal(recovered?.errorCode, "process_restarted");

await rm(testRoot, { recursive: true, force: true });
console.log("ComfyUI registry, transport, local security, and job tests passed.");
