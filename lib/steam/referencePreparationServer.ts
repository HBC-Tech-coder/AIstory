import "server-only";

import { createHash } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  blockedSteamReferencePreparation,
  deriveSteamReferencePreparation,
  STEAM_REFERENCE_PREPARATION_AUTHORITY,
  STEAM_REFERENCE_PREPARATION_LIMITS,
  STEAM_REFERENCE_PREPARATION_PNG_POLICY,
  STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES,
  STEAM_REFERENCE_PREPARATION_ROLE_ORDER,
  STEAM_REFERENCE_PREPARATION_TARGETS,
  type SteamReferencePreparationFailureCode,
  type SteamReferencePreparationInput,
  type SteamReferencePreparationManifest,
} from "@/lib/steam/referencePreparation";

const ASSET_MANIFEST_BASENAME = "asset-manifest.v1.1.json";
const VIDEO_PROMPTS_BASENAME = "video-prompts.v1.1.json";
const GENERATED_ASSETS_BASENAME = "generated-assets";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFE_PNG_BASENAME = /^[a-z0-9][a-z0-9._-]{0,151}\.png$/;
const SHA256 = /^[a-f0-9]{64}$/;

const ASSET_MANIFEST_ROOT_KEYS = [
  "schemaVersion",
  "caseStudyId",
  "releaseVersion",
  "statusLegend",
  "formStateFields",
  "sourceReferences",
  "assets",
] as const;
const ASSET_KEYS = [
  "assetId",
  "kind",
  "sceneId",
  "status",
  "localPath",
  "releasePolicy",
  "formState",
  "visualState",
  "bytes",
  "sha256",
  "source",
] as const;
const VIDEO_PROMPTS_ROOT_KEYS = [
  "schemaVersion",
  "caseStudyId",
  "releaseVersion",
  "targetDurationSeconds",
  "referenceLibrary",
  "shots",
] as const;
const REFERENCE_KEYS = ["id", "file", "purpose"] as const;
const SHOT_KEYS = [
  "shotId",
  "episodeId",
  "sceneId",
  "nodeId",
  "title",
  "durationSeconds",
  "sourceParagraphIds",
  "sourceTextVerbatim",
  "releasePolicy",
  "autoSubmit",
  "referenceIds",
  "referenceUploadOrder",
  "prompt",
  "negativePrompt",
  "firstFrameAsset",
  "continuity",
] as const;

type JsonRecord = Record<string, unknown>;

export type SteamReferencePreparationFileStat = {
  identity: string;
  size: number;
  modifiedMs: number;
  changedMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

export type SteamReferencePreparationReadHandle = {
  stat: () => Promise<SteamReferencePreparationFileStat>;
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>;
  close: () => Promise<void>;
};

export type SteamReferencePreparationFileOps = {
  lstat: (file: string) => Promise<SteamReferencePreparationFileStat>;
  realpath: (file: string) => Promise<string>;
  openReadOnly: (file: string) => Promise<SteamReferencePreparationReadHandle>;
};

export type SteamReferencePreparationServerOptions = {
  /** Test-only root substitution. Production callers omit this field. */
  testOnlyAuthorRoot?: string;
  /** Test-only filesystem fault injection. Production callers omit this field. */
  testOnlyFileOps?: SteamReferencePreparationFileOps;
};

class LocalReadFailure {
  readonly code: SteamReferencePreparationFailureCode;

  constructor(code: SteamReferencePreparationFailureCode) {
    this.code = code;
  }
}

function fail(code: SteamReferencePreparationFailureCode): never {
  throw new LocalReadFailure(code);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nodeStat(value: Awaited<ReturnType<typeof lstat>>): SteamReferencePreparationFileStat {
  return {
    identity: `${value.dev}:${value.ino}`,
    size: Number(value.size),
    modifiedMs: Number(value.mtimeMs),
    changedMs: Number(value.ctimeMs),
    isFile: value.isFile(),
    isDirectory: value.isDirectory(),
    isSymbolicLink: value.isSymbolicLink(),
  };
}

export function createSteamReferencePreparationNodeFileOps(): SteamReferencePreparationFileOps {
  return {
    lstat: async (file) => nodeStat(await lstat(file)),
    realpath,
    openReadOnly: async (file) => {
      const handle = await open(file, "r");
      return {
        stat: async () => nodeStat(await handle.stat()),
        read: async (buffer, offset, length, position) => {
          const result = await handle.read(buffer, offset, length, position);
          return result.bytesRead;
        },
        close: () => handle.close(),
      };
    },
  };
}

function exactJsonRecord(
  value: unknown,
  expectedKeys: readonly string[],
): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  const output: JsonRecord = Object.create(null) as JsonRecord;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function exactJsonArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key === "symbol" ||
        (key !== "length" &&
          (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)),
    ) ||
    keys.length !== value.length + 1
  ) {
    return null;
  }
  return [...value];
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : null;
}

function safePngBasename(value: unknown): string | null {
  return typeof value === "string" && SAFE_PNG_BASENAME.test(value)
    ? value
    : null;
}

function basenameFromManifestPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes("\0")
  ) {
    return null;
  }
  const pieces = value.replaceAll("\\", "/").split("/");
  return safePngBasename(pieces.at(-1));
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFileStat(
  left: SteamReferencePreparationFileStat,
  right: SteamReferencePreparationFileStat,
): boolean {
  return (
    left.identity === right.identity &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs &&
    left.changedMs === right.changedMs &&
    left.isFile === right.isFile &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function controlledRoot(
  root: string,
  ops: SteamReferencePreparationFileOps,
): Promise<string> {
  let metadata: SteamReferencePreparationFileStat;
  let resolved: string;
  try {
    metadata = await ops.lstat(root);
    resolved = await ops.realpath(root);
  } catch {
    return fail("authority_invalid");
  }
  if (metadata.isSymbolicLink) return fail("local_asset_link_forbidden");
  if (!metadata.isDirectory) return fail("authority_invalid");
  if (canonicalPath(resolved) !== canonicalPath(root)) {
    return fail("local_asset_outside_root");
  }
  return resolved;
}

async function readBoundedRegularFile(input: {
  root: string;
  realRoot: string;
  basename: string;
  maximumBytes: number;
  ops: SteamReferencePreparationFileOps;
  missingCode: SteamReferencePreparationFailureCode;
  invalidCode: SteamReferencePreparationFailureCode;
  linkCode: SteamReferencePreparationFailureCode;
  outsideCode: SteamReferencePreparationFailureCode;
  limitCode: SteamReferencePreparationFailureCode;
  changedCode: SteamReferencePreparationFailureCode;
}): Promise<Buffer> {
  const candidate = path.resolve(input.root, input.basename);
  if (!containedBy(path.resolve(input.root), candidate)) return fail(input.outsideCode);
  let before: SteamReferencePreparationFileStat;
  let resolvedBefore: string;
  try {
    before = await input.ops.lstat(candidate);
    resolvedBefore = await input.ops.realpath(candidate);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return fail(input.missingCode);
    }
    return fail(input.invalidCode);
  }
  if (before.isSymbolicLink) return fail(input.linkCode);
  if (!before.isFile || before.isDirectory) return fail(input.invalidCode);
  if (before.size < 1 || before.size > input.maximumBytes) return fail(input.limitCode);
  if (
    !containedBy(input.realRoot, resolvedBefore) ||
    canonicalPath(resolvedBefore) !== canonicalPath(candidate)
  ) {
    return fail(input.outsideCode);
  }

  let handle: SteamReferencePreparationReadHandle | null = null;
  try {
    handle = await input.ops.openReadOnly(candidate);
    const opened = await handle.stat();
    if (
      opened.isSymbolicLink ||
      !opened.isFile ||
      opened.isDirectory ||
      !sameFileStat(before, opened)
    ) {
      return fail(input.changedCode);
    }
    if (opened.size < 1 || opened.size > input.maximumBytes) return fail(input.limitCode);
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(read) || read < 0 || read > bytes.length - offset) {
        return fail(input.changedCode);
      }
      if (read === 0) break;
      offset += read;
    }
    if (offset !== opened.size) return fail(input.changedCode);
    const afterHandle = await handle.stat();
    if (!sameFileStat(opened, afterHandle)) return fail(input.changedCode);
    const afterPath = await input.ops.lstat(candidate);
    const resolvedAfter = await input.ops.realpath(candidate);
    if (
      !sameFileStat(before, afterPath) ||
      canonicalPath(resolvedBefore) !== canonicalPath(resolvedAfter) ||
      !containedBy(input.realRoot, resolvedAfter)
    ) {
      return fail(input.changedCode);
    }
    return bytes.subarray(0, opened.size);
  } catch (error) {
    if (error instanceof LocalReadFailure) throw error;
    return fail(input.invalidCode);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // A close failure cannot make an unverified result successful.
      }
    }
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return fail("authority_invalid");
  }
}

function parsePng(bytes: Uint8Array): SteamReferencePreparationInput["assets"][number]["local"] {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return fail("local_asset_png_invalid");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24]!;
  const colorType = buffer[25]!;
  const compressionMethod = buffer[26]!;
  const filterMethod = buffer[27]!;
  const interlaceMethod = buffer[28]!;
  if (
    width < 1 ||
    width > 8_192 ||
    height < 1 ||
    height > 8_192 ||
    bitDepth !== STEAM_REFERENCE_PREPARATION_PNG_POLICY.bitDepth ||
    colorType !== STEAM_REFERENCE_PREPARATION_PNG_POLICY.colorType ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    (interlaceMethod !== 0 && interlaceMethod !== 1)
  ) {
    return fail("local_asset_png_invalid");
  }
  return {
    bytes: buffer.length,
    sha256: sha256(buffer),
    mediaType: "image/png",
    width,
    height,
    bitDepth,
    colorType,
    compressionMethod,
    filterMethod,
    interlaceMethod,
    localIntegrity: "verified",
  };
}

function projectAuthority(
  rawAssetManifest: unknown,
  rawVideoPrompts: unknown,
  pins: SteamReferencePreparationInput["sourceManifests"],
): Omit<SteamReferencePreparationInput, "assets"> & {
  selectedAssets: Array<{
    assetId: string;
    basename: string;
    manifestBasename: string;
    kind: string;
    sceneId: string | null;
    status: string;
    releasePolicy: string;
    bytes: number;
    sha256: string;
  }>;
} {
  const assetRoot = exactJsonRecord(rawAssetManifest, ASSET_MANIFEST_ROOT_KEYS);
  const videoRoot = exactJsonRecord(rawVideoPrompts, VIDEO_PROMPTS_ROOT_KEYS);
  if (!assetRoot || !videoRoot) return fail("authority_invalid");
  if (
    assetRoot.schemaVersion !== 1 ||
    videoRoot.schemaVersion !== 1 ||
    assetRoot.caseStudyId !== STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId ||
    videoRoot.caseStudyId !== STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId
  ) {
    return fail("authority_case_mismatch");
  }
  if (
    assetRoot.releaseVersion !== STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion ||
    videoRoot.releaseVersion !== STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion
  ) {
    return fail("authority_version_mismatch");
  }
  const rawReferences = exactJsonArray(videoRoot.referenceLibrary);
  const rawShots = exactJsonArray(videoRoot.shots);
  const rawAssets = exactJsonArray(assetRoot.assets);
  if (!rawReferences || !rawShots || !rawAssets) return fail("authority_invalid");

  const referenceFiles = new Map<string, string>();
  for (const value of rawReferences) {
    const reference = exactJsonRecord(value, REFERENCE_KEYS);
    const referenceId = safeId(reference?.id);
    if (!referenceId) continue;
    if (referenceFiles.has(referenceId)) return fail("reference_binding_duplicate");
    const basename = safePngBasename(reference?.file);
    if (basename) referenceFiles.set(referenceId, basename);
  }
  for (const expected of STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES) {
    if (referenceFiles.get(expected.referenceId) !== `${expected.assetId}.png`) {
      return fail("reference_binding_mismatch");
    }
  }

  const projectedShots: SteamReferencePreparationInput["shots"] = [];
  const shotPairs = new Set<string>();
  for (const target of STEAM_REFERENCE_PREPARATION_TARGETS) {
    const matches = rawShots.filter((value) => {
      const shot = exactJsonRecord(value, SHOT_KEYS);
      return shot?.nodeId === target.nodeId || shot?.shotId === target.shotId;
    });
    if (matches.length === 0) return fail("target_shot_missing");
    if (matches.length !== 1) return fail("target_shot_duplicate");
    const shot = exactJsonRecord(matches[0], SHOT_KEYS);
    const referenceIds = exactJsonArray(shot?.referenceIds);
    const firstFrameBasename = safePngBasename(shot?.firstFrameAsset);
    const sceneId = safeId(shot?.sceneId);
    const episodeId = safeId(shot?.episodeId);
    if (
      !shot ||
      shot.nodeId !== target.nodeId ||
      shot.shotId !== target.shotId ||
      !sceneId ||
      !episodeId ||
      shot.durationSeconds !== 30 ||
      shot.releasePolicy !== "public" ||
      !referenceIds ||
      firstFrameBasename !== `${target.sourceFrameAssetId}.png`
    ) {
      return fail("target_shot_mismatch");
    }
    const pair = `${target.nodeId}\0${target.shotId}`;
    if (shotPairs.has(pair)) return fail("target_shot_duplicate");
    shotPairs.add(pair);
    projectedShots.push({
      nodeId: target.nodeId,
      shotId: target.shotId,
      sceneId,
      episodeId,
      durationSeconds: 30,
      releasePolicy: "public",
      sourceFrameAssetId: target.sourceFrameAssetId,
      referenceIds: referenceIds.map((value) => String(value)),
    });
  }

  const expectedAssetIds = [
    ...STEAM_REFERENCE_PREPARATION_TARGETS.map((target) => target.sourceFrameAssetId),
    ...STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES.map((reference) => reference.assetId),
  ];
  const selectedAssets: ReturnType<typeof projectAuthority>["selectedAssets"] = [];
  for (const assetId of expectedAssetIds) {
    const matches = rawAssets.filter((value) => {
      const asset = exactJsonRecord(value, ASSET_KEYS);
      return asset?.assetId === assetId;
    });
    if (matches.length === 0) return fail("asset_missing");
    if (matches.length !== 1) return fail("asset_duplicate");
    const asset = exactJsonRecord(matches[0], ASSET_KEYS);
    const basename = `${assetId}.png`;
    const manifestBasename = basenameFromManifestPath(asset?.localPath);
    const sceneId = asset?.sceneId === null ? null : safeId(asset?.sceneId);
    if (
      !asset ||
      !manifestBasename ||
      !safeId(asset.kind) ||
      sceneId === undefined ||
      !safeId(asset.status) ||
      !safeId(asset.releasePolicy) ||
      !Number.isSafeInteger(asset.bytes) ||
      (asset.bytes as number) < 1 ||
      (asset.bytes as number) > STEAM_REFERENCE_PREPARATION_LIMITS.assetBytes ||
      typeof asset.sha256 !== "string" ||
      !SHA256.test(asset.sha256)
    ) {
      return fail("asset_manifest_mismatch");
    }
    selectedAssets.push({
      assetId,
      basename,
      manifestBasename,
      kind: asset.kind as string,
      sceneId,
      status: asset.status as string,
      releasePolicy: asset.releasePolicy as string,
      bytes: asset.bytes as number,
      sha256: asset.sha256,
    });
  }

  const bindings: SteamReferencePreparationInput["bindings"] = [];
  for (const shot of projectedShots) {
    bindings.push({
      nodeId: shot.nodeId,
      shotId: shot.shotId,
      role: STEAM_REFERENCE_PREPARATION_ROLE_ORDER[0],
      referenceId: null,
      assetId: shot.sourceFrameAssetId,
    });
    for (const reference of STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES) {
      bindings.push({
        nodeId: shot.nodeId,
        shotId: shot.shotId,
        role: reference.role,
        referenceId: reference.referenceId,
        assetId: reference.assetId,
      });
    }
  }
  return {
    authority: {
      caseId: STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId,
      releaseVersion: STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion,
    },
    sourceManifests: pins,
    shots: projectedShots,
    bindings,
    selectedAssets,
  };
}

async function readSteamReferencePreparationWithOptions(
  options: SteamReferencePreparationServerOptions = {},
): Promise<SteamReferencePreparationManifest> {
  try {
    const ops = options.testOnlyFileOps ?? createSteamReferencePreparationNodeFileOps();
    const authorRoot = path.resolve(
      options.testOnlyAuthorRoot ??
        path.join(
          process.cwd(),
          "content",
          "case-studies",
          STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId,
          "author-locked-v1.1",
        ),
    );
    const realAuthorRoot = await controlledRoot(authorRoot, ops);
    const generatedRoot = path.join(authorRoot, GENERATED_ASSETS_BASENAME);
    const realGeneratedRoot = await controlledRoot(generatedRoot, ops);

    const sourceReadOptions = {
      root: authorRoot,
      realRoot: realAuthorRoot,
      maximumBytes: STEAM_REFERENCE_PREPARATION_LIMITS.sourceManifestBytes,
      ops,
      missingCode: "authority_invalid" as const,
      invalidCode: "authority_invalid" as const,
      linkCode: "local_asset_link_forbidden" as const,
      outsideCode: "local_asset_outside_root" as const,
      limitCode: "authority_invalid" as const,
      changedCode: "authority_invalid" as const,
    };
    const assetManifestBytes = await readBoundedRegularFile({
      ...sourceReadOptions,
      basename: ASSET_MANIFEST_BASENAME,
    });
    const videoPromptsBytes = await readBoundedRegularFile({
      ...sourceReadOptions,
      basename: VIDEO_PROMPTS_BASENAME,
    });
    const pins: SteamReferencePreparationInput["sourceManifests"] = {
      assetManifest: {
        schemaVersion: 1,
        bytes: assetManifestBytes.length,
        sha256: sha256(assetManifestBytes),
      },
      videoPrompts: {
        schemaVersion: 1,
        bytes: videoPromptsBytes.length,
        sha256: sha256(videoPromptsBytes),
      },
    };
    if (
      pins.assetManifest.bytes !== STEAM_REFERENCE_PREPARATION_AUTHORITY.assetManifest.bytes ||
      pins.assetManifest.sha256 !== STEAM_REFERENCE_PREPARATION_AUTHORITY.assetManifest.sha256 ||
      pins.videoPrompts.bytes !== STEAM_REFERENCE_PREPARATION_AUTHORITY.videoPrompts.bytes ||
      pins.videoPrompts.sha256 !== STEAM_REFERENCE_PREPARATION_AUTHORITY.videoPrompts.sha256
    ) {
      return blockedSteamReferencePreparation("authority_invalid");
    }
    const projection = projectAuthority(
      parseJson(assetManifestBytes),
      parseJson(videoPromptsBytes),
      pins,
    );

    const assets: SteamReferencePreparationInput["assets"] = [];
    for (const asset of projection.selectedAssets) {
      const bytes = await readBoundedRegularFile({
        root: generatedRoot,
        realRoot: realGeneratedRoot,
        basename: asset.basename,
        maximumBytes: STEAM_REFERENCE_PREPARATION_LIMITS.assetBytes,
        ops,
        missingCode: "local_asset_missing",
        invalidCode: "local_asset_not_regular",
        linkCode: "local_asset_link_forbidden",
        outsideCode: "local_asset_outside_root",
        limitCode: "local_asset_limit_exceeded",
        changedCode: "local_verification_unavailable",
      });
      if (bytes.length !== asset.bytes) return fail("local_asset_bytes_mismatch");
      const local = parsePng(bytes);
      if (local.sha256 !== asset.sha256) return fail("local_asset_sha256_mismatch");
      assets.push({ ...asset, local });
    }
    return deriveSteamReferencePreparation(
      {
        authority: projection.authority,
        sourceManifests: projection.sourceManifests,
        shots: projection.shots,
        assets,
        bindings: projection.bindings,
      },
      (value) => sha256(value),
    );
  } catch (error) {
    return blockedSteamReferencePreparation(
      error instanceof LocalReadFailure ? error.code : "local_verification_unavailable",
    );
  }
}

export async function readSteamReferencePreparation(): Promise<SteamReferencePreparationManifest> {
  return readSteamReferencePreparationWithOptions();
}

/** Test-only fault-injection entry; production callers use the zero-argument reader above. */
export async function readSteamReferencePreparationForTest(
  options: SteamReferencePreparationServerOptions,
): Promise<SteamReferencePreparationManifest> {
  return readSteamReferencePreparationWithOptions(options);
}
