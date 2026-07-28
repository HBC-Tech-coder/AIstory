import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const testRoot = path.resolve(
  process.cwd(),
  `.test-asset-continuity-${process.pid}-${Date.now()}`,
);
assert.equal(testRoot.startsWith(path.resolve(process.cwd()) + path.sep), true);
process.env.AISTORY_CACHE_DIR = path.join(testRoot, "cache");
process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs");
process.env.AISTORY_PROJECT_ASSET_DIR = path.join(testRoot, "assets");
process.env.AISTORY_COMFYUI_REGISTRY_DIR = path.join(testRoot, "registry");
process.env.COMFYUI_ENABLED = "true";
process.env.COMFYUI_BASE_URL = "http://127.0.0.1:8188";
delete process.env.COMFYUI_IMAGE_WORKFLOW_JSON;
await mkdir(testRoot, { recursive: true });

const { cacheMediaBytes } = await import("../lib/engine/mediaCache");
const {
  GenerationJobScheduler,
  generationRequestFingerprint,
} = await import("../lib/generation-jobs/server");
const { getStoredGenerationJob, saveStoredGenerationJob } = await import(
  "../lib/generation-jobs/store"
);
const { importComfyUIWorkflowTemplate } = await import(
  "../lib/providers/comfyui/registry"
);
const { adoptGenerationJobArtifact } = await import(
  "../lib/project-assets/server"
);
const { prepareProjectAssetComfyReference } = await import(
  "../lib/project-assets/comfyReference"
);
const { saveProjectAssetIfAbsent } = await import(
  "../lib/project-assets/repository"
);
const { POST: prepareReferenceRoute } = await import(
  "../app/api/providers/comfyui/project-asset-reference/route"
);
type StoredGenerationJob = import(
  "../lib/generation-jobs/types"
).StoredGenerationJob;
type ProjectAsset = import("../lib/project-assets/types").ProjectAsset;

const workflow = {
  workflow: {
    prompt: { class_type: "CLIPTextEncode", inputs: { text: "fixture" } },
    reference: { class_type: "LoadImage", inputs: { image: "" } },
    output: {
      class_type: "SaveImage",
      inputs: { images: ["prompt", 0] },
    },
  },
  outputNodeIds: ["output"],
  bindings: {
    positivePrompt: { nodeId: "prompt", input: "text" },
    referenceImages: {
      primary: { nodeId: "reference", input: "image" },
    },
    faceReference: { nodeId: "reference", input: "image" },
  },
};
await importComfyUIWorkflowTemplate({
  id: "continuity-image",
  name: "素材连续性测试",
  modality: "image",
  enabled: true,
  workflow,
});

function job(
  id: string,
  artifact: { url: string; contentType: string; bytes: number },
  modality: "image" | "video" = "image",
): StoredGenerationJob {
  const now = new Date().toISOString();
  return {
    id,
    provider: "comfyui",
    modality,
    status: "succeeded",
    progress: 100,
    requestFingerprint: `fingerprint-${id}`,
    idempotencyKey: `idempotency-${id}`,
    workflowId: "continuity-image",
    workflowVersion: 1,
    attempts: 1,
    maxAttempts: 1,
    retryable: false,
    artifact,
    provenance: {
      purpose: "foreground",
      source: "aistory-studio",
      provider: "comfyui",
    },
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    input: {
      workflowId: "continuity-image",
      modality,
      prompt: "private fixture prompt",
      seed: 100,
      orientation: "landscape",
      idempotencyKey: `idempotency-${id}`,
    },
  };
}

const firstBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
const firstCached = await cacheMediaBytes(firstBytes, "image/png");
const firstJob = job(randomUUID(), {
  url: firstCached.url,
  contentType: "image/png",
  bytes: firstBytes.byteLength,
});
await saveStoredGenerationJob(firstJob);
const firstAsset = (await adoptGenerationJobArtifact(501, firstJob.id)).asset;

let uploadCalls = 0;
let promptCalls = 0;
const mockFetch = (async (input, init) => {
  const url = String(input);
  assert.equal(init?.redirect, "error");
  if (url.endsWith("/system_stats")) {
    return new Response(JSON.stringify({ exec_info: { queue_remaining: 0 } }));
  }
  if (url.endsWith("/object_info")) {
    return new Response(JSON.stringify({ LoadImage: {}, SaveImage: {} }));
  }
  if (url.endsWith("/upload/image")) {
    uploadCalls += 1;
    assert.equal(init?.method, "POST");
    assert.equal(init?.body instanceof FormData, true);
    const image = (init?.body as FormData).get("image");
    assert.equal(image instanceof File, true);
    return new Response(
      JSON.stringify({
        name: (image as File).name,
        subfolder: "aistory",
        type: "input",
      }),
    );
  }
  if (url.endsWith("/prompt")) {
    promptCalls += 1;
    return new Response(JSON.stringify({ prompt_id: "next-prompt-001" }));
  }
  if (url.includes("/history/next-prompt-001")) {
    return new Response(
      JSON.stringify({
        "next-prompt-001": {
          outputs: {
            output: {
              images: [
                { filename: "next.png", subfolder: "", type: "output" },
              ],
            },
          },
          status: { completed: true, status_str: "success" },
        },
      }),
    );
  }
  if (url.includes("/view?")) {
    return new Response(Uint8Array.from([137, 80, 78, 71, 9, 9, 9]), {
      headers: { "content-type": "image/png", "content-length": "7" },
    });
  }
  throw new Error(`Unexpected fixture request: ${url}`);
}) as typeof fetch;

try {
  const [referenceA, referenceB] = await Promise.all([
    prepareProjectAssetComfyReference(501, firstAsset.id, mockFetch),
    prepareProjectAssetComfyReference(501, firstAsset.id, mockFetch),
  ]);
  assert.deepEqual(referenceA, referenceB);
  assert.equal(uploadCalls, 1);
  assert.equal(referenceA.assetId, firstAsset.id);
  assert.equal(referenceA.contentHash, firstAsset.contentHash);
  assert.equal(referenceA.name, `${firstAsset.id}.png`);
  assert.equal(JSON.stringify(referenceA).includes(firstAsset.url), false);
  assert.equal(JSON.stringify(referenceA).includes(firstJob.providerTaskId ?? "never"), false);
  assert.equal(
    (await prepareProjectAssetComfyReference(501, firstAsset.id, mockFetch))
      .referenceRevision,
    referenceA.referenceRevision,
  );
  assert.equal(uploadCalls, 1);

  await assert.rejects(
    () => prepareProjectAssetComfyReference(502, firstAsset.id, mockFetch),
    /not found in this project/,
  );

  const secondBytes = Uint8Array.from([137, 80, 78, 71, 5, 6, 7, 8]);
  const secondCached = await cacheMediaBytes(secondBytes, "image/png");
  const secondJob = job(randomUUID(), {
    url: secondCached.url,
    contentType: "image/png",
    bytes: secondBytes.byteLength,
  });
  await saveStoredGenerationJob(secondJob);
  const secondAsset = (await adoptGenerationJobArtifact(501, secondJob.id)).asset;
  const referenceC = await prepareProjectAssetComfyReference(
    501,
    secondAsset.id,
    mockFetch,
  );
  assert.notEqual(referenceA.referenceRevision, referenceC.referenceRevision);
  assert.equal(uploadCalls, 2);

  const baseInput = {
    workflowId: "continuity-image",
    modality: "image",
    prompt: "next generation",
    seed: 777,
    referenceImages: { primary: `aistory/${referenceA.name}` },
    referenceRevision: referenceA.referenceRevision,
  };
  const sameFingerprint = generationRequestFingerprint(
    { ...baseInput, idempotencyKey: "different-idempotency" },
    "continuity-image:1",
  );
  const firstFingerprint = generationRequestFingerprint(
    { ...baseInput, idempotencyKey: "first-idempotency" },
    "continuity-image:1",
  );
  const secondFingerprint = generationRequestFingerprint(
    {
      ...baseInput,
      referenceImages: { primary: `aistory/${referenceC.name}` },
      referenceRevision: referenceC.referenceRevision,
      idempotencyKey: "second-idempotency",
    },
    "continuity-image:1",
  );
  assert.equal(firstFingerprint, sameFingerprint);
  assert.notEqual(firstFingerprint, secondFingerprint);

  const videoBytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]);
  const videoCached = await cacheMediaBytes(videoBytes, "video/mp4");
  const videoJob = job(
    randomUUID(),
    {
      url: videoCached.url,
      contentType: "video/mp4",
      bytes: videoBytes.byteLength,
    },
    "video",
  );
  await saveStoredGenerationJob(videoJob);
  const videoAsset = (await adoptGenerationJobArtifact(501, videoJob.id)).asset;
  await assert.rejects(
    () => prepareProjectAssetComfyReference(501, videoAsset.id, mockFetch),
    /Only image assets/,
  );

  const fakeBase: ProjectAsset = {
    ...firstAsset,
    id: randomUUID(),
    jobId: randomUUID(),
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  };
  const malicious = {
    ...fakeBase,
    url: "/api/aistory-cache/media/../../private.png",
  };
  await saveProjectAssetIfAbsent(malicious);
  await assert.rejects(
    () => prepareProjectAssetComfyReference(501, malicious.id, mockFetch),
    /not a safe cached image/,
  );

  const missing = {
    ...fakeBase,
    id: randomUUID(),
    jobId: randomUUID(),
    url: `/api/aistory-cache/media/${"a".repeat(64)}.png`,
  };
  await saveProjectAssetIfAbsent(missing);
  await assert.rejects(
    () => prepareProjectAssetComfyReference(501, missing.id, mockFetch),
    /cache entry is missing/,
  );

  const tamperBytes = Uint8Array.from([137, 80, 78, 71, 3, 3, 3]);
  const tamperCached = await cacheMediaBytes(tamperBytes, "image/png");
  const tamperJob = job(randomUUID(), {
    url: tamperCached.url,
    contentType: "image/png",
    bytes: tamperBytes.byteLength,
  });
  await saveStoredGenerationJob(tamperJob);
  const tamperAsset = (await adoptGenerationJobArtifact(501, tamperJob.id)).asset;
  const tamperFile = tamperCached.url.split("/").at(-1)!;
  await writeFile(
    path.join(process.env.AISTORY_CACHE_DIR!, "media", tamperFile),
    Uint8Array.from([1, 2, 3]),
  );
  await assert.rejects(
    () => prepareProjectAssetComfyReference(501, tamperAsset.id, mockFetch),
    /integrity check failed/,
  );

  const notReadyFetch = (async (input, init) => {
    assert.equal(init?.redirect, "error");
    const url = String(input);
    if (url.endsWith("/system_stats")) return new Response("offline", { status: 503 });
    if (url.endsWith("/object_info")) return new Response("offline", { status: 503 });
    throw new Error("upload must not run while provider is offline");
  }) as typeof fetch;
  await assert.rejects(
    () => prepareProjectAssetComfyReference(501, secondAsset.id, notReadyFetch),
    /not ready/,
  );

  for (const headers of [
    { host: "192.168.1.20:4200", origin: "http://192.168.1.20:4200" },
    { host: "127.0.0.1:4200", origin: "http://evil.example" },
  ]) {
    const response = await prepareReferenceRoute(
      new Request("http://127.0.0.1:4200/api/providers/comfyui/project-asset-reference", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ projectId: 501, assetId: firstAsset.id }),
      }),
    );
    assert.equal(response.status, 403);
  }

  // M9 developer fixture: succeeded job -> adopt -> prepare reference -> next job.
  const scheduler = new GenerationJobScheduler({
    fetcher: mockFetch,
    pollIntervalMs: 1,
    maxPolls: 5,
  });
  const nextJob = await scheduler.submitComfyUI({
    workflowId: "continuity-image",
    modality: "image",
    prompt: "next generation from adopted project asset",
    referenceImages: { primary: `aistory/${referenceA.name}` },
    faceReference: `aistory/${referenceA.name}`,
    referenceRevision: referenceA.referenceRevision,
    seed: 777,
    width: 1344,
    height: 768,
    orientation: "landscape",
    idempotencyKey: "fixture-next-generation-job",
  });
  let completed = await getStoredGenerationJob(nextJob.id);
  for (let attempt = 0; attempt < 50 && completed?.status !== "succeeded"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    completed = await getStoredGenerationJob(nextJob.id);
  }
  assert.equal(completed?.status, "succeeded");
  assert.equal(completed?.input.referenceRevision, referenceA.referenceRevision);
  assert.equal(promptCalls, 1);

  console.log("Project asset continuity fixture passed and used only a temporary store.");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
