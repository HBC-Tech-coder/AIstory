import assert from "node:assert/strict";

import { getLocalMiniDramaProjectContext } from "../lib/localminidrama/server";

const originalBackend = process.env.LOCAL_MINIDRAMA_BACKEND_URL;
const originalFrontend = process.env.LOCAL_MINIDRAMA_FRONTEND_URL;

process.env.LOCAL_MINIDRAMA_BACKEND_URL = "http://127.0.0.1:5679";
process.env.LOCAL_MINIDRAMA_FRONTEND_URL = "http://localhost:4107";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" },
  });

const requests: string[] = [];
const fetcher = (async (input: URL | RequestInfo) => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith("/dramas/7")) {
    return json({
      id: 7,
      title: "测试短剧",
      status: "draft",
      genre: "悬疑",
      style: "cinematic",
      updated_at: "2026-07-27T10:00:00.000Z",
      episodes: [
        {
          id: 71,
          title: "不可回传的正文",
          script_content: "PRIVATE_SCRIPT_MARKER",
        },
      ],
      scenes: [{ id: 1 }, { id: 2 }],
      api_key: "PRIVATE_KEY_MARKER",
    });
  }
  if (url.endsWith("/dramas/7/characters")) {
    return json([
      { id: 1, name: "角色甲", private_prompt: "PRIVATE_PROMPT_MARKER" },
      { id: 2, name: "角色乙" },
    ]);
  }
  if (url.endsWith("/dramas/7/props")) return json([{ id: 1 }]);
  if (url.includes("/tasks?resource_id=7")) {
    return json([
      {
        id: "task-1",
        type: "image_generation",
        status: "processing",
        progress: 55,
        updated_at: "2026-07-27T10:03:00.000Z",
        error: "PRIVATE_ERROR_MARKER",
        result: { prompt: "PRIVATE_RESULT_MARKER" },
      },
    ]);
  }
  if (url.includes("/assets?")) {
    return json({
      items: [{ updated_at: "2026-07-27T10:01:00.000Z" }],
      pagination: { total: 3 },
    });
  }
  if (url.includes("/images?")) {
    return json({
      items: [{ updated_at: "2026-07-27T10:02:00.000Z" }],
      pagination: { total: 4 },
    });
  }
  if (url.includes("/videos?")) {
    return json({
      items: [{ updated_at: "2026-07-27T10:04:00.000Z" }],
      pagination: { total: 2 },
    });
  }
  throw new Error(`Unexpected URL: ${url}`);
}) as typeof fetch;

const context = await getLocalMiniDramaProjectContext(7, fetcher);
assert.equal(context.state, "ready");
assert.deepEqual(context.counts, {
  characters: 2,
  scenes: 2,
  props: 1,
  tasks: 1,
  media: 9,
  images: 4,
  videos: 2,
});
assert.equal(context.project.episodeCount, 1);
assert.equal(context.activeTasks[0]?.status, "running");
assert.equal(context.activeTasks[0]?.progress, 55);
assert.equal(context.lastUpdatedAt, "2026-07-27T10:04:00.000Z");
assert.equal(requests.length, 7);

const serialized = JSON.stringify(context);
for (const forbidden of [
  "PRIVATE_SCRIPT_MARKER",
  "PRIVATE_KEY_MARKER",
  "PRIVATE_PROMPT_MARKER",
  "PRIVATE_ERROR_MARKER",
  "PRIVATE_RESULT_MARKER",
  "script_content",
  "api_key",
]) {
  assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
}

const partialFetcher = (async (input: URL | RequestInfo) => {
  const url = String(input);
  if (url.endsWith("/dramas/8")) {
    return json({ id: 8, title: "部分可用", status: "draft", scenes: [] });
  }
  if (url.includes("/images?")) {
    return new Response("busy", { status: 503 });
  }
  return json([]);
}) as typeof fetch;
const partial = await getLocalMiniDramaProjectContext(8, partialFetcher);
assert.equal(partial.state, "partial");
assert.deepEqual(partial.warnings, ["images-unavailable"]);

await assert.rejects(() => getLocalMiniDramaProjectContext(0, fetcher));
await assert.rejects(() => getLocalMiniDramaProjectContext(Number.NaN, fetcher));

let remoteFetchCalled = false;
process.env.LOCAL_MINIDRAMA_BACKEND_URL = "https://example.com";
await assert.rejects(() =>
  getLocalMiniDramaProjectContext(
    7,
    (async () => {
      remoteFetchCalled = true;
      return json({});
    }) as typeof fetch,
  ),
);
assert.equal(remoteFetchCalled, false);

if (originalBackend === undefined) {
  delete process.env.LOCAL_MINIDRAMA_BACKEND_URL;
} else {
  process.env.LOCAL_MINIDRAMA_BACKEND_URL = originalBackend;
}
if (originalFrontend === undefined) {
  delete process.env.LOCAL_MINIDRAMA_FRONTEND_URL;
} else {
  process.env.LOCAL_MINIDRAMA_FRONTEND_URL = originalFrontend;
}

console.log("LocalMiniDrama typed bridge tests passed.");
