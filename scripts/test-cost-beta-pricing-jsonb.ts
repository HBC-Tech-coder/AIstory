import assert from "node:assert/strict";

import {
  assertCostBetaPricingPolicy,
  buildCostBetaPricingCandidate,
  COST_BETA_PRICING_VERSION_PREFIX,
  CostBetaPricingContractError,
  type CostBetaPricingCandidate,
} from "../lib/billing/costBetaPricing";
import type { FixedBetaRuntimeConfig } from "../lib/billing/fixedBetaPricing";
import { PLATFORM_CANONICAL_PROVIDER_BINDINGS } from "../lib/billing/platformCostEnvelopeServer";

// ──────────────────────────────────────────────────────────────────────
//  JSONB readback regression for the approved (already persisted) policy.
//
//  PostgreSQL JSONB does not preserve object key insertion order: it
//  re-emits object keys sorted by length then lexically. `policyVersion`
//  hashes `JSON.stringify(versionlessPolicy)`, whose shape is pinned by the
//  builder's fixed field order, so the assertion must canonicalize each
//  entry back to that exact builder order before hashing. Entry array order
//  is separately verified to stay irrelevant under the existing canonical
//  (platform operation) contract.
//
//  This test proves that:
//    * reordered top-level keys are accepted,
//    * reordered per-entry keys are accepted,
//    * permuted entry arrays are accepted (existing canonical contract),
//    * combinations preserve the original, approved version/fingerprint,
//    * negative changes / extra keys / getters / proxies still fail safely.
//  It performs no DB/network/env access and has no external side effects.
// ──────────────────────────────────────────────────────────────────────

type DataRecord = Record<string, unknown>;
type EntryRecord = Record<string, unknown>;
type KeyOrder = (keys: readonly string[]) => string[];
type EntryPermutation = (items: EntryRecord[]) => EntryRecord[];

function makeRuntime(): FixedBetaRuntimeConfig {
  const bindings = PLATFORM_CANONICAL_PROVIDER_BINDINGS;
  return {
    text: {
      provider: bindings.text.provider,
      model: bindings.text.model,
      baseUrl: bindings.text.baseUrl,
    },
    image: {
      provider: bindings.image.provider,
      model: bindings.image.model,
      baseUrl: bindings.image.baseUrl,
    },
    vision: {
      provider: bindings.vision.provider,
      model: bindings.vision.model,
      baseUrl: bindings.vision.baseUrl,
    },
    tts: {
      provider: bindings.tts.provider,
      speechModel: bindings.tts.model,
      baseUrl: bindings.tts.baseUrl,
    },
  };
}

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
// Deterministic even/odd interleave: a distinct, non-sorted permutation.
const INTERLEAVED_ENTRY_ORDER: EntryPermutation = (items) => [
  ...items.filter((_, index) => index % 2 === 0),
  ...items.filter((_, index) => index % 2 === 1),
];

function cloneEntry(source: EntryRecord, order: KeyOrder): EntryRecord {
  const result: EntryRecord = {};
  for (const key of order(Object.keys(source))) result[key] = source[key];
  return result;
}

/**
 * Deep-clone the approved policy while re-emitting the top-level keys and
 * each entry's keys in the requested order, optionally permuting the entry
 * array. Values are copied verbatim so the approved prices are preserved.
 */
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
  // Mirrors the persisted production row: policy + audit columns.
  return {
    ...source,
    updatedAt: "2026-10-22T00:00:00.000Z",
    updatedBy: "cost-beta-approval",
  };
}

function candidatePolicy(
  candidate: CostBetaPricingCandidate,
): DataRecord {
  return candidate.policy as unknown as DataRecord;
}

function approvedCandidate(
  phase: "beta" | "formal" = "beta",
): CostBetaPricingCandidate {
  return buildCostBetaPricingCandidate(makeRuntime(), phase);
}

function assertAccepted(
  variant: unknown,
  candidate: CostBetaPricingCandidate,
): void {
  const originalVersion = candidate.policy.version;
  assert.doesNotThrow(
    () => assertCostBetaPricingPolicy(variant),
    "reordered JSONB readback must assert against the approved version",
  );
  const record = variant as DataRecord;
  // The approved version is preserved verbatim; no new version is minted.
  assert.equal(record.version, originalVersion);
  const expectedEntries =
    candidate.policy.entries as unknown as readonly EntryRecord[];
  const actualEntries = record.entries as EntryRecord[];
  assert.equal(actualEntries.length, expectedEntries.length);
  for (const expected of expectedEntries) {
    const actual = actualEntries.find(
      (entry) => entry.operation === expected.operation,
    );
    assert.ok(actual, `missing entry ${String(expected.operation)}`);
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
    candidatePolicy(candidate),
    AS_BUILT,
    AS_BUILT,
  );
  return { policy, entries: policy.entries as EntryRecord[] };
}

type Test = readonly [name: string, fn: () => Promise<void> | void];

const tests: Test[] = [
  [
    "reordered top-level and per-entry keys assert against the approved version",
    () => {
      const candidate = approvedCandidate("beta");
      const policy = candidatePolicy(candidate);
      const originalVersion = candidate.policy.version;
      const originalFingerprint = candidate.fingerprint;

      const combos: ReadonlyArray<
        readonly [KeyOrder, KeyOrder, string, boolean]
      > = [
        [AS_BUILT, AS_BUILT, "builder order", false],
        [REVERSED, REVERSED, "fully reversed", true],
        [POSTGRES, POSTGRES, "PostgreSQL length-then-lexical", true],
        [REVERSED, POSTGRES, "reversed top + PostgreSQL entries", true],
        [POSTGRES, REVERSED, "PostgreSQL top + reversed entries", true],
      ];
      for (
        const [policyOrder, entryOrder, label, expectDifferent] of combos
      ) {
        const variant = clonePolicy(policy, policyOrder, entryOrder);
        assertAccepted(variant, candidate);
        // Prove the reordering variants really expose a different shape.
        if (expectDifferent) {
          assert.notEqual(
            JSON.stringify(variant),
            JSON.stringify(policy),
            `${label} did not reorder keys`,
          );
        }
      }

      // The approved version and fingerprint are untouched.
      assert.equal(candidate.policy.version, originalVersion);
      assert.equal(candidate.fingerprint, originalFingerprint);
    },
  ],
  [
    "PostgreSQL key ordering is actually length-then-lexical",
    () => {
      const candidate = approvedCandidate("beta");
      const policy = candidatePolicy(candidate);
      const variant = clonePolicy(policy, POSTGRES, POSTGRES);
      const builderEntry =
        (candidate.policy.entries as unknown as EntryRecord[])[0]!;
      const pgEntry = (variant.entries as EntryRecord[])[0]!;

      const expectedEntryKeys = Object.keys(builderEntry)
        .slice()
        .sort((left, right) =>
          left.length - right.length
          || (left < right ? -1 : left > right ? 1 : 0)
        );
      assert.deepEqual(Object.keys(pgEntry), expectedEntryKeys);
      assert.notDeepEqual(
        Object.keys(pgEntry),
        Object.keys(builderEntry),
        "entry key order must differ from the builder order",
      );
      // Builder field order must remain the version-hashed contract.
      assert.deepEqual(Object.keys(builderEntry), [
        "operation",
        "modality",
        "provider",
        "model",
        "providerCostMinor",
        "enabled",
        "pricingMode",
        "fixedCredits",
      ]);
      assertAccepted(variant, candidate);
    },
  ],
  [
    "permuted entry arrays are accepted under the canonical operation order",
    () => {
      const candidate = approvedCandidate("beta");
      const policy = candidatePolicy(candidate);
      for (const permute of [
        SAME_ENTRY_ORDER,
        REVERSED_ENTRY_ORDER,
        ROTATED_ENTRY_ORDER,
        INTERLEAVED_ENTRY_ORDER,
      ]) {
        const variant = clonePolicy(
          policy,
          AS_BUILT,
          AS_BUILT,
          permute,
        );
        assertAccepted(variant, candidate);
      }
      // Canonical operation order is platform order, not stored array order.
      const permuted = clonePolicy(
        policy,
        POSTGRES,
        REVERSED,
        REVERSED_ENTRY_ORDER,
      );
      assert.notDeepEqual(
        (permuted.entries as EntryRecord[]).map((entry) => entry.operation),
        (policy.entries as EntryRecord[]).map((entry) => entry.operation),
      );
      assertAccepted(permuted, candidate);
    },
  ],
  [
    "all combinations plus audit columns assert; approved version is unchanged",
    () => {
      const beta = approvedCandidate("beta");
      const approval = {
        version: beta.policy.version,
        fingerprint: beta.fingerprint,
      };
      const permutations: EntryPermutation[] = [
        SAME_ENTRY_ORDER,
        REVERSED_ENTRY_ORDER,
        ROTATED_ENTRY_ORDER,
        INTERLEAVED_ENTRY_ORDER,
      ];
      const orders: KeyOrder[] = [AS_BUILT, REVERSED, POSTGRES];
      for (const policyOrder of orders) {
        for (const entryOrder of orders) {
          for (const permute of permutations) {
            const variant = clonePolicy(
              candidatePolicy(beta),
              policyOrder,
              entryOrder,
              permute,
            );
            assertAccepted(variant, beta);
            assertAccepted(withAudit(variant), beta);
          }
        }
      }

      const formal = approvedCandidate("formal");
      const formalVersion = formal.policy.version;
      const formalVariant = withAudit(
        clonePolicy(
          candidatePolicy(formal),
          POSTGRES,
          REVERSED,
          ROTATED_ENTRY_ORDER,
        ),
      );
      assertAccepted(formalVariant, formal);

      // Original candidate object is unchanged before/after the assertions.
      assert.equal(beta.policy.version, approval.version);
      assert.equal(beta.fingerprint, approval.fingerprint);
      assert.equal(formal.policy.version, formalVersion);
    },
  ],
  [
    "negative: changed values, extra keys, getters and proxies fail safely",
    () => {
      const candidate = approvedCandidate("beta");

      const changedCost = mutatedPolicy(candidate);
      changedCost.entries[0]!.providerCostMinor =
        (changedCost.entries[0]!.providerCostMinor as number) + 1;
      assertRejected(changedCost.policy, "changed providerCostMinor");

      const changedCredits = mutatedPolicy(candidate);
      changedCredits.entries[0]!.fixedCredits =
        (changedCredits.entries[0]!.fixedCredits as number) + 1;
      assertRejected(changedCredits.policy, "changed fixedCredits");

      const changedModel = mutatedPolicy(candidate);
      changedModel.entries[0]!.model = `sha256:${"a".repeat(64)}`;
      assertRejected(changedModel.policy, "unauthorized runtime model");

      const changedEnabled = mutatedPolicy(candidate);
      changedEnabled.entries[0]!.enabled = false;
      assertRejected(changedEnabled.policy, "disabled entry");

      const changedVersion = mutatedPolicy(candidate);
      changedVersion.policy.version =
        `${COST_BETA_PRICING_VERSION_PREFIX}beta.${"0".repeat(64)}`;
      assertRejected(changedVersion.policy, "changed version");

      const extraTopLevel = clonePolicy(
        candidatePolicy(candidate),
        POSTGRES,
        POSTGRES,
      );
      extraTopLevel.rateCatalog = "nope";
      assertRejected(extraTopLevel, "extra top-level key");

      const extraEntryKey = clonePolicy(
        candidatePolicy(candidate),
        POSTGRES,
        POSTGRES,
      );
      (extraEntryKey.entries as EntryRecord[])[0]!.surprise = true;
      assertRejected(extraEntryKey, "extra entry key");

      // Getters are rejected even when they report a valid value.
      const topGetter = clonePolicy(
        candidatePolicy(candidate),
        POSTGRES,
        POSTGRES,
      );
      Object.defineProperty(topGetter, "markupBasisPoints", {
        enumerable: true,
        configurable: true,
        get: () => 10_000,
      });
      assertRejected(topGetter, "getter on top-level policy field");

      const entryGetter = clonePolicy(
        candidatePolicy(candidate),
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
        new Proxy(clonePolicy(candidatePolicy(candidate), REVERSED, REVERSED), {}),
        "proxy policy",
      );

      // The original approved candidate is never mutated by failed asserts.
      assert.doesNotThrow(() => assertCostBetaPricingPolicy(candidate.policy));
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
    console.error(`\n${failed} cost-beta JSONB readback test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${tests.length} cost-beta JSONB readback test(s) passed.`);
  }
}

void main();
