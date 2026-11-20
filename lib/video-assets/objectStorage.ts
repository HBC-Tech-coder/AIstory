import "server-only";

export type VideoObjectContentType = "video/mp4" | "video/webm";

export type VideoObjectByteRange = {
  start: number;
  end: number;
};

export type VideoObjectMetadata = {
  bytes: number;
  contentType: VideoObjectContentType;
  contentHash: string;
  etag?: string;
};

export type VideoObjectPutResult = VideoObjectMetadata & {
  created: boolean;
};

export type VideoObjectReadResult = {
  body: Uint8Array | ReadableStream<Uint8Array>;
  metadata: VideoObjectMetadata;
  contentLength: number;
};

export const ALIYUN_OSS_VIDEO_PREFIX = "aistory/video-assets/v1";

/**
 * Server-only object storage boundary. Implementations must keep the bucket
 * private, conditionally create by object key, and verify an existing object's
 * hash/size/type before reporting an idempotent replay. They must never return
 * a provider URL to a browser-facing caller.
 */
export interface VideoObjectStorageTransport {
  readonly provider: "aliyun_oss";

  putObjectIfAbsent(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: VideoObjectContentType;
    contentHash: string;
    tenantId: string;
    projectId: number;
  }): Promise<VideoObjectPutResult>;

  headObject(input: {
    objectKey: string;
  }): Promise<VideoObjectMetadata | null>;

  readObject(input: {
    objectKey: string;
    range: VideoObjectByteRange | null;
  }): Promise<VideoObjectReadResult>;

  deleteObjectIfMatch(input: {
    objectKey: string;
    contentHash: string;
    etag?: string;
  }): Promise<{ deleted: boolean }>;
}

export type VideoObjectReconciliationEntry = {
  objectKey: string;
  bytes: number;
  lastModified: string;
  etag: string;
};

export type VideoObjectReconciliationPage = {
  objects: VideoObjectReconciliationEntry[];
  nextContinuationToken?: string;
};

/**
 * Administrative reconciliation is deliberately narrower than the delivery
 * transport. Implementations choose the tenant/project prefix; callers never
 * receive a bucket-wide or arbitrary-prefix listing primitive.
 */
export interface VideoObjectReconciliationTransport {
  listProjectObjects(input: {
    projectId: number;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<VideoObjectReconciliationPage>;
}

function safeNamespaceSegment(value: string, label: string): string {
  const segment = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(segment)) {
    throw new Error(`${label}不合法。`);
  }
  return segment;
}

function extensionFor(contentType: VideoObjectContentType): "mp4" | "webm" {
  return contentType === "video/mp4" ? "mp4" : "webm";
}

export function buildAliyunOssVideoObjectKey(input: {
  tenantId: string;
  projectId: number;
  contentHash: string;
  contentType: VideoObjectContentType;
}): string {
  const tenantId = safeNamespaceSegment(input.tenantId, "租户 ID");
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    throw new Error("项目 ID 不合法。");
  }
  const contentHash = input.contentHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error("视频内容哈希不合法。");
  }
  return [
    ALIYUN_OSS_VIDEO_PREFIX,
    "tenants",
    tenantId,
    "projects",
    String(input.projectId),
    "sha256",
    contentHash.slice(0, 2),
    `${contentHash}.${extensionFor(input.contentType)}`,
  ].join("/");
}

export function assertVideoObjectMetadata(
  actual: VideoObjectMetadata,
  expected: {
    bytes: number;
    contentType: VideoObjectContentType;
    contentHash: string;
  },
): VideoObjectMetadata {
  if (
    actual.bytes !== expected.bytes ||
    actual.contentType !== expected.contentType ||
    actual.contentHash.toLowerCase() !== expected.contentHash.toLowerCase()
  ) {
    throw new Error("视频对象存储完整性校验失败。");
  }
  if (actual.etag !== undefined && !actual.etag.trim()) {
    throw new Error("视频对象存储 ETag 不合法。");
  }
  return actual;
}

export function assertVideoObjectEtag(
  actual: VideoObjectMetadata,
  expectedEtag: string | undefined,
): VideoObjectMetadata {
  if (expectedEtag !== undefined && actual.etag !== expectedEtag) {
    throw new Error("视频对象存储 ETag 完整性校验失败。");
  }
  return actual;
}
