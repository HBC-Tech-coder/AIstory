import "server-only";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  blockedSteamLaunchCueReview,
  deriveSteamLaunchCueReview,
  type SteamLaunchCueReviewResult,
} from "@/lib/steam/launchCueReview";
import {
  readSteamLaunchReviewPacket,
  type SteamLaunchReviewPacketTestOptions,
  readSteamLaunchReviewPacketForTest,
} from "@/lib/steam/launchReviewPacketServer";

export const STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE = Object.freeze({
  basename: "launchCueAssignments.v1.json",
  bytes: 17_394,
  sha256: "ca2f09c637a3adc67d96ad0e7fd65805b0b123f0f877c01bf56028cd32cd0fcc",
  maxBytes: 128 * 1024,
} as const);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const assignmentPath = fileURLToPath(new URL(`./${STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.basename}`, import.meta.url));

type SteamLaunchCueReviewTestOptions = {
  assignmentBytes?: Uint8Array;
  reviewPacketOptions?: SteamLaunchReviewPacketTestOptions;
  reviewPacketResult?: unknown;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameFileIdentity(
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

async function readPinnedAssignmentBytes(): Promise<Uint8Array> {
  const directoryStat = await lstat(moduleDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("assignment_authority_unavailable");
  }
  const before = await lstat(assignmentPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.bytes ||
    before.size > STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.maxBytes
  ) {
    throw new Error("assignment_authority_unavailable");
  }
  const [realDirectory, realFile] = await Promise.all([
    realpath(moduleDirectory),
    realpath(assignmentPath),
  ]);
  const relative = path.relative(realDirectory, realFile);
  if (relative !== STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.basename) {
    throw new Error("assignment_authority_unavailable");
  }
  const handle = await open(
    assignmentPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const during = await handle.stat();
    if (!during.isFile() || !sameFileIdentity(before, during)) {
      throw new Error("assignment_authority_unavailable");
    }
    const buffer = Buffer.alloc(STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.bytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.bytes) {
      throw new Error("assignment_authority_unavailable");
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(assignmentPath);
    if (
      !sameFileIdentity(before, afterHandle) ||
      !sameFileIdentity(before, afterPath) ||
      afterPath.isSymbolicLink()
    ) {
      throw new Error("assignment_authority_unavailable");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parsePinnedAssignmentBytes(bytes: Uint8Array): unknown {
  if (
    bytes.byteLength !== STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.bytes ||
    bytes.byteLength > STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.maxBytes ||
    sha256(bytes) !== STEAM_LAUNCH_CUE_ASSIGNMENTS_FILE.sha256
  ) {
    throw new Error("assignment_authority_unavailable");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(source) as unknown;
}

async function readWithOptions(
  options?: SteamLaunchCueReviewTestOptions,
): Promise<SteamLaunchCueReviewResult> {
  try {
    const assignmentBytes = options?.assignmentBytes ?? (await readPinnedAssignmentBytes());
    const assignments = parsePinnedAssignmentBytes(assignmentBytes);
    const reviewPacket = options?.reviewPacketResult
      ? options.reviewPacketResult
      : options?.reviewPacketOptions
        ? await readSteamLaunchReviewPacketForTest(options.reviewPacketOptions)
        : await readSteamLaunchReviewPacket();
    return deriveSteamLaunchCueReview(reviewPacket, assignments, (value) => sha256(value));
  } catch {
    return blockedSteamLaunchCueReview("assignments_unavailable");
  }
}

export async function readSteamLaunchCueReview(): Promise<SteamLaunchCueReviewResult> {
  return readWithOptions();
}

/** Test-only fault injection. Production callers use the zero-argument reader. */
export async function readSteamLaunchCueReviewForTest(
  options: SteamLaunchCueReviewTestOptions,
): Promise<SteamLaunchCueReviewResult> {
  return readWithOptions(options);
}

/** Test-only exact pinned assignment projection for hostile pure-input tests. */
export async function readSteamLaunchCueAssignmentsForTest(): Promise<unknown | null> {
  try {
    return parsePinnedAssignmentBytes(await readPinnedAssignmentBytes());
  } catch {
    return null;
  }
}
