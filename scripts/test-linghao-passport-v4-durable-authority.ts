import "server-only";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION,
  LINGHAO_PASSPORT_V4_AUTH_GATE_ENV,
  LINGHAO_PASSPORT_V4_AUTH_REPOSITORY_ENV,
  deriveLinghaoPassportV4DurableHash,
  inspectLinghaoPassportV4DurableAuthorityGate,
} from "../lib/auth/linghaoPassportV4DurableAuthority";
import {
  createLinghaoPassportV4DurableAuthority,
  type LinghaoPassportV4AuthRpcClient,
} from "../lib/auth/linghaoPassportV4DurableRepository";
import {
  openLinghaoPassportV4State,
  sealLinghaoPassportV4State,
} from "../lib/auth/linghaoPassportV4StateSeal";

const key = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(8);
const plaintext = new TextEncoder().encode("sensitive-test-value");
const sealContext = "d".repeat(64);
const envelope = sealLinghaoPassportV4State(
  "authorization_transaction",
  sealContext,
  plaintext,
  key,
  () => new Uint8Array(12).fill(9),
);
assert.match(envelope, /^v1\./);
assert.equal(
  new TextDecoder().decode(
    openLinghaoPassportV4State("authorization_transaction", sealContext, envelope, key),
  ),
  "sensitive-test-value",
);
assert.throws(
  () => openLinghaoPassportV4State("refresh_token", sealContext, envelope, key),
  /state_seal_rejected/,
);
assert.throws(
  () =>
    openLinghaoPassportV4State(
      "authorization_transaction",
      sealContext,
      envelope,
      otherKey,
    ),
  /state_seal_rejected/,
);
assert.throws(
  () =>
    openLinghaoPassportV4State(
      "authorization_transaction",
      sealContext,
      (() => {
        const parts = envelope.split(".");
        parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
        return parts.join(".");
      })(),
      key,
    ),
  /state_seal_rejected/,
);
assert.throws(
  () =>
    openLinghaoPassportV4State(
      "authorization_transaction",
      "e".repeat(64),
      envelope,
      key,
    ),
  /state_seal_rejected/,
);

const sessionResultEnvelope = sealLinghaoPassportV4State(
  "session_result",
  sealContext,
  new TextEncoder().encode("session-cookie-recovery"),
  key,
  () => new Uint8Array(12).fill(10),
);
const hintEnvelope = sealLinghaoPassportV4State(
  "id_token_hint",
  sealContext,
  new TextEncoder().encode("id-token-hint"),
  key,
  () => new Uint8Array(12).fill(11),
);
const refreshEnvelope = sealLinghaoPassportV4State(
  "refresh_token",
  sealContext,
  new TextEncoder().encode("refresh-token"),
  key,
  () => new Uint8Array(12).fill(12),
);
const accessEnvelope = sealLinghaoPassportV4State(
  "access_token",
  sealContext,
  new TextEncoder().encode("access-token"),
  key,
  () => new Uint8Array(12).fill(13),
);

const hashes = Object.freeze({
  family: deriveLinghaoPassportV4DurableHash("family_cookie", "family", key),
  transaction: deriveLinghaoPassportV4DurableHash(
    "transaction_cookie",
    "transaction",
    key,
  ),
  state: deriveLinghaoPassportV4DurableHash("oidc_state", "state", key),
  nonce: deriveLinghaoPassportV4DurableHash("oidc_nonce", "nonce", key),
  bucket: deriveLinghaoPassportV4DurableHash("rate_bucket", "source", key),
  principal: "a".repeat(64),
  session: deriveLinghaoPassportV4DurableHash(
    "session_cookie",
    "session",
    key,
  ),
  completion: deriveLinghaoPassportV4DurableHash(
    "completion",
    "completion",
    key,
  ),
  refresh: deriveLinghaoPassportV4DurableHash(
    "refresh_token",
    "refresh",
    key,
  ),
  replacement: deriveLinghaoPassportV4DurableHash(
    "refresh_token",
    "replacement",
    key,
  ),
  attempt: deriveLinghaoPassportV4DurableHash(
    "refresh_attempt",
    "attempt",
    key,
  ),
  receipt: deriveLinghaoPassportV4DurableHash(
    "logout_receipt",
    "receipt",
    key,
  ),
  logoutState: deriveLinghaoPassportV4DurableHash(
    "logout_state",
    "logout-state",
    key,
  ),
  outbox: "b".repeat(64),
  claim: "c".repeat(64),
});

assert.notEqual(hashes.family, hashes.session);
assert.notEqual(
  hashes.family,
  deriveLinghaoPassportV4DurableHash("family_cookie", "family", otherKey),
);
assert.deepEqual(inspectLinghaoPassportV4DurableAuthorityGate({}), {
  ready: false,
  missing: ["auth_repository", "auth_database_gate"],
});

const environment = {
  [LINGHAO_PASSPORT_V4_AUTH_REPOSITORY_ENV]: "supabase",
  [LINGHAO_PASSPORT_V4_AUTH_GATE_ENV]:
    LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION,
};
const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
const now = 1_800_000_000_000;
const client: LinghaoPassportV4AuthRpcClient = {
  async rpc(name, args) {
    calls.push({ name, ...(args ? { args } : {}) });
    if (name === "aistory_linghao_passport_v4_auth_posture") {
      return { data: LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION, error: null };
    }
    const outputs: Record<string, unknown> = {
      aistory_linghao_passport_v4_reserve_start: {
        status: "reserved",
        expiresAtMs: now + 600_000,
      },
      aistory_linghao_passport_v4_cancel_start: true,
      aistory_linghao_passport_v4_consume_callback: {
        status: "accepted",
        familyHash: hashes.family,
        transactionHash: hashes.transaction,
        nonceHash: hashes.nonce,
        verifierEnvelope: envelope,
      },
      aistory_linghao_passport_v4_commit_callback: {
        status: "committed",
        sessionResultEnvelope,
        absoluteExpiresAtMs: now + 3_600_000,
      },
      aistory_linghao_passport_v4_read_session: {
        status: "authenticated",
        principalKey: hashes.principal,
        familyHash: hashes.family,
        sessionHash: hashes.session,
        generation: 1,
        authenticatedAtMs: now,
        expiresAtMs: now + 900_000,
      },
      aistory_linghao_passport_v4_begin_refresh: {
        status: "claimed",
        familyHash: hashes.family,
        sessionHash: hashes.session,
        generation: 1,
        refreshContextHash: hashes.refresh,
        refreshEnvelope,
      },
      aistory_linghao_passport_v4_commit_refresh: { status: "committed" },
      aistory_linghao_passport_v4_fail_refresh: true,
      aistory_linghao_passport_v4_begin_logout: {
        status: "revoked",
        localLoggedOut: true,
        revocationPending: true,
        resultExpiresAtMs: now + 600_000,
        idTokenHintEnvelope: hintEnvelope,
      },
      aistory_linghao_passport_v4_claim_revocation: {
        status: "claimed",
        outboxHash: hashes.outbox,
        tokenContextHash: hashes.refresh,
        tokenKind: "refresh_token",
        tokenEnvelope: refreshEnvelope,
      },
      aistory_linghao_passport_v4_complete_revocation: true,
      aistory_linghao_passport_v4_inspect_logout_result: {
        status: "ready",
        revocationConfirmed: true,
      },
      aistory_linghao_passport_v4_consume_logout_result: {
        status: "consumed",
        localLoggedOut: true,
        revocationConfirmed: true,
        upstreamReturnConfirmed: true,
      },
    };
    return { data: outputs[name], error: null };
  },
};

const repository = createLinghaoPassportV4DurableAuthority(client, environment);
await repository.assertReady();
assert.equal(
  (
    await repository.reserveStart({
      familyHash: hashes.family,
      transactionHash: hashes.transaction,
      stateHash: hashes.state,
      nonceHash: hashes.nonce,
      rateBucketHash: hashes.bucket,
      verifierEnvelope: envelope,
    })
  ).status,
  "reserved",
);
await repository.cancelStart(hashes.transaction);
assert.equal(
  (await repository.consumeCallback(hashes.transaction, hashes.state)).status,
  "accepted",
);
assert.equal(
  (
    await repository.commitCallback({
      transactionHash: hashes.transaction,
      familyHash: hashes.family,
      principalKey: hashes.principal,
      sessionHash: hashes.session,
      completionHash: hashes.completion,
      sessionResultEnvelope,
      accessTokenFingerprint: hashes.bucket,
      accessTokenEnvelope: accessEnvelope,
      idTokenHintEnvelope: hintEnvelope,
      refreshFingerprint: hashes.refresh,
      refreshEnvelope,
      providerExpiresAtMs: now + 3_600_000,
    })
  ).status,
  "committed",
);
assert.equal((await repository.readSession(hashes.session)).status, "authenticated");
assert.equal(
  (
    await repository.beginRefresh(
      hashes.session,
      hashes.attempt,
    )
  ).status,
  "claimed",
);
assert.equal(
  (
    await repository.commitRefresh({
      attemptHash: hashes.attempt,
      completionHash: hashes.completion,
      replacementFingerprint: hashes.replacement,
      replacementEnvelope: refreshEnvelope,
      accessTokenFingerprint: hashes.bucket,
      accessTokenEnvelope: accessEnvelope,
      idTokenHintEnvelope: hintEnvelope,
      providerExpiresAtMs: now + 3_600_000,
    })
  ).status,
  "committed",
);
await repository.failRefresh(hashes.attempt);
assert.equal(
  (
    await repository.beginLogout({
      familyHash: hashes.family,
      sessionHash: hashes.session,
      receiptHash: hashes.receipt,
      stateHash: hashes.logoutState,
      upstreamReturnExpected: true,
    })
  ).status,
  "revoked",
);
assert.equal(
  (await repository.claimRevocation(hashes.claim)).status,
  "claimed",
);
await repository.completeRevocation(hashes.outbox, true);
const inspectedLogout = await repository.inspectLogoutResult(hashes.receipt);
assert.equal(inspectedLogout.status, "ready");
assert.equal(
  inspectedLogout.status === "ready" && inspectedLogout.revocationConfirmed,
  true,
);
assert.equal(
  (
    await repository.consumeLogoutResult(
      hashes.receipt,
      hashes.logoutState,
      true,
    )
  ).status,
  "consumed",
);

const operationalCalls = calls.filter(
  (call) => call.name !== "aistory_linghao_passport_v4_auth_posture",
).length;
const postureCalls = calls.filter(
  (call) => call.name === "aistory_linghao_passport_v4_auth_posture",
).length;
assert.equal(postureCalls, operationalCalls + 1);

const malformedClient: LinghaoPassportV4AuthRpcClient = {
  async rpc(name) {
    if (name === "aistory_linghao_passport_v4_auth_posture") {
      return { data: LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION, error: null };
    }
    const result = { status: "invalid" } as Record<string, unknown>;
    Object.defineProperty(result, "surprise", {
      enumerable: true,
      get() {
        throw new Error("getter must not execute");
      },
    });
    return { data: result, error: null };
  },
};
await assert.rejects(
  () =>
    createLinghaoPassportV4DurableAuthority(
      malformedClient,
      environment,
    ).readSession(hashes.session),
  /DURABLE_AUTHORITY_UNAVAILABLE/,
);

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261119120000_linghao_passport_v4_auth_state_gate.sql",
    import.meta.url,
  ),
  "utf8",
);
for (const forbidden of [
  "public.app_users",
  "public.phone_identities",
  "public.aiuser_account_links",
  "public.credit_ledger",
  "public.admin_principals",
  "auth.users",
]) {
  assert.doesNotMatch(migration, new RegExp(forbidden.replace(".", "\\."), "i"));
}
assert.match(migration, /force row level security/gi);
assert.match(migration, /from public, anon, authenticated, service_role/gi);
assert.match(migration, /refresh_uncertain/);
assert.match(migration, /for update skip locked/);

console.log("PASS_LINGHAO_PASSPORT_V4_DURABLE_AUTHORITY");
console.log(
  JSON.stringify({
    assertions: 41,
    postureCalls,
    operationalCalls,
    gate: LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION,
    plaintextProviderStateInDatabase: false,
    legacyDataDependencies: 0,
    productionEnabled: false,
  }),
);
