import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { prepareGenerationBilling } from "@/lib/billing/generationGate";
import { authorizeCredentialAccess } from "@/lib/credentials/serverPolicy";

type BilledRoute = {
  file: string;
  operations: string[];
  providerCalls: string[];
  cachePreflight?: string;
  authorLocked?: boolean;
  byok?: boolean;
};

const root = process.cwd();

async function source(file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

async function walkRoutes(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walkRoutes(absolute));
    } else if (entry.name === "route.ts") {
      found.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return found;
}

function indexesOf(sourceText: string, needle: string, from = 0): number[] {
  const indexes: number[] = [];
  let offset = from;
  while (offset < sourceText.length) {
    const index = sourceText.indexOf(needle, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}

/**
 * Finds the matching close delimiter for a source span. Quotes and comments
 * are skipped so braces inside string literals cannot unbalance the scan.
 */
function matchingDelimiter(
  sourceText: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  assert.ok(openIndex >= 0, `missing ${open} delimiter`);
  let depth = 0;
  for (let index = openIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      index += 1;
      while (index < sourceText.length && sourceText[index] !== quote) {
        if (sourceText[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (character === "/" && sourceText[index + 1] === "/") {
      const newline = sourceText.indexOf("\n", index);
      index = newline < 0 ? sourceText.length : newline;
      continue;
    }
    if (character === "/" && sourceText[index + 1] === "*") {
      const commentEnd = sourceText.indexOf("*/", index + 2);
      index = commentEnd < 0 ? sourceText.length : commentEnd + 1;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail(`unbalanced ${open}${close} near index ${openIndex}`);
}

type CallSpan = {
  start: number;
  open: number;
  end: number;
  args: string;
};

function callSpans(sourceText: string, needle: string, from = 0): CallSpan[] {
  return indexesOf(sourceText, needle, from).map((start) => {
    const open = sourceText.indexOf("(", start + needle.length - 1);
    const end = matchingDelimiter(sourceText, open, "(", ")");
    return {
      start,
      open,
      end,
      args: sourceText.slice(open + 1, end),
    };
  });
}

type FunctionRegion = {
  start: number;
  open: number;
  close: number;
  body: string;
};

function functionRegion(sourceText: string, signature: string): FunctionRegion {
  const start = sourceText.indexOf(signature);
  assert.ok(start >= 0, `missing function ${signature}`);
  const open = sourceText.indexOf("{", start + signature.length);
  const close = matchingDelimiter(sourceText, open, "{", "}");
  return {
    start,
    open,
    close,
    body: sourceText.slice(open, close + 1),
  };
}

const billedRoutes: BilledRoute[] = [
  {
    file: "app/api/start/route.ts",
    operations: ["story.start"],
    providerCalls: ["startSession("],
    cachePreflight: "await peekSceneCache",
    byok: true,
  },
  {
    file: "app/api/scene/route.ts",
    operations: ["story.scene", "story.scene.prefetch"],
    providerCalls: ["requestScene("],
    cachePreflight: "await peekSceneCache",
    authorLocked: true,
    byok: true,
  },
  {
    file: "app/api/vision/route.ts",
    operations: ["vision.decide"],
    providerCalls: ["visionDecide("],
    authorLocked: true,
    byok: true,
  },
  {
    file: "app/api/classify-freeform/route.ts",
    operations: ["story.classify-freeform"],
    providerCalls: ["classifyFreeform("],
    authorLocked: true,
    byok: true,
  },
  {
    file: "app/api/insert-beat/route.ts",
    operations: ["story.insert-beat"],
    providerCalls: ["requestInsertBeat("],
    authorLocked: true,
    byok: true,
  },
  {
    file: "app/api/style-hot-swap/route.ts",
    operations: ["style.redraw", "style.rewrite"],
    providerCalls: ["runPainter(", "await chat("],
    cachePreflight: "await peekStyleHotSwapCache",
    authorLocked: true,
  },
  {
    file: "app/api/parse-style-image/route.ts",
    operations: ["vision.style-parse"],
    providerCalls: ["analyzeImageDataUrl("],
  },
  {
    file: "app/api/character-names/route.ts",
    operations: ["text.character-names"],
    providerCalls: ["await chat("],
  },
  {
    file: "app/api/beat-audio/route.ts",
    operations: ["tts.beat"],
    providerCalls: ["requestBeatAudio("],
    cachePreflight: "peekTtsCache(",
  },
];

/**
 * Start/scene platform branches are structurally different from the one-shot
 * utility routes: JSON and SSE both call a shared trusted helper, the provider
 * callback is only passed into that helper, and the helper owns the single
 * provider-start site plus the conditional legacy/v2 success markers.
 */
async function assertTrustedStartSceneHelper(
  file: string,
  helperName: string,
  providerNeedle: string,
  operationMarker: string,
): Promise<void> {
  const text = await source(file);
  const prepareIndex = text.indexOf("prepareGenerationBilling({");
  assert.ok(prepareIndex >= 0, `${file} must prepare billing`);
  const helper = functionRegion(text, `async function ${helperName}(`);
  const helperCalls = callSpans(text, `${helperName}(`)
    .filter((span) => span.start > prepareIndex);
  assert.equal(
    helperCalls.length,
    2,
    `${file}: JSON and SSE branches must each invoke ${helperName} after reserve`,
  );
  const providerIndexes = indexesOf(text, providerNeedle);
  assert.equal(
    providerIndexes.length,
    2,
    `${file}: exactly two actual platform provider calls must remain one per branch`,
  );
  for (const [branch, call] of helperCalls.entries()) {
    const contained = providerIndexes.filter(
      (providerIndex) => providerIndex > call.start && providerIndex < call.end,
    );
    assert.equal(
      contained.length,
      1,
      `${file}: branch ${branch + 1} must pass exactly one provider callback into ${helperName}`,
    );
    assert.equal(
      call.args.includes("() =>"),
      true,
      `${file}: provider callback must be passed to ${helperName}, not invoked outside`,
    );
    assert.ok(call.args.includes("costBetaBilling"), `${file}: helper needs the v2 predicate`);
    assert.ok(call.args.includes("billing"), `${file}: helper needs the reservation context`);
    assert.ok(call.args.includes("config"), `${file}: helper needs the original config identity`);
  }
  const streamIndex = text.indexOf("new ReadableStream(");
  assert.ok(
    streamIndex > 0
      && helperCalls[0]!.start < streamIndex
      && helperCalls[1]!.start > streamIndex,
    `${file}: one helper invocation belongs to JSON and one to SSE`,
  );

  assert.equal(
    indexesOf(text, "markGenerationBillingProviderStarted(").length,
    1,
    `${file}: one provider-start site shared by both platform branches`,
  );
  assert.equal(
    indexesOf(text, "markGenerationBillingOperationFailed(").length,
    1,
    `${file}: only the narrow trusted-helper failure proof may mark failed delivery`,
  );
  assert.equal(
    indexesOf(text, "markGenerationBillingProviderSucceeded(").length,
    2,
    `${file}: legacy and v2 success branches stay inside the trusted helper`,
  );
  assert.equal(
    indexesOf(helper.body, "markGenerationBillingProviderSucceeded(").length,
    2,
    `${file}: success must be marked by the trusted helper, not outside it`,
  );
  assert.equal(
    indexesOf(helper.body, "runInCostEnvelope(").length,
    1,
    `${file}: the trusted helper owns the single v2 envelope`,
  );
  assert.equal(
    indexesOf(helper.body, "markGenerationBillingOperationFailed(").length,
    1,
    `${file}: failure proof belongs inside the trusted helper`,
  );

  const startedIndex = helper.body.indexOf("markGenerationBillingProviderStarted(");
  const legacyIf = helper.body.indexOf("if (!costBetaBilling)");
  assert.ok(
    startedIndex >= 0 && startedIndex < legacyIf,
    `${file}: provider-started must be recorded before branching`,
  );
  const legacyOpen = helper.body.indexOf("{", legacyIf);
  const legacyClose = matchingDelimiter(helper.body, legacyOpen, "{", "}");
  const legacyBody = helper.body.slice(legacyOpen, legacyClose + 1);
  assert.equal(
    legacyBody.includes("runInCostEnvelope"),
    false,
    `${file}: legacy/v1 direct generation must not enter the v2 envelope`,
  );
  assert.ok(legacyBody.includes("await generate()"), `${file}: legacy branch calls the provider directly`);
  const legacySuccess = legacyBody.indexOf("markGenerationBillingProviderSucceeded(");
  assert.ok(
    legacyBody.indexOf("await generate()") < legacySuccess
      && legacySuccess < legacyBody.indexOf("cacheApiResponseImage("),
    `${file}: legacy success ordering (generate -> success -> cache) is preserved`,
  );

  const envelopeCalls = callSpans(helper.body, "runInCostEnvelope(", legacyClose);
  assert.equal(envelopeCalls.length, 1, `${file}: v2 branch wraps exactly one envelope`);
  const envelope = envelopeCalls[0]!;
  assert.ok(
    envelope.args.includes(operationMarker),
    `${file}: envelope must use the pinned platform operation`,
  );
  assert.ok(envelope.args.includes("await generate()"), `${file}: envelope must own the provider callback`);
  assert.ok(
    envelope.args.indexOf("await generate()")
      < envelope.args.indexOf("assertCostBetaGeneratedCore(result)"),
    `${file}: essential core must be validated after generation inside the envelope`,
  );
  assert.equal(
    envelope.args.includes("cacheApiResponseImage"),
    false,
    `${file}: generated output must not be cached inside the envelope callback`,
  );
  assert.equal(
    envelope.args.includes("markGenerationBillingProviderSucceeded"),
    false,
    `${file}: success must not be marked inside the envelope callback`,
  );

  const cacheIndex = helper.body.indexOf("cacheApiResponseImage(generated)", envelope.end);
  const v2SuccessIndex = helper.body.indexOf(
    "markGenerationBillingProviderSucceeded(",
    envelope.end,
  );
  const failureIndex = helper.body.indexOf(
    "markGenerationBillingOperationFailed(",
    envelope.end,
  );
  assert.ok(
    failureIndex > envelope.end && failureIndex < cacheIndex,
    `${file}: narrow post-envelope failure proof must precede cache/success`,
  );
  assert.ok(
    helper.body.indexOf("throw error", failureIndex) > failureIndex,
    `${file}: narrow failure proof must rethrow the original trusted error`,
  );
  assert.ok(
    cacheIndex > envelope.end,
    `${file}: v2 result may only be cached after the envelope completes`,
  );
  assert.ok(
    v2SuccessIndex > cacheIndex,
    `${file}: v2 success must be marked after envelope AND cache preparation`,
  );
}

/**
 * The utility routes keep their legacy flow but gained an explicit v2
 * parse/validation gate, a failed-delivery intent, and a refund. These checks
 * pin both the new v2 ordering and the preserved legacy success-before-parse
 * behavior without counting success markers against provider call sites.
 */
async function assertUtilityV2GenerationStructure(): Promise<void> {
  const names = await source("app/api/character-names/route.ts");
  const namesPrepare = names.indexOf("prepareGenerationBilling({");
  const namesEnvelope = names.indexOf(
    'runInCostEnvelope(config, "text.character-names", generate)',
  );
  const namesV2Parse = names.indexOf("const parsed = parseJsonLoose<RawAiResponse>(raw);");
  const namesV2Collect = names.indexOf(
    "collectAiCandidates(parsed, existingNames, count, body);",
    namesV2Parse,
  );
  const namesSuccess = names.indexOf("markGenerationBillingProviderSucceeded(billing)");
  const namesV2Failure = names.indexOf(
    "markGenerationBillingOperationFailed(billing)",
    namesSuccess,
  );
  const namesV2Refund = names.indexOf("await refundGenerationBilling(", namesV2Failure);
  assert.ok(
    namesPrepare >= 0
      && namesPrepare < namesEnvelope
      && namesEnvelope < namesV2Parse
      && namesV2Parse < namesV2Collect
      && namesV2Collect < namesSuccess,
    "character-names: v2 parse/validation must follow the envelope before success",
  );
  assert.ok(
    namesSuccess < namesV2Failure && namesV2Failure < namesV2Refund,
    "character-names: v2 failed-delivery intent must precede refund",
  );
  assert.match(
    names.slice(namesV2Collect, namesSuccess),
    /if \(!isV2 \|\| \(!v2ParseFailed && candidates\.length > 0\)\)/,
    "character-names: success is gated on usable v2 candidates only",
  );
  const namesLegacyParse = names.indexOf(
    "const parsed = parseJsonLoose<RawAiResponse>(raw);",
    namesSuccess,
  );
  const namesLegacySettle = names.indexOf(
    "await settleGenerationBilling(billing",
    namesLegacyParse,
  );
  assert.ok(
    namesSuccess < namesLegacyParse && namesLegacyParse < namesLegacySettle,
    "character-names: legacy success-before-parse and settle ordering preserved",
  );
  const namesOuterCatch = names.lastIndexOf("} catch {");
  assert.equal(
    names.indexOf("markGenerationBillingOperationFailed", namesOuterCatch),
    -1,
    "character-names: broad DB/response catch must never prove failed delivery",
  );

  const styleParse = await source("app/api/parse-style-image/route.ts");
  const parsePrepare = styleParse.indexOf("prepareGenerationBilling({");
  const parseEnvelope = styleParse.indexOf(
    'runInCostEnvelope(config, "vision.style-parse", generate)',
  );
  const parseV2Parse = styleParse.indexOf("parsed = parseVisionJson(raw);");
  const parseV2Usable = styleParse.indexOf(
    "const v2Usable = !v2ParseFailed && Boolean(stylePrompt);",
  );
  const parseSuccess = styleParse.indexOf("markGenerationBillingProviderSucceeded(billing)");
  const parseV2ParseFailureBranch = styleParse.indexOf("if (v2ParseFailed) {", parseSuccess);
  const parseV2ParseFailure = styleParse.indexOf(
    "markGenerationBillingOperationFailed(billing)",
    parseV2ParseFailureBranch,
  );
  const parseV2ParseRefund = styleParse.indexOf(
    "await refundGenerationBilling(",
    parseV2ParseFailure,
  );
  const parseV2NoPromptBranch = styleParse.indexOf("if (!stylePrompt) {", parseV2ParseRefund);
  const parseV2NoPromptFailure = styleParse.indexOf(
    "markGenerationBillingOperationFailed(billing)",
    parseV2NoPromptBranch,
  );
  const parseV2NoPromptRefund = styleParse.indexOf(
    "await refundGenerationBilling(",
    parseV2NoPromptFailure,
  );
  assert.ok(
    parsePrepare >= 0
      && parsePrepare < parseEnvelope
      && parseEnvelope < parseV2Parse
      && parseV2Parse < parseV2Usable
      && parseV2Usable < parseSuccess,
    "parse-style-image: v2 parse/usability must precede the success marker",
  );
  assert.match(
    styleParse.slice(parseV2Usable, parseSuccess),
    /if \(!isV2 \|\| v2Usable\)/,
    "parse-style-image: success is gated on usable v2 stylePrompt only",
  );
  assert.ok(
    parseSuccess < parseV2ParseFailureBranch
      && parseV2ParseFailureBranch < parseV2ParseFailure
      && parseV2ParseFailure < parseV2ParseRefund
      && parseV2ParseRefund < parseV2NoPromptBranch
      && parseV2NoPromptBranch < parseV2NoPromptFailure
      && parseV2NoPromptFailure < parseV2NoPromptRefund,
    "parse-style-image: v2 failure intent precedes each refund",
  );
  const parseLegacyParse = styleParse.indexOf(
    "const legacyParsed = parseVisionJson(raw);",
  );
  const parseLegacyEmptyBranch = styleParse.indexOf(
    "if (!legacyStylePrompt) {",
    parseLegacyParse,
  );
  const parseLegacyEmptySettle = styleParse.indexOf(
    "await settleGenerationBilling(billing",
    parseLegacyEmptyBranch,
  );
  const parseLegacyEmptyMessage = styleParse.indexOf(
    "Vision model returned an empty stylePrompt",
    parseLegacyEmptySettle,
  );
  assert.ok(
    parseSuccess < parseLegacyParse
      && parseLegacyParse < parseLegacyEmptyBranch
      && parseLegacyEmptyBranch < parseLegacyEmptySettle
      && parseLegacyEmptySettle < parseLegacyEmptyMessage,
    "parse-style-image: legacy success-before-parse and settle-before-502 preserved",
  );
  const parseOuterCatch = styleParse.lastIndexOf("} catch {");
  assert.equal(
    styleParse.indexOf("markGenerationBillingOperationFailed", parseOuterCatch),
    -1,
    "parse-style-image: broad DB/response catch must never prove failed delivery",
  );

  const style = await source("app/api/style-hot-swap/route.ts");
  const stylePrepare = style.indexOf("prepareGenerationBilling({");
  const rewriteEnvelope = style.indexOf(
    'runInCostEnvelope(config, "style.rewrite", generate)',
  );
  const rewriteNormalize = style.indexOf("normalized = normalizeRewrite(parsed);");
  const rewriteUseful = style.indexOf(
    "v2Unusable = !hasUsefulRewrite(sourceBeats, normalized);",
  );
  const rewriteSuccess = style.indexOf(
    "markGenerationBillingProviderSucceeded(billing!)",
    rewriteUseful,
  );
  const rewriteV2Failure = style.indexOf(
    "markGenerationBillingOperationFailed(billing!)",
    rewriteSuccess,
  );
  const rewriteUnusableThrow = style.indexOf(
    'throw new Error("Unusable style rewrite output")',
    rewriteV2Failure,
  );
  const rewriteV2Apply = style.indexOf(
    "return applyExpressionRewrite(sourceBeats, normalized);",
    rewriteUnusableThrow,
  );
  const rewriteLegacyParse = style.indexOf(
    "const legacyParsed = parseJsonLoose<RawRewrite>(raw);",
    rewriteSuccess,
  );
  assert.ok(
    stylePrepare >= 0
      && stylePrepare < rewriteEnvelope
      && rewriteEnvelope < rewriteNormalize
      && rewriteNormalize < rewriteUseful
      && rewriteUseful < rewriteSuccess,
    "style-hot-swap: v2 normalize/usefulness must precede the success marker",
  );
  assert.match(
    style.slice(rewriteUseful, rewriteSuccess),
    /if \(!isV2 \|\| !v2Unusable\)/,
    "style-hot-swap: success is gated on a usable v2 rewrite only",
  );
  assert.ok(
    rewriteSuccess < rewriteV2Failure
      && rewriteV2Failure < rewriteUnusableThrow
      && rewriteUnusableThrow < rewriteV2Apply,
    "style-hot-swap: unusable v2 rewrite records failure before refusing delivery",
  );
  assert.ok(
    rewriteSuccess < rewriteLegacyParse,
    "style-hot-swap: legacy success-before-parse ordering preserved",
  );
  const rewriteOuterCatch = style.lastIndexOf("} catch {");
  assert.equal(
    style.indexOf("markGenerationBillingOperationFailed", rewriteOuterCatch),
    -1,
    "style-hot-swap: broad cache/response catch must never prove failed delivery",
  );
  const normalizeHelper = functionRegion(style, "function normalizeRewrite(");
  assert.match(
    normalizeHelper.body,
    /if \(seenIds\.has\(record\.id\)\) \{\s*throw new Error\("duplicate style rewrite beat id"\);/,
    "style-hot-swap: v2 normalizeRewrite must reject duplicate ids before last-wins application",
  );
}

for (const route of billedRoutes) {
  const text = await source(route.file);
  const prepareIndex = text.indexOf("prepareGenerationBilling({");
  assert.ok(prepareIndex >= 0, `${route.file} must prepare billing`);
  const configIndex = text.indexOf("loadEngineConfig()");
  assert.ok(
    configIndex >= 0 && configIndex < prepareIndex,
    `${route.file} must reject unavailable provider configuration before reserve`,
  );
  assert.ok(
    text.includes("refundGenerationBilling("),
    `${route.file} must have a refund terminal`,
  );
  assert.ok(
    text.includes("runtimeConfig: config"),
    `${route.file} must bind the exact loaded runtime config before reserve`,
  );
  const settlementCalls = text.match(/settleGenerationBilling\([\s\S]*?\);/g) || [];
  assert.ok(settlementCalls.length > 0, `${route.file} must have a settle terminal`);
  for (const call of settlementCalls) {
    assert.match(
      call,
      /requestSignal:/,
      `${route.file} settlement must account for client cancellation`,
    );
  }
  for (const operation of route.operations) {
    assert.ok(text.includes(`"${operation}"`), `${route.file} is missing ${operation}`);
  }
  const providerIndexes = route.providerCalls
    .flatMap((providerCall) => indexesOf(text, providerCall))
    .sort((left, right) => left - right);
  const startedIndexes = indexesOf(
    text,
    "markGenerationBillingProviderStarted(billing",
  );
  const succeededIndexes = indexesOf(
    text,
    "markGenerationBillingProviderSucceeded(billing",
  );
  const callbackDrivenProviderMarker =
    route.file === "app/api/beat-audio/route.ts"
    || route.file === "app/api/style-hot-swap/route.ts"
    || route.file === "app/api/vision/route.ts"
    || route.file === "app/api/classify-freeform/route.ts"
    || route.file === "app/api/insert-beat/route.ts";
  const trustedHelperDriven =
    route.file === "app/api/start/route.ts"
    || route.file === "app/api/scene/route.ts";
  if (!trustedHelperDriven) {
    assert.equal(
      startedIndexes.length,
      providerIndexes.length,
      `${route.file} must mark exactly every actual provider callback entry`,
    );
    assert.equal(
      succeededIndexes.length,
      providerIndexes.length,
      `${route.file} must mark exactly every trusted provider result`,
    );
    for (const [index, providerIndex] of providerIndexes.entries()) {
      assert.ok(providerIndex > prepareIndex, `${route.file} calls provider before reserve`);
      if (!callbackDrivenProviderMarker) {
        assert.ok(
          startedIndexes[index]! < providerIndex
            && providerIndex < succeededIndexes[index]!,
          `${route.file} provider call must be enclosed by started/succeeded markers`,
        );
      }
    }
  }
  if (route.cachePreflight) {
    const cacheIndex = text.indexOf(route.cachePreflight);
    assert.ok(cacheIndex >= 0 && cacheIndex < prepareIndex, `${route.file} must read cache before auth/reserve`);
    assert.match(text, /Cache hit; reservation released\./);
  }
  if (route.authorLocked) {
    const authorGuardIndex = text.indexOf("isAuthoredAiContinuationAllowed(");
    assert.ok(
      authorGuardIndex >= 0 && authorGuardIndex < prepareIndex,
      `${route.file} must reject locked authored content before billing/provider work`,
    );
  }
  if (route.byok) {
    assert.ok(text.includes("assertCompleteByok("), `${route.file} must reject partial BYOK fallback`);
  }
  assert.equal(
    /\b(?:error|err)\.message\b/.test(text),
    false,
    `${route.file} must never return or stream raw exception text`,
  );
}

await assertTrustedStartSceneHelper(
  "app/api/start/route.ts",
  "runStartGeneration",
  "startSession(",
  "GENERATION_OPERATION",
);
await assertTrustedStartSceneHelper(
  "app/api/scene/route.ts",
  "runSceneGeneration",
  "requestScene(",
  "operation",
);
await assertUtilityV2GenerationStructure();

const allApiRoutes = await walkRoutes(path.join(root, "app", "api"));
const discoveredProviderRoutes: string[] = [];
for (const file of allApiRoutes) {
  const text = await source(file);
  if (
    text.includes("export async function POST")
    && (
      text.includes("@infiplot/ai-client")
      || text.includes("@infiplot/engine")
      || text.includes("@/lib/engine/agents/painter")
    )
  ) {
    discoveredProviderRoutes.push(file);
  }
}
assert.deepEqual(
  discoveredProviderRoutes.sort(),
  billedRoutes.map((route) => route.file).sort(),
  "every direct platform provider API route must be classified in the billing matrix",
);

const gate = await source("lib/billing/generationGate.ts");
const service = await source("lib/billing/service.ts");
const policy = await source("lib/credentials/serverPolicy.ts");
assert.ok(policy.includes('input.authType === "phone" && input.userId !== "anonymous"'));
assert.ok(policy.includes('input.authType === "aiuser"'));
assert.ok(policy.includes('input.verifiedLinkedPhoneUserId'));
for (const pseudoId of ["aiuser:synthetic", "00000000-0000-4000-8000-000000000001"]) {
  const unlinked = authorizeCredentialAccess({ requestedMode: "platform_managed", hasByok: false,
    userId: pseudoId, authType: "aiuser", env: { AISTORY_PLATFORM_BILLING_ENABLED: "true" } });
  assert.equal(unlinked.allowed, false, "unlinked AIUser cannot spend platform credits");
  if (!unlinked.allowed) assert.equal(unlinked.code, "PHONE_VERIFICATION_REQUIRED");
}
assert.ok(gate.indexOf("authorizeCredentialAccess({") < gate.indexOf("reservePlatformOperation("));
assert.ok(gate.includes("quotePlatformOperation("), "login rejection must carry a server quote");
assert.ok(gate.includes("IDEMPOTENCY_KEY_REQUIRED"));
assert.ok(gate.includes("BILLING_OPERATION_REPLAYED"));
assert.ok(gate.includes("CREDENTIAL_MODE_CONFLICT"));
assert.equal(
  gate.includes("error: error.message"),
  false,
  "billing failures must expose only fixed redacted messages",
);
assert.ok(service.includes("{8,152}"), "reserve keys must fit the DB after :reserve");
assert.ok(gate.includes('providerOutcome !== "succeeded"'));
assert.ok(gate.includes('providerOutcome !== "not_started"'));
assert.ok(gate.includes('return "pending"'));
assert.equal(
  gate.includes("options.requestSignal?.aborted"),
  false,
  "late client cancellation must not manufacture a provider-not-started refund",
);
const reserveFunction = service.indexOf("export async function reservePlatformOperation");
assert.ok(service.indexOf("await quotePlatformOperation", reserveFunction) > reserveFunction);
assert.ok(
  service.indexOf("repository.reserveLedger", reserveFunction)
    > service.indexOf("await quotePlatformOperation", reserveFunction),
  "quote must precede immutable credit reservation",
);
assert.ok(
  service.includes('costSource: parsedReceipt ? "provider_settlement" : "price_catalog"'),
  "only a typed provider receipt may claim provider_settlement",
);

const previousFormalBilling = process.env.AISTORY_PLATFORM_BILLING_ENABLED;
const previousPlatformManaged = process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
const previousPlatformAllowlist = process.env.AISTORY_PLATFORM_MANAGED_ALLOWLIST;
process.env.AISTORY_PLATFORM_BILLING_ENABLED = "true";
try {
  const missingKey = await prepareGenerationBilling({
    request: new Request("https://aistory.example/api/start", { method: "POST" }),
    auth: { userId: "phone-test-user", authType: "phone" },
    requestedMode: "platform_managed",
    hasByok: false,
    operation: "story.start",
  });
  assert.ok(missingKey instanceof Response);
  assert.equal((await missingKey.json() as { code?: string }).code, "IDEMPOTENCY_KEY_REQUIRED");

  const byok = await prepareGenerationBilling({
    request: new Request("https://aistory.example/api/start", { method: "POST" }),
    auth: { userId: "anonymous", authType: "anonymous" },
    requestedMode: "user_byok",
    hasByok: true,
    operation: "story.start",
  });
  assert.equal(byok instanceof Response, false);
  if (!(byok instanceof Response)) {
    assert.equal(byok.mode, "user_byok");
    assert.equal(byok.reservation, undefined, "BYOK must never reserve platform credits");
  }

  const credentialConflict = await prepareGenerationBilling({
    request: new Request("https://aistory.example/api/start", {
      method: "POST",
      headers: { "X-Idempotency-Key": "platform-mode-conflict" },
    }),
    auth: { userId: "phone-test-user", authType: "phone" },
    requestedMode: "platform_managed",
    hasByok: true,
    operation: "story.start",
  });
  assert.ok(credentialConflict instanceof Response);
  assert.equal(credentialConflict.status, 400);
  assert.equal(
    (await credentialConflict.json() as { code?: string }).code,
    "CREDENTIAL_MODE_CONFLICT",
  );

  delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  process.env.AISTORY_PLATFORM_MANAGED_ENABLED = "true";
  process.env.AISTORY_PLATFORM_MANAGED_ALLOWLIST = "phone-test-user";
  const legacyMissingKey = await prepareGenerationBilling({
    request: new Request("https://aistory.example/api/scene", { method: "POST" }),
    auth: { userId: "phone-test-user", authType: "phone" },
    requestedMode: "platform_managed",
    hasByok: false,
    operation: "story.scene",
  });
  assert.ok(legacyMissingKey instanceof Response);
  assert.equal(
    (await legacyMissingKey.json() as { code?: string }).code,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
} finally {
  if (previousFormalBilling === undefined) {
    delete process.env.AISTORY_PLATFORM_BILLING_ENABLED;
  } else {
    process.env.AISTORY_PLATFORM_BILLING_ENABLED = previousFormalBilling;
  }
  if (previousPlatformManaged === undefined) {
    delete process.env.AISTORY_PLATFORM_MANAGED_ENABLED;
  } else {
    process.env.AISTORY_PLATFORM_MANAGED_ENABLED = previousPlatformManaged;
  }
  if (previousPlatformAllowlist === undefined) {
    delete process.env.AISTORY_PLATFORM_MANAGED_ALLOWLIST;
  } else {
    process.env.AISTORY_PLATFORM_MANAGED_ALLOWLIST = previousPlatformAllowlist;
  }
}

const sceneRoute = await source("app/api/scene/route.ts");
assert.equal(
  indexesOf(sceneRoute, 'billing.providerOutcome === "not_started"').length,
  2,
  "scene JSON/SSE single-flight followers must refund without a second provider call",
);
const beatAudio = await source("app/api/beat-audio/route.ts");
assert.ok(
  beatAudio.indexOf("if (!config.tts)")
    < beatAudio.indexOf("prepareGenerationBilling({"),
  "disabled TTS must not create a reservation",
);
assert.ok(
  beatAudio.indexOf("model: config.tts.speechModel")
    < beatAudio.indexOf("beatAudioCacheKey(config.tts, billingBody)"),
  "platform TTS must pin client voice.model to the server model before cache/provider work",
);
const beatAudioCall = beatAudio.indexOf("requestBeatAudio(config, billingBody, {");
const beatAudioHook = beatAudio.indexOf("onProviderStarted:", beatAudioCall);
const beatAudioHookMarker = beatAudio.indexOf(
  "markGenerationBillingProviderStarted(billing)",
  beatAudioHook,
);
assert.ok(
  beatAudioCall >= 0
    && beatAudioHook > beatAudioCall
    && beatAudioHookMarker > beatAudioHook,
  "beat audio must mark billing through the provider-boundary hook",
);
assert.doesNotMatch(
  beatAudio.slice(beatAudio.indexOf('async () => {', beatAudio.indexOf('"api/beat-audio"')), beatAudioCall),
  /markGenerationBillingProviderStarted/,
  "beat audio must not mark provider-started before entering requestBeatAudio",
);
const styleHotSwap = await source("app/api/style-hot-swap/route.ts");
assert.ok(
  styleHotSwap.indexOf('body.action === "redraw-current" && config.mockImage')
    < styleHotSwap.indexOf("prepareGenerationBilling({"),
  "mock-only image mode must not create a reservation",
);
const painterCall = styleHotSwap.indexOf("runPainter(");
const painterHook = styleHotSwap.indexOf("onProviderStarted:", painterCall);
const painterHookMarker = styleHotSwap.indexOf(
  "markGenerationBillingProviderStarted(billing!)",
  painterHook,
);
assert.ok(
  painterCall >= 0 && painterHook > painterCall && painterHookMarker > painterHook,
  "style redraw must mark billing through the painter provider-boundary hook",
);
for (const [routeFile, providerCall] of [
  ["app/api/vision/route.ts", "visionDecide(config, body, {"],
  ["app/api/classify-freeform/route.ts", "classifyFreeform(config, body, {"],
  ["app/api/insert-beat/route.ts", "requestInsertBeat(config, body, {"],
] as const) {
  const routeSource = await source(routeFile);
  const callIndex = routeSource.indexOf(providerCall);
  const hookIndex = routeSource.indexOf("onProviderStarted:", callIndex);
  const markerIndex = routeSource.indexOf(
    "markGenerationBillingProviderStarted(billing)",
    hookIndex,
  );
  assert.ok(
    callIndex >= 0 && hookIndex > callIndex && markerIndex > hookIndex,
    `${routeFile} must mark billing through the provider-boundary hook`,
  );
}

for (const clientFile of [
  "lib/engineClient.ts",
  "components/StoryCharacterModal.tsx",
  "lib/exportAudio.ts",
  "app/[locale]/page.tsx",
  "app/[locale]/play/page.tsx",
]) {
  assert.ok(
    (await source(clientFile)).includes('"X-Idempotency-Key"'),
    `${clientFile} must send idempotency keys for platform generation`,
  );
}

const localMiniDramaServer = await source("lib/localminidrama/server.ts");
assert.ok(
  localMiniDramaServer.indexOf("!isLoopbackServiceUrl(backendUrl)")
    < localMiniDramaServer.indexOf("const response = await fetcher("),
  "LocalMiniDrama must reject non-loopback targets before fetch",
);
for (const [file, guard] of [
  ["app/api/localminidrama/continuation/route.ts", "assertTrustedLoopbackMutation("],
  ["app/api/localminidrama/dramas/route.ts", "assertTrustedLoopbackMutation("],
  ["app/api/localminidrama/status/route.ts", "isLoopbackReadRequest("],
  ["app/api/localminidrama/capabilities/route.ts", "isLoopbackReadRequest("],
  ["app/api/localminidrama/projects/[projectId]/context/route.ts", "isLoopbackReadRequest("],
] as const) {
  assert.ok((await source(file)).includes(guard), `${file} must remain loopback-only`);
}

const generationJobs = await source("app/api/generation-jobs/route.ts");
assert.ok(
  generationJobs.indexOf("assertTrustedLoopbackMutation(request)")
    < generationJobs.indexOf("scheduler.submitComfyUI("),
  "local image/video submissions must remain behind the loopback mutation gate",
);
const volcengine = await source("lib/providers/volcengine-agent-plan/server.ts");
assert.ok(volcengine.includes("networkEnabled: false"));
assert.equal(volcengine.includes("await fetch("), false, "Agent Plan must remain contract-only");

const config = await source("lib/config.ts");
assert.ok(config.includes("tts: undefined"), "server BYOK must not inherit platform TTS");

const accountMe = await source("app/api/account/me/route.ts");
for (const privateBillingField of [
  "providerCostMinor",
  "providerCurrency",
  "providerMinorUnitScale",
  "pricePolicyVersion",
  "billingOperationId",
]) {
  assert.equal(
    accountMe.includes(privateBillingField),
    false,
    `account DTO must not expose ${privateBillingField}`,
  );
}

console.log("platform generation billing coverage tests passed");
