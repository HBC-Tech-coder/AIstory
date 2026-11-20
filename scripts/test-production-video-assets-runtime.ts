import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  VideoAssetMetadataWriteRejectedError,
  VideoAssetUnavailableError,
} from "../lib/video-assets/errors";
import {
  buildAliyunOssVideoObjectKey,
  type VideoObjectMetadata,
} from "../lib/video-assets/objectStorage";
import {
  AliyunOssVideoObjectTransport,
  type AliyunOssClientFactory,
} from "../lib/video-assets/production/aliyunOssTransport";
import {
  inspectProductionVideoAssetConfig,
  loadProductionVideoAssetConfig,
  PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION,
  type ProductionVideoAssetEnvironment,
} from "../lib/video-assets/production/config";
import {
  createEcsRamRoleCredentialSource,
  type EcsRamRoleProviderBuilderLike,
} from "../lib/video-assets/production/credentials";
import { createProductionVideoByteProbe } from "../lib/video-assets/production/probe";
import { reconcileUnreferencedProjectVideoObjects } from "../lib/video-assets/production/reconciliation";
import {
  createProductionVideoAssetAdapter,
  getRuntimeVideoAssetServiceOptions,
} from "../lib/video-assets/production/runtime";
import {
  SupabaseVideoAssetRepository,
  type VideoAssetRpcClient,
} from "../lib/video-assets/production/supabaseRepository";
import type {
  StoredVideoAsset,
  VideoAssetAudit,
  VideoAssetIdempotency,
} from "../lib/video-assets/repository";
import { videoAssetCapabilityStatus } from "../lib/video-assets/server";
import type { AdminActor } from "../lib/admin/types";

const APPROVED_INTEGRITY =
  "sha512-FipRmyd16Pr/tEey/YaaQ/24Pc3HEpLM9S1DRakEuXlSLXNIJnu1oJtHM53eVYpvW3dXapSjrip3xylZUTIZVQ==";
const TENANT_ID = "tenant-prod-a";
const PROJECT_ID = 101;
const fakeMp4 = Uint8Array.from([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
]);
const contentHash = createHash("sha256").update(fakeMp4).digest("hex");

const validEnv: ProductionVideoAssetEnvironment = {
  AISTORY_VIDEO_ASSET_ADAPTER: "aliyun_oss",
  AISTORY_VIDEO_METADATA_REPOSITORY: "supabase",
  AISTORY_VIDEO_ASSET_TENANT_ID: TENANT_ID,
  AISTORY_VIDEO_DATABASE_GATE_VERSION: PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION,
  AISTORY_DATABASE_GATE_VERSION: PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION,
  AISTORY_VIDEO_OSS_BUCKET: "aistory-private-video",
  AISTORY_VIDEO_OSS_REGION: "oss-cn-hangzhou",
  AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT:
    "https://oss-cn-hangzhou-internal.aliyuncs.com",
  AISTORY_VIDEO_OSS_PREFIX: "aistory/video-assets/v1",
  AISTORY_VIDEO_OSS_CREDENTIAL_SOURCE: "ecs_ram_role",
  AISTORY_VIDEO_OSS_ECS_RAM_ROLE_NAME: "AIstoryVideoAssetRole",
  AISTORY_VIDEO_OSS_TIMEOUT_MS: "12000",
  AISTORY_VIDEO_IMDS_CONNECT_TIMEOUT_MS: "800",
  AISTORY_VIDEO_IMDS_READ_TIMEOUT_MS: "900",
  AISTORY_VIDEO_FFPROBE_PATH: "C:\\tools\\ffprobe.exe",
  AISTORY_SUPABASE_SERVER_URL: "https://database.invalid.example",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key-not-real",
};

const packageJson = JSON.parse(
  await readFile(path.join(process.cwd(), "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
assert.equal(packageJson.dependencies?.["ali-oss"], "6.23.0");
const lockSource = await readFile(
  path.join(process.cwd(), "pnpm-lock.yaml"),
  "utf8",
);
assert.match(lockSource, /ali-oss:\s*\r?\n\s+specifier: 6\.23\.0/);
assert.match(lockSource, /ali-oss@6\.23\.0:[\s\S]*?integrity: sha512-FipRmyd16Pr\/tEey\/YaaQ\/24Pc3HEpLM9S1DRakEuXlSLXNIJnu1oJtHM53eVYpvW3dXapSjrip3xylZUTIZVQ==/);
const installedPackage = JSON.parse(
  await readFile(path.join(process.cwd(), "node_modules", "ali-oss", "package.json"), "utf8"),
) as { version?: string; license?: string; repository?: { url?: string } };
assert.equal(installedPackage.version, "6.23.0");
assert.equal(installedPackage.license, "MIT");
assert.equal(
  installedPackage.repository?.url,
  "https://github.com/ali-sdk/ali-oss.git",
);
assert.equal(APPROVED_INTEGRITY.startsWith("sha512-"), true);

assert.deepEqual(inspectProductionVideoAssetConfig(validEnv), {
  ready: true,
  missing: [],
});
for (const [key, badValue] of [
  ["AISTORY_VIDEO_METADATA_REPOSITORY", "memory"],
  ["AISTORY_VIDEO_ASSET_TENANT_ID", "../tenant"],
  ["AISTORY_VIDEO_DATABASE_GATE_VERSION", "20260809113000"],
  ["AISTORY_DATABASE_GATE_VERSION", "20260809113000"],
  ["AISTORY_VIDEO_OSS_BUCKET", "INVALID_BUCKET"],
  ["AISTORY_VIDEO_OSS_REGION", "cn-hangzhou"],
  ["AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT", "https://oss-cn-hangzhou.aliyuncs.com"],
  ["AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT", "http://oss-cn-hangzhou-internal.aliyuncs.com"],
  ["AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT", "https://user@oss-cn-hangzhou-internal.aliyuncs.com"],
  ["AISTORY_VIDEO_OSS_PREFIX", "aistory/video-assets/v2"],
  ["AISTORY_VIDEO_OSS_CREDENTIAL_SOURCE", "default"],
  ["AISTORY_VIDEO_OSS_ECS_RAM_ROLE_NAME", "../role"],
  ["AISTORY_VIDEO_FFPROBE_PATH", "ffprobe"],
  ["DEBUG", "ali-oss*"],
  ["DEBUG", "*"],
  ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
] as const) {
  const status = inspectProductionVideoAssetConfig({
    ...validEnv,
    [key]: badValue,
  });
  assert.equal(status.ready, false, `${key} must fail closed`);
}
assert.equal(
  inspectProductionVideoAssetConfig({
    ...validEnv,
    DEBUG: "app:*,-ali-oss*",
  }).ready,
  true,
  "unrelated debug namespaces with an explicit ali-oss exclusion are safe",
);
assert.throws(
  () => loadProductionVideoAssetConfig({ ...validEnv, SUPABASE_SERVICE_ROLE_KEY: "" }),
  VideoAssetUnavailableError,
);
const config = loadProductionVideoAssetConfig(validEnv);

const builderCalls: Array<[string, unknown]> = [];
let credentialFetches = 0;
const fakeBuilder: EcsRamRoleProviderBuilderLike = {
  withRoleName(value) {
    builderCalls.push(["role", value]);
    return this;
  },
  withDisableIMDSv1(value) {
    builderCalls.push(["disableIMDSv1", value]);
    return this;
  },
  withAsyncCredentialUpdateEnabled(value) {
    builderCalls.push(["asyncUpdate", value]);
    return this;
  },
  withConnectTimeout(value) {
    builderCalls.push(["connectTimeout", value]);
    return this;
  },
  withReadTimeout(value) {
    builderCalls.push(["readTimeout", value]);
    return this;
  },
  build() {
    builderCalls.push(["build", true]);
    return {
      async getCredentials() {
        credentialFetches += 1;
        return {
          accessKeyId: "synthetic-ak",
          accessKeySecret: "synthetic-secret",
          securityToken: "synthetic-token",
          providerName: "ecs_ram_role",
        };
      },
    };
  },
};
const credentialSource = createEcsRamRoleCredentialSource(
  config,
  () => fakeBuilder,
);
assert.equal(builderCalls.length, 0, "provider construction must remain lazy");
await credentialSource.getCredentials();
assert.deepEqual(builderCalls, [
  ["role", "AIstoryVideoAssetRole"],
  ["disableIMDSv1", true],
  ["asyncUpdate", false],
  ["connectTimeout", 800],
  ["readTimeout", 900],
  ["build", true],
]);
assert.equal(credentialFetches, 1);
await assert.rejects(
  () => createEcsRamRoleCredentialSource(config, () => ({
    ...fakeBuilder,
    build() {
      return {
        async getCredentials() {
          return {
            accessKeyId: "synthetic-ak",
            accessKeySecret: "synthetic-secret",
            securityToken: "synthetic-token",
          };
        },
      };
    },
  })).getCredentials(),
  VideoAssetUnavailableError,
  "credentials without an explicit ECS RAM role provenance must fail closed",
);

type FakeStoredObject = { bytes: Uint8Array; metadata: VideoObjectMetadata };
const objects = new Map<string, FakeStoredObject>();
const sdkCalls: Array<{ operation: string; input: unknown }> = [];
let clientCreations = 0;
const fakeClientFactory: AliyunOssClientFactory = (credentials, fixedConfig) => {
  clientCreations += 1;
  assert.equal(credentials.securityToken, "synthetic-token");
  assert.equal(fixedConfig.endpoint, validEnv.AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT);
  return {
    async put(objectKey, bytes, options) {
      sdkCalls.push({ operation: "put", input: { objectKey, options } });
      if (objects.has(objectKey)) {
        throw { status: 409, code: "FileAlreadyExists", message: "synthetic-secret" };
      }
      const optionRecord = options as {
        headers: Record<string, string>;
        meta: Record<string, string>;
        mime: "video/mp4" | "video/webm";
      };
      assert.equal(optionRecord.headers["x-oss-forbid-overwrite"], "true");
      const metadata: VideoObjectMetadata = {
        bytes: bytes.byteLength,
        contentType: optionRecord.mime,
        contentHash: optionRecord.meta["aistory-sha256"]!,
        etag: '"synthetic-etag"',
      };
      objects.set(objectKey, {
        bytes: Uint8Array.from(bytes),
        metadata,
      });
      return { res: { status: 200, headers: { etag: metadata.etag } } };
    },
    async head(objectKey) {
      sdkCalls.push({ operation: "head", input: { objectKey } });
      const object = objects.get(objectKey);
      if (!object) throw { status: 404, code: "NoSuchKey" };
      return {
        status: 200,
        meta: {
          "aistory-bytes": String(object.metadata.bytes),
          "aistory-content-type": object.metadata.contentType,
          "aistory-sha256": object.metadata.contentHash,
        },
        res: {
          status: 200,
          headers: {
            "content-length": String(object.metadata.bytes),
            "content-type": object.metadata.contentType,
            etag: object.metadata.etag,
          },
        },
      };
    },
    async getStream(objectKey, options) {
      sdkCalls.push({ operation: "getStream", input: { objectKey, options } });
      const object = objects.get(objectKey);
      if (!object) throw { status: 404, code: "NoSuchKey" };
      const rangeHeader = (options?.headers as { Range?: string } | undefined)?.Range;
      let body = object.bytes;
      let statusCode = 200;
      let contentRange: string | undefined;
      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)!;
        const start = Number(match[1]);
        const end = Number(match[2]);
        body = object.bytes.slice(start, end + 1);
        statusCode = 206;
        contentRange = `bytes ${start}-${end}/${object.bytes.byteLength}`;
      }
      return {
        stream: Readable.from([Buffer.from(body)]),
        res: {
          status: statusCode,
          headers: {
            "content-length": String(body.byteLength),
            "content-type": object.metadata.contentType,
            "x-oss-meta-aistory-bytes": String(object.metadata.bytes),
            "x-oss-meta-aistory-content-type": object.metadata.contentType,
            "x-oss-meta-aistory-sha256": object.metadata.contentHash,
            ...(contentRange ? { "content-range": contentRange } : {}),
            etag: object.metadata.etag,
          },
        },
      };
    },
    async delete(objectKey, options) {
      sdkCalls.push({ operation: "delete", input: { objectKey, options } });
      const expected = objects.get(objectKey)?.metadata.etag;
      assert.equal((options?.headers as Record<string, string>)["If-Match"], expected);
      objects.delete(objectKey);
      return { res: { status: 204, headers: {} } };
    },
    async listV2(query) {
      sdkCalls.push({ operation: "listV2", input: query });
      const prefix = String(query.prefix);
      assert.equal(prefix, `aistory/video-assets/v1/tenants/${TENANT_ID}/projects/${PROJECT_ID}/`);
      assert.equal(query["max-keys"], 25);
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([name, object]) => ({
            name,
            size: object.metadata.bytes,
            etag: object.metadata.etag,
            lastModified: "2026-08-09T00:00:00.000Z",
            url: "https://must-not-be-projected.invalid",
          })),
        isTruncated: true,
        nextContinuationToken: "synthetic-next-token",
        res: { status: 200, headers: {} },
      };
    },
  };
};

const transport = new AliyunOssVideoObjectTransport(
  config,
  credentialSource,
  fakeClientFactory,
);
const objectKey = buildAliyunOssVideoObjectKey({
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  contentHash,
  contentType: "video/mp4",
});
const put = await transport.putObjectIfAbsent({
  objectKey,
  bytes: fakeMp4,
  contentType: "video/mp4",
  contentHash,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
});
assert.equal(put.created, true);
assert.equal(put.etag, '"synthetic-etag"');
const replay = await transport.putObjectIfAbsent({
  objectKey,
  bytes: fakeMp4,
  contentType: "video/mp4",
  contentHash,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
});
assert.equal(replay.created, false);
assert.deepEqual(await transport.headObject({ objectKey }), {
  bytes: put.bytes,
  contentType: put.contentType,
  contentHash: put.contentHash,
  etag: put.etag,
});
const full = await transport.readObject({ objectKey, range: null });
assert.deepEqual(
  new Uint8Array(await new Response(full.body).arrayBuffer()),
  fakeMp4,
);
const range = await transport.readObject({
  objectKey,
  range: { start: 4, end: 11 },
});
assert.deepEqual(
  new Uint8Array(await new Response(range.body).arrayBuffer()),
  fakeMp4.slice(4, 12),
);
const page = await transport.listProjectObjects({
  projectId: PROJECT_ID,
  maxKeys: 25,
});
assert.deepEqual(page, {
  objects: [{
    objectKey,
    bytes: fakeMp4.byteLength,
    lastModified: "2026-08-09T00:00:00.000Z",
    etag: '"synthetic-etag"',
  }],
  nextContinuationToken: "synthetic-next-token",
});
assert.doesNotMatch(JSON.stringify(page), /https:|bucket|owner/i);
for (const invalidListResult of [
  {
    objects: [
      { name: objectKey, size: fakeMp4.byteLength },
      { name: objectKey, size: fakeMp4.byteLength },
    ],
    isTruncated: false,
    res: { status: 200 },
  },
  {
    objects: [],
    isTruncated: true,
    nextContinuationToken: "x".repeat(513),
    res: { status: 200 },
  },
  {
    objects: [],
    isTruncated: true,
    res: { status: 200 },
  },
  {
    objects: [],
    isTruncated: true,
    nextContinuationToken: "invalid\ntoken",
    res: { status: 200 },
  },
  {
    objects: [{
      name: objectKey,
      size: fakeMp4.byteLength,
      lastModified: "2026-08-09T00:00:00.000Z",
    }],
    isTruncated: false,
    res: { status: 200 },
  },
] as const) {
  const invalidListTransport = new AliyunOssVideoObjectTransport(
    config,
    credentialSource,
    () => ({
      async listV2() {
        return invalidListResult;
      },
    } as never),
  );
  await assert.rejects(
    () => invalidListTransport.listProjectObjects({
      projectId: PROJECT_ID,
      maxKeys: 1,
    }),
    VideoAssetUnavailableError,
  );
}
await assert.rejects(
  () => transport.listProjectObjects({ projectId: PROJECT_ID, maxKeys: 101 }),
  VideoAssetUnavailableError,
);
await assert.rejects(
  () => transport.headObject({ objectKey: objectKey.replace(TENANT_ID, "other-tenant") }),
  VideoAssetUnavailableError,
);
assert.equal(
  (await transport.deleteObjectIfMatch({
    objectKey,
    contentHash,
    etag: '"synthetic-etag"',
  })).deleted,
  true,
);
assert.ok(clientCreations > 0, "fake SDK calls must pass through the injected client factory");

const reconciliationNow = new Date("2026-08-11T12:00:00.000Z");
const reconciliationHashes = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
const reconciliationKeys = reconciliationHashes.map((hash) =>
  buildAliyunOssVideoObjectKey({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    contentHash: hash,
    contentType: "video/mp4",
  })
);
const referencedKey = reconciliationKeys[1]!;
const reconciliationMetadata = new Map(reconciliationKeys.map((key, index) => [
  key,
  {
    bytes: fakeMp4.byteLength,
    contentType: "video/mp4" as const,
    contentHash: reconciliationHashes[index]!,
    etag: `"reconcile-${index}"`,
  },
]));
const reconciliationDeletes: string[] = [];
const reconciliationReferenceChecks: string[] = [];
const reconciliationResult = await reconcileUnreferencedProjectVideoObjects({
  projectId: PROJECT_ID,
  graceMs: 24 * 60 * 60 * 1000,
  quiescedAt: new Date("2026-08-10T12:00:00.000Z"),
  now: reconciliationNow,
  repository: {
    async hasObjectReference(key) {
      reconciliationReferenceChecks.push(key);
      return key === referencedKey;
    },
  },
  transport: {
    async listProjectObjects(input) {
      assert.equal(input.projectId, PROJECT_ID);
      return {
        objects: reconciliationKeys.map((key, index) => ({
          objectKey: key,
          bytes: fakeMp4.byteLength,
          etag: `"reconcile-${index}"`,
          lastModified: index === 2
            ? "2026-08-11T11:30:00.000Z"
            : "2026-08-09T00:00:00.000Z",
        })),
      };
    },
    async headObject({ objectKey: key }) {
      return reconciliationMetadata.get(key) ?? null;
    },
    async deleteObjectIfMatch(input) {
      const metadata = reconciliationMetadata.get(input.objectKey);
      assert.equal(input.etag, metadata?.etag);
      assert.equal(input.contentHash, metadata?.contentHash);
      reconciliationDeletes.push(input.objectKey);
      return { deleted: true };
    },
  },
});
assert.deepEqual(reconciliationResult, {
  examined: 3,
  deleted: 1,
  referenced: 1,
  recent: 1,
  missing: 0,
});
assert.deepEqual(reconciliationDeletes, [reconciliationKeys[0]]);
assert.equal(
  reconciliationReferenceChecks.filter((key) => key === reconciliationKeys[0]).length,
  2,
  "a grace-aged orphan must be reference-checked again immediately before delete",
);
await assert.rejects(
  () => reconcileUnreferencedProjectVideoObjects({
    projectId: PROJECT_ID,
    graceMs: 1,
    quiescedAt: new Date(0),
    repository: { async hasObjectReference() { return false; } },
    transport: {} as never,
  }),
  VideoAssetUnavailableError,
);
await assert.rejects(
  () => reconcileUnreferencedProjectVideoObjects({
    projectId: PROJECT_ID,
    graceMs: 24 * 60 * 60 * 1000,
    quiescedAt: new Date("2026-08-11T11:30:00.000Z"),
    now: reconciliationNow,
    repository: { async hasObjectReference() { return false; } },
    transport: {} as never,
  }),
  VideoAssetUnavailableError,
  "reconciliation requires uploads to be quiesced for the full grace period",
);
for (const invalidPageInput of [
  { maxKeys: 0 },
  { continuationToken: "" },
] as const) {
  await assert.rejects(
    () => reconcileUnreferencedProjectVideoObjects({
      projectId: PROJECT_ID,
      graceMs: 24 * 60 * 60 * 1000,
      quiescedAt: new Date("2026-08-10T12:00:00.000Z"),
      now: reconciliationNow,
      repository: { async hasObjectReference() { return false; } },
      transport: {
        async listProjectObjects(input) {
          assert.deepEqual(input, {
            projectId: PROJECT_ID,
            ...invalidPageInput,
          });
          throw new Error("invalid paging input");
        },
      } as never,
      ...invalidPageInput,
    }),
    VideoAssetUnavailableError,
  );
}

const secretErrorTransport = new AliyunOssVideoObjectTransport(
  config,
  credentialSource,
  () => ({
    async head() {
      throw {
        status: 500,
        code: "InternalError",
        message: "synthetic-ak synthetic-secret synthetic-token bucket objectKey",
      };
    },
  } as never),
);
await assert.rejects(
  () => secretErrorTransport.headObject({ objectKey }),
  (error: unknown) => {
    assert.ok(error instanceof VideoAssetUnavailableError);
    assert.doesNotMatch(String(error), /synthetic|bucket|objectKey|token/i);
    return true;
  },
);

const mismatchedHeadTransport = new AliyunOssVideoObjectTransport(
  config,
  credentialSource,
  () => ({
    async head() {
      return {
        status: 200,
        meta: {
          "aistory-bytes": String(fakeMp4.byteLength),
          "aistory-content-type": "video/mp4",
          "aistory-sha256": contentHash,
        },
        res: {
          status: 200,
          headers: {
            "content-length": String(fakeMp4.byteLength + 1),
            "content-type": "video/mp4",
            etag: '"synthetic-etag"',
          },
        },
      };
    },
  } as never),
);
await assert.rejects(
  () => mismatchedHeadTransport.headObject({ objectKey }),
  VideoAssetUnavailableError,
  "OSS user metadata must agree with the authoritative full object length",
);

const shortStreamTransport = new AliyunOssVideoObjectTransport(
  config,
  credentialSource,
  () => ({
    async getStream() {
      return {
        stream: Readable.from([Buffer.from(fakeMp4.slice(0, -1))]),
        res: {
          status: 200,
          headers: {
            "content-length": String(fakeMp4.byteLength),
            "content-type": "video/mp4",
            "x-oss-meta-aistory-bytes": String(fakeMp4.byteLength),
            "x-oss-meta-aistory-content-type": "video/mp4",
            "x-oss-meta-aistory-sha256": contentHash,
            etag: '"synthetic-etag"',
          },
        },
      };
    },
  } as never),
);
const shortRead = await shortStreamTransport.readObject({
  objectKey,
  range: null,
});
await assert.rejects(
  () => new Response(shortRead.body).arrayBuffer(),
  /length mismatch/i,
  "a short OSS stream must abort instead of completing a truncated response",
);

let probeFile = "";
const probe = createProductionVideoByteProbe(
  config.ffprobePath,
  async (executable, args, options) => {
    assert.equal(executable, config.ffprobePath);
    assert.deepEqual(args.slice(0, 6), [
      "-nostdin", "-v", "error", "-hide_banner", "-protocol_whitelist", "file",
    ]);
    probeFile = args.at(-1)!;
    assert.equal(options.cwd, path.dirname(probeFile));
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.doesNotMatch(
      Object.keys(options.env).join(" "),
      /SUPABASE|SECRET|TOKEN|ACCESS_KEY|AISTORY|COMFY|MODEL/i,
    );
    assert.equal((await stat(probeFile)).size, fakeMp4.byteLength);
    return {
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            duration: "12",
          },
          { codec_type: "audio", codec_name: "aac" },
        ],
        format: { duration: "12", size: String(fakeMp4.byteLength) },
      }),
    };
  },
);
const probed = await probe({ bytes: fakeMp4, contentHash, contentType: "video/mp4" });
assert.equal(probed.videoCodec, "h264");
assert.equal(existsSync(probeFile), false);
assert.equal(existsSync(path.dirname(probeFile)), false);

let failedProbeFile = "";
const failingProbe = createProductionVideoByteProbe(
  config.ffprobePath,
  async (_executable, args) => {
    failedProbeFile = args.at(-1)!;
    throw new Error("synthetic ffprobe failure with secret-like detail");
  },
);
await assert.rejects(
  () => failingProbe({ bytes: fakeMp4, contentHash, contentType: "video/mp4" }),
  VideoAssetUnavailableError,
);
assert.equal(existsSync(failedProbeFile), false);
assert.equal(existsSync(path.dirname(failedProbeFile)), false);

const storedAsset: StoredVideoAsset = {
  id: "asset-production-runtime-1",
  tenantId: TENANT_ID,
  contentHash,
  contentType: "video/mp4",
  bytes: fakeMp4.byteLength,
  storage: {
    kind: "object",
    provider: "aliyun_oss",
    objectKey,
    etag: '"synthetic-etag"',
  },
  durationMs: 12_000,
  width: 1920,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  hasAudio: true,
  status: "draft",
  releasePolicy: "public",
  projectId: PROJECT_ID,
  storyId: "story-1",
  nodeId: "node-1",
  title: "Synthetic asset",
  subtitles: [],
  source: "upload",
  revision: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};
const idempotency: VideoAssetIdempotency = {
  key: "video-runtime-test:000001",
  fingerprint: "a".repeat(64),
  assetId: storedAsset.id,
  operation: "upload",
  createdAt: storedAsset.createdAt,
};
const audit: VideoAssetAudit = {
  id: "audit-runtime-1",
  actorId: "00000000-0000-4000-8000-000000000001",
  action: "video_asset.upload",
  assetId: storedAsset.id,
  reason: "Synthetic test",
  requestId: "request-runtime-000001",
  createdAt: storedAsset.createdAt,
};

function failingWriteClient(error: unknown): VideoAssetRpcClient {
  return {
    async rpc(name) {
      if (name === "aistory_database_gate_status") {
        return { data: PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION, error: null };
      }
      if (name === "aistory_video_asset_security_posture") {
        return { data: true, error: null };
      }
      return { data: null, error };
    },
  };
}
await assert.rejects(
  () => new SupabaseVideoAssetRepository(
    TENANT_ID,
    () => failingWriteClient({ code: "P0001", message: "redacted" }),
  ).create(storedAsset, idempotency, audit),
  VideoAssetMetadataWriteRejectedError,
  "a SQLSTATE rejection proves the RPC transaction did not commit",
);
for (const rejectedSqlState of [
  "23502", "23503", "23505", "23514", "22P02", "22003",
]) {
  await assert.rejects(
    () => new SupabaseVideoAssetRepository(
      TENANT_ID,
      () => failingWriteClient({ code: rejectedSqlState, message: "redacted" }),
    ).create(storedAsset, idempotency, audit),
    VideoAssetMetadataWriteRejectedError,
    `${rejectedSqlState} must permit created-object rollback after DB rejection`,
  );
}
await assert.rejects(
  () => new SupabaseVideoAssetRepository(
    TENANT_ID,
    () => failingWriteClient({ message: "Gateway timeout after unknown commit" }),
  ).create(storedAsset, idempotency, audit),
  (error: unknown) => {
    assert.ok(error instanceof VideoAssetUnavailableError);
    assert.equal(error instanceof VideoAssetMetadataWriteRejectedError, false);
    assert.doesNotMatch(String(error), /gateway|commit/i);
    return true;
  },
  "ambiguous gateway failures must never authorize synchronous object deletion",
);
for (const ambiguousSqlState of ["08007", "40003"]) {
  await assert.rejects(
    () => new SupabaseVideoAssetRepository(
      TENANT_ID,
      () => failingWriteClient({
        code: ambiguousSqlState,
        message: "transaction outcome unknown",
      }),
    ).create(storedAsset, idempotency, audit),
    (error: unknown) => {
      assert.ok(error instanceof VideoAssetUnavailableError);
      assert.equal(error instanceof VideoAssetMetadataWriteRejectedError, false);
      return true;
    },
    `${ambiguousSqlState} must preserve the created object for reconciliation`,
  );
}

const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
const rpcClient: VideoAssetRpcClient = {
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === "aistory_database_gate_status") {
      return { data: PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION, error: null };
    }
    if (name === "aistory_video_asset_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_video_asset_list") {
      return { data: [storedAsset], error: null };
    }
    if (name === "aistory_video_asset_get") {
      return { data: storedAsset, error: null };
    }
    if (name === "aistory_video_asset_find_idempotency") {
      return { data: idempotency, error: null };
    }
    if (name === "aistory_video_asset_has_object_reference") {
      return { data: true, error: null };
    }
    if (name === "aistory_video_asset_create") {
      const payload = args?.request_payload as { asset: StoredVideoAsset };
      return { data: { asset: { ...payload.asset, revision: 1 }, created: true }, error: null };
    }
    if (name === "aistory_video_asset_mutate") {
      const payload = args?.request_payload as { next: StoredVideoAsset };
      return { data: { asset: { ...payload.next, revision: 2 }, changed: true }, error: null };
    }
    throw new Error(`Unexpected fake RPC ${name}`);
  },
};
const repository = new SupabaseVideoAssetRepository(TENANT_ID, () => rpcClient);
assert.equal(rpcCalls.length, 0, "repository construction must not call Supabase");
assert.deepEqual(await repository.list(), [storedAsset]);
assert.deepEqual(rpcCalls.slice(0, 3).map((call) => call.name), [
  "aistory_database_gate_status",
  "aistory_video_asset_security_posture",
  "aistory_video_asset_list",
]);
assert.equal((await repository.get(storedAsset.id))?.tenantId, TENANT_ID);
assert.deepEqual(await repository.findIdempotency(idempotency.key), idempotency);
assert.equal(await repository.hasObjectReference(objectKey), true);
assert.equal((await repository.create(storedAsset, idempotency, audit)).created, true);
const mutated = await repository.mutateAsset(
  storedAsset.id,
  { ...idempotency, key: "video-runtime-mutate:0001", operation: "mutation" },
  { ...audit, action: "video_asset.submit_review" },
  (asset) => {
    asset.status = "review_pending";
  },
);
assert.equal(mutated.asset.status, "review_pending");
assert.equal(mutated.asset.revision, 2);
for (const call of rpcCalls) {
  if (call.args && "requested_tenant_id" in call.args) {
    assert.equal(call.args.requested_tenant_id, TENANT_ID);
  }
}
assert.doesNotMatch(
  JSON.stringify(rpcCalls.filter((call) => call.name.includes("security_posture"))),
  /synthetic-service-role-key|synthetic-secret|synthetic-token/i,
);

let runtimeCredentialCalls = 0;
let runtimeRpcCalls = 0;
let runtimeSdkCalls = 0;
let runtimeProbeCalls = 0;
const runtimeAdapter = createProductionVideoAssetAdapter(validEnv, {
  credentialSource: {
    async getCredentials() {
      runtimeCredentialCalls += 1;
      return {
        accessKeyId: "runtime-ak",
        accessKeySecret: "runtime-secret",
        securityToken: "runtime-token",
      };
    },
  },
  ossClientFactory: () => {
    runtimeSdkCalls += 1;
    return fakeClientFactory(
      {
        accessKeyId: "synthetic-ak",
        accessKeySecret: "synthetic-secret",
        securityToken: "synthetic-token",
      },
      config,
    );
  },
  rpcClientFactory: () => {
    runtimeRpcCalls += 1;
    return rpcClient;
  },
  probeExecRunner: async () => {
    runtimeProbeCalls += 1;
    throw new Error("not invoked by capability");
  },
});
const productionActor: AdminActor = {
  userId: "00000000-0000-4000-8000-000000000001",
  roles: ["super_admin"],
  mode: "production",
};
assert.equal(
  videoAssetCapabilityStatus(productionActor, {
    production: runtimeAdapter,
    allowTestAdapter: true,
  }).available,
  true,
);
assert.deepEqual(
  [runtimeCredentialCalls, runtimeRpcCalls, runtimeSdkCalls, runtimeProbeCalls],
  [0, 0, 0, 0],
  "capability inspection must be zero-network",
);
const cachedRouteOptionsA = getRuntimeVideoAssetServiceOptions(validEnv);
const cachedRouteOptionsB = getRuntimeVideoAssetServiceOptions(validEnv);
assert.ok(cachedRouteOptionsA.production);
assert.equal(
  cachedRouteOptionsA.production,
  cachedRouteOptionsB.production,
  "route composition must reuse the lazy credential and repository session",
);

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260811193000_production_video_asset_metadata_gate.sql",
);
const migration = await readFile(migrationPath, "utf8");
assert.match(migration, /requires gate13/);
assert.match(migration, /is distinct from '20260809113000'/);
assert.match(migration, /values \('production_identity_billing', '20260811193000'\)/);
assert.match(migration, /alter table public\.video_assets force row level security/i);
assert.match(migration, /alter table public\.video_asset_idempotency force row level security/i);
assert.match(migration, /video_assets_object_key_check/);
assert.match(migration, /video_asset_idempotency_append_only/);
assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public/i);
for (const rpc of [
  "aistory_video_asset_list",
  "aistory_video_asset_get",
  "aistory_video_asset_find_idempotency",
  "aistory_video_asset_has_object_reference",
  "aistory_video_asset_create",
  "aistory_video_asset_mutate",
  "aistory_video_asset_security_posture",
]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${rpc}`));
}
assert.match(migration, /to service_role/);
assert.doesNotMatch(
  migration,
  /access[_-]?key|secret[_-]?key|security[_-]?token|provider_task|workflow|prompt/i,
);
const gate13 = await readFile(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260809113000_phone_admin_identity_gate.sql",
  ),
);
assert.equal(gate13.byteLength, 9076);
assert.equal(
  createHash("sha256").update(gate13).digest("hex"),
  "b922f10078f0eccda9fbb8fc9b821d4d6eb55acb1014db076f96d1788936d32e",
);

for (const routePath of [
  path.join("app", "api", "admin", "video-assets", "route.ts"),
  path.join("app", "api", "admin", "video-assets", "[assetId]", "route.ts"),
  path.join("app", "api", "admin", "video-assets", "[assetId]", "content", "route.ts"),
  path.join("app", "api", "video-assets", "[assetId]", "content", "route.ts"),
]) {
  const source = await readFile(path.join(process.cwd(), routePath), "utf8");
  assert.match(source, /getRuntimeVideoAssetServiceOptions/);
  assert.doesNotMatch(source, /bucket|objectKey|accessKey|secretKey|securityToken/i);
}
const adminPanelSource = await readFile(
  path.join(process.cwd(), "components", "AdminVideoAssetsPanel.tsx"),
  "utf8",
);
assert.match(
  adminPanelSource,
  /setData\(isAssetResponse\(assetsPayload\) \? assetsPayload : null\)/,
  "a structured 503 must clear stale ready state and retain its safe capability DTO",
);
assert.match(
  adminPanelSource,
  /async function adopt[\s\S]*?!data\?\.capability\.uploadAvailable/,
  "generation adoption must fail closed when production upload is unavailable",
);
assert.match(
  adminPanelSource,
  /productionProjectRequired[\s\S]*?Number\.isSafeInteger\(parsedProjectId\)/,
  "production upload UI must require a valid project binding",
);
assert.doesNotMatch(
  adminPanelSource,
  /aliyuncs|100\.100\.100\.200|accessKey|secretKey|securityToken/i,
);
const transportSource = await readFile(
  path.join(
    process.cwd(),
    "lib",
    "video-assets",
    "production",
    "aliyunOssTransport.ts",
  ),
  "utf8",
);
assert.match(transportSource, /"x-oss-forbid-overwrite": "true"/);
assert.match(transportSource, /retryMax: 0/);
assert.match(transportSource, /refreshSTSTokenInterval: 300_000/);
assert.doesNotMatch(transportSource, /listBuckets|putBucket|deleteBucket|ACL/i);
const aliOssDebugSources = await Promise.all([
  "lib/client.js",
  "lib/object.js",
  "lib/sts.js",
  "lib/common/multipart-copy.js",
  "lib/common/utils/createRequest.js",
].map((relativePath) =>
  readFile(path.join(process.cwd(), "node_modules", "ali-oss", relativePath), "utf8")
));
assert.match(aliOssDebugSources.join("\n"), /x-oss-security-token/);
assert.match(aliOssDebugSources.join("\n"), /authorization/i);
for (const namespace of [
  "ali-oss",
  "ali-oss:object",
  "ali-oss:sts",
  "ali-oss:multipart-copy",
]) {
  assert.equal(
    inspectProductionVideoAssetConfig({ ...validEnv, DEBUG: namespace }).ready,
    false,
    `SDK debug namespace ${namespace} must fail closed before credential use`,
  );
}

console.log("production video asset runtime adapter zero-network tests passed");
