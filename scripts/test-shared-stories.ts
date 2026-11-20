import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMediaValidator,
  validateMediaUrl,
} from "../lib/shared-stories/media";
import {
  PUBLISHED_STATIC_MEDIA_PATHS,
  isPublishedStaticMediaUrl,
} from "../lib/shared-stories/publishedStaticMedia";
import {
  assertSameOriginMutation,
  handleCreateSharedStory,
  handleGetSharedStory,
  handleListSharedStories,
  handlePatchSharedStory,
} from "../lib/shared-stories/http";
import { SharedStoriesRepository } from "../lib/shared-stories/repository";
import {
  SharedStoriesService,
  createSharedStoriesServiceFromEnv,
} from "../lib/shared-stories/service";
import {
  SharedStoriesError,
  type SharedDocumentV1,
  type SharedNext,
  type SharedOwner,
} from "../lib/shared-stories/types";
import { validateDocumentStructure } from "../lib/shared-stories/validation";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz3W6QAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_DATA_URL.split(",")[1]!, "base64");
// Minimal bytes carrying a real WebP container signature (RIFF....WEBP).
const TINY_WEBP_BYTES = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1");

const OWNER_A: SharedOwner = { userId: "owner-a", authType: "phone" };
const OWNER_B: SharedOwner = { userId: "owner-b", authType: "aiuser" };

const allowAllMedia = async (): Promise<void> => undefined;

function sampleDocument(
  overrides: {
    imageUrl?: string;
    narration?: string;
    next?: SharedNext;
  } = {},
): SharedDocumentV1 {
  return {
    v: 1,
    scenes: [
      {
        id: "scene-1",
        imageUrl: overrides.imageUrl ?? TINY_PNG_DATA_URL,
        entryBeatId: "beat-1",
        beats: [
          {
            id: "beat-1",
            narration: overrides.narration ?? "The beginning",
            next:
              overrides.next ??
              {
                type: "choice",
                choices: [
                  {
                    id: "choice-1",
                    label: "Continue",
                    target: { sceneId: "scene-1", beatId: "beat-2" },
                  },
                ],
              },
          },
          {
            id: "beat-2",
            line: "The end",
            next: { type: "continue", nextBeatId: "beat-1" },
          },
        ],
      },
    ],
  };
}

async function expectDomainError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SharedStoriesError, "expected SharedStoriesError");
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

function isDomainError(code: string, status?: number) {
  return (error: unknown): boolean =>
    error instanceof SharedStoriesError &&
    error.code === code &&
    (status === undefined || error.status === status);
}

async function withService(
  run: (context: {
    dir: string;
    repository: SharedStoriesRepository;
    service: SharedStoriesService;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "aistory-shared-stories-"));
  try {
    const repository = new SharedStoriesRepository(dir, {
      validateMedia: allowAllMedia,
    });
    const service = new SharedStoriesService({
      repository,
      validateMedia: allowAllMedia,
    });
    await run({ dir, repository, service });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mutationRequest(url: string, body: unknown, method = "POST"): Request {
  const parsed = new URL(url);
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: parsed.origin,
      host: parsed.host,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

test("new stories default to public and DTOs do not leak sourceId", async () => {
  await withService(async ({ service }) => {
    const created = await service.createStory(OWNER_A, {
      sourceId: "case-default",
      title: "A shared story",
      document: sampleDocument(),
    });
    assert.equal(created.created, true);
    assert.equal(created.story.visibility, "public");
    assert.equal(created.story.revision, 1);
    assert.equal(Object.hasOwn(created.story, "sourceId"), false);

    const publicStory = await service.getPublicStory(created.story.id);
    assert.ok(publicStory);
    assert.equal(publicStory.document.v, 1);
    assert.equal(publicStory.document.scenes[0]?.beats.length, 2);
    assert.equal(Object.hasOwn(publicStory, "sourceId"), false);
    assert.equal(Object.hasOwn(publicStory, "ownerKey"), false);

    const publicList = await service.listPublic();
    assert.equal(publicList.items.length, 1);
    assert.equal(publicList.nextCursor, null);
    assert.equal(Object.hasOwn(publicList.items[0]!, "sourceId"), false);

    const mine = await service.listMine(OWNER_A);
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0]?.sourceId, "case-default");

    const otherMine = await service.listMine(OWNER_B);
    assert.equal(otherMine.items.length, 0);
  });
});

test("hidden stories are public-404 and visibility omission preserves hidden", async () => {
  await withService(async ({ service }) => {
    const created = await service.createStory(OWNER_A, {
      sourceId: "hidden-case",
      title: "Hidden",
      visibility: "hidden",
      document: sampleDocument(),
    });
    assert.equal(created.story.visibility, "hidden");
    assert.equal(await service.getPublicStory(created.story.id), null);
    assert.equal((await service.listPublic()).items.length, 0);

    const mine = await service.listMine(OWNER_A);
    assert.equal(mine.items[0]?.visibility, "hidden");

    const updated = await service.createStory(OWNER_A, {
      sourceId: "hidden-case",
      title: "Hidden",
      expectedRevision: 1,
      document: sampleDocument({ narration: "Updated hidden content" }),
    });
    assert.equal(updated.story.revision, 2);
    assert.equal(updated.story.visibility, "hidden");
    assert.equal(await service.getPublicStory(created.story.id), null);

    const published = await service.updateVisibility(OWNER_A, created.story.id, {
      visibility: "public",
      expectedRevision: 2,
    });
    assert.equal(published.visibility, "public");
    assert.equal(published.revision, 3);
    assert.ok(await service.getPublicStory(created.story.id));
  });
});

test("owner B cannot mutate or read owner A's hidden story", async () => {
  await withService(async ({ service }) => {
    const created = await service.createStory(OWNER_A, {
      sourceId: "owner-a",
      title: "Owned by A",
      visibility: "hidden",
      document: sampleDocument(),
    });
    await expectDomainError(
      service.updateVisibility(OWNER_B, created.story.id, {
        visibility: "public",
        expectedRevision: 1,
      }),
      "not_found",
      404,
    );
    assert.equal(await service.getPublicStory(created.story.id), null);
    assert.equal((await service.listMine(OWNER_B)).items.length, 0);

    const same = await service.updateVisibility(OWNER_A, created.story.id, {
      visibility: "hidden",
      expectedRevision: 1,
    });
    assert.equal(same.revision, 1);
  });
});

test("repeating identical POST input is idempotent", async () => {
  await withService(async ({ service }) => {
    const body = {
      sourceId: "idempotent-case",
      title: "Same input",
      document: sampleDocument(),
    };
    const first = await service.createStory(OWNER_A, body);
    const second = await service.createStory(OWNER_A, body);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.story.id, first.story.id);
    assert.equal(second.story.revision, 1);
    assert.equal((await service.listPublic()).items.length, 1);
  });
});

test("changed content requires the correct expectedRevision", async () => {
  await withService(async ({ service }) => {
    const created = await service.createStory(OWNER_A, {
      sourceId: "conflict-case",
      title: "Conflict",
      document: sampleDocument(),
    });
    await expectDomainError(
      service.createStory(OWNER_A, {
        sourceId: "conflict-case",
        title: "Conflict",
        document: sampleDocument({ narration: "Changed without revision" }),
      }),
      "revision_required",
      409,
    );
    await expectDomainError(
      service.createStory(OWNER_A, {
        sourceId: "conflict-case",
        title: "Conflict",
        expectedRevision: 99,
        document: sampleDocument({ narration: "Changed with wrong revision" }),
      }),
      "revision_conflict",
      409,
    );
    const updated = await service.createStory(OWNER_A, {
      sourceId: "conflict-case",
      title: "Conflict",
      expectedRevision: 1,
      document: sampleDocument({ narration: "Correct revision" }),
    });
    assert.equal(updated.story.revision, 2);
    assert.equal(updated.created, false);
    assert.equal(created.story.revision, 1);
  });
});

test("separate repository instances serialize concurrent stores and revisions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aistory-shared-concurrent-"));
  try {
    const firstService = new SharedStoriesService({
      repository: new SharedStoriesRepository(dir, { validateMedia: allowAllMedia }),
      validateMedia: allowAllMedia,
    });
    const secondService = new SharedStoriesService({
      repository: new SharedStoriesRepository(dir, { validateMedia: allowAllMedia }),
      validateMedia: allowAllMedia,
    });

    const results = await Promise.all([
      firstService.createStory(OWNER_A, {
        sourceId: "concurrent-a",
        title: "Concurrent A",
        visibility: "hidden",
        document: sampleDocument(),
      }),
      secondService.createStory(OWNER_A, {
        sourceId: "concurrent-b",
        title: "Concurrent B",
        visibility: "hidden",
        document: sampleDocument({ narration: "B" }),
      }),
    ]);
    assert.deepEqual(
      results.map((result) => result.created),
      [true, true],
    );

    const storyId = results[0].story.id;
    const settled = await Promise.allSettled([
      firstService.updateVisibility(OWNER_A, storyId, {
        visibility: "public",
        expectedRevision: 1,
      }),
      secondService.updateVisibility(OWNER_A, storyId, {
        visibility: "public",
        expectedRevision: 1,
      }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof SharedStoriesError);
    assert.equal(rejected[0]!.reason.code, "revision_conflict");

    const mine = await firstService.listMine(OWNER_A);
    const row = mine.items.find((story) => story.id === storyId);
    assert.equal(row?.revision, 2);
    assert.equal(row?.visibility, "public");

    const repeated = await firstService.updateVisibility(OWNER_A, storyId, {
      visibility: "public",
      expectedRevision: 2,
    });
    assert.equal(repeated.revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupted state fails closed and is never reset", async () => {
  await withService(async ({ dir, service }) => {
    const created = await service.createStory(OWNER_A, {
      sourceId: "corrupt-case",
      title: "Corrupt",
      document: sampleDocument(),
    });
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, "{not-json", "utf8");

    const secondRepository = new SharedStoriesRepository(dir, {
      validateMedia: allowAllMedia,
    });
    await expectDomainError(secondRepository.getStory(created.story.id), "store_corrupt", 503);
    await expectDomainError(
      secondRepository.createStory({
        ownerKey: "a".repeat(64),
        sourceId: "other",
        title: "Other",
        document: sampleDocument(),
      }),
      "store_corrupt",
      503,
    );
    assert.equal(await readFile(stateFile, "utf8"), "{not-json");
  });
});

test("production store is disabled without the exact enable flag and absolute root", async () => {
  const mode = process.env.AISTORY_SHARED_STORIES_MODE;
  const root = process.env.AISTORY_SHARED_STORIES_ROOT;
  try {
    delete process.env.AISTORY_SHARED_STORIES_MODE;
    delete process.env.AISTORY_SHARED_STORIES_ROOT;
    assert.throws(
      () => createSharedStoriesServiceFromEnv(),
      (error: unknown) =>
        error instanceof SharedStoriesError &&
        error.code === "disabled" &&
        error.status === 503,
    );

    process.env.AISTORY_SHARED_STORIES_MODE = "memory";
    assert.throws(
      () => createSharedStoriesServiceFromEnv(),
      (error: unknown) => error instanceof SharedStoriesError && error.code === "disabled",
    );

    process.env.AISTORY_SHARED_STORIES_MODE = "filesystem-v1";
    process.env.AISTORY_SHARED_STORIES_ROOT = "relative/root";
    assert.throws(
      () => createSharedStoriesServiceFromEnv(),
      (error: unknown) => error instanceof SharedStoriesError && error.code === "disabled",
    );
  } finally {
    if (mode === undefined) delete process.env.AISTORY_SHARED_STORIES_MODE;
    else process.env.AISTORY_SHARED_STORIES_MODE = mode;
    if (root === undefined) delete process.env.AISTORY_SHARED_STORIES_ROOT;
    else process.env.AISTORY_SHARED_STORIES_ROOT = root;
  }
});

test("unknown fields, malformed markup, dangling references, and limits are rejected", async () => {
  await withService(async ({ service }) => {
    await expectDomainError(
      service.createStory(OWNER_A, {
        sourceId: "unknown",
        title: "Unknown",
        document: sampleDocument(),
        authoredStory: { text: "secret" },
      }),
      "invalid_request",
      400,
    );
    await expectDomainError(
      service.createStory(OWNER_A, {
        sourceId: "unknown-nested",
        title: "Unknown nested",
        document: {
          ...sampleDocument(),
          prompts: ["do not share"],
        },
      }),
      "invalid_request",
      400,
    );
    await expectDomainError(
      service.createStory(OWNER_A, {
        sourceId: "x".repeat(201),
        title: "Too long",
        document: sampleDocument(),
      }),
      "invalid_request",
      400,
    );
    await expectDomainError(
      service.createStory(OWNER_A, {
        sourceId: "markup",
        title: "<script>alert(1)</script>",
        document: sampleDocument(),
      }),
      "invalid_request",
      400,
    );
  });

  assert.throws(
    () =>
      validateDocumentStructure({
        v: 1,
        scenes: [
          {
            id: "scene-1",
            imageUrl: TINY_PNG_DATA_URL,
            entryBeatId: "beat-1",
            beats: [
              {
                id: "beat-1",
                next: { type: "continue", nextBeatId: "missing-beat" },
              },
            ],
          },
        ],
      }),
    (error: unknown) => error instanceof SharedStoriesError,
  );

  assert.throws(
    () =>
      validateDocumentStructure({
        v: 1,
        scenes: [
          {
            id: "scene-1",
            imageUrl: TINY_PNG_DATA_URL,
            entryBeatId: "beat-1",
            beats: [
              {
                id: "beat-1",
                next: {
                  type: "choice",
                  choices: [
                    {
                      id: "choice-1",
                      label: "Missing scene",
                      target: { sceneId: "scene-missing", beatId: "beat-1" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    (error: unknown) => error instanceof SharedStoriesError,
  );

  assert.throws(
    () => validateDocumentStructure(documentWithSceneCount(201)),
    (error: unknown) => error instanceof SharedStoriesError,
  );
  assert.throws(
    () => validateDocumentStructure(documentWithBeatCount(1001)),
    (error: unknown) => error instanceof SharedStoriesError,
  );
  assert.throws(
    () => validateDocumentStructure(documentWithChoiceCount(21)),
    (error: unknown) => error instanceof SharedStoriesError,
  );
});

test("beat and choice ids are unique per scene and per beat, and scenes are required", () => {
  // Ordinary sessions reuse "b1" and "c1" in every scene/beat.
  const twoScenes = {
    v: 1,
    scenes: [
      {
        id: "scene-a",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "b1",
        beats: [{ id: "b1", next: { type: "continue", nextBeatId: "b1" } }],
      },
      {
        id: "scene-b",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "b1",
        beats: [{ id: "b1", next: { type: "continue", nextBeatId: "b1" } }],
      },
    ],
  };
  assert.doesNotThrow(() => validateDocumentStructure(twoScenes));

  const twoChoiceBeats = {
    v: 1,
    scenes: [
      {
        id: "scene-1",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "b1",
        beats: [
          {
            id: "b1",
            next: {
              type: "choice",
              choices: [
                { id: "c1", label: "First", target: { sceneId: "scene-1", beatId: "b2" } },
              ],
            },
          },
          {
            id: "b2",
            next: {
              type: "choice",
              choices: [
                { id: "c1", label: "Second", target: { sceneId: "scene-1", beatId: "b1" } },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => validateDocumentStructure(twoChoiceBeats));

  const duplicateChoiceInBeat = {
    v: 1,
    scenes: [
      {
        id: "scene-1",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "b1",
        beats: [
          {
            id: "b1",
            next: {
              type: "choice",
              choices: [
                { id: "c1", label: "First", target: { sceneId: "scene-1", beatId: "b1" } },
                { id: "c1", label: "Second", target: { sceneId: "scene-1", beatId: "b1" } },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => validateDocumentStructure(duplicateChoiceInBeat),
    isDomainError("invalid_request", 400),
  );

  const duplicateBeatInScene = {
    v: 1,
    scenes: [
      {
        id: "scene-1",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "b1",
        beats: [
          { id: "b1", next: { type: "continue", nextBeatId: "b1" } },
          { id: "b1", next: { type: "continue", nextBeatId: "b1" } },
        ],
      },
    ],
  };
  assert.throws(
    () => validateDocumentStructure(duplicateBeatInScene),
    isDomainError("invalid_request", 400),
  );

  assert.throws(
    () => validateDocumentStructure({ v: 1, scenes: [] }),
    isDomainError("invalid_request", 400),
  );
});

function documentWithSceneCount(count: number): unknown {
  return {
    v: 1,
    scenes: Array.from({ length: count }, (_, index) => ({
      id: `scene-${index}`,
      imageUrl: TINY_PNG_DATA_URL,
      entryBeatId: `beat-${index}`,
      beats: [
        {
          id: `beat-${index}`,
          next: { type: "continue", nextBeatId: `beat-${index}` },
        },
      ],
    })),
  };
}

function documentWithBeatCount(count: number): unknown {
  return {
    v: 1,
    scenes: [
      {
        id: "scene-1",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "beat-0",
        beats: Array.from({ length: count }, (_, index) => ({
          id: `beat-${index}`,
          next: { type: "continue", nextBeatId: "beat-0" },
        })),
      },
    ],
  };
}

function documentWithChoiceCount(count: number): unknown {
  return {
    v: 1,
    scenes: [
      {
        id: "scene-1",
        imageUrl: TINY_PNG_DATA_URL,
        entryBeatId: "beat-1",
        beats: [
          {
            id: "beat-1",
            next: {
              type: "choice",
              choices: Array.from({ length: count }, (_, index) => ({
                id: `choice-${index}`,
                label: `Choice ${index}`,
                target: { sceneId: "scene-1", beatId: "beat-1" },
              })),
            },
          },
        ],
      },
    ],
  };
}

test("media accepts tiny PNG bytes and rejects external, traversal, SVG, and oversized data", async () => {
  await validateMediaUrl(TINY_PNG_DATA_URL);

  const rejected = [
    "https://example.com/image.png",
    "http://localhost/image.png",
    "/api/aistory-cache/media/../secret.png",
    `/api/aistory-cache/media/${"a".repeat(64)}.svg`,
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/plain;base64,aGVsbG8=",
    "blob:https://example.com/media",
    "file:///etc/passwd",
    "/home/%2e%2e/secret.png",
  ];
  for (const url of rejected) {
    await expectDomainError(validateMediaUrl(url), "media_invalid", 400);
  }

  const oversized =
    "data:image/png;base64," + Buffer.alloc(1024 * 1024 + 1, 0).toString("base64");
  await expectDomainError(validateMediaUrl(oversized), "media_invalid", 400);
});

test("cached media must resolve to an existing regular non-symlink file", async () => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "aistory-media-cache-"));
  try {
    const mediaDir = path.join(cacheRoot, "media");
    await mkdir(mediaDir);
    const fileName = `${"b".repeat(64)}.png`;
    const filePath = path.join(mediaDir, fileName);
    await writeFile(filePath, TINY_PNG_BYTES);
    const validator = createMediaValidator({ mediaCacheDir: mediaDir });
    await validator(`/api/aistory-cache/media/${fileName}`);

    await writeFile(filePath, Buffer.from("not a png"));
    await expectDomainError(
      validator(`/api/aistory-cache/media/${fileName}`),
      "media_invalid",
      400,
    );

    await rm(filePath);
    await expectDomainError(
      validator(`/api/aistory-cache/media/${fileName}`),
      "media_invalid",
      400,
    );
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("static media requires the injected manifest and real raster bytes", async () => {
  const publicDir = await mkdtemp(path.join(tmpdir(), "aistory-public-"));
  try {
    await mkdir(path.join(publicDir, "home"));
    const url = "/home/hero.png";
    await writeFile(path.join(publicDir, "home", "hero.png"), TINY_PNG_BYTES);

    await expectDomainError(validateMediaUrl(url, { publicDir }), "media_invalid", 400);
    await validateMediaUrl(url, { publicDir, staticPaths: new Set([url]) });

    const svgUrl = "/home/hero.svg";
    await writeFile(path.join(publicDir, "home", "hero.svg"), "<svg></svg>");
    await expectDomainError(
      validateMediaUrl(svgUrl, { publicDir, staticPaths: new Set([svgUrl]) }),
      "media_invalid",
      400,
    );
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("published static media catalog is the frozen exact 122-path manifest", () => {
  const expected: string[] = [];
  for (let index = 0; index <= 29; index += 1) {
    expected.push(`/home/firstscene/f${index}.webp`);
    expected.push(`/home/firstscene-portrait/f${index}.webp`);
    expected.push(`/home/firstscene-portrait/m${index}.webp`);
  }
  for (let index = 0; index <= 31; index += 1) {
    expected.push(`/home/firstscene/m${index}.webp`);
  }

  assert.equal(PUBLISHED_STATIC_MEDIA_PATHS.length, 122);
  assert.equal(new Set(PUBLISHED_STATIC_MEDIA_PATHS).size, 122);
  assert.deepEqual([...PUBLISHED_STATIC_MEDIA_PATHS].sort(), expected.sort());
  for (const url of PUBLISHED_STATIC_MEDIA_PATHS) {
    assert.equal(isPublishedStaticMediaUrl(url), true);
  }

  const rejected: unknown[] = [
    "/home/firstscene/f30.webp",
    "/home/firstscene-portrait/m30.webp",
    "/home/firstscene/F0.webp",
    "home/firstscene/f0.webp",
    "/home/firstscene/f0.webp?x=1",
    "/home/firstscene/f0.webp#x",
    "/home/firstscene/../firstscene/f0.webp",
    "/home/%66irstscene/f0.webp",
    "/home/case/f0.webp",
    "/home/firstscene/f0.svg",
    "",
    null,
    undefined,
    0,
    {},
  ];
  for (const value of rejected) {
    assert.equal(isPublishedStaticMediaUrl(value), false);
  }
});

test("default published catalog accepts exact preset paths with real raster bytes", async () => {
  const publicDir = await mkdtemp(path.join(tmpdir(), "aistory-published-public-"));
  const emptyDir = await mkdtemp(path.join(tmpdir(), "aistory-published-missing-"));
  try {
    await mkdir(path.join(publicDir, "home", "firstscene"), { recursive: true });
    await mkdir(path.join(publicDir, "home", "firstscene-portrait"), { recursive: true });
    await writeFile(path.join(publicDir, "home", "firstscene", "f0.webp"), TINY_WEBP_BYTES);
    await writeFile(
      path.join(publicDir, "home", "firstscene-portrait", "m29.webp"),
      TINY_WEBP_BYTES,
    );
    // PNG bytes with a .webp name must fail the raster-signature check.
    await writeFile(path.join(publicDir, "home", "firstscene", "f1.webp"), TINY_PNG_BYTES);

    // Default (no injected staticPaths) uses the frozen published catalog.
    await validateMediaUrl("/home/firstscene/f0.webp", { publicDir });
    await validateMediaUrl("/home/firstscene-portrait/m29.webp", { publicDir });

    // The file must still exist and be accessible.
    await expectDomainError(
      validateMediaUrl("/home/firstscene/f2.webp", { publicDir: emptyDir }),
      "media_invalid",
      400,
    );
    await expectDomainError(
      validateMediaUrl("/home/firstscene/f1.webp", { publicDir }),
      "media_invalid",
      400,
    );

    // An injected empty set denies everything the default catalog allows.
    const denyAll = createMediaValidator({ publicDir, staticPaths: new Set() });
    await expectDomainError(denyAll("/home/firstscene/f0.webp"), "media_invalid", 400);

    // Injected overrides still work for host-specific public paths.
    await mkdir(path.join(publicDir, "case-studies"), { recursive: true });
    await writeFile(path.join(publicDir, "case-studies", "demo.png"), TINY_PNG_BYTES);
    await validateMediaUrl("/case-studies/demo.png", {
      publicDir,
      staticPaths: new Set(["/case-studies/demo.png"]),
    });
  } finally {
    await rm(publicDir, { recursive: true, force: true });
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("unlisted look-alike preset paths are rejected even when files exist", async () => {
  const publicDir = await mkdtemp(path.join(tmpdir(), "aistory-published-lookalike-"));
  try {
    await mkdir(path.join(publicDir, "home", "firstscene"), { recursive: true });
    await mkdir(path.join(publicDir, "home", "firstscene-portrait"), { recursive: true });
    await writeFile(path.join(publicDir, "home", "firstscene", "f30.webp"), TINY_WEBP_BYTES);
    await writeFile(
      path.join(publicDir, "home", "firstscene-portrait", "m30.webp"),
      TINY_WEBP_BYTES,
    );

    await expectDomainError(
      validateMediaUrl("/home/firstscene/f30.webp", { publicDir }),
      "media_invalid",
      400,
    );
    await expectDomainError(
      validateMediaUrl("/home/firstscene-portrait/m30.webp", { publicDir }),
      "media_invalid",
      400,
    );
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("oversized static image is rejected before it is read", async () => {
  const publicDir = await mkdtemp(path.join(tmpdir(), "aistory-published-oversized-"));
  try {
    await mkdir(path.join(publicDir, "home", "firstscene"), { recursive: true });
    // The size cap (16 MiB) must reject this before readFile bounds memory.
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
    oversized.write("RIFF", 0, "latin1");
    oversized.write("WEBP", 8, "latin1");
    await writeFile(path.join(publicDir, "home", "firstscene", "f0.webp"), oversized);

    await expectDomainError(
      validateMediaUrl("/home/firstscene/f0.webp", { publicDir }),
      "media_invalid",
      400,
    );
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test("nested symlink below the trusted public root cannot escape", async (t) => {
  const publicDir = await mkdtemp(path.join(tmpdir(), "aistory-public-link-"));
  const outsideDir = await mkdtemp(path.join(tmpdir(), "aistory-public-outside-"));
  try {
    await mkdir(path.join(publicDir, "home"), { recursive: true });
    await writeFile(path.join(outsideDir, "f0.webp"), TINY_WEBP_BYTES);
    try {
      await symlink(outsideDir, path.join(publicDir, "home", "firstscene"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "ELOOP") {
        t.skip(`symlink creation is not permitted here (${code})`);
        return;
      }
      throw error;
    }

    await expectDomainError(
      validateMediaUrl("/home/firstscene/f0.webp", { publicDir }),
      "media_invalid",
      400,
    );
  } finally {
    await rm(publicDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("HTTP mutation rejects CSRF failures, wrong content type, and oversized bodies", async () => {
  const originEnv = process.env.AISTORY_SHARED_STORIES_ORIGIN;
  const nodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    process.env.NODE_ENV = "test";

    const noOrigin = new Request("http://localhost/api/shared-stories", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify({}),
    });
    const noOriginResponse = await handleCreateSharedStory(noOrigin, OWNER_A);
    assert.equal(noOriginResponse.status, 400);
    assert.equal(noOriginResponse.headers.get("cache-control"), "no-store");
    const noOriginBody = (await noOriginResponse.json()) as {
      error: string;
      code: string;
    };
    assert.equal(noOriginBody.code, "csrf_rejected");
    assert.equal(typeof noOriginBody.error, "string");
    assert.ok(noOriginBody.error.length > 0);
    assert.equal(Object.hasOwn(noOriginBody, "message"), false);

    const crossSite = new Request("http://localhost/api/shared-stories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({}),
    });
    const crossSiteResponse = await handleCreateSharedStory(crossSite, OWNER_A);
    assert.equal(crossSiteResponse.status, 400);

    const wrongType = new Request("http://localhost/api/shared-stories", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        host: "localhost",
        origin: "http://localhost",
      },
      body: "{}",
    });
    const wrongTypeResponse = await handleCreateSharedStory(wrongType, OWNER_A);
    assert.equal(wrongTypeResponse.status, 400);
    assert.equal(
      ((await wrongTypeResponse.json()) as { code: string }).code,
      "invalid_content_type",
    );

    const hugeBody = "x".repeat(1024 * 1024 + 1);
    const huge = new Request("http://localhost/api/shared-stories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost",
      },
      body: hugeBody,
    });
    const hugeResponse = await handleCreateSharedStory(huge, OWNER_A);
    assert.equal(hugeResponse.status, 413);
    assert.equal(
      ((await hugeResponse.json()) as { code: string }).code,
      "payload_too_large",
    );
  } finally {
    if (originEnv === undefined) delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    else process.env.AISTORY_SHARED_STORIES_ORIGIN = originEnv;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
});

test("mutation origin is pinned to the exact configured canonical HTTPS origin", async () => {
  const originEnv = process.env.AISTORY_SHARED_STORIES_ORIGIN;
  const nodeEnv = process.env.NODE_ENV;
  try {
    process.env.AISTORY_SHARED_STORIES_ORIGIN = "https://play.hibcglobal.com";

    // Verified host proxy: public HTTPS Origin, internal request URL is http on
    // the same host (X-Forwarded-Proto is http and is never consulted).
    const proxiedRequest = (): Request =>
      new Request("http://play.hibcglobal.com/api/shared-stories", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://play.hibcglobal.com",
          host: "play.hibcglobal.com",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({}),
      });
    assert.doesNotThrow(() => assertSameOriginMutation(proxiedRequest()));

    const evilOrigin = new Request("http://play.hibcglobal.com/api/shared-stories", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        host: "play.hibcglobal.com",
      },
    });
    assert.throws(() => assertSameOriginMutation(evilOrigin), isDomainError("csrf_rejected", 400));

    const wrongHost = new Request("http://internal.local/api/shared-stories", {
      method: "POST",
      headers: {
        origin: "https://play.hibcglobal.com",
        host: "internal.local",
      },
    });
    assert.throws(() => assertSameOriginMutation(wrongHost), isDomainError("csrf_rejected", 400));

    const wrongHostHeader = new Request("http://internal.local/api/shared-stories", {
      method: "POST",
      headers: {
        origin: "https://play.hibcglobal.com",
        host: "play.hibcglobal.com",
      },
    });
    assert.throws(
      () => assertSameOriginMutation(wrongHostHeader),
      isDomainError("csrf_rejected", 400),
    );

    // Production without the pinned origin fails closed before touching storage.
    process.env.NODE_ENV = "production";
    delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    const missingConfigResponse = await handleCreateSharedStory(proxiedRequest(), OWNER_A);
    assert.equal(missingConfigResponse.status, 503);
    const missingConfigBody = (await missingConfigResponse.json()) as {
      error: string;
      code: string;
    };
    assert.equal(missingConfigBody.code, "origin_not_configured");
    assert.equal(typeof missingConfigBody.error, "string");

    // A non-canonical spelling (trailing slash) is rejected as misconfiguration.
    process.env.AISTORY_SHARED_STORIES_ORIGIN = "https://play.hibcglobal.com/";
    assert.throws(
      () => assertSameOriginMutation(proxiedRequest()),
      isDomainError("origin_misconfigured", 503),
    );
  } finally {
    if (originEnv === undefined) delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    else process.env.AISTORY_SHARED_STORIES_ORIGIN = originEnv;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
});

test("configured plain HTTP origin is accepted only for exact strict loopback hosts", () => {
  const originEnv = process.env.AISTORY_SHARED_STORIES_ORIGIN;
  const nodeEnv = process.env.NODE_ENV;
  const request = (
    configuredOrigin: string,
    requestUrl = `${configuredOrigin}/api/shared-stories`,
    hostHeader = new URL(configuredOrigin).host,
    originHeader = configuredOrigin,
  ): Request =>
    new Request(requestUrl, {
      method: "POST",
      headers: {
        origin: originHeader,
        host: hostHeader,
        "sec-fetch-site": "same-origin",
      },
    });

  try {
    process.env.NODE_ENV = "production";

    // The packaged local artifact runs production Nextstart on plain HTTP.
    for (const configuredOrigin of [
      "http://127.0.0.1:4335",
      "http://localhost:4335",
      "http://[::1]:4335",
    ]) {
      process.env.AISTORY_SHARED_STORIES_ORIGIN = configuredOrigin;
      assert.doesNotThrow(
        () => assertSameOriginMutation(request(configuredOrigin)),
        configuredOrigin,
      );
    }

    process.env.AISTORY_SHARED_STORIES_ORIGIN = "http://127.0.0.1:4335";

    // Browser Origin, Host, and request-URL host must all match exactly.
    const wrongOrigin = "http://127.0.0.1:4336";
    assert.throws(
      () =>
        assertSameOriginMutation(
          request(
            "http://127.0.0.1:4335",
            "http://127.0.0.1:4335/api/shared-stories",
            "127.0.0.1:4335",
            wrongOrigin,
          ),
        ),
      isDomainError("csrf_rejected", 400),
    );
    assert.throws(
      () =>
        assertSameOriginMutation(
          request(
            "http://127.0.0.1:4335",
            "http://127.0.0.1:4335/api/shared-stories",
            "127.0.0.1:4336",
          ),
        ),
      isDomainError("csrf_rejected", 400),
    );
    assert.throws(
      () =>
        assertSameOriginMutation(
          request(
            "http://127.0.0.1:4335",
            "http://localhost:4335/api/shared-stories",
            "127.0.0.1:4335",
          ),
        ),
      isDomainError("csrf_rejected", 400),
    );

    // Forwarded headers are never trusted to repair a mismatched request.
    const forwarded = new Request("http://127.0.0.1:4336/api/shared-stories", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:4335",
        host: "127.0.0.1:4336",
        "x-forwarded-host": "127.0.0.1:4335",
        "x-forwarded-proto": "http",
      },
    });
    assert.throws(
      () => assertSameOriginMutation(forwarded),
      isDomainError("csrf_rejected", 400),
    );

    // Plain HTTP remains forbidden for every non-loopback configured host.
    for (const malformedOrigin of [
      "http://127.0.0.2:4335",
      "http://localhost.example:4335",
      "http://play.hibcglobal.com",
    ]) {
      process.env.AISTORY_SHARED_STORIES_ORIGIN = malformedOrigin;
      assert.throws(
        () => assertSameOriginMutation(request("http://127.0.0.1:4335")),
        isDomainError("origin_misconfigured", 503),
      );
    }

    // Production still fails closed when no shared origin is configured.
    delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    assert.throws(
      () => assertSameOriginMutation(request("http://127.0.0.1:4335")),
      isDomainError("origin_not_configured", 503),
    );
  } finally {
    if (originEnv === undefined) delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    else process.env.AISTORY_SHARED_STORIES_ORIGIN = originEnv;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
});

test("HTTP create/get/list flow works through env-configured filesystem store", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aistory-http-store-"));
  const mode = process.env.AISTORY_SHARED_STORIES_MODE;
  const root = process.env.AISTORY_SHARED_STORIES_ROOT;
  const originEnv = process.env.AISTORY_SHARED_STORIES_ORIGIN;
  const nodeEnv = process.env.NODE_ENV;
  try {
    process.env.AISTORY_SHARED_STORIES_MODE = "filesystem-v1";
    process.env.AISTORY_SHARED_STORIES_ROOT = dir;
    delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    process.env.NODE_ENV = "test";

    const createResponse = await handleCreateSharedStory(
      mutationRequest("http://localhost/api/shared-stories", {
        sourceId: "http-flow",
        title: "HTTP flow",
        document: sampleDocument(),
      }),
      OWNER_A,
    );
    assert.equal(createResponse.status, 201);
    assert.equal(createResponse.headers.get("cache-control"), "no-store");
    const created = (await createResponse.json()) as {
      id: string;
      sourceId?: string;
      revision: number;
    };
    assert.equal(created.revision, 1);
    assert.equal(Object.hasOwn(created, "story"), false);
    assert.equal(Object.hasOwn(created, "sourceId"), false);

    const getResponse = await handleGetSharedStory(
      new Request(`http://localhost/api/shared-stories/${created.id}`),
      created.id,
    );
    assert.equal(getResponse.status, 200);
    const full = (await getResponse.json()) as {
      id: string;
      document: SharedDocumentV1;
      sourceId?: string;
    };
    assert.equal(full.id, created.id);
    assert.equal(Object.hasOwn(full, "story"), false);
    assert.equal(full.document.scenes.length, 1);
    assert.equal(Object.hasOwn(full, "sourceId"), false);

    // PATCH responds with the story item directly, not a wrapper.
    const patchResponse = await handlePatchSharedStory(
      mutationRequest(
        `http://localhost/api/shared-stories/${created.id}`,
        { visibility: "hidden", expectedRevision: 1 },
        "PATCH",
      ),
      created.id,
      OWNER_A,
    );
    assert.equal(patchResponse.status, 200);
    const patched = (await patchResponse.json()) as {
      id: string;
      visibility: string;
      revision: number;
    };
    assert.equal(patched.id, created.id);
    assert.equal(patched.visibility, "hidden");
    assert.equal(patched.revision, 2);
    assert.equal(Object.hasOwn(patched, "story"), false);
    assert.equal(
      (
        await handleGetSharedStory(
          new Request(`http://localhost/api/shared-stories/${created.id}`),
          created.id,
        )
      ).status,
      404,
    );
    const republishResponse = await handlePatchSharedStory(
      mutationRequest(
        `http://localhost/api/shared-stories/${created.id}`,
        { visibility: "public", expectedRevision: 2 },
        "PATCH",
      ),
      created.id,
      OWNER_A,
    );
    assert.equal(republishResponse.status, 200);

    const hiddenCreateResponse = await handleCreateSharedStory(
      mutationRequest("http://localhost/api/shared-stories", {
        sourceId: "http-hidden",
        title: "Hidden HTTP",
        visibility: "hidden",
        document: sampleDocument({ narration: "Hidden HTTP content" }),
      }),
      OWNER_A,
    );
    assert.equal(hiddenCreateResponse.status, 201);
    const hiddenCreated = (await hiddenCreateResponse.json()) as {
      id: string;
    };
    const hiddenGetResponse = await handleGetSharedStory(
      new Request(`http://localhost/api/shared-stories/${hiddenCreated.id}`),
      hiddenCreated.id,
    );
    assert.equal(hiddenGetResponse.status, 404);
    assert.equal(hiddenGetResponse.headers.get("cache-control"), "no-store");
    const hiddenBody = (await hiddenGetResponse.json()) as {
      error: string;
      code: string;
    };
    assert.equal(hiddenBody.code, "not_found");
    assert.equal(typeof hiddenBody.error, "string");

    const listResponse = await handleListSharedStories(
      new Request("http://localhost/api/shared-stories?limit=20"),
      null,
    );
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as {
      items: Array<{ id: string; sourceId?: string }>;
      nextCursor: string | null;
    };
    assert.equal(list.items.length, 1);
    assert.equal(list.nextCursor, null);
    assert.equal(Object.hasOwn(list.items[0]!, "sourceId"), false);

    const mineResponse = await handleListSharedStories(
      new Request("http://localhost/api/shared-stories?mine=1"),
      OWNER_A,
    );
    const mine = (await mineResponse.json()) as {
      items: Array<{ sourceId?: string }>;
    };
    assert.ok(mine.items.some((item) => item.sourceId === "http-flow"));
    assert.ok(mine.items.some((item) => item.sourceId === "http-hidden"));

    const anonymousMine = await handleListSharedStories(
      new Request("http://localhost/api/shared-stories?mine=1"),
      null,
    );
    assert.equal(anonymousMine.status, 401);

    const badCursor = await handleListSharedStories(
      new Request("http://localhost/api/shared-stories?cursor=not-a-cursor"),
      null,
    );
    assert.equal(badCursor.status, 400);
  } finally {
    if (mode === undefined) delete process.env.AISTORY_SHARED_STORIES_MODE;
    else process.env.AISTORY_SHARED_STORIES_MODE = mode;
    if (root === undefined) delete process.env.AISTORY_SHARED_STORIES_ROOT;
    else process.env.AISTORY_SHARED_STORIES_ROOT = root;
    if (originEnv === undefined) delete process.env.AISTORY_SHARED_STORIES_ORIGIN;
    else process.env.AISTORY_SHARED_STORIES_ORIGIN = originEnv;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

const PUBLIC_ORIGIN = "https://play.hibcglobal.com";
const PUBLIC_HOST = "play.hibcglobal.com";
const INTERNAL_ORIGIN_ENV = "AISTORY_SHARED_STORIES_INTERNAL_ORIGIN";
const EXTERNAL_ORIGIN_ENV = "AISTORY_SHARED_STORIES_ORIGIN";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Every new origin test saves and restores all three values so no test can
 * contaminate the existing suite or another regression case.
 */
function withOriginEnv(
  values: { external?: string; internal?: string; nodeEnv?: string },
  run: () => void,
): void {
  const external = process.env[EXTERNAL_ORIGIN_ENV];
  const internal = process.env[INTERNAL_ORIGIN_ENV];
  const nodeEnv = process.env.NODE_ENV;
  try {
    setEnv(EXTERNAL_ORIGIN_ENV, values.external);
    setEnv(INTERNAL_ORIGIN_ENV, values.internal);
    setEnv("NODE_ENV", values.nodeEnv);
    run();
  } finally {
    setEnv(EXTERNAL_ORIGIN_ENV, external);
    setEnv(INTERNAL_ORIGIN_ENV, internal);
    setEnv("NODE_ENV", nodeEnv);
  }
}

type MutationHeaderOverrides = {
  origin?: string;
  host?: string;
  secFetchSite?: string;
  extra?: Record<string, string>;
};

function originMutationRequest(
  url: string,
  overrides: MutationHeaderOverrides = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (overrides.origin !== undefined) headers.origin = overrides.origin;
  if (overrides.host !== undefined) headers.host = overrides.host;
  if (overrides.secFetchSite !== undefined) {
    headers["sec-fetch-site"] = overrides.secFetchSite;
  }
  Object.assign(headers, overrides.extra);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

function publicProxyRequest(
  url: string,
  overrides: MutationHeaderOverrides = {},
): Request {
  return originMutationRequest(url, {
    origin: PUBLIC_ORIGIN,
    host: PUBLIC_HOST,
    secFetchSite: "same-origin",
    ...overrides,
  });
}

test("internal transport origin pin accepts the proxy request URL without widening Origin or Host", () => {
  withOriginEnv(
    {
      external: PUBLIC_ORIGIN,
      internal: "http://127.0.0.1:4200",
      nodeEnv: "production",
    },
    () => {
      const internalBase = "http://127.0.0.1:4200/api/shared-stories";

      // Exact internal transport origin with a path and query: the comparison
      // must be origin-only, not full-URL equality.
      assert.doesNotThrow(() =>
        assertSameOriginMutation(publicProxyRequest(`${internalBase}?limit=20`)),
      );
      assert.doesNotThrow(() =>
        assertSameOriginMutation(publicProxyRequest(`${internalBase}/story-id`)),
      );

      // Ordinary external request URLs keep working in both http and https form.
      assert.doesNotThrow(() =>
        assertSameOriginMutation(publicProxyRequest(`${PUBLIC_ORIGIN}/api/shared-stories`)),
      );
      assert.doesNotThrow(() =>
        assertSameOriginMutation(
          publicProxyRequest("http://play.hibcglobal.com/api/shared-stories"),
        ),
      );

      // Wrong internal port.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest("http://127.0.0.1:4201/api/shared-stories"),
          ),
        isDomainError("csrf_rejected", 400),
      );

      // HTTPS is not the pinned internal transport scheme.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest("https://127.0.0.1:4200/api/shared-stories"),
          ),
        isDomainError("csrf_rejected", 400),
      );

      // Other loopback aliases, arbitrary private hosts, and unrelated public
      // hosts are not covered by the pin.
      for (const url of [
        "http://localhost:4200/api/shared-stories",
        "http://10.1.2.3:4200/api/shared-stories",
        "https://internal.example/api/shared-stories",
        "https://play.hibcglobal.com.evil.example/api/shared-stories",
      ]) {
        assert.throws(
          () => assertSameOriginMutation(publicProxyRequest(url)),
          isDomainError("csrf_rejected", 400),
          url,
        );
      }

      // The internal pin must not expand the caller Origin.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest(internalBase, { origin: "http://127.0.0.1:4200" }),
          ),
        isDomainError("csrf_rejected", 400),
      );

      // The internal pin must not expand the allowed Host header.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest(internalBase, { host: "127.0.0.1:4200" }),
          ),
        isDomainError("csrf_rejected", 400),
      );

      // Missing Origin and cross-site requests remain rejected.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest(internalBase, { origin: undefined }),
          ),
        isDomainError("csrf_rejected", 400),
      );
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest(internalBase, { secFetchSite: "cross-site" }),
          ),
        isDomainError("csrf_rejected", 400),
      );

      // Forwarded headers never repair a request URL outside the pin.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest("http://127.0.0.1:4201/api/shared-stories", {
              extra: {
                "x-forwarded-host": "127.0.0.1:4200",
                "x-forwarded-proto": "http",
              },
            }),
          ),
        isDomainError("csrf_rejected", 400),
      );
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest("https://unrelated.example/api/shared-stories", {
              extra: {
                "x-forwarded-host": PUBLIC_HOST,
                "x-forwarded-proto": "https",
              },
            }),
          ),
        isDomainError("csrf_rejected", 400),
      );
    },
  );
});

test("internal transport origin pin supports canonical localhost and IPv6 loopback spellings", () => {
  for (const internal of ["http://localhost:4201", "http://[::1]:4201"]) {
    withOriginEnv(
      {
        external: PUBLIC_ORIGIN,
        internal,
        nodeEnv: "production",
      },
      () => {
        assert.doesNotThrow(
          () =>
            assertSameOriginMutation(
              publicProxyRequest(`${internal}/api/shared-stories/nested`),
            ),
          internal,
        );

        // A different loopback spelling is a different pinned origin.
        const other =
          internal === "http://localhost:4201"
            ? "http://127.0.0.1:4201"
            : "http://localhost:4201";
        assert.throws(
          () =>
            assertSameOriginMutation(
              publicProxyRequest(`${other}/api/shared-stories`),
            ),
          isDomainError("csrf_rejected", 400),
          internal,
        );
      },
    );
  }
});

test("absent internal transport origin pin preserves the previous strict request-URL rule", () => {
  withOriginEnv(
    {
      external: PUBLIC_ORIGIN,
      nodeEnv: "production",
    },
    () => {
      // Without the pin, the proxy's internal Next request URL is rejected as
      // before even though the public Origin and Host are exact.
      assert.throws(
        () =>
          assertSameOriginMutation(
            publicProxyRequest("http://127.0.0.1:4200/api/shared-stories"),
          ),
        isDomainError("csrf_rejected", 400),
      );

      // The existing direct external behavior is unchanged.
      assert.doesNotThrow(() =>
        assertSameOriginMutation(
          publicProxyRequest(`${PUBLIC_ORIGIN}/api/shared-stories`),
        ),
      );
    },
  );
});

test("invalid internal transport origin pin spellings fail closed as origin_misconfigured", () => {
  const invalidPins = [
    "",
    " ",
    "\thttp://127.0.0.1:4200",
    "http://127.0.0.1:4200 ",
    "http://127.0.0.1:4200\n",
    "http://127.0.0.1:4200/",
    "HTTP://127.0.0.1:4200",
    "http://LOCALHOST:4200",
    "http://user:pass@127.0.0.1:4200",
    "http://127.0.0.1:4200/api",
    "http://127.0.0.1:4200?x=1",
    "http://127.0.0.1:4200#x",
    "http://127.0.0.1:80",
    "http://127.0.0.1:04200",
    "https://127.0.0.1:4200",
    "ftp://127.0.0.1:4200",
    "//127.0.0.1:4200",
    "http://127.0.0.2:4200",
    "http://10.0.0.5:4200",
    "http://localhost.example:4200",
    "http://127.1:4200",
    "http://2130706433:4200",
    "http://0177.0.0.1:4200",
    "http://[0:0:0:0:0:0:0:1]:4200",
    "http://[::1]:4200/",
  ];

  withOriginEnv(
    {
      external: PUBLIC_ORIGIN,
      nodeEnv: "production",
    },
    () => {
      const validRequest = (): Request =>
        publicProxyRequest(`${PUBLIC_ORIGIN}/api/shared-stories`);
      assert.doesNotThrow(() => assertSameOriginMutation(validRequest()));

      for (const pin of invalidPins) {
        process.env[INTERNAL_ORIGIN_ENV] = pin;
        assert.throws(
          () => assertSameOriginMutation(validRequest()),
          isDomainError("origin_misconfigured", 503),
          JSON.stringify(pin),
        );
      }
    },
  );
});

test("internal transport origin pin requires configured public HTTPS external mode", () => {
  const pin = "http://127.0.0.1:4200";
  const proxyUrl = "http://127.0.0.1:4200/api/shared-stories";

  // Missing external origin fails closed in production and non-production alike;
  // the pin must never silently degrade to local preview mode.
  for (const nodeEnv of ["production", "test"]) {
    withOriginEnv({ internal: pin, nodeEnv }, () => {
      assert.throws(
        () => assertSameOriginMutation(publicProxyRequest(proxyUrl)),
        isDomainError("origin_misconfigured", 503),
        nodeEnv,
      );
    });
  }

  // An explicitly empty external origin is still a missing external origin.
  withOriginEnv(
    { external: "", internal: pin, nodeEnv: "production" },
    () => {
      assert.throws(
        () => assertSameOriginMutation(publicProxyRequest(proxyUrl)),
        isDomainError("origin_misconfigured", 503),
      );
    },
  );

  // Local loopback HTTP external origins are the local preview mode.
  for (const external of [
    "http://127.0.0.1:4200",
    "http://localhost:4200",
    "http://[::1]:4200",
  ]) {
    withOriginEnv(
      { external, internal: pin, nodeEnv: "production" },
      () => {
        assert.throws(
          () =>
            assertSameOriginMutation(publicProxyRequest(`${external}/api/shared-stories`)),
          isDomainError("origin_misconfigured", 503),
          external,
        );
      },
    );
  }

  // HTTPS loopback is still loopback, so it cannot carry an internal pin.
  for (const external of [
    "https://localhost:4200",
    "https://127.0.0.1:4200",
    "https://[::1]:4200",
  ]) {
    withOriginEnv(
      { external, internal: pin, nodeEnv: "production" },
      () => {
        assert.throws(
          () =>
            assertSameOriginMutation(publicProxyRequest(`${external}/api/shared-stories`)),
          isDomainError("origin_misconfigured", 503),
          external,
        );
      },
    );
  }

  // A configured public HTTPS external origin makes the same pin usable.
  withOriginEnv(
    { external: PUBLIC_ORIGIN, internal: pin, nodeEnv: "production" },
    () => {
      assert.doesNotThrow(() =>
        assertSameOriginMutation(publicProxyRequest(proxyUrl)),
      );
    },
  );
});
