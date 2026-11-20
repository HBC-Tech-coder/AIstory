import "server-only";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { isLoopbackReadRequest } from "@/lib/security/localMutation";
import type { VideoAssetContent } from "./server";
import {
  assertVideoObjectEtag,
  assertVideoObjectMetadata,
  type VideoObjectReadResult,
} from "./objectStorage";
import {
  asVideoAssetUnavailableError,
  VideoAssetUnavailableError,
} from "./errors";

export function parseVideoByteRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match) throw new Error("INVALID_RANGE");
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    const suffix = Math.min(end, size);
    start = size - suffix;
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) throw new Error("INVALID_RANGE");
    if (!Number.isFinite(end)) end = size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new Error("INVALID_RANGE");
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function streamVideoFile(
  request: Request,
  file: string,
  contentType: "video/mp4" | "video/webm",
  cacheControl: string,
  contentHash?: string,
  expectedBytes?: number,
): Promise<Response> {
  const metadata = await stat(file);
  const size = metadata.size;
  if (
    !metadata.isFile() ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    (expectedBytes !== undefined && size !== expectedBytes)
  ) {
    throw new Error("VIDEO_FILE_METADATA_MISMATCH");
  }
  const headers = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    ...(contentHash ? { ETag: `"sha256-${contentHash}"` } : {}),
  });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }
  let range: { start: number; end: number } | null;
  try {
    range = parseVideoByteRange(request.headers.get("range"), size);
  } catch {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    headers.set("Cache-Control", "no-store");
    return new Response(null, {
      status: 416,
      headers,
    });
  }
  if (!range) {
    headers.set("Content-Length", String(size));
    const stream = Readable.toWeb(createReadStream(file));
    return new Response(stream as ReadableStream, { status: 200, headers });
  }
  const length = range.end - range.start + 1;
  headers.set("Content-Length", String(length));
  headers.set(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${size}`,
  );
  const stream = Readable.toWeb(
    createReadStream(file, { start: range.start, end: range.end }),
  );
  return new Response(stream as ReadableStream, { status: 206, headers });
}

async function streamVideoObject(
  request: Request,
  content: Extract<VideoAssetContent, { kind: "object" }>,
  cacheControl: string,
): Promise<Response> {
  const size = content.asset.bytes;
  const headers = new Headers({
    "Content-Type": content.asset.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    ETag: `"sha256-${content.asset.contentHash}"`,
  });
  const expectedEtag = content.asset.storage.kind === "object"
    ? content.asset.storage.etag
    : undefined;
  if (request.method === "HEAD") {
    try {
      const metadata = await content.transport.headObject({
        objectKey: content.objectKey,
      });
      if (!metadata) throw new Error("VIDEO_OBJECT_NOT_FOUND");
      assertVideoObjectMetadata(metadata, content.asset);
      assertVideoObjectEtag(metadata, expectedEtag);
    } catch (error) {
      throw asVideoAssetUnavailableError(error);
    }
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }
  let range: { start: number; end: number } | null;
  try {
    range = parseVideoByteRange(request.headers.get("range"), size);
  } catch {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    headers.set("Cache-Control", "no-store");
    return new Response(null, {
      status: 416,
      headers,
    });
  }
  let result: VideoObjectReadResult | undefined;
  try {
    result = await content.transport.readObject({
      objectKey: content.objectKey,
      range,
    });
    assertVideoObjectMetadata(result.metadata, content.asset);
    assertVideoObjectEtag(result.metadata, expectedEtag);
  } catch (error) {
    if (
      result?.body instanceof ReadableStream
    ) {
      await result.body.cancel().catch(() => undefined);
    }
    throw asVideoAssetUnavailableError(error);
  }
  if (!result) throw new VideoAssetUnavailableError();
  const expectedLength = range ? range.end - range.start + 1 : size;
  if (
    result.contentLength !== expectedLength ||
    (result.body instanceof Uint8Array &&
      result.body.byteLength !== expectedLength)
  ) {
    if (result.body instanceof ReadableStream) {
      await result.body.cancel().catch(() => undefined);
    }
    throw asVideoAssetUnavailableError(
      new Error("VIDEO_OBJECT_LENGTH_MISMATCH"),
    );
  }
  headers.set("Content-Length", String(expectedLength));
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${size}`,
    );
  }
  return new Response(result.body as BodyInit, {
    status: range ? 206 : 200,
    headers,
  });
}

export async function streamVideoAssetContent(
  request: Request,
  content: VideoAssetContent,
  cacheControl: string,
): Promise<Response> {
  if (content.kind === "local") {
    if (!isLoopbackReadRequest(request)) {
      throw new Error("LOCAL_VIDEO_ASSET_READ_REQUIRES_LOOPBACK");
    }
    return streamVideoFile(
      request,
      content.file,
      content.asset.contentType,
      cacheControl,
      content.asset.contentHash,
      content.asset.bytes,
    );
  }
  return streamVideoObject(request, content, cacheControl);
}

