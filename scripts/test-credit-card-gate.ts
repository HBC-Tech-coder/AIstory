import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CREDIT_CARD_DATABASE_GATE_VERSION,
  normalizeCreditCardNumber,
  normalizeCreditCardPin,
  parseCreditCardAdminAction,
  parseCreditCardRedeemAction,
  type CreditCardBatchSummary,
} from "../lib/billing/creditCards";
import {
  activateCreditCardBatch,
  disableCreditCardBatch,
  inspectCreditCardProductionGate,
  isCreditCardSameOriginRequest,
  issueCreditCardBatch,
  loadCreditCardRuntimePolicy,
  parseCreditCardRuntimePolicy,
  readCreditCardJsonBody,
  redeemCreditCard,
  type CreditCardAdminAuthorization,
  type CreditCardIssueStoreInput,
  type CreditCardRepository,
  type CreditCardRedeemStoreInput,
  type CreditCardStoreRedeemResult,
} from "../lib/billing/creditCardsServer";

const HASH = "a".repeat(64);
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-28T15:00:00.000Z");

const authorization: CreditCardAdminAuthorization = Object.freeze({
  binding: Object.freeze({
    principalId: `iap_${"1".repeat(32)}`,
    credentialBindingSha256: HASH,
    credentialEpochSha256: "b".repeat(64),
    passwordVerifierReferenceSha256: "c".repeat(64),
    passwordAlgorithm: "scrypt-v1",
    passwordParameters: Object.freeze({
      N: 131072,
      r: 8,
      p: 1,
      keyLength: 64,
      maxmem: 268435456,
    }),
  }),
  sessionIdHash: "d".repeat(64),
});

const policy = parseCreditCardRuntimePolicy({
  schemaVersion: "aistory.credit-card-runtime.v1",
  policyVersion: "credit-card-policy-v1.synthetic",
  keyId: "cck_synthetic_v1",
  hmacKeyBase64url: Buffer.alloc(32, 7).toString("base64url"),
  allowedDenominations: [100, 500],
  allowedValidityDays: [7, 30],
  maxBatchCount: 4,
  maxBatchCredits: 2000,
});

type StoredBatch = {
  summary: CreditCardBatchSummary;
  activationHash: string;
  cards: Array<{ locatorHash: string; verifierHash: string; state: string }>;
  fingerprint: string;
};

class FakeRepository implements CreditCardRepository {
  readonly batches = new Map<string, StoredBatch>();
  readonly idempotency = new Map<string, string>();
  readonly redeemed = new Map<string, {
    fingerprint: string;
    result: Extract<CreditCardStoreRedeemResult, { kind: "redeemed" }>;
  }>();
  failIssue = false;
  forceRateLimit = false;

  async assertGateReady(): Promise<void> {}

  async listBatches(): Promise<readonly CreditCardBatchSummary[]> {
    return [...this.batches.values()].map((item) => item.summary);
  }

  async issueBatch(input: CreditCardIssueStoreInput) {
    if (this.failIssue) throw new Error("synthetic atomic failure");
    const priorId = this.idempotency.get(input.idempotencyKey);
    if (priorId) {
      const prior = this.batches.get(priorId)!;
      assert.equal(prior.fingerprint, input.requestFingerprint);
      return { batch: prior.summary, replayed: true } as const;
    }
    const summary: CreditCardBatchSummary = Object.freeze({
      batchId: input.batchId,
      denominationCredits: input.denominationCredits,
      quantity: input.quantity,
      redeemedCount: 0,
      remainingCount: input.quantity,
      disabledCount: 0,
      expiredCount: 0,
      state: "pending_activation",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
    this.batches.set(input.batchId, {
      summary,
      activationHash: input.activationTokenHash,
      cards: input.cards.map((item) => ({ ...item, state: "active" })),
      fingerprint: input.requestFingerprint,
    });
    this.idempotency.set(input.idempotencyKey, input.batchId);
    return { batch: summary, replayed: false } as const;
  }

  async activateBatch(input: {
    batchId: string;
    activationTokenHash: string;
    occurredAt: string;
  }) {
    const batch = this.batches.get(input.batchId)!;
    assert.equal(input.activationTokenHash, batch.activationHash);
    batch.summary = Object.freeze({
      ...batch.summary,
      state: "active",
      activatedAt: input.occurredAt,
    });
    return batch.summary;
  }

  async disableBatch(input: { batchId: string; occurredAt: string }) {
    const batch = this.batches.get(input.batchId)!;
    const disabled = batch.cards.filter((card) => card.state === "active").length;
    for (const card of batch.cards) {
      if (card.state === "active") card.state = "disabled";
    }
    batch.summary = Object.freeze({
      ...batch.summary,
      state: "disabled",
      remainingCount: 0,
      disabledCount: batch.summary.disabledCount + disabled,
      disabledAt: input.occurredAt,
    });
    return batch.summary;
  }

  async disableCard(): Promise<CreditCardBatchSummary> {
    throw new Error("not used by this fake");
  }

  async redeem(input: CreditCardRedeemStoreInput): Promise<CreditCardStoreRedeemResult> {
    if (this.forceRateLimit) {
      return { kind: "rate_limited", retryAfterSeconds: 60 };
    }
    const replay = this.redeemed.get(`${input.userId}:${input.idempotencyKey}`);
    if (replay) {
      return replay.fingerprint === input.requestFingerprint
        ? { ...replay.result, replayed: true }
        : { kind: "unavailable" };
    }
    for (const batch of this.batches.values()) {
      const card = batch.cards.find((candidate) => (
        candidate.locatorHash === input.locatorHash
      ));
      if (!card || card.verifierHash !== input.verifierHash) continue;
      if (
        batch.summary.state !== "active"
        || card.state !== "active"
        || Date.parse(batch.summary.expiresAt) <= Date.parse(input.occurredAt)
      ) {
        return { kind: "unavailable" };
      }
      card.state = "redeemed";
      batch.summary = Object.freeze({
        ...batch.summary,
        redeemedCount: batch.summary.redeemedCount + 1,
        remainingCount: batch.summary.remainingCount - 1,
      });
      const result = Object.freeze({
        kind: "redeemed" as const,
        creditedCredits: batch.summary.denominationCredits,
        balanceAfter: 1000 + batch.summary.denominationCredits,
        redeemedAt: input.occurredAt,
        replayed: false,
      });
      this.redeemed.set(`${input.userId}:${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    }
    return { kind: "unavailable" };
  }
}

function deterministicRandom(seed = 1) {
  let counter = seed;
  return (size: number) => {
    const output = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      output[index] = (counter + index) & 0xff;
    }
    counter += size;
    return output;
  };
}

async function main() {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network forbidden");
  }) as typeof fetch;
  try {
    assert.equal(normalizeCreditCardNumber("ac1-00000-00000-00000-00000-000000"), "AC100000000000000000000000000");
    assert.equal(normalizeCreditCardPin("00000-00000-00000-00000-000000"), "00000000000000000000000000");
    assert.equal(normalizeCreditCardPin("contains-i"), undefined);
    assert.equal(parseCreditCardAdminAction({ action: "issue" }), undefined);
    assert.equal(parseCreditCardAdminAction(Object.create({ action: "issue" })), undefined);
    assert.equal(parseCreditCardRedeemAction({
      cardNumber: "x", pin: "x", idempotencyKey: "x", extra: true,
    }), undefined);
    const accessor: Record<string, unknown> = {
      cardNumber: "AC1" + "0".repeat(26),
      pin: "0".repeat(26),
    };
    Object.defineProperty(accessor, "idempotencyKey", { get: () => `ccr_${"x".repeat(24)}`, enumerable: true });
    assert.equal(parseCreditCardRedeemAction(accessor), undefined);

    assert.equal(inspectCreditCardProductionGate({}).ready, false);
    const syntheticGateEnv = {
      AISTORY_CREDIT_CARD_MODE: "production_v1",
      AISTORY_CREDIT_CARD_CONFIG_FILE: "D:\\AIstory\\..secret\\credit-card.json",
      AISTORY_CREDIT_CARD_DATABASE_GATE_VERSION: CREDIT_CARD_DATABASE_GATE_VERSION,
      AISTORY_CREDIT_CARD_PUBLIC_ORIGIN: "https://beta.example.test",
      AISTORY_ADMIN_PRINCIPAL_MODE: "aistory-independent-admin-principal-v1:production_v1",
      AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE: "D:\\protected\\admin.json",
      AISTORY_ADMIN_PRINCIPAL_DATABASE_GATE_VERSION: "20260828230000",
      AISTORY_ADMIN_PRINCIPAL_PUBLIC_ORIGIN: "https://beta.example.test",
      AISTORY_TRUST_PROXY_HEADERS: "true",
      AISTORY_PRODUCTION_IDENTITY_ENABLED: "true",
      AISTORY_IDENTITY_REPOSITORY: "supabase",
      AISTORY_ADMIN_REPOSITORY: "supabase",
      AISTORY_DATABASE_GATE_VERSION: "20260811193000",
      AISTORY_ANONYMOUS_SESSION_SECRET: "s".repeat(32),
      AISTORY_ANONYMOUS_SUBJECT_PEPPER: "p".repeat(32),
      AISTORY_SUPABASE_SERVER_URL: "https://database.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-placeholder",
    };
    assert.equal(inspectCreditCardProductionGate(syntheticGateEnv).ready, true);
    await assert.rejects(loadCreditCardRuntimePolicy({
      env: syntheticGateEnv,
      workspaceRoot: "D:\\AIstory",
    }));
    assert.equal(inspectCreditCardProductionGate({
      ...syntheticGateEnv,
      AISTORY_ADMIN_PRINCIPAL_PUBLIC_ORIGIN: "https://other.example.test",
    }).ready, false);
    assert.throws(() => parseCreditCardRuntimePolicy({ ...policy, extra: true }));
    assert.throws(() => parseCreditCardRuntimePolicy({
      schemaVersion: "aistory.credit-card-runtime.v1",
      policyVersion: "credit-card-policy-v1.synthetic",
      keyId: "cck_synthetic_v1",
      hmacKeyBase64url: Buffer.alloc(31).toString("base64url"),
      allowedDenominations: [100], allowedValidityDays: [7],
      maxBatchCount: 1, maxBatchCredits: 100,
    }));

    const goodRequest = new Request("https://beta.example.test/api/x", {
      method: "POST",
      headers: { origin: "https://beta.example.test", host: "beta.example.test" },
    });
    assert.equal(isCreditCardSameOriginRequest(goodRequest, "https://beta.example.test"), true);
    const crossOrigin = new Request("https://beta.example.test/api/x", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "beta.example.test" },
    });
    assert.equal(isCreditCardSameOriginRequest(crossOrigin, "https://beta.example.test"), false);
    const body = JSON.stringify({ ok: true });
    assert.deepEqual(await readCreditCardJsonBody(new Request("https://beta.example.test", {
      method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body,
    })), { ok: true });
    assert.equal(await readCreditCardJsonBody(new Request("https://beta.example.test", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body,
    })), undefined);
    assert.equal(await readCreditCardJsonBody(new Request("https://beta.example.test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ oversized: "x".repeat(9000) }),
    }), 4096), undefined);

    const repository = new FakeRepository();
    const issued = await issueCreditCardBatch({
      repository, authorization, policy, denominationCredits: 100,
      quantity: 2, validityDays: 7,
      idempotencyKey: `ccr_${"i".repeat(24)}`,
      now: NOW, random: deterministicRandom(),
    });
    assert.equal(issued.deliveryAvailable, true);
    assert.equal(issued.oneTimeDelivery?.cards.length, 2);
    assert.equal(JSON.stringify(repository).includes(issued.oneTimeDelivery!.cards[0]!.cardNumber), false);
    assert.equal(JSON.stringify(repository).includes(issued.oneTimeDelivery!.cards[0]!.pin), false);

    const replay = await issueCreditCardBatch({
      repository, authorization, policy, denominationCredits: 100,
      quantity: 2, validityDays: 7,
      idempotencyKey: `ccr_${"i".repeat(24)}`,
      now: NOW + 1, random: deterministicRandom(),
    });
    assert.equal(replay.deliveryAvailable, false);
    assert.equal(replay.oneTimeDelivery, undefined);
    assert.equal(replay.batch.batchId, issued.batch.batchId);

    await activateCreditCardBatch({
      repository, authorization, policy,
      batchId: issued.oneTimeDelivery!.batchId,
      activationToken: issued.oneTimeDelivery!.activationToken,
      now: NOW + 1000,
    });
    const card = issued.oneTimeDelivery!.cards[0]!;
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_A, cardNumber: card.cardNumber,
      pin: "0".repeat(26), idempotencyKey: `ccr_${"w".repeat(24)}`, now: NOW + 2000,
    }));
    const redeemed = await redeemCreditCard({
      repository, policy, userId: USER_A, cardNumber: card.cardNumber,
      pin: card.pin, idempotencyKey: `ccr_${"r".repeat(24)}`, now: NOW + 3000,
    });
    assert.equal(redeemed.creditedCredits, 100);
    assert.equal(redeemed.replayed, false);
    const redeemedReplay = await redeemCreditCard({
      repository, policy, userId: USER_A, cardNumber: card.cardNumber,
      pin: card.pin, idempotencyKey: `ccr_${"r".repeat(24)}`, now: NOW + 4000,
    });
    assert.equal(redeemedReplay.replayed, true);
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_A, cardNumber: card.cardNumber,
      pin: "0".repeat(26), idempotencyKey: `ccr_${"r".repeat(24)}`,
      now: NOW + 4500,
    }));
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_B, cardNumber: card.cardNumber,
      pin: card.pin, idempotencyKey: `ccr_${"c".repeat(24)}`, now: NOW + 5000,
    }));

    const second = issued.oneTimeDelivery!.cards[1]!;
    const concurrent = await Promise.allSettled([
      redeemCreditCard({ repository, policy, userId: USER_A,
        cardNumber: second.cardNumber, pin: second.pin,
        idempotencyKey: `ccr_${"1".repeat(24)}`, now: NOW + 6000 }),
      redeemCreditCard({ repository, policy, userId: USER_B,
        cardNumber: second.cardNumber, pin: second.pin,
        idempotencyKey: `ccr_${"2".repeat(24)}`, now: NOW + 6000 }),
    ]);
    assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);

    const disabled = await issueCreditCardBatch({
      repository, authorization, policy, denominationCredits: 500,
      quantity: 1, validityDays: 7,
      idempotencyKey: `ccr_${"d".repeat(24)}`, now: NOW,
      random: deterministicRandom(80),
    });
    await disableCreditCardBatch({
      repository, authorization, batchId: disabled.batch.batchId, now: NOW + 10,
    });
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_A,
      cardNumber: disabled.oneTimeDelivery!.cards[0]!.cardNumber,
      pin: disabled.oneTimeDelivery!.cards[0]!.pin,
      idempotencyKey: `ccr_${"e".repeat(24)}`, now: NOW + 20,
    }));

    const crossBatch = await issueCreditCardBatch({
      repository, authorization, policy, denominationCredits: 100,
      quantity: 1, validityDays: 7,
      idempotencyKey: `ccr_${"x".repeat(24)}`, now: NOW,
      random: deterministicRandom(160),
    });
    await activateCreditCardBatch({
      repository, authorization, policy,
      batchId: crossBatch.batch.batchId,
      activationToken: crossBatch.oneTimeDelivery!.activationToken,
      now: NOW + 10,
    });
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_A,
      cardNumber: crossBatch.oneTimeDelivery!.cards[0]!.cardNumber,
      pin: disabled.oneTimeDelivery!.cards[0]!.pin,
      idempotencyKey: `ccr_${"m".repeat(24)}`, now: NOW + 20,
    }));
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_A,
      cardNumber: crossBatch.oneTimeDelivery!.cards[0]!.cardNumber,
      pin: crossBatch.oneTimeDelivery!.cards[0]!.pin,
      idempotencyKey: `ccr_${"z".repeat(24)}`,
      now: NOW + 8 * 24 * 60 * 60 * 1000,
    }));

    repository.forceRateLimit = true;
    await assert.rejects(redeemCreditCard({
      repository, policy, userId: USER_A,
      cardNumber: crossBatch.oneTimeDelivery!.cards[0]!.cardNumber,
      pin: crossBatch.oneTimeDelivery!.cards[0]!.pin,
      idempotencyKey: `ccr_${"l".repeat(24)}`, now: NOW + 30,
    }), (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "CREDIT_CARD_RATE_LIMITED"
    ));
    repository.forceRateLimit = false;

    const atomic = new FakeRepository(); atomic.failIssue = true;
    await assert.rejects(issueCreditCardBatch({
      repository: atomic, authorization, policy, denominationCredits: 100,
      quantity: 1, validityDays: 7,
      idempotencyKey: `ccr_${"f".repeat(24)}`, now: NOW,
      random: deterministicRandom(220),
    }));
    assert.equal(atomic.batches.size, 0);

    const migration = await readFile(path.join(process.cwd(), "supabase/migrations/20260828234500_credit_card_gate.sql"), "utf8");
    for (const required of [
      "billing_policies_initial_grant_1000",
      "initial_grant_credits = 1000",
      "aistory_credit_card_admin_create_batch",
      "aistory_credit_card_redeem",
      "aistory_independent_admin_verify_session",
      "aistory:credit-card:program-key-binding:v1",
      "aistory:credit-card:principal-issue-rate:v1:",
      "identity_type = 'phone'",
      "kind,amount,reason,idempotency_key",
      "'reward'",
      "credit_card_redemptions_append_only",
      "trigger_row.tgenabled = 'O'",
      "aistory_reject_append_only_mutation()'::regprocedure::oid",
      "pg_catalog.pg_get_expr(",
      "force row level security",
      "revoke all on table public.credit_cards",
      `values ('credit_card_program', '${CREDIT_CARD_DATABASE_GATE_VERSION}')`,
    ]) assert.ok(migration.toLowerCase().includes(required.toLowerCase()), required);
    for (const forbidden of [
      "update public.credit_accounts set balance_snapshot",
      "insert into public.profiles",
      "phone_number",
      "masked_phone",
      "card_number",
      " pin ",
      "trigger_row.tgenabled <> 'D'",
      "pg_catalog.pg_get_constraintdef(",
    ]) assert.equal(migration.toLowerCase().includes(forbidden), false, forbidden);

    const serverSource = await readFile(path.join(process.cwd(), "lib/billing/creditCardsServer.ts"), "utf8");
    const forbiddenServerCalls = ["fetch(", "console."];
    for (const value of forbiddenServerCalls) {
      assert.equal(serverSource.includes(value), false, value);
    }
    const adminRoute = await readFile(path.join(
      process.cwd(), "app/api/admin/credit-cards/route.ts",
    ), "utf8");
    const userRoute = await readFile(path.join(
      process.cwd(), "app/api/account/credit-cards/redeem/route.ts",
    ), "utf8");
    for (const required of [
      "resolveIndependentAdminPrincipalAuthorizedContext",
      "context.databaseContext",
      '"Cache-Control": "private, no-store, max-age=0"',
      'Pragma: "no-cache"',
      'Vary: "Cookie"',
      "isCreditCardSameOriginRequest",
      "readCreditCardJsonBody",
    ]) assert.equal(adminRoute.includes(required), true, required);
    assert.equal(adminRoute.includes("requireAdmin("), false);
    for (const required of [
      "requireUser()",
      'auth.authType !== "phone"',
      "isCreditCardSameOriginRequest",
      "error.retryAfterSeconds",
      'response.headers.set("Retry-After"',
      '"Cache-Control": "private, no-store, max-age=0"',
    ]) assert.equal(userRoute.includes(required), true, required);
    for (const source of [adminRoute, userRoute]) {
      assert.equal(source.includes("console."), false);
      assert.equal(source.includes("error.message"), false);
      assert.equal(source.includes("phoneNumber"), false);
    }
    assert.equal(fetchCalls, 0);
    console.log("credit-card gate tests: PASS (zero network, hash-only persistence, one-time delivery, atomic ledger contract)");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
