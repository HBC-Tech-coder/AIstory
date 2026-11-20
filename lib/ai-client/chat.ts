import OpenAI from "openai";
import type { ChatStreamResult, ChatStreamUsage, ProviderConfig } from "@infiplot/types";
import {
  beginPlatformTextRequest,
  type PlatformTextRequestPlan,
} from "../billing/platformCostEnvelope";
import { normalizeBaseUrl } from "./normalizeUrl";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// ── CORS proxy fallback (browser-only) ───────────────────────────────
// BYO mode calls providers directly from the browser. When a provider
// rejects the preflight (no CORS headers), the first request throws a
// TypeError. We cache the blocked host and transparently reroute all
// subsequent requests through /api/llm/user-proxy, which forwards
// server-side and returns the upstream response (including SSE streams)
// byte-for-byte.

const corsBlockedHosts = new Set<string>();

export function isCorsProxied(baseUrl: string): boolean {
  try {
    return corsBlockedHosts.has(new URL(baseUrl).host);
  } catch {
    return false;
  }
}

function proxyFetch(
  config: ProviderConfig,
  init?: RequestInit,
): Promise<Response> {
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { /* empty */ }
  }
  return globalThis.fetch("/api/llm/user-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      body,
      model: config.model,
      stream: body.stream === true,
    }),
  });
}

function makeCorsAwareFetch(
  config: ProviderConfig,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : input.url;

    let host: string;
    try { host = new URL(url).host; } catch { return globalThis.fetch(input, init); }

    if (corsBlockedHosts.has(host)) {
      return proxyFetch(config, init);
    }

    try {
      return await globalThis.fetch(input, init);
    } catch (err) {
      if (err instanceof TypeError) {
        corsBlockedHosts.add(host);
        console.warn(`[CORS] ${host} blocked, falling back to server proxy`);
        return proxyFetch(config, init);
      }
      throw err;
    }
  };
}

// Cache observability for the prompt-prefix caching that the Writer stable
// prefix relies on. The OpenAI usage object reports only cached READS
// (prompt_tokens_details.cached_tokens) and has no field for cache WRITES
// (tokens written to the cache on a cold pass), so unlike the old AI SDK
// path we can show the hit rate but not the create cost. cached_tokens lives
// directly on the SDK's CompletionUsage type — no cast needed.
function summarizeSdkUsage(
  tag: string,
  usage: OpenAI.Completions.CompletionUsage | undefined,
): string {
  if (!usage) return `[cache] ${tag} no-usage`;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") {
    const rate = input > 0 ? ((cached / input) * 100).toFixed(1) : "n/a";
    return `[cache] ${tag} hit=${cached} input=${input} rate=${rate}% completion=${output}`;
  }
  return `[cache] ${tag} input=${input} completion=${output} (provider didn't report cache stats)`;
}

function makeClient(
  config: ProviderConfig,
  allowServerProxyFallback = true,
): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: normalizeBaseUrl(config.baseUrl, "openai_compatible"),
    maxRetries: 0,
    dangerouslyAllowBrowser: true,
    ...(typeof window !== "undefined"
      ? {
          fetch: allowServerProxyFallback
            ? makeCorsAwareFetch(config)
            : globalThis.fetch,
        }
      : {}),
  });
}

/**
 * Platform cost envelope payload: caps output tokens and disables provider
 * thinking. Outside a platform scope this is empty, so BYOK requests are
 * byte-for-byte unchanged.
 */
function platformPlanFields(
  plan: PlatformTextRequestPlan | undefined,
): { max_tokens?: number; enable_thinking?: boolean } {
  return plan
    ? { max_tokens: plan.maxTokens, enable_thinking: plan.enableThinking }
    : {};
}

export async function chat(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    tag?: string;
    /** Keep BYOK keys entirely in the browser; CORS failures surface to UI. */
    allowServerProxyFallback?: boolean;
  },
): Promise<string> {
  // Consumes one platform attempt synchronously, before any HTTP request.
  // Returns undefined for BYOK / unbound config, which leaves the call unchanged.
  const platformPlan = beginPlatformTextRequest(config, messages);
  const client = makeClient(config, opts?.allowServerProxyFallback !== false);

  const completion = await client.chat.completions.create({
    model: config.model,
    messages: messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    })),
    temperature: opts?.temperature ?? 0.9,
    stream: false,
    ...platformPlanFields(platformPlan),
  });

  const text = completion.choices[0]?.message?.content ?? "";
  console.log(summarizeSdkUsage(opts?.tag ?? "chat", completion.usage ?? undefined));

  if (text.length === 0) {
    throw new Error(`Chat API returned no content.`);
  }
  return text;
}

/**
 * Streaming variant of {@link chat} — the streaming primitive behind
 * paradigm D. Returns incremental `textStream` chunks plus an end-of-stream
 * `usage` promise so `summarizeSdkUsage` keeps doing cache accounting.
 *
 * Uses the OpenAI SDK's native streaming (`stream: true`) which returns an
 * async iterable of ChatCompletionChunk. The returned `usage` settles after
 * the stream drains, so callers should `await result.usage` once iteration
 * ends.
 *
 * Degrade path: if the provider doesn't support streaming, fall back to a
 * single non-streaming call wrapped as a one-chunk stream so downstream
 * tag-routing still works — the player loses progressive playback but the
 * scene generates normally.
 */
export function chatStream(
  config: ProviderConfig,
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    tag?: string;
  },
): ChatStreamResult {
  const client = makeClient(config);
  const tag = opts?.tag ?? "chatStream";
  const msgPayload = messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: m.content,
  }));

  let resolveUsage: (u: ChatStreamUsage | undefined) => void;
  const usage = new Promise<ChatStreamUsage | undefined>((r) => { resolveUsage = r; });

  const textStream = (async function* (): AsyncIterable<string> {
    // One platform attempt per physical request. The streaming request and the
    // non-streaming degrade path each consume separately.
    let platformPlan = beginPlatformTextRequest(config, messages);
    let yieldedAny = false;
    try {
      const stream = await client.chat.completions.create({
        model: config.model,
        messages: msgPayload,
        temperature: opts?.temperature ?? 0.9,
        stream: true,
        stream_options: { include_usage: true },
        ...platformPlanFields(platformPlan),
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          yieldedAny = true;
          yield delta;
        }

        if (chunk.usage) {
          const u: ChatStreamUsage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            prompt_tokens_details: chunk.usage.prompt_tokens_details
              ? { cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens ?? undefined }
              : undefined,
          };
          console.log(summarizeSdkUsage(tag, chunk.usage));
          resolveUsage!(u);
        }
      }
      // If usage was never emitted (provider omitted it), resolve undefined.
      resolveUsage!(undefined);
    } catch (err) {
      if (platformPlan) {
        // In a platform scope, never issue a second physical request after any
        // partial output, and never exceed the shared attempt budget.
        if (yieldedAny) {
          resolveUsage!(undefined);
          throw err;
        }
        try {
          platformPlan = beginPlatformTextRequest(config, messages);
        } catch (budgetErr) {
          resolveUsage!(undefined);
          throw budgetErr;
        }
      }
      // Streaming not supported by provider → degrade to buffered call.
      console.warn(
        `[chatStream] streaming failed, degrading to non-streaming:`,
        err,
      );
      try {
        const completion = await client.chat.completions.create({
          model: config.model,
          messages: msgPayload,
          temperature: opts?.temperature ?? 0.9,
          stream: false,
          ...platformPlanFields(platformPlan),
        });
        const text = completion.choices[0]?.message?.content ?? "";
        if (text) yield text;
        console.log(summarizeSdkUsage(`${tag}:degraded`, completion.usage ?? undefined));
        resolveUsage!(completion.usage ? {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          prompt_tokens_details: completion.usage.prompt_tokens_details
            ? { cached_tokens: completion.usage.prompt_tokens_details.cached_tokens ?? undefined }
            : undefined,
        } : undefined);
      } catch (fallbackErr) {
        resolveUsage!(undefined);
        throw fallbackErr;
      }
    }
  })();

  return { textStream, usage };
}
