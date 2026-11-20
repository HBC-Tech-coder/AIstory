import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type GenerationBillingContext =
  import("@/lib/billing/generationGate").GenerationBillingContext;

const SELECTOR = "one-text-request";
const OPERATION = "text.character-names";
const IDEMPOTENCY_KEY = `live-smoke-${randomUUID()}`;
const BILLING_ENV = "AISTORY_PLATFORM_BILLING_ENABLED";

async function main(): Promise<void> {
  if (process.env.AISTORY_LIVE_COST_SMOKE !== SELECTOR) {
    console.log("cost-beta live text smoke: skipped (selector not enabled)");
    return;
  }

  const { loadEngineConfig } = await import("@/lib/config");
  const {
    assertCostBetaPricingPolicy,
    buildCostBetaPricingCandidate,
    COST_BETA_PRICING_MODE_CONFIG,
    COST_BETA_PRICING_MODE_ENV,
    COST_BETA_PRICING_VERSION_ENV,
  } = await import("@/lib/billing/costBetaPricing");
  const { LocalAdminRepository } = await import("@/lib/admin/localRepository");
  const { createUserWithInitialGrant } = await import("@/lib/admin/service");
  const {
    getServerCreditBalance,
    quotePlatformOperation,
    reservePlatformOperation,
    settlePlatformOperation,
  } = await import("@/lib/billing/service");
  const {
    markGenerationBillingOperationFailed,
    markGenerationBillingProviderStarted,
    markGenerationBillingProviderSucceeded,
    refundGenerationBilling,
    settleGenerationBilling,
  } = await import("@/lib/billing/generationGate");
  const { runInCostEnvelope } = await import(
    "@/lib/billing/platformCostEnvelopeServer"
  );
  const { chat } = await import("@/lib/ai-client/chat");

  const config = loadEngineConfig();
  const policy = buildCostBetaPricingCandidate(config as never).policy;

  const previous = {
    billing: process.env[BILLING_ENV],
    mode: process.env[COST_BETA_PRICING_MODE_ENV],
    version: process.env[COST_BETA_PRICING_VERSION_ENV],
  };
  process.env[BILLING_ENV] = "true";
  process.env[COST_BETA_PRICING_MODE_ENV] = COST_BETA_PRICING_MODE_CONFIG;
  process.env[COST_BETA_PRICING_VERSION_ENV] = policy.version;

  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let tmpDir: string | undefined;
  let phase = "setup";
  let report: Record<string, unknown> = {
    ok: false,
    code: "LIVE_SMOKE_SETUP_FAILED",
  };

  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "aistory-live-cost-"));
    const repo = new LocalAdminRepository(path.join(tmpDir, "store.json"));

    // Bypass the admin service save guard on purpose: local-only isolated store.
    const persistedPolicy = { ...policy, entries: policy.entries.map((entry) => ({ ...entry })), updatedAt: new Date().toISOString(), updatedBy: "isolated-live-smoke" };
    const validatePolicy: (value: unknown) => asserts value is import("@/lib/admin/types").BillingPolicy = assertCostBetaPricingPolicy;
    validatePolicy(persistedPolicy);
    await repo.saveBillingPolicy(persistedPolicy);

    const userId = randomUUID();
    await createUserWithInitialGrant(repo, {
      userId,
      tenantId: "platform",
      displayName: "Isolated smoke",
      status: "active",
      userType: "player",
    });
    const initialBalance = await getServerCreditBalance(repo, userId);

    await quotePlatformOperation(repo, OPERATION, config as never);
    const reservation = await reservePlatformOperation(repo, {
      userId,
      operation: OPERATION,
      idempotencyKey: IDEMPOTENCY_KEY,
      runtimeConfig: config as never,
    });
    assert.equal(reservation.replayed, false);

    const context = {
      mode: "platform_managed",
      reservation,
      providerOutcome: "not_started",
    } as GenerationBillingContext;

    const expectedUrl = `${config.text.baseUrl}/chat/completions`;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (url !== expectedUrl || method !== "POST" || fetchCalls >= 1) {
        throw new Error("LIVE_SMOKE_FETCH_GUARD");
      }
      fetchCalls += 1;
      return realFetch(input as never, {
        ...(init ?? {}),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    }) as typeof fetch;

    phase = "provider";
    let terminal: "settle" | "refund" | "none" | "pending" = "pending";
    try {
      markGenerationBillingProviderStarted(context);
      const content = await runInCostEnvelope(
        config as never,
        OPERATION,
        () =>
          chat(
            config.text,
            [{ role: "user", content: "Reply OK only." }],
            { allowServerProxyFallback: false },
          ),
      );
      assert.equal(typeof content, "string");
      assert.ok(content.trim().length > 0);
    } catch {
      markGenerationBillingOperationFailed(context);
      await refundGenerationBilling(context, "LIVE_SMOKE_FAILED", {
        repository: repo,
      });
      throw new Error("LIVE_SMOKE_PROVIDER_FAILED");
    }
    markGenerationBillingProviderSucceeded(context);
    terminal = await settleGenerationBilling(context, { repository: repo });
    assert.equal(terminal, "settle");

    const replay = await reservePlatformOperation(repo, {
      userId,
      operation: OPERATION,
      idempotencyKey: IDEMPOTENCY_KEY,
      runtimeConfig: config as never,
    });
    assert.equal(replay.replayed, true);
    const replayedTerminal = await settlePlatformOperation(repo, replay);
    assert.equal(replayedTerminal.kind, "settle");
    const settledAgain = await settlePlatformOperation(repo, replay);
    assert.equal(settledAgain.kind, "settle");

    const ledger = await repo.listLedger(userId);
    const reserveCount = ledger.filter((e) => e.kind === "reserve").length;
    const settleCount = ledger.filter((e) => e.kind === "settle").length;
    const finalBalance = await getServerCreditBalance(repo, userId);
    assert.equal(reserveCount, 1);
    assert.equal(settleCount, 1);
    assert.equal(
      finalBalance,
      initialBalance - reservation.quote.estimatedCredits,
    );
    assert.equal(finalBalance, 999);

    assert.equal(fetchCalls, 1);
    report = {
      ok: true,
      fetchCalls,
      policyVersion: policy.version,
      responseNonempty: true,
      operation: OPERATION,
      terminal,
      replay: true,
      ledger: { reserve: reserveCount, settle: settleCount },
      balances: { initial: initialBalance, final: finalBalance },
      estimatedProviderCostUpperBoundCny: 0.08,
      actualReceiptUnknown: true,
    };
  } catch {
    report = {
      ok: false,
      code: phase === "provider"
        ? "LIVE_SMOKE_PROVIDER_FAILED"
        : "LIVE_SMOKE_SETUP_FAILED",
    };
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of [
      [BILLING_ENV, previous.billing],
      [COST_BETA_PRICING_MODE_ENV, previous.mode],
      [COST_BETA_PRICING_VERSION_ENV, previous.version],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  report.fetchCalls = fetchCalls;
  report.policyVersion = policy.version;
  report.estimatedProviderCostUpperBoundCny = 0.08;
  report.actualReceiptUnknown = true;
  if (report.ok !== true) process.exitCode = 1;
  const reportPath = tmpDir
    ? path.join(tmpDir, "report.json")
    : undefined;
  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  }
  console.log(
    "cost-beta live text smoke:",
    report.ok ? "ok" : "failed",
    report.ok ? "" : `[${String(report.code)}]`,
  );
  if (reportPath) console.log("report:", reportPath);
}

main().catch(() => { console.error("LIVE_SMOKE_SETUP_FAILED"); process.exitCode = 1; });

