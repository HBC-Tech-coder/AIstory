// Export local beta + formal cost-derived pricing candidates.
//
//   tsx scripts/export-cost-beta-pricing.ts [outputDir]
//
// The output directory is optional and defaults to `os.tmpdir()`. The script
// only reads module constants and writes local JSON files:
//   * no environment variables are read,
//   * no credentials are required or written,
//   * no provider is contacted,
//   * no account/credit data is mutated.
//
// The candidates are reserved upper-bound estimates built from the verified
// official rate catalog and the exact live deployment bindings. They are NOT
// actual provider usage, invoices, or cost receipts.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildCostBetaPricingCandidate,
  COST_BETA_OFFICIAL_RATE_SOURCES,
  COST_BETA_PRICE_ASSUMPTIONS,
  COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS,
  COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
  COST_BETA_PRICING_MODE,
  COST_BETA_RATE_CATALOG_VERSION,
  type CostBetaPricingCandidate,
} from "../lib/billing/costBetaPricing";
import {
  assertPlatformRuntimeConfig,
  PLATFORM_LIVE_PROVIDER_BINDINGS,
} from "../lib/billing/platformCostEnvelopeServer";
import type { FixedBetaRuntimeConfig } from "../lib/billing/fixedBetaPricing";

export const COST_BETA_PRICING_EXPORT_SCHEMA =
  "aistory.cost-beta-pricing-export/v1" as const;

/**
 * The exact live deployment bindings, converted to the runtime shape used by
 * the cost model. The TTS role carries `speechModel` (not `model`) because
 * that is what `TtsConfig` and the TTS adapter actually consume.
 */
function liveRuntimeConfig(): FixedBetaRuntimeConfig {
  const live = PLATFORM_LIVE_PROVIDER_BINDINGS;
  const runtime: FixedBetaRuntimeConfig = {
    text: {
      provider: live.text.provider as FixedBetaRuntimeConfig["text"]["provider"],
      model: live.text.model,
      baseUrl: live.text.baseUrl,
    },
    image: {
      provider: live.image.provider as FixedBetaRuntimeConfig["image"]["provider"],
      model: live.image.model,
      baseUrl: live.image.baseUrl,
    },
    vision: {
      provider: live.vision.provider as FixedBetaRuntimeConfig["vision"]["provider"],
      model: live.vision.model,
      baseUrl: live.vision.baseUrl,
    },
    // TTS binding conversion: PLATFORM_LIVE_PROVIDER_BINDINGS uses `model`,
    // while the runtime TTS contract uses `speechModel`.
    tts: {
      provider: live.tts.provider as NonNullable<
        FixedBetaRuntimeConfig["tts"]
      >["provider"],
      speechModel: live.tts.model,
      baseUrl: live.tts.baseUrl,
    },
  };
  assertPlatformRuntimeConfig(runtime);
  return runtime;
}

export type CostBetaPricingExport = Readonly<{
  schema: typeof COST_BETA_PRICING_EXPORT_SCHEMA;
  status: "LOCAL_PRICING_CANDIDATE_ONLY";
  generatedAt: string;
  pricingMode: typeof COST_BETA_PRICING_MODE;
  rateCatalogVersion: typeof COST_BETA_RATE_CATALOG_VERSION;
  runtime: Readonly<{
    source: "PLATFORM_LIVE_PROVIDER_BINDINGS";
    text: Readonly<{ provider: string; model: string; baseUrl: string }>;
    image: Readonly<{ provider: string; model: string; baseUrl: string }>;
    vision: Readonly<{ provider: string; model: string; baseUrl: string }>;
    tts: Readonly<{
      provider: string;
      speechModel: string;
      baseUrl: string;
    }>;
  }>;
  grants: Readonly<{
    initialGrantCredits: number;
    friendRegistrationGrantCredits: number;
    friendBalance2000PreservedAsMetadata: true;
    grantsAreMetadataOnly: true;
    accountMutations: 0;
  }>;
  sourceReferences: readonly unknown[];
  caveats: readonly string[];
  candidates: Readonly<{
    beta: CostBetaPricingCandidate;
    formal: CostBetaPricingCandidate;
  }>;
}>;

const EXPORT_CAVEATS = Object.freeze([
  ...COST_BETA_PRICE_ASSUMPTIONS,
  "These candidates are local, immutable, upper-bound reserved estimates. They are not actual provider usage, invoices, settlement records, or cost receipts.",
  "Both phases use the same worst-case provider cost; formal credits are exactly 10x the beta credits per operation.",
  "The initial registration grant is 1,000 credits. The 2,000-credit friend grant is preserved as metadata only and is not applied, altered, or written anywhere.",
  "This export performs no account mutations, grants no credits, reads no environment variables or credentials, and contacts no provider.",
  "Official rate facts were captured on the date in the embedded rate catalog and are pinned by its version and fingerprint.",
]);

function buildExport(): CostBetaPricingExport {
  const runtime = liveRuntimeConfig();
  const beta = buildCostBetaPricingCandidate(runtime, "beta");
  const formal = buildCostBetaPricingCandidate(runtime, "formal");

  if (beta.policy.initialGrantCredits !==
    COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS) {
    throw new Error("Beta candidate initial grant is not 1,000 credits.");
  }
  if (formal.policy.initialGrantCredits !==
    COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS) {
    throw new Error("Formal candidate initial grant is not 1,000 credits.");
  }
  if (
    COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS !== 2_000
    || beta.friendRegistrationGrantCredits !== 2_000
    || formal.friendRegistrationGrantCredits !== 2_000
  ) {
    throw new Error("Friend balance metadata must stay at 2,000 credits.");
  }
  if (
    beta.grantsAreMetadataOnly !== true
    || formal.grantsAreMetadataOnly !== true
    || beta.writesPerformed !== 0
    || formal.writesPerformed !== 0
    || beta.networkCalls !== 0
    || formal.networkCalls !== 0
  ) {
    throw new Error("Pricing candidates must remain metadata-only.");
  }

  return Object.freeze({
    schema: COST_BETA_PRICING_EXPORT_SCHEMA,
    status: "LOCAL_PRICING_CANDIDATE_ONLY",
    generatedAt: new Date().toISOString(),
    pricingMode: COST_BETA_PRICING_MODE,
    rateCatalogVersion: COST_BETA_RATE_CATALOG_VERSION,
    runtime: Object.freeze({
      source: "PLATFORM_LIVE_PROVIDER_BINDINGS",
      text: Object.freeze({
        provider: runtime.text.provider!,
        model: runtime.text.model,
        baseUrl: runtime.text.baseUrl,
      }),
      image: Object.freeze({
        provider: runtime.image.provider!,
        model: runtime.image.model,
        baseUrl: runtime.image.baseUrl,
      }),
      vision: Object.freeze({
        provider: runtime.vision.provider!,
        model: runtime.vision.model,
        baseUrl: runtime.vision.baseUrl,
      }),
      tts: Object.freeze({
        provider: runtime.tts!.provider!,
        speechModel: runtime.tts!.speechModel,
        baseUrl: runtime.tts!.baseUrl,
      }),
    }),
    grants: Object.freeze({
      initialGrantCredits: COST_BETA_ORDINARY_REGISTRATION_GRANT_CREDITS,
      friendRegistrationGrantCredits:
        COST_BETA_FRIEND_REGISTRATION_GRANT_CREDITS,
      friendBalance2000PreservedAsMetadata: true as const,
      grantsAreMetadataOnly: true as const,
      accountMutations: 0 as const,
    }),
    sourceReferences: COST_BETA_OFFICIAL_RATE_SOURCES,
    caveats: EXPORT_CAVEATS,
    candidates: Object.freeze({ beta, formal }),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const outputDir = resolve(process.argv[2] ?? tmpdir());
  await mkdir(outputDir, { recursive: true });

  const manifest = buildExport();
  const baseName = "cost-beta-pricing-v2-live";
  const manifestPath = join(outputDir, `${baseName}.manifest.json`);
  const betaPath = join(outputDir, `${baseName}.beta.json`);
  const formalPath = join(outputDir, `${baseName}.formal.json`);

  await writeJson(manifestPath, manifest);
  await writeJson(betaPath, manifest.candidates.beta);
  await writeJson(formalPath, manifest.candidates.formal);

  console.log(`Exported cost-beta pricing candidates to ${outputDir}`);
  console.log(`- ${manifestPath}`);
  console.log(`- ${betaPath}`);
  console.log(`- ${formalPath}`);
  console.log(
    `beta operations=${manifest.candidates.beta.operationCount} `
      + `initialGrant=${manifest.candidates.beta.policy.initialGrantCredits} `
      + `friendGrantMetadata=${manifest.grants.friendRegistrationGrantCredits}`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

