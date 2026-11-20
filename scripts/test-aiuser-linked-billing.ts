import assert from "node:assert/strict";

import {
  AIUSER_LINKED_BILLING_ENV,
  AIUSER_LINKED_BILLING_MODE,
  aiUserLinkedBillingSelected,
} from "../lib/auth/aiUserLinkedBillingConfig.ts";
import {
  AIUSER_LINKED_BILLING_GATE,
  AiUserLinkedBillingUnavailableError,
  createAiUserLinkedBillingRepository,
  isAiUserLinkedBillingPrincipalKey,
  toAiUserLinkedBillingPhoneUserId,
} from "../lib/auth/aiUserLinkedBillingRepository.ts";

let checks = 0;
let network = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  network++;
  throw Error("NETWORK_FORBIDDEN");
};

const LINK_ENV = "AISTORY_AIUSER_ACCOUNT_LINK_MODE";
const LINK_REVOCATION_ENV = "AISTORY_AIUSER_ACCOUNT_LINK_REVOCATION_MODE";
const LINK_MODE = "aistory-aiuser-explicit-account-link-v1:enabled";
const LINK_REVOCATION_MODE = "aistory-aiuser-explicit-account-link-revocation-v1:enabled";
const savedEnv = new Map(
  [AIUSER_LINKED_BILLING_ENV, LINK_ENV, LINK_REVOCATION_ENV].map((name) => [name, process.env[name]]),
);
function clearEnv() {
  for (const name of savedEnv.keys()) delete process.env[name];
}
function restoreEnv() {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const PRINCIPAL = "a".repeat(64);
const PHONE = "12345678-1234-4234-9234-123456789012";
const PHONE_WITH_HEX_LETTERS = "abcdef12-1234-4234-9234-abcdef123456";

function fakeClient(options = {}) {
  const calls = [];
  let postureCalls = 0;
  let resolverCalls = 0;
  const hasPosture = Object.prototype.hasOwnProperty.call(options, "posture");
  const hasResolver = Object.prototype.hasOwnProperty.call(options, "resolver");
  return {
    calls,
    postureCalls: () => postureCalls,
    resolverCalls: () => resolverCalls,
    rpc(name, args) {
      calls.push({ name, args });
      if (name === "aistory_aiuser_linked_billing_posture_claims_v1") {
        postureCalls++;
        if (options.postureThrows) throw Error("POSTURE_TRANSPORT");
        return Promise.resolve(
          hasPosture
            ? options.posture
            : { data: AIUSER_LINKED_BILLING_GATE, error: null },
        );
      }
      if (name === "aistory_aiuser_linked_billing_resolve_claims_v1") {
        resolverCalls++;
        if (options.resolverThrows) throw Error("RESOLVER_TRANSPORT");
        return Promise.resolve(
          hasResolver
            ? options.resolver
            : { data: PHONE, error: null },
        );
      }
      throw Error(`UNEXPECTED_RPC:${name}`);
    },
  };
}

async function rejectsUnavailable(promise) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AiUserLinkedBillingUnavailableError);
    assert.equal(error.name, "AiUserLinkedBillingUnavailableError");
    assert.equal(error.code, "LINKED_BILLING_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.equal(error.message, "LINKED_BILLING_UNAVAILABLE");
    return true;
  });
  checks++;
}

async function main() {
  // --- Selector: exact, default off, independent of link selectors ---------
  clearEnv();
  assert.equal(aiUserLinkedBillingSelected(), false);
  process.env[LINK_ENV] = LINK_MODE;
  process.env[LINK_REVOCATION_ENV] = LINK_REVOCATION_MODE;
  assert.equal(aiUserLinkedBillingSelected(), false, "link admission must not enable billing");
  checks++;
  for (const value of ["true", "enabled", "1", "aistory-aiuser-linked-billing-v1", "AISTORY-AIUSER-LINKED-BILLING-V1:ENABLED", " "]) {
    process.env[AIUSER_LINKED_BILLING_ENV] = value;
    assert.equal(aiUserLinkedBillingSelected(), false, `wrong selector accepted: ${JSON.stringify(value)}`);
    checks++;
  }
  process.env[AIUSER_LINKED_BILLING_ENV] = AIUSER_LINKED_BILLING_MODE;
  assert.equal(aiUserLinkedBillingSelected(), true);
  delete process.env[LINK_ENV];
  delete process.env[LINK_REVOCATION_ENV];
  assert.equal(aiUserLinkedBillingSelected(), true, "billing stays independent when link admission is off");
  checks++;
  delete process.env[AIUSER_LINKED_BILLING_ENV];
  assert.equal(aiUserLinkedBillingSelected(), false);
  checks++;

  // --- Pure validation -----------------------------------------------------
  assert.equal(isAiUserLinkedBillingPrincipalKey(PRINCIPAL), true);
  for (const value of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64),
    `${"a".repeat(63)}G`, null, undefined, 1, {}, [], new String(PRINCIPAL)]) {
    assert.equal(isAiUserLinkedBillingPrincipalKey(value), false);
    checks++;
  }
  assert.equal(toAiUserLinkedBillingPhoneUserId(PHONE), PHONE);
  checks++;
  for (const value of ["", "not-a-uuid", "12345678-1234-0234-9234-123456789012",
    "12345678-1234-4234-7234-123456789012", "12345678-1234-4234-9234-12345678901Z",
    PHONE_WITH_HEX_LETTERS.toUpperCase(), ` ${PHONE}`, `${PHONE} `, `{${PHONE}}`, null, undefined, true, 42, {}, []]) {
    await rejectsUnavailable(Promise.resolve().then(() => toAiUserLinkedBillingPhoneUserId(value)));
  }

  // --- Posture is uncached and fail-closed ---------------------------------
  {
    const client = fakeClient();
    let baseReadyCalls = 0;
    const repository = createAiUserLinkedBillingRepository(client, async () => { baseReadyCalls++; });
    await repository.assertReady();
    assert.equal(baseReadyCalls, 1);
    assert.equal(client.postureCalls(), 1);
    assert.equal(client.resolverCalls(), 0);
    checks++;
    await repository.assertReady();
    assert.equal(baseReadyCalls, 2, "posture must be reread, not cached");
    assert.equal(client.postureCalls(), 2);
    checks++;
  }
  for (const posture of [
    { data: "20260901040000", error: null },
    { data: null, error: null },
    { data: true, error: null },
    { data: {}, error: null },
    { data: `${AIUSER_LINKED_BILLING_GATE} `, error: null },
    { data: AIUSER_LINKED_BILLING_GATE, error: { message: "drift" } },
  ]) {
    const client = fakeClient({ posture });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.assertReady());
    assert.equal(client.resolverCalls(), 0);
    checks++;
  }
  {
    const client = fakeClient({ postureThrows: true });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.assertReady());
    assert.equal(client.resolverCalls(), 0);
  }
  {
    const client = fakeClient();
    const repository = createAiUserLinkedBillingRepository(client, async () => {
      throw Error("BASE_GATE_UNAVAILABLE");
    });
    await rejectsUnavailable(repository.assertReady());
    assert.equal(client.postureCalls(), 0);
    assert.equal(client.resolverCalls(), 0);
  }

  // --- Invalid principal never reaches the RPC -----------------------------
  for (const value of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64),
    null, undefined, 1, {}, [], new String(PRINCIPAL)]) {
    const client = fakeClient();
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.resolvePhoneUserId(value));
    assert.equal(client.calls.length, 0, "malformed principal must not call posture or resolver");
    checks++;
  }

  // --- Resolver result: exact lowercase active UUID only --------------------
  for (const value of ["", "not-a-uuid", "12345678-1234-0234-9234-123456789012",
    "12345678-1234-4234-7234-123456789012", "12345678-1234-4234-9234-12345678901Z",
    PHONE_WITH_HEX_LETTERS.toUpperCase(), ` ${PHONE}`, `${PHONE} `, `{${PHONE}}`, null, undefined, true, 42, {}, []]) {
    const client = fakeClient({ resolver: { data: value, error: null } });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.requirePhoneUserId(PRINCIPAL));
    assert.equal(client.postureCalls(), 1);
    assert.equal(client.resolverCalls(), 1);
    checks++;
  }
  for (const resolver of [
    { data: PHONE, error: { message: "drift" } },
    { data: PHONE, error: {} },
    null,
    undefined,
  ]) {
    const client = fakeClient({ resolver });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.resolvePhoneUserId(PRINCIPAL));
    checks++;
  }
  {
    const client = fakeClient({ resolverThrows: true });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.resolvePhoneUserId(PRINCIPAL));
  }

  // --- Nullable resolver: only SQL NULL maps to unlinked -------------------
  {
    const client = fakeClient({ resolver: { data: null, error: null } });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    assert.equal(await repository.resolvePhoneUserId(PRINCIPAL), null);
    await rejectsUnavailable(repository.requirePhoneUserId(PRINCIPAL));
    assert.equal(client.postureCalls(), 2);
    assert.equal(client.resolverCalls(), 2);
    checks++;
  }
  {
    const client = fakeClient({ resolver: { data: { phoneUserId: PHONE }, error: null } });
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    await rejectsUnavailable(repository.resolvePhoneUserId(PRINCIPAL));
  }

  // --- Success shape: only principal_hash is ever sent ---------------------
  {
    const client = fakeClient();
    const repository = createAiUserLinkedBillingRepository(client, async () => {});
    const first = await repository.resolvePhoneUserId(PRINCIPAL);
    const second = await repository.resolvePhoneUserId(PRINCIPAL);
    assert.equal(await repository.requirePhoneUserId(PRINCIPAL), PHONE);
    assert.equal(first, PHONE);
    assert.equal(second, PHONE);
    assert.equal(client.postureCalls(), 3);
    assert.equal(client.resolverCalls(), 3);
    assert.deepEqual(client.calls.map((call) => call.name), [
      "aistory_aiuser_linked_billing_posture_claims_v1",
      "aistory_aiuser_linked_billing_resolve_claims_v1",
      "aistory_aiuser_linked_billing_posture_claims_v1",
      "aistory_aiuser_linked_billing_resolve_claims_v1",
      "aistory_aiuser_linked_billing_posture_claims_v1",
      "aistory_aiuser_linked_billing_resolve_claims_v1",
    ]);
    for (const call of client.calls.filter((item) => item.name.endsWith("resolve_claims_v1"))) {
      assert.deepEqual(Object.keys(call.args), ["principal_hash"]);
      assert.equal(call.args.principal_hash, PRINCIPAL);
      assert.equal(JSON.stringify(call.args).includes(PHONE), false, "phone UUID must not be sent to the resolver");
    }
    checks += 3;
  }
  assert.equal(network, 0, "repository must not use fetch");
  console.log(JSON.stringify({
    status: "PASS_AIUSER_LINKED_BILLING_REPOSITORY",
    checks,
    externalNetwork: network,
    calls: 0,
    credentialsRead: false,
    phoneUuidReturnedToBrowser: false,
    databaseExecuted: false,
  }));
}

try {
  await main();
} finally {
  restoreEnv();
  globalThis.fetch = originalFetch;
}
