import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdminActor } from "../lib/admin/types";
import { canSubmitComfyUIGeneration } from "../lib/generation-jobs/preflight";
import type { ComfyUIProviderStatus } from "../lib/providers/comfyui/types";
import { LocalVideoAssetRepository } from "../lib/video-assets/repository";
import { streamVideoAssetContent } from "../lib/video-assets/http";
import {
  getPublicVideoAssetContent,
  getPublicVideoAssetFile,
  listAdminVideoAssets,
  mutateAdminVideoAsset,
  projectPublishedVideoAsset,
  uploadAdminVideoAsset,
} from "../lib/video-assets/server";
import {
  parseWebVtt,
  sniffVideoContainer,
  validateContainerCodecCombination,
  validateVideoBytes,
} from "../lib/video-assets/validation";

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-video-assets-"));
const repository = new LocalVideoAssetRepository(root);
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
const fakeMp4 = Uint8Array.from([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
]);
const fakeWebM = Uint8Array.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81,
]);
const fakeProbe = async () => ({
  durationMs: 12_000,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
});
const options = {
  repository,
  probe: fakeProbe,
  allowTestAdapter: true,
  maxUploadBytes: 1024 * 1024,
  randomId: () => "asset-video-1",
  now: () => new Date("2026-07-29T08:00:00.000Z"),
};

try {
  assert.equal(sniffVideoContainer(fakeMp4), "video/mp4");
  assert.equal(sniffVideoContainer(fakeWebM), "video/webm");
  assert.equal(
    validateVideoBytes(fakeWebM, "video/webm", 1024).contentType,
    "video/webm",
  );
  assert.throws(
    () => validateVideoBytes(new Uint8Array(), "video/mp4", 1024),
    /空|大小/,
  );
  assert.throws(
    () => validateVideoBytes(fakeMp4, "video/mp4", fakeMp4.length - 1),
    /大小/,
  );
  assert.throws(
    () => validateVideoBytes(fakeMp4, "video/webm", 1024),
    /MIME/,
  );
  assert.throws(
    () =>
      validateContainerCodecCombination("video/mp4", {
        durationMs: 1000,
        width: 1280,
        height: 720,
        videoCodec: "vp9",
        audioCodec: "opus",
        hasAudio: true,
      }),
    /H\.264/,
  );
  assert.throws(
    () =>
      parseWebVtt(
        "WEBVTT\n\n00:00.000 --> 00:01.000\n<script>alert(1)</script>",
      ),
    /HTML/,
  );
  const cues = parseWebVtt(
    "WEBVTT\n\ncue-1\n00:00.000 --> 00:02.000\n第一句\n\n00:02.000 --> 00:04.000\n第二句",
  );
  assert.equal(cues.length, 2);

  const uploadInput = {
    bytes: fakeMp4,
    declaredType: "video/mp4",
    title: "审核用小型合成视频",
    projectId: 101,
    storyId: "story-1",
    nodeId: "node-1",
    releasePolicy: "public" as const,
    cues,
    idempotencyKey: "video-upload:test:00000001",
    requestId: "request-1",
  };
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () =>
      uploadAdminVideoAsset(actor, uploadInput, options),
    ),
  );
  assert.equal(concurrent.filter((result) => result.created).length, 1);
  assert.equal(new Set(concurrent.map((result) => result.asset.id)).size, 1);
  assert.equal((await listAdminVideoAssets(actor, options)).length, 1);

  await assert.rejects(
    () =>
      uploadAdminVideoAsset(
        actor,
        { ...uploadInput, title: "不同请求" },
        options,
      ),
    /幂等键/,
  );
  await assert.rejects(
    () => listAdminVideoAssets(productionActor, options),
    /生产视频资产/,
  );
  const originalAdapter = process.env.AISTORY_VIDEO_ASSET_ADAPTER;
  try {
    delete process.env.AISTORY_VIDEO_ASSET_ADAPTER;
    await assert.rejects(
      () =>
        listAdminVideoAssets(actor, {
          repository,
          probe: fakeProbe,
        }),
      /未启用/,
    );
  } finally {
    if (originalAdapter === undefined) {
      delete process.env.AISTORY_VIDEO_ASSET_ADAPTER;
    } else {
      process.env.AISTORY_VIDEO_ASSET_ADAPTER = originalAdapter;
    }
  }

  const submit = await mutateAdminVideoAsset(
    actor,
    "asset-video-1",
    {
      action: "submit_review",
      reason: "完整性检查通过",
      idempotencyKey: "video-review:test:00000001",
      requestId: "request-2",
    },
    options,
  );
  assert.equal(submit.asset.status, "review_pending");
  assert.equal(
    projectPublishedVideoAsset((await repository.get("asset-video-1"))!),
    null,
  );
  const approved = await mutateAdminVideoAsset(
    actor,
    "asset-video-1",
    {
      action: "approve",
      reason: "内容和版权检查通过",
      idempotencyKey: "video-approve:test:0000001",
      requestId: "request-3",
    },
    options,
  );
  assert.equal(approved.asset.status, "publishable");
  const approvedReplay = await mutateAdminVideoAsset(
    actor,
    "asset-video-1",
    {
      action: "approve",
      reason: "内容和版权检查通过",
      idempotencyKey: "video-approve:test:0000001",
      requestId: "request-3-replay",
    },
    options,
  );
  assert.equal(approvedReplay.changed, false);
  await assert.rejects(
    () =>
      mutateAdminVideoAsset(
        actor,
        "asset-video-1",
        {
          action: "bind",
          reason: "已批准后不得绕过复审修改发布策略",
          releasePolicy: "internal",
          idempotencyKey: "video-bind:test:00000001",
          requestId: "request-bind-rejected",
        },
        options,
      ),
    /草稿/,
  );
  const internal = await repository.get("asset-video-1");
  assert.ok(internal);
  assert.equal(projectPublishedVideoAsset(internal!)?.kind, "video");
  assert.equal(
    (await getPublicVideoAssetFile("asset-video-1", options))?.asset.id,
    "asset-video-1",
  );
  const publicRecord = await getPublicVideoAssetFile("asset-video-1", options);
  assert.ok(publicRecord);
  const publicContent = await getPublicVideoAssetContent(
    "asset-video-1",
    options,
  );
  assert.ok(publicContent);
  await assert.rejects(
    () =>
      streamVideoAssetContent(
        new Request("https://example.com/video"),
        publicContent!,
        "public, max-age=60",
      ),
    /LOOPBACK/,
  );
  const rangeResponse = await streamVideoAssetContent(
    new Request("http://127.0.0.1/video", {
      headers: { Host: "127.0.0.1", Range: "bytes=4-11" },
    }),
    publicContent!,
    "public, max-age=60",
  );
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), "bytes 4-11/24");
  assert.deepEqual(
    new Uint8Array(await rangeResponse.arrayBuffer()),
    fakeMp4.slice(4, 12),
  );

  const dtoJson = JSON.stringify(approved.asset);
  assert.doesNotMatch(
    dtoJson,
    /(storageFile|localPath|providerTaskId|workflow|negativePrompt|prompt)/i,
  );
  const offlineInput = {
    action: "offline" as const,
    reason: "下线回归测试",
    idempotencyKey: "video-offline:test:0000001",
    requestId: "request-4",
  };
  await mutateAdminVideoAsset(
    actor,
    "asset-video-1",
    offlineInput,
    options,
  );
  assert.equal(
    (
      await mutateAdminVideoAsset(
        actor,
        "asset-video-1",
        { ...offlineInput, requestId: "request-4-replay" },
        options,
      )
    ).changed,
    false,
  );
  assert.equal(
    await getPublicVideoAssetFile("asset-video-1", options),
    null,
  );
  const storeJson = await readFile(
    path.join(root, "video-assets.json"),
    "utf8",
  );
  assert.match(storeJson, /video_asset\.approve/);
  assert.equal(JSON.parse(storeJson).audit.length, 4);

  const readyStatus: ComfyUIProviderStatus = {
    provider: "comfyui",
    enabled: true,
    configured: true,
    available: true,
    state: "ready",
    baseUrl: "http://127.0.0.1:8188",
    modalities: { image: true, video: false },
    workflowNodeCounts: {},
    message: "ready",
    checkedAt: new Date().toISOString(),
  };
  assert.equal(
    canSubmitComfyUIGeneration(readyStatus, { modality: "video" }),
    false,
  );
  assert.equal(
    canSubmitComfyUIGeneration(
      {
        ...readyStatus,
        modalities: { image: true, video: true },
      },
      { modality: "video" },
    ),
    true,
  );

  const routeSource = await readFile(
    path.join(
      process.cwd(),
      "app",
      "api",
      "admin",
      "video-assets",
      "route.ts",
    ),
    "utf8",
  );
  assert.match(routeSource, /requireAdmin/);
  assert.match(routeSource, /assertTrustedAdminMutation/);
  assert.match(routeSource, /content-length/);
  assert.doesNotMatch(routeSource, /public\/uploads|writeFile/);

  console.log("admin video asset tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
