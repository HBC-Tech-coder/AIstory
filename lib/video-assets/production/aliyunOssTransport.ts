import "server-only";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

import { VideoAssetUnavailableError } from "../errors";
import {
  assertVideoObjectMetadata,
  buildAliyunOssVideoObjectKey,
  type VideoObjectByteRange,
  type VideoObjectMetadata,
  type VideoObjectReadResult,
  type VideoObjectReconciliationPage,
  type VideoObjectReconciliationTransport,
  type VideoObjectStorageTransport,
} from "../objectStorage";
import type { ProductionVideoAssetConfig } from "./config";
import type {
  AliyunOssCredentialSource,
  AliyunOssSessionCredentials,
} from "./credentials";

type AliOssResponse = {
  status?: number;
  statusCode?: number;
  headers?: Record<string, unknown>;
};

type AliOssClientLike = {
  put(
    objectKey: string,
    bytes: Buffer,
    options: Record<string, unknown>,
  ): Promise<{ res?: AliOssResponse }>;
  head(
    objectKey: string,
    options?: Record<string, unknown>,
  ): Promise<{
    status?: number;
    meta?: Record<string, unknown> | null;
    res?: AliOssResponse;
  }>;
  getStream(
    objectKey: string,
    options?: Record<string, unknown>,
  ): Promise<{ stream: NodeJS.ReadableStream; res?: AliOssResponse }>;
  delete(
    objectKey: string,
    options?: Record<string, unknown>,
  ): Promise<{ res?: AliOssResponse }>;
  listV2(
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{
    objects?: Array<{
      name?: unknown;
      size?: unknown;
      etag?: unknown;
      lastModified?: unknown;
    }>;
    isTruncated?: boolean;
    nextContinuationToken?: unknown;
    res?: AliOssResponse;
  }>;
};

type AliOssConstructor = new (options: Record<string, unknown>) => AliOssClientLike;

export type AliyunOssClientFactory = (
  credentials: AliyunOssSessionCredentials,
  config: ProductionVideoAssetConfig,
) => AliOssClientLike;

const require = createRequire(import.meta.url);

function defaultClientFactory(
  credentials: AliyunOssSessionCredentials,
  config: ProductionVideoAssetConfig,
): AliOssClientLike {
  const AliOss = require("ali-oss") as AliOssConstructor;
  return new AliOss({
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken,
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    internal: true,
    secure: true,
    timeout: config.ossTimeoutMs,
    retryMax: 0,
    // The transport creates a fresh client from the cached ECS-role provider
    // for each operation. A non-zero interval suppresses the SDK's STS warning;
    // without refreshSTSToken the SDK schedules no refresh or background work.
    refreshSTSTokenInterval: 300_000,
  });
}

function statusOf(response: AliOssResponse | undefined): number | undefined {
  return response?.status ?? response?.statusCode;
}

function headersOf(response: AliOssResponse | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response?.headers ?? {})) {
    if (typeof value === "string" || typeof value === "number") {
      headers[key.toLowerCase()] = String(value);
    }
  }
  return headers;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = Number(record.status ?? record.statusCode);
  return Number.isInteger(status) ? status : undefined;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { code?: unknown; name?: unknown };
  return typeof record.code === "string"
    ? record.code
    : typeof record.name === "string"
      ? record.name
      : "";
}

function isMissing(error: unknown): boolean {
  return errorStatus(error) === 404
    || ["NoSuchKey", "NotFound", "NoSuchObject"].includes(errorCode(error));
}

function isCreateConflict(error: unknown): boolean {
  return [409, 412].includes(errorStatus(error) ?? 0)
    || ["FileAlreadyExists", "ObjectAlreadyExists", "PreconditionFailed"].includes(
      errorCode(error),
    );
}

function isDeleteConflict(error: unknown): boolean {
  return isMissing(error)
    || errorStatus(error) === 412
    || errorCode(error) === "PreconditionFailed";
}

function parsePositiveSafeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid OSS object length.");
  }
  return parsed;
}

function cleanEtag(value: unknown): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 200
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Invalid OSS object ETag.");
  }
  return value.trim();
}

function cleanContinuationToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("Invalid OSS continuation token.");
  }
  const token = value.trim();
  if (
    !token
    || token !== value
    || token.length > 512
    || /[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new Error("Invalid OSS continuation token.");
  }
  return token;
}

function cleanLastModified(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid OSS object timestamp.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid OSS object timestamp.");
  }
  return new Date(timestamp).toISOString();
}

function parseMetadata(
  headers: Record<string, string>,
  meta?: Record<string, unknown> | null,
  verifyFullContentLength = false,
): VideoObjectMetadata {
  const contentEncoding = headers["content-encoding"];
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new Error("Encoded OSS video objects are unsupported.");
  }
  const bytes = parsePositiveSafeInteger(
    meta?.["aistory-bytes"] ?? headers["x-oss-meta-aistory-bytes"]
      ?? headers["content-length"],
  );
  if (
    verifyFullContentLength
    && parsePositiveSafeInteger(headers["content-length"]) !== bytes
  ) {
    throw new Error("OSS object length metadata mismatch.");
  }
  const contentType = String(
    meta?.["aistory-content-type"]
      ?? headers["x-oss-meta-aistory-content-type"]
      ?? headers["content-type"]
      ?? "",
  ).toLowerCase();
  if (contentType !== "video/mp4" && contentType !== "video/webm") {
    throw new Error("Invalid OSS video content type.");
  }
  const contentHash = String(
    meta?.["aistory-sha256"]
      ?? headers["x-oss-meta-aistory-sha256"]
      ?? "",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error("Invalid OSS video content hash.");
  }
  return {
    bytes,
    contentType,
    contentHash,
    etag: cleanEtag(headers.etag),
  };
}

function wrapUnavailable(error: unknown): never {
  if (error instanceof VideoAssetUnavailableError) throw error;
  throw new VideoAssetUnavailableError();
}

function countedWebStream(
  stream: NodeJS.ReadableStream,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  const nodeStream = stream as Readable;
  const reader = (Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>)
    .getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (received !== expectedBytes) {
            controller.error(new Error("OSS response body length mismatch."));
          } else {
            controller.close();
          }
          return;
        }
        received += next.value.byteLength;
        if (received > expectedBytes) {
          await reader.cancel();
          controller.error(new Error("OSS response body exceeds declared length."));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(new VideoAssetUnavailableError());
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      nodeStream.destroy();
    },
  });
}

export class AliyunOssVideoObjectTransport
  implements VideoObjectStorageTransport, VideoObjectReconciliationTransport {
  readonly provider = "aliyun_oss" as const;

  constructor(
    readonly config: ProductionVideoAssetConfig,
    private readonly credentialSource: AliyunOssCredentialSource,
    private readonly clientFactory: AliyunOssClientFactory = defaultClientFactory,
  ) {}

  private async client(): Promise<AliOssClientLike> {
    try {
      return this.clientFactory(
        await this.credentialSource.getCredentials(),
        this.config,
      );
    } catch (error) {
      return wrapUnavailable(error);
    }
  }

  private assertObjectKey(objectKey: string): void {
    const escapedPrefix = this.config.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedTenant = this.config.tenantId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `^${escapedPrefix}/tenants/${escapedTenant}/projects/([1-9][0-9]*)/sha256/([a-f0-9]{2})/([a-f0-9]{64})\\.(mp4|webm)$`,
    ).exec(objectKey);
    if (!match || match[2] !== match[3]?.slice(0, 2)) {
      throw new VideoAssetUnavailableError();
    }
  }

  async putObjectIfAbsent(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: "video/mp4" | "video/webm";
    contentHash: string;
    tenantId: string;
    projectId: number;
  }) {
    try {
      this.assertObjectKey(input.objectKey);
      if (
        input.tenantId !== this.config.tenantId
        || input.objectKey !== buildAliyunOssVideoObjectKey(input)
        || createHash("sha256").update(input.bytes).digest("hex")
          !== input.contentHash
      ) {
        throw new Error("OSS put contract mismatch.");
      }
      const client = await this.client();
      try {
        const result = await client.put(input.objectKey, Buffer.from(input.bytes), {
          mime: input.contentType,
          headers: {
            "Content-Length": String(input.bytes.byteLength),
            "Content-Type": input.contentType,
            "x-oss-forbid-overwrite": "true",
          },
          meta: {
            "aistory-bytes": String(input.bytes.byteLength),
            "aistory-content-type": input.contentType,
            "aistory-sha256": input.contentHash,
          },
        });
        if (statusOf(result.res) !== 200) {
          throw new Error("Unexpected OSS put status.");
        }
        const headers = headersOf(result.res);
        return {
          bytes: input.bytes.byteLength,
          contentType: input.contentType,
          contentHash: input.contentHash,
          etag: cleanEtag(headers.etag),
          created: true,
        };
      } catch (error) {
        if (!isCreateConflict(error)) throw error;
        const existing = await this.headObject({ objectKey: input.objectKey });
        if (!existing) throw new Error("OSS create conflict without object.");
        return {
          ...assertVideoObjectMetadata(existing, {
            bytes: input.bytes.byteLength,
            contentType: input.contentType,
            contentHash: input.contentHash,
          }),
          created: false,
        };
      }
    } catch (error) {
      return wrapUnavailable(error);
    }
  }

  async headObject(input: {
    objectKey: string;
  }): Promise<VideoObjectMetadata | null> {
    try {
      this.assertObjectKey(input.objectKey);
      try {
        const result = await (await this.client()).head(input.objectKey);
        if ((result.status ?? statusOf(result.res)) !== 200) {
          throw new Error("Unexpected OSS head status.");
        }
        return parseMetadata(headersOf(result.res), result.meta, true);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    } catch (error) {
      return wrapUnavailable(error);
    }
  }

  async readObject(input: {
    objectKey: string;
    range: VideoObjectByteRange | null;
  }): Promise<VideoObjectReadResult> {
    let stream: NodeJS.ReadableStream | undefined;
    try {
      this.assertObjectKey(input.objectKey);
      const headers = input.range
        ? { Range: `bytes=${input.range.start}-${input.range.end}` }
        : {};
      const result = await (await this.client()).getStream(input.objectKey, {
        headers,
      });
      stream = result.stream;
      const responseHeaders = headersOf(result.res);
      const expectedStatus = input.range ? 206 : 200;
      if (statusOf(result.res) !== expectedStatus) {
        throw new Error("Unexpected OSS object read status.");
      }
      const metadata = parseMetadata(responseHeaders, undefined, !input.range);
      const contentLength = parsePositiveSafeInteger(
        responseHeaders["content-length"],
      );
      if (input.range) {
        const expectedLength = input.range.end - input.range.start + 1;
        if (
          contentLength !== expectedLength
          || responseHeaders["content-range"] !==
            `bytes ${input.range.start}-${input.range.end}/${metadata.bytes}`
        ) {
          throw new Error("OSS range response mismatch.");
        }
      } else if (contentLength !== metadata.bytes) {
        throw new Error("OSS full response length mismatch.");
      }
      return {
        body: countedWebStream(stream, contentLength),
        metadata,
        contentLength,
      };
    } catch (error) {
      if (stream && "destroy" in stream) {
        (stream as Readable).destroy();
      }
      return wrapUnavailable(error);
    }
  }

  async deleteObjectIfMatch(input: {
    objectKey: string;
    contentHash: string;
    etag?: string;
  }): Promise<{ deleted: boolean }> {
    try {
      this.assertObjectKey(input.objectKey);
      if (!input.etag) return { deleted: false };
      const existing = await this.headObject({ objectKey: input.objectKey });
      if (
        !existing
        || existing.contentHash !== input.contentHash
        || existing.etag !== input.etag
      ) {
        return { deleted: false };
      }
      try {
        const result = await (await this.client()).delete(input.objectKey, {
          headers: { "If-Match": input.etag },
        });
        if (statusOf(result.res) !== 204) {
          throw new Error("Unexpected OSS delete status.");
        }
        return { deleted: true };
      } catch (error) {
        if (isDeleteConflict(error)) return { deleted: false };
        throw error;
      }
    } catch (error) {
      return wrapUnavailable(error);
    }
  }

  async listProjectObjects(input: {
    projectId: number;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<VideoObjectReconciliationPage> {
    try {
      if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
        throw new Error("Invalid reconciliation project.");
      }
      const maxKeys = input.maxKeys ?? 50;
      if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100) {
        throw new Error("Invalid reconciliation page size.");
      }
      const continuationToken = cleanContinuationToken(input.continuationToken);
      const prefix = `${this.config.prefix}/tenants/${this.config.tenantId}/projects/${input.projectId}/`;
      const result = await (await this.client()).listV2({
        prefix,
        "max-keys": maxKeys,
        ...(continuationToken
          ? { "continuation-token": continuationToken }
          : {}),
      });
      if (statusOf(result.res) !== 200) {
        throw new Error("Unexpected OSS list status.");
      }
      const rawObjects = result.objects ?? [];
      if (!Array.isArray(rawObjects) || rawObjects.length > maxKeys) {
        throw new Error("Invalid OSS reconciliation page.");
      }
      const objects = rawObjects.map((object) => {
        if (typeof object.name !== "string") {
          throw new Error("Invalid OSS list entry.");
        }
        this.assertObjectKey(object.name);
        if (!object.name.startsWith(prefix)) {
          throw new Error("Cross-prefix OSS list entry.");
        }
        return {
          objectKey: object.name,
          bytes: parsePositiveSafeInteger(object.size),
          lastModified: cleanLastModified(object.lastModified),
          etag: cleanEtag(object.etag),
        };
      });
      const next = cleanContinuationToken(result.nextContinuationToken);
      if (result.isTruncated && !next) {
        throw new Error("Invalid OSS list continuation response.");
      }
      return {
        objects,
        ...(result.isTruncated && next
          ? { nextContinuationToken: next }
          : {}),
      };
    } catch (error) {
      return wrapUnavailable(error);
    }
  }
}
