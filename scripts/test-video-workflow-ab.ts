import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import type { AdminActor } from "@/lib/admin/types";
import type { ProjectAsset } from "@/lib/project-assets/types";
import { canonicalJson, canonicalSha256 } from "@/lib/video-workflow-ab/canonical";
import {
  inspectZipCentralDirectory,
  validateVideoWorkflowABPackage,
  type VideoWorkflowABProbeResult,
} from "@/lib/video-workflow-ab/package";
import { LocalVideoWorkflowABRepository } from "@/lib/video-workflow-ab/repository";
import {
  adoptApprovedVideoWorkflowABRun,
  importVideoWorkflowABExperiment,
  listVideoWorkflowABExperiments,
  mutateVideoWorkflowABExperiment,
  videoWorkflowABCapabilityStatus,
} from "@/lib/video-workflow-ab/server";
import type {
  VideoWorkflowABPackageManifest,
  VideoWorkflowABReviewScores,
  VideoWorkflowABRunManifest,
} from "@/lib/video-workflow-ab/types";
import { validateVideoWorkflowABManifest } from "@/lib/video-workflow-ab/validation";

const actor: AdminActor = {
  userId: "local-admin",
  roles: ["super_admin"],
  mode: "local",
};
const productionActor: AdminActor = {
  userId: "00000000-0000-4000-8000-000000000001",
  roles: ["super_admin"],
  mode: "production",
};
const scores: VideoWorkflowABReviewScores = {
  firstFrameFidelity: 4,
  lastFrameIdentityFidelity: 4,
  characterConsistency: 4,
  motionCoherence: 4,
  artifactCleanliness: 4,
};

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x69, 0x73, 0x6f, 0x32,
]);
const webm = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88,
  0x77, 0x65, 0x62, 0x6d,
]);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const workflowA = { "1": { class_type: "WanOfficial", inputs: { seed: 42 } } };
const workflowB = {
  "1": { class_type: "WanOfficial", inputs: { seed: 42 } },
  "2": { class_type: "ModelOffload", inputs: { device: "cpu" } },
};
const workflowABytes = Buffer.from(canonicalJson(workflowA));
const workflowBBytes = Buffer.from(canonicalJson(workflowB));
const imageHash = hash("project-input-image");
const weightHashes = {
  diffusion: hash("official-diffusion"),
  vae: hash("official-vae"),
  text_encoder: hash("official-text-encoder"),
};

function outputReference(runId: string) {
  return {
    path: `runs/${runId}/output.mp4`,
    sha256: hash(mp4),
    bytes: mp4.byteLength,
    contentType: "video/mp4",
    durationMs: 2_000,
    width: 128,
    height: 64,
    videoCodec: "h264",
    hasAudio: false,
    frameCount: 16,
    fps: 8,
  };
}

function frameReference(runId: string, name: "first" | "last") {
  return {
    path: `runs/${runId}/${name}-frame.png`,
    sha256: hash(png),
    bytes: png.byteLength,
    contentType: "image/png",
  };
}

function run(
  id: string,
  variantId: "A" | "B",
  pairIndex: number,
  executionOrder: number,
  warmup = false,
): VideoWorkflowABRunManifest {
  return {
    id,
    variantId,
    pairIndex,
    executionOrder,
    warmup,
    status: "succeeded",
    queuedMs: 10,
    generationMs: 1_500,
    totalMs: 1_650,
    peakVramMiB: 18_000,
    output: outputReference(id),
    firstFrame: frameReference(id, "first"),
    lastFrame: frameReference(id, "last"),
  };
}

function manifest(
  experimentId = "wan-ab-test-1",
  synthetic = false,
): VideoWorkflowABPackageManifest {
  return {
    schemaVersion: "aistory-video-workflow-ab-v1",
    experiment: {
      id: experimentId,
      projectId: 7,
      title: "Wan2.2 5B 官方与 4090 优化 A/B",
      synthetic,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    input: {
      imageAssetId: "image-asset-1",
      imageSha256: imageHash,
      promptSha256: hash("same prompt"),
      negativePromptSha256: hash("same negative"),
      seed: 42,
      width: 128,
      height: 64,
      frameCount: 16,
      fps: 8,
      samplingSemanticsSha256: hash("steps=20;cfg=5;scheduler=official"),
    },
    environment: {
      comfyuiVersion: "0.3-fixture",
      comfyuiCommit: "fixture-commit",
      gpuModel: "Synthetic RTX 4090",
      gpuVramMiB: 24_576,
      driverVersion: "fixture-driver",
      cudaVersion: "fixture-cuda",
      pytorchVersion: "fixture-torch",
    },
    weights: [
      {
        role: "diffusion",
        fileName: "wan2.2_ti2v_5B_fp16.safetensors",
        sha256: weightHashes.diffusion,
        sourceUrl: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B",
        sourceRevision: "fixture-revision",
        licenseId: "Apache-2.0",
        licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      },
      {
        role: "vae",
        fileName: "wan2.2_vae.safetensors",
        sha256: weightHashes.vae,
        sourceUrl: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B",
        sourceRevision: "fixture-revision",
        licenseId: "Apache-2.0",
        licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      },
      {
        role: "text_encoder",
        fileName: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        sha256: weightHashes.text_encoder,
        sourceUrl: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
        sourceRevision: "fixture-revision",
        licenseId: "Apache-2.0",
        licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      },
    ],
    variants: [
      {
        id: "A",
        kind: "official_baseline",
        workflowPath: "workflows/A.json",
        workflowSha256: canonicalSha256(workflowA),
        workflowSourceUrl: "https://docs.comfy.org/tutorials/video/wan/wan2_2",
        workflowSourceRevision: "official-template-fixture",
        weightSha256ByRole: weightHashes,
        thirdPartyLoras: [],
        optimizationChanges: [],
        postprocess: { enabled: false },
      },
      {
        id: "B",
        kind: "aistory_4090_optimized",
        workflowPath: "workflows/B.json",
        workflowSha256: canonicalSha256(workflowB),
        parentWorkflowSha256: canonicalSha256(workflowA),
        workflowSourceUrl: "https://docs.comfy.org/tutorials/video/wan/wan2_2",
        workflowSourceRevision: "aistory-fixture-copy",
        weightSha256ByRole: weightHashes,
        thirdPartyLoras: [],
        optimizationChanges: ["model_offload"],
        postprocess: { enabled: false },
      },
    ],
    runs: [
      run("warmup-a", "A", 0, 1, true),
      run("warmup-b", "B", 0, 2, true),
      run("pair-1-a", "A", 1, 3),
      run("pair-1-b", "B", 1, 4),
      run("pair-2-b", "B", 2, 5),
      run("pair-2-a", "A", 2, 6),
    ],
  };
}

async function packageBytes(
  source: VideoWorkflowABPackageManifest,
  mutateZip?: (zip: JSZip) => void,
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("ab-manifest.json", canonicalJson(source));
  zip.file("workflows/A.json", workflowABytes);
  zip.file("workflows/B.json", workflowBBytes);
  for (const item of source.runs) {
    if (!item.output || !item.firstFrame || !item.lastFrame) continue;
    zip.file(item.output.path, mp4);
    zip.file(item.firstFrame.path, png);
    zip.file(item.lastFrame.path, png);
  }
  mutateZip?.(zip);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}

const fakeProbe: VideoWorkflowABProbeResult = {
  durationMs: 2_000,
  width: 128,
  height: 64,
  videoCodec: "h264",
  hasAudio: false,
  frameCount: 16,
  fps: 8,
};

function centralOnlyZip(
  entries: Array<{ name: string; mode?: number; bytes?: number }>,
): Buffer {
  const local = Buffer.alloc(4);
  local.writeUInt32LE(0x04034b50, 0);
  const centralParts = entries.map((entry) => {
    const name = Buffer.from(entry.name);
    const part = Buffer.alloc(46 + name.length);
    part.writeUInt32LE(0x02014b50, 0);
    part.writeUInt16LE(0x0800, 8);
    part.writeUInt16LE(0, 10);
    part.writeUInt32LE(entry.bytes ?? 0, 20);
    part.writeUInt32LE(entry.bytes ?? 0, 24);
    part.writeUInt16LE(name.length, 28);
    part.writeUInt32LE(((entry.mode ?? 0o100644) * 0x10000) >>> 0, 38);
    name.copy(part, 46);
    return part;
  });
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

const validatedManifest = validateVideoWorkflowABManifest(manifest());
assert.equal(validatedManifest.variants[0].workflowSha256, canonicalSha256(workflowA));
assert.throws(
  () =>
    validateVideoWorkflowABManifest({
      ...manifest(),
      variants: [
        manifest().variants[0],
        { ...manifest().variants[1], thirdPartyLoras: ["forbidden"] },
      ],
    }),
  /LoRA/,
);
assert.throws(
  () =>
    validateVideoWorkflowABManifest({
      ...manifest(),
      variants: [
        manifest().variants[0],
        {
          ...manifest().variants[1],
          weightSha256ByRole: {
            ...weightHashes,
            diffusion: hash("different-weight"),
          },
        },
      ],
    }),
  /identical official weight/,
);
assert.throws(
  () =>
    validateVideoWorkflowABManifest({
      ...manifest(),
      variants: [
        manifest().variants[0],
        {
          ...manifest().variants[1],
          optimizationChanges: ["quantized_weights"],
        },
      ],
    }),
  /allowlisted/,
);
assert.throws(
  () =>
    validateVideoWorkflowABManifest({
      ...manifest(),
      variants: [
        { ...manifest().variants[0], postprocess: { enabled: true } },
        manifest().variants[1],
      ],
    }),
  /postprocessing/,
);
assert.throws(
  () =>
    validateVideoWorkflowABManifest({
      ...manifest(),
      variants: [
        {
          ...manifest().variants[0],
          workflowPath: "misc/official.json",
        },
        manifest().variants[1],
      ],
    }),
  /package layout/,
);
const invalidRunLayout = manifest();
invalidRunLayout.runs[0]!.output!.path = "outputs/renamed.mp4";
assert.throws(
  () => validateVideoWorkflowABManifest(invalidRunLayout),
  /package layout/,
);

assert.throws(
  () =>
    inspectZipCentralDirectory(
      centralOnlyZip([{ name: "../escape.txt" }]),
    ),
  /unsafe/,
);
assert.throws(
  () =>
    inspectZipCentralDirectory(
      centralOnlyZip([
        { name: "same.txt" },
        { name: "SAME.txt" },
      ]),
    ),
  /duplicate/,
);
assert.throws(
  () =>
    inspectZipCentralDirectory(
      centralOnlyZip([{ name: "link", mode: 0o120777 }]),
    ),
  /symbolic links/,
);
assert.throws(
  () =>
    inspectZipCentralDirectory(
      centralOnlyZip([{ name: "huge.bin", bytes: 1000 }]),
      { maxExpandedBytes: 100 },
    ),
  /expanded size/,
);

const validPackage = await packageBytes(manifest());
const validatedPackage = await validateVideoWorkflowABPackage(validPackage, {
  probeVideo: async () => fakeProbe,
});
assert.equal(validatedPackage.manifest.runs.length, 6);

await assert.rejects(
  validateVideoWorkflowABPackage(
    await packageBytes(manifest(), (zip) => {
      zip.file("extra/private.txt", "not declared");
    }),
    { probeVideo: async () => fakeProbe },
  ),
  /undeclared files/,
);

const badHashManifest = manifest();
badHashManifest.runs[0]!.output!.sha256 = hash("wrong");
await assert.rejects(
  validateVideoWorkflowABPackage(await packageBytes(badHashManifest), {
    probeVideo: async () => fakeProbe,
  }),
  /integrity|hash/,
);

const mismatchPackageManifest = manifest();
mismatchPackageManifest.runs[0]!.output = {
  ...mismatchPackageManifest.runs[0]!.output!,
  sha256: hash(webm),
  bytes: webm.byteLength,
};
const mismatchZip = new JSZip();
mismatchZip.file("ab-manifest.json", canonicalJson(mismatchPackageManifest));
mismatchZip.file("workflows/A.json", workflowABytes);
mismatchZip.file("workflows/B.json", workflowBBytes);
for (const item of mismatchPackageManifest.runs) {
  if (!item.output || !item.firstFrame || !item.lastFrame) continue;
  mismatchZip.file(item.output.path, item.id === "warmup-a" ? webm : mp4);
  mismatchZip.file(item.firstFrame.path, png);
  mismatchZip.file(item.lastFrame.path, png);
}
await assert.rejects(
  validateVideoWorkflowABPackage(
    await mismatchZip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    { probeVideo: async () => fakeProbe },
  ),
  /MIME|content validation|MP4|WebM/,
);
await assert.rejects(
  validateVideoWorkflowABPackage(validPackage, {
    probeVideo: async () => ({ ...fakeProbe, width: 256 }),
  }),
  /probe metadata/,
);

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-video-ab-test-"));
try {
  const repository = new LocalVideoWorkflowABRepository(root);
  const fakeInputAsset: ProjectAsset = {
    id: "image-asset-1",
    projectId: 7,
    jobId: "fixture-image-job",
    provider: "comfyui",
    modality: "image",
    status: "ready",
    name: "Fixture input",
    url: "/api/aistory-cache/media/fixture.png",
    contentHash: imageHash,
    contentType: "image/png",
    bytes: 12,
    orientation: "landscape",
    provenance: {
      source: "aistory-generation-job",
      requestFingerprint: hash("fixture-request"),
      generationStatus: "succeeded",
    },
    generatedAt: "2026-07-29T00:00:00.000Z",
    createdAt: "2026-07-29T00:00:00.000Z",
  };
  let randomCounter = 0;
  const serviceOptions = {
    repository,
    allowTestAdapter: true,
    packageValidation: {
      probeVideo: async () => fakeProbe,
    },
    resolveProjectAsset: async () => fakeInputAsset,
    randomId: () => `00000000-0000-4000-8000-${String(++randomCounter).padStart(12, "0")}`,
    now: () => new Date("2026-07-29T01:00:00.000Z"),
  };
  const imported = await importVideoWorkflowABExperiment(
    actor,
    {
      packageBytes: validPackage,
      reason: "导入安全 A/B 测试包",
      idempotencyKey: "video-ab-import:test-1",
      requestId: "request-import-1",
    },
    serviceOptions,
  );
  assert.equal(imported.created, true);
  assert.equal(imported.experiment.status, "completed");
  assert.equal(imported.experiment.synthetic, false);
  const blinded = JSON.stringify(imported.experiment);
  assert.equal(blinded.includes("variantId"), false);
  assert.equal(blinded.includes("workflowFile"), false);
  assert.equal(blinded.includes("artifactFile"), false);
  assert.equal(blinded.includes("actorId"), false);
  assert.equal(blinded.includes("same prompt"), false);
  assert.equal(blinded.includes(root), false);

  const replay = await importVideoWorkflowABExperiment(
    actor,
    {
      packageBytes: validPackage,
      reason: "导入安全 A/B 测试包",
      idempotencyKey: "video-ab-import:test-1",
      requestId: "request-import-2",
    },
    serviceOptions,
  );
  assert.equal(replay.created, false);
  await assert.rejects(
    importVideoWorkflowABExperiment(
      actor,
      {
        packageBytes: validPackage,
        reason: "相同包但更换导入理由",
        idempotencyKey: "video-ab-import:test-1",
        requestId: "request-import-reason-conflict",
      },
      serviceOptions,
    ),
    /conflicts/,
  );
  await assert.rejects(
    importVideoWorkflowABExperiment(
      actor,
      {
        packageBytes: await packageBytes(manifest("wan-ab-conflict")),
        reason: "复用冲突幂等键",
        idempotencyKey: "video-ab-import:test-1",
        requestId: "request-import-3",
      },
      serviceOptions,
    ),
    /conflicts/,
  );

  const firstMeasured = imported.experiment.runs.find(
    (item) => !item.warmup && item.status === "succeeded",
  )!;
  await assert.rejects(
    adoptApprovedVideoWorkflowABRun(
      actor,
      imported.experiment.id,
      {
        reason: "批准前禁止纳管",
        idempotencyKey: "video-ab-adopt:too-early",
        requestId: "adopt-too-early",
      },
      serviceOptions,
    ),
    /Only an approved/,
  );
  await assert.rejects(
    mutateVideoWorkflowABExperiment(
      actor,
      imported.experiment.id,
      {
        action: "approve",
        blindRunId: firstMeasured.blindId,
        reason: "审核前禁止批准",
        idempotencyKey: "video-ab-approve:too-early",
        requestId: "approve-too-early",
      },
      serviceOptions,
    ),
    /reviewed and revealed/,
  );

  let current = imported.experiment;
  for (const runDto of current.runs.filter(
    (item) => !item.warmup && item.status === "succeeded",
  )) {
    const reviewed = await mutateVideoWorkflowABExperiment(
      actor,
      current.id,
      {
        action: "review_run",
        blindRunId: runDto.blindId,
        scores,
        note: "盲评测试备注",
        reason: "记录盲评评分",
        idempotencyKey: `video-ab-review:${runDto.blindId}`,
        requestId: `review-${runDto.blindId}`,
      },
      serviceOptions,
    );
    current = reviewed.experiment;
  }
  assert.equal(current.eligibleForApproval, true);
  const finalizeInput = {
    action: "finalize_review" as const,
    reason: "完成交错多轮盲评",
    idempotencyKey: "video-ab-finalize:test-1",
    requestId: "finalize-1",
  };
  current = (
    await mutateVideoWorkflowABExperiment(
      actor,
      current.id,
      finalizeInput,
      serviceOptions,
    )
  ).experiment;
  assert.equal(current.status, "reviewed");
  assert.equal(current.revealed, false);
  assert.equal(JSON.stringify(current).includes("variantId"), false);
  const finalizeReplay = await mutateVideoWorkflowABExperiment(
    actor,
    current.id,
    finalizeInput,
    serviceOptions,
  );
  assert.equal(finalizeReplay.changed, false);
  assert.equal(finalizeReplay.experiment.status, "reviewed");
  current = (
    await mutateVideoWorkflowABExperiment(
      actor,
      current.id,
      {
        action: "reveal",
        reason: "盲评完成后揭盲",
        idempotencyKey: "video-ab-reveal:test-1",
        requestId: "reveal-1",
      },
      serviceOptions,
    )
  ).experiment;
  assert.equal(current.revealed, true);
  assert.equal(current.runs.every((item) => Boolean(item.variantId)), true);

  const winningRun = current.runs.find(
    (item) => !item.warmup && item.variantId === "B",
  )!;
  current = (
    await mutateVideoWorkflowABExperiment(
      actor,
      current.id,
      {
        action: "approve",
        blindRunId: winningRun.blindId,
        reason: "批准盲评后选中的真实 run",
        idempotencyKey: "video-ab-approve:test-1",
        requestId: "approve-1",
      },
      serviceOptions,
    )
  ).experiment;
  assert.equal(current.status, "approved");

  let savedAsset: ProjectAsset | undefined;
  const adopted = await adoptApprovedVideoWorkflowABRun(
    actor,
    current.id,
    {
      reason: "批准后加入项目素材库",
      idempotencyKey: "video-ab-adopt:test-1",
      requestId: "adopt-1",
    },
    {
      ...serviceOptions,
      mirrorMedia: async () => ({
        url: `/api/aistory-cache/media/${hash(mp4)}.mp4`,
        file: `${hash(mp4)}.mp4`,
      }),
      saveProjectAsset: async (candidate) => {
        savedAsset = candidate;
        return { asset: candidate, created: true };
      },
    },
  );
  assert.equal(adopted.videoAssetReviewRequired, true);
  assert.equal(savedAsset?.provenance.source, "aistory-video-ab-experiment");
  assert.equal("publicUrl" in adopted.asset, false);
  assert.equal(adopted.experiment.adoptedProjectAssetId, adopted.asset.id);
  current = (
    await mutateVideoWorkflowABExperiment(
      actor,
      current.id,
      {
        action: "offline",
        reason: "下线实验不等于发布素材",
        idempotencyKey: "video-ab-offline:test-1",
        requestId: "offline-1",
      },
      serviceOptions,
    )
  ).experiment;
  assert.equal(current.status, "offline");

  let synthetic = (
    await importVideoWorkflowABExperiment(
      actor,
      {
        packageBytes: await packageBytes(manifest("wan-ab-synthetic", true)),
        reason: "导入明确标识的合成演示包",
        idempotencyKey: "video-ab-import:synthetic",
        requestId: "import-synthetic",
      },
      serviceOptions,
    )
  ).experiment;
  for (const runDto of synthetic.runs.filter(
    (item) => !item.warmup && item.status === "succeeded",
  )) {
    synthetic = (
      await mutateVideoWorkflowABExperiment(
        actor,
        synthetic.id,
        {
          action: "review_run",
          blindRunId: runDto.blindId,
          scores,
          note: "合成 fixture 仅用于契约演示",
          reason: "记录合成 fixture 盲评",
          idempotencyKey: `video-ab-synthetic-review:${runDto.blindId}`,
          requestId: `synthetic-review-${runDto.blindId}`,
        },
        serviceOptions,
      )
    ).experiment;
  }
  synthetic = (
    await mutateVideoWorkflowABExperiment(
      actor,
      synthetic.id,
      {
        action: "finalize_review",
        reason: "完成合成 fixture 盲评",
        idempotencyKey: "video-ab-synthetic:finalize",
        requestId: "synthetic-finalize",
      },
      serviceOptions,
    )
  ).experiment;
  synthetic = (
    await mutateVideoWorkflowABExperiment(
      actor,
      synthetic.id,
      {
        action: "reveal",
        reason: "揭盲合成 fixture",
        idempotencyKey: "video-ab-synthetic:reveal",
        requestId: "synthetic-reveal",
      },
      serviceOptions,
    )
  ).experiment;
  const syntheticCandidate = synthetic.runs.find(
    (item) => !item.warmup && item.status === "succeeded",
  )!;
  await assert.rejects(
    mutateVideoWorkflowABExperiment(
      actor,
      synthetic.id,
      {
        action: "approve",
        blindRunId: syntheticCandidate.blindId,
        reason: "合成 fixture 不得获批",
        idempotencyKey: "video-ab-synthetic:approve",
        requestId: "synthetic-approve",
      },
      serviceOptions,
    ),
    /Synthetic/,
  );
  synthetic = (
    await mutateVideoWorkflowABExperiment(
      actor,
      synthetic.id,
      {
        action: "reject",
        reason: "拒绝合成 fixture",
        idempotencyKey: "video-ab-synthetic:reject",
        requestId: "synthetic-reject",
      },
      serviceOptions,
    )
  ).experiment;
  assert.equal(synthetic.status, "rejected");

  const restarted = new LocalVideoWorkflowABRepository(root);
  assert.equal((await restarted.list()).length, 2);
  const storeText = await readFile(
    path.join(root, "video-workflow-ab.json"),
    "utf8",
  );
  assert.equal(storeText.includes("same prompt"), false);
  assert.equal(storeText.includes("video_workflow_ab.import"), true);
  assert.equal(storeText.includes("video_workflow_ab.adopt_project_asset"), true);

  await assert.rejects(
    listVideoWorkflowABExperiments(productionActor, {
      repository,
      allowTestAdapter: true,
    }),
    /Production/,
  );
  assert.equal(videoWorkflowABCapabilityStatus(productionActor).available, false);
} finally {
  await rm(root, { recursive: true, force: true });
}

const sourceScan = await readFile(
  path.join(process.cwd(), "components", "AdminVideoWorkflowABPanel.tsx"),
  "utf8",
);
assert.match(sourceScan, /SYNTHETIC/);
assert.match(sourceScan, /盲样/);
assert.match(sourceScan, /VideoStoryPlayer/);
assert.match(sourceScan, /overflow-x-auto/);
assert.match(sourceScan, /仍需视频资产审核与发布/);

console.log("video workflow A/B tests passed");
