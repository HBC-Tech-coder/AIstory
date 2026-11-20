// Adapter-level physical-boundary tests.
//
// These tests exercise the REAL adapters (chat/vision/image/TTS) against a
// fake global `fetch`. No request ever leaves the process:
//   * the fake fetch records every physical call,
//   * it rejects any URL outside the small allowlist below,
//   * retry throttling uses `retry-after: 0`, so nothing sleeps for seconds.
//
// Run with the parent's normal runner, e.g.:
//   tsx scripts/test-platform-cost-adapters.ts

import assert from "node:assert/strict";

import {
  PlatformCostEnvelopeError,
  platformCostEnvelopeSnapshot,
  type PlatformCostEnvelopeErrorCode,
  type PlatformCostEnvelopeSnapshot,
} from "../lib/billing/platformCostEnvelope";
import {
  PLATFORM_CANONICAL_PROVIDER_BINDINGS,
  runInCostEnvelope,
  type PlatformRuntimeConfig,
} from "../lib/billing/platformCostEnvelopeServer";
import { chat, chatStream } from "../lib/ai-client/chat";
import { generateImage } from "../lib/ai-client/image";
import { analyzeImageDataUrl } from "../lib/ai-client/vision";
import { synthesize } from "../lib/tts-client/index";
import type { ProviderConfig, TtsConfig } from "../lib/types/index";

// ── Fake fetch ─────────────────────────────────────────────────────────

const COMPATIBLE_BASE =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/api/v1";
const TTS_AUDIO_URL = "https://audio.test/tts/voice.wav";

const ALLOWED_URLS = new Set([
  `${COMPATIBLE_BASE}/chat/completions`,
  `${DASHSCOPE_BASE}/services/aigc/multimodal-generation/generation`,
  TTS_AUDIO_URL,
]);

type CapturedRequest = {
  url: string;
  body: unknown;
};

type FakeFetchHandler = (
  request: CapturedRequest,
) => Response | Promise<Response>;

let captured: CapturedRequest[] = [];
let originalFetch: typeof globalThis.fetch | undefined;

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function installFakeFetch(handler: FakeFetchHandler): void {
  captured = [];
  originalFetch = globalThis.fetch;
  const fake = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request: CapturedRequest = { url, body };
    captured.push(request);
    if (!ALLOWED_URLS.has(url)) {
      throw new Error(`Fake fetch rejected unknown URL: ${url}`);
    }
    return handler(request);
  };
  (globalThis as { fetch: typeof fetch }).fetch =
    fake as unknown as typeof fetch;
}

function restoreFakeFetch(): void {
  if (originalFetch) {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    originalFetch = undefined;
  }
}

async function withFakeFetch<T>(
  handler: FakeFetchHandler,
  fn: () => Promise<T>,
): Promise<T> {
  installFakeFetch(handler);
  try {
    return await fn();
  } finally {
    restoreFakeFetch();
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────

type TestRuntime = PlatformRuntimeConfig & {
  text: ProviderConfig;
  image: ProviderConfig;
  vision: ProviderConfig;
  tts: TtsConfig;
};

function makeRuntime(): TestRuntime {
  const bindings = PLATFORM_CANONICAL_PROVIDER_BINDINGS;
  return {
    text: {
      provider: bindings.text.provider as ProviderConfig["provider"],
      model: bindings.text.model,
      baseUrl: bindings.text.baseUrl,
      apiKey: "test-key",
    },
    image: {
      provider: bindings.image.provider as ProviderConfig["provider"],
      model: bindings.image.model,
      baseUrl: bindings.image.baseUrl,
      apiKey: "test-key",
    },
    vision: {
      provider: bindings.vision.provider as ProviderConfig["provider"],
      model: bindings.vision.model,
      baseUrl: bindings.vision.baseUrl,
      apiKey: "test-key",
    },
    tts: {
      provider: bindings.tts.provider as TtsConfig["provider"],
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
      apiKey: "test-key",
    },
  };
}

const COMPLETION = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "qwen-plus",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

async function rejectEnvelopeCode(
  promise: Promise<unknown>,
  code: PlatformCostEnvelopeErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof PlatformCostEnvelopeError,
      `expected PlatformCostEnvelopeError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

function isEnvelopeCode(
  error: unknown,
  code: PlatformCostEnvelopeErrorCode,
): boolean {
  return error instanceof PlatformCostEnvelopeError
    && error.code === code;
}

type Test = readonly [name: string, fn: () => Promise<void>];

const tests: Test[] = [
  [
    "fake fetch rejects unknown URLs",
    async () => {
      await withFakeFetch(
        () => jsonResponse(COMPLETION),
        async () => {
          await assert.rejects(
            globalThis.fetch("https://unknown.example.com/v1/chat/completions"),
            /Fake fetch rejected unknown URL/,
          );
          assert.equal(captured.length, 1);
        },
      );
    },
  ],
  [
    "chat: physical request gets max_tokens 8192 and enable_thinking false",
    async () => {
      await withFakeFetch(
        (request) => {
          assert.equal(request.url, `${COMPATIBLE_BASE}/chat/completions`);
          return jsonResponse(COMPLETION);
        },
        async () => {
          const config = makeRuntime();
          await runInCostEnvelope(config, "style.rewrite", async () => {
            const text = await chat(
              config.text,
              [{ role: "user", content: "hello" }],
              { tag: "platform-chat" },
            );
            assert.equal(text, "ok");
            const snapshot = platformCostEnvelopeSnapshot();
            assert.equal(snapshot?.roles.text?.used, 1);
          });
          assert.equal(captured.length, 1);
          const body = captured[0]!.body as Record<string, unknown>;
          assert.equal(body.stream, false);
          assert.equal(body.max_tokens, 8_192);
          assert.equal(body.enable_thinking, false);
          assert.equal(body.model, "qwen-plus");
        },
      );
    },
  ],
  [
    "chatStream: stream failure falls back and counts two attempts on story.start",
    async () => {
      await withFakeFetch(
        (request) => {
          const body = request.body as Record<string, unknown> | undefined;
          if (body?.stream === true) {
            return new Response("stream unavailable", {
              status: 500,
              headers: { "content-type": "text/plain" },
            });
          }
          return jsonResponse(COMPLETION);
        },
        async () => {
          const config = makeRuntime();
          await runInCostEnvelope(config, "story.start", async () => {
            const chunks: string[] = [];
            const result = chatStream(
              config.text,
              [{ role: "user", content: "hello" }],
              { tag: "platform-stream" },
            );
            for await (const chunk of result.textStream) chunks.push(chunk);
            const usage = await result.usage;
            assert.equal(chunks.join(""), "ok");
            assert.equal(usage?.completion_tokens, 1);
            assert.equal(platformCostEnvelopeSnapshot()?.roles.text?.used, 2);
          });
          assert.equal(captured.length, 2);
          const first = captured[0]!.body as Record<string, unknown>;
          const second = captured[1]!.body as Record<string, unknown>;
          assert.equal(first.stream, true);
          assert.equal(first.max_tokens, 8_192);
          assert.equal(first.enable_thinking, false);
          assert.equal(second.stream, false);
          assert.equal(second.max_tokens, 8_192);
          assert.equal(second.enable_thinking, false);
        },
      );
    },
  ],
  [
    "chatStream: style.rewrite budget 1 blocks the fallback physical request",
    async () => {
      await withFakeFetch(
        (request) => {
          const body = request.body as Record<string, unknown> | undefined;
          assert.equal(body?.stream, true);
          return new Response("stream unavailable", {
            status: 500,
            headers: { "content-type": "text/plain" },
          });
        },
        async () => {
          const config = makeRuntime();
          let snapshot: PlatformCostEnvelopeSnapshot | undefined;
          await rejectEnvelopeCode(
            runInCostEnvelope(config, "style.rewrite", async () => {
              const result = chatStream(
                config.text,
                [{ role: "user", content: "hello" }],
                { tag: "platform-stream-budget" },
              );
              try {
                for await (const chunk of result.textStream) {
                  // The stream failed before any output, so no chunk is valid.
                  assert.fail(`unexpected chunk after stream failure: ${chunk}`);
                }
              } catch (error) {
                snapshot = platformCostEnvelopeSnapshot();
                await result.usage;
                throw error;
              }
            }),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
          // Only the first (streaming) physical request happened.
          assert.equal(captured.length, 1);
          assert.equal(snapshot?.roles.text?.used, 1);
          assert.equal(
            snapshot?.violation?.code,
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        },
      );
    },
  ],
  [
    "image: every physical retry consumes an image attempt",
    async () => {
      await withFakeFetch(
        (request) => {
          assert.equal(
            request.url,
            `${DASHSCOPE_BASE}/services/aigc/multimodal-generation/generation`,
          );
          const body = request.body as {
            input: { messages: Array<{ content: Array<{ text: string }> }> };
            parameters: { n: number };
          };
          assert.equal(body.parameters.n, 1);
          assert.equal(body.input.messages[0]!.content[0]!.text, "scene prompt");
          if (captured.length === 1) {
            // Retryable response; retry-after 0 keeps the test instant.
            return jsonResponse(
              { error: { message: "rate limited" } },
              429,
              { "retry-after": "0" },
            );
          }
          return jsonResponse({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: "https://img.test/scene.png" }],
                  },
                },
              ],
            },
          });
        },
        async () => {
          const config = makeRuntime();
          await runInCostEnvelope(config, "style.redraw", async () => {
            const result = await generateImage(config.image, "scene prompt", {
              retries: 1,
            });
            assert.equal(result.imageUrl, "https://img.test/scene.png");
            assert.equal(platformCostEnvelopeSnapshot()?.roles.image?.used, 2);
          });
          assert.equal(captured.length, 2);
        },
      );
    },
  ],
  [
    "image: physical retries stop at the style.redraw cap of 4",
    async () => {
      await withFakeFetch(
        () =>
          jsonResponse(
            { error: { message: "rate limited" } },
            429,
            { "retry-after": "0" },
          ),
        async () => {
          const config = makeRuntime();
          let snapshot: PlatformCostEnvelopeSnapshot | undefined;
          await rejectEnvelopeCode(
            runInCostEnvelope(config, "style.redraw", async () => {
              await assert.rejects(
                generateImage(config.image, "cap prompt", { retries: 3 }),
                /DashScope Image API error/,
              );
              await assert.rejects(
                generateImage(config.image, "cap prompt", { retries: 0 }),
                (error: unknown) =>
                  isEnvelopeCode(
                    error,
                    "PLATFORM_COST_ENVELOPE_EXHAUSTED",
                  ),
              );
              // Capture AFTER the exhausted attempt so the sticky violation
              // is visible in the snapshot.
              snapshot = platformCostEnvelopeSnapshot();
            }),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
          // Exactly 4 physical fetches; the 5th call was rejected pre-fetch.
          assert.equal(captured.length, 4);
          assert.equal(snapshot?.roles.image?.used, 4);
          assert.equal(
            snapshot?.violation?.code,
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        },
      );
    },
  ],
  [
    "vision: actual request carries sibling max_pixels, high-res false, max_tokens 4096",
    async () => {
      await withFakeFetch(
        (request) => {
          assert.equal(request.url, `${COMPATIBLE_BASE}/chat/completions`);
          return jsonResponse(COMPLETION);
        },
        async () => {
          const config = makeRuntime();
          const imageDataUrl = "data:image/png;base64,aGVsbG8=";
          await runInCostEnvelope(config, "vision.decide", async () => {
            const text = await analyzeImageDataUrl(
              config.vision,
              imageDataUrl,
              "describe the scene",
            );
            assert.equal(text, "ok");
            assert.equal(platformCostEnvelopeSnapshot()?.roles.vision?.used, 1);
          });
          assert.equal(captured.length, 1);
          const body = captured[0]!.body as {
            max_tokens?: number;
            vl_high_resolution_images?: boolean;
            messages: Array<{
              content: Array<{
                type: string;
                max_pixels?: number;
                image_url?: { url: string; max_pixels?: number };
              }>;
            }>;
          };
          assert.equal(body.max_tokens, 4_096);
          assert.equal(body.vl_high_resolution_images, false);
          const imagePart = body.messages[0]!.content.find(
            (part) => part.type === "image_url",
          );
          assert.ok(imagePart, "missing image_url content part");
          // max_pixels is a SIBLING of type/image_url, never nested inside it.
          assert.equal(imagePart.max_pixels, 262_144);
          assert.equal(imagePart.image_url?.url, imageDataUrl);
          assert.equal(
            Object.prototype.hasOwnProperty.call(
              imagePart.image_url,
              "max_pixels",
            ),
            false,
          );
        },
      );
    },
  ],
  [
    "TTS: wrong voice provider and wrong model are rejected pre-dispatch",
    async () => {
      await withFakeFetch(
        () => {
          throw new Error("TTS mismatch must not issue a fetch");
        },
        async () => {
          const providerConfig = makeRuntime();
          await rejectEnvelopeCode(
            runInCostEnvelope(providerConfig, "tts.beat", async () => {
              await synthesize(
                providerConfig.tts!,
                {
                  provider: "xiaomi",
                  referenceAudioBase64: "AAAA",
                  mimeType: "audio/wav",
                },
                "hello",
              );
            }),
            "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
          );
          assert.equal(captured.length, 0);

          const modelConfig = makeRuntime();
          await rejectEnvelopeCode(
            runInCostEnvelope(modelConfig, "tts.beat", async () => {
              await synthesize(
                modelConfig.tts!,
                {
                  provider: "bailian",
                  voiceId: "Cherry",
                  model: "qwen3-tts-flash-v2",
                  mimeType: "audio/wav",
                },
                "hello",
              );
            }),
            "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
          );
          assert.equal(captured.length, 0);
        },
      );
    },
  ],
  [
    "TTS: 1001 characters is rejected before fetch",
    async () => {
      await withFakeFetch(
        () => {
          throw new Error("oversize TTS must not issue a fetch");
        },
        async () => {
          const config = makeRuntime();
          await rejectEnvelopeCode(
            runInCostEnvelope(config, "tts.beat", async () => {
              await synthesize(
                config.tts!,
                {
                  provider: "bailian",
                  voiceId: "Cherry",
                  model: "qwen3-tts-flash",
                  mimeType: "audio/wav",
                },
                "字".repeat(1_001),
              );
            }),
            "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
          );
          assert.equal(captured.length, 0);
        },
      );
    },
  ],
  [
    "TTS: valid 1000 character request sends the observed payload",
    async () => {
      await withFakeFetch(
        (request) => {
          if (request.url === TTS_AUDIO_URL) {
            return new Response(new Uint8Array([1, 2, 3, 4]), {
              status: 200,
              headers: { "content-type": "audio/wav" },
            });
          }
          assert.equal(
            request.url,
            `${DASHSCOPE_BASE}/services/aigc/multimodal-generation/generation`,
          );
          return jsonResponse({ output: { audio: { url: TTS_AUDIO_URL } } });
        },
        async () => {
          const config = makeRuntime();
          const text = "字".repeat(1_000);
          await runInCostEnvelope(config, "tts.beat", async () => {
            const result = await synthesize(
              config.tts!,
              {
                provider: "bailian",
                voiceId: "Cherry",
                model: "qwen3-tts-flash",
                mimeType: "audio/wav",
              },
              text,
            );
            assert.equal(result.mimeType, "audio/wav");
            assert.ok(result.audioBase64.length > 0);
            assert.equal(platformCostEnvelopeSnapshot()?.roles.tts?.used, 1);
          });
          assert.equal(captured.length, 2);
          const body = captured[0]!.body as {
            model: string;
            input: { text: string; voice: string };
          };
          assert.equal(body.model, "qwen3-tts-flash");
          assert.equal(body.input.text.length, 1_000);
          assert.equal(body.input.voice, "Cherry");
          assert.equal(captured[1]!.url, TTS_AUDIO_URL);
        },
      );
    },
  ],
  [
    "BYOK: outside a platform scope, chat and vision carry no envelope caps",
    async () => {
      await withFakeFetch(
        () => jsonResponse(COMPLETION),
        async () => {
          const config = makeRuntime();
          const text = await chat(
            config.text,
            [{ role: "user", content: "hello" }],
            { tag: "byok-chat" },
          );
          assert.equal(text, "ok");
          const chatBody = captured[0]!.body as Record<string, unknown>;
          assert.equal("max_tokens" in chatBody, false);
          assert.equal("enable_thinking" in chatBody, false);

          const visionText = await analyzeImageDataUrl(
            config.vision,
            "data:image/png;base64,aGVsbG8=",
            "byok vision",
          );
          assert.equal(visionText, "ok");
          const visionBody = captured[1]!.body as {
            max_tokens?: number;
            vl_high_resolution_images?: boolean;
            messages: Array<{
              content: Array<{ type: string; max_pixels?: number }>;
            }>;
          };
          assert.equal("max_tokens" in visionBody, false);
          assert.equal("vl_high_resolution_images" in visionBody, false);
          const imagePart = visionBody.messages[0]!.content.find(
            (part) => part.type === "image_url",
          );
          assert.ok(imagePart);
          assert.equal("max_pixels" in imagePart, false);
          assert.equal(captured.length, 2);
        },
      );
    },
  ],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} adapter test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${tests.length} adapter test(s) passed.`);
  }
}

void main();
