import assert from "node:assert/strict";

import {
  assertCostEnvelopeDeliverable,
  assertPlatformOperationScope,
  assertPlatformTtsVoiceBinding,
  beginPlatformImageAttempt,
  beginPlatformTextRequest,
  beginPlatformTtsAttempt,
  beginPlatformVisionRequest,
  platformCostEnvelopeSnapshot,
  PlatformCostEnvelopeError,
  PLATFORM_COST_ENVELOPE_SPEC,
  type PlatformCostEnvelopeErrorCode,
} from "../lib/billing/platformCostEnvelope";
import {
  assertPlatformRuntimeConfig,
  PLATFORM_CANONICAL_PROVIDER_BINDINGS,
  PLATFORM_LIVE_PROVIDER_BINDINGS,
  platformCostEnvelopeFingerprint,
  runInCostEnvelope,
  type PlatformRuntimeConfig,
} from "../lib/billing/platformCostEnvelopeServer";

type BindingSet = {
  text: { provider: string; model: string; baseUrl: string };
  image: { provider: string; model: string; baseUrl: string };
  vision: { provider: string; model: string; baseUrl: string };
  tts: { provider: string; model: string; baseUrl: string };
};

function makeConfig(
  bindings: BindingSet = PLATFORM_CANONICAL_PROVIDER_BINDINGS,
): PlatformRuntimeConfig {
  return {
    text: { ...bindings.text, apiKey: "test-key" },
    image: { ...bindings.image, apiKey: "test-key" },
    vision: { ...bindings.vision, apiKey: "test-key" },
    tts: {
      provider: bindings.tts.provider,
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
      apiKey: "test-key",
    },
  };
}

const USER_MESSAGE = [{ role: "user", content: "hello" }] as const;

function expectCode(
  fn: () => unknown,
  code: PlatformCostEnvelopeErrorCode,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PlatformCostEnvelopeError);
    assert.equal(error.code, code);
    return true;
  });
}

async function rejectCode(
  promise: Promise<unknown>,
  code: PlatformCostEnvelopeErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PlatformCostEnvelopeError);
    assert.equal(error.code, code);
    return true;
  });
}

type Test = readonly [name: string, fn: () => Promise<void> | void];

const tests: Test[] = [
  [
    "BYOK: no active scope leaves all helpers as no-ops",
    () => {
      const config = makeConfig();
      assert.equal(beginPlatformTextRequest(config.text, USER_MESSAGE), undefined);
      assert.equal(
        beginPlatformImageAttempt(config.image, "prompt", {
          count: 1,
          width: 928,
          height: 1664,
        }),
        undefined,
      );
      assert.equal(
        beginPlatformVisionRequest(config.vision, "prompt", { imageCount: 1 }),
        undefined,
      );
      assert.equal(
        beginPlatformTtsAttempt(config.tts!, "hi", "qwen3-tts-flash"),
        undefined,
      );
      assert.equal(platformCostEnvelopeSnapshot(), undefined);
      assert.doesNotThrow(() => assertCostEnvelopeDeliverable());
    },
  ],
  [
    "scope survives awaited/parallel callbacks and caps text at 12",
    async () => {
      const config = makeConfig();
      let snapshot: ReturnType<typeof platformCostEnvelopeSnapshot> | undefined;
      await rejectCode(
        runInCostEnvelope(config, "story.start", async () => {
          const plans = await Promise.all(
            Array.from({ length: 12 }, async () => {
              await Promise.resolve();
              await new Promise((resolve) => setTimeout(resolve, 0));
              return beginPlatformTextRequest(config.text, USER_MESSAGE);
            }),
          );
          assert.equal(plans.length, 12);
          assert.ok(plans.every((plan) => plan?.maxTokens === 8_192));
          assert.ok(plans.every((plan) => plan?.enableThinking === false));
          expectCode(
            () => beginPlatformTextRequest(config.text, USER_MESSAGE),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
          // Capture AFTER the exhausted attempt so the sticky violation is
          // visible. The snapshot itself remains immutable.
          snapshot = platformCostEnvelopeSnapshot();
        }),
        "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      );
      assert.ok(snapshot);
      assert.equal(snapshot.roles.text?.used, 12);
      assert.equal(snapshot.roles.text?.remaining, 0);
      assert.equal(snapshot.violation?.code, "PLATFORM_COST_ENVELOPE_EXHAUSTED");
      assert.ok(Object.isFrozen(snapshot));
    },
  ],
  [
    "sticky violation survives a swallowed error and fails delivery",
    async () => {
      const config = makeConfig();
      let snapshot: ReturnType<typeof platformCostEnvelopeSnapshot> | undefined;
      await rejectCode(
        runInCostEnvelope(config, "style.rewrite", async () => {
          beginPlatformTextRequest(config.text, USER_MESSAGE);
          // Engine/director swallows the budget error...
          try {
            beginPlatformTextRequest(config.text, USER_MESSAGE);
          } catch {
            // ...and produces a fallback.
          }
          snapshot = platformCostEnvelopeSnapshot();
          // Gate still refuses delivery.
          expectCode(
            () => assertCostEnvelopeDeliverable(),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
          // Even re-entry cannot clear budget.
          expectCode(
            () => beginPlatformTextRequest(config.text, USER_MESSAGE),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      );
      assert.equal(snapshot?.violation?.code, "PLATFORM_COST_ENVELOPE_EXHAUSTED");
    },
  ],
  [
    "failed attempts are consumed and never restored",
    async () => {
      const config = makeConfig();
      let snapshot: ReturnType<typeof platformCostEnvelopeSnapshot> | undefined;
      await rejectCode(
        runInCostEnvelope(config, "style.redraw", async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            beginPlatformImageAttempt(config.image, "retry", {
              width: 928,
              height: 1664,
            });
            // Simulated provider failure — the attempt is already spent.
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            beginPlatformImageAttempt(config.image, "retry", {
              width: 928,
              height: 1664,
            });
          }
          snapshot = platformCostEnvelopeSnapshot();
          expectCode(
            () =>
              beginPlatformImageAttempt(config.image, "retry", {
                width: 928,
                height: 1664,
              }),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      );
      assert.equal(snapshot?.roles.image?.used, 4);
    },
  ],
  [
    "oversize image shape is rejected before consuming",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "style.redraw", async () => {
          expectCode(
            () =>
              beginPlatformImageAttempt(config.image, "too big", {
                count: 1,
                width: 1664,
                height: 1664,
              }),
            "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
          );
        }),
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      );

      const clean = makeConfig();
      await runInCostEnvelope(clean, "style.redraw", async () => {
        beginPlatformImageAttempt(clean.image, "ok", {
          count: 1,
          width: 928,
          height: 1664,
        });
        assert.equal(platformCostEnvelopeSnapshot()?.roles.image?.used, 1);
      });
    },
  ],
  [
    "config mutation and endpoint drift are caught on every call",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "style.rewrite", async () => {
          config.text.model = "qwen-max";
          expectCode(
            () => beginPlatformTextRequest(config.text, USER_MESSAGE),
            "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED",
      );

      const endpointConfig = makeConfig();
      await rejectCode(
        runInCostEnvelope(endpointConfig, "style.rewrite", async () => {
          endpointConfig.text.baseUrl =
            "https://evil.example.com/compatible-mode/v1";
          expectCode(
            () => beginPlatformTextRequest(endpointConfig.text, USER_MESSAGE),
            "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_CONFIG_MUTATED",
      );
    },
  ],
  [
    "model override via a different config object fails closed",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "style.rewrite", async () => {
          const override = { ...config.text, model: "qwen-max" };
          expectCode(
            () => beginPlatformTextRequest(override, USER_MESSAGE),
            "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG",
          );
        }),
        "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG",
      );
    },
  ],
  [
    "authorized live endpoint binds; wildcard/other hosts are rejected",
    async () => {
      const live = makeConfig(PLATFORM_LIVE_PROVIDER_BINDINGS);
      await runInCostEnvelope(live, "style.rewrite", async () => {
        const plan = beginPlatformTextRequest(live.text, USER_MESSAGE);
        assert.equal(plan?.maxTokens, 8_192);
      });

      const wildcard = makeConfig();
      wildcard.text.baseUrl =
        "https://anything.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
      await assert.rejects(
        runInCostEnvelope(wildcard, "style.rewrite", () => undefined),
        (error: unknown) => {
          assert.ok(error instanceof PlatformCostEnvelopeError);
          assert.equal(error.code, "PLATFORM_COST_ENVELOPE_CONFIG_INVALID");
          return true;
        },
      );
    },
  ],
  [
    "atomic bind: invalid allowlist rejects before the callback runs",
    async () => {
      const config = makeConfig();
      config.vision.model = "qwen-vl-max";
      let called = false;
      await assert.rejects(
        runInCostEnvelope(config, "story.start", () => {
          called = true;
        }),
        (error: unknown) => {
          assert.ok(error instanceof PlatformCostEnvelopeError);
          assert.equal(error.code, "PLATFORM_COST_ENVELOPE_CONFIG_INVALID");
          return true;
        },
      );
      assert.equal(called, false);
    },
  ],
  [
    "same config object for text and vision is rejected",
    () => {
      const config = makeConfig();
      (config as unknown as { vision: unknown }).vision = config.text;
      assert.throws(
        () => assertPlatformRuntimeConfig(config),
        PlatformCostEnvelopeError,
      );
    },
  ],
  [
    "rebinding and nesting are rejected",
    async () => {
      const config = makeConfig();
      await runInCostEnvelope(config, "style.rewrite", async () => {
        await assert.rejects(
          runInCostEnvelope(config, "style.rewrite", () => undefined),
          (error: unknown) => {
            assert.ok(error instanceof PlatformCostEnvelopeError);
            assert.equal(error.code, "PLATFORM_COST_ENVELOPE_NESTED_SCOPE");
            return true;
          },
        );
        // The rejection did not poison the outer scope.
        beginPlatformTextRequest(config.text, USER_MESSAGE);
      });
    },
  ],
  [
    "parallel scopes do not share budgets",
    async () => {
      const config = makeConfig();
      const exhausted = runInCostEnvelope(config, "style.rewrite", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        beginPlatformTextRequest(config.text, USER_MESSAGE);
        expectCode(
          () => beginPlatformTextRequest(config.text, USER_MESSAGE),
          "PLATFORM_COST_ENVELOPE_EXHAUSTED",
        );
      });
      const healthy = runInCostEnvelope(config, "style.rewrite", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        beginPlatformTextRequest(config.text, USER_MESSAGE);
        assert.equal(platformCostEnvelopeSnapshot()?.roles.text?.used, 1);
      });
      await rejectCode(exhausted, "PLATFORM_COST_ENVELOPE_EXHAUSTED");
      await healthy;
    },
  ],
  [
    "unknown operation is rejected",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "unknown.operation" as never, () => undefined),
        "PLATFORM_COST_ENVELOPE_UNKNOWN_OPERATION",
      );
    },
  ],
  [
    "role not in the operation envelope is unbound",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "style.rewrite", async () => {
          expectCode(
            () =>
              beginPlatformImageAttempt(config.image, "prompt", {
                width: 928,
                height: 1664,
              }),
            "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG",
          );
        }),
        "PLATFORM_COST_ENVELOPE_UNBOUND_CONFIG",
      );
    },
  ],
  [
    "vision bounds and single attempt",
    async () => {
      const oversize = makeConfig();
      await rejectCode(
        runInCostEnvelope(oversize, "vision.decide", async () => {
          expectCode(
            () =>
              beginPlatformVisionRequest(oversize.vision, "prompt", {
                imageCount: 1,
                imageBytes: 3 * 1024 * 1024 + 1,
              }),
            "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
          );
        }),
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      );

      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "vision.decide", async () => {
          const plan = beginPlatformVisionRequest(config.vision, "prompt", {
            imageCount: 1,
            imageBytes: 3 * 1024 * 1024,
          });
          assert.equal(plan?.maxTokens, 4_096);
          assert.equal(plan?.maxPixels, 262_144);
          assert.equal(plan?.highResolutionImages, false);
          expectCode(
            () =>
              beginPlatformVisionRequest(config.vision, "prompt", {
                imageCount: 1,
              }),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      );
    },
  ],
  [
    "vision envelope pins the 3 MiB / 262144 px / 129024 token bounds",
    () => {
      assert.equal(PLATFORM_COST_ENVELOPE_SPEC.vision.maxImageBytes, 3 * 1024 * 1024);
      assert.equal(PLATFORM_COST_ENVELOPE_SPEC.vision.maxPixels, 262_144);
      assert.equal(
        PLATFORM_COST_ENVELOPE_SPEC.vision.maxBillableInputTokens,
        129_024,
      );
      assert.equal(PLATFORM_COST_ENVELOPE_SPEC.vision.maxImages, 1);
      assert.equal(PLATFORM_COST_ENVELOPE_SPEC.vision.maxOutputTokens, 4_096);
    },
  ],
  [
    "TTS voice mismatch is rejected before fallback; attempts capped",
    async () => {
      const mismatch = makeConfig();
      await rejectCode(
        runInCostEnvelope(mismatch, "tts.beat", async () => {
          expectCode(
            () => assertPlatformTtsVoiceBinding(mismatch.tts, "xiaomi", undefined),
            "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
          );
        }),
        "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
      );

      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "tts.beat", async () => {
          expectCode(
            () =>
              assertPlatformTtsVoiceBinding(
                config.tts,
                "bailian",
                "qwen3-tts-flash-v2",
              ),
            "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
          );
        }),
        "PLATFORM_COST_ENVELOPE_VOICE_MISMATCH",
      );

      const good = makeConfig();
      await rejectCode(
        runInCostEnvelope(good, "tts.beat", async () => {
          assertPlatformTtsVoiceBinding(good.tts, "bailian", "qwen3-tts-flash");
          beginPlatformTtsAttempt(good.tts, "hello", "qwen3-tts-flash");
          expectCode(
            () => beginPlatformTtsAttempt(good.tts, "hello", "qwen3-tts-flash"),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      );
    },
  ],
  [
    "zero-attempt TTS role on story.start blocks synthesis",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "story.start", async () => {
          expectCode(
            () => beginPlatformTtsAttempt(config.tts, "hello", "qwen3-tts-flash"),
            "PLATFORM_COST_ENVELOPE_EXHAUSTED",
          );
        }),
        "PLATFORM_COST_ENVELOPE_EXHAUSTED",
      );
    },
  ],
  [
    "text input byte cap is enforced before consuming",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "style.rewrite", async () => {
          const tooLarge = [{ role: "user", content: "x".repeat(64_001) }];
          expectCode(
            () => beginPlatformTextRequest(config.text, tooLarge),
            "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
          );
        }),
        "PLATFORM_COST_ENVELOPE_REQUEST_TOO_LARGE",
      );
    },
  ],
  [
    "operation scope assert helper",
    async () => {
      const config = makeConfig();
      await rejectCode(
        runInCostEnvelope(config, "style.rewrite", async () => {
          assertPlatformOperationScope("style.rewrite");
          expectCode(
            () => assertPlatformOperationScope("tts.beat"),
            "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH",
          );
        }),
        "PLATFORM_COST_ENVELOPE_ROLE_MISMATCH",
      );
    },
  ],
  [
    "envelope fingerprint changes when a limit changes",
    () => {
      const baseline = platformCostEnvelopeFingerprint(
        PLATFORM_COST_ENVELOPE_SPEC,
      );
      assert.match(baseline, /^sha256:[a-f0-9]{64}$/);
      const altered = {
        ...PLATFORM_COST_ENVELOPE_SPEC,
        text: { ...PLATFORM_COST_ENVELOPE_SPEC.text, maxOutputTokens: 4_096 },
      };
      assert.notEqual(platformCostEnvelopeFingerprint(altered), baseline);
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
    console.error(`\n${failed} envelope test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${tests.length} envelope test(s) passed.`);
  }
}

void main();

