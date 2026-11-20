import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_SHARED_TITLE,
  DEFAULT_SHARED_VISIBILITY,
  MAX_SHARED_IMAGE_BYTES,
  SHARED_MEDIA_PATH_PATTERN,
  SharedStoryProjectionError,
  buildSharedStoryDocument,
  buildSharedStoryPostBody,
  isAllowedMediaUrl,
  parseSharedDocument,
  parseSharedList,
  parseSharedStoryDetail,
  parseSharedSummary,
  safeMediaUrl,
} from "../lib/shared-stories/clientProjection";
import {
  PUBLISHED_STATIC_MEDIA_PATHS,
  isPublishedStaticMediaUrl,
} from "../lib/shared-stories/publishedStaticMedia";
import { resolvePublishSubmission } from "../lib/shared-stories/publishPolicy";

type ProjectSession = NonNullable<
  Parameters<typeof buildSharedStoryDocument>[0]
>;

// Frozen contract media path: exactly 64 lowercase hex chars + raster extension.
const HEX_64 = "0123456789abcdef".repeat(4);
const VALID_MEDIA = `/api/aistory-cache/media/${HEX_64}.webp`;
const VALID_PNG = `/api/aistory-cache/media/${HEX_64}.png`;
const VALID_JPG = `/api/aistory-cache/media/${HEX_64}.jpg`;
const VALID_JPEG = `/api/aistory-cache/media/${HEX_64}.jpeg`;
const UPPERCASE_HEX = "A".repeat(64);
const SHORT_HEX = "a".repeat(63);
const LONG_HEX = "a".repeat(65);

// Normal preset first-scene sessions use the backend's published catalog.
const PRESET_IMAGE = "/home/firstscene/f0.webp";
const PRESET_IMAGE_M31 = "/home/firstscene/m31.webp";
const PRESET_PORTRAIT_IMAGE = "/home/firstscene-portrait/m29.webp";

const SMALL_PNG_DATA_URI =
  "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
const OVERSIZED_DATA_URI =
  "data:image/png;base64," +
  Buffer.alloc(MAX_SHARED_IMAGE_BYTES + 1, 1).toString("base64");

const SECRETS = [
  "SECRET_WORLD_SETTING",
  "SECRET_STYLE_GUIDE",
  "SECRET_STORY_STATE",
  "SECRET_NEXT_SCENE_SEED",
  "SECRET_PROMPT",
  "SECRET_CHOICE_PROMPT",
  "SECRET_OWNER_ID",
  "SECRET_VOICE",
  "SECRET_WORLD_BOOK",
  "SECRET_TIMELINE",
  "SECRET_SCENE_PROMPT",
  "SECRET_BEAT_PROPERTY",
  "SECRET_AUTHORED_STORY",
  "video-secret.mp4",
  "evil.example",
];

function makeSession(history: unknown[]): ProjectSession {
  return {
    id: "session-secret-id",
    createdAt: 1,
    worldSetting: "SECRET_WORLD_SETTING",
    styleGuide: "SECRET_STYLE_GUIDE",
    styleReferenceImage: SMALL_PNG_DATA_URI,
    storyState: { logline: "SECRET_STORY_STATE" },
    nextSceneSeed: "SECRET_NEXT_SCENE_SEED",
    prompts: { writer: "SECRET_PROMPT" },
    ownerId: "SECRET_OWNER_ID",
    characters: [
      { name: "甲", voiceDescription: "SECRET_VOICE", voice: { provider: "stepfun" } },
    ],
    worldBooks: [{ name: "SECRET_WORLD_BOOK" }],
    timeline: { marker: "SECRET_TIMELINE" },
    history,
  } as unknown as ProjectSession;
}

function setField(session: ProjectSession, key: string, value: unknown): void {
  (session as unknown as Record<string, unknown>)[key] = value;
}

function makeHistory(): unknown[] {
  return [
    {
      scene: {
        id: "scene-a",
        scenePrompt: "SECRET_SCENE_PROMPT",
        entryBeatId: "a2",
        imageUrl: VALID_MEDIA,
        ownerId: "SECRET_OWNER_ID",
        media: { kind: "image", url: VALID_PNG },
        beats: [
          {
            id: "a2",
            narration: "第二拍叙述",
            speaker: "甲",
            line: "第二拍台词",
            hiddenSecret: "SECRET_BEAT_PROPERTY",
            prompt: "SECRET_PROMPT",
            next: {
              type: "choice",
              prompt: "SECRET_CHOICE_PROMPT",
              choices: [
                {
                  id: "c-advance",
                  label: "前进",
                  ownerId: "SECRET_OWNER_ID",
                  effect: { kind: "advance-beat", targetBeatId: "a1" },
                },
                {
                  id: "c-scene",
                  label: "进入下一幕",
                  effect: {
                    kind: "change-scene",
                    nextSceneSeed: "SECRET_NEXT_SCENE_SEED",
                  },
                },
                {
                  id: "c-missing",
                  label: "未生成的后续",
                  effect: {
                    kind: "change-scene",
                    nextSceneSeed: "SECRET_NEXT_SCENE_SEED",
                  },
                },
                {
                  id: "c-prompt",
                  label: "坏目标",
                  effect: { kind: "advance-beat", targetBeatId: "missing-beat" },
                },
              ],
            },
          },
          {
            id: "a1",
            narration: "第一拍叙述",
            next: { type: "continue", nextBeatId: "a2" },
          },
        ],
      },
      visitedBeatIds: ["a2", "a1"],
      exit: {
        kind: "choice",
        choiceId: "c-scene",
        label: "进入下一幕",
        nextSceneSeed: "SECRET_NEXT_SCENE_SEED",
      },
      storyStateAfter: { logline: "SECRET_STORY_STATE" },
      ownerId: "SECRET_OWNER_ID",
    },
    {
      scene: {
        id: "scene-b",
        scenePrompt: "SECRET_SCENE_PROMPT_B",
        entryBeatId: "b1",
        imageUrl: VALID_MEDIA,
        beats: [
          {
            id: "b1",
            narration: "终幕",
            next: { type: "choice", choices: [] },
          },
        ],
      },
    },
  ];
}

function singleScene(scene: Record<string, unknown>): unknown[] {
  return [{ scene }];
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    assert.ok(
      allowed.includes(key),
      `${label} leaked unexpected key "${key}"`,
    );
  }
}

function assertProjectionError(run: () => unknown, pattern: RegExp): void {
  assert.throws(
    run,
    (error: unknown) => {
      assert.ok(error instanceof SharedStoryProjectionError, "not a projection error");
      assert.match(error.message, pattern);
      // User-facing Chinese copy only; no raw provider/exception text.
      assert.equal(/[A-Za-z]{6,}/.test(error.message), false);
      return true;
    },
  );
}

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`not ok - ${name}\n  ${message}`);
  }
}

test("document uses only v + scenes and preserves generated scene/beat order", () => {
  const doc = buildSharedStoryDocument(makeSession(makeHistory()));
  assert.equal(doc.v, 1);
  assert.deepEqual(Object.keys(doc).sort(), ["scenes", "v"]);
  assert.deepEqual(
    doc.scenes.map((scene) => scene.id),
    ["scene-a", "scene-b"],
  );
  assert.deepEqual(
    doc.scenes[0].beats.map((beat) => beat.id),
    ["a2", "a1"],
  );
  assert.equal(doc.scenes[0].entryBeatId, "a2");
  assert.equal(doc.scenes[1].entryBeatId, "b1");
  // The explicit image media URL wins over the legacy imageUrl.
  assert.equal(doc.scenes[0].imageUrl, VALID_PNG);
  assert.equal(doc.scenes[1].imageUrl, VALID_MEDIA);
});

test("projection strips session secrets, prompts, owner ids, voices and unknown fields", () => {
  const doc = buildSharedStoryDocument(makeSession(makeHistory()));
  const serialized = JSON.stringify(doc);
  for (const secret of SECRETS) {
    assert.equal(
      serialized.includes(secret),
      false,
      `public document leaked ${secret}`,
    );
  }
  assert.equal(serialized.includes('"ownerId"'), false);
  assert.equal(serialized.includes('"scenePrompt"'), false);
  assert.equal(serialized.includes('"session"'), false);
  assert.equal(serialized.includes('"worldSetting"'), false);
  assert.equal(serialized.includes('"storyState"'), false);

  assertAllowedKeys(doc as unknown as Record<string, unknown>, ["v", "scenes"], "doc");
  for (const scene of doc.scenes) {
    assertAllowedKeys(
      scene as unknown as Record<string, unknown>,
      ["id", "imageUrl", "entryBeatId", "beats"],
      "scene",
    );
    for (const beat of scene.beats) {
      assertAllowedKeys(
        beat as unknown as Record<string, unknown>,
        ["id", "narration", "speaker", "line", "next"],
        "beat",
      );
      if (beat.next.type === "choice") {
        for (const choice of beat.next.choices) {
          assertAllowedKeys(
            choice as unknown as Record<string, unknown>,
            ["id", "label", "target"],
            "choice",
          );
        }
      }
    }
  }
});

test("choice targets map only persisted, generated continuations", () => {
  const doc = buildSharedStoryDocument(makeSession(makeHistory()));
  const firstSceneBeats = doc.scenes[0].beats;
  const choiceBeat = firstSceneBeats.find((beat) => beat.id === "a2");
  assert.ok(choiceBeat && choiceBeat.next.type === "choice");
  const choices = choiceBeat.next.choices;
  const byId = new Map(choices.map((choice) => [choice.id, choice]));

  assert.deepEqual(byId.get("c-advance")?.target, {
    sceneId: "scene-a",
    beatId: "a1",
  });
  assert.deepEqual(byId.get("c-scene")?.target, {
    sceneId: "scene-b",
    beatId: "b1",
  });
  assert.equal(byId.get("c-missing")?.target, undefined);
  assert.equal(byId.get("c-prompt")?.target, undefined);
});

test("media allowlist is the exact published catalog plus strict media path or bounded raster data URI", () => {
  assert.match(SHARED_MEDIA_PATH_PATTERN.source, /0-9a-f\]\{64\}/);
  for (const url of [VALID_MEDIA, VALID_PNG, VALID_JPG, VALID_JPEG]) {
    assert.equal(isAllowedMediaUrl(url), true, `${url} should be allowed`);
  }
  assert.equal(isAllowedMediaUrl(SMALL_PNG_DATA_URI), true);

  // The backend-owned published static catalog is copied verbatim and stays
  // browser-safe exact-match only: no prefix, glob, case fold or extension
  // guessing.
  assert.equal(PUBLISHED_STATIC_MEDIA_PATHS.length, 122);
  for (const url of PUBLISHED_STATIC_MEDIA_PATHS) {
    assert.equal(isAllowedMediaUrl(url), true, `${url} should be allowed`);
  }
  for (const preset of [PRESET_IMAGE, PRESET_IMAGE_M31, PRESET_PORTRAIT_IMAGE]) {
    assert.equal(PUBLISHED_STATIC_MEDIA_PATHS.includes(preset), true);
    assert.equal(isAllowedMediaUrl(preset), true, `${preset} should be allowed`);
  }

  const rejected = [
    `/api/aistory-cache/media/scene-a.webp`,
    `/api/aistory-cache/media/${UPPERCASE_HEX}.png`,
    `/api/aistory-cache/media/${SHORT_HEX}.png`,
    `/api/aistory-cache/media/${LONG_HEX}.png`,
    `/api/aistory-cache/media/${HEX_64}.gif`,
    `/api/aistory-cache/media/${HEX_64}.png?x=1`,
    `/api/aistory-cache/media/${HEX_64}/../secret.png`,
    `/api/aistory-cache/media/../${HEX_64}.png`,
    `https://evil.example/${HEX_64}.png`,
    `//evil.example/${HEX_64}.png`,
    "data:image/svg+xml;base64,AAAA",
    OVERSIZED_DATA_URI,
    // Catalog look-alikes: absent numbers, wrong extension, case, query/hash,
    // encoded or traversal paths and relative forms are never allowed.
    "/home/firstscene/f30.webp",
    "/home/firstscene-portrait/m30.webp",
    "/home/firstscene/f0.png",
    "/home/firstscene/F0.webp",
    "/home/firstscene/f00.webp",
    "home/firstscene/f0.webp",
    "/home/firstscene/f0.webp/",
    "/home/firstscene/f0.webp?x=1",
    "/home/firstscene/f0.webp#x",
    "/home/firstscene/../firstscene/f0.webp",
    "/home/firstscene/%66%30.webp",
    42,
    null,
    undefined,
  ];
  for (const value of rejected) {
    assert.equal(isAllowedMediaUrl(value), false, `${String(value)} should be rejected`);
  }
  assert.equal(safeMediaUrl("https://evil.example/a.png"), null);
  assert.equal(safeMediaUrl(null), null);
  assert.equal(safeMediaUrl(VALID_MEDIA), VALID_MEDIA);
});

test("normal preset f0 session projects, posts and parses summary/detail catalog media", () => {
  const beat = {
    id: "p1",
    narration: "预设开场",
    next: { type: "continue", nextBeatId: "p1" },
  };
  const session = makeSession(
    singleScene({
      id: "scene-preset",
      entryBeatId: "p1",
      imageUrl: PRESET_IMAGE,
      beats: [beat],
    }),
  );

  const doc = buildSharedStoryDocument(session);
  assert.equal(doc.scenes.length, 1);
  assert.equal(doc.scenes[0].imageUrl, PRESET_IMAGE);

  const body = buildSharedStoryPostBody(session, "预设作品");
  assert.equal(body.visibility, "public");
  assert.equal(body.document.scenes[0].imageUrl, PRESET_IMAGE);

  const summaryBase = {
    id: "share-preset",
    title: "预设作品",
    visibility: "public",
    revision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sceneCount: 1,
  };

  // Same catalog path must survive the summary/list/detail parsers instead of
  // being rejected as external media (coverUrl is a plain nullable string).
  const f0Summary = parseSharedSummary({ ...summaryBase, coverUrl: PRESET_IMAGE });
  assert.ok(f0Summary);
  assert.equal(f0Summary.coverUrl, PRESET_IMAGE);

  const m31Summary = parseSharedSummary({ ...summaryBase, coverUrl: PRESET_IMAGE_M31 });
  assert.ok(m31Summary);
  assert.equal(m31Summary.coverUrl, PRESET_IMAGE_M31);

  const portraitSummary = parseSharedSummary({
    ...summaryBase,
    coverUrl: PRESET_PORTRAIT_IMAGE,
  });
  assert.ok(portraitSummary);
  assert.equal(portraitSummary.coverUrl, PRESET_PORTRAIT_IMAGE);

  const list = parseSharedList({
    items: [{ ...summaryBase, coverUrl: PRESET_IMAGE_M31 }],
    nextCursor: null,
  });
  assert.ok(list);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].coverUrl, PRESET_IMAGE_M31);

  const detail = parseSharedStoryDetail({
    ...summaryBase,
    coverUrl: PRESET_IMAGE,
    document: doc,
  });
  assert.ok(detail);
  assert.equal(detail.coverUrl, PRESET_IMAGE);
  assert.equal(detail.document.scenes[0].imageUrl, PRESET_IMAGE);

  // A normal preset scene is never re-encoded or rewritten.
  const parsedDocument = parseSharedDocument(doc);
  assert.ok(parsedDocument);
  assert.equal(parsedDocument.scenes[0].imageUrl, PRESET_IMAGE);

  // Unpublished look-alikes in the catalog namespace still throw, never blank.
  for (const imageUrl of [
    "/home/firstscene/f30.webp",
    "/home/firstscene-portrait/m30.webp",
    `/home/firstscene/../firstscene/${"f0".repeat(1)}.webp`,
  ]) {
    assertProjectionError(
      () =>
        buildSharedStoryDocument(
          makeSession(
            singleScene({
              id: "scene-preset-unknown",
              entryBeatId: "p1",
              imageUrl,
              beats: [beat],
            }),
          ),
        ),
      /图片/,
    );
  }
});

test("missing, invalid and external scene images throw (no blank fallback or skipped scene)", () => {
  const beat = { id: "b1", next: { type: "continue", nextBeatId: "b1" } };

  for (const imageUrl of [
    "https://evil.example/x.png",
    `/api/aistory-cache/media/scene-a.webp`,
    "",
    undefined,
  ]) {
    assertProjectionError(
      () =>
        buildSharedStoryDocument(
          makeSession(
            singleScene({
              id: "scene-bad-image",
              entryBeatId: "b1",
              imageUrl,
              beats: [beat],
            }),
          ),
        ),
      /图片/,
    );
  }

  assertProjectionError(
    () =>
      buildSharedStoryDocument(
        makeSession(
          singleScene({
            id: "scene-bad-media",
            entryBeatId: "b1",
            imageUrl: VALID_MEDIA,
            media: { kind: "image", url: "https://evil.example/x.png" },
            beats: [beat],
          }),
        ),
      ),
    /图片/,
  );

  // A malformed scene is rejected rather than silently skipped.
  assertProjectionError(
    () =>
      buildSharedStoryDocument(
        makeSession([
          { scene: { id: "scene-ok", entryBeatId: "b1", imageUrl: VALID_MEDIA, beats: [beat] } },
          { notAScene: true },
        ]),
      ),
    /剧情数据不完整/,
  );
});

test("scene media.kind=video throws and is never downgraded to the image snapshot", () => {
  const beat = { id: "v1", next: { type: "continue", nextBeatId: "v1" } };

  assertProjectionError(
    () =>
      buildSharedStoryDocument(
        makeSession(
          singleScene({
            id: "scene-video-only",
            entryBeatId: "v1",
            media: {
              kind: "video",
              url: `/api/aistory-cache/media/${HEX_64}.mp4`,
            },
            beats: [beat],
          }),
        ),
      ),
    /视频/,
  );

  // Even with a perfectly valid poster/legacy image, video must throw.
  assertProjectionError(
    () =>
      buildSharedStoryDocument(
        makeSession(
          singleScene({
            id: "scene-video-with-poster",
            entryBeatId: "v1",
            imageUrl: VALID_PNG,
            media: {
              kind: "video",
              url: `/api/aistory-cache/media/${HEX_64}.mp4`,
              posterUrl: VALID_PNG,
            },
            beats: [beat],
          }),
        ),
      ),
    /视频/,
  );

  assertProjectionError(
    () =>
      buildSharedStoryDocument(
        makeSession(
          singleScene({
            id: "scene-unknown-media",
            entryBeatId: "v1",
            media: { kind: "audio" },
            beats: [beat],
          }),
        ),
      ),
    /媒体类型/,
  );
});

test("authoredStory and any authorLocked are rejected before projection", () => {
  const authored = makeSession(makeHistory());
  setField(authored, "authoredStory", {
    caseStudyId: "SECRET_AUTHORED_STORY",
    authorLocked: false,
  });
  assertProjectionError(
    () => buildSharedStoryDocument(authored),
    /作者/,
  );

  const locked = makeSession(makeHistory());
  setField(locked, "timeline", {
    branches: [{ snapshot: { authoredStory: { authorLocked: true } } }],
  });
  assertProjectionError(() => buildSharedStoryDocument(locked), /作者/);

  // The authored check runs before image validation, so this reports 作者 not 图片.
  const authoredAndBadImage = makeSession(
    singleScene({
      id: "scene-bad",
      entryBeatId: "b1",
      imageUrl: "https://evil.example/x.png",
      beats: [{ id: "b1", next: { type: "continue", nextBeatId: "b1" } }],
    }),
  );
  setField(authoredAndBadImage, "authoredStory", { nodes: [] });
  assertProjectionError(() => buildSharedStoryDocument(authoredAndBadImage), /作者/);
});

test("POST body is the exact allowlist, defaults public, and never embeds the session", () => {
  const session = makeSession(makeHistory());
  const body = buildSharedStoryPostBody(session, "   ");
  assert.equal(DEFAULT_SHARED_VISIBILITY, "public");
  assert.equal(body.title, DEFAULT_SHARED_TITLE);
  assert.equal(body.visibility, "public");
  assert.deepEqual(Object.keys(body).sort(), [
    "document",
    "sourceId",
    "title",
    "visibility",
  ]);
  assert.equal(body.sourceId, "session-secret-id");
  assert.equal("session" in body, false);
  assert.equal("worldSetting" in body, false);
  assert.equal(
    JSON.stringify(body).includes("SECRET_WORLD_SETTING"),
    false,
  );
  const serialized = JSON.stringify(body);
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret), false, `POST body leaked ${secret}`);
  }

  const hidden = buildSharedStoryPostBody(session, "隐藏作品", "hidden");
  assert.equal(hidden.visibility, "hidden");
  assert.equal(hidden.title, "隐藏作品");
});

test("publish policy aborts unknown/login lookups and keeps existing hidden state", () => {
  // Unknown owner lookup MUST abort; nothing is submitted.
  assert.deepEqual(
    resolvePublishSubmission({ status: "unknown" }, "public", false),
    { type: "abort", reason: "unknown" },
  );
  assert.deepEqual(
    resolvePublishSubmission({ status: "login" }, "hidden", true),
    { type: "abort", reason: "login" },
  );

  // Brand-new work always submits explicit visibility, including hidden.
  const newPublic = resolvePublishSubmission({ status: "missing" }, "public", false);
  assert.deepEqual(newPublic, {
    type: "submit",
    visibility: "public",
    includeVisibility: true,
  });
  const newHidden = resolvePublishSubmission({ status: "missing" }, "hidden", false);
  assert.deepEqual(newHidden, {
    type: "submit",
    visibility: "hidden",
    includeVisibility: true,
  });

  // Existing hidden work + untouched default-public select: omit visibility.
  const hiddenExisting = resolvePublishSubmission(
    { status: "found", item: { visibility: "hidden", revision: 7 } },
    "public",
    false,
  );
  assert.deepEqual(hiddenExisting, {
    type: "submit",
    visibility: "hidden",
    includeVisibility: false,
    expectedRevision: 7,
  });

  // Explicit user change sends the new visibility with the known revision.
  const toPublic = resolvePublishSubmission(
    { status: "found", item: { visibility: "hidden", revision: 7 } },
    "public",
    true,
  );
  assert.deepEqual(toPublic, {
    type: "submit",
    visibility: "public",
    includeVisibility: true,
    expectedRevision: 7,
  });
});

test("summary parser accepts coverUrl null per backend and drops owner internals", () => {
  const base = {
    id: "share-1",
    title: "公开作品",
    visibility: "public",
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    sceneCount: 2,
  };

  const nullCover = parseSharedSummary({
    ...base,
    coverUrl: null,
    sourceId: "source-1",
    ownerId: "SECRET_OWNER_ID",
    secret: "SECRET_STORY_STATE",
  });
  assert.ok(nullCover);
  assert.equal(nullCover.coverUrl, null);
  assert.equal(nullCover.sourceId, "source-1");
  assert.equal("ownerId" in nullCover, false);
  assert.equal("secret" in nullCover, false);
  assertAllowedKeys(
    nullCover as unknown as Record<string, unknown>,
    [
      "id",
      "title",
      "visibility",
      "revision",
      "createdAt",
      "updatedAt",
      "sceneCount",
      "coverUrl",
      "sourceId",
    ],
    "summary",
  );

  const validCover = parseSharedSummary({ ...base, coverUrl: VALID_MEDIA });
  assert.ok(validCover);
  assert.equal(validCover.coverUrl, VALID_MEDIA);

  // Missing / non-contract cover strings are rejected, never blanked.
  assert.equal(parseSharedSummary({ ...base }), null);
  assert.equal(
    parseSharedSummary({ ...base, coverUrl: "https://evil.example/x.png" }),
    null,
  );
  assert.equal(parseSharedSummary({ ...base, coverUrl: null, visibility: "private" }), null);
  assert.equal(parseSharedSummary({ ...base, coverUrl: null, revision: -1 }), null);
});

test("list parser handles cursor, null covers and invalid items safely", () => {
  const summary = {
    id: "share-1",
    title: "公开作品",
    visibility: "public",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sceneCount: 1,
    coverUrl: null,
  };
  const parsed = parseSharedList({
    items: [summary, { bad: true }, { ...summary, coverUrl: "https://evil.example/a.png" }],
    nextCursor: "cursor-2",
  });
  assert.ok(parsed);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].coverUrl, null);
  assert.equal(parsed.nextCursor, "cursor-2");
  assert.equal(parseSharedList({ items: "nope" }), null);
  assert.equal(parseSharedList(null), null);
});

test("detail parser accepts the DIRECT contract shape and rejects invalid scene images", () => {
  const document = buildSharedStoryDocument(makeSession(makeHistory()));
  const detail = {
    id: "share-1",
    title: "公开作品",
    visibility: "public",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sceneCount: document.scenes.length,
    coverUrl: null,
    document,
  };
  const parsed = parseSharedStoryDetail(detail);
  assert.ok(parsed);
  assert.equal(parsed.document.scenes.length, 2);
  assert.equal(parsed.coverUrl, null);
  assert.equal(parseSharedStoryDetail({ story: detail }), null);
  assert.equal(parseSharedStoryDetail({ item: detail }), null);

  const badDocument = {
    ...document,
    scenes: document.scenes.map((scene, index) =>
      index === 0 ? { ...scene, imageUrl: "https://evil.example/x.png" } : scene,
    ),
  };
  assert.equal(parseSharedStoryDetail({ ...detail, document: badDocument }), null);
});

test("document parser sanitizes injected fields and rejects invalid/missing images", () => {
  const contaminated = {
    v: 1,
    secretTop: "SECRET_STORY_STATE",
    scenes: [
      {
        id: "z",
        imageUrl: VALID_MEDIA,
        entryBeatId: "z1",
        ownerId: "SECRET_OWNER_ID",
        secretScene: "SECRET_SCENE_PROMPT",
        beats: [
          {
            id: "z1",
            narration: "n",
            secretBeat: "SECRET_BEAT_PROPERTY",
            next: {
              type: "choice",
              secretNext: "SECRET_NEXT_SCENE_SEED",
              choices: [
                {
                  id: "k1",
                  label: "l",
                  prompt: "SECRET_CHOICE_PROMPT",
                  target: { sceneId: "missing", beatId: "x" },
                },
              ],
            },
          },
          {
            id: "z2",
            line: "l2",
            next: { type: "continue", nextBeatId: "z1" },
          },
        ],
      },
      {
        id: "a",
        imageUrl: VALID_PNG,
        entryBeatId: "a1",
        beats: [
          { id: "a1", narration: "a", next: { type: "continue", nextBeatId: "a1" } },
        ],
      },
    ],
  };
  const parsed = parseSharedDocument(contaminated);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.scenes.map((scene) => scene.id),
    ["z", "a"],
  );
  assert.deepEqual(
    parsed.scenes[0].beats.map((beat) => beat.id),
    ["z1", "z2"],
  );
  assert.equal(parsed.scenes[0].imageUrl, VALID_MEDIA);
  assert.equal(parsed.scenes[1].imageUrl, VALID_PNG);
  const serialized = JSON.stringify(parsed);
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret), false, `parsed doc leaked ${secret}`);
  }
  const choiceBeat = parsed.scenes[0].beats[0];
  assert.ok(choiceBeat.next.type === "choice");
  assert.equal(choiceBeat.next.choices[0].target, undefined);

  // Scene image is mandatory: invalid and missing both reject the response.
  assert.equal(
    parseSharedDocument({
      ...contaminated,
      scenes: [{ ...contaminated.scenes[0], imageUrl: "https://evil.example/x.png" }],
    }),
    null,
  );
  assert.equal(
    parseSharedDocument({
      ...contaminated,
      scenes: [{ ...contaminated.scenes[0], imageUrl: undefined }],
    }),
    null,
  );
  // entryBeatId must point at a real beat in the same scene.
  assert.equal(
    parseSharedDocument({
      ...contaminated,
      scenes: [{ ...contaminated.scenes[0], entryBeatId: "missing" }],
    }),
    null,
  );
});

test("publish panel validates before POST, aborts unknown lookup and has no login route", () => {
  const source = readFileSync(
    path.join(process.cwd(), "components", "SharedStoryPublishPanel.tsx"),
    "utf8",
  );
  assert.equal(source.includes("useEffect"), false);
  assert.equal(source.includes("createStoryShareDoc"), false);
  assert.equal(source.includes("/api/tts"), false);
  assert.equal(source.includes("beat-audio"), false);
  assert.equal(source.includes("dangerouslySetInnerHTML"), false);
  assert.equal(source.includes('method: "POST"'), true);
  assert.equal(source.includes("expectedRevision"), true);
  assert.equal(source.includes("保存后所有人可见，可改为隐藏"), true);
  assert.equal(source.includes("DEFAULT_SHARED_TITLE"), true);
  assert.equal(source.includes("onClick={() => void handleSave()}"), true);
  assert.equal(source.includes("SharedStoryProjectionError"), true);
  assert.equal(source.includes("resolvePublishSubmission"), true);
  assert.equal(source.includes("submission.type === \"abort\""), true);
  assert.equal(source.includes("网络异常，保存结果未知"), true);
  assert.equal(source.includes("/login"), false);
  assert.equal(source.includes("返回首页登录"), true);
  // Internal keyed reset so a pending request for one session cannot land in
  // another session's state.
  assert.equal(source.includes("const sessionKey = session?.id ?? \"no-session\""), true);
  assert.equal(source.includes("key={sessionKey}"), true);

  const abortIndex = source.indexOf("submission.type === \"abort\"");
  const postIndex = source.indexOf('method: "POST"');
  assert.ok(abortIndex >= 0, "abort branch missing");
  assert.ok(postIndex > abortIndex, "POST must appear after the abort branch");
});

test("reader has real beat anchors, strict images and no generation/engine references", () => {
  const source = readFileSync(
    path.join(process.cwd(), "components", "SharedStoryReader.tsx"),
    "utf8",
  );
  const forbidden = [
    "nextSceneSeed",
    "createStoryShareDoc",
    "storyState",
    "worldSetting",
    "styleGuide",
    "worldBooks",
    "timeline",
    "/api/scene",
    "/api/start",
    "/api/beat-audio",
    "/api/tts",
    "/api/export",
    "dangerouslySetInnerHTML",
    "autoPlay",
    "<video",
    'preload="auto"',
    "/login",
  ];
  for (const term of forbidden) {
    assert.equal(source.includes(term), false, `reader references ${term}`);
  }
  assert.equal(source.includes("parseSharedStoryDetail"), true);
  assert.equal(source.includes("该作品不存在，或已被作者设为隐藏。"), true);
  assert.equal(source.includes("function beatAnchorId"), true);
  assert.equal(source.includes("id={beatAnchorId(sceneIndex, beatIndex)}"), true);
  assert.equal(source.includes("id={sceneAnchorId(sceneIndex)}"), true);
  assert.equal(source.includes("href={targetHref}"), true);
  assert.equal(source.includes("disabled"), true);
  assert.equal(source.includes("该选项的后续内容未生成"), true);
  // No silent blank-image fallback.
  assert.equal(source.includes("本幕没有可用的公开图片"), false);
  assert.equal(source.includes("isAllowedMediaUrl"), true);
});

test("library uses mine tab, same-origin no-store fetch, AbortController and locale paths", () => {
  const source = readFileSync(
    path.join(process.cwd(), "components", "SharedStoryLibrary.tsx"),
    "utf8",
  );
  assert.equal(source.includes('params.set("mine", "1")'), true);
  assert.equal(source.includes('credentials: "same-origin"'), true);
  assert.equal(source.includes('cache: "no-store"'), true);
  assert.equal(source.includes("AbortController"), true);
  assert.equal(source.includes("useLocalePath"), true);
  assert.equal(source.includes("expectedRevision"), true);
  assert.equal(source.includes("dangerouslySetInnerHTML"), false);
  assert.equal(source.includes("ownerId"), false);
  assert.equal(source.includes("/login"), false);
  assert.equal(source.includes("返回首页登录"), true);
});

test("page wrappers are default-export-only and await Next 16 params", () => {
  const community = readFileSync(
    path.join(process.cwd(), "app", "[locale]", "community", "page.tsx"),
    "utf8",
  );
  assert.equal(community.includes("export default function CommunityPage"), true);
  assert.equal(community.includes("SharedStoryLibrary"), true);

  const shared = readFileSync(
    path.join(process.cwd(), "app", "[locale]", "shared", "[id]", "page.tsx"),
    "utf8",
  );
  assert.equal(shared.includes("export default async function SharedStoryPage"), true);
  assert.equal(shared.includes("params: Promise<{ locale: string; id: string }>"), true);
  assert.equal(shared.includes("await params"), true);
  assert.equal(shared.includes("SharedStoryReader"), true);
  assert.equal(shared.includes("generateMetadata"), false);
  assert.equal(shared.includes("generateStaticParams"), false);
});

test("integration.patch is a real apply_patch against the two reference pages", () => {
  const patch = readFileSync(
    path.join(process.cwd(), "integration.patch"),
    "utf8",
  );
  assert.equal(patch.startsWith("*** Begin Patch"), true);
  assert.equal(patch.includes("*** Update File: app/[locale]/page.tsx"), true);
  assert.equal(patch.includes("*** Update File: app/[locale]/play/page.tsx"), true);
  assert.equal(patch.includes("*** End Patch"), true);
  assert.equal(patch.includes('href={lp("/community")}'), true);
  assert.equal(patch.includes("共享故事社区"), true);
  // Both entrances: the mobile md:hidden wrapper and the desktop header.
  assert.equal(patch.includes('<div className="md:hidden">'), true);
  assert.equal(patch.includes("<MobileDreamFrameApp />"), true);
  assert.equal(patch.includes('href={lp("/worldline")}'), true);
  assert.equal(patch.includes("SharedStoryPublishPanel"), true);
  assert.equal(patch.includes("key={session.id}"), true);
  assert.equal(patch.includes("/login"), false);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} shared-story UI checks passed.`);
}
