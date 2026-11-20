import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  SteamLaunchReviewFailureCode,
  SteamLaunchReviewPacketInput,
  SteamLaunchReviewPacketResult,
} from "../lib/steam/launchReviewPacket";

const CHILD_FLAG = "--p110-launch-review-react-server-child";

if (!process.argv.includes(CHILD_FLAG)) {
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", fileURLToPath(import.meta.url), CHILD_FLAG],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  await run();
}

type ContractModule = typeof import("../lib/steam/launchReviewPacket");

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ready(result: SteamLaunchReviewPacketResult) {
  assert.equal(result.status, "LOCAL_REVIEW_PACKET_READY");
  if (result.status !== "LOCAL_REVIEW_PACKET_READY") throw new Error("packet_not_ready");
  return result.packet;
}

function assertBlocked(
  contract: ContractModule,
  input: SteamLaunchReviewPacketInput,
  expectedCode?: SteamLaunchReviewFailureCode,
  label = "hostile input",
): void {
  const result = contract.deriveSteamLaunchReviewPacket(input, hash);
  assert.equal(result.status, "BLOCKED", label);
  if (result.status !== "BLOCKED") throw new Error(`expected_blocked:${label}`);
  assert.equal(result.packet, null, label);
  assert.equal(result.publicResult.packetId, null, label);
  assert.equal(result.publicResult.packetFingerprint, null, label);
  assert.deepEqual(
    result.publicResult.summary,
    { shots: 0, reviewRows: 0, choices: 0, referenceBindings: 0, uniqueAssets: 0 },
    label,
  );
  assert.deepEqual(result.publicResult.blockerCodes, [
    "source_reference_not_prepared",
    "publishable_workflow_missing",
    "manual_cue_review_required",
  ]);
  assert.equal(result.publicResult.playbackReady, false);
  assert.equal(result.publicResult.executionAllowed, false);
  assert.equal(result.publicResult.publishAllowed, false);
  assert.equal(result.publicResult.jobWriteAllowed, false);
  assert.equal(result.publicResult.providerPreparation, "NOT_ATTEMPTED");
  assert.equal(result.publicResult.providerContacted, false);
  assert.equal(result.publicResult.providerReferenceHandlesIssued, 0);
  assert.equal(result.publicResult.gpuProbed, false);
  assert.equal(result.publicResult.networkCalls, 0);
  assert.equal(result.publicResult.writesPerformed, 0);
  assert.equal(result.publicResult.releaseGate.satisfied, false);
  if (expectedCode) assert.equal(result.publicResult.failureCode, expectedCode, label);
}

function hostile(
  contract: ContractModule,
  baseline: SteamLaunchReviewPacketInput,
  label: string,
  mutate: (draft: SteamLaunchReviewPacketInput) => void,
  expectedCode?: SteamLaunchReviewFailureCode,
): void {
  const draft = structuredClone(baseline);
  mutate(draft);
  assertBlocked(contract, draft, expectedCode, label);
}

function assertAssignmentsAreUnassigned(result: ReturnType<typeof ready>): void {
  for (const shot of result.shots) {
    for (const row of shot.rows) {
      assert.deepEqual(row.assignment, {
        speaker: { status: "UNASSIGNED", characterId: null },
        audio: { status: "UNASSIGNED", assetId: null },
        subtitle: { status: "UNASSIGNED", cueId: null },
        timing: { status: "UNASSIGNED", startMs: null, endMs: null },
      });
    }
  }
}

function assertPublicRedaction(value: unknown): void {
  const forbiddenKeys = new Set([
    "absolutePath",
    "autoSubmit",
    "data",
    "effect",
    "imageBytes",
    "localPath",
    "mediaUrl",
    "negativePrompt",
    "nextSceneSeed",
    "path",
    "preparedReference",
    "preparedReferences",
    "prompt",
    "providerTaskId",
    "referenceHandle",
    "referenceToken",
    "scenePrompt",
    "secret",
    "sourceTextVerbatim",
    "token",
    "uri",
    "url",
    "workflowJson",
  ]);
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      assert.doesNotMatch(entry, /(?:file:|https?:\/\/|data:image|[A-Za-z]:\\|\\\\)/i);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(entry)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden public key: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

async function assertStaticBoundary(): Promise<void> {
  const source = (
    await Promise.all(
      [
        "lib/steam/launchReviewPacket.ts",
        "lib/steam/launchReviewPacketServer.ts",
      ].map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
  const forbidden = [
    /node:(?:http|https|net|tls|child_process)/,
    /\bundici\b/,
    /\bfetch\s*\(/,
    /process\.env/,
    /productionSpecServer/,
    /productionPlanServer/,
    /mapSteamVideoGenerationSpecToCreateRequest/,
    /generation-jobs/,
    /project-assets/,
    /gpu-coordinator/,
    /providers\/comfyui/,
    /video-assets/,
    /sceneMedia/,
    /\b(?:writeFile|appendFile|mkdir|rm|rename|unlink)\s*\(/,
    /\b(?:submit|enqueue|upload|publish)Steam/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network_forbidden_in_launch_review_packet_test");
  }) as typeof fetch;

  try {
    const contract = await import("../lib/steam/launchReviewPacket");
    const server = await import("../lib/steam/launchReviewPacketServer");

    const first = await server.readSteamLaunchReviewPacket();
    const second = await server.readSteamLaunchReviewPacket();
    const packet = ready(first);
    const secondPacket = ready(second);
    assert.equal(packet.mode, "local_plan_only");
    assert.equal(packet.status, "LOCAL_REVIEW_PACKET_READY");
    assert.deepEqual(packet.summary, {
      shots: 3,
      reviewRows: 23,
      choices: 5,
      referenceBindings: 12,
      uniqueAssets: 6,
    });
    assert.equal(
      packet.packetFingerprint,
      "fda3ec7088d07225d6486afa38471f4cc88f79e67d3a1506caac2fb894d1c397",
    );
    assert.equal(packet.packetId, `slrp1-${packet.packetFingerprint}`);
    assert.equal(packet.packetFingerprint, secondPacket.packetFingerprint);
    assert.equal(
      contract.serializeSteamLaunchReviewPacketJson(first),
      contract.serializeSteamLaunchReviewPacketJson(second),
    );
    assert.equal(
      contract.serializeSteamLaunchReviewPacketCsv(first),
      contract.serializeSteamLaunchReviewPacketCsv(second),
    );
    assert.deepEqual(packet.releasePolicy, {
      discriminator: "STEAM_RELEASE_TARGET",
      policyVersion: "steam_release_v1",
      orientation: "landscape",
      aspectRatio: "16:9",
      width: 1280,
      height: 720,
      fps: 24,
      durationSeconds: 30,
      audioIntent: "attach",
      subtitleIntent: "attach_webvtt",
      policyHash: "47aec1252f7c9aba7a9d0ff6358dff152ec15cd5094bd781e80bf257047259a6",
    });
    assert.deepEqual(packet.subtitleTarget, {
      locale: "zh-CN",
      format: "webvtt",
      windowStartMs: 0,
      windowEndMs: 30_000,
      cuesAssigned: false,
    });
    assert.deepEqual(packet.blockerCodes, [
      "source_reference_not_prepared",
      "publishable_workflow_missing",
      "manual_cue_review_required",
    ]);
    assert.equal(packet.playbackReady, false);
    assert.equal(packet.executionAllowed, false);
    assert.equal(packet.publishAllowed, false);
    assert.equal(packet.jobWriteAllowed, false);
    assert.equal(packet.providerPreparation, "NOT_ATTEMPTED");
    assert.equal(packet.providerContacted, false);
    assert.equal(packet.providerReferenceHandlesIssued, 0);
    assert.equal(packet.gpuProbed, false);
    assert.equal(packet.networkCalls, 0);
    assert.equal(packet.writesPerformed, 0);
    assert.equal(packet.releaseGate.satisfied, false);
    assert.equal(packet.localIntegrity.status, "LOCAL_VERIFIED_ONLY");
    assert.equal(
      packet.localIntegrity.manifestFingerprint,
      "ac44cd20cf8efa8b9f4305c2fd4ae324c60df8e8a64775b00c8a94dc05c06875",
    );
    assert.deepEqual(packet.authority, {
      caseId: "virtual-girlfriend-20260727",
      storyId: "case:virtual-girlfriend-20260727",
      storyVersion: "author-locked-v1.1",
      projectRef: "case-study:virtual-girlfriend-20260727",
      authorReleaseVersion: "v1.1",
      authorStory: {
        bytes: 134_298,
        rawBytesSha256: "c48d1f53f48c2ddb4a62fe89aa7e14ed84a895af68bc49e6323f59aef35f0ab1",
      },
      publicStory: {
        bytes: 47_895,
        rawBytesSha256: "26b54b8532f3a9e6107a4dabc0b34ceabcd3f7709292f243ade96cf661a3a3cc",
      },
      assetManifest: {
        schemaVersion: 1,
        bytes: 8_256,
        sha256: "b3232a6a9da08bd103c8005aa0569a2412c558d197c6626f762d60d6c23798c0",
      },
      videoPrompts: {
        schemaVersion: 1,
        bytes: 56_726,
        sha256: "94089ac020424b1b9f425777814820d5626e2d3e514105f9350f82b1ca0f77c6",
      },
    });

    assert.deepEqual(
      packet.shots.map((shot) => [
        shot.nodeId,
        shot.shotId,
        shot.landingBeatId,
        shot.rows.length,
        shot.choices.length,
        shot.bindings.length,
      ]),
      [
        ["vg11_wake_choice", "VG11-SHOT-02", "vg11_wake_choice_b2", 2, 2, 4],
        ["vg11_breakfast_choice", "VG11-SHOT-04", "vg11_breakfast_choice_b8", 8, 2, 4],
        ["vg11_wake_pull", "VG11-SHOT-05", "vg11_wake_pull_b13", 13, 1, 4],
      ],
    );
    assert.deepEqual(
      packet.shots.map((shot) => [
        shot.production.specId,
        shot.production.inputFingerprint,
        shot.production.sourceContentHash,
        shot.production.taskId,
        shot.production.outputRef,
      ]),
      [
        [
          "svgs2-4b99cbdcc987a63687d19e3659b9a1390201428da6b3fde863aaf51dbab55cb9",
          "760992fa4cc40233c38f5a95a016d745bdaeecc6649712ce7a8a1eb9a3763759",
          "5446cc48e998927613e050eb994d8137df6575ed692e8baa375c356976113ed0",
          "svp1-0858ae144799e79385e1b910-5446cc48e998927613e050eb-original_video",
          "steam-video:v1:0858ae144799e79385e1b910:5446cc48e998927613e050eb:original_video",
        ],
        [
          "svgs2-a830782fd55aea28814aa71b582cdc702cc0b8170416c7f309bfc6480820f8a8",
          "38ab3450de53b6c0b5b00d188d50aa2d7f650dc17bd2405c6d36333772b5c758",
          "c5c6cda991e5f07d2d06a6bfbc42ac6d631588cdde1a60dfa3512075bca1dedc",
          "svp1-0858ae144799e79385e1b910-c5c6cda991e5f07d2d06a6bf-original_video",
          "steam-video:v1:0858ae144799e79385e1b910:c5c6cda991e5f07d2d06a6bf:original_video",
        ],
        [
          "svgs2-8c9fc5cc731eea0c367205f781d90bdf8416394ebd907cd66619f3cfa139c4fd",
          "214b2c7a83a8fdf03e36308a916f15111323734c00cb53499a66bf54b52819ba",
          "da32dc9b276815acd795ef896ab98b5789b8da523352004d26a087e6d4b9b886",
          "svp1-0858ae144799e79385e1b910-da32dc9b276815acd795ef89-original_video",
          "steam-video:v1:0858ae144799e79385e1b910:da32dc9b276815acd795ef89:original_video",
        ],
      ],
    );
    const allRows = packet.shots.flatMap((shot) => shot.rows);
    const allChoices = packet.shots.flatMap((shot) => shot.choices);
    const allBindings = packet.shots.flatMap((shot) => shot.bindings);
    assert.equal(allRows.length, 23);
    assert.equal(new Set(allRows.map((row) => row.rowHash)).size, 23);
    assert.equal(allChoices.length, 5);
    assert.equal(new Set(allChoices.map((choice) => choice.choiceHash)).size, 5);
    assert.equal(allChoices.filter((choice) => choice.provenance === "explicit_choice").length, 4);
    assert.equal(allChoices.filter((choice) => choice.provenance === "derived_next").length, 1);
    assert.deepEqual(
      allChoices.map((choice) => [
        choice.choiceId,
        choice.sourceBeatId,
        choice.targetNodeId,
        choice.targetSceneId,
        choice.targetEntryBeatId,
        choice.provenance,
      ]),
      [
        ["vg11_c_wake_sleep", "vg11_wake_choice_b2", "vg11_wake_sleep", "VG11-S02A", "vg11_wake_sleep_b1", "explicit_choice"],
        ["vg11_c_wake_pull", "vg11_wake_choice_b2", "vg11_wake_pull", "VG11-S02B", "vg11_wake_pull_b1", "explicit_choice"],
        ["vg11_c_breakfast_angry", "vg11_breakfast_choice_b8", "vg11_breakfast_angry", "VG11-S04A", "vg11_breakfast_angry_b1", "explicit_choice"],
        ["vg11_c_breakfast_calm", "vg11_breakfast_choice_b8", "vg11_breakfast_calm", "VG11-S04B", "vg11_breakfast_calm_b1", "explicit_choice"],
        ["vg11_wake_pull_continue", "vg11_wake_pull_b13", "vg11_breakfast_choice", "VG11-S03", "vg11_breakfast_choice_b1", "derived_next"],
      ],
    );
    assert.equal(allBindings.length, 12);
    assert.equal(allBindings.every((binding) => binding.prepared === false), true);
    assert.equal(packet.assets.length, 6);
    assert.equal(packet.assets.every((asset) => asset.localIntegrity === "verified"), true);
    assert.equal(packet.assets.every((asset) => asset.mediaType === "image/png"), true);
    assertAssignmentsAreUnassigned(packet);
    for (const shot of packet.shots) {
      assert.equal(shot.production.status, "blocked");
      assert.equal(shot.production.planStatus, "blocked");
      assert.equal(shot.production.releaseCompatible, false);
      assert.equal(shot.production.executionAllowed, false);
      assert.equal(shot.production.referencesPrepared, false);
      assert.equal(shot.production.workflowPin, null);
      assert.deepEqual(shot.production.blockerCodes, [
        "publishable_workflow_missing",
        "source_reference_not_prepared",
      ]);
    }

    const json = contract.serializeSteamLaunchReviewPacketJson(first);
    const csv = contract.serializeSteamLaunchReviewPacketCsv(first);
    assert.equal(json.endsWith("\n"), true);
    assert.equal(csv.endsWith("\n"), true);
    assert.equal(csv.trimEnd().split(/\r?\n/).length, 24);
    assert.match(csv.split(/\r?\n/, 1)[0]!, /speakerStatus.*subtitleStatus.*timingStatus/);
    assertPublicRedaction(contract.redactSteamLaunchReviewPacket(first));
    assertPublicRedaction(JSON.parse(json) as unknown);
    assertPublicRedaction(csv);

    const videoPromptsRaw = await readFile(
      path.join(
        "content",
        "case-studies",
        "virtual-girlfriend-20260727",
        "author-locked-v1.1",
        "video-prompts.v1.1.json",
      ),
      "utf8",
    );
    const videoPrompts = JSON.parse(videoPromptsRaw) as {
      shots: Array<{ nodeId: string; prompt: string; negativePrompt: string }>;
    };
    for (const shot of videoPrompts.shots.filter((entry) =>
      ["vg11_wake_choice", "vg11_breakfast_choice", "vg11_wake_pull"].includes(entry.nodeId),
    )) {
      assert.equal(json.includes(shot.prompt), false);
      assert.equal(json.includes(shot.negativePrompt), false);
    }

    const baseline = await server.readSteamLaunchReviewPacketInputForTest();
    assert.ok(baseline);
    const pure = ready(contract.deriveSteamLaunchReviewPacket(baseline, hash));
    assert.equal(pure.packetFingerprint, packet.packetFingerprint);
    const reordered = structuredClone(baseline);
    reordered.shots.reverse();
    reordered.localIntegrity.assets.reverse();
    for (const shot of reordered.shots) {
      shot.rows.reverse();
      shot.choices.reverse();
      shot.bindings.reverse();
      shot.production.blockerCodes.reverse();
    }
    const reorderedResult = contract.deriveSteamLaunchReviewPacket(reordered, hash);
    const reorderedPacket = ready(reorderedResult);
    assert.equal(reorderedPacket.packetFingerprint, packet.packetFingerprint);
    assert.equal(
      contract.serializeSteamLaunchReviewPacketJson(reorderedResult),
      contract.serializeSteamLaunchReviewPacketJson(first),
    );
    assert.equal(
      contract.serializeSteamLaunchReviewPacketCsv(reorderedResult),
      contract.serializeSteamLaunchReviewPacketCsv(first),
    );

    hostile(contract, baseline, "wrong case", (draft) => { draft.authority.caseId = "wrong-case"; }, "authority_mismatch");
    hostile(contract, baseline, "wrong story", (draft) => { draft.authority.storyId = "case:wrong"; }, "authority_mismatch");
    hostile(contract, baseline, "wrong version", (draft) => { draft.authority.storyVersion = "author-locked-v1.0"; }, "authority_mismatch");
    hostile(contract, baseline, "wrong project", (draft) => { draft.authority.projectRef = "case-study:wrong"; }, "authority_mismatch");
    hostile(contract, baseline, "wrong author version", (draft) => { draft.authority.authorReleaseVersion = "v1.0"; }, "authority_mismatch");
    hostile(contract, baseline, "author bytes drift", (draft) => { draft.authority.authorStory.bytes += 1; }, "authority_mismatch");
    hostile(contract, baseline, "public hash drift", (draft) => { draft.authority.publicStory.rawBytesSha256 = "0".repeat(64); }, "authority_mismatch");

    for (const key of [
      "discriminator",
      "policyVersion",
      "policyHash",
      "orientation",
      "aspectRatio",
      "audioIntent",
      "subtitleIntent",
    ] as const) {
      hostile(contract, baseline, `policy ${key}`, (draft) => { draft.releasePolicy[key] = `${draft.releasePolicy[key]}-drift`; }, "release_policy_mismatch");
    }
    for (const key of ["width", "height", "fps", "durationSeconds"] as const) {
      hostile(contract, baseline, `policy ${key}`, (draft) => { draft.releasePolicy[key] += 1; }, "release_policy_mismatch");
    }

    hostile(contract, baseline, "local status", (draft) => { draft.localIntegrity.status = "BLOCKED"; }, "local_integrity_invalid");
    hostile(contract, baseline, "local fingerprint", (draft) => { draft.localIntegrity.manifestFingerprint = "0".repeat(64); }, "local_manifest_mismatch");
    hostile(contract, baseline, "asset manifest bytes", (draft) => { draft.localIntegrity.sourceManifests!.assetManifest.bytes += 1; }, "local_manifest_mismatch");
    hostile(contract, baseline, "video manifest hash", (draft) => { draft.localIntegrity.sourceManifests!.videoPrompts.sha256 = "0".repeat(64); }, "local_manifest_mismatch");
    hostile(contract, baseline, "local count", (draft) => { draft.localIntegrity.summary.bindings = 11; }, "coverage_mismatch");
    hostile(contract, baseline, "provider attempted", (draft) => { draft.localIntegrity.providerPreparation = "ATTEMPTED"; }, "unsafe_gate");
    hostile(contract, baseline, "provider contacted", (draft) => { draft.localIntegrity.providerContacted = true; }, "unsafe_gate");
    hostile(contract, baseline, "handle issued", (draft) => { draft.localIntegrity.providerReferenceHandlesIssued = 1; }, "unsafe_gate");
    hostile(contract, baseline, "execution enabled", (draft) => { draft.localIntegrity.executionAllowed = true; }, "unsafe_gate");
    hostile(contract, baseline, "gpu probed", (draft) => { draft.localIntegrity.gpuProbed = true; }, "unsafe_gate");
    hostile(contract, baseline, "network called", (draft) => { draft.localIntegrity.networkCalls = 1; }, "unsafe_gate");
    hostile(contract, baseline, "write performed", (draft) => { draft.localIntegrity.writesPerformed = 1; }, "unsafe_gate");
    hostile(contract, baseline, "release gate", (draft) => { draft.localIntegrity.releaseGateSatisfied = true; }, "unsafe_gate");
    hostile(contract, baseline, "local blocker missing", (draft) => { draft.localIntegrity.blockerCodes = []; }, "blocker_mismatch");
    hostile(contract, baseline, "asset missing", (draft) => { draft.localIntegrity.assets.pop(); }, "asset_mismatch");
    hostile(contract, baseline, "asset duplicate", (draft) => { draft.localIntegrity.assets.push(structuredClone(draft.localIntegrity.assets[0]!)); }, "asset_mismatch");
    hostile(contract, baseline, "asset bytes", (draft) => { draft.localIntegrity.assets[0]!.bytes += 1; }, "asset_mismatch");
    hostile(contract, baseline, "asset hash", (draft) => { draft.localIntegrity.assets[0]!.sha256 = "0".repeat(64); }, "asset_mismatch");
    hostile(contract, baseline, "asset kind", (draft) => { draft.localIntegrity.assets[0]!.kind = "internal"; }, "asset_mismatch");
    hostile(contract, baseline, "asset media", (draft) => { draft.localIntegrity.assets[0]!.mediaType = "application/octet-stream"; }, "asset_mismatch");
    hostile(contract, baseline, "asset integrity", (draft) => { draft.localIntegrity.assets[0]!.localIntegrity = "pending"; }, "asset_mismatch");

    hostile(contract, baseline, "shot missing", (draft) => { draft.shots.pop(); }, "coverage_mismatch");
    hostile(contract, baseline, "shot duplicate", (draft) => { draft.shots.push(structuredClone(draft.shots[0]!)); }, "coverage_mismatch");
    for (const key of ["nodeId", "shotId", "sceneId", "episodeId", "landingBeatId"] as const) {
      hostile(contract, baseline, `shot ${key}`, (draft) => { draft.shots[0]![key] = `${draft.shots[0]![key]}-drift`; }, "coverage_mismatch");
    }
    for (const key of ["specId", "inputFingerprint", "sourceContentHash", "taskId", "outputRef"] as const) {
      hostile(contract, baseline, `production ${key}`, (draft) => { draft.shots[0]!.production[key] = `${draft.shots[0]!.production[key]}-drift`; }, "production_spec_mismatch");
    }
    hostile(contract, baseline, "production status", (draft) => { draft.shots[0]!.production.status = "ready"; }, "production_spec_mismatch");
    hostile(contract, baseline, "production plan", (draft) => { draft.shots[0]!.production.planStatus = "ready"; }, "production_spec_mismatch");
    hostile(contract, baseline, "release compatible", (draft) => { draft.shots[0]!.production.releaseCompatible = true; }, "production_spec_mismatch");
    hostile(contract, baseline, "production execution", (draft) => { draft.shots[0]!.production.executionAllowed = true; }, "unsafe_gate");
    hostile(contract, baseline, "references prepared", (draft) => { draft.shots[0]!.production.referencesPrepared = true; }, "unsafe_gate");
    hostile(contract, baseline, "workflow pin", (draft) => { draft.shots[0]!.production.workflowPin = { templateId: "unsafe" }; }, "unsafe_gate");
    hostile(contract, baseline, "production blocker", (draft) => { draft.shots[0]!.production.blockerCodes = ["source_reference_not_prepared"]; }, "blocker_mismatch");

    hostile(contract, baseline, "row missing", (draft) => { draft.shots[0]!.rows.pop(); }, "row_mismatch");
    hostile(contract, baseline, "row duplicate", (draft) => { draft.shots[0]!.rows.push(structuredClone(draft.shots[0]!.rows[0]!)); }, "row_mismatch");
    hostile(contract, baseline, "row paragraph", (draft) => { draft.shots[0]!.rows[0]!.paragraphId = "P999"; }, "row_mismatch");
    hostile(contract, baseline, "row beat", (draft) => { draft.shots[0]!.rows[0]!.beatId = "wrong-beat"; }, "row_mismatch");
    hostile(contract, baseline, "row text", (draft) => { draft.shots[0]!.rows[0]!.publicText += " drift"; }, "row_mismatch");
    hostile(contract, baseline, "row self-consistent text drift", (draft) => {
      const row = draft.shots[0]!.rows[0]!;
      row.publicText += " drift";
      row.publicTextHash = hash(row.publicText);
      row.authorityTextHash = row.publicTextHash;
      row.charCount = Array.from(row.publicText).length;
    }, "row_mismatch");
    hostile(contract, baseline, "row authority hash", (draft) => { draft.shots[0]!.rows[0]!.authorityTextHash = "0".repeat(64); }, "row_mismatch");
    hostile(contract, baseline, "row next", (draft) => { draft.shots[0]!.rows[0]!.nextBeatId = "wrong"; }, "row_mismatch");
    hostile(contract, baseline, "row choice ids", (draft) => { draft.shots[0]!.rows.at(-1)!.choiceIds.pop(); }, "row_mismatch");

    hostile(contract, baseline, "choice missing", (draft) => { draft.shots[0]!.choices.pop(); }, "choice_mismatch");
    hostile(contract, baseline, "choice duplicate", (draft) => { draft.shots[0]!.choices.push(structuredClone(draft.shots[0]!.choices[0]!)); }, "choice_mismatch");
    hostile(contract, baseline, "choice target", (draft) => { draft.shots[0]!.choices[0]!.targetNodeId = "wrong"; }, "choice_mismatch");
    hostile(contract, baseline, "choice landing", (draft) => { draft.shots[0]!.choices[0]!.targetEntryBeatId = "wrong"; }, "choice_mismatch");
    hostile(contract, baseline, "choice provenance", (draft) => { draft.shots[2]!.choices[0]!.provenance = "explicit_choice"; }, "choice_mismatch");
    hostile(contract, baseline, "choice self-consistent label drift", (draft) => {
      const choice = draft.shots[0]!.choices[0]!;
      choice.label += " drift";
      choice.labelHash = hash(choice.label);
      choice.labelCharCount = Array.from(choice.label).length;
    }, "choice_mismatch");

    hostile(contract, baseline, "binding missing", (draft) => { draft.shots[0]!.bindings.pop(); }, "binding_mismatch");
    hostile(contract, baseline, "binding duplicate", (draft) => { draft.shots[0]!.bindings.push(structuredClone(draft.shots[0]!.bindings[0]!)); }, "binding_mismatch");
    hostile(contract, baseline, "binding role", (draft) => { draft.shots[0]!.bindings[0]!.role = "maid"; }, "binding_mismatch");
    hostile(contract, baseline, "binding asset", (draft) => { draft.shots[0]!.bindings[0]!.assetId = "vg11-char-face-reference"; }, "binding_mismatch");
    hostile(contract, baseline, "binding prepared", (draft) => { draft.shots[0]!.bindings[0]!.prepared = true; }, "unsafe_gate");

    hostile(contract, baseline, "root extra", (draft) => { Object.assign(draft, { unknown: true }); }, "input_invalid");
    hostile(contract, baseline, "root accessor", (draft) => { Object.defineProperty(draft, "unknown", { enumerable: true, get: () => true }); }, "input_invalid");
    hostile(contract, baseline, "shot prototype", (draft) => { Object.setPrototypeOf(draft.shots[0]!, { unsafe: true }); }, "coverage_mismatch");
    hostile(contract, baseline, "asset symbol", (draft) => { Reflect.defineProperty(draft.localIntegrity.assets[0]!, Symbol("unsafe"), { value: true, enumerable: true }); }, "asset_mismatch");
    hostile(contract, baseline, "array prototype", (draft) => { Object.setPrototypeOf(draft.shots, Object.create(Array.prototype)); }, "coverage_mismatch");
    hostile(contract, baseline, "prepared reference extra", (draft) => { Object.assign(draft.shots[0]!.bindings[0]!, { preparedReference: "unsafe" }); }, "binding_mismatch");

    const authorBytes = new Uint8Array(
      await readFile(
        path.join(
          "content",
          "case-studies",
          "virtual-girlfriend-20260727",
          "author-locked-v1.1",
          "virtual-girlfriend.author-locked.v1.1.story.json",
        ),
      ),
    );
    const driftIndex = authorBytes.length - 2;
    authorBytes[driftIndex] = authorBytes[driftIndex]! ^ 1;
    const authorityDrift = await server.readSteamLaunchReviewPacketForTest({
      testOnlyAuthorityBytes: { authorStory: authorBytes },
    });
    assert.equal(authorityDrift.status, "BLOCKED");
    if (authorityDrift.status !== "BLOCKED") throw new Error("authority_drift_not_blocked");
    assert.equal(authorityDrift.publicResult.failureCode, "authority_unavailable");
    assert.deepEqual(authorityDrift.publicResult.summary, {
      shots: 0,
      reviewRows: 0,
      choices: 0,
      referenceBindings: 0,
      uniqueAssets: 0,
    });

    const referenceServer = await import("../lib/steam/referencePreparationServer");
    const verifiedLocal = await referenceServer.readSteamReferencePreparation();
    assert.equal(verifiedLocal.status, "LOCAL_VERIFIED_ONLY");
    if (verifiedLocal.status !== "LOCAL_VERIFIED_ONLY") {
      throw new Error("p19_local_integrity_not_verified");
    }
    const extraLocalShot = structuredClone(verifiedLocal);
    extraLocalShot.shots.push(structuredClone(extraLocalShot.shots[0]!));
    const extraLocalResult = await server.readSteamLaunchReviewPacketForTest({
      testOnlyLocalIntegrity: extraLocalShot,
    });
    assert.equal(extraLocalResult.status, "BLOCKED");
    const wrongLocalIdentity = structuredClone(verifiedLocal);
    Object.assign(wrongLocalIdentity.shots[0]!, {
      sceneId: "VG11-WRONG",
      episodeId: "VG11-WRONG",
    });
    const wrongLocalResult = await server.readSteamLaunchReviewPacketForTest({
      testOnlyLocalIntegrity: wrongLocalIdentity,
    });
    assert.equal(wrongLocalResult.status, "BLOCKED");
    const wrongLocalAuthority = structuredClone(verifiedLocal);
    Object.assign(wrongLocalAuthority.authority, { caseId: "wrong-case", releaseVersion: "v0" });
    const wrongLocalAuthorityResult = await server.readSteamLaunchReviewPacketForTest({
      testOnlyLocalIntegrity: wrongLocalAuthority,
    });
    assert.equal(wrongLocalAuthorityResult.status, "BLOCKED");

    await assertStaticBoundary();
    assert.equal(networkCalls, 0);
    process.stdout.write(
      `steam launch review packet tests passed (3/23/5/12/6; fingerprint=${packet.packetFingerprint}; network=0; writes=0)\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
