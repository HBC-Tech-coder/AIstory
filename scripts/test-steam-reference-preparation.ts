import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  SteamReferencePreparationFileOps,
  SteamReferencePreparationFileStat,
  SteamReferencePreparationReadHandle,
} from "../lib/steam/referencePreparationServer";
import type { SteamReferencePreparationInput } from "../lib/steam/referencePreparation";

const CHILD_FLAG = "--p19-react-server-child";

if (!process.argv.includes(CHILD_FLAG)) {
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      CHILD_FLAG,
    ],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  await run();
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network_forbidden_in_reference_preparation_test");
  }) as typeof fetch;

  try {
    const contract = await import("../lib/steam/referencePreparation");
    const server = await import("../lib/steam/referencePreparationServer");

    const hash = (value: string | Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    const first = await server.readSteamReferencePreparation();
    const second = await server.readSteamReferencePreparation();

    assert.equal(first.status, "LOCAL_VERIFIED_ONLY");
    assert.deepEqual(first.summary, {
      shots: 3,
      bindings: 12,
      uniqueAssets: 6,
      localVerifiedAssets: 6,
    });
    assert.equal(first.mode, "local_verify_only");
    assert.equal(first.executionAllowed, false);
    assert.equal(first.providerPreparation, "NOT_ATTEMPTED");
    assert.equal(first.providerContacted, false);
    assert.equal(first.providerReferenceHandlesIssued, 0);
    assert.equal(first.gpuProbed, false);
    assert.equal(first.networkCalls, 0);
    assert.equal(first.writesPerformed, 0);
    assert.equal(first.releaseGate.satisfied, false);
    assert.deepEqual(first.blockerCodes, ["source_reference_not_prepared"]);
    assert.match(first.manifestFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(contract.serializeSteamReferencePreparation(first), contract.serializeSteamReferencePreparation(second));
    assert.equal(first.manifestFingerprint, second.manifestFingerprint);
    assert.equal(first.sourceManifests.assetManifest.bytes, 8_256);
    assert.equal(
      first.sourceManifests.assetManifest.sha256,
      "b3232a6a9da08bd103c8005aa0569a2412c558d197c6626f762d60d6c23798c0",
    );
    assert.equal(first.sourceManifests.videoPrompts.bytes, 56_726);
    assert.equal(
      first.sourceManifests.videoPrompts.sha256,
      "94089ac020424b1b9f425777814820d5626e2d3e514105f9350f82b1ca0f77c6",
    );
    assert.deepEqual(
      first.shots.map((shot) => [shot.nodeId, shot.shotId, shot.bindings.length]),
      [
        ["vg11_wake_choice", "VG11-SHOT-02", 4],
        ["vg11_breakfast_choice", "VG11-SHOT-04", 4],
        ["vg11_wake_pull", "VG11-SHOT-05", 4],
      ],
    );
    assert.equal(first.assets.reduce((total, asset) => total + asset.bytes, 0), 11_146_904);
    assert.deepEqual(
      first.assets.map((asset) => [asset.assetId, asset.kind, asset.bytes, asset.sha256]),
      [
        [
          "vg11-char-expression-reference",
          "expression_sheet",
          2_089_975,
          "26413e9b8c6a690f3284878d3241d630ba755a5bcc393a1099d835b2caa7597f",
        ],
        [
          "vg11-char-face-reference",
          "character_base",
          1_791_749,
          "390262b5125b6d3b8b0d02996bd1dab15a4d25d9d5d2f79bd2b849ec3f24032a",
        ],
        [
          "vg11-char-home-outfit-reference",
          "outfit_sheet",
          1_861_662,
          "102aae24bfdc03608763f153cfeb5a568776549da2c2722a36814911c593310b",
        ],
        [
          "vg11-kf-breakfast",
          "keyframe",
          1_841_942,
          "04cc8aadfdd00dd79962bb5062079d09f59e7c173bf3a9419bd56e107d10df15",
        ],
        [
          "vg11-kf-pull-up",
          "keyframe",
          1_820_066,
          "14ffb9f340d86916fd2d7a8c7874b14fc7e10044a8cd2052e38732326a2050b4",
        ],
        [
          "vg11-kf-wake",
          "keyframe",
          1_741_510,
          "dc403b7da99253fadbf7382195941692bdf5b228978e889b571e5d98e7a670ad",
        ],
      ],
    );
    for (const asset of first.assets) {
      assert.equal(asset.mediaType, "image/png");
      assert.deepEqual(asset.media, {
        width: 1_672,
        height: 941,
        bitDepth: 8,
        colorType: 2,
        compressionMethod: 0,
        filterMethod: 0,
        interlaceMethod: 0,
      });
      assert.equal(asset.localIntegrity, "verified");
    }

    const canonicalInput = inputFromVerified(first);
    const derived = contract.deriveSteamReferencePreparation(canonicalInput, hash);
    assert.equal(derived.status, "LOCAL_VERIFIED_ONLY");
    assert.equal(derived.manifestFingerprint, first.manifestFingerprint);

    const reordered = structuredClone(canonicalInput);
    reordered.shots.reverse();
    reordered.assets.reverse();
    reordered.bindings.reverse();
    for (const shot of reordered.shots) shot.referenceIds.reverse();
    const reorderedResult = contract.deriveSteamReferencePreparation(reordered, hash);
    assert.equal(reorderedResult.status, "LOCAL_VERIFIED_ONLY");
    assert.equal(reorderedResult.manifestFingerprint, first.manifestFingerprint);
    assert.equal(
      contract.serializeSteamReferencePreparation(reorderedResult),
      contract.serializeSteamReferencePreparation(first),
    );

    const expectBlocked = (
      mutate: (input: ReturnType<typeof inputFromVerified>) => void,
      code: string,
    ) => {
      const input = structuredClone(canonicalInput);
      mutate(input);
      const result = contract.deriveSteamReferencePreparation(input, hash);
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.manifestFingerprint, null);
      assert.deepEqual(result.assets, []);
      assert.deepEqual(result.shots, []);
      assert.deepEqual(result.summary, {
        shots: 0,
        bindings: 0,
        uniqueAssets: 0,
        localVerifiedAssets: 0,
      });
      assert.deepEqual(result.blockerCodes, ["source_reference_not_prepared", code]);
    };

    expectBlocked((input) => {
      input.authority.caseId = "replacement-case";
    }, "authority_case_mismatch");
    expectBlocked((input) => {
      input.authority.releaseVersion = "v1.0";
    }, "authority_version_mismatch");
    expectBlocked((input) => {
      input.sourceManifests.assetManifest.schemaVersion = 2;
    }, "authority_invalid");
    expectBlocked((input) => {
      input.shots.pop();
    }, "target_shot_missing");
    expectBlocked((input) => {
      input.shots[2] = structuredClone(input.shots[0]!);
    }, "target_shot_duplicate");
    expectBlocked((input) => {
      input.shots[0]!.shotId = "VG11-SHOT-99";
    }, "target_shot_mismatch");
    expectBlocked((input) => {
      input.shots[0]!.nodeId = "vg11_replacement";
    }, "target_shot_missing");
    expectBlocked((input) => {
      input.shots[0]!.referenceIds.pop();
    }, "reference_binding_mismatch");
    expectBlocked((input) => {
      input.shots[0]!.referenceIds[0] = "R3_MAID_OUTFIT";
    }, "reference_binding_mismatch");
    expectBlocked((input) => {
      input.shots[0]!.referenceIds[0] = "R5_NATIVE_BODY";
    }, "reference_binding_mismatch");
    expectBlocked((input) => {
      input.bindings.pop();
    }, "reference_binding_missing");
    expectBlocked((input) => {
      input.bindings[11] = structuredClone(input.bindings[0]!);
    }, "reference_binding_duplicate");
    expectBlocked((input) => {
      const binding = input.bindings.find((item) => item.role === "identity_face")!;
      binding.referenceId = "R3_MAID_OUTFIT";
    }, "reference_binding_mismatch");
    expectBlocked((input) => {
      input.assets.pop();
    }, "asset_missing");
    expectBlocked((input) => {
      input.assets[5] = structuredClone(input.assets[0]!);
    }, "asset_duplicate");
    expectBlocked((input) => {
      input.assets[0]!.status = "pending";
    }, "asset_status_invalid");
    expectBlocked((input) => {
      input.assets[0]!.releasePolicy = "internal";
    }, "asset_release_policy_invalid");
    expectBlocked((input) => {
      input.assets[0]!.kind = "keyframe";
    }, "asset_kind_invalid");
    for (const unsafe of [
      "../vg11-char-expression-reference.png",
      "folder/vg11-char-expression-reference.png",
      "folder\\vg11-char-expression-reference.png",
      "C:vg11-char-expression-reference.png",
      "file:vg11-char-expression-reference.png",
    ]) {
      expectBlocked((input) => {
        input.assets[0]!.basename = unsafe;
      }, "asset_manifest_mismatch");
    }
    expectBlocked((input) => {
      input.assets[0]!.manifestBasename = "vg11-char-face-reference.png";
    }, "asset_manifest_mismatch");
    expectBlocked((input) => {
      input.assets[0]!.local.bytes += 1;
    }, "local_asset_bytes_mismatch");
    expectBlocked((input) => {
      input.assets[0]!.local.sha256 = "f".repeat(64);
    }, "local_asset_sha256_mismatch");
    expectBlocked((input) => {
      input.assets[0]!.local.width = 1_671;
    }, "local_asset_png_invalid");
    expectBlocked((input) => {
      input.assets[0]!.local.mediaType = "image/jpeg";
    }, "local_asset_png_invalid");

    const extraKeyInput = structuredClone(canonicalInput) as ReturnType<
      typeof inputFromVerified
    > & { extra?: string };
    extraKeyInput.extra = "not_allowed";
    assert.equal(
      contract.deriveSteamReferencePreparation(extraKeyInput, hash).status,
      "BLOCKED",
    );
    const prototypeInput = structuredClone(canonicalInput);
    Object.setPrototypeOf(prototypeInput, { inherited: true });
    assert.equal(
      contract.deriveSteamReferencePreparation(prototypeInput, hash).status,
      "BLOCKED",
    );
    const arrayPrototypeInput = structuredClone(canonicalInput);
    Object.setPrototypeOf(arrayPrototypeInput.shots, { inherited: true });
    assert.equal(
      contract.deriveSteamReferencePreparation(arrayPrototypeInput, hash).status,
      "BLOCKED",
    );
    const symbolInput = structuredClone(canonicalInput) as ReturnType<typeof inputFromVerified> &
      Record<symbol, string>;
    symbolInput[Symbol("hidden")] = "not_allowed";
    assert.equal(contract.deriveSteamReferencePreparation(symbolInput, hash).status, "BLOCKED");
    let accessorRead = false;
    const accessorInput = structuredClone(canonicalInput);
    Object.defineProperty(accessorInput, "authority", {
      enumerable: true,
      get() {
        accessorRead = true;
        return canonicalInput.authority;
      },
    });
    assert.equal(
      contract.deriveSteamReferencePreparation(accessorInput, hash).status,
      "BLOCKED",
    );
    assert.equal(accessorRead, false);

    assertPublicRedaction(first);
    const serialized = contract.serializeSteamReferencePreparation(first);
    assert.equal(serialized.includes("R3_MAID_OUTFIT"), false);
    assert.equal(serialized.includes("R5_NATIVE_BODY"), false);
    assert.equal(serialized.includes("sourceReferences"), false);

    const baseOps = server.createSteamReferencePreparationNodeFileOps();
    const authorRoot = path.resolve(
      "content/case-studies/virtual-girlfriend-20260727/author-locked-v1.1",
    );
    // The selected shared expression asset is verified last, so every injected
    // failure below also proves that five prior successes are never returned as
    // a partially-qualified package.
    const targetPath = path.join(
      authorRoot,
      "generated-assets",
      "vg11-char-expression-reference.png",
    );
    const actualBytes = await readFile(targetPath);
    const actualStat = await baseOps.lstat(targetPath);

    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        lstat: async () => Promise.reject(Object.assign(new Error("private path"), { code: "ENOENT" })),
      }),
      "local_asset_missing",
    );
    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        lstat: async () => ({ ...actualStat, isFile: false, isDirectory: true }),
      }),
      "local_asset_not_regular",
    );
    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        lstat: async () => ({ ...actualStat, isFile: false, isDirectory: false }),
      }),
      "local_asset_not_regular",
    );
    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        lstat: async () => ({ ...actualStat, isSymbolicLink: true }),
      }),
      "local_asset_link_forbidden",
    );
    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        realpath: async () => path.resolve(authorRoot, "..", "outside.png"),
      }),
      "local_asset_outside_root",
    );
    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        lstat: async () => ({
          ...actualStat,
          size: contract.STEAM_REFERENCE_PREPARATION_LIMITS.assetBytes + 1,
        }),
      }),
      "local_asset_limit_exceeded",
    );
    await assertServerFailure(
      server,
      authorRoot,
      wrapOps(baseOps, targetPath, {
        openReadOnly: async () => fakeHandle(actualBytes, {
          ...actualStat,
          identity: `${actualStat.identity}-changed`,
        }),
      }),
      "local_verification_unavailable",
    );

    const bytesDrift = Buffer.concat([actualBytes, Buffer.from([0])]);
    await assertServerFailure(
      server,
      authorRoot,
      bufferOps(baseOps, targetPath, bytesDrift, {
        ...actualStat,
        size: bytesDrift.length,
        modifiedMs: actualStat.modifiedMs + 1,
        changedMs: actualStat.changedMs + 1,
      }),
      "local_asset_bytes_mismatch",
    );
    const hashDrift = Buffer.from(actualBytes);
    hashDrift[hashDrift.length - 1] = hashDrift[hashDrift.length - 1]! ^ 1;
    await assertServerFailure(
      server,
      authorRoot,
      bufferOps(baseOps, targetPath, hashDrift, actualStat),
      "local_asset_sha256_mismatch",
    );
    const magicDrift = Buffer.from(actualBytes);
    magicDrift[0] = magicDrift[0]! ^ 1;
    await assertServerFailure(
      server,
      authorRoot,
      bufferOps(baseOps, targetPath, magicDrift, actualStat),
      "local_asset_png_invalid",
    );
    const ihdrDrift = Buffer.from(actualBytes);
    ihdrDrift[12] = 0;
    await assertServerFailure(
      server,
      authorRoot,
      bufferOps(baseOps, targetPath, ihdrDrift, actualStat),
      "local_asset_png_invalid",
    );
    await assertServerFailure(
      server,
      authorRoot,
      growthOps(baseOps, targetPath, actualBytes, actualStat),
      "local_verification_unavailable",
    );

    await assertPreflightRemainsBlocked(hash, first);
    await assertStaticBoundary();
    assert.equal(networkCalls, 0);

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        status: first.status,
        manifestFingerprint: first.manifestFingerprint,
        shots: first.summary.shots,
        bindings: first.summary.bindings,
        uniqueAssets: first.summary.uniqueAssets,
        providerContacted: first.providerContacted,
        providerReferenceHandlesIssued: first.providerReferenceHandlesIssued,
        gpuProbed: first.gpuProbed,
        networkCalls,
        writesPerformed: first.writesPerformed,
        executionAllowed: first.executionAllowed,
      })}\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

type VerifiedManifest = Extract<
  Awaited<ReturnType<typeof import("../lib/steam/referencePreparationServer").readSteamReferencePreparation>>,
  { status: "LOCAL_VERIFIED_ONLY" }
>;

function inputFromVerified(manifest: VerifiedManifest): SteamReferencePreparationInput {
  const targets = [
    ["vg11_wake_choice", "VG11-SHOT-02", "vg11-kf-wake"],
    ["vg11_breakfast_choice", "VG11-SHOT-04", "vg11-kf-breakfast"],
    ["vg11_wake_pull", "VG11-SHOT-05", "vg11-kf-pull-up"],
  ] as const;
  const assets = manifest.assets.map((asset) => {
    const sourceTarget = targets.find((target) => target[2] === asset.assetId);
    const sourceShot = sourceTarget
      ? manifest.shots.find((shot) => shot.nodeId === sourceTarget[0])
      : undefined;
    return {
      assetId: asset.assetId,
      basename: `${asset.assetId}.png`,
      manifestBasename: `${asset.assetId}.png`,
      kind: asset.kind,
      sceneId: sourceShot?.sceneId ?? null,
      status: "generated",
      releasePolicy: "public",
      bytes: asset.bytes,
      sha256: asset.sha256,
      local: {
        bytes: asset.bytes,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        ...asset.media,
        localIntegrity: "verified",
      },
    };
  });
  return {
    authority: structuredClone(manifest.authority),
    sourceManifests: structuredClone(manifest.sourceManifests),
    shots: targets.map(([nodeId, shotId, sourceFrameAssetId]) => {
      const shot = manifest.shots.find((candidate) => candidate.nodeId === nodeId)!;
      return {
        nodeId,
        shotId,
        sceneId: shot.sceneId,
        episodeId: shot.episodeId,
        durationSeconds: 30,
        releasePolicy: "public",
        sourceFrameAssetId,
        referenceIds: ["R1_FACE", "R2_HOME_OUTFIT", "R4_EXPRESSIONS"],
      };
    }),
    assets,
    bindings: manifest.shots.flatMap((shot) =>
      shot.bindings.map((binding) => ({
        nodeId: shot.nodeId,
        shotId: shot.shotId,
        role: binding.role,
        referenceId: binding.referenceId,
        assetId: binding.assetId,
      })),
    ),
  };
}

function assertPublicRedaction(value: unknown): void {
  const forbiddenKeys = new Set([
    "prepared",
    "preparedReference",
    "preparedReferences",
    "referenceImages",
    "url",
    "uri",
    "localPath",
    "path",
    "absolutePath",
    "prompt",
    "negativePrompt",
    "sourceReferences",
    "providerTaskId",
    "workflowJson",
    "token",
    "secret",
    "imageBytes",
    "dataUri",
  ]);
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      assert.equal(/(?:https?:|file:|data:image|^[A-Za-z]:[\\/]|^\\\\)/i.test(entry), false);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden public key: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function wrapOps(
  base: SteamReferencePreparationFileOps,
  target: string,
  overrides: Partial<SteamReferencePreparationFileOps>,
): SteamReferencePreparationFileOps {
  return {
    lstat: (file) =>
      samePath(file, target) && overrides.lstat ? overrides.lstat(file) : base.lstat(file),
    realpath: (file) =>
      samePath(file, target) && overrides.realpath
        ? overrides.realpath(file)
        : base.realpath(file),
    openReadOnly: (file) =>
      samePath(file, target) && overrides.openReadOnly
        ? overrides.openReadOnly(file)
        : base.openReadOnly(file),
  };
}

function fakeHandle(
  bytes: Uint8Array,
  stat: SteamReferencePreparationFileStat,
  options: { growthByte?: boolean } = {},
): SteamReferencePreparationReadHandle {
  return {
    stat: async () => ({ ...stat }),
    read: async (target, offset, length, position) => {
      if (position < bytes.length) {
        const count = Math.min(length, bytes.length - position);
        target.set(bytes.subarray(position, position + count), offset);
        return count;
      }
      if (options.growthByte && position === bytes.length && length > 0) {
        target[offset] = 0;
        return 1;
      }
      return 0;
    },
    close: async () => undefined,
  };
}

function bufferOps(
  base: SteamReferencePreparationFileOps,
  target: string,
  bytes: Uint8Array,
  stat: SteamReferencePreparationFileStat,
): SteamReferencePreparationFileOps {
  return wrapOps(base, target, {
    lstat: async () => ({ ...stat }),
    openReadOnly: async () => fakeHandle(bytes, stat),
  });
}

function growthOps(
  base: SteamReferencePreparationFileOps,
  target: string,
  bytes: Uint8Array,
  stat: SteamReferencePreparationFileStat,
): SteamReferencePreparationFileOps {
  return wrapOps(base, target, {
    lstat: async () => ({ ...stat }),
    openReadOnly: async () => fakeHandle(bytes, stat, { growthByte: true }),
  });
}

async function assertServerFailure(
  server: typeof import("../lib/steam/referencePreparationServer"),
  authorRoot: string,
  ops: SteamReferencePreparationFileOps,
  code: string,
): Promise<void> {
  const result = await server.readSteamReferencePreparationForTest({
    testOnlyAuthorRoot: authorRoot,
    testOnlyFileOps: ops,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.manifestFingerprint, null);
  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.shots, []);
  assert.deepEqual(result.blockerCodes, ["source_reference_not_prepared", code]);
}

async function assertPreflightRemainsBlocked(
  hash: (value: string) => string,
  manifest: VerifiedManifest,
): Promise<void> {
  const preflight = await import("../lib/steam/productionSpec");
  const byId = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const sourceAssets: Record<string, string> = {
    vg11_wake_choice: "vg11-kf-wake",
    vg11_breakfast_choice: "vg11-kf-breakfast",
    vg11_wake_pull: "vg11-kf-pull-up",
  };
  const shots = manifest.shots.map((shot, index) => ({
    projectRef: "case-study:virtual-girlfriend-20260727",
    caseId: "virtual-girlfriend-20260727",
    storyId: "case:virtual-girlfriend-20260727",
    storyVersion: "author-locked-v1.1",
    nodeId: shot.nodeId as (typeof preflight.STEAM_VIDEO_GENERATION_PREFLIGHT_NODE_IDS)[number],
    sceneId: shot.sceneId,
    episodeId: shot.episodeId,
    shotId: shot.shotId,
    sourceContentHash: hash(`source-${shot.nodeId}`),
    privatePrompt: "SERVER_ONLY_TEST_PROMPT",
    videoPolicy: {
      orientation: "landscape" as const,
      durationSeconds: 30,
      aspectRatio: "16:9" as const,
      width: 1280,
      height: 720,
      fps: 24,
    },
    audioIntent: "attach" as const,
    subtitleIntent: "attach_webvtt" as const,
    references: [
      ["source_frame", sourceAssets[shot.nodeId]],
      ["identity_face", "vg11-char-face-reference"],
      ["home_outfit", "vg11-char-home-outfit-reference"],
      ["expressions", "vg11-char-expression-reference"],
    ].map(([role, assetId]) => ({
      role: role as "source_frame" | "identity_face" | "home_outfit" | "expressions",
      assetId: assetId!,
      sha256: byId.get(assetId!)!.sha256,
    })),
    originalPlanTask: {
      taskId: `svp1-test-original-${index}`,
      outputRef: `steam-video:test:original:${index}`,
      status: "ready" as const,
      blockerCodes: [],
    },
    upscalePlanTask: {
      taskId: `svp1-test-upscale-${index}`,
      outputRef: `steam-video:test:upscale:${index}`,
    },
    workflowCandidates: [],
  }));
  const result = preflight.deriveSteamVideoGenerationPreflight({
    observedAt: "2026-08-16T00:00:00.000Z",
    authority: {
      caseId: "virtual-girlfriend-20260727",
      storyId: "case:virtual-girlfriend-20260727",
      storyVersion: "author-locked-v1.1",
      projectRef: "case-study:virtual-girlfriend-20260727",
    },
    shots,
    sha256: hash,
  }).publicPackage;
  assert.deepEqual(result.summary, { total: 3, ready: 0, blocked: 3 });
  assert.equal(result.executionAllowed, false);
  for (const spec of result.specs) {
    assert.deepEqual(spec.blockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
    ]);
    assert.equal(spec.references.every((reference) => !reference.prepared), true);
    assert.equal(spec.executionAllowed, false);
  }
}

async function assertStaticBoundary(): Promise<void> {
  const files = [
    "lib/steam/referencePreparation.ts",
    "lib/steam/referencePreparationServer.ts",
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  const forbidden = [
    /node:(?:http|https|net|tls|child_process)/,
    /\bundici\b/,
    /\bfetch\s*\(/,
    /\b(?:writeFile|appendFile|mkdir|rm|rename|unlink)\s*\(/,
    /process\.env/,
    /generation-jobs/,
    /project-assets/,
    /gpu-coordinator/,
    /providers\/comfyui/,
    /GenerationJobScheduler/,
    /referenceImages/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
}
