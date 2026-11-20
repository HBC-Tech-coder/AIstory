import "server-only";

import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  blockedSteamLaunchReviewPacket,
  deriveSteamLaunchReviewPacket,
  STEAM_LAUNCH_REVIEW_AUTHORITY,
  STEAM_LAUNCH_REVIEW_CHOICE_PINS,
  STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH,
  STEAM_LAUNCH_REVIEW_TARGETS,
  type SteamLaunchReviewPacketInput,
  type SteamLaunchReviewPacketResult,
} from "@/lib/steam/launchReviewPacket";
import {
  deriveSteamVideoGenerationPreflight,
  STEAM_RELEASE_TARGET_POLICY,
  type SteamVideoGenerationAuthoritativeInput,
} from "@/lib/steam/productionSpec";
import type { SteamReferencePreparationVerifiedManifest } from "@/lib/steam/referencePreparation";
import { readSteamReferencePreparation } from "@/lib/steam/referencePreparationServer";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTHOR_ROOT = path.join(
  REPOSITORY_ROOT,
  "content",
  "case-studies",
  "virtual-girlfriend-20260727",
  "author-locked-v1.1",
);
const PUBLIC_ROOT = path.join(
  REPOSITORY_ROOT,
  "public",
  "case-studies",
  "virtual-girlfriend-20260727",
);
const AUTHOR_STORY_BASENAME = "virtual-girlfriend.author-locked.v1.1.story.json";
const PUBLIC_STORY_BASENAME = "story.json";
const VIDEO_PROMPTS_BASENAME = "video-prompts.v1.1.json";
const MAX_AUTHORITY_BYTES = 512 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const AUTHOR_ROOT_KEYS = [
  "schemaVersion",
  "caseStudyId",
  "workingTitle",
  "recommendedTitle",
  "titleOptions",
  "rightsStatus",
  "storyMeta",
  "variables",
  "characters",
  "world",
  "interactiveGraph",
  "firstActCompat",
  "authorLocked",
  "releaseVersion",
  "releasePolicy",
  "aiContinuationBoundary",
] as const;
const AUTHOR_GRAPH_KEYS = [
  "startNodeId",
  "mergeNodes",
  "defaultVariables",
  "nodes",
  "internalSequenceStartNodeId",
  "internalEpisodeStartNodeIds",
] as const;
const AUTHOR_NODE_BASE_KEYS = [
  "nodeId",
  "episodeId",
  "sceneId",
  "title",
  "kind",
  "estimatedSeconds",
  "location",
  "summary",
  "sourceParagraphIds",
  "sourceTextVerbatim",
  "beats",
  "characterState",
  "characterVisualStates",
  "roleState",
  "visualState",
  "visualStates",
  "releasePolicy",
] as const;
const AUTHOR_BEAT_KEYS = ["speaker", "text", "sourceParagraphId", "sourceTextVerbatim"] as const;
const AUTHOR_CHOICE_KEYS = [
  "choiceId",
  "label",
  "choiceLabelVerbatim",
  "targetNodeId",
  "variableDelta",
  "reason",
] as const;
const AUTHOR_NEXT_KEYS = ["type", "nextNodeId"] as const;

const PUBLIC_ROOT_KEYS = ["schemaVersion", "kind", "card", "session", "assetSummary"] as const;
const PUBLIC_SESSION_KEYS = [
  "id",
  "createdAt",
  "worldSetting",
  "styleGuide",
  "history",
  "characters",
  "storyState",
  "orientation",
  "language",
  "cacheIdentity",
  "authoredStory",
] as const;
const CACHE_IDENTITY_KEYS = ["visibility", "storyId", "templateId", "version"] as const;
const PUBLIC_AUTHORED_KEYS = [
  "caseStudyId",
  "version",
  "authorLocked",
  "releasePolicy",
  "aiContinuationBoundary",
  "currentNodeId",
  "currentBeatId",
  "visitedNodeIds",
  "variables",
  "variableDefinitions",
  "nodes",
  "currentCharacterState",
  "currentVisualStates",
  "currentRoleState",
] as const;
const PUBLIC_NODE_KEYS = [
  "nodeId",
  "sourceSceneId",
  "title",
  "kind",
  "episodeId",
  "sourceParagraphIds",
  "releasePolicy",
  "characterState",
  "characterVisualStates",
  "roleState",
  "scene",
] as const;
const PUBLIC_SCENE_KEYS = [
  "id",
  "scenePrompt",
  "beats",
  "entryBeatId",
  "sceneKey",
  "imageUrl",
  "orientation",
] as const;
const PUBLIC_BEAT_KEYS = ["id", "narration", "next"] as const;
const CONTINUE_KEYS = ["type", "nextBeatId"] as const;
const CHOICE_NEXT_KEYS = ["type", "choices"] as const;
const PUBLIC_CHOICE_KEYS = ["id", "label", "effect"] as const;
const EXPLICIT_EFFECT_KEYS = [
  "kind",
  "nextSceneSeed",
  "authoredTargetNodeId",
  "variableDelta",
] as const;
const DERIVED_EFFECT_KEYS = ["kind", "nextSceneSeed", "authoredTargetNodeId"] as const;

const VIDEO_PROMPTS_ROOT_KEYS = [
  "schemaVersion",
  "caseStudyId",
  "releaseVersion",
  "targetDurationSeconds",
  "referenceLibrary",
  "shots",
] as const;
const VIDEO_SHOT_KEYS = [
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
type AuthorityDocumentName = "authorStory" | "publicStory" | "videoPrompts";

export type SteamLaunchReviewPacketTestOptions = {
  /** Test-only byte substitution; production always reads the three fixed files. */
  testOnlyAuthorityBytes?: Partial<Record<AuthorityDocumentName, Uint8Array>>;
  /** Test-only P1.9 substitution; production always runs the fixed local verifier. */
  testOnlyLocalIntegrity?: SteamReferencePreparationVerifiedManifest;
};

class AuthorityFailure extends Error {
  readonly code = "authority_unavailable" as const;

  constructor() {
    super("authority_unavailable");
  }
}

function fail(): never {
  throw new AuthorityFailure();
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[]): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return fail();
  }
  const output: JsonRecord = Object.create(null) as JsonRecord;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
    output[key] = descriptor.value;
  }
  return output;
}

function exactArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
    result.push(descriptor.value);
  }
  if (
    keys.some(
      (key) =>
        typeof key === "symbol" ||
        (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)),
    )
  ) {
    return fail();
  }
  return result;
}

function text(value: unknown, maximum = 32_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    return fail();
  }
  return value;
}

function exactText(value: unknown, expected: string): string {
  if (value !== expected) return fail();
  return expected;
}

function exactInteger(value: unknown, expected: number): number {
  if (value !== expected || !Number.isSafeInteger(value)) return fail();
  return expected;
}

function exactBoolean(value: unknown, expected: boolean): boolean {
  if (value !== expected) return fail();
  return expected;
}

function exactStringArray(value: unknown, expected: readonly string[]): string[] {
  const array = exactArray(value);
  if (
    array.length !== expected.length ||
    array.some((entry, index) => entry !== expected[index])
  ) {
    return fail();
  }
  return [...expected];
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return fail();
    return String(value);
  }
  if (Array.isArray(value)) return `[${exactArray(value).map(canonical).join(",")}]`;
  const record = exactRecord(value, Object.keys(value as object));
  return `{${Object.keys(record)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function sameIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readFixedBoundedFile(
  root: string,
  basename: string,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(basename)) return fail();
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return fail();
  const resolvedRoot = await realpath(root);
  const candidate = path.join(root, basename);
  const beforePath = await lstat(candidate);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) return fail();
  const resolvedCandidate = await realpath(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return fail();
  if (expectedBytes > MAX_AUTHORITY_BYTES || beforePath.size !== expectedBytes) return fail();

  const handle = await open(candidate, "r");
  try {
    const beforeHandle = await handle.stat();
    if (
      !beforeHandle.isFile() ||
      beforeHandle.size !== expectedBytes ||
      beforeHandle.dev !== beforePath.dev ||
      beforeHandle.ino !== beforePath.ino
    ) {
      return fail();
    }
    const buffer = new Uint8Array(expectedBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(candidate);
    if (
      offset !== expectedBytes ||
      !sameIdentity(beforeHandle, afterHandle) ||
      afterHandle.dev !== afterPath.dev ||
      afterHandle.ino !== afterPath.ino ||
      beforePath.dev !== afterPath.dev ||
      beforePath.ino !== afterPath.ino ||
      beforePath.size !== afterPath.size ||
      beforePath.mtimeMs !== afterPath.mtimeMs ||
      beforePath.ctimeMs !== afterPath.ctimeMs ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile()
    ) {
      return fail();
    }
    return buffer.subarray(0, expectedBytes);
  } finally {
    await handle.close();
  }
}

function parsePinnedJson(bytes: Uint8Array, expectedBytes: number, expectedSha256: string): unknown {
  if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) return fail();
  try {
    return JSON.parse(UTF8.decode(bytes)) as unknown;
  } catch {
    return fail();
  }
}

async function authorityBytes(
  name: AuthorityDocumentName,
  options: SteamLaunchReviewPacketTestOptions | undefined,
): Promise<Uint8Array> {
  const injected = options?.testOnlyAuthorityBytes?.[name];
  if (injected) return new Uint8Array(injected);
  if (name === "authorStory") {
    return readFixedBoundedFile(
      AUTHOR_ROOT,
      AUTHOR_STORY_BASENAME,
      STEAM_LAUNCH_REVIEW_AUTHORITY.authorStory.bytes,
    );
  }
  if (name === "publicStory") {
    return readFixedBoundedFile(
      PUBLIC_ROOT,
      PUBLIC_STORY_BASENAME,
      STEAM_LAUNCH_REVIEW_AUTHORITY.publicStory.bytes,
    );
  }
  return readFixedBoundedFile(AUTHOR_ROOT, VIDEO_PROMPTS_BASENAME, 56_726);
}

function uniqueRecordById(
  values: unknown,
  keys: readonly string[],
  idKey: string,
  id: string,
): JsonRecord {
  const matches = exactArray(values)
    .filter((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return fail();
      if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, idKey);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
      return descriptor.value === id;
    })
    .map((value) => exactRecord(value, keys));
  if (matches.length !== 1) return fail();
  return matches[0]!;
}

function validateAuthorRoot(value: unknown): JsonRecord {
  const root = exactRecord(value, AUTHOR_ROOT_KEYS);
  exactInteger(root.schemaVersion, 1);
  exactText(root.caseStudyId, STEAM_LAUNCH_REVIEW_AUTHORITY.caseId);
  exactBoolean(root.authorLocked, true);
  exactText(root.releaseVersion, STEAM_LAUNCH_REVIEW_AUTHORITY.authorReleaseVersion);
  const graph = exactRecord(root.interactiveGraph, AUTHOR_GRAPH_KEYS);
  exactArray(graph.nodes);
  return root;
}

function validatePublicRoot(value: unknown): JsonRecord {
  const root = exactRecord(value, PUBLIC_ROOT_KEYS);
  exactInteger(root.schemaVersion, 1);
  exactText(root.kind, "aistory-authored-case");
  const session = exactRecord(root.session, PUBLIC_SESSION_KEYS);
  exactText(session.orientation, "landscape");
  exactText(session.language, "zh-CN");
  const identity = exactRecord(session.cacheIdentity, CACHE_IDENTITY_KEYS);
  exactText(identity.visibility, "public");
  exactText(identity.storyId, STEAM_LAUNCH_REVIEW_AUTHORITY.storyId);
  exactText(identity.templateId, STEAM_LAUNCH_REVIEW_AUTHORITY.caseId);
  exactText(identity.version, STEAM_LAUNCH_REVIEW_AUTHORITY.storyVersion);
  const authored = exactRecord(session.authoredStory, PUBLIC_AUTHORED_KEYS);
  exactText(authored.caseStudyId, STEAM_LAUNCH_REVIEW_AUTHORITY.caseId);
  exactText(authored.version, STEAM_LAUNCH_REVIEW_AUTHORITY.storyVersion);
  exactBoolean(authored.authorLocked, true);
  exactArray(authored.nodes);
  return root;
}

function videoPromptByNode(value: unknown, nodeId: string): JsonRecord {
  const root = exactRecord(value, VIDEO_PROMPTS_ROOT_KEYS);
  exactInteger(root.schemaVersion, 1);
  exactText(root.caseStudyId, STEAM_LAUNCH_REVIEW_AUTHORITY.caseId);
  exactText(root.releaseVersion, STEAM_LAUNCH_REVIEW_AUTHORITY.authorReleaseVersion);
  return uniqueRecordById(root.shots, VIDEO_SHOT_KEYS, "nodeId", nodeId);
}

function publicNodeById(authored: JsonRecord, nodeId: string): JsonRecord {
  return uniqueRecordById(authored.nodes, PUBLIC_NODE_KEYS, "nodeId", nodeId);
}

function authorNodeById(graph: JsonRecord, nodeId: string, terminal: "choices" | "next"): JsonRecord {
  return uniqueRecordById(
    graph.nodes,
    [...AUTHOR_NODE_BASE_KEYS, terminal],
    "nodeId",
    nodeId,
  );
}

function referenceIdForRole(role: string): string | null {
  if (role === "identity_face") return "R1_FACE";
  if (role === "home_outfit") return "R2_HOME_OUTFIT";
  if (role === "expressions") return "R4_EXPRESSIONS";
  if (role === "source_frame") return null;
  return fail();
}

function validateExplicitChoice(
  authorNode: JsonRecord,
  publicChoice: JsonRecord,
  choiceId: string,
): void {
  const authorChoices = exactArray(authorNode.choices).map((entry) =>
    exactRecord(entry, AUTHOR_CHOICE_KEYS),
  );
  const matches = authorChoices.filter((choice) => choice.choiceId === choiceId);
  if (matches.length !== 1) return fail();
  const authorChoice = matches[0]!;
  exactText(publicChoice.label, text(authorChoice.label, 1024));
  const effect = exactRecord(publicChoice.effect, EXPLICIT_EFFECT_KEYS);
  exactText(effect.kind, "change-scene");
  exactText(effect.authoredTargetNodeId, text(authorChoice.targetNodeId, 160));
  exactText(effect.nextSceneSeed, text(authorChoice.reason, 4096));
  if (canonical(effect.variableDelta) !== canonical(authorChoice.variableDelta)) return fail();
}

function buildRowsAndChoices(
  target: (typeof STEAM_LAUNCH_REVIEW_TARGETS)[number],
  authorNode: JsonRecord,
  publicNode: JsonRecord,
  publicAuthored: JsonRecord,
): Pick<SteamLaunchReviewPacketInput["shots"][number], "rows" | "choices"> {
  exactText(authorNode.nodeId, target.nodeId);
  exactText(authorNode.sceneId, target.sceneId);
  exactText(authorNode.episodeId, target.episodeId);
  exactText(authorNode.releasePolicy, "public");
  exactStringArray(
    authorNode.sourceParagraphIds,
    target.rows.map((row) => row.paragraphId),
  );
  const authorBeats = exactArray(authorNode.beats).map((entry) => exactRecord(entry, AUTHOR_BEAT_KEYS));
  if (authorBeats.length !== target.rows.length) return fail();

  exactText(publicNode.nodeId, target.nodeId);
  exactText(publicNode.sourceSceneId, target.sceneId);
  exactText(publicNode.episodeId, target.episodeId);
  exactText(publicNode.releasePolicy, "public");
  exactStringArray(
    publicNode.sourceParagraphIds,
    target.rows.map((row) => row.paragraphId),
  );
  const scene = exactRecord(publicNode.scene, PUBLIC_SCENE_KEYS);
  exactText(scene.entryBeatId, target.rows[0]!.beatId);
  exactText(scene.orientation, "landscape");
  const publicBeats = exactArray(scene.beats).map((entry) => exactRecord(entry, PUBLIC_BEAT_KEYS));
  if (publicBeats.length !== target.rows.length) return fail();

  const choicePins = STEAM_LAUNCH_REVIEW_CHOICE_PINS.filter(
    (choice) => choice.sourceNodeId === target.nodeId,
  );
  const rows: SteamLaunchReviewPacketInput["shots"][number]["rows"] = [];
  let terminalChoices: JsonRecord[] = [];
  for (let index = 0; index < target.rows.length; index += 1) {
    const pin = target.rows[index]!;
    const authorBeat = authorBeats[index]!;
    const publicBeat = publicBeats[index]!;
    if (authorBeat.speaker !== null) return fail();
    exactText(authorBeat.sourceParagraphId, pin.paragraphId);
    const authorText = text(authorBeat.text, 4096);
    exactText(authorBeat.sourceTextVerbatim, authorText);
    exactText(publicBeat.id, pin.beatId);
    const narration = text(publicBeat.narration, 4096);
    exactText(narration, authorText);
    const isLast = index === target.rows.length - 1;
    if (isLast) {
      const next = exactRecord(publicBeat.next, CHOICE_NEXT_KEYS);
      exactText(next.type, "choice");
      terminalChoices = exactArray(next.choices).map((entry) =>
        exactRecord(entry, PUBLIC_CHOICE_KEYS),
      );
      if (terminalChoices.length !== choicePins.length) return fail();
    } else {
      const next = exactRecord(publicBeat.next, CONTINUE_KEYS);
      exactText(next.type, "continue");
      exactText(next.nextBeatId, target.rows[index + 1]!.beatId);
    }
    const publicTextHash = sha256(narration);
    rows.push({
      rowIndex: index + 1,
      paragraphId: pin.paragraphId,
      beatId: pin.beatId,
      publicText: narration,
      publicTextHash,
      authorityTextHash: sha256(authorText),
      charCount: Array.from(narration).length,
      nextKind: isLast ? "choice" : "continue",
      nextBeatId: isLast ? null : target.rows[index + 1]!.beatId,
      choiceIds: isLast ? choicePins.map((choice) => choice.choiceId) : [],
    });
  }

  const choices: SteamLaunchReviewPacketInput["shots"][number]["choices"] = [];
  const seenChoices = new Set<string>();
  for (const pin of choicePins) {
    const matches = terminalChoices.filter((choice) => choice.id === pin.choiceId);
    if (matches.length !== 1 || seenChoices.has(pin.choiceId)) return fail();
    seenChoices.add(pin.choiceId);
    const publicChoice = matches[0]!;
    const label = text(publicChoice.label, 1024);
    if (pin.provenance === "explicit_choice") {
      validateExplicitChoice(authorNode, publicChoice, pin.choiceId);
    } else {
      const authorNext = exactRecord(authorNode.next, AUTHOR_NEXT_KEYS);
      exactText(authorNext.type, "continue");
      exactText(authorNext.nextNodeId, pin.targetNodeId);
      const effect = exactRecord(publicChoice.effect, DERIVED_EFFECT_KEYS);
      exactText(effect.kind, "change-scene");
      exactText(effect.authoredTargetNodeId, pin.targetNodeId);
      text(effect.nextSceneSeed, 32_000);
    }
    const targetNode = publicNodeById(publicAuthored, pin.targetNodeId);
    exactText(targetNode.sourceSceneId, pin.targetSceneId);
    exactText(targetNode.releasePolicy, "public");
    const targetScene = exactRecord(targetNode.scene, PUBLIC_SCENE_KEYS);
    exactText(targetScene.entryBeatId, pin.targetEntryBeatId);
    choices.push({
      choiceId: pin.choiceId,
      sourceBeatId: pin.sourceBeatId,
      label,
      labelHash: sha256(label),
      labelCharCount: Array.from(label).length,
      targetNodeId: pin.targetNodeId,
      targetSceneId: pin.targetSceneId,
      targetEntryBeatId: pin.targetEntryBeatId,
      provenance: pin.provenance,
    });
  }
  return { rows, choices };
}

function buildProductionSpec(
  target: (typeof STEAM_LAUNCH_REVIEW_TARGETS)[number],
  promptShot: JsonRecord,
  localShot: SteamReferencePreparationVerifiedManifest["shots"][number],
): SteamVideoGenerationAuthoritativeInput {
  exactText(promptShot.nodeId, target.nodeId);
  exactText(promptShot.shotId, target.shotId);
  exactText(promptShot.sceneId, target.sceneId);
  exactText(promptShot.episodeId, target.episodeId);
  exactInteger(promptShot.durationSeconds, 30);
  exactText(promptShot.releasePolicy, "public");
  exactStringArray(promptShot.referenceIds, ["R1_FACE", "R2_HOME_OUTFIT", "R4_EXPRESSIONS"]);
  exactText(promptShot.firstFrameAsset, `${target.sourceFrameAssetId}.png`);
  const prompt = text(promptShot.prompt, 32_000);
  const negativePrompt = text(promptShot.negativePrompt, 16_000);
  if (localShot.nodeId !== target.nodeId || localShot.shotId !== target.shotId) return fail();
  const references = localShot.bindings.map((binding) => ({
    role: binding.role,
    assetId: binding.assetId,
    sha256: binding.sha256,
  }));
  return {
    projectRef: STEAM_LAUNCH_REVIEW_AUTHORITY.projectRef,
    caseId: STEAM_LAUNCH_REVIEW_AUTHORITY.caseId,
    storyId: STEAM_LAUNCH_REVIEW_AUTHORITY.storyId,
    storyVersion: STEAM_LAUNCH_REVIEW_AUTHORITY.storyVersion,
    nodeId: target.nodeId,
    sceneId: target.sceneId,
    episodeId: target.episodeId,
    shotId: target.shotId,
    sourceContentHash: target.sourceContentHash,
    privatePrompt: prompt,
    privateNegativePrompt: negativePrompt,
    videoPolicy: {
      orientation: STEAM_RELEASE_TARGET_POLICY.orientation,
      durationSeconds: STEAM_RELEASE_TARGET_POLICY.durationSeconds,
      aspectRatio: STEAM_RELEASE_TARGET_POLICY.aspectRatio,
      width: STEAM_RELEASE_TARGET_POLICY.width,
      height: STEAM_RELEASE_TARGET_POLICY.height,
      fps: STEAM_RELEASE_TARGET_POLICY.fps,
    },
    audioIntent: STEAM_RELEASE_TARGET_POLICY.audioIntent,
    subtitleIntent: STEAM_RELEASE_TARGET_POLICY.subtitleIntent,
    references,
    originalPlanTask: {
      taskId: target.taskId,
      outputRef: target.outputRef,
      status: "blocked",
      blockerCodes: ["workflow_capability_missing"],
    },
    upscalePlanTask: {
      taskId: target.taskId.replace(/-original_video$/, "-upscale"),
      outputRef: target.outputRef.replace(/:original_video$/, ":upscale"),
    },
    workflowCandidates: [],
  };
}

function buildLocalIntegrityInput(
  manifest: SteamReferencePreparationVerifiedManifest,
): SteamLaunchReviewPacketInput["localIntegrity"] {
  return {
    schema: manifest.schema,
    schemaVersion: manifest.schemaVersion,
    mode: manifest.mode,
    status: manifest.status,
    manifestFingerprint: manifest.manifestFingerprint,
    sourceManifests: {
      assetManifest: { ...manifest.sourceManifests.assetManifest },
      videoPrompts: { ...manifest.sourceManifests.videoPrompts },
    },
    summary: { ...manifest.summary },
    executionAllowed: manifest.executionAllowed,
    providerPreparation: manifest.providerPreparation,
    providerContacted: manifest.providerContacted,
    providerReferenceHandlesIssued: manifest.providerReferenceHandlesIssued,
    gpuProbed: manifest.gpuProbed,
    networkCalls: manifest.networkCalls,
    writesPerformed: manifest.writesPerformed,
    releaseGateSatisfied: manifest.releaseGate.satisfied,
    blockerCodes: [...manifest.blockerCodes],
    assets: manifest.assets.map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      bytes: asset.bytes,
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      localIntegrity: asset.localIntegrity,
    })),
  };
}

async function buildInput(
  options?: SteamLaunchReviewPacketTestOptions,
): Promise<SteamLaunchReviewPacketInput> {
  const [authorBytes, publicBytes, videoBytes, localIntegrity] = await Promise.all([
    authorityBytes("authorStory", options),
    authorityBytes("publicStory", options),
    authorityBytes("videoPrompts", options),
    options?.testOnlyLocalIntegrity
      ? Promise.resolve(options.testOnlyLocalIntegrity)
      : readSteamReferencePreparation(),
  ]);
  if (localIntegrity.status !== "LOCAL_VERIFIED_ONLY") return fail();
  if (
    localIntegrity.authority.caseId !== STEAM_LAUNCH_REVIEW_AUTHORITY.caseId ||
    localIntegrity.authority.releaseVersion !==
      STEAM_LAUNCH_REVIEW_AUTHORITY.authorReleaseVersion ||
    localIntegrity.shots.length !== STEAM_LAUNCH_REVIEW_TARGETS.length
  ) {
    return fail();
  }
  for (const target of STEAM_LAUNCH_REVIEW_TARGETS) {
    const matches = localIntegrity.shots.filter((shot) => shot.nodeId === target.nodeId);
    if (
      matches.length !== 1 ||
      matches[0]!.shotId !== target.shotId ||
      matches[0]!.sceneId !== target.sceneId ||
      matches[0]!.episodeId !== target.episodeId
    ) {
      return fail();
    }
  }

  const authorRoot = validateAuthorRoot(
    parsePinnedJson(
      authorBytes,
      STEAM_LAUNCH_REVIEW_AUTHORITY.authorStory.bytes,
      STEAM_LAUNCH_REVIEW_AUTHORITY.authorStory.rawBytesSha256,
    ),
  );
  const publicRoot = validatePublicRoot(
    parsePinnedJson(
      publicBytes,
      STEAM_LAUNCH_REVIEW_AUTHORITY.publicStory.bytes,
      STEAM_LAUNCH_REVIEW_AUTHORITY.publicStory.rawBytesSha256,
    ),
  );
  const videoRoot = parsePinnedJson(
    videoBytes,
    localIntegrity.sourceManifests.videoPrompts.bytes,
    localIntegrity.sourceManifests.videoPrompts.sha256,
  );
  const authorGraph = exactRecord(authorRoot.interactiveGraph, AUTHOR_GRAPH_KEYS);
  const publicSession = exactRecord(publicRoot.session, PUBLIC_SESSION_KEYS);
  const publicAuthored = exactRecord(publicSession.authoredStory, PUBLIC_AUTHORED_KEYS);

  const projected = STEAM_LAUNCH_REVIEW_TARGETS.map((target) => {
    const terminal = target.nodeId === "vg11_wake_pull" ? "next" : "choices";
    const authorNode = authorNodeById(authorGraph, target.nodeId, terminal);
    const publicNode = publicNodeById(publicAuthored, target.nodeId);
    const rowChoiceProjection = buildRowsAndChoices(
      target,
      authorNode,
      publicNode,
      publicAuthored,
    );
    const promptShot = videoPromptByNode(videoRoot, target.nodeId);
    const localMatches = localIntegrity.shots.filter((shot) => shot.nodeId === target.nodeId);
    if (localMatches.length !== 1) return fail();
    const productionInput = buildProductionSpec(target, promptShot, localMatches[0]!);
    return { target, productionInput, localShot: localMatches[0]!, ...rowChoiceProjection };
  });

  const derived = deriveSteamVideoGenerationPreflight({
    observedAt: "1970-01-01T00:00:00.000Z",
    authority: {
      caseId: STEAM_LAUNCH_REVIEW_AUTHORITY.caseId,
      storyId: STEAM_LAUNCH_REVIEW_AUTHORITY.storyId,
      storyVersion: STEAM_LAUNCH_REVIEW_AUTHORITY.storyVersion,
      projectRef: STEAM_LAUNCH_REVIEW_AUTHORITY.projectRef,
    },
    shots: projected.map((entry) => entry.productionInput),
    sha256: (value) => sha256(value),
  });
  if (
    derived.publicPackage.summary.total !== 3 ||
    derived.publicPackage.summary.ready !== 0 ||
    derived.publicPackage.summary.blocked !== 3 ||
    derived.publicPackage.executionAllowed
  ) {
    return fail();
  }

  const shots: SteamLaunchReviewPacketInput["shots"] = projected.map((entry) => {
    const specs = derived.publicPackage.specs.filter((spec) => spec.nodeId === entry.target.nodeId);
    const privateSpecs = derived.privateSpecs.filter(
      (spec) => spec.publicSpec.nodeId === entry.target.nodeId,
    );
    if (specs.length !== 1 || privateSpecs.length !== 1) return fail();
    const spec = specs[0]!;
    const privateSpec = privateSpecs[0]!;
    if (
      spec.specId !== entry.target.specId ||
      spec.inputFingerprint !== entry.target.inputFingerprint ||
      spec.sourceContentHash !== entry.target.sourceContentHash ||
      spec.original.taskId !== entry.target.taskId ||
      spec.original.outputRef !== entry.target.outputRef ||
      spec.status !== "blocked" ||
      spec.original.planStatus !== "blocked" ||
      spec.executionAllowed ||
      spec.releaseTarget.compatible ||
      spec.workflow.pin !== null ||
      spec.missingFields.length !== 0 ||
      spec.references.length !== 4 ||
      spec.references.some((reference) => reference.prepared) ||
      privateSpec.releasePolicyHash !== STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH ||
      privateSpec.preparedReferences.source_frame !== undefined ||
      canonical([...spec.blockerCodes].sort()) !==
        canonical(["publishable_workflow_missing", "source_reference_not_prepared"])
    ) {
      return fail();
    }
    return {
      nodeId: entry.target.nodeId,
      shotId: entry.target.shotId,
      sceneId: entry.target.sceneId,
      episodeId: entry.target.episodeId,
      landingBeatId: entry.target.landingBeatId,
      production: {
        specId: spec.specId,
        inputFingerprint: spec.inputFingerprint,
        sourceContentHash: spec.sourceContentHash,
        taskId: spec.original.taskId,
        outputRef: spec.original.outputRef,
        status: spec.status,
        planStatus: spec.original.planStatus,
        releaseCompatible: spec.releaseTarget.compatible,
        executionAllowed: spec.executionAllowed,
        referencesPrepared: spec.references.every((reference) => reference.prepared),
        workflowPin: spec.workflow.pin,
        blockerCodes: [...spec.blockerCodes],
      },
      rows: entry.rows,
      choices: entry.choices,
      bindings: entry.localShot.bindings.map((binding) => ({
        role: binding.role,
        referenceId: referenceIdForRole(binding.role),
        assetId: binding.assetId,
        sha256: binding.sha256,
        bytes: binding.bytes,
        mediaType: binding.mediaType,
        localIntegrity: binding.localIntegrity,
        prepared: false,
      })),
    };
  });

  return {
    authority: {
      ...STEAM_LAUNCH_REVIEW_AUTHORITY,
      authorStory: { ...STEAM_LAUNCH_REVIEW_AUTHORITY.authorStory },
      publicStory: { ...STEAM_LAUNCH_REVIEW_AUTHORITY.publicStory },
    },
    releasePolicy: {
      ...STEAM_RELEASE_TARGET_POLICY,
      policyHash: STEAM_LAUNCH_REVIEW_RELEASE_POLICY_HASH,
    },
    localIntegrity: buildLocalIntegrityInput(localIntegrity),
    shots,
  };
}

async function readWithOptions(
  options?: SteamLaunchReviewPacketTestOptions,
): Promise<SteamLaunchReviewPacketResult> {
  try {
    const input = await buildInput(options);
    return deriveSteamLaunchReviewPacket(input, (value) => sha256(value));
  } catch {
    return blockedSteamLaunchReviewPacket("authority_unavailable");
  }
}

export async function readSteamLaunchReviewPacket(): Promise<SteamLaunchReviewPacketResult> {
  return readWithOptions();
}

/** Test-only authority fault injection; production callers use the zero-argument reader. */
export async function readSteamLaunchReviewPacketForTest(
  options: SteamLaunchReviewPacketTestOptions,
): Promise<SteamLaunchReviewPacketResult> {
  return readWithOptions(options);
}

/** Test-only safe projection for pure hostile-input and reorder tests. */
export async function readSteamLaunchReviewPacketInputForTest(
  options: SteamLaunchReviewPacketTestOptions = {},
): Promise<SteamLaunchReviewPacketInput | null> {
  try {
    return await buildInput(options);
  } catch {
    return null;
  }
}
