import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEGAL_VIDEO_SOURCE_BYTES = 6_601_802;
const LEGAL_VIDEO_SOURCE_SHA256 =
  "aa9e676f730c1472ed10cc3f042d21587679d721bbbfaa1f4bf6854a264fe8dd";
const MEDIA_ROOT_NAME = "harness-media";
const LEGAL_VIDEO_NAME = "legal-world-model-excerpt.mp4";
const LEGAL_VIDEO_MANIFEST_NAME = "legal-world-model-excerpt.manifest.json";
const MAX_LEGAL_VIDEO_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024;
const CORRUPT_RESPONSE_DELAY_MS = 500;
const CORRUPT_VIDEO = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x6d, 0x70, 0x34, 0x31,
  0x00, 0x00, 0x00, 0x20, 0x6d, 0x6f, 0x6f, 0x76,
]);
const CONTROLLED_VTT = new TextEncoder().encode(
  [
    "WEBVTT",
    "",
    "p114-vtt-1",
    "00:00:00.100 --> 00:00:01.000",
    "P1.14 受控 WebVTT 字幕",
    "",
  ].join("\n"),
);

type RouteContext = { params: Promise<{ asset: string }> };
type ByteRange = { start: number; end: number };
type LegalVideoManifest = {
  schemaVersion: 1;
  source: {
    id: "world-model-little-chef";
    bytes: number;
    sha256: string;
  };
  derived: {
    kind: "local_browser_smoke_excerpt";
    bytes: number;
    sha256: string;
  };
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseLegalManifest(bytes: Uint8Array): LegalVideoManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("p114_legal_manifest_size_invalid");
  }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isPlainRecord(parsed) ||
    !exactKeys(parsed, ["schemaVersion", "source", "derived"]) ||
    parsed.schemaVersion !== 1 ||
    !isPlainRecord(parsed.source) ||
    !exactKeys(parsed.source, ["id", "bytes", "sha256"]) ||
    parsed.source.id !== "world-model-little-chef" ||
    parsed.source.bytes !== LEGAL_VIDEO_SOURCE_BYTES ||
    parsed.source.sha256 !== LEGAL_VIDEO_SOURCE_SHA256 ||
    !isPlainRecord(parsed.derived) ||
    !exactKeys(parsed.derived, ["kind", "bytes", "sha256"]) ||
    parsed.derived.kind !== "local_browser_smoke_excerpt" ||
    !Number.isSafeInteger(parsed.derived.bytes) ||
    Number(parsed.derived.bytes) <= 0 ||
    Number(parsed.derived.bytes) > MAX_LEGAL_VIDEO_BYTES ||
    typeof parsed.derived.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.derived.sha256)
  ) {
    throw new Error("p114_legal_manifest_invalid");
  }
  return parsed as LegalVideoManifest;
}

function safeHeaders(contentType: string): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

function parseRange(value: string | null, size: number): ByteRange | null | false {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return false;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function bytesResponse(
  request: Request,
  bytes: Uint8Array,
  contentType: string,
): Response {
  const range = parseRange(request.headers.get("range"), bytes.byteLength);
  const headers = safeHeaders(contentType);
  if (range === false) {
    headers.set("Content-Range", `bytes */${bytes.byteLength}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  if (range === null) {
    headers.set("Content-Length", String(bytes.byteLength));
    return new Response(
      request.method === "HEAD" ? null : new Uint8Array(bytes).buffer,
      { status: 200, headers },
    );
  }

  const body = bytes.slice(range.start, range.end + 1);
  headers.set("Content-Length", String(body.byteLength));
  headers.set(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
  );
  return new Response(
    request.method === "HEAD" ? null : new Uint8Array(body).buffer,
    { status: 206, headers },
  );
}

async function readPinnedLegalVideo(): Promise<Uint8Array> {
  const mediaRoot = await realpath(path.resolve(process.cwd(), MEDIA_ROOT_NAME));
  const candidate = path.resolve(mediaRoot, LEGAL_VIDEO_NAME);
  const manifestFile = path.resolve(mediaRoot, LEGAL_VIDEO_MANIFEST_NAME);
  const relative = path.relative(mediaRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("p114_legal_video_outside_media_root");
  }

  const candidateReal = await realpath(candidate);
  const manifestReal = await realpath(manifestFile);
  const realRelative = path.relative(mediaRoot, candidateReal);
  const manifestRelative = path.relative(mediaRoot, manifestReal);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative) ||
    !manifestRelative ||
    manifestRelative.startsWith("..") ||
    path.isAbsolute(manifestRelative)
  ) {
    throw new Error("p114_legal_video_realpath_outside_media_root");
  }

  const manifestHandle = await open(manifestReal, fsConstants.O_RDONLY);
  let manifest: LegalVideoManifest;
  try {
    const before = await manifestHandle.stat();
    if (!before.isFile() || before.size > MAX_MANIFEST_BYTES) {
      throw new Error("p114_legal_manifest_stat_invalid");
    }
    const manifestBytes = await manifestHandle.readFile();
    const after = await manifestHandle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("p114_legal_manifest_drift");
    }
    manifest = parseLegalManifest(new Uint8Array(manifestBytes));
  } finally {
    await manifestHandle.close();
  }

  const handle = await open(candidateReal, fsConstants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== manifest.derived.bytes ||
      before.size > MAX_LEGAL_VIDEO_BYTES
    ) {
      throw new Error("p114_legal_video_stat_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== manifest.derived.bytes ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !==
        manifest.derived.sha256
    ) {
      throw new Error("p114_legal_video_integrity_invalid");
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close();
  }
}

function notFound(request: Request): Response {
  const headers = safeHeaders("text/plain; charset=utf-8");
  headers.set("Content-Length", request.method === "HEAD" ? "0" : "9");
  return new Response(request.method === "HEAD" ? null : "not found", {
    status: 404,
    headers,
  });
}

async function respond(request: Request, context: RouteContext): Promise<Response> {
  const { asset } = await context.params;
  try {
    if (asset === "legal.mp4") {
      return bytesResponse(request, await readPinnedLegalVideo(), "video/mp4");
    }
    if (asset === "corrupt.mp4") {
      await new Promise((resolve) =>
        setTimeout(resolve, CORRUPT_RESPONSE_DELAY_MS),
      );
      return bytesResponse(request, CORRUPT_VIDEO, "video/mp4");
    }
    if (asset === "subtitles.vtt") {
      return bytesResponse(
        request,
        CONTROLLED_VTT,
        "text/vtt; charset=utf-8",
      );
    }
    return notFound(request);
  } catch {
    const headers = safeHeaders("text/plain; charset=utf-8");
    headers.set("Content-Length", "0");
    return new Response(null, { status: 503, headers });
  }
}

export const GET = respond;
export const HEAD = respond;
