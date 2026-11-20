import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("NETWORK_FORBIDDEN");
}) as typeof fetch;

const {
  FIXED_BETA_PROVIDER_COST_CATALOG_FINGERPRINT,
  fingerprintFixedBetaProviderCostCatalogDraft,
  FixedBetaProviderCostCatalogError,
  inspectFixedBetaProviderCostCatalog,
} = await import("@/lib/billing/fixedBetaProviderCostCatalog");

type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function operation(value: unknown, operationId: string): JsonRecord {
  const found = asArray(asRecord(value).operations)
    .map(asRecord)
    .find((candidate) => candidate.operation === operationId);
  assert.ok(found, `missing operation fixture ${operationId}`);
  return found;
}

function source(value: unknown, sourceId: string): JsonRecord {
  const found = asArray(asRecord(value).sources)
    .map(asRecord)
    .find((candidate) => candidate.sourceId === sourceId);
  assert.ok(found, `missing source fixture ${sourceId}`);
  return found;
}

function expectBlocked(value: unknown): void {
  assert.throws(
    () => inspectFixedBetaProviderCostCatalog(value),
    (error: unknown) => {
      assert.ok(error instanceof FixedBetaProviderCostCatalogError);
      assert.equal(error.code, "FIXED_BETA_PROVIDER_COST_CATALOG_INVALID");
      assert.equal(error.message, "Fixed beta provider cost catalog is invalid.");
      assert.equal(
        /prompt|workflow|api[_-]?key|secret|token|authorization|bearer|https?:\/\//i
          .test(error.message),
        false,
      );
      return true;
    },
  );
}

const catalogPath = path.join(
  process.cwd(),
  "lib",
  "billing",
  "fixedBetaProviderCostCatalog.v1.json",
);
const modulePath = path.join(
  process.cwd(),
  "lib",
  "billing",
  "fixedBetaProviderCostCatalog.ts",
);
const [catalogText, moduleText, fixedPricingText, imageText, painterText, ttsRouteText] =
  await Promise.all([
    readFile(catalogPath, "utf8"),
    readFile(modulePath, "utf8"),
    readFile(path.join(process.cwd(), "lib", "billing", "fixedBetaPricing.ts"), "utf8"),
    readFile(path.join(process.cwd(), "lib", "ai-client", "image.ts"), "utf8"),
    readFile(path.join(process.cwd(), "lib", "engine", "agents", "painter.ts"), "utf8"),
    readFile(path.join(process.cwd(), "app", "api", "beat-audio", "route.ts"), "utf8"),
  ]);
const catalog = JSON.parse(catalogText) as JsonRecord;

try {
  const first = inspectFixedBetaProviderCostCatalog(catalog);
  const second = inspectFixedBetaProviderCostCatalog(clone(catalog));
  assert.deepEqual(second, first);
  assert.equal(first.schema, "aistory.fixed-beta-provider-cost-catalog/v1");
  assert.equal(first.status, "BLOCKED_INELIGIBLE_OPERATIONS");
  assert.equal(
    first.catalogFingerprint,
    FIXED_BETA_PROVIDER_COST_CATALOG_FINGERPRINT,
  );
  assert.equal(
    fingerprintFixedBetaProviderCostCatalogDraft(catalog),
    first.catalogFingerprint,
  );
  assert.equal(first.operationCount, 11);
  assert.equal(first.eligibleCount, 1);
  assert.equal(first.ineligibleCount, 10);
  assert.deepEqual(first.eligibleOperations, ["style.redraw"]);
  assert.equal(first.ineligibleOperations.length, 10);
  assert.equal(first.policyCandidateAvailable, false);
  assert.equal(first.policyCandidate, null);
  assert.equal(first.policySaveAllowed, false);
  assert.equal(first.activationAllowed, false);
  assert.equal(first.productionWriteAllowed, false);
  assert.equal(first.providerContacted, false);
  assert.equal(first.networkCalls, 0);
  assert.equal(first.writesPerformed, 0);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.eligibleOperations), true);
  assert.equal(Object.isFrozen(first.ineligibleOperations), true);
  assert.equal(
    first.ineligibleOperations.every((item) => (
      Object.isFrozen(item) && Object.isFrozen(item.reasonCodes)
    )),
    true,
  );

  const operations = asArray(catalog.operations).map(asRecord);
  const sources = asArray(catalog.sources).map(asRecord);
  assert.equal(operations.length, 11);
  assert.equal(sources.length, 4);
  assert.equal(new Set(operations.map((item) => item.operation)).size, 11);
  assert.equal(new Set(sources.map((item) => item.sourceId)).size, 4);
  assert.equal(
    sources.every((item) => (
      typeof item.officialUrl === "string"
      && item.officialUrl.startsWith("https://help.aliyun.com/zh/model-studio/")
      && item.capturedOn === "2026-08-28"
      && item.sourceEffectiveOn === null
      && item.sourceEffectiveOnStatus === "NOT_STATED_BY_SOURCE"
      && item.region === "cn-beijing"
      && item.currency === "CNY"
    )),
    true,
  );

  const redraw = operation(catalog, "style.redraw");
  const redrawLine = asRecord(asArray(redraw.pricingLines)[0]);
  const imageSource = source(
    catalog,
    "qwen-image-2.0-pro-beijing-output-image",
  );
  const imageFact = asRecord(asArray(imageSource.priceFacts)[0]);
  assert.equal(redrawLine.maxQuantityPerAttempt, 1);
  assert.equal(redrawLine.maxBillableAttempts, 6);
  assert.equal(imageFact.unitQuantity, 1);
  assert.equal(imageFact.unitPriceMinor, 50);
  assert.equal(redraw.providerCostMinor, 300);
  assert.equal(
    Number(redrawLine.maxQuantityPerAttempt)
      * Number(redrawLine.maxBillableAttempts)
      * Number(imageFact.unitPriceMinor)
      / Number(imageFact.unitQuantity),
    redraw.providerCostMinor,
  );
  assert.equal(operation(catalog, "tts.beat").providerCostMinor, null);
  assert.deepEqual(operation(catalog, "tts.beat").reasonCodes, [
    "unbounded_tts_billing_characters",
  ]);
  assert.equal(
    operations.filter((item) => item.eligibility === "eligible").length,
    1,
  );
  assert.equal(
    operations.filter((item) => item.eligibility === "not_eligible").length,
    10,
  );

  const reordered = clone(catalog);
  reordered.operations = asArray(reordered.operations).reverse();
  reordered.sources = asArray(reordered.sources).reverse().map((item) => {
    const record = asRecord(item);
    record.priceFacts = asArray(record.priceFacts).reverse();
    return record;
  });
  for (const item of asArray(reordered.operations).map(asRecord)) {
    item.sourceIds = asArray(item.sourceIds).reverse();
    item.reasonCodes = asArray(item.reasonCodes).reverse();
    item.limitEvidence = asArray(item.limitEvidence).reverse();
    item.pricingLines = asArray(item.pricingLines).reverse();
  }
  const reorderedAssessment = inspectFixedBetaProviderCostCatalog(reordered);
  assert.equal(reorderedAssessment.catalogFingerprint, first.catalogFingerprint);
  assert.deepEqual(reorderedAssessment, first);

  const driftCases: Array<(value: JsonRecord) => void> = [
    (value) => { value.schema = "aistory.fixed-beta-provider-cost-catalog/v2"; },
    (value) => { value.catalogId = "other"; },
    (value) => { value.catalogVersion = "v2-2026-08-28"; },
    (value) => { value.status = "READY"; },
    (value) => { value.providerCurrency = "USD"; },
    (value) => { value.providerMinorUnitScale = 3; },
    (value) => { value.region = "cn-shanghai"; },
    (value) => { value.collectedOn = "2026-08-27"; },
    (value) => { value.candidateEffectiveOn = "not-a-date"; },
    (value) => { value.candidateEffectiveOn = "2026-02-30"; },
    (value) => { asRecord(asArray(value.eligibleEnvelopeAuthorities)[0]).sha256 = "0".repeat(64); },
    (value) => { asRecord(asArray(value.eligibleEnvelopeAuthorities)[0]).path = "lib/other.ts"; },
    (value) => { asRecord(value.review).technicalCoverage = "COMPLETE"; },
    (value) => { asRecord(value.review).founderBusinessAmountApproval = "YES"; },
    (value) => { asRecord(value.review).budgetRiskApproval = "YES"; },
    (value) => { asRecord(value.riskPolicy).bufferBasisPoints = 1; },
    (value) => { asRecord(value.riskPolicy).formula = "floor"; },
    (value) => { asRecord(value.userPricing).fixedCreditsPerOperation = 2; },
    (value) => { asRecord(value.userPricing).providerCostPurpose = "USER_PRICE"; },
    (value) => { value.fingerprint = "sha256:" + "f".repeat(64); },
    (value) => { source(value, "qwen-image-2.0-pro-beijing-output-image").officialUrl = "https://example.com/pricing"; },
    (value) => { source(value, "qwen-image-2.0-pro-beijing-output-image").officialUrl = "https://help.aliyun.com/zh/model-studio/model-pricing?token=x"; },
    (value) => { source(value, "qwen-image-2.0-pro-beijing-output-image").model = "other-model"; },
    (value) => { source(value, "qwen-image-2.0-pro-beijing-output-image").region = "cn-shanghai"; },
    (value) => { asRecord(asArray(source(value, "qwen-image-2.0-pro-beijing-output-image").priceFacts)[0]).unitPriceMinor = 51; },
    (value) => { asRecord(asArray(source(value, "qwen-image-2.0-pro-beijing-output-image").priceFacts)[0]).unitQuantity = 0; },
    (value) => { operation(value, "style.redraw").modality = "text"; },
    (value) => { asRecord(operation(value, "style.redraw").runtimeBinding).model = "sha256:" + "0".repeat(64); },
    (value) => { operation(value, "style.redraw").sourceIds = ["qwen-plus-beijing-token-pricing"]; },
    (value) => { operation(value, "style.redraw").eligibility = "not_eligible"; },
    (value) => { operation(value, "style.redraw").reasonCodes = ["unknown_reason"]; },
    (value) => { asRecord(operation(value, "style.redraw").requestLimits).billableAttemptsMax = 5; },
    (value) => { asRecord(asArray(operation(value, "style.redraw").pricingLines)[0]).maxBillableAttempts = 5; },
    (value) => { operation(value, "style.redraw").cachePolicy = "ignore_cache"; },
    (value) => { operation(value, "style.redraw").retryPolicy = "ignore_retries"; },
    (value) => { operation(value, "style.redraw").aggregationPolicy = "single_attempt"; },
    (value) => { operation(value, "style.redraw").roundingPolicy = "floor"; },
    (value) => { operation(value, "style.redraw").bufferBasisPoints = 1; },
    (value) => { operation(value, "style.redraw").providerCostMinor = 50; },
    (value) => { operation(value, "tts.beat").providerCostMinor = 5; },
    (value) => { operation(value, "tts.beat").formulaId = "minor_cost_v1"; },
    (value) => { operation(value, "tts.beat").pricingLines = clone(operation(value, "style.redraw").pricingLines); },
    (value) => { asRecord(value).unexpected = true; },
    (value) => { asRecord(value.review).unexpected = true; },
    (value) => { asRecord(asArray(value.sources)[0]).unexpected = true; },
    (value) => { asRecord(asArray(value.operations)[0]).unexpected = true; },
    (value) => { value.sources = asArray(value.sources).slice(1); },
    (value) => { value.sources = [...asArray(value.sources), clone(asArray(value.sources)[0])]; },
    (value) => { value.operations = asArray(value.operations).slice(1); },
    (value) => { value.operations = [...asArray(value.operations), clone(asArray(value.operations)[0])]; },
  ];
  for (const mutate of driftCases) {
    const drifted = clone(catalog);
    mutate(drifted);
    expectBlocked(drifted);
  }

  const resignedPrice = clone(catalog);
  asRecord(asArray(source(
    resignedPrice,
    "qwen-image-2.0-pro-beijing-output-image",
  ).priceFacts)[0]).unitPriceMinor = 1;
  operation(resignedPrice, "style.redraw").providerCostMinor = 6;
  resignedPrice.fingerprint = fingerprintFixedBetaProviderCostCatalogDraft(
    resignedPrice,
  );
  assert.notEqual(
    resignedPrice.fingerprint,
    FIXED_BETA_PROVIDER_COST_CATALOG_FINGERPRINT,
  );
  expectBlocked(resignedPrice);

  const resignedRetryEnvelope = clone(catalog);
  asRecord(operation(
    resignedRetryEnvelope,
    "style.redraw",
  ).requestLimits).billableAttemptsMax = 5;
  asRecord(operation(
    resignedRetryEnvelope,
    "style.redraw",
  ).requestLimits).providerInvocationsMax = 5;
  asRecord(asArray(operation(
    resignedRetryEnvelope,
    "style.redraw",
  ).pricingLines)[0]).maxBillableAttempts = 5;
  operation(resignedRetryEnvelope, "style.redraw").providerCostMinor = 250;
  resignedRetryEnvelope.fingerprint =
    fingerprintFixedBetaProviderCostCatalogDraft(resignedRetryEnvelope);
  expectBlocked(resignedRetryEnvelope);

  const resignedModelVersion = clone(catalog);
  source(
    resignedModelVersion,
    "qwen-image-2.0-pro-beijing-output-image",
  ).modelVersion = "qwen-image-2.0-pro-other";
  resignedModelVersion.fingerprint =
    fingerprintFixedBetaProviderCostCatalogDraft(resignedModelVersion);
  expectBlocked(resignedModelVersion);

  const resignedEligibility = clone(catalog);
  const tts = operation(resignedEligibility, "tts.beat");
  tts.eligibility = "eligible";
  tts.reasonCodes = [];
  asRecord(tts.requestLimits).ttsCharactersMax = 600;
  tts.formulaId = "minor_cost_v1";
  tts.pricingLines = [{
    sourceId: "qwen3-tts-flash-beijing-character-pricing",
    factId: "input_weighted_characters",
    maxQuantityPerAttempt: 600,
    maxBillableAttempts: 1,
  }];
  tts.cachePolicy = "cache_hit_zero_cost_miss_uses_full_envelope";
  tts.retryPolicy = "global_worst_case_billable_attempt_bound";
  tts.aggregationPolicy = "sum_all_potentially_billable_attempts";
  tts.providerCostMinor = 5;
  tts.technicalReviewStatus = "MECHANICALLY_VERIFIED";
  resignedEligibility.fingerprint =
    fingerprintFixedBetaProviderCostCatalogDraft(resignedEligibility);
  expectBlocked(resignedEligibility);

  const resignedAuthority = clone(catalog);
  asRecord(asArray(resignedAuthority.eligibleEnvelopeAuthorities)[0]).sha256 =
    "0".repeat(64);
  resignedAuthority.fingerprint =
    fingerprintFixedBetaProviderCostCatalogDraft(resignedAuthority);
  expectBlocked(resignedAuthority);

  const nullPrototype = clone(catalog);
  Object.setPrototypeOf(operation(nullPrototype, "style.redraw"), null);
  expectBlocked(nullPrototype);

  const inheritedPrototype = clone(catalog);
  Object.setPrototypeOf(operation(inheritedPrototype, "style.redraw"), { injected: true });
  expectBlocked(inheritedPrototype);

  const accessor = clone(catalog);
  Object.defineProperty(operation(accessor, "style.redraw"), "providerCostMinor", {
    enumerable: true,
    get: () => 300,
  });
  expectBlocked(accessor);

  const symbol = clone(catalog);
  Object.defineProperty(operation(symbol, "style.redraw"), Symbol("secret"), {
    enumerable: true,
    value: "blocked",
  });
  expectBlocked(symbol);

  const proxied = clone(catalog);
  const proxiedOperations = asArray(proxied.operations);
  proxiedOperations[0] = new Proxy(asRecord(proxiedOperations[0]), {});
  expectBlocked(proxied);

  const sparse = clone(catalog);
  delete asArray(sparse.operations)[3];
  expectBlocked(sparse);

  const arrayProperty = clone(catalog);
  Object.defineProperty(asArray(arrayProperty.operations), "extra", {
    enumerable: true,
    value: true,
  });
  expectBlocked(arrayProperty);

  const arraySymbol = clone(catalog);
  Object.defineProperty(asArray(arraySymbol.operations), Symbol("extra"), {
    enumerable: true,
    value: true,
  });
  expectBlocked(arraySymbol);

  const assessmentText = JSON.stringify(first);
  assert.equal(
    /api[_-]?key|secret|access[_-]?token|auth[_-]?token|authorization|bearer|prompt|workflow|baseurl|endpoint|receipt/i
      .test(assessmentText),
    false,
  );
  assert.equal(/[A-Za-z]:\\|\/etc\/|\/home\/|https?:\/\//.test(assessmentText), false);
  assert.equal(
    /api[_-]?key|authorization|bearer|process\.env|saveBillingPolicy|AdminRepository|fetch\s*\(/i
      .test(moduleText),
    false,
  );
  assert.equal(
    /from\s+["']@\/app\/api|generation-jobs|gpu|comfyui|sms|oss|supabase/i
      .test(moduleText),
    false,
  );
  assert.equal(/100\s*\+\s*index/.test(catalogText), false);
  assert.match(fixedPricingText, /value\.length !== FIXED_BETA_OPERATION_CONTRACT\.length/);
  assert.match(fixedPricingText, /rawEntry\.enabled !== true/);
  assert.match(imageText, /parameters:\s*\{[\s\S]*?n:\s*1,/);
  assert.match(painterText, /Tier A[\s\S]*Tier B/);
  assert.match(ttsRouteText, /typeof body\.beat\.line !== "string"/);
  assert.equal(/body\.beat\.line\.length\s*[<>]=?\s*600/.test(ttsRouteText), false);
  const authorityRows = asArray(catalog.eligibleEnvelopeAuthorities).map(asRecord);
  assert.equal(authorityRows.length, 5);
  for (const authority of authorityRows) {
    assert.equal(typeof authority.path, "string");
    assert.equal(typeof authority.sha256, "string");
    const bytes = await readFile(path.join(process.cwd(), authority.path as string));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      authority.sha256,
      `request-envelope authority drift: ${authority.path as string}`,
    );
  }
  const retrySource = await readFile(
    path.join(process.cwd(), "lib", "ai-client", "fetchWithRetry.ts"),
    "utf8",
  );
  assert.match(retrySource, /retries\s*=\s*2/);
  const styleCacheSource = await readFile(
    path.join(process.cwd(), "lib", "engine", "styleHotSwapCache.ts"),
    "utf8",
  );
  assert.equal((styleCacheSource.match(/\bcompute\(\)/g) ?? []).length, 1);
  assert.equal(fetchCalls, 0);

  console.log(
    `PASS fixed-beta provider cost catalog: fingerprint=${first.catalogFingerprint} operations=11 eligible=1 ineligible=10 style.redraw.providerCostMinor=300 save=false activation=false network=0 writes=0`,
  );
} finally {
  globalThis.fetch = originalFetch;
}
