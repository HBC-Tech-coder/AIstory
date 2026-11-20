import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  deriveSteamVideoProductionPlan,
  escapeSteamVideoProductionPlanCsvCell,
  serializeSteamVideoProductionPlanCsv,
  serializeSteamVideoProductionPlanJson,
  STEAM_VIDEO_PRODUCTION_PLAN_STAGES,
  type DeriveSteamVideoProductionPlanInput,
  type SteamVideoProductionPlanAssetSnapshot,
  type SteamVideoProductionPlanJobSnapshot,
  type SteamVideoProductionPlanNodeInput,
} from "../lib/steam/productionPlan";
import { readSteamVideoProductionPlan } from "../lib/steam/productionPlanServer";
import { GET as getProductionPlan } from "../app/api/steam/video-production-plan/route";

const PUBLIC_STORY = path.resolve(
  "public/case-studies/virtual-girlfriend-20260727/story.json",
);
const STEAM_PAGE = path.resolve("app/[locale]/steam/page.tsx");
const STUDIO_PAGE = path.resolve("app/[locale]/studio/page.tsx");
const STUDIO_SHELL = path.resolve("components/CreatorStudioShell.tsx");

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("network_forbidden");
}) as typeof fetch;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function input(
  overrides: Partial<DeriveSteamVideoProductionPlanInput> = {},
): DeriveSteamVideoProductionPlanInput {
  const nodes: SteamVideoProductionPlanNodeInput[] = [
    {
      ordinal: 0,
      nodeId: "node-a",
      sceneId: "scene-a",
      episodeId: "episode-a",
      releasePolicy: "public",
      sourceContentHash: hash("node-a"),
      sourceAvailable: true,
    },
    {
      ordinal: 1,
      nodeId: "node-b",
      sceneId: "scene-b",
      episodeId: "episode-a",
      releasePolicy: "public",
      sourceContentHash: hash("node-b"),
      sourceAvailable: true,
    },
  ];
  return {
    observedAt: "2026-08-14T00:00:00.000Z",
    designation: {
      status: "designated",
      caseId: "virtual-girlfriend-20260727",
      storyId: "case:virtual-girlfriend-20260727",
      version: "author-locked-v1.1",
      projectRef: "case-study:virtual-girlfriend-20260727",
      sourceGraphHash: hash("virtual-girlfriend-author-locked-v1.1"),
      evidence: ["steam_default_case", "public_author_locked_bundle"],
    },
    nodes,
    jobs: [],
    assets: [],
    capabilities: {
      enabledOriginalVideoTemplateCount: 1,
      enabledUpscaleTemplateCount: 1,
      subtitleAudioAttach: true,
    },
    ...overrides,
  };
}

function asset(
  nodeId: string,
  overrides: Partial<SteamVideoProductionPlanAssetSnapshot> = {},
): SteamVideoProductionPlanAssetSnapshot {
  return {
    assetId: `asset-${nodeId}`,
    storyId: "case:virtual-girlfriend-20260727",
    nodeId,
    status: "draft",
    releasePolicy: "public",
    hasAudio: true,
    subtitleCount: 1,
    ...overrides,
  };
}

function job(
  idempotencyKey: string,
  overrides: Partial<SteamVideoProductionPlanJobSnapshot> = {},
): SteamVideoProductionPlanJobSnapshot {
  return {
    jobId: `job-${hash(idempotencyKey).slice(0, 8)}`,
    idempotencyKey,
    provider: "comfyui",
    modality: "video",
    status: "queued",
    exactWorkflowPin: true,
    artifactAvailable: false,
    ...overrides,
  };
}

function assertNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of [
    "prompt",
    "workflowid",
    "workflowjson",
    "providertask",
    "idempotencykey",
    "localpath",
    "objectkey",
    "checkpoint",
    "lora",
    "token",
    "secret",
    "cookie",
    "authorization",
    "sourceparagraph",
    "sceneprompt",
    "beats",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

try {
  const first = deriveSteamVideoProductionPlan(input());
  const second = deriveSteamVideoProductionPlan(input());
  assert.deepEqual(first, second, "the same snapshot must derive byte-stable data");
  assert.equal(first.tasks.length, 10);
  assert.deepEqual(
    first.batches.map((batch) => batch.stage),
    STEAM_VIDEO_PRODUCTION_PLAN_STAGES,
  );
  assert.equal(new Set(first.tasks.map((task) => task.taskId)).size, 10);
  assert.equal(first.tasks.every((task) => task.taskId.length <= 160), true);
  const otherStory = deriveSteamVideoProductionPlan(
    input({
      designation: {
        status: "designated",
        caseId: "other-case",
        storyId: "case:other-case",
        version: "v1",
        projectRef: "case-study:other-case",
        sourceGraphHash: hash("other-case-v1"),
        evidence: ["steam_default_case", "public_author_locked_bundle"],
      },
      nodes: [input().nodes[0]!],
    }),
  );
  assert.notEqual(first.tasks[0]!.taskId, otherStory.tasks[0]!.taskId);
  for (const nodeId of ["node-a", "node-b"]) {
    const tasks = first.tasks.filter((task) => task.nodeId === nodeId);
    assert.equal(tasks.length, 5);
    const original = tasks.find((task) => task.stage === "original_video")!;
    const upscale = tasks.find((task) => task.stage === "upscale")!;
    const attach = tasks.find((task) => task.stage === "subtitle_audio_attach")!;
    assert.notEqual(original.taskId, upscale.taskId);
    assert.notEqual(original.outputRef, upscale.outputRef);
    assert.deepEqual(upscale.dependencies, [original.taskId]);
    assert.deepEqual(attach.dependencies, [original.taskId]);
    assert.deepEqual(attach.optionalDependencies, [upscale.taskId]);
  }

  const blockedDesignation = deriveSteamVideoProductionPlan(
    input({
      designation: {
        status: "blocked",
        blockedReason: "release_story_not_designated",
        candidates: [],
      },
    }),
  );
  assert.equal(blockedDesignation.tasks.length, 0);
  assert.equal(blockedDesignation.designation.status, "blocked");

  const missing = deriveSteamVideoProductionPlan(
    input({ nodes: [{ ...input().nodes[0]!, sourceAvailable: false }] }),
  );
  assert.equal(missing.tasks[0]!.status, "missing_source");
  assert.equal(missing.tasks.slice(1).every((task) => task.status === "blocked"), true);

  const noWorkflow = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      capabilities: {
        enabledOriginalVideoTemplateCount: 0,
        enabledUpscaleTemplateCount: 0,
        subtitleAudioAttach: false,
      },
    }),
  );
  assert.deepEqual(noWorkflow.tasks[0]!.blockerCodes, ["workflow_capability_missing"]);

  const queuedBase = deriveSteamVideoProductionPlan(
    input({ nodes: [input().nodes[0]!] }),
  );
  const originalId = queuedBase.tasks[0]!.taskId;
  const queued = deriveSteamVideoProductionPlan(
    input({ nodes: [input().nodes[0]!], jobs: [job(originalId)] }),
  );
  assert.equal(queued.tasks[0]!.status, "queued");
  const unrelated = deriveSteamVideoProductionPlan(
    input({ nodes: [input().nodes[0]!], jobs: [job("unrelated-task")] }),
  );
  assert.equal(unrelated.tasks[0]!.status, "ready");
  const unpinned = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      jobs: [job(originalId, { exactWorkflowPin: false })],
    }),
  );
  assert.deepEqual(unpinned.tasks[0]!.blockerCodes, ["workflow_pin_missing"]);
  const wrongModality = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      jobs: [job(originalId, { modality: "image" })],
    }),
  );
  assert.deepEqual(wrongModality.tasks[0]!.blockerCodes, ["job_stage_mismatch"]);
  const lanLab = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      jobs: [
        job(originalId, {
          provider: "gpu-connector-lan",
          taskType: "generate",
          releaseClassification: "non_publishable",
        }),
      ],
    }),
  );
  assert.deepEqual(lanLab.tasks[0]!.blockerCodes, ["non_publishable_job"]);

  const roleBase = deriveSteamVideoProductionPlan(
    input({ nodes: [input().nodes[0]!] }),
  );
  const roleOriginalId = roleBase.tasks[0]!.taskId;
  const roleUpscaleId = roleBase.tasks[1]!.taskId;
  const roleJobs = [
    job(roleOriginalId, {
      jobId: "job-role-original",
      taskType: "generate",
      status: "succeeded",
      artifactAvailable: true,
    }),
    job(roleUpscaleId, {
      jobId: "job-role-upscale",
      taskType: "upscale",
      status: "succeeded",
      artifactAvailable: true,
    }),
  ];
  const roleSeparated = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      jobs: roleJobs,
      assets: [
        asset("node-a", {
          assetId: "asset-role-original",
          generationJobId: "job-role-original",
        }),
        asset("node-a", {
          assetId: "asset-role-upscale",
          generationJobId: "job-role-upscale",
        }),
      ],
    }),
  );
  assert.equal(roleSeparated.tasks[0]!.status, "generated");
  assert.equal(roleSeparated.tasks[1]!.status, "generated");
  assert.equal(roleSeparated.tasks[2]!.status, "generated");
  assert.equal(
    roleSeparated.tasks.some((task) =>
      task.blockerCodes.includes("ambiguous_asset_binding"),
    ),
    false,
  );

  const selectedUpscalePending = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      assets: [asset("node-a")],
      jobs: [job(roleUpscaleId, { taskType: "upscale" })],
    }),
  );
  assert.equal(selectedUpscalePending.tasks[1]!.status, "queued");
  assert.deepEqual(selectedUpscalePending.tasks[2]!.blockerCodes, [
    "dependency_not_ready",
  ]);

  const upscaleOnly = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      jobs: [roleJobs[1]!],
      assets: [
        asset("node-a", {
          assetId: "asset-upscale-only",
          generationJobId: "job-role-upscale",
        }),
      ],
    }),
  );
  assert.equal(upscaleOnly.tasks[0]!.status, "ready");
  assert.notEqual(upscaleOnly.tasks[0]!.status, "generated");

  const reviewed = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      assets: [asset("node-a", { status: "review_pending" })],
    }),
  );
  assert.equal(reviewed.tasks[0]!.status, "generated");
  assert.equal(reviewed.tasks[2]!.status, "generated");
  assert.equal(reviewed.tasks[3]!.status, "review_pending");
  assert.equal(reviewed.tasks[4]!.status, "blocked");

  const published = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      assets: [asset("node-a", { status: "publishable" })],
    }),
  );
  assert.equal(published.tasks[3]!.status, "approved");
  assert.equal(published.tasks[4]!.status, "published");
  const publishCannotBypassAttach = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      assets: [
        asset("node-a", {
          status: "publishable",
          hasAudio: false,
          subtitleCount: 0,
        }),
      ],
      capabilities: {
        enabledOriginalVideoTemplateCount: 1,
        enabledUpscaleTemplateCount: 0,
        subtitleAudioAttach: false,
      },
    }),
  );
  assert.equal(publishCannotBypassAttach.tasks[2]!.status, "blocked");
  assert.equal(publishCannotBypassAttach.tasks[3]!.status, "blocked");
  assert.equal(publishCannotBypassAttach.tasks[4]!.status, "blocked");
  const privatePolicy = deriveSteamVideoProductionPlan(
    input({
      nodes: [input().nodes[0]!],
      assets: [
        asset("node-a", {
          status: "publishable",
          releasePolicy: "internal",
        }),
      ],
    }),
  );
  assert.deepEqual(privatePolicy.tasks[4]!.blockerCodes, ["release_policy_not_public"]);

  const hostile = deriveSteamVideoProductionPlan(
    input({
      nodes: [
        {
          ...input().nodes[0]!,
          nodeId: "=cmd|' /C calc'!A0",
        },
      ],
    }),
  );
  assert.equal(hostile.designation.status, "blocked");

  const csvFormulaPlan = deriveSteamVideoProductionPlan(
    input({
      designation: {
        status: "designated",
        caseId: "case-safe",
        storyId: "formula",
        version: "v1",
        projectRef: "case-study:case-safe",
        sourceGraphHash: hash("case-safe-v1"),
        evidence: ["steam_default_case", "public_author_locked_bundle"],
      },
      nodes: [input().nodes[0]!],
    }),
  );
  assert.equal(csvFormulaPlan.designation.status, "designated");
  assert.match(
    serializeSteamVideoProductionPlanCsv(csvFormulaPlan),
    /"formula"/,
  );
  assert.equal(escapeSteamVideoProductionPlanCsvCell("=1+1").charCodeAt(1), 39);

  const json = serializeSteamVideoProductionPlanJson(published);
  const csv = serializeSteamVideoProductionPlanCsv(published);
  assert.deepEqual(JSON.parse(json), published);
  assert.match(csv, /^"taskId","projectRef","storyId"/);
  assertNoSecrets(published);
  assertNoSecrets(json);
  assertNoSecrets(csv);

  const publicStory = JSON.parse(await readFile(PUBLIC_STORY, "utf8")) as {
    session: {
      cacheIdentity: { storyId: string; templateId: string; version: string };
      authoredStory: { nodes: Array<{ nodeId: string; releasePolicy: string }> };
    };
  };
  assert.equal(publicStory.session.cacheIdentity.storyId, "case:virtual-girlfriend-20260727");
  assert.equal(publicStory.session.cacheIdentity.templateId, "virtual-girlfriend-20260727");
  assert.equal(publicStory.session.cacheIdentity.version, "author-locked-v1.1");
  assert.equal(publicStory.session.authoredStory.nodes.length, 7);
  assert.equal(
    publicStory.session.authoredStory.nodes.every((node) => node.releasePolicy === "public"),
    true,
  );
  const authoritative = await readSteamVideoProductionPlan();
  assert.equal(authoritative.designation.status, "designated");
  assert.equal(authoritative.tasks.length, 35);
  assert.equal(new Set(authoritative.tasks.map((task) => task.nodeId)).size, 7);
  assert.equal(authoritative.summary.missing_source, 4);
  const steamPage = await readFile(STEAM_PAGE, "utf8");
  assert.match(steamPage, /STEAM_LAUNCH_CASE_ID/);
  const studioPage = await readFile(STUDIO_PAGE, "utf8");
  const studioShell = await readFile(STUDIO_SHELL, "utf8");
  assert.match(studioPage, /CREATOR_STUDIO_MODULES\.some/);
  assert.match(studioPage, /initialModule=\{initialModule\}/);
  assert.match(studioShell, /activeModule === "steam-video-plan"/);
  const remoteResponse = await getProductionPlan(
    new Request("http://evil.example/api/steam/video-production-plan", {
      headers: { host: "evil.example" },
    }),
  );
  assert.equal(remoteResponse.status, 404);
  assert.deepEqual(await remoteResponse.json(), { error: "Not found" });
  assert.equal(networkCalls, 0);
  console.log("Steam video production plan tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
