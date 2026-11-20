import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertCostBetaPricingPolicy,
  buildCostBetaPricingCandidate,
  COST_BETA_MIXED_PROVIDER_BINDINGS,
  COST_BETA_PRICING_VERSION_PREFIX,
  CostBetaPricingContractError,
  type CostBetaPricingCandidate,
} from "../lib/billing/costBetaPricing";
import type { FixedBetaRuntimeConfig } from "../lib/billing/fixedBetaPricing";
import {
  PLATFORM_CANONICAL_PROVIDER_BINDINGS,
  PLATFORM_LIVE_PROVIDER_BINDINGS,
} from "../lib/billing/platformCostEnvelopeServer";

// ──────────────────────────────────────────────────────────────────────
//  Mixed-profile allowlist test (cost_beta_credit_v2).
//
//  The one authorized third complete profile is:
//      live text + live image + live vision + CANONICAL TTS
//  because root confirmed voice TTS needs the canonical
//  `https://dashscope.aliyuncs.com/api/v1` baseUrl, while the already
//  working live text/image/vision endpoints must stay unchanged.
//
//  This test proves that:
//    * the exact mixed profile builds and asserts,
//    * its beta prices are identical to the all-live profile,
//    * PostgreSQL JSONB-style key reordering still asserts against the
//      approved version,
//    * all-canonical and all-live profiles still validate,
//    * representative UNAPPROVED role combinations and new models are
//      rejected (no arbitrary Cartesian product, no widened endpoints),
//    * extra keys / getters / proxies still fail closed,
//    * shared operation hashes are exactly the expected ones.
//
//  No DB, network, provider calls or credentials. Fixtures use the fake
//  apiKey "test" only. It also writes the non-secret local compare artifact
//  reference/mixed.beta.json (full candidate + beta policy, no secrets).
// ──────────────────────────────────────────────────────────────────────

type BindingSet = {
  text: { provider: string; model: string; baseUrl: string };
  image: { provider: string; model: string; baseUrl: string };
  vision: { provider: string; model: string; baseUrl: string };
  tts: { provider: string; model: string; baseUrl: string };
};

const FAKE_API_KEY = "test";

function makeRuntime(bindings: BindingSet): FixedBetaRuntimeConfig {
  return {
    text: { ...bindings.text, apiKey: FAKE_API_KEY },
    image: { ...bindings.image, apiKey: FAKE_API_KEY },
    vision: { ...bindings.vision, apiKey: FAKE_API_KEY },
    tts: {
      provider: bindings.tts.provider,
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
      apiKey: FAKE_API_KEY,
    },
  };
}

/**
 * Independently compose the mixed profile from the two exported authorized
 * sets. This deliberately does NOT reuse `COST_BETA_MIXED_PROVIDER_BINDINGS`
 * so the test proves the module allowlist matches root's confirmed profile.
 */
function mixedBindings(): BindingSet {
  return {
    text: {
      provider: PLATFORM_LIVE_PROVIDER_BINDINGS.text.provider,
      model: PLATFORM_LIVE_PROVIDER_BINDINGS.text.model,
      baseUrl: PLATFORM_LIVE_PROVIDER_BINDINGS.text.baseUrl,
    },
    image: {
      provider: PLATFORM_LIVE_PROVIDER_BINDINGS.image.provider,
      model: PLATFORM_LIVE_PROVIDER_BINDINGS.image.model,
      baseUrl: PLATFORM_LIVE_PROVIDER_BINDINGS.image.baseUrl,
    },
    vision: {
      provider: PLATFORM_LIVE_PROVIDER_BINDINGS.vision.provider,
      model: PLATFORM_LIVE_PROVIDER_BINDINGS.vision.model,
      baseUrl: PLATFORM_LIVE_PROVIDER_BINDINGS.vision.baseUrl,
    },
    tts: {
      provider: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.provider,
      model: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.model,
      baseUrl: PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.baseUrl,
    },
  };
}

function candidateFor(
  bindings: BindingSet,
  phase: "beta" | "formal" = "beta",
): CostBetaPricingCandidate {
  return buildCostBetaPricingCandidate(makeRuntime(bindings), phase);
}

function entryOf(candidate: CostBetaPricingCandidate, operation: string) {
  const found = candidate.policy.entries.find(
    (item) => item.operation === operation,
  );
  assert.ok(found, `missing policy entry ${operation}`);
  return found;
}

const TEXT_ONLY_OPS = [
  "story.classify-freeform",
  "story.insert-beat",
  "style.rewrite",
  "text.character-names",
] as const;
const VISION_ONLY_OPS = ["vision.decide", "vision.style-parse"] as const;
const IMAGE_ONLY_OPS = ["style.redraw"] as const;
const TTS_ONLY_OPS = ["tts.beat"] as const;
const MULTI_ROLE_OPS = [
  "story.start",
  "story.scene",
  "story.scene.prefetch",
] as const;

// ── JSONB-style cloning helpers (no global key sort) ───────────────────

type DataRecord = Record<string, unknown>;
type EntryRecord = Record<string, unknown>;
type KeyOrder = (keys: readonly string[]) => string[];
type EntryPermutation = (items: EntryRecord[]) => EntryRecord[];

const AS_BUILT: KeyOrder = (keys) => [...keys];
const REVERSED: KeyOrder = (keys) => [...keys].reverse();
// PostgreSQL JSONB ordering: shorter keys first, then lexical.
const POSTGRES: KeyOrder = (keys) =>
  [...keys].sort((left, right) =>
    left.length - right.length
    || (left < right ? -1 : left > right ? 1 : 0)
  );

const SAME_ENTRY_ORDER: EntryPermutation = (items) => items;
const REVERSED_ENTRY_ORDER: EntryPermutation = (items) => [...items].reverse();
const ROTATED_ENTRY_ORDER: EntryPermutation = (items) =>
  items.length < 2 ? [...items] : [...items.slice(1), items[0]!];
const INTERLEAVED_ENTRY_ORDER: EntryPermutation = (items) => [
  ...items.filter((_, index) => index % 2 === 0),
  ...items.filter((_, index) => index % 2 === 1),
];

function cloneEntry(source: EntryRecord, order: KeyOrder): EntryRecord {
  const result: EntryRecord = {};
  for (const key of order(Object.keys(source))) result[key] = source[key];
  return result;
}

function clonePolicy(
  source: DataRecord,
  policyOrder: KeyOrder,
  entryOrder: KeyOrder,
  permuteEntries: EntryPermutation = SAME_ENTRY_ORDER,
): DataRecord {
  const entries = (source.entries as EntryRecord[]).map((item) =>
    cloneEntry(item, entryOrder)
  );
  const result: DataRecord = {};
  for (const key of policyOrder(Object.keys(source))) {
    result[key] = key === "entries" ? permuteEntries(entries) : source[key];
  }
  return result;
}

function withAudit(source: DataRecord): DataRecord {
  return {
    ...source,
    updatedAt: "2026-10-22T00:00:00.000Z",
    updatedBy: "cost-beta-approval",
  };
}

function policyRecord(candidate: CostBetaPricingCandidate): DataRecord {
  return candidate.policy as unknown as DataRecord;
}

function assertAccepted(
  variant: unknown,
  candidate: CostBetaPricingCandidate,
): void {
  assert.doesNotThrow(
    () => assertCostBetaPricingPolicy(variant),
    "reordered JSONB readback must assert against the approved version",
  );
  const record = variant as DataRecord;
  assert.equal(record.version, candidate.policy.version);
  const actualEntries = record.entries as EntryRecord[];
  assert.equal(actualEntries.length, candidate.policy.entries.length);
  for (const expected of candidate.policy.entries) {
    const actual = actualEntries.find(
      (item) => item.operation === expected.operation,
    );
    assert.ok(actual, `missing entry ${expected.operation}`);
    assert.equal(actual.providerCostMinor, expected.providerCostMinor);
    assert.equal(actual.fixedCredits, expected.fixedCredits);
    assert.equal(actual.model, expected.model);
  }
}

function assertRejected(value: unknown, label: string): void {
  assert.throws(
    () => assertCostBetaPricingPolicy(value),
    CostBetaPricingContractError,
    label,
  );
}

function mutatedPolicy(candidate: CostBetaPricingCandidate): {
  policy: DataRecord;
  entries: EntryRecord[];
} {
  const policy = clonePolicy(
    policyRecord(candidate),
    AS_BUILT,
    AS_BUILT,
  );
  return { policy, entries: policy.entries as EntryRecord[] };
}

// ── Tests ──────────────────────────────────────────────────────────────

type Test = readonly [name: string, fn: () => Promise<void> | void];

const tests: Test[] = [
  [
    "mixed profile is exactly live text/image/vision + canonical TTS",
    () => {
      const live = mixedBindings();
      // The module allowlist constant must be that exact profile, nothing more.
      assert.deepEqual(COST_BETA_MIXED_PROVIDER_BINDINGS, live);
      assert.ok(Object.isFrozen(COST_BETA_MIXED_PROVIDER_BINDINGS));
      assert.equal(
        live.text.baseUrl,
        PLATFORM_LIVE_PROVIDER_BINDINGS.text.baseUrl,
      );
      assert.equal(
        live.image.baseUrl,
        PLATFORM_LIVE_PROVIDER_BINDINGS.image.baseUrl,
      );
      assert.equal(
        live.vision.baseUrl,
        PLATFORM_LIVE_PROVIDER_BINDINGS.vision.baseUrl,
      );
      assert.equal(
        live.tts.baseUrl,
        PLATFORM_CANONICAL_PROVIDER_BINDINGS.tts.baseUrl,
      );
      // It is genuinely mixed: no all-live / all-canonical equality.
      assert.notDeepEqual(live, PLATFORM_LIVE_PROVIDER_BINDINGS);
      assert.notDeepEqual(live, PLATFORM_CANONICAL_PROVIDER_BINDINGS);
    },
  ],
  [
    "mixed beta candidate builds, asserts, and pins shared operation hashes",
    () => {
      const mixed = candidateFor(mixedBindings(), "beta");
      const live = candidateFor(PLATFORM_LIVE_PROVIDER_BINDINGS, "beta");
      const canonical = candidateFor(
        PLATFORM_CANONICAL_PROVIDER_BINDINGS,
        "beta",
      );

      assert.equal(mixed.phase, "beta");
      assert.equal(mixed.operationCount, 11);
      assert.equal(mixed.policy.entries.length, 11);
      assert.match(mixed.fingerprint, /^[a-f0-9]{64}$/);
      assert.ok(mixed.policy.version.startsWith(`${COST_BETA_PRICING_VERSION_PREFIX}beta.`));
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(mixed.policy));

      // Operation-specific role descriptors: single-role ops inherit the
      // profile that owns that role, so those hashes are naturally shared.
      for (const operation of TEXT_ONLY_OPS) {
        assert.equal(
          entryOf(mixed, operation).model,
          entryOf(live, operation).model,
          `${operation} should reuse the live text binding hash`,
        );
        assert.notEqual(
          entryOf(mixed, operation).model,
          entryOf(canonical, operation).model,
          `${operation} must not match the canonical text hash`,
        );
      }
      for (const operation of VISION_ONLY_OPS) {
        assert.equal(
          entryOf(mixed, operation).model,
          entryOf(live, operation).model,
          `${operation} should reuse the live vision binding hash`,
        );
        assert.notEqual(
          entryOf(mixed, operation).model,
          entryOf(canonical, operation).model,
        );
      }
      for (const operation of IMAGE_ONLY_OPS) {
        assert.equal(
          entryOf(mixed, operation).model,
          entryOf(live, operation).model,
          `${operation} should reuse the live image binding hash`,
        );
        assert.notEqual(
          entryOf(mixed, operation).model,
          entryOf(canonical, operation).model,
        );
      }
      for (const operation of TTS_ONLY_OPS) {
        assert.equal(
          entryOf(mixed, operation).model,
          entryOf(canonical, operation).model,
          `${operation} should reuse the canonical TTS binding hash`,
        );
        assert.notEqual(
          entryOf(mixed, operation).model,
          entryOf(live, operation).model,
        );
      }
      // Multi-role operations pin the whole role set: the mixed profile hash
      // must differ from BOTH complete profiles.
      for (const operation of MULTI_ROLE_OPS) {
        assert.notEqual(
          entryOf(mixed, operation).model,
          entryOf(live, operation).model,
          `${operation} must pin the canonical TTS role`,
        );
        assert.notEqual(
          entryOf(mixed, operation).model,
          entryOf(canonical, operation).model,
          `${operation} must pin the live text/image roles`,
        );
      }
      // All 11 operations are accounted for by the groups above.
      const covered = [
        ...TEXT_ONLY_OPS,
        ...VISION_ONLY_OPS,
        ...IMAGE_ONLY_OPS,
        ...TTS_ONLY_OPS,
        ...MULTI_ROLE_OPS,
      ];
      assert.equal(new Set(covered).size, 11);
    },
  ],
  [
    "mixed beta prices are identical to all-live beta",
    () => {
      const mixed = candidateFor(mixedBindings(), "beta");
      const live = candidateFor(PLATFORM_LIVE_PROVIDER_BINDINGS, "beta");
      for (const mixedEntry of mixed.policy.entries) {
        const liveEntry = entryOf(live, mixedEntry.operation);
        assert.equal(
          mixedEntry.providerCostMinor,
          liveEntry.providerCostMinor,
          `${mixedEntry.operation} provider cost changed`,
        );
        assert.equal(
          mixedEntry.fixedCredits,
          liveEntry.fixedCredits,
          `${mixedEntry.operation} beta credits changed`,
        );
        assert.equal(mixedEntry.modality, liveEntry.modality);
      }
      // Prices are identical, but the runtime pin (version/fingerprint) is not.
      assert.notEqual(mixed.policy.version, live.policy.version);
      assert.notEqual(mixed.fingerprint, live.fingerprint);
    },
  ],
  [
    "JSONB-style key reorder roundtrip asserts for the exact mixed profile",
    () => {
      const mixed = candidateFor(mixedBindings(), "beta");
      const policy = policyRecord(mixed);
      const approvedVersion = mixed.policy.version;
      const approvedFingerprint = mixed.fingerprint;

      const orders: KeyOrder[] = [AS_BUILT, REVERSED, POSTGRES];
      const permutations: EntryPermutation[] = [
        SAME_ENTRY_ORDER,
        REVERSED_ENTRY_ORDER,
        ROTATED_ENTRY_ORDER,
        INTERLEAVED_ENTRY_ORDER,
      ];
      for (const policyOrder of orders) {
        for (const entryOrder of orders) {
          for (const permute of permutations) {
            const variant = clonePolicy(
              policy,
              policyOrder,
              entryOrder,
              permute,
            );
            assertAccepted(variant, mixed);
            assertAccepted(withAudit(variant), mixed);
            if (
              policyOrder === POSTGRES
              && permute === REVERSED_ENTRY_ORDER
            ) {
              // Prove the readback shape really changed for the mixed profile.
              assert.notEqual(
                JSON.stringify(variant),
                JSON.stringify(policy),
              );
            }
          }
        }
      }

      // Builder field order remains the version-hashed contract.
      assert.deepEqual(Object.keys(mixed.policy.entries[0]!), [
        "operation",
        "modality",
        "provider",
        "model",
        "providerCostMinor",
        "enabled",
        "pricingMode",
        "fixedCredits",
      ]);
      // No new version is minted by any accepted reorder.
      assert.equal(mixed.policy.version, approvedVersion);
      assert.equal(mixed.fingerprint, approvedFingerprint);
    },
  ],
  [
    "all-canonical and all-live profiles remain valid",
    () => {
      for (
        const [label, bindings] of [
          ["all-canonical", PLATFORM_CANONICAL_PROVIDER_BINDINGS],
          ["all-live", PLATFORM_LIVE_PROVIDER_BINDINGS],
        ] as const
      ) {
        for (const phase of ["beta", "formal"] as const) {
          const candidate = candidateFor(bindings, phase);
          assert.equal(
            candidate.phase,
            phase,
            `${label} ${phase} phase`,
          );
          assert.doesNotThrow(
            () => assertCostBetaPricingPolicy(candidate.policy),
            `${label} ${phase} policy must stay valid`,
          );
        }
      }
    },
  ],
  [
    "unapproved relevant-role combinations are rejected by the policy assertion",
    () => {
      const live = PLATFORM_LIVE_PROVIDER_BINDINGS;
      const canonical = PLATFORM_CANONICAL_PROVIDER_BINDINGS;
      const combos: ReadonlyArray<readonly [string, BindingSet]> = [
        [
          "canonical text + live image + canonical TTS",
          {
            text: { ...canonical.text },
            image: { ...live.image },
            vision: { ...live.vision },
            tts: { ...canonical.tts },
          },
        ],
        [
          "live text + canonical image + canonical TTS",
          {
            text: { ...live.text },
            image: { ...canonical.image },
            vision: { ...live.vision },
            tts: { ...canonical.tts },
          },
        ],
        [
          "canonical text + canonical image + live TTS",
          {
            text: { ...canonical.text },
            image: { ...canonical.image },
            vision: { ...canonical.vision },
            tts: { ...live.tts },
          },
        ],
        [
          "live text + canonical image + live TTS",
          {
            text: { ...live.text },
            image: { ...canonical.image },
            vision: { ...live.vision },
            tts: { ...live.tts },
          },
        ],
        [
          "canonical text + live image + live TTS",
          {
            text: { ...canonical.text },
            image: { ...live.image },
            vision: { ...live.vision },
            tts: { ...live.tts },
          },
        ],
      ];

      for (const [label, bindings] of combos) {
        // Every role is individually authorized, so the builder can compute a
        // policy version; it must still fail the allowlist assertion because
        // the multi-role operation hashes belong to no complete profile.
        const built = buildCostBetaPricingCandidate(
          makeRuntime(bindings),
          "beta",
        );
        assertRejected(built.policy, label);
      }

      // Control: the exact mixed profile and both complete profiles pass.
      assert.doesNotThrow(() =>
        assertCostBetaPricingPolicy(candidateFor(mixedBindings(), "beta").policy)
      );
      assert.doesNotThrow(() =>
        assertCostBetaPricingPolicy(
          candidateFor(PLATFORM_LIVE_PROVIDER_BINDINGS, "beta").policy,
        )
      );
      assert.doesNotThrow(() =>
        assertCostBetaPricingPolicy(
          candidateFor(PLATFORM_CANONICAL_PROVIDER_BINDINGS, "beta").policy,
        )
      );
    },
  ],
  [
    "new models and unauthorized endpoints fail closed (builder + assertion)",
    () => {
      // Builder rejects a new text model even though the baseUrl is valid.
      const newModel = mixedBindings() as BindingSet;
      newModel.text = { ...newModel.text, model: "qwen-max" };
      assert.throws(
        () => buildCostBetaPricingCandidate(makeRuntime(newModel), "beta"),
        CostBetaPricingContractError,
        "new text model must not bind",
      );

      // Builder rejects an unknown endpoint host.
      const newHost = mixedBindings() as BindingSet;
      newHost.vision = {
        ...newHost.vision,
        baseUrl: "https://example.invalid/compatible-mode/v1",
      };
      assert.throws(
        () => buildCostBetaPricingCandidate(makeRuntime(newHost), "beta"),
        CostBetaPricingContractError,
        "unknown endpoint host must not bind",
      );

      // Builder rejects a model swapped across roles.
      const swapped = mixedBindings() as BindingSet;
      swapped.text = {
        ...swapped.text,
        model: PLATFORM_CANONICAL_PROVIDER_BINDINGS.image.model,
      };
      assert.throws(
        () => buildCostBetaPricingCandidate(makeRuntime(swapped), "beta"),
        CostBetaPricingContractError,
        "cross-role model must not bind",
      );

      // The policy assertion also rejects an injected, well-formed but
      // unapproved binding hash.
      const mixed = candidateFor(mixedBindings(), "beta");
      const unknownHash = mutatedPolicy(mixed);
      unknownHash.entries[0]!.model = `sha256:${"b".repeat(64)}`;
      assertRejected(unknownHash.policy, "unapproved binding hash");
    },
  ],
  [
    "extra keys, getters and proxies still fail closed on the mixed policy",
    () => {
      const mixed = candidateFor(mixedBindings(), "beta");

      const extraTopLevel = clonePolicy(
        policyRecord(mixed),
        POSTGRES,
        POSTGRES,
      );
      extraTopLevel.rateCatalog = "nope";
      assertRejected(extraTopLevel, "extra top-level key");

      const extraEntryKey = clonePolicy(
        policyRecord(mixed),
        POSTGRES,
        POSTGRES,
      );
      (extraEntryKey.entries as EntryRecord[])[0]!.surprise = true;
      assertRejected(extraEntryKey, "extra entry key");

      const topGetter = clonePolicy(
        policyRecord(mixed),
        POSTGRES,
        POSTGRES,
      );
      Object.defineProperty(topGetter, "markupBasisPoints", {
        enumerable: true,
        configurable: true,
        get: () => 10_000,
      });
      assertRejected(topGetter, "getter on top-level field");

      const entryGetter = clonePolicy(
        policyRecord(mixed),
        POSTGRES,
        POSTGRES,
      );
      const targetEntry = (entryGetter.entries as EntryRecord[])[0]!;
      const fixedCredits = targetEntry.fixedCredits;
      Object.defineProperty(targetEntry, "fixedCredits", {
        enumerable: true,
        configurable: true,
        get: () => fixedCredits,
      });
      assertRejected(entryGetter, "getter on entry field");

      assertRejected(
        new Proxy(clonePolicy(policyRecord(mixed), REVERSED, REVERSED), {}),
        "proxy policy",
      );

      // A changed price/credit/version is still rejected for the mixed profile.
      const changedCost = mutatedPolicy(mixed);
      changedCost.entries[0]!.providerCostMinor =
        (changedCost.entries[0]!.providerCostMinor as number) + 1;
      assertRejected(changedCost.policy, "changed providerCostMinor");

      const changedVersion = mutatedPolicy(mixed);
      changedVersion.policy.version =
        `${COST_BETA_PRICING_VERSION_PREFIX}beta.${"0".repeat(64)}`;
      assertRejected(changedVersion.policy, "changed version");

      // The approved mixed candidate is never mutated by failed assertions.
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(mixed.policy));
    },
  ],
];

// ── Non-secret local compare artifact ─────────────────────────────────

function writeMixedArtifact(): string {
  const candidate = candidateFor(mixedBindings(), "beta");
  const bindings = mixedBindings();
  const artifact = {
    artifact: "reference/mixed.beta.json",
    generatedBy: "scripts/test-cost-beta-mixed-profile.ts",
    nonSecret: true,
    note: "Local owner-compare artifact only. No API key, credential or network data. Generated deterministically from the authorized bindings.",
    profile: {
      label: "live text/image/vision + canonical TTS",
      text: bindings.text,
      image: bindings.image,
      vision: bindings.vision,
      tts: bindings.tts,
    },
    phase: candidate.phase,
    pricingMode: candidate.pricingMode,
    policyVersion: candidate.policy.version,
    fingerprint: candidate.fingerprint,
    candidate,
    policy: candidate.policy,
  };
  const target = fileURLToPath(
    new URL("../reference/mixed.beta.json", import.meta.url),
  );
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return target;
}

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
    console.error(`\n${failed} cost-beta mixed-profile test(s) failed.`);
    process.exitCode = 1;
    return;
  }

  try {
    const target = writeMixedArtifact();
    console.log(`\nwrote ${target}`);
  } catch (error) {
    // Artifact generation is a local convenience, never a test failure; the
    // owner can re-run this script where the workspace is writable.
    console.error("mixed.beta.json generation failed; policy checks passed.");
    console.error(error);
  }

  console.log(`\n${tests.length} cost-beta mixed-profile test(s) passed.`);
}

void main();
