import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AdminActor } from "../lib/admin/types";
import {
  isTrustedLoopbackMutationRequest,
  isTrustedSameOriginMutationRequest,
} from "../lib/security/localMutation";
import {
  VideoAssetMetadataWriteRejectedError,
  VideoAssetUnavailableError,
} from "../lib/video-assets/errors";
import { streamVideoAssetContent } from "../lib/video-assets/http";
import {
  assertVideoObjectMetadata,
  buildAliyunOssVideoObjectKey,
  type VideoObjectByteRange,
  type VideoObjectMetadata,
  type VideoObjectReadResult,
  type VideoObjectStorageTransport,
} from "../lib/video-assets/objectStorage";
import type {
  StoredVideoAsset,
  VideoAssetAudit,
  VideoAssetIdempotency,
  VideoAssetRepository,
} from "../lib/video-assets/repository";
import {
  getPublicVideoAssetContent,
  listAdminVideoAssets,
  mutateAdminVideoAsset,
  uploadAdminVideoAsset,
  videoAssetCapabilityStatus,
  type ProductionVideoAssetAdapter,
  type VideoAssetServiceOptions,
} from "../lib/video-assets/server";
import type { VideoProbeResult } from "../lib/video-assets/types";

const TENANT_ID = "tenant-prod-a";
const NOW = new Date("2026-08-10T08:00:00.000Z");
const productionActor: AdminActor = {
  userId: "00000000-0000-4000-8000-000000000001",
  roles: ["super_admin"],
  mode: "production",
};
const fakeMp4 = Uint8Array.from([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeProductionVideoAssetRepository implements VideoAssetRepository {
  readonly source = "production_database" as const;
  readonly assets = new Map<string, StoredVideoAsset>();
  readonly idempotency = new Map<string, VideoAssetIdempotency>();
  readonly audit: VideoAssetAudit[] = [];
  readonly externallyReferencedObjectKeys = new Set<string>();
  failCreateCount = 0;
  failCreateUnknownCount = 0;

  constructor(readonly tenantId: string) {}

  async list(): Promise<StoredVideoAsset[]> {
    return [...this.assets.values()].map(clone);
  }

  async get(id: string): Promise<StoredVideoAsset | undefined> {
    const asset = this.assets.get(id);
    return asset ? clone(asset) : undefined;
  }

  async findIdempotency(
    key: string,
  ): Promise<VideoAssetIdempotency | undefined> {
    const record = this.idempotency.get(key);
    return record ? clone(record) : undefined;
  }

  async hasObjectReference(objectKey: string): Promise<boolean> {
    return this.externallyReferencedObjectKeys.has(objectKey) ||
      [...this.assets.values()].some(
      (asset) => asset.storage.kind === "object"
        && asset.storage.objectKey === objectKey,
    );
  }

  async create(
    asset: StoredVideoAsset,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
  ): Promise<{ asset: StoredVideoAsset; created: boolean }> {
    if (this.failCreateUnknownCount > 0) {
      this.failCreateUnknownCount -= 1;
      throw new VideoAssetUnavailableError();
    }
    if (this.failCreateCount > 0) {
      this.failCreateCount -= 1;
      throw new VideoAssetMetadataWriteRejectedError();
    }
    const replay = this.idempotency.get(idempotency.key);
    if (replay) {
      if (replay.fingerprint !== idempotency.fingerprint) {
        throw new Error("idempotency conflict");
      }
      const existing = this.assets.get(replay.assetId);
      if (!existing) throw new Error("broken idempotency record");
      return { asset: clone(existing), created: false };
    }
    if (asset.tenantId !== this.tenantId) {
      throw new Error("tenant mismatch");
    }
    this.assets.set(asset.id, clone(asset));
    this.idempotency.set(idempotency.key, clone(idempotency));
    this.audit.push(clone(audit));
    return { asset: clone(asset), created: true };
  }

  async mutateAsset(
    id: string,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
    update: (asset: StoredVideoAsset) => void,
  ): Promise<{ asset: StoredVideoAsset; changed: boolean }> {
    const replay = this.idempotency.get(idempotency.key);
    if (replay) {
      if (
        replay.fingerprint !== idempotency.fingerprint ||
        replay.assetId !== id
      ) {
        throw new Error("idempotency conflict");
      }
      const existing = this.assets.get(id);
      if (!existing) throw new Error("broken idempotency record");
      return { asset: clone(existing), changed: false };
    }
    const current = this.assets.get(id);
    if (!current) throw new Error("asset missing");
    const next = clone(current);
    update(next);
    next.updatedAt = NOW.toISOString();
    this.assets.set(id, clone(next));
    this.idempotency.set(idempotency.key, clone(idempotency));
    this.audit.push(clone(audit));
    return { asset: next, changed: true };
  }
}

type StoredObject = {
  bytes: Uint8Array;
  metadata: VideoObjectMetadata;
};

class FakeAliyunOssTransport implements VideoObjectStorageTransport {
  readonly provider = "aliyun_oss" as const;
  readonly objects = new Map<string, StoredObject>();
  readonly putCalls: string[] = [];
  readonly headCalls: string[] = [];
  readonly readCalls: Array<{
    objectKey: string;
    range: VideoObjectByteRange | null;
  }> = [];
  readonly deleteCalls: string[] = [];
  returnMismatchedPutMetadataOnce = false;
  returnMismatchedReadEtagOnce = false;
  hideHeadOnce = false;

  async putObjectIfAbsent(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: "video/mp4" | "video/webm";
    contentHash: string;
    tenantId: string;
    projectId: number;
  }) {
    this.putCalls.push(input.objectKey);
    const existing = this.objects.get(input.objectKey);
    if (existing) {
      assertVideoObjectMetadata(existing.metadata, {
        bytes: input.bytes.byteLength,
        contentType: input.contentType,
        contentHash: input.contentHash,
      });
      return { ...clone(existing.metadata), created: false };
    }
    const metadata: VideoObjectMetadata = {
      bytes: input.bytes.byteLength,
      contentType: input.contentType,
      contentHash: input.contentHash,
      etag: `etag-${input.contentHash.slice(0, 16)}`,
    };
    this.objects.set(input.objectKey, {
      bytes: Uint8Array.from(input.bytes),
      metadata: clone(metadata),
    });
    if (this.returnMismatchedPutMetadataOnce) {
      this.returnMismatchedPutMetadataOnce = false;
      return { ...clone(metadata), bytes: metadata.bytes + 1, created: true };
    }
    return { ...clone(metadata), created: true };
  }

  async headObject(input: {
    objectKey: string;
  }): Promise<VideoObjectMetadata | null> {
    this.headCalls.push(input.objectKey);
    if (this.hideHeadOnce) {
      this.hideHeadOnce = false;
      return null;
    }
    const object = this.objects.get(input.objectKey);
    return object ? clone(object.metadata) : null;
  }

  async readObject(input: {
    objectKey: string;
    range: VideoObjectByteRange | null;
  }): Promise<VideoObjectReadResult> {
    this.readCalls.push(clone(input));
    const object = this.objects.get(input.objectKey);
    if (!object) throw new Error("synthetic object missing");
    const body = input.range
      ? object.bytes.slice(input.range.start, input.range.end + 1)
      : Uint8Array.from(object.bytes);
    const metadata = clone(object.metadata);
    if (this.returnMismatchedReadEtagOnce) {
      this.returnMismatchedReadEtagOnce = false;
      metadata.etag = "etag-mismatch";
    }
    return { body, metadata, contentLength: body.byteLength };
  }

  async deleteObjectIfMatch(input: {
    objectKey: string;
    contentHash: string;
    etag?: string;
  }): Promise<{ deleted: boolean }> {
    this.deleteCalls.push(input.objectKey);
    const object = this.objects.get(input.objectKey);
    if (
      !object ||
      object.metadata.contentHash !== input.contentHash ||
      (input.etag !== undefined && object.metadata.etag !== input.etag)
    ) {
      return { deleted: false };
    }
    this.objects.delete(input.objectKey);
    return { deleted: true };
  }
}

function serviceOptions(input: {
  repository: FakeProductionVideoAssetRepository;
  transport: FakeAliyunOssTransport;
  probeCalls: Array<{ contentHash: string; contentType: string; bytes: number }>;
}): VideoAssetServiceOptions {
  let id = 0;
  return {
    allowTestAdapter: true,
    maxUploadBytes: 1024 * 1024,
    now: () => NOW,
    randomId: () => `asset-prod-${++id}`,
    production: {
      tenantId: TENANT_ID,
      repository: input.repository,
      objectStorage: input.transport,
      probe: async ({ bytes, contentHash, contentType }) => {
        input.probeCalls.push({
          bytes: bytes.byteLength,
          contentHash,
          contentType,
        });
        return {
          durationMs: 12_000,
          width: 1920,
          height: 1080,
          videoCodec: "h264",
          audioCodec: "aac",
          hasAudio: true,
        } satisfies VideoProbeResult;
      },
    },
  };
}

const contentHash = createHash("sha256").update(fakeMp4).digest("hex");
const expectedObjectKey = [
  "aistory/video-assets/v1/tenants",
  TENANT_ID,
  "projects/101/sha256",
  contentHash.slice(0, 2),
  `${contentHash}.mp4`,
].join("/");
assert.equal(
  buildAliyunOssVideoObjectKey({
    tenantId: TENANT_ID,
    projectId: 101,
    contentHash,
    contentType: "video/mp4",
  }),
  expectedObjectKey,
);
assert.notEqual(
  buildAliyunOssVideoObjectKey({
    tenantId: TENANT_ID,
    projectId: 102,
    contentHash,
    contentType: "video/mp4",
  }),
  expectedObjectKey,
);
assert.throws(
  () =>
    buildAliyunOssVideoObjectKey({
      tenantId: "../unsafe",
      projectId: 101,
      contentHash,
      contentType: "video/mp4",
    }),
  /租户/,
);

const placeholderRepository = new FakeProductionVideoAssetRepository(TENANT_ID);
const placeholderTransport = new FakeAliyunOssTransport();
const placeholderProbe = async (): Promise<VideoProbeResult> => ({
  durationMs: 1000,
  width: 1280,
  height: 720,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
});
const incompleteAdapters: unknown[] = [
  undefined,
  {
    tenantId: TENANT_ID,
    objectStorage: placeholderTransport,
    probe: placeholderProbe,
  },
  {
    tenantId: TENANT_ID,
    repository: placeholderRepository,
    probe: placeholderProbe,
  },
  {
    tenantId: TENANT_ID,
    repository: placeholderRepository,
    objectStorage: placeholderTransport,
  },
];
for (const production of incompleteAdapters) {
  const incompleteOptions: VideoAssetServiceOptions = {
    allowTestAdapter: true,
    production: production as ProductionVideoAssetAdapter | undefined,
  };
  const capability = videoAssetCapabilityStatus(
    productionActor,
    incompleteOptions,
  );
  assert.equal(capability.available, false);
  assert.doesNotMatch(JSON.stringify(capability), /bucket|secret|token|AK/i);
  await assert.rejects(
    () => listAdminVideoAssets(productionActor, incompleteOptions),
    VideoAssetUnavailableError,
  );
}

const originalNodeEnv = process.env.NODE_ENV;
const originalVideoAdapter = process.env.AISTORY_VIDEO_ASSET_ADAPTER;
try {
  process.env.NODE_ENV = "production";
  delete process.env.AISTORY_VIDEO_ASSET_ADAPTER;
  await assert.rejects(
    () => getPublicVideoAssetContent("missing-production-asset"),
    VideoAssetUnavailableError,
  );
  const publicContentRoute = await import(
    "../app/api/video-assets/[assetId]/content/route"
  );
  const unavailableResponse = await publicContentRoute.GET(
    new Request("https://media.example.test/api/video-assets/missing/content"),
    { params: Promise.resolve({ assetId: "missing" }) },
  );
  assert.equal(unavailableResponse.status, 503);
  const unavailableBody = await unavailableResponse.text();
  assert.match(unavailableBody, /unavailable/i);
  assert.doesNotMatch(
    unavailableBody,
    /bucket|objectKey|accessKey|secretKey|token/i,
  );
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalVideoAdapter === undefined) {
    delete process.env.AISTORY_VIDEO_ASSET_ADAPTER;
  } else {
    process.env.AISTORY_VIDEO_ASSET_ADAPTER = originalVideoAdapter;
  }
}

const repository = new FakeProductionVideoAssetRepository(TENANT_ID);
const transport = new FakeAliyunOssTransport();
const probeCalls: Array<{
  contentHash: string;
  contentType: string;
  bytes: number;
}> = [];
const options = serviceOptions({ repository, transport, probeCalls });
const uploadInput = {
  bytes: fakeMp4,
  declaredType: "video/mp4",
  title: "Production fake OSS video",
  projectId: 101,
  storyId: "story-production-1",
  nodeId: "node-production-1",
  releasePolicy: "public" as const,
  cues: [
    {
      id: "cue-1",
      startMs: 0,
      endMs: 2000,
      text: "Synthetic subtitle",
    },
  ],
  idempotencyKey: "video-prod-upload:test:000001",
  requestId: "request-prod-upload-1",
};

const uploaded = await uploadAdminVideoAsset(
  productionActor,
  uploadInput,
  options,
);
assert.equal(uploaded.created, true);
assert.equal(uploaded.asset.status, "draft");
assert.equal(uploaded.asset.publicUrl, undefined);
assert.equal(probeCalls.length, 1);
assert.deepEqual(transport.putCalls, [expectedObjectKey]);
assert.equal(repository.audit.length, 1);
const stored = await repository.get(uploaded.asset.id);
assert.ok(stored);
assert.deepEqual(stored!.storage, {
  kind: "object",
  provider: "aliyun_oss",
  objectKey: expectedObjectKey,
  etag: `etag-${contentHash.slice(0, 16)}`,
});
const dtoJson = JSON.stringify(uploaded.asset);
assert.doesNotMatch(
  dtoJson,
  /tenantId|storage|objectKey|bucket|etag|fileName|localPath|jobId|providerTask|workflow|seed|prompt|secret|token/i,
);
assert.match(uploaded.asset.previewUrl, /^\/api\/admin\/video-assets\//);

const replayedUpload = await uploadAdminVideoAsset(
  productionActor,
  { ...uploadInput, requestId: "request-prod-upload-replay" },
  options,
);
assert.equal(replayedUpload.created, false);
assert.equal(replayedUpload.asset.id, uploaded.asset.id);
assert.equal(probeCalls.length, 1);
assert.equal(transport.putCalls.length, 1);
assert.equal(repository.audit.length, 1);
transport.hideHeadOnce = true;
await assert.rejects(
  () => uploadAdminVideoAsset(productionActor, uploadInput, options),
  VideoAssetUnavailableError,
);
assert.equal(transport.putCalls.length, 1);
assert.equal(repository.audit.length, 1);
await assert.rejects(
  () =>
    uploadAdminVideoAsset(
      productionActor,
      { ...uploadInput, title: "Conflicting replay" },
      options,
    ),
  /幂等/,
);

const putsBeforeInvalidCues = transport.putCalls.length;
await assert.rejects(() =>
  uploadAdminVideoAsset(
    productionActor,
    {
      ...uploadInput,
      bytes: Uint8Array.from([...fakeMp4, 1]),
      cues: [
        {
          id: "too-late",
          startMs: 0,
          endMs: 20_000,
          text: "Out of range",
        },
      ],
      idempotencyKey: "video-prod-invalid-cues:0001",
    },
    options,
  ),
);
assert.equal(transport.putCalls.length, putsBeforeInvalidCues);

const createdThenFailedBytes = Uint8Array.from([...fakeMp4, 2]);
const createdThenFailedHash = createHash("sha256")
  .update(createdThenFailedBytes)
  .digest("hex");
const createdThenFailedKey = buildAliyunOssVideoObjectKey({
  tenantId: TENANT_ID,
  projectId: 202,
  contentHash: createdThenFailedHash,
  contentType: "video/mp4",
});
repository.failCreateCount = 1;
const deletesBeforeCreatedFailure = transport.deleteCalls.length;
await assert.rejects(
  () =>
    uploadAdminVideoAsset(
      productionActor,
      {
        ...uploadInput,
        bytes: createdThenFailedBytes,
        projectId: 202,
        idempotencyKey: "video-prod-create-failure:0001",
      },
      options,
    ),
  VideoAssetUnavailableError,
);
assert.equal(transport.objects.has(createdThenFailedKey), false);
assert.equal(transport.deleteCalls.length, deletesBeforeCreatedFailure + 1);

const unknownOutcomeBytes = Uint8Array.from([...fakeMp4, 12]);
const unknownOutcomeHash = createHash("sha256")
  .update(unknownOutcomeBytes)
  .digest("hex");
const unknownOutcomeKey = buildAliyunOssVideoObjectKey({
  tenantId: TENANT_ID,
  projectId: 212,
  contentHash: unknownOutcomeHash,
  contentType: "video/mp4",
});
repository.failCreateUnknownCount = 1;
const deletesBeforeUnknownOutcome = transport.deleteCalls.length;
await assert.rejects(
  () => uploadAdminVideoAsset(
    productionActor,
    {
      ...uploadInput,
      bytes: unknownOutcomeBytes,
      projectId: 212,
      idempotencyKey: "video-prod-unknown-outcome:0001",
    },
    options,
  ),
  VideoAssetUnavailableError,
);
assert.equal(
  transport.objects.has(unknownOutcomeKey),
  true,
  "an unknown database commit outcome must never delete the created object",
);
assert.equal(transport.deleteCalls.length, deletesBeforeUnknownOutcome);

const concurrentlyReferencedBytes = Uint8Array.from([...fakeMp4, 9]);
const concurrentlyReferencedHash = createHash("sha256")
  .update(concurrentlyReferencedBytes)
  .digest("hex");
const concurrentlyReferencedKey = buildAliyunOssVideoObjectKey({
  tenantId: TENANT_ID,
  projectId: 209,
  contentHash: concurrentlyReferencedHash,
  contentType: "video/mp4",
});
repository.externallyReferencedObjectKeys.add(concurrentlyReferencedKey);
repository.failCreateCount = 1;
const deletesBeforeConcurrentReference = transport.deleteCalls.length;
await assert.rejects(
  () =>
    uploadAdminVideoAsset(
      productionActor,
      {
        ...uploadInput,
        bytes: concurrentlyReferencedBytes,
        projectId: 209,
        idempotencyKey: "video-prod-concurrent-reference:0001",
      },
      options,
    ),
  VideoAssetUnavailableError,
);
assert.equal(transport.objects.has(concurrentlyReferencedKey), true);
assert.equal(transport.deleteCalls.length, deletesBeforeConcurrentReference);
repository.externallyReferencedObjectKeys.delete(concurrentlyReferencedKey);

const preexistingBytes = Uint8Array.from([...fakeMp4, 3]);
const preexistingHash = createHash("sha256")
  .update(preexistingBytes)
  .digest("hex");
const preexistingKey = buildAliyunOssVideoObjectKey({
  tenantId: TENANT_ID,
  projectId: 303,
  contentHash: preexistingHash,
  contentType: "video/mp4",
});
await transport.putObjectIfAbsent({
  objectKey: preexistingKey,
  bytes: preexistingBytes,
  contentType: "video/mp4",
  contentHash: preexistingHash,
  tenantId: TENANT_ID,
  projectId: 303,
});
repository.failCreateCount = 1;
const deletesBeforeExistingFailure = transport.deleteCalls.length;
await assert.rejects(
  () =>
    uploadAdminVideoAsset(
      productionActor,
      {
        ...uploadInput,
        bytes: preexistingBytes,
        projectId: 303,
        idempotencyKey: "video-prod-existing-failure:0001",
      },
      options,
    ),
  VideoAssetUnavailableError,
);
assert.equal(transport.objects.has(preexistingKey), true);
assert.equal(transport.deleteCalls.length, deletesBeforeExistingFailure);
assert.equal(
  repository.failCreateCount,
  1,
  "an unreferenced pre-existing object must fail before metadata creation",
);
repository.failCreateCount = 0;

const mismatchedBytes = Uint8Array.from([...fakeMp4, 4]);
const mismatchedHash = createHash("sha256").update(mismatchedBytes).digest("hex");
const mismatchedKey = buildAliyunOssVideoObjectKey({
  tenantId: TENANT_ID,
  projectId: 404,
  contentHash: mismatchedHash,
  contentType: "video/mp4",
});
transport.returnMismatchedPutMetadataOnce = true;
await assert.rejects(
  () =>
    uploadAdminVideoAsset(
      productionActor,
      {
        ...uploadInput,
        bytes: mismatchedBytes,
        projectId: 404,
        idempotencyKey: "video-prod-put-mismatch:0001",
      },
      options,
    ),
  VideoAssetUnavailableError,
);
assert.equal(transport.objects.has(mismatchedKey), false);

const submitInput = {
  action: "submit_review" as const,
  reason: "Synthetic review submitted",
  idempotencyKey: "video-prod-review:test:00001",
  requestId: "request-prod-review-1",
};
assert.equal(
  (
    await mutateAdminVideoAsset(
      productionActor,
      uploaded.asset.id,
      submitInput,
      options,
    )
  ).asset.status,
  "review_pending",
);
assert.equal(repository.audit.length, 2);
const approveInput = {
  action: "approve" as const,
  reason: "Synthetic review approved",
  idempotencyKey: "video-prod-approve:test:0001",
  requestId: "request-prod-approve-1",
};
transport.hideHeadOnce = true;
await assert.rejects(
  () =>
    mutateAdminVideoAsset(
      productionActor,
      uploaded.asset.id,
      approveInput,
      options,
    ),
  VideoAssetUnavailableError,
);
assert.equal((await repository.get(uploaded.asset.id))!.status, "review_pending");
assert.equal(repository.audit.length, 2);
const approved = await mutateAdminVideoAsset(
  productionActor,
  uploaded.asset.id,
  approveInput,
  options,
);
assert.equal(approved.asset.status, "publishable");
assert.match(approved.asset.publicUrl || "", /^\/api\/video-assets\//);
assert.equal(repository.audit.length, 3);
const approvedReplay = await mutateAdminVideoAsset(
  productionActor,
  uploaded.asset.id,
  { ...approveInput, requestId: "request-prod-approve-replay" },
  options,
);
assert.equal(approvedReplay.changed, false);
assert.equal(repository.audit.length, 3);
await assert.rejects(
  () =>
    mutateAdminVideoAsset(
      productionActor,
      uploaded.asset.id,
      {
        action: "bind",
        reason: "Must require a new review",
        releasePolicy: "internal",
        idempotencyKey: "video-prod-bind-after-approve:0001",
        requestId: "request-prod-bind-after-approve",
      },
      options,
    ),
  /草稿/,
);
assert.equal(repository.audit.length, 3);

const publicContent = await getPublicVideoAssetContent(
  uploaded.asset.id,
  options,
);
assert.ok(publicContent && publicContent.kind === "object");
const fullResponse = await streamVideoAssetContent(
  new Request("https://media.example.test/video"),
  publicContent!,
  "public, max-age=60",
);
assert.equal(fullResponse.status, 200);
assert.equal(fullResponse.headers.get("content-length"), String(fakeMp4.length));
assert.equal(fullResponse.headers.get("x-content-type-options"), "nosniff");
assert.equal(
  fullResponse.headers.get("etag"),
  `"sha256-${contentHash}"`,
);
assert.notEqual(
  fullResponse.headers.get("etag"),
  `etag-${contentHash.slice(0, 16)}`,
);
assert.equal(
  fullResponse.headers.get("cross-origin-resource-policy"),
  "same-origin",
);
assert.deepEqual(
  new Uint8Array(await fullResponse.arrayBuffer()),
  fakeMp4,
);
assert.doesNotMatch(JSON.stringify([...fullResponse.headers]), /objectKey|bucket/i);

const rangeResponse = await streamVideoAssetContent(
  new Request("https://media.example.test/video", {
    headers: { Range: "bytes=4-11" },
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
const suffixResponse = await streamVideoAssetContent(
  new Request("https://media.example.test/video", {
    headers: { Range: "bytes=-4" },
  }),
  publicContent!,
  "public, max-age=60",
);
assert.equal(suffixResponse.status, 206);
assert.deepEqual(
  new Uint8Array(await suffixResponse.arrayBuffer()),
  fakeMp4.slice(-4),
);
for (const range of ["bytes=999-", "bytes=0-1,4-5"]) {
  const invalidRangeResponse = await streamVideoAssetContent(
    new Request("https://media.example.test/video", {
      headers: { Range: range },
    }),
    publicContent!,
    "public, max-age=60",
  );
  assert.equal(invalidRangeResponse.status, 416);
  assert.equal(invalidRangeResponse.headers.get("content-range"), "bytes */24");
  assert.equal(
    invalidRangeResponse.headers.get("x-content-type-options"),
    "nosniff",
  );
}
const readsBeforeHead = transport.readCalls.length;
const headResponse = await streamVideoAssetContent(
  new Request("https://media.example.test/video", {
    method: "HEAD",
    headers: { Range: "bytes=invalid" },
  }),
  publicContent!,
  "public, max-age=60",
);
assert.equal(headResponse.status, 200);
assert.equal(await headResponse.text(), "");
assert.equal(transport.readCalls.length, readsBeforeHead);
transport.returnMismatchedReadEtagOnce = true;
await assert.rejects(
  () =>
    streamVideoAssetContent(
      new Request("https://media.example.test/video"),
      publicContent!,
      "public, max-age=60",
    ),
  VideoAssetUnavailableError,
);

const offlineInput = {
  action: "offline" as const,
  reason: "Synthetic release offline",
  idempotencyKey: "video-prod-offline:test:0001",
  requestId: "request-prod-offline-1",
};
assert.equal(
  (
    await mutateAdminVideoAsset(
      productionActor,
      uploaded.asset.id,
      offlineInput,
      options,
    )
  ).asset.status,
  "offline",
);
assert.equal(repository.audit.length, 4);
assert.equal(
  (
    await mutateAdminVideoAsset(
      productionActor,
      uploaded.asset.id,
      { ...offlineInput, requestId: "request-prod-offline-replay" },
      options,
    )
  ).changed,
  false,
);
assert.equal(repository.audit.length, 4);
assert.equal(
  await getPublicVideoAssetContent(uploaded.asset.id, options),
  null,
);

const validStoredRecord = repository.assets.get(uploaded.asset.id)!;
const corruptStoredRecord = clone(validStoredRecord) as StoredVideoAsset & {
  contentType: string;
};
corruptStoredRecord.contentType = "text/plain";
repository.assets.set(
  uploaded.asset.id,
  corruptStoredRecord as StoredVideoAsset,
);
await assert.rejects(
  () => listAdminVideoAssets(productionActor, options),
  VideoAssetUnavailableError,
);
repository.assets.set(uploaded.asset.id, validStoredRecord);

assert.equal(
  isTrustedSameOriginMutationRequest(
    new Request("https://admin.example.test/api", {
      headers: {
        Host: "admin.example.test",
        Origin: "https://admin.example.test",
      },
    }),
  ),
  true,
);
for (const headers of [
  { Host: "admin.example.test", Origin: "http://admin.example.test" },
  { Host: "admin.example.test", Origin: "https://other.example.test" },
  { Host: "admin.example.test", Origin: "https://user@admin.example.test" },
  { Host: "admin.example.test" },
]) {
  assert.equal(
    isTrustedSameOriginMutationRequest(
      new Request("https://admin.example.test/api", { headers }),
    ),
    false,
  );
}
assert.equal(
  isTrustedLoopbackMutationRequest(
    new Request("http://127.0.0.1:4200/api", {
      headers: {
        Host: "127.0.0.1:4200",
        Origin: "http://127.0.0.1:4200",
      },
    }),
  ),
  true,
);

const adminRouteSource = await readFile(
  path.join(process.cwd(), "app", "api", "admin", "video-assets", "route.ts"),
  "utf8",
);
assert.match(adminRouteSource, /assertTrustedAdminMutation/);
assert.match(adminRouteSource, /actor\.mode === "production" \? 503 : 200/);
assert.doesNotMatch(adminRouteSource, /bucket|objectKey|accessKey|secretKey/i);
for (const route of [
  path.join(
    process.cwd(),
    "app",
    "api",
    "admin",
    "video-assets",
    "[assetId]",
    "content",
    "route.ts",
  ),
  path.join(
    process.cwd(),
    "app",
    "api",
    "video-assets",
    "[assetId]",
    "content",
    "route.ts",
  ),
]) {
  const source = await readFile(route, "utf8");
  assert.match(source, /isVideoAssetUnavailableError/);
  assert.match(source, /status: 503/);
  assert.doesNotMatch(source, /bucket|objectKey|accessKey|secretKey/i);
  if (!route.includes(`${path.sep}admin${path.sep}`)) {
    assert.match(source, /private, no-store/);
    assert.doesNotMatch(source, /stale-while-revalidate|max-age/);
  }
}

console.log("production video asset fake OSS contract tests passed");
