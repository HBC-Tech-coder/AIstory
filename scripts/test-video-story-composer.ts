import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AdminActor } from "../lib/admin/types";
import { createVideoCompletionGate } from "../lib/sceneMedia";
import {
  compileVideoStoryRelease,
  validateVideoStoryDraft,
} from "../lib/video-stories/compiler";
import {
  createVideoStorySubtitleCue,
  deleteVideoStoryNode,
  duplicateVideoStoryNode,
  duplicateVideoStorySubtitleCue,
  moveVideoStoryItem,
  renameVideoStoryNode,
} from "../lib/video-stories/editor";
import { LocalVideoStoryRepository } from "../lib/video-stories/repository";
import {
  createVideoStoryDraft,
  copyVideoStoryDraft,
  readPublishedVideoStory,
  saveVideoStoryDraft,
  transitionVideoStoryDraft,
} from "../lib/video-stories/server";
import { resolveVideoStoryPreviewCompletion } from "../lib/video-stories/runtime";
import type {
  VideoStoryAssetProjection,
  VideoStoryDraft,
} from "../lib/video-stories/types";
import {
  LocalVideoAssetRepository,
  type StoredVideoAsset,
} from "../lib/video-assets/repository";

const root = await mkdtemp(path.join(os.tmpdir(), "aistory-video-story-"));
const storyRoot = path.join(root, "stories");
const assetRoot = path.join(root, "assets");
const repository = new LocalVideoStoryRepository(storyRoot);
const assetRepository = new LocalVideoAssetRepository(assetRoot);
const actor: AdminActor = {
  userId: "local-admin",
  roles: ["super_admin"],
  mode: "local",
};
const productionActor: AdminActor = {
  userId: "00000000-0000-4000-8000-000000000001",
  roles: ["super_admin"],
  mode: "production",
};
const now = () => new Date("2026-07-29T10:00:00.000Z");
const options = {
  repository,
  assetRepository,
  allowTestAdapter: true,
  now,
  randomId: () => "draft-1",
};

function storedAsset(
  id: string,
  projectId = 101,
  storyId = "story-video-1",
): StoredVideoAsset {
  const contentHash = createHash("sha256").update(id).digest("hex");
  return {
    id,
    tenantId: assetRepository.tenantId,
    contentHash,
    contentType: "video/mp4",
    bytes: 24,
    storage: {
      kind: "local",
      fileName: `${contentHash}.mp4`,
    },
    durationMs: 12_000,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: "aac",
    hasAudio: true,
    status: "publishable",
    releasePolicy: "public",
    projectId,
    storyId,
    nodeId: id.replace(/^asset-/, ""),
    title: id,
    subtitles: [
      {
        id: `${id}-cue-1`,
        startMs: 0,
        endMs: 2_000,
        text: "已审核字幕",
      },
    ],
    source: "upload",
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    reviewNote: "仅管理员可见，不得进入发布物",
  };
}

async function seedAsset(asset: StoredVideoAsset): Promise<void> {
  await assetRepository.create(
    asset,
    {
      key: `asset-seed:${asset.id}:0001`,
      fingerprint: `fingerprint:${asset.id}`,
      assetId: asset.id,
      operation: "upload",
      createdAt: now().toISOString(),
    },
    {
      id: `audit-${asset.id}`,
      actorId: actor.userId,
      action: "video_asset.approve",
      assetId: asset.id,
      reason: "测试资产",
      requestId: `request-${asset.id}`,
      createdAt: now().toISOString(),
    },
  );
}

function assetProjection(
  id: string,
  overrides: Partial<VideoStoryAssetProjection> = {},
): VideoStoryAssetProjection {
  return {
    id,
    projectId: 101,
    storyId: "story-video-1",
    status: "publishable",
    releasePolicy: "public",
    publicUrl: `/api/video-assets/${id}/content`,
    durationMs: 12_000,
    hasAudio: true,
    subtitles: [
      {
        id: `${id}-cue-1`,
        startMs: 0,
        endMs: 2_000,
        text: "第一句",
      },
    ],
    ...overrides,
  };
}

function validDraft(): VideoStoryDraft {
  return {
    schemaVersion: 1,
    id: "draft-1",
    projectId: 101,
    storyId: "story-video-1",
    title: "互动视频故事",
    summary: "确定性互动视频编排测试",
    version: "v1",
    revision: 2,
    orientation: "landscape",
    startNodeId: "start",
    releasePolicy: "public",
    status: "draft",
    variables: [
      {
        id: "trust",
        label: "信任",
        initialValue: 0,
        min: 0,
        max: 10,
      },
    ],
    nodes: [
      {
        nodeId: "start",
        title: "起点视频",
        assetId: "asset-start",
        allowSkip: true,
        endedBehavior: "choices",
        terminal: false,
        choices: [
          {
            id: "choose-left",
            label: "走左边",
            targetNodeId: "ending",
            conditions: [
              { variableId: "trust", operator: "gte", value: 0 },
            ],
            variableDelta: { trust: 1 },
          },
        ],
        releasePolicy: "public",
      },
      {
        nodeId: "ending",
        title: "终局视频",
        assetId: "asset-ending",
        allowSkip: false,
        endedBehavior: "hold",
        terminal: true,
        choices: [],
        releasePolicy: "public",
      },
    ],
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
}

try {
  const assets = [assetProjection("asset-start"), assetProjection("asset-ending")];
  assert.equal(validateVideoStoryDraft(validDraft(), assets).ok, true);

  const missingTarget = validDraft();
  missingTarget.nodes[0]!.choices[0]!.targetNodeId = "missing";
  assert.equal(validateVideoStoryDraft(missingTarget, assets).ok, false);
  assert.ok(
    validateVideoStoryDraft(missingTarget, assets).errors.some(
      (item) => item.code === "missing_choice_target",
    ),
  );

  const deadEnd = validDraft();
  deadEnd.nodes[0]!.choices = [];
  assert.ok(
    validateVideoStoryDraft(deadEnd, assets).errors.some(
      (item) => item.code === "dead_end",
    ),
  );

  const unreachable = validDraft();
  unreachable.nodes.push({
    nodeId: "orphan",
    title: "不可达节点",
    assetId: "asset-ending",
    allowSkip: true,
    endedBehavior: "hold",
    terminal: true,
    choices: [],
    releasePolicy: "public",
  });
  assert.ok(
    validateVideoStoryDraft(unreachable, assets).warnings.some(
      (item) => item.code === "unreachable_node",
    ),
  );
  assert.throws(
    () => compileVideoStoryRelease(unreachable, assets),
    /无法从起点到达/,
  );

  const invalidSubtitle = validDraft();
  invalidSubtitle.nodes[0]!.subtitles = [
    { id: "cue-1", startMs: 11_000, endMs: 13_000, text: "越界" },
  ];
  assert.ok(
    validateVideoStoryDraft(invalidSubtitle, assets).errors.some(
      (item) => item.code === "invalid_subtitle_timing",
    ),
  );
  const unsafeSubtitle = validDraft();
  unsafeSubtitle.nodes[0]!.subtitles = [
    {
      id: "cue-unsafe",
      startMs: 0,
      endMs: 1_000,
      text: "访问 https://unsafe.invalid/content",
    },
  ];
  assert.ok(
    validateVideoStoryDraft(unsafeSubtitle, assets).errors.some(
      (item) =>
        item.code === "unsafe_subtitle_content" && item.nodeId === "start",
    ),
  );

  const closedCycle = validDraft();
  closedCycle.nodes = [
    {
      ...closedCycle.nodes[0]!,
      choices: [{ id: "to-loop", label: "继续", targetNodeId: "loop" }],
    },
    {
      ...closedCycle.nodes[0]!,
      nodeId: "loop",
      title: "闭环",
      choices: [{ id: "to-start", label: "返回", targetNodeId: "start" }],
    },
  ];
  assert.ok(
    validateVideoStoryDraft(closedCycle, assets).errors.some(
      (item) => item.code === "non_terminating_cycle" && item.nodeId === "start",
    ),
  );

  const cue = createVideoStorySubtitleCue([], 12_000, 1_500);
  assert.deepEqual(cue, {
    id: "cue-1",
    startMs: 1_500,
    endMs: 3_500,
    text: "",
  });
  const copiedCues = duplicateVideoStorySubtitleCue(
    [{ ...cue, text: "原字幕", speaker: "角色" }],
    0,
    12_000,
  );
  assert.equal(copiedCues.length, 2);
  assert.equal(copiedCues[1]?.id, "cue-2");
  assert.equal(copiedCues[1]?.startMs, 3_500);
  assert.equal(copiedCues[1]?.text, "原字幕");
  assert.deepEqual(moveVideoStoryItem(["a", "b", "c"], 2, 0), [
    "c",
    "a",
    "b",
  ]);

  const renamed = renameVideoStoryNode(validDraft(), 1, "ending-renamed");
  assert.equal(renamed.nodes[0]?.choices[0]?.targetNodeId, "ending-renamed");
  const duplicated = duplicateVideoStoryNode(renamed, 0);
  assert.equal(duplicated.nodes.length, 3);
  assert.notEqual(duplicated.nodes[0]?.nodeId, duplicated.nodes[1]?.nodeId);
  const deleted = deleteVideoStoryNode(duplicated, 1);
  assert.equal(deleted.nodes.length, 2);

  assert.equal(
    validateVideoStoryDraft(validDraft(), [
      assetProjection("asset-start", { status: "review_pending" }),
      assetProjection("asset-ending"),
    ]).ok,
    false,
  );
  assert.equal(
    validateVideoStoryDraft(validDraft(), [
      assetProjection("asset-start", { projectId: 999 }),
      assetProjection("asset-ending"),
    ]).ok,
    false,
  );
  assert.equal(
    validateVideoStoryDraft(validDraft(), [
      assetProjection("asset-start", { releasePolicy: "internal" }),
      assetProjection("asset-ending"),
    ]).ok,
    false,
  );

  const compiledA = compileVideoStoryRelease(validDraft(), assets);
  const compiledB = compileVideoStoryRelease(
    structuredClone(validDraft()),
    structuredClone(assets),
  );
  assert.equal(compiledA.bytes, compiledB.bytes);
  assert.equal(
    compiledA.artifact.contentHash,
    compiledB.artifact.contentHash,
  );
  assert.equal(
    compiledA.artifact.bundle.session.authoredStory?.authorLocked,
    true,
  );
  assert.equal(
    compiledA.artifact.bundle.session.history[0]?.scene.media?.kind,
    "video",
  );
  assert.doesNotMatch(
    compiledA.bytes,
    /(storage|storageFile|objectKey|etag|reviewNote|providerTaskId|workflowId|actorId|localPath)/,
  );

  let completionCount = 0;
  const completionGate = createVideoCompletionGate(() => {
    completionCount += 1;
  });
  assert.equal(completionGate("skipped"), true);
  assert.equal(completionGate("completed"), false);
  assert.equal(completionGate("seeked"), false);
  assert.equal(completionCount, 1);
  const autoNode = {
    ...validDraft().nodes[0]!,
    endedBehavior: "advance" as const,
    endedTargetNodeId: "ending",
    endedVariableDelta: { trust: 2 },
    choices: [],
  };
  assert.deepEqual(
    resolveVideoStoryPreviewCompletion(autoNode, "skipped"),
    {
      nodeId: "start",
      completionReason: "skipped",
      targetNodeId: "ending",
      variableDelta: { trust: 2 },
    },
  );

  await seedAsset(storedAsset("asset-start"));
  await seedAsset(storedAsset("asset-ending"));
  const createInput = {
    id: "draft-1",
    projectId: 101,
    storyId: "story-video-1",
    title: "互动视频故事",
    summary: "确定性互动视频编排测试",
    version: "v1",
    orientation: "landscape",
    reason: "创建测试草稿",
    idempotencyKey: "video-story-create:test:0001",
    requestId: "request-create",
  };
  const concurrentCreates = await Promise.all(
    Array.from({ length: 4 }, () =>
      createVideoStoryDraft(actor, createInput, options),
    ),
  );
  assert.equal(concurrentCreates.filter((item) => item.created).length, 1);
  assert.equal(new Set(concurrentCreates.map((item) => item.draft.id)).size, 1);
  await assert.rejects(
    () =>
      createVideoStoryDraft(
        actor,
        { ...createInput, title: "不同语义" },
        options,
      ),
    /幂等键/,
  );
  await assert.rejects(
    () => createVideoStoryDraft(productionActor, createInput, options),
    /生产视频剧情仓储/,
  );
  const sourceDraft = validDraft();
  const saved = await saveVideoStoryDraft(
    actor,
    "draft-1",
    {
      title: sourceDraft.title,
      summary: sourceDraft.summary,
      version: sourceDraft.version,
      orientation: sourceDraft.orientation,
      startNodeId: sourceDraft.startNodeId,
      variables: sourceDraft.variables,
      nodes: sourceDraft.nodes,
      reason: "保存完整节点图",
      idempotencyKey: "video-story-save:test:000001",
      requestId: "request-save",
    },
    options,
  );
  assert.equal(saved.draft.revision, 2);
  await assert.rejects(
    () =>
      saveVideoStoryDraft(
        actor,
        "draft-1",
        {
          title: sourceDraft.title,
          summary: sourceDraft.summary,
          version: sourceDraft.version,
          orientation: sourceDraft.orientation,
          startNodeId: sourceDraft.startNodeId,
          variables: sourceDraft.variables,
          nodes: sourceDraft.nodes.map((node, index) =>
            index === 0
              ? {
                  ...node,
                  subtitles: [
                    {
                      id: "cue-leak",
                      startMs: 0,
                      endMs: 1_000,
                      text: "/home/private/output.mp4",
                    },
                  ],
                }
              : node,
          ),
          reason: "拒绝危险字幕",
          idempotencyKey: "video-story-save:unsafe:0001",
          requestId: "request-save-unsafe",
        },
        options,
      ),
    /URL 或本地路径/,
  );
  const copied = await copyVideoStoryDraft(
    actor,
    "draft-1",
    {
      id: "draft-copy",
      projectId: 101,
      storyId: "story-video-1",
      title: "互动视频故事副本",
      summary: "复制测试",
      version: "v1",
      orientation: "portrait",
      reason: "复制为独立草稿",
      idempotencyKey: "video-story-copy:test:000001",
      requestId: "request-copy",
    },
    options,
  );
  assert.equal(copied.draft.id, "draft-copy");
  assert.equal(copied.draft.status, "draft");
  assert.equal(copied.draft.nodes.length, 2);
  const submit = await transitionVideoStoryDraft(
    actor,
    "draft-1",
    {
      action: "submit_review",
      reason: "提交内容审核",
      idempotencyKey: "video-story-review:test:0001",
      requestId: "request-review",
    },
    options,
  );
  assert.equal(submit.draft.status, "review_pending");
  const published = await transitionVideoStoryDraft(
    actor,
    "draft-1",
    {
      action: "publish",
      reason: "审核通过并确定发布",
      idempotencyKey: "video-story-publish:test:001",
      requestId: "request-publish",
    },
    options,
  );
  assert.equal(published.draft.status, "published");
  assert.equal(published.release?.status, "published");
  const replayPublish = await transitionVideoStoryDraft(
    actor,
    "draft-1",
    {
      action: "publish",
      reason: "审核通过并确定发布",
      idempotencyKey: "video-story-publish:test:001",
      requestId: "request-publish",
    },
    options,
  );
  assert.equal(replayPublish.changed, false);
  assert.equal(
    replayPublish.release?.releaseId,
    published.release?.releaseId,
  );
  await assert.rejects(
    () =>
      transitionVideoStoryDraft(
        actor,
        "draft-1",
        {
          action: "publish",
          reason: "相同幂等键但不同语义",
          idempotencyKey: "video-story-publish:test:001",
          requestId: "request-publish-conflict",
        },
        options,
      ),
    /幂等键/,
  );

  const restarted = new LocalVideoStoryRepository(storyRoot);
  const publicRelease = await readPublishedVideoStory("story-video-1", {
    repository: restarted,
    allowTestAdapter: true,
  });
  assert.equal(publicRelease?.bundle.kind, "aistory-authored-case");
  assert.doesNotMatch(
    JSON.stringify(publicRelease),
    /(reviewNote|storage|storageFile|objectKey|etag|providerTaskId|workflowId|actorId|localPath)/,
  );

  const offline = await transitionVideoStoryDraft(
    actor,
    "draft-1",
    {
      action: "offline",
      reason: "下线公开版本",
      idempotencyKey: "video-story-offline:test:001",
      requestId: "request-offline",
    },
    options,
  );
  assert.equal(offline.draft.status, "offline");
  assert.equal(
    await readPublishedVideoStory("story-video-1", {
      repository: restarted,
      allowTestAdapter: true,
    }),
    null,
  );

  const routeSource = await readFile(
    path.join(
      process.cwd(),
      "app",
      "api",
      "admin",
      "video-stories",
      "[draftId]",
      "route.ts",
    ),
    "utf8",
  );
  assert.match(routeSource, /requireAdmin/);
  assert.match(routeSource, /assertTrustedLoopbackMutation/);
  assert.match(routeSource, /x-idempotency-key/i);
  const publicRouteSource = await readFile(
    path.join(
      process.cwd(),
      "app",
      "api",
      "video-stories",
      "[storyId]",
      "route.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    publicRouteSource,
    /(storage|storageFile|objectKey|etag|localPath|reviewNote|providerTaskId)/,
  );
  assert.match(publicRouteSource, /isLoopbackReadRequest/);

  const composerSource = await readFile(
    path.join(process.cwd(), "components", "AdminVideoStoryComposer.tsx"),
    "utf8",
  );
  assert.match(composerSource, /VideoStorySubtitleEditor/);
  assert.match(composerSource, /VideoStoryChoiceEditor/);
  assert.match(composerSource, /data-video-story-node/);
  assert.match(composerSource, /等待 Connector/);
  assert.doesNotMatch(composerSource, /字幕 cues（JSON）/);
  const structuredEditorSource = await readFile(
    path.join(process.cwd(), "components", "VideoStoryStructuredEditors.tsx"),
    "utf8",
  );
  for (const control of [
    "当前时间→起点",
    "当前时间→终点",
    "复制",
    "删除",
    "目标节点",
  ]) {
    assert.match(structuredEditorSource, new RegExp(control));
  }

  console.log("video story composer tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
