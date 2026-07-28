import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const testRoot = path.resolve(
  process.cwd(),
  `.test-project-assets-${process.pid}-${Date.now()}`,
);
assert.equal(testRoot.startsWith(path.resolve(process.cwd()) + path.sep), true);
process.env.AISTORY_CACHE_DIR = path.join(testRoot, "cache");
process.env.AISTORY_GENERATION_JOB_DIR = path.join(testRoot, "jobs");
process.env.AISTORY_PROJECT_ASSET_DIR = path.join(testRoot, "assets");
await mkdir(testRoot, { recursive: true });

const { cacheMediaBytes } = await import("../lib/engine/mediaCache");
const { saveStoredGenerationJob } = await import(
  "../lib/generation-jobs/store"
);
const { adoptGenerationJobArtifact } = await import(
  "../lib/project-assets/server"
);
const { listProjectAssets } = await import(
  "../lib/project-assets/repository"
);
const { POST } = await import("../app/api/project-assets/route");

const now = new Date().toISOString();
const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const cached = await cacheMediaBytes(imageBytes, "image/png");

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function comfyJob(
  index: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: uuid(index),
    provider: "comfyui" as const,
    modality: "image" as const,
    status: "succeeded" as const,
    progress: 100,
    requestFingerprint: `fingerprint-${index}`,
    idempotencyKey: `idempotency-${index}`,
    workflowId: "portrait-v1",
    workflowVersion: 3,
    providerTaskId: `provider-${index}`,
    attempts: 1,
    maxAttempts: 1,
    retryable: false,
    artifact: {
      url: cached.url,
      contentType: "image/png",
      bytes: imageBytes.byteLength,
    },
    provenance: {
      purpose: "foreground" as const,
      source: "aistory-studio" as const,
      provider: "comfyui" as const,
    },
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    input: {
      workflowId: "portrait-v1",
      modality: "image" as const,
      prompt: "PRIVATE PROMPT MUST NOT ENTER ASSET DTO",
      negativePrompt: "PRIVATE NEGATIVE PROMPT",
      checkpoint: "D:\\private-models\\checkpoint.safetensors",
      seed: 42 + index,
      width: 768,
      height: 1344,
      orientation: "portrait" as const,
      idempotencyKey: `idempotency-${index}`,
      apiKey: "must-never-be-copied",
    },
    ...overrides,
  };
}

try {
  const primary = comfyJob(1);
  await saveStoredGenerationJob(primary);
  const concurrent = await Promise.all(
    Array.from({ length: 12 }, () =>
      adoptGenerationJobArtifact(101, primary.id),
    ),
  );
  assert.equal(concurrent.filter((result) => result.created).length, 1);
  assert.equal(new Set(concurrent.map((result) => result.asset.id)).size, 1);

  const project101 = await listProjectAssets(101);
  assert.equal(project101.total, 1);
  assert.equal(project101.items[0]?.projectId, 101);
  assert.equal(project101.items[0]?.jobId, primary.id);
  assert.equal(project101.items[0]?.bytes, imageBytes.byteLength);
  assert.equal(project101.items[0]?.contentType, "image/png");
  assert.equal(project101.items[0]?.orientation, "portrait");
  assert.equal(project101.items[0]?.workflow?.version, 3);
  assert.equal(project101.items[0]?.seed, 43);

  const serialized = JSON.stringify(project101);
  for (const secret of [
    "PRIVATE PROMPT",
    "PRIVATE NEGATIVE",
    "private-models",
    "apiKey",
    "providerTaskId",
  ]) {
    assert.equal(serialized.includes(secret), false, `DTO leaked ${secret}`);
  }

  const crossProject = await adoptGenerationJobArtifact(202, primary.id);
  assert.equal(crossProject.created, true);
  assert.equal((await listProjectAssets(101)).total, 1);
  assert.equal((await listProjectAssets(202)).total, 1);

  for (let index = 2; index <= 9; index += 1) {
    await saveStoredGenerationJob(comfyJob(index));
  }
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      adoptGenerationJobArtifact(101, uuid(index + 2)),
    ),
  );
  assert.equal((await listProjectAssets(101)).total, 9);

  const persisted = JSON.parse(
    await readFile(
      path.join(process.env.AISTORY_PROJECT_ASSET_DIR!, "project-assets.json"),
      "utf8",
    ),
  ) as { schemaVersion?: number; assets?: unknown[] };
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.assets?.length, 10);
  assert.equal((await listProjectAssets(101)).total, 9);

  const failed = comfyJob(20, {
    status: "failed",
    artifact: undefined,
  });
  await saveStoredGenerationJob(failed);
  await assert.rejects(
    () => adoptGenerationJobArtifact(101, failed.id),
    /Only successful/,
  );

  const external = comfyJob(21, {
    artifact: {
      url: "https://example.com/private.png",
      contentType: "image/png",
      bytes: imageBytes.byteLength,
    },
  });
  await saveStoredGenerationJob(external);
  await assert.rejects(
    () => adoptGenerationJobArtifact(101, external.id),
    /cached media URL/,
  );

  const traversal = comfyJob(22, {
    artifact: {
      url: "/api/aistory-cache/media/../../private.png",
      contentType: "image/png",
      bytes: imageBytes.byteLength,
    },
  });
  await saveStoredGenerationJob(traversal);
  await assert.rejects(
    () => adoptGenerationJobArtifact(101, traversal.id),
    /cached media URL/,
  );

  const badMetadata = comfyJob(23, {
    artifact: {
      url: cached.url,
      contentType: "image/png",
      bytes: imageBytes.byteLength + 1,
    },
  });
  await saveStoredGenerationJob(badMetadata);
  await assert.rejects(
    () => adoptGenerationJobArtifact(101, badMetadata.id),
    /metadata does not match/,
  );

  const lmd = {
    ...comfyJob(24),
    provider: "localminidrama" as const,
    workflowId: undefined,
    workflowVersion: undefined,
    provenance: {
      purpose: "foreground" as const,
      source: "aistory-studio" as const,
      provider: "localminidrama" as const,
    },
    input: {
      dramaId: 101,
      prompt: "private",
      aspectRatio: "16:9" as const,
      seed: 9,
      idempotencyKey: "lmd-idempotency",
    },
  };
  await saveStoredGenerationJob(lmd);
  await assert.rejects(
    () => adoptGenerationJobArtifact(202, lmd.id),
    /different project/,
  );

  const forbidden = await POST(
    new Request("http://192.168.1.20:4200/api/project-assets", {
      method: "POST",
      headers: {
        host: "192.168.1.20:4200",
        origin: "http://192.168.1.20:4200",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: 101, jobId: primary.id }),
    }),
  );
  assert.equal(forbidden.status, 403);

  const evilOrigin = await POST(
    new Request("http://127.0.0.1:4200/api/project-assets", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4200",
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: 101, jobId: primary.id }),
    }),
  );
  assert.equal(evilOrigin.status, 403);

  console.log("Project asset registry tests passed.");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
