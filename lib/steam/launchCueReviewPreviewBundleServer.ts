import "server-only";

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalSteamLaunchCueReviewPreview,
  createSteamLaunchCueReviewPreviewWrittenReceipt,
  deriveSteamLaunchCueReviewPreviewBundle,
  STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES,
  type SteamLaunchCueReviewPreviewBundle,
  type SteamLaunchCueReviewPreviewReceipt,
} from "@/lib/steam/launchCueReviewPreviewBundle";
import { readSteamLaunchCueMaterializationPreflight } from "@/lib/steam/launchCueMaterializationPreflightServer";
import { readSteamLaunchCueReview } from "@/lib/steam/launchCueReviewServer";
import { readSteamLaunchReviewPacket } from "@/lib/steam/launchReviewPacketServer";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGING_MARKER = ".p115-private-review-owner";
const INJECTED_EXTRA = ".p115-injected-extra";
const STAGING_PREFIX_SUFFIX = ".p115-staging-";
const MAX_PACKAGE_FILE_BYTES = 256 * 1024;

export type SteamLaunchCueReviewPreviewBuildFailureCode =
  | "source_unavailable"
  | "source_mismatch"
  | "output_arguments_invalid"
  | "output_parent_invalid"
  | "output_target_exists"
  | "output_reparse_forbidden"
  | "output_forbidden"
  | "package_filename_invalid"
  | "package_write_failed"
  | "package_verify_failed"
  | "package_rename_failed"
  | "package_cleanup_failed";

export type SteamLaunchCueReviewPreviewBuildResult =
  | {
      status: "PRIVATE_REVIEW_BUNDLE_WRITTEN";
      receipt: SteamLaunchCueReviewPreviewReceipt;
      privateReviewPackageFilesWritten: 3;
      releaseMaterializedArtifacts: 0;
      runtimeWritesPerformed: 0;
      networkCalls: 0;
    }
  | {
      status: "BLOCKED";
      failureCode: SteamLaunchCueReviewPreviewBuildFailureCode;
      receipt: null;
      privateReviewPackageFilesWritten: 0;
      releaseMaterializedArtifacts: 0;
      runtimeWritesPerformed: 0;
      networkCalls: 0;
    };

export type SteamLaunchCueReviewPreviewBuildFault =
  | "after_first_write"
  | "after_second_write"
  | "after_manifest_write"
  | "inject_extra_entry"
  | "before_rename";

export type SteamLaunchCueReviewPreviewBuildTestOptions = {
  outputDirectory: string;
  reviewPacketResult?: unknown;
  cueReviewResult?: unknown;
  materializationPreflightResult?: unknown;
  filenames?: readonly string[];
  fault?: SteamLaunchCueReviewPreviewBuildFault;
};

class PreviewBuildFailure extends Error {
  constructor(readonly code: SteamLaunchCueReviewPreviewBuildFailureCode) {
    super(code);
  }
}

function fail(code: SteamLaunchCueReviewPreviewBuildFailureCode): never {
  throw new PreviewBuildFailure(code);
}

function blocked(code: SteamLaunchCueReviewPreviewBuildFailureCode): SteamLaunchCueReviewPreviewBuildResult {
  return {
    status: "BLOCKED",
    failureCode: code,
    receipt: null,
    privateReviewPackageFilesWritten: 0,
    releaseMaterializedArtifacts: 0,
    runtimeWritesPerformed: 0,
    networkCalls: 0,
  };
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLocaleLowerCase("en-US") === path.normalize(right).toLocaleLowerCase("en-US");
}

function isSafeLocalDrivePathSyntax(value: string): boolean {
  if (!/^[A-Za-z]:\\/u.test(value) || /^[\\/]{2}/u.test(value)) return false;
  const segments = value.slice(3).split("\\");
  return segments.every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      !segment.includes(":") &&
      !/[. ]$/u.test(segment) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment),
  );
}

function containedBy(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sameIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isDirectory() && right.isDirectory();
}

async function validateDirectoryChain(directory: string): Promise<void> {
  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  let current = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isMissing(error)) fail("output_parent_invalid");
      throw error;
    }
    if (stat.isSymbolicLink()) fail("output_reparse_forbidden");
    if (!stat.isDirectory()) fail("output_parent_invalid");
  }
  const resolved = await realpath(directory);
  if (!samePath(resolved, directory)) fail("output_reparse_forbidden");
}

async function validateOutputDirectory(raw: string): Promise<{ target: string; parent: string; basename: string }> {
  if (
    typeof raw !== "string" ||
    raw.length < 4 ||
    raw.length > 1024 ||
    raw.includes("\0") ||
    !isSafeLocalDrivePathSyntax(raw) ||
    !path.isAbsolute(raw) ||
    raw !== path.normalize(raw) ||
    raw.split(/[\\/]/u).some((part) => part === "." || part === "..")
  ) {
    fail("output_arguments_invalid");
  }
  const target = path.resolve(raw);
  const parent = path.dirname(target);
  const basename = path.basename(target);
  if (
    target === path.parse(target).root ||
    !basename ||
    /[. ]$/u.test(basename) ||
    /^\.aistory-/iu.test(basename)
  ) {
    fail("output_forbidden");
  }
  if (containedBy(REPOSITORY_ROOT, target)) fail("output_forbidden");
  await validateDirectoryChain(parent);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) fail("output_reparse_forbidden");
    fail("output_target_exists");
  } catch (error) {
    if (error instanceof PreviewBuildFailure) throw error;
    if (!isMissing(error)) throw error;
  }
  return { target, parent, basename };
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_PACKAGE_FILE_BYTES) fail("package_write_failed");
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== bytes.byteLength) fail("package_write_failed");
  } finally {
    await handle.close();
  }
}

async function readExactRegularFile(filePath: string, expectedBytes: number): Promise<Uint8Array> {
  if (expectedBytes < 1 || expectedBytes > MAX_PACKAGE_FILE_BYTES) fail("package_verify_failed");
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedBytes) {
    fail("package_verify_failed");
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const during = await handle.stat();
    if (!during.isFile() || !sameIdentity(before, during)) fail("package_verify_failed");
    const output = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes) fail("package_verify_failed");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (!sameIdentity(before, afterHandle) || !sameIdentity(before, afterPath) || afterPath.isSymbolicLink()) {
      fail("package_verify_failed");
    }
    return output.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function verifyPackageDirectory(
  directory: string,
  bundle: SteamLaunchCueReviewPreviewBundle,
  includeMarker: boolean,
  ownerToken?: string,
): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("package_verify_failed");
  const expectedNames = bundle.files.map((file) => file.basename);
  if (includeMarker) expectedNames.push(STAGING_MARKER);
  const entries = (await readdir(directory)).sort();
  const expected = [...expectedNames].sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    fail("package_verify_failed");
  }
  for (const file of bundle.files) {
    const bytes = await readExactRegularFile(path.join(directory, file.basename), file.bytes);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content !== file.content) fail("package_verify_failed");
  }
  if (includeMarker) {
    if (!ownerToken) fail("package_verify_failed");
    const markerBytes = await readExactRegularFile(
      path.join(directory, STAGING_MARKER),
      new TextEncoder().encode(ownerToken).byteLength,
    );
    if (new TextDecoder("utf-8", { fatal: true }).decode(markerBytes) !== ownerToken) {
      fail("package_verify_failed");
    }
  }
  const manifestFile = bundle.files.find((file) => file.kind === "manifest");
  if (!manifestFile) fail("package_verify_failed");
  const parsed = JSON.parse(manifestFile.content) as unknown;
  if (`${canonicalSteamLaunchCueReviewPreview(parsed)}\n` !== manifestFile.content) {
    fail("package_verify_failed");
  }
}

async function removeKnownDirectory(
  directory: string,
  parent: string,
  prefix: string,
  knownNames: ReadonlySet<string>,
  expectedIdentity?: Awaited<ReturnType<typeof lstat>>,
  ownerToken?: string,
): Promise<boolean> {
  try {
    if (!containedBy(parent, directory) || !path.basename(directory).startsWith(prefix)) return false;
    await validateDirectoryChain(parent);
    const resolved = await realpath(directory);
    if (!samePath(resolved, directory) || !containedBy(parent, resolved)) return false;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (expectedIdentity && !sameDirectoryIdentity(stat, expectedIdentity)) return false;
    const entries = await readdir(directory);
    if (entries.some((entry) => !knownNames.has(entry))) return false;
    if (entries.includes(STAGING_MARKER)) {
      if (!ownerToken) return false;
      const markerBytes = await readExactRegularFile(
        path.join(directory, STAGING_MARKER),
        new TextEncoder().encode(ownerToken).byteLength,
      );
      if (new TextDecoder("utf-8", { fatal: true }).decode(markerBytes) !== ownerToken) return false;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const entryStat = await lstat(entryPath);
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) return false;
    }
    for (const entry of entries) await unlink(path.join(directory, entry));
    await rmdir(directory);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function readSources(options: SteamLaunchCueReviewPreviewBuildTestOptions | undefined) {
  const [reviewPacketResult, cueReviewResult, materializationPreflightResult] = await Promise.all([
    options && Object.prototype.hasOwnProperty.call(options, "reviewPacketResult")
      ? options.reviewPacketResult
      : readSteamLaunchReviewPacket(),
    options && Object.prototype.hasOwnProperty.call(options, "cueReviewResult")
      ? options.cueReviewResult
      : readSteamLaunchCueReview(),
    options && Object.prototype.hasOwnProperty.call(options, "materializationPreflightResult")
      ? options.materializationPreflightResult
      : readSteamLaunchCueMaterializationPreflight(),
  ]);
  return { reviewPacketResult, cueReviewResult, materializationPreflightResult };
}

async function buildWithOptions(
  outputDirectory: string,
  options?: SteamLaunchCueReviewPreviewBuildTestOptions,
): Promise<SteamLaunchCueReviewPreviewBuildResult> {
  let stagePath: string | null = null;
  let stageIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let renamed = false;
  let targetPath: string | null = null;
  let parentPath: string | null = null;
  let targetBasename = "";
  let ownerToken: string | undefined;
  let bundle: SteamLaunchCueReviewPreviewBundle | null = null;
  const knownCleanupNames = new Set<string>([STAGING_MARKER, INJECTED_EXTRA]);
  try {
    const output = await validateOutputDirectory(outputDirectory);
    targetPath = output.target;
    parentPath = output.parent;
    targetBasename = output.basename;
    const sources = await readSources(options);
    const filenames = options?.filenames ?? [
      STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.manifest,
      STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.breakfast,
      STEAM_LAUNCH_CUE_REVIEW_PREVIEW_FILENAMES.wakePull,
    ];
    const derived = deriveSteamLaunchCueReviewPreviewBundle(
      sources.reviewPacketResult,
      sources.cueReviewResult,
      sources.materializationPreflightResult,
      filenames,
    );
    if (derived.status !== "PRIVATE_REVIEW_ONLY") {
      fail(derived.failureCode === "package_filename_invalid" ? "package_filename_invalid" : "source_mismatch");
    }
    bundle = derived.bundle;
    bundle.files.forEach((file) => knownCleanupNames.add(file.basename));
    ownerToken = randomBytes(16).toString("hex");
    const stagePrefix = `.${targetBasename}${STAGING_PREFIX_SUFFIX}`;
    stagePath = await mkdtemp(path.join(parentPath, stagePrefix));
    stageIdentity = await lstat(stagePath);
    if (!stageIdentity.isDirectory() || stageIdentity.isSymbolicLink()) fail("output_reparse_forbidden");
    const realStage = await realpath(stagePath);
    if (!containedBy(parentPath, realStage) || !samePath(realStage, stagePath)) {
      fail("output_reparse_forbidden");
    }
    await writeExclusive(path.join(stagePath, STAGING_MARKER), new TextEncoder().encode(ownerToken));
    for (let index = 0; index < bundle.files.length; index += 1) {
      const file = bundle.files[index]!;
      await writeExclusive(path.join(stagePath, file.basename), new TextEncoder().encode(file.content));
      if (index === 0 && options?.fault === "after_first_write") fail("package_write_failed");
      if (index === 1 && options?.fault === "after_second_write") fail("package_write_failed");
      if (file.kind === "manifest" && options?.fault === "after_manifest_write") {
        fail("package_write_failed");
      }
    }
    if (options?.fault === "inject_extra_entry") {
      await writeExclusive(path.join(stagePath, INJECTED_EXTRA), new TextEncoder().encode("owned-test-extra"));
    }
    await verifyPackageDirectory(stagePath, bundle, true, ownerToken);
    await unlink(path.join(stagePath, STAGING_MARKER));
    await verifyPackageDirectory(stagePath, bundle, false);
    if (options?.fault === "before_rename") fail("package_rename_failed");
    await validateDirectoryChain(parentPath);
    const stageBeforeRename = await lstat(stagePath);
    if (!stageIdentity || !sameDirectoryIdentity(stageIdentity, stageBeforeRename)) {
      fail("package_verify_failed");
    }
    try {
      const competingTarget = await lstat(targetPath);
      if (competingTarget.isSymbolicLink()) fail("output_reparse_forbidden");
      fail("output_target_exists");
    } catch (error) {
      if (error instanceof PreviewBuildFailure) throw error;
      if (!isMissing(error)) throw error;
    }
    try {
      await rename(stagePath, targetPath);
      renamed = true;
    } catch {
      fail("package_rename_failed");
    }
    const finalStat = await lstat(targetPath);
    if (!stageIdentity || !sameDirectoryIdentity(stageIdentity, finalStat)) fail("package_verify_failed");
    await verifyPackageDirectory(targetPath, bundle, false);
    return {
      status: "PRIVATE_REVIEW_BUNDLE_WRITTEN",
      receipt: createSteamLaunchCueReviewPreviewWrittenReceipt(bundle),
      privateReviewPackageFilesWritten: 3,
      releaseMaterializedArtifacts: 0,
      runtimeWritesPerformed: 0,
      networkCalls: 0,
    };
  } catch (error) {
    const code = error instanceof PreviewBuildFailure ? error.code : "package_write_failed";
    if (parentPath && bundle) {
      let cleaned = true;
      if (renamed && targetPath && stageIdentity) {
        cleaned = await removeKnownDirectory(
          targetPath,
          parentPath,
          targetBasename,
          knownCleanupNames,
          stageIdentity,
          ownerToken,
        );
      } else if (stagePath) {
        cleaned = await removeKnownDirectory(
          stagePath,
          parentPath,
          `.${targetBasename}${STAGING_PREFIX_SUFFIX}`,
          knownCleanupNames,
          stageIdentity,
          ownerToken,
        );
      }
      if (!cleaned) return blocked("package_cleanup_failed");
    }
    return blocked(code);
  }
}

export async function buildSteamLaunchCueReviewPreviewBundle(
  outputDirectory: string,
): Promise<SteamLaunchCueReviewPreviewBuildResult> {
  return buildWithOptions(outputDirectory);
}

/** Test-only source, filename, and bounded failure injection. Production callers only pass an output directory. */
export async function buildSteamLaunchCueReviewPreviewBundleForTest(
  options: SteamLaunchCueReviewPreviewBuildTestOptions,
): Promise<SteamLaunchCueReviewPreviewBuildResult> {
  return buildWithOptions(options.outputDirectory, options);
}
