import OpenAI from "openai";
import type { ProviderConfig } from "@infiplot/types";
import { beginPlatformVisionRequest } from "../billing/platformCostEnvelope";
import { normalizeBaseUrl } from "./normalizeUrl";

const VISION_TIMEOUT_MS = 60_000;

/**
 * Typed structural view of the chat-completions request. The OpenAI SDK type
 * does not model DashScope's `max_pixels` image-content-part field or the
 * `vl_high_resolution_images` provider parameter, so the request is built as
 * this intermediate object and cast once at the SDK boundary. BYOK requests
 * never populate the platform-only fields.
 */
type VisionRequestContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string };
      /** Sibling of `type`/`image_url` — never nested inside `image_url`. */
      max_pixels?: number;
    };

type VisionChatRequest = {
  model: string;
  messages: Array<{ role: "user"; content: VisionRequestContentPart[] }>;
  temperature: number;
  stream: false;
  max_tokens?: number;
  /** `false` is required or the provider ignores `max_pixels`. */
  vl_high_resolution_images?: boolean;
};

/** Bytes backing a `data:<mime>;base64,...` URL, without decoding it. */
function estimateDataUrlBytes(imageDataUrl: string): number {
  const comma = imageDataUrl.indexOf(",");
  const payload = comma >= 0 ? imageDataUrl.slice(comma + 1) : imageDataUrl;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export async function interpretClick(
  config: ProviderConfig,
  imageBase64: string,
  prompt: string,
): Promise<string> {
  return analyzeImageDataUrl(
    config,
    `data:image/png;base64,${imageBase64}`,
    prompt,
  );
}

export async function analyzeImageDataUrl(
  config: ProviderConfig,
  imageDataUrl: string,
  prompt: string,
): Promise<string> {
  // Platform scope: validate image/prompt bounds and consume one vision
  // attempt synchronously before the HTTP request. BYOK returns undefined.
  const platformPlan = beginPlatformVisionRequest(config, prompt, {
    imageCount: 1,
    imageBytes: estimateDataUrlBytes(imageDataUrl),
  });
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: normalizeBaseUrl(config.baseUrl, "openai_compatible"),
    maxRetries: 0,
    timeout: VISION_TIMEOUT_MS,
    dangerouslyAllowBrowser: true,
  });

  const imagePart: VisionRequestContentPart = platformPlan
    ? {
        type: "image_url",
        image_url: { url: imageDataUrl },
        max_pixels: platformPlan.maxPixels,
      }
    : { type: "image_url", image_url: { url: imageDataUrl } };

  const request: VisionChatRequest = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, imagePart],
      },
    ],
    temperature: 0.2,
    stream: false,
    ...(platformPlan
      ? {
          max_tokens: platformPlan.maxTokens,
          vl_high_resolution_images: platformPlan.highResolutionImages,
        }
      : {}),
  };

  const completion = await client.chat.completions.create(
    request as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );

  const text = completion.choices[0]?.message?.content ?? "";
  if (text.length === 0) {
    throw new Error(`Vision API returned no content.`);
  }
  return text;
}
