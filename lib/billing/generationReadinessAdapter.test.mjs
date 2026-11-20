import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveGenerationReadiness } from "./generationReadiness.ts";

const ROUTE_SOURCE = new URL(
  "../../app/api/account/generation-readiness/route.ts",
  import.meta.url,
);

function baseDeps(quote) {
  return {
    isBillingEnabled: () => true,
    authenticate: async () => ({ kind: "phone", userId: "user-1" }),
    assertDatabaseGateReady: () => {},
    loadRuntimeConfig: () => ({ text: { model: "runtime-model" } }),
    loadUser: async () => ({ status: "active" }),
    quote,
  };
}

test("route quote adapter awaits quotePlatformOperation and extracts .publicQuote", async () => {
  const source = await readFile(ROUTE_SOURCE, "utf8");

  assert.match(
    source,
    /quote:\s*async\s*\(\s*config\s*\)\s*:\s*Promise<GenerationReadinessQuote>\s*=>\s*\{/,
    "route quote dependency must be an async closure typed to the readiness contract",
  );
  assert.match(
    source,
    /const\s*\{\s*publicQuote\s*\}\s*=\s*await\s+quotePlatformOperation\(/,
    "route must await quotePlatformOperation and destructure .publicQuote",
  );
  assert.match(
    source,
    /return\s*\{\s*estimatedCredits:\s*publicQuote\.estimatedCredits\s*\};/,
    "route must project only the public quote's estimatedCredits",
  );
});

test("route quote adapter does not return or double-cast the raw wrapper", async () => {
  const source = await readFile(ROUTE_SOURCE, "utf8");

  // Regression: the old adapter returned the whole { publicQuote, policy,
  // catalogEntry } object, so readiness always saw undefined credits.
  assert.doesNotMatch(
    source,
    /quote:\s*(?:async\s*)?\(?\s*config\s*\)\s*(?::\s*[^=]+)?=>\s*(?:await\s+)?quotePlatformOperation\(/,
    "quote dependency must not return the raw quotePlatformOperation result",
  );
  // A cast must not smuggle the incompatible wrapper through the contract.
  assert.doesNotMatch(source, /as\s+unknown\s+as\s+GenerationReadinessQuote/);
  assert.doesNotMatch(source, /as\s+unknown\s+as\s*\{\s*estimatedCredits/);
});

test("raw quotePlatformOperation wrapper fails readiness; extracted publicQuote succeeds", async () => {
  const rawWrapper = {
    publicQuote: { operation: "story.start", estimatedCredits: 250 },
    policy: { version: "v1" },
    catalogEntry: { operation: "story.start" },
  };

  // This is the exact first-run bug: the wrapper has no top-level
  // estimatedCredits, so readiness degrades to service_unavailable.
  const broken = await resolveGenerationReadiness(baseDeps(async () => rawWrapper));
  assert.equal(broken.available, false);
  assert.equal(broken.reason, "service_unavailable");

  // The fixed adapter extracts .publicQuote, which the contract accepts.
  const fixed = await resolveGenerationReadiness(
    baseDeps(async () => ({
      estimatedCredits: rawWrapper.publicQuote.estimatedCredits,
    })),
  );
  assert.equal(fixed.available, true);
  assert.equal(fixed.reason, "ready");
  assert.equal(fixed.estimatedCredits, 250);
});
