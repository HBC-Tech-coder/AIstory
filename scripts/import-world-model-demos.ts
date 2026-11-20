import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { CaseStudyPublishedBundle } from "@/lib/case-studies/schema";
import type {
  AuthoredStoryNode,
  Beat,
  Scene,
  Session,
  StoryState,
} from "@infiplot/types";
import {
  getWorldModelDemo,
  WORLD_MODEL_DEMOS,
  type WorldModelDemo,
  worldModelVideoAssetPath,
} from "@/lib/world-model-demos/catalog";

const WORKSPACE = path.resolve(import.meta.dirname, "..");
const SOURCE_ROOT = "D:\\AI-story\\movie";
const PRIVATE_SOURCE_ROOT = path.join(
  WORKSPACE,
  "content",
  "world-model-demos",
  "source",
);
const PUBLIC_ROOT = path.join(WORKSPACE, "public", "case-studies");

const SOURCE_FILES: Readonly<Record<string, { fileName: string; posterAt: number }>> = {
  "world-model-anime-sunset": {
    fileName: "二次元第一视角互动.mp4",
    posterAt: 18,
  },
  "world-model-close-encounter": {
    fileName: "男频第一视角互动.mp4",
    posterAt: 28,
  },
  "world-model-midnight-heartbeat": {
    fileName: "女频肢体互动.mp4",
    posterAt: 22,
  },
  "world-model-little-chef": {
    fileName: "喂狗互动第一视角.mp4",
    posterAt: 14,
  },
  "world-model-forest-friend": {
    fileName: "野外丛林的互动.mp4",
    posterAt: 32,
  },
};

function runFfmpeg(args: string[]): void {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
    cwd: WORKSPACE,
    encoding: "utf8",
    stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function sha256(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

function videoScene(demo: WorldModelDemo, choices: Beat["next"]): Scene {
  return {
    id: `${demo.id}:video`,
    scenePrompt: `世界模型第一视角互动演示：${demo.title}`,
    entryBeatId: `${demo.id}:after-video`,
    sceneKey: demo.id,
    imageUrl: demo.posterUrl,
    orientation: "landscape",
    media: {
      kind: "video",
      url: demo.videoUrl,
      posterUrl: demo.posterUrl,
      durationMs: demo.durationMs,
      hasAudio: true,
      endBehavior: "unlock-interaction",
      allowSkip: true,
      hotspotsEnabled: false,
    },
    beats: [
      {
        id: `${demo.id}:after-video`,
        narration: demo.followUp,
        next: choices,
      },
    ],
  };
}

function endingNode(
  demo: WorldModelDemo,
  choice: WorldModelDemo["choices"][number],
): AuthoredStoryNode {
  const nodeId = `${demo.id}:${choice.id}`;
  return {
    nodeId,
    sourceSceneId: `${choice.id}-ending`,
    title: choice.label,
    kind: "ending",
    episodeId: "world-model-demo",
    sourceParagraphIds: [`${demo.id}:${choice.id}`],
    releasePolicy: "public",
    scene: {
      id: `${nodeId}:scene`,
      scenePrompt: `世界模型互动演示结尾：${choice.label}`,
      entryBeatId: `${nodeId}:beat`,
      sceneKey: `${demo.id}-ending`,
      imageUrl: demo.posterUrl,
      orientation: "landscape",
      media: { kind: "image", url: demo.posterUrl },
      beats: [
        {
          id: `${nodeId}:beat`,
          narration: choice.outcome,
          next: { type: "choice", choices: [] },
        },
      ],
    },
  };
}

function makeBundle(demo: WorldModelDemo): CaseStudyPublishedBundle {
  const choiceBeatNext: Beat["next"] = {
    type: "choice",
    choices: demo.choices.map((choice) => ({
      id: `${demo.id}:${choice.id}:choice`,
      label: `【选项】${choice.label}`,
      effect: {
        kind: "change-scene",
        nextSceneSeed: `author-locked:${demo.id}:${choice.id}`,
        authoredTargetNodeId: `${demo.id}:${choice.id}`,
      },
    })),
  };
  const firstScene = videoScene(demo, choiceBeatNext);
  const storyState: StoryState = {
    logline: demo.followUp,
    genreTags: "世界模型 / 第一视角 / 互动视频 / 作者锁定",
    protagonist: "你以第一人称进入一段世界模型生成的影像，并在结尾决定故事下一步。",
    castNotes: "演示角色与动物仅用于本地作者锁定互动，不触发模型续写。",
    synopsis: demo.summary,
    openThreads: [demo.followUp],
    relationships: [],
    nextHook: "视频结束后，由玩家选择下一步。",
  };
  const firstNode: AuthoredStoryNode = {
    nodeId: `${demo.id}:start`,
    sourceSceneId: `${demo.id}-video`,
    title: demo.title,
    kind: "video",
    episodeId: "world-model-demo",
    sourceParagraphIds: [`${demo.id}:video`],
    releasePolicy: "public",
    scene: firstScene,
  };
  const nodes = [
    firstNode,
    ...demo.choices.map((choice) => endingNode(demo, choice)),
  ];
  const session: Session = {
    id: `case:${demo.id}`,
    createdAt: 1_786_320_000_000,
    worldSetting: demo.summary,
    styleGuide: "世界模型生成的第一视角视频，保持原片画面与声音。",
    history: [
      {
        scene: firstScene,
        visitedBeatIds: [firstScene.entryBeatId],
        storyStateAfter: storyState,
      },
    ],
    characters: [],
    storyState,
    orientation: "landscape",
    language: "zh-CN",
    cacheIdentity: {
      visibility: "public",
      storyId: `case:${demo.id}`,
      templateId: demo.id,
      version: "world-model-demo-v1",
    },
    authoredStory: {
      caseStudyId: demo.id,
      version: "author-locked-world-model-demo-v1",
      authorLocked: true,
      releasePolicy: {
        defaultAccess: "public",
        restrictedNodeIds: [],
      },
      currentNodeId: firstNode.nodeId,
      currentBeatId: firstScene.entryBeatId,
      visitedNodeIds: [firstNode.nodeId],
      variables: {},
      variableDefinitions: [],
      nodes,
    },
  };
  return {
    schemaVersion: 1,
    kind: "aistory-authored-case",
    card: {
      id: demo.id,
      gender:
        demo.id === "world-model-midnight-heartbeat" ? "女性向" : "男性向",
      index: 0,
      title: demo.title,
      outline: demo.summary,
      style: "世界模型生成 · 第一视角互动演示",
      tags: ["世界模型生成", "第一视角演示", "作者锁定"],
      coverPath: demo.posterUrl,
      playPath: demo.playPath,
      assetStatus: "ready",
      active: true,
    },
    session,
    assetSummary: { generated: 2, pending: 0, failed: 0 },
  };
}

async function importDemo(demo: WorldModelDemo) {
  const source = SOURCE_FILES[demo.id];
  if (!source) throw new Error(`Missing source mapping for ${demo.id}`);
  if (getWorldModelDemo(demo.id) !== demo) {
    throw new Error(`Catalog identity mismatch for ${demo.id}`);
  }

  const sourcePath = path.join(SOURCE_ROOT, source.fileName);
  const privateCopyPath = path.join(PRIVATE_SOURCE_ROOT, source.fileName);
  const assetDir = path.join(PUBLIC_ROOT, demo.id, "assets");
  const videoPath = path.join(assetDir, "demo.mp4");
  const posterPath = path.join(assetDir, "poster.jpg");
  const storyPath = path.join(PUBLIC_ROOT, demo.id, "story.json");
  await mkdir(PRIVATE_SOURCE_ROOT, { recursive: true });
  await mkdir(assetDir, { recursive: true });
  await copyFile(sourcePath, privateCopyPath);

  runFfmpeg([
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    "scale=1280:-2:flags=lanczos",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "23",
    "-maxrate",
    "5M",
    "-bufsize",
    "10M",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    videoPath,
  ]);
  runFfmpeg([
    "-ss",
    String(source.posterAt),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:-2:flags=lanczos",
    "-q:v",
    "2",
    posterPath,
  ]);
  await writeFile(
    storyPath,
    `${JSON.stringify(makeBundle(demo), null, 2)}\n`,
    "utf8",
  );

  return {
    id: demo.id,
    source: {
      fileName: source.fileName,
      bytes: (await stat(sourcePath)).size,
      sha256: await sha256(sourcePath),
    },
    privateCopy: {
      relativePath: path.relative(WORKSPACE, privateCopyPath),
      bytes: (await stat(privateCopyPath)).size,
      sha256: await sha256(privateCopyPath),
    },
    publicVideo: {
      url: worldModelVideoAssetPath(demo.id),
      bytes: (await stat(videoPath)).size,
      sha256: await sha256(videoPath),
    },
    poster: {
      url: demo.posterUrl,
      bytes: (await stat(posterPath)).size,
      sha256: await sha256(posterPath),
    },
  };
}

async function main() {
  const imported = [];
  for (const demo of WORLD_MODEL_DEMOS) {
    console.log(`[world-model-demo] importing ${demo.id}`);
    imported.push(await importDemo(demo));
  }
  const manifestPath = path.join(
    WORKSPACE,
    "content",
    "world-model-demos",
    "import-manifest.json",
  );
  const publicReleaseManifestPath = path.join(
    WORKSPACE,
    "lib",
    "world-model-demos",
    "release-manifest.json",
  );
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    publicReleaseManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        derivatives: imported.map(({ id, publicVideo }) => ({
          id,
          publicVideo,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        importedAt: new Date().toISOString(),
        sourceRootLabel: "Founder-provided local world-model demo movies",
        derivatives: imported,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`[world-model-demo] imported ${imported.length} demos`);
}

await main();
