// Browser-safe request-budget envelope for platform-managed provider calls.
//
// IMPORTANT: this module is imported by the browser-capable AI/TTS adapters,
// therefore it MUST NOT import `node:*` or `server-only`. The AsyncLocalStorage
// reader is installed by `platformCostEnvelopeServer.ts` through
// `installPlatformCostEnvelopeReader`.
//
// Semantics:
//   * No active platform scope  -> every helper returns `undefined` and the
//     adapter keeps its original BYOK behavior.
//   * Active platform scope     -> every helper validates the exact config
//     object, enforces physical request caps, then consumes one attempt
//     synchronously BEFORE the adapter issues the HTTP request.
//   * Attempts never come back. Retries, hedges and stream fallbacks each
//     consume a fresh attempt, and exhaustion throws before any fetch.

export const PLATFORM_COST_ENVELOPE_SCHEMA =
  "aistory.platform-cost-envelope/v1" as const;
export const PLATFORM_COST_ENVELOPE_VERSION =
  "platform-cost-envelope-v1" as const;

/** The only billable platform operations. Keep exactly 11 entries. */
export const PLATFORM_COST_OPERATIONS = [
  "story.start",
  "story.scene",
  "story.scene.prefetch",
  "vision.decide",
  "story.classify-freeform",
  "story.insert-beat",
  "style.redraw",
  "style.rewrite",
  "vision.style-parse",
  "text.character-names",
  "tts.beat",
] as const;

export type PlatformOperation = (typeof PLATFORM_COST_OPERATIONS)[number];

export const PLATFORM_COST_ROLES = [
  "text",
  "image",
  "vision",
  "tts",
] as const;

export type PlatformCostRole = (typeof PLATFORM_COST_ROLES)[number];

// ── Physical per-attempt limits ────────────────────────────────────────
// These are request SHAPE bounds, not prices. Cost pricing (see
// `costBetaPricing.ts`) prices the worst case these bounds allow.

export const PLATFORM_TEXT_LIMITS = Object.freeze({
  maxInputBytes: 64_000,
  maxMessages: 64,
  messageOverheadBytes: 64,
  maxOutputTokens: 8_192,
});

export const PLATFORM_IMAGE_LIMITS = Object.freeze({
  maxOutputImages: 1,
  maxWidth: 1_664,
  maxHeight: 1_664,
  maxPixels: 1_544_192,
  maxPromptBytes: 16_000,
});

export const PLATFORM_VISION_LIMITS = Object.freeze({
  maxImages: 1,
  /**
   * One image per request. Images are downsampled by the provider to this many
   * pixels (the official qwen-vl-plus image-content-part `max_pixels` value);
   * at the official 32×32 px/token rule this bounds image tokens to
   * floor(262,144 / 1,024) + 2 = 258.
   */
  maxPixels: 262_144,
  /** Largest accepted image data URL payload, decoded: 3 MiB. */
  maxImageBytes: 3 * 1024 * 1024,
  maxPromptBytes: 16_000,
  maxOutputTokens: 4_096,
  /**
   * Official qwen-vl-plus model context ceiling for a whole request. Pricing
   * reserves this many input tokens (image + prompt together), never the
   * prompt and image counts added separately.
   */
  maxBillableInputTokens: 129_024,
});

export const PLATFORM_TTS_LIMITS = Object.freeze({
  /** Raw codepoints accepted for one synthesis request. */
  maxCharacters: 1_000,
  /** Worst-case codepoint weight used for pricing (2x). */
  pricingCharacterWeight: 2,
  /** Characters priced per attempt: maxCharacters * pricingCharacterWeight. */
  maxPricedCharacters: 2_000,
  maxBytes: 8_000,
});

/**
 * Total attempts per role for one platform operation. A role absent from an
 * operation (e.g. `vision` on `story.start`) is unbound and any call for it
 * fails closed. A present zero means "valid config, zero attempts".
 */
export const PLATFORM_COST_ROLE_ATTEMPT_CAPS: Readonly<
  Record<
    PlatformOperation,
    Readonly<Partial<Record<PlatformCostRole, number>>>
  >
> = Object.freeze({
  "story.start": Object.freeze({ text: 12, image: 6, tts: 0 }),
  "story.scene": Object.freeze({ text: 10, image: 6, tts: 0 }),
  "story.scene.prefetch": Object.freeze({ text: 10, image: 6, tts: 0 }),
  "vision.decide": Object.freeze({ vision: 1 }),
  "story.classify-freeform": Object.freeze({ text: 1 }),
  "story.insert-beat": Object.freeze({ text: 1 }),
  "style.redraw": Object.freeze({ image: 4 }),
  "style.rewrite": Object.freeze({ text: 1 }),
  "vision.style-parse": Object.freeze({ vision: 1 }),
  "text.character-names": Object.freeze({ text: 1 }),
  "tts.beat": Object.freeze({ tts: 1 }),
});

export const PLATFORM_COST_ENVELOPE_SPEC = Object.freeze({
  schema: PLATFORM_COST_ENVELOPE_SCHEMA,
  version: PLATFORM_COST_ENVELOPE_VERSION,
  text: PLATFORM_TEXT_LIMITS,
  image: PLATFORM_IMAGE_LIMITS,
  vision: PLATFORM_VISION_LIMITS,
  tts: PLATFORM_TTS_LIMITS,
  operations: PLATFORM_COST_ROLE_ATTEMPT_CAPS,
});

export type PlatformCostEnvelopeErrorCode =
  | "PLATFORM_COST_ENVELOPE_NOT_INSTALLED"
  | "PLATFORM_COST_ENVELOPE_UNKNOWN_OPERATION"
  | "PLATFORM_COST_ENVELOPE_CONFIG_INVALID"
  | "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG"
  | "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH"
  | "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED"
  | "PLATFORM_COST_ENVELOPE_EXHAUSTED"
  | "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE"
  | "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH"
  | "PLATFORM_COST_ENVELOPE_NESTED_SCOPE";

export class PlatformCostEnvelopeError extends Error {
  readonly code: PlatformCostEnvelopeErrorCode;

  constructor(code: PlatformCostEnvelopeErrorCode, message: string) {
    super(message);
    this.name = "PlatformCostEnvelopeError";
    this.code = code;
  }
}

function fail(
  code: PlatformCostEnvelopeErrorCode,
  message: string,
): never {
  throw new PlatformCostEnvelopeError(code, message);
}

/** Records the FIRST violation on the scope, then throws it. Sticky forever. */
function failInScope(
  scope: PlatformCostEnvelopeScope,
  code: PlatformCostEnvelopeErrorCode,
  message: string,
): never {
  if (!scope.violation) {
    scope.violation = Object.freeze({ code, message });
  }
  throw new PlatformCostEnvelopeError(code, message);
}

// ── Scope contract shared with the server module ───────────────────────

export type PlatformCostEnvelopeViolation = Readonly<{
  code: PlatformCostEnvelopeErrorCode;
  message: string;
}>;

export type PlatformBoundRole = {
  readonly role: PlatformCostRole;
  /** The exact runtime config object that was bound. */
  readonly config: object;
  readonly provider: string;
  readonly baseUrl: string;
  /** Model for text/image/vision, `speechModel` for TTS. */
  readonly model: string;
  readonly maxAttempts: number;
  /** Mutable ONLY inside this process; never exported as a live reference. */
  used: number;
};

export type PlatformCostEnvelopeScope = {
  readonly operation: PlatformOperation;
  readonly envelopeHash: string;
  readonly roles: Readonly<Partial<Record<PlatformCostRole, PlatformBoundRole>>>;
  /**
   * Sticky first violation. Once written it is never cleared, even if the
   * engine swallows the thrown error and retries a fallback. The server
   * wrapper re-throws it after the callback resolves.
   */
  violation?: PlatformCostEnvelopeViolation;
};

export type PlatformCostEnvelopeRoleSnapshot = Readonly<{
  role: PlatformCostRole;
  maxAttempts: number;
  used: number;
  remaining: number;
}>;

export type PlatformCostEnvelopeSnapshot = Readonly<{
  operation: PlatformOperation;
  envelopeHash: string;
  roles: Readonly<
    Partial<Record<PlatformCostRole, PlatformCostEnvelopeRoleSnapshot>>
  >;
  violation: PlatformCostEnvelopeViolation | null;
}>;

type PlatformCostEnvelopeReader = () =>
  | PlatformCostEnvelopeScope
  | undefined;

let platformCostEnvelopeReader: PlatformCostEnvelopeReader | undefined;

/**
 * Called exactly once by the server-only module at import time. The browser
 * build never installs a reader, so helpers stay no-ops there.
 */
export function installPlatformCostEnvelopeReader(
  reader: PlatformCostEnvelopeReader,
): void {
  if (typeof reader !== "function") {
    fail(
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "Platform cost envelope reader must be a function.",
    );
  }
  if (platformCostEnvelopeReader && platformCostEnvelopeReader !== reader) {
    fail(
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "A different platform cost envelope reader is already installed.",
    );
  }
  platformCostEnvelopeReader = reader;
}

export function isPlatformCostEnvelopeInstalled(): boolean {
  return platformCostEnvelopeReader !== undefined;
}

/** Root/gateway guard: refuse to run platform traffic if no scope is wired. */
export function assertPlatformCostEnvelopeInstalled(): void {
  if (!platformCostEnvelopeReader) {
    fail(
      "PLATFORM_COST_ENVELOPE_NOT_INSTALLED",
      "Platform cost envelope reader is not installed; platform provider calls must not run.",
    );
  }
}

export function currentPlatformCostEnvelopeScope():
  | PlatformCostEnvelopeScope
  | undefined {
  return platformCostEnvelopeReader?.();
}

export function assertPlatformOperationScope(
  operation: PlatformOperation,
): PlatformCostEnvelopeScope {
  assertPlatformCostEnvelopeInstalled();
  const scope = currentPlatformCostEnvelopeScope();
  if (!scope) {
    fail(
      "PLATFORM_COST_ENVELOPE_NOT_INSTALLED",
      `No platform cost envelope scope is active for ${operation}.`,
    );
  }
  if (scope.operation !== operation) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH",
      `Active platform cost envelope is ${scope.operation}, not ${operation}.`,
    );
  }
  return scope;
}

// ── Canonical spec text (hash input) ───────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Deterministic text hashed by the server module (no crypto here). */
export function canonicalPlatformCostEnvelopeSpec(
  value: unknown = PLATFORM_COST_ENVELOPE_SPEC,
): string {
  return stableStringify(value);
}

// ── Internal scope resolution ──────────────────────────────────────────

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requireBoundRole(
  config: unknown,
  role: PlatformCostRole,
): { scope: PlatformCostEnvelopeScope; bound: PlatformBoundRole } | undefined {
  const scope = currentPlatformCostEnvelopeScope();
  if (!scope) return undefined;

  if (scope.violation) {
    // Re-entry after a sticky violation can never succeed or clear budget.
    throw new PlatformCostEnvelopeError(
      scope.violation.code,
      scope.violation.message,
    );
  }

  const bound = PLATFORM_COST_ROLES
    .map((candidate) => scope.roles[candidate])
    .find((candidate) => candidate?.config === config);
  if (!bound) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG",
      `Config object is not bound to the active ${scope.operation} platform cost envelope.`,
    );
  }
  if (bound.role !== role) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH",
      `Config is bound as ${bound.role} but ${role} was requested.`,
    );
  }
  assertBoundConfigIntact(scope, bound);
  return { scope, bound };
}

function assertBoundConfigIntact(
  scope: PlatformCostEnvelopeScope,
  bound: PlatformBoundRole,
): void {
  const config = bound.config as Record<string, unknown>;
  const actualModel =
    bound.role === "tts" ? config.speechModel : config.model;
  if (
    config.provider !== bound.provider
    || config.baseUrl !== bound.baseUrl
    || actualModel !== bound.model
  ) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED",
      `Bound ${bound.role} config was mutated after the envelope was established.`,
    );
  }
}

function consumeAttempt(
  scope: PlatformCostEnvelopeScope,
  bound: PlatformBoundRole,
): void {
  if (bound.used >= bound.maxAttempts) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      `Platform ${bound.role} attempt budget is exhausted.`,
    );
  }
  bound.used += 1;
}

function assertSafePositiveInteger(
  value: unknown,
  field: string,
  scope: PlatformCostEnvelopeScope,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      `${field} must be a positive safe integer.`,
    );
  }
  return value;
}

function assertSafeNonNegativeInteger(
  value: unknown,
  field: string,
  scope: PlatformCostEnvelopeScope,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      `${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

// ── Text boundary ──────────────────────────────────────────────────────

export type PlatformTextRequestPlan = Readonly<{
  maxTokens: number;
  enableThinking: false;
}>;

/**
 * Validate + consume one text attempt, returning the request payload cap.
 * Returns `undefined` outside a platform scope so BYOK is unchanged.
 */
export function beginPlatformTextRequest(
  config: unknown,
  messages: unknown,
): PlatformTextRequestPlan | undefined {
  const hit = requireBoundRole(config, "text");
  if (!hit) return undefined;
  const { scope } = hit;

  if (!Array.isArray(messages) || messages.length < 1) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Text request must contain at least one message.",
    );
  }
  if (messages.length > PLATFORM_TEXT_LIMITS.maxMessages) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Text request exceeds the maximum message count.",
    );
  }
  let inputBytes = 0;
  for (const message of messages) {
    if (message === null || typeof message !== "object") {
      failInScope(
        scope,
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
        "Text messages must be plain objects.",
      );
    }
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      failInScope(
        scope,
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
        "Text message role is invalid.",
      );
    }
    if (typeof record.content !== "string") {
      failInScope(
        scope,
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
        "Text message content must be a string.",
      );
    }
    inputBytes += utf8Bytes(record.content);
  }
  if (inputBytes > PLATFORM_TEXT_LIMITS.maxInputBytes) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Text request exceeds the per-attempt input byte cap.",
    );
  }

  consumeAttempt(scope, hit.bound);
  return Object.freeze({
    maxTokens: PLATFORM_TEXT_LIMITS.maxOutputTokens,
    enableThinking: false as const,
  });
}

// ── Image boundary ─────────────────────────────────────────────────────

export type PlatformImageAttemptOptions = {
  count?: number;
  width?: number;
  height?: number;
};

export type PlatformImageAttemptPlan = Readonly<{ count: 1 }>;

/**
 * Validate image shape and consume one image attempt. The adapter must call
 * this immediately before EVERY physical fetch, including retries.
 */
export function beginPlatformImageAttempt(
  config: unknown,
  prompt: unknown,
  options: PlatformImageAttemptOptions = {},
): PlatformImageAttemptPlan | undefined {
  const hit = requireBoundRole(config, "image");
  if (!hit) return undefined;
  const { scope } = hit;

  if (typeof prompt !== "string") {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "Image prompt must be a string.",
    );
  }
  if (utf8Bytes(prompt) > PLATFORM_IMAGE_LIMITS.maxPromptBytes) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Image prompt exceeds the per-attempt byte cap.",
    );
  }
  const count = options.count === undefined
    ? 1
    : assertSafePositiveInteger(options.count, "image count", scope);
  if (count !== PLATFORM_IMAGE_LIMITS.maxOutputImages) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Platform image requests may return exactly one image per attempt.",
    );
  }
  const width = assertSafePositiveInteger(options.width, "image width", scope);
  const height = assertSafePositiveInteger(options.height, "image height", scope);
  if (
    width > PLATFORM_IMAGE_LIMITS.maxWidth
    || height > PLATFORM_IMAGE_LIMITS.maxHeight
    || width * height > PLATFORM_IMAGE_LIMITS.maxPixels
  ) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Image dimensions exceed the platform envelope.",
    );
  }

  consumeAttempt(scope, hit.bound);
  return Object.freeze({ count: 1 as const });
}

// ── Vision boundary ────────────────────────────────────────────────────

export type PlatformVisionRequestOptions = {
  imageCount?: number;
  imageBytes?: number;
  maxOutputTokens?: number;
};

export type PlatformVisionRequestPlan = Readonly<{
  maxTokens: number;
  /** Provider-side per-image pixel cap (`max_pixels` content-part field). */
  maxPixels: number;
  /** Official qwen-vl-plus switch; without `false`, `max_pixels` is ignored. */
  highResolutionImages: false;
}>;

export function beginPlatformVisionRequest(
  config: unknown,
  prompt: unknown,
  options: PlatformVisionRequestOptions = {},
): PlatformVisionRequestPlan | undefined {
  const hit = requireBoundRole(config, "vision");
  if (!hit) return undefined;
  const { scope } = hit;

  if (typeof prompt !== "string") {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "Vision prompt must be a string.",
    );
  }
  if (utf8Bytes(prompt) > PLATFORM_VISION_LIMITS.maxPromptBytes) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Vision prompt exceeds the per-attempt byte cap.",
    );
  }
  const imageCount = options.imageCount === undefined
    ? 1
    : assertSafeNonNegativeInteger(
        options.imageCount,
        "vision image count",
        scope,
      );
  if (imageCount > PLATFORM_VISION_LIMITS.maxImages) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "Vision request exceeds the maximum image count.",
    );
  }
  if (options.imageBytes !== undefined) {
    const imageBytes = assertSafeNonNegativeInteger(
      options.imageBytes,
      "vision image bytes",
      scope,
    );
    if (imageBytes > PLATFORM_VISION_LIMITS.maxImageBytes) {
      failInScope(
        scope,
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
        "Vision request image exceeds the byte cap.",
      );
    }
  }
  const requestedOutput = options.maxOutputTokens === undefined
    ? PLATFORM_VISION_LIMITS.maxOutputTokens
    : assertSafePositiveInteger(
        options.maxOutputTokens,
        "vision output tokens",
        scope,
      );
  const maxTokens = Math.min(
    requestedOutput,
    PLATFORM_VISION_LIMITS.maxOutputTokens,
  );

  consumeAttempt(scope, hit.bound);
  return Object.freeze({
    maxTokens,
    maxPixels: PLATFORM_VISION_LIMITS.maxPixels,
    highResolutionImages: false as const,
  });
}

// ── TTS boundary ───────────────────────────────────────────────────────

/**
 * Pre-dispatch guard used by `lib/tts-client/index.ts`: rejects a voice that
 * would route outside the bound TTS config before Xiaomi/StepFun fallbacks
 * can escape the platform scope.
 */
export function assertPlatformTtsVoiceBinding(
  config: unknown,
  voiceProvider: unknown,
  voiceModel: unknown,
): void {
  const hit = requireBoundRole(config, "tts");
  if (!hit) return;
  if (
    voiceProvider !== hit.bound.provider
    || voiceModel !== hit.bound.model
  ) {
    failInScope(
      hit.scope,
      "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
      "TTS voice provider/model does not match the bound platform voice.",
    );
  }
}

export type PlatformTtsAttemptPlan = Readonly<{ characters: number }>;

export function beginPlatformTtsAttempt(
  config: unknown,
  text: unknown,
  voiceModel: unknown,
): PlatformTtsAttemptPlan | undefined {
  const hit = requireBoundRole(config, "tts");
  if (!hit) return undefined;
  const { scope } = hit;

  if (typeof text !== "string") {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_CONFIG_INVALID",
      "TTS text must be a string.",
    );
  }
  const characters = Array.from(text).length;
  if (characters > PLATFORM_TTS_LIMITS.maxCharacters) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "TTS request exceeds the per-attempt character cap.",
    );
  }
  if (utf8Bytes(text) > PLATFORM_TTS_LIMITS.maxBytes) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      "TTS request exceeds the per-attempt byte cap.",
    );
  }
  if (voiceModel !== hit.bound.model) {
    failInScope(
      scope,
      "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
      "TTS voice model does not match the bound platform speech model.",
    );
  }

  consumeAttempt(scope, hit.bound);
  return Object.freeze({ characters });
}

// ── Delivery gate / snapshot ───────────────────────────────────────────

/** Current sticky violation for the active scope, if any. */
export function platformCostEnvelopeViolation():
  | PlatformCostEnvelopeViolation
  | undefined {
  return currentPlatformCostEnvelopeScope()?.violation;
}

/**
 * Root/billing gate: throws if the active platform scope recorded any
 * swallowed violation. No-ops outside a platform scope (BYOK).
 */
export function assertCostEnvelopeDeliverable(): void {
  const scope = currentPlatformCostEnvelopeScope();
  if (!scope) return;
  if (scope.violation) {
    throw new PlatformCostEnvelopeError(
      scope.violation.code,
      scope.violation.message,
    );
  }
}

/** Named alias kept for the delivery-gate contract wording. */
export const assertPlatformCostEnvelopeDeliverable =
  assertCostEnvelopeDeliverable;

export function platformCostEnvelopeSnapshot():
  | PlatformCostEnvelopeSnapshot
  | undefined {
  const scope = currentPlatformCostEnvelopeScope();
  if (!scope) return undefined;
  const roles: Partial<Record<PlatformCostRole, PlatformCostEnvelopeRoleSnapshot>> = {};
  for (const role of PLATFORM_COST_ROLES) {
    const bound = scope.roles[role];
    if (!bound) continue;
    roles[role] = Object.freeze({
      role: bound.role,
      maxAttempts: bound.maxAttempts,
      used: bound.used,
      remaining: bound.maxAttempts - bound.used,
    });
  }
  return Object.freeze({
    operation: scope.operation,
    envelopeHash: scope.envelopeHash,
    roles: Object.freeze(roles),
    violation: scope.violation ?? null,
  });
}

