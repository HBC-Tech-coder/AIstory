import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAiUserLinkIntents } from "../lib/auth/aiUserAccountLinkSession";
import { createAiUserAccountLinkService, type AiUserAccountLinkRepository, type AiUserLinkCommit } from "../lib/auth/aiUserAccountLinkService";
import { createAiUserAccountLinkRepository, AIUSER_LINK_GATE } from "../lib/auth/aiUserAccountLinkRepository";
import { decideAiUserAccountLink } from "../lib/auth/aiUserAccountLinkPolicy";
import { handleAiUserAccountLink } from "../lib/auth/aiUserAccountLinkServer";
import { createAiUserAccountLinkLogoutBarrier } from "../lib/auth/aiUserAccountLinkLogout";
import { AIUSER_LINK_ENV, AIUSER_LINK_MODE, AIUSER_LINK_REVOCATION_ENV, AIUSER_LINK_REVOCATION_MODE,
  aiUserAccountLinkRevocationSelected, aiUserAccountLinkSelected } from "../lib/auth/aiUserAccountLinkConfig";
import { assertAiUserRequestOrigin } from "../lib/auth/aiUserOidcCallback";
import { createAccountLogoutRouteHandler } from "../lib/auth/accountLogoutRoute";

let checks = 0, calls = 0, network = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { network++; throw Error("NETWORK_FORBIDDEN"); };
const digest = (x: string) => createHash("sha256").update(x).digest("hex");
const origin = "https://play.hibcglobal.com", path = "/api/auth/aiuser/account-link";
const base = 1788232800000;
function fixture() {
  let now = base, active = true, phoneActive = true, failAudit = false, failReady = false, allow = true, rateCalls = 0;
  let readyCalls = 0, mappingReads = 0;
  let principal = digest("synthetic-principal"), phoneId = "12345678-1234-4234-9234-123456789012";
  let changeProofsAfterRead = false, proofReads = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const mappings = new Map<string, string>(), prepared = new Map<string, AiUserLinkCommit>();
  const intents = new Map<string, "linked" | "already_linked">();
  const revoked = new Map<string, string>();
  const serializedEvents: string[] = [];
  let commitBarrier: (() => Promise<void>) | undefined;
  const proofs = () => ({ aiuser: { principalKey: principal, sessionBinding: digest("synthetic-aiuser-session"), authenticatedAt: base - 1000, expiresAt: base + 800000, membershipGeneration: 1 },
    phone: { userId: phoneId, sessionBinding: digest("synthetic-phone-session"), authenticatedAt: base - 1000, expiresAt: base + 600000, active: true as const } });
  const repository: AiUserAccountLinkRepository = {
    assertReady: async () => { readyCalls++; if (failReady) throw Error("DATABASE_UNAVAILABLE"); },
    isLinked: async (key) => { mappingReads++; return mappings.has(key); },
    prepare(input) {
      const work = tail.catch(() => undefined).then(() => {
        const prior = prepared.get(input.intent.id);
        if (revoked.has(input.aiuser.sessionBinding) || revoked.has(input.phone.sessionBinding)
          || (prior && JSON.stringify(prior) !== JSON.stringify(input))) throw Error("REJECTED");
        prepared.set(input.intent.id, structuredClone(input));
      }); tail = work; return work;
    },
    commit(input) {
      const work = tail.catch(() => undefined).then(async () => {
        if (commitBarrier) { const barrier = commitBarrier; commitBarrier = undefined; await barrier(); }
        const p = input.aiuser.principalKey, u = input.phone.userId;
        const byAi = mappings.get(p), byPhone = [...mappings].find(([, value]) => value === u);
        const result = decideAiUserAccountLink({ ...input, existingByAiuser: byAi ? { principalKey: p, phoneUserId: byAi } : null,
          existingByPhone: byPhone ? { principalKey: byPhone[0], phoneUserId: u } : null }, now);
        const registered = prepared.get(input.intent.id), consumed = intents.get(input.intent.id);
        if (!phoneActive || !result.ok || !registered || JSON.stringify(registered) !== JSON.stringify(input)
          || revoked.has(input.aiuser.sessionBinding) || revoked.has(input.phone.sessionBinding) || failAudit) throw Error("REJECTED");
        if (consumed) return consumed;
        const outcome = result.status === "link_allowed" ? "linked" as const : "already_linked" as const;
        mappings.set(p, u); intents.set(input.intent.id, outcome); serializedEvents.push("confirm"); return outcome;
      }); tail = work; return work;
    },
    revokeSessions(input) {
      const work = tail.catch(() => undefined).then(() => {
        const entries = [
          input.aiuser ? { session: input.aiuser.sessionBinding, owner: `aiuser:${input.aiuser.principalKey}` } : null,
          input.phone ? { session: input.phone.sessionBinding, owner: `phone:${input.phone.userId}` } : null,
        ].filter((entry): entry is { session: string; owner: string } => entry !== null);
        for (const entry of entries) {
          const previous = revoked.get(entry.session);
          if (previous !== undefined && previous !== entry.owner) throw Error("REJECTED");
        }
        for (const entry of entries) revoked.set(entry.session, entry.owner);
        serializedEvents.push("logout");
      }); tail = work; return work;
    },
  };
  const service = createAiUserAccountLinkService({ now: () => now, repository, allowMutation: () => { rateCalls++; return allow; },
    intents: createAiUserLinkIntents("Z".repeat(64), () => now),
    readProofs: async () => {
      proofReads++;
      const result = active && phoneActive ? proofs() : null;
      if (changeProofsAfterRead) { changeProofsAfterRead = false; phoneId = "12345678-1234-4234-9234-123456789013"; }
      return result;
    },
    assertOrigin: (request) => { assertAiUserRequestOrigin(request, path);
      if (request.method !== "GET" && request.headers.get("origin") !== origin) throw Error("REJECTED"); },
  });
  const request = (body?: string, cookie = "", extra: Record<string, string> = {}, url = origin + path) => new Request(url, {
    method: body === undefined ? "GET" : "POST", headers: { host: "play.hibcglobal.com", origin, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie, ...extra }, body });
  async function prepare() { const result = await service(request('{"action":"prepare"}')); assert.equal(result.status, 200); checks++;
    return result.headers.get("set-cookie")!.split(";")[0]!; }
  return { service, request, prepare, mappings, prepared, intents, proofs, repository, revoked, serializedEvents,
    rateCalls: () => rateCalls,
    readyCalls: () => readyCalls, mappingReads: () => mappingReads,
    proofReads: () => proofReads, changeProofsOnNextRead: () => { changeProofsAfterRead = true; },
    pauseCommitAfterLock() {
      let enteredResolve!: () => void; let releaseResolve!: () => void;
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      commitBarrier = async () => { enteredResolve(); await release; };
      return { entered, release: releaseResolve };
    },
    advance: (ms: number) => { now += ms; }, revoke: () => { active = false; }, freeze: () => { phoneActive = false; },
    fail: () => { failAudit = true; }, breakPosture: () => { failReady = true; }, rate: () => { allow = false; },
    crossAi: () => { principal = digest("other"); }, crossPhone: () => { phoneId = "12345678-1234-4234-9234-123456789013"; },
  };
}
async function run() {
  const barrierGates: string[] = [];
  delete process.env[AIUSER_LINK_ENV];
  delete process.env[AIUSER_LINK_REVOCATION_ENV];
  assert.equal(aiUserAccountLinkSelected(), false); assert.equal(aiUserAccountLinkRevocationSelected(), false); checks++;
  process.env[AIUSER_LINK_ENV] = AIUSER_LINK_MODE;
  assert.equal(aiUserAccountLinkSelected(), false, "admission requires the sticky revocation channel"); checks++;
  process.env[AIUSER_LINK_REVOCATION_ENV] = AIUSER_LINK_REVOCATION_MODE;
  assert.equal(aiUserAccountLinkSelected(), true); assert.equal(aiUserAccountLinkRevocationSelected(), true);
  barrierGates.push("dual_exact_selector_admission"); checks++;
  for (const value of ["true", "enabled", "wrong-version"]) {
    process.env[AIUSER_LINK_ENV] = value;
    assert.equal(aiUserAccountLinkSelected(), false);
    assert.equal((await handleAiUserAccountLink(new Request(origin + path))).status, 503); checks++;
  }
  process.env[AIUSER_LINK_ENV] = AIUSER_LINK_MODE;
  for (const value of ["true", "enabled", "wrong-version"]) {
    process.env[AIUSER_LINK_REVOCATION_ENV] = value;
    assert.equal(aiUserAccountLinkSelected(), false); assert.equal(aiUserAccountLinkRevocationSelected(), false);
    assert.equal((await handleAiUserAccountLink(new Request(origin + path))).status, 503); checks++;
  }
  delete process.env[AIUSER_LINK_REVOCATION_ENV];
  assert.equal((await handleAiUserAccountLink(new Request(origin + path, { method: "POST" }))).status, 503); checks++;
  delete process.env[AIUSER_LINK_ENV];
  process.env[AIUSER_LINK_REVOCATION_ENV] = AIUSER_LINK_REVOCATION_MODE;
  assert.equal(aiUserAccountLinkSelected(), false); assert.equal(aiUserAccountLinkRevocationSelected(), true);
  for (const command of ['{"action":"prepare"}', '{"action":"confirm","confirmLink":true}']) {
    assert.equal((await handleAiUserAccountLink(new Request(origin + path, { method: "POST", body: command }))).status, 503); checks++;
  }
  assert.equal((await handleAiUserAccountLink(new Request(origin + path))).status, 503); checks++;
  delete process.env[AIUSER_LINK_REVOCATION_ENV];
  assert.equal((await handleAiUserAccountLink(new Request(origin + path))).status, 503); checks++;
  const f = fixture(); const cookie = await f.prepare();
  assert.equal(f.mappings.size, 0); assert.equal(f.prepared.size, 1); assert.equal(f.intents.size, 0); checks++;
  const results = await Promise.all([f.service(f.request('{"action":"confirm","confirmLink":true}', cookie)), f.service(f.request('{"action":"confirm","confirmLink":true}', cookie))]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 200]); assert.equal(f.mappings.size, 1); assert.equal(f.intents.size, 1); checks++;
  for (const result of results) assert.equal(await result.text(), '{"ok":true,"status":"linked","assetsMerged":false,"creditsGranted":false,"administratorGranted":false}'); checks++;
  const readsBeforeStatus = f.proofReads();
  const status = await (await f.service(f.request())).json();
  assert.deepEqual(status, { available: true, linked: true, assetsMerged: false, creditsGranted: false }); checks++;
  assert.equal(f.proofReads() - readsBeforeStatus, 2, "successful GET must re-read the complete proof after database checks"); checks++;
  const noPhoneCapability = fixture(); noPhoneCapability.freeze();
  const noPhoneResponse = await noPhoneCapability.service(noPhoneCapability.request());
  assert.equal(noPhoneResponse.status, 401); assert.deepEqual(await noPhoneResponse.json(), { ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" });
  assert.equal(noPhoneCapability.readyCalls(), 0); assert.equal(noPhoneCapability.mappingReads(), 0); checks++;
  const noAiUserCapability = fixture(); noAiUserCapability.revoke();
  const noAiUserResponse = await noAiUserCapability.service(noAiUserCapability.request());
  assert.equal(noAiUserResponse.status, 401); assert.deepEqual(await noAiUserResponse.json(), { ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" });
  assert.equal(noAiUserCapability.readyCalls(), 0); assert.equal(noAiUserCapability.mappingReads(), 0); checks++;
  const staleCapability = fixture(); staleCapability.advance(300001);
  const staleResponse = await staleCapability.service(staleCapability.request());
  assert.equal(staleResponse.status, 401); assert.deepEqual(await staleResponse.json(), { ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" });
  assert.equal(staleCapability.readyCalls(), 0); assert.equal(staleCapability.mappingReads(), 0); checks++;
  const postureFailureCapability = fixture(); postureFailureCapability.breakPosture();
  const postureFailureResponse = await postureFailureCapability.service(postureFailureCapability.request());
  assert.equal(postureFailureResponse.status, 503); assert.deepEqual(await postureFailureResponse.json(), { ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" });
  assert.equal(postureFailureCapability.readyCalls(), 1); assert.equal(postureFailureCapability.mappingReads(), 0); checks++;
  const changedCapability = fixture(); changedCapability.changeProofsOnNextRead();
  const changedResponse = await changedCapability.service(changedCapability.request());
  assert.equal(changedResponse.status, 403); assert.deepEqual(await changedResponse.json(), { ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" });
  assert.equal(changedCapability.proofReads(), 2); checks++;
  const repeatedCapability = fixture();
  assert.equal((await repeatedCapability.service(repeatedCapability.request())).status, 200);
  assert.equal((await repeatedCapability.service(repeatedCapability.request())).status, 200);
  assert.equal(repeatedCapability.readyCalls(), 2); assert.equal(repeatedCapability.mappingReads(), 2);
  assert.equal(repeatedCapability.proofReads(), 4); checks++;
  const again = await f.prepare(); assert.equal((await (await f.service(f.request('{"action":"confirm","confirmLink":true}', again))).json()).status, "already_linked"); checks++;
  const loggedOut = fixture(); const loggedOutIntent = await loggedOut.prepare(); const loggedOutProofs = loggedOut.proofs();
  await loggedOut.repository.revokeSessions({
    aiuser: { principalKey: loggedOutProofs.aiuser.principalKey, sessionBinding: loggedOutProofs.aiuser.sessionBinding },
    phone: { userId: loggedOutProofs.phone.userId, sessionBinding: loggedOutProofs.phone.sessionBinding },
  });
  assert.notEqual((await loggedOut.service(loggedOut.request('{"action":"confirm","confirmLink":true}', loggedOutIntent))).status, 200);
  assert.equal(loggedOut.mappings.size, 0); assert.equal(loggedOut.intents.size, 0); checks++;
  // Red control for the former coupling: once admission is disabled, using the
  // admission selector for logout acknowledges without a tombstone and lets
  // the already-admitted confirm commit afterwards.
  const legacy = fixture(); const legacyIntent = await legacy.prepare(); const legacyProofs = legacy.proofs();
  const legacyCommit = legacy.repository.commit.bind(legacy.repository);
  let legacyEnteredResolve!: () => void; let legacyReleaseResolve!: () => void;
  const legacyEntered = new Promise<void>((resolve) => { legacyEnteredResolve = resolve; });
  const legacyRelease = new Promise<void>((resolve) => { legacyReleaseResolve = resolve; });
  legacy.repository.commit = async (input) => { legacyEnteredResolve(); await legacyRelease; return legacyCommit(input); };
  const legacyConfirm = legacy.service(legacy.request('{"action":"confirm","confirmLink":true}', legacyIntent));
  await legacyEntered;
  process.env[AIUSER_LINK_REVOCATION_ENV] = AIUSER_LINK_REVOCATION_MODE;
  delete process.env[AIUSER_LINK_ENV];
  const legacyCoupledLogout = createAiUserAccountLinkLogoutBarrier({
    revocationSelected: aiUserAccountLinkSelected,
    readAiuser: async () => ({ principalKey: legacyProofs.aiuser.principalKey,
      sessionBinding: legacyProofs.aiuser.sessionBinding }),
    readPhone: async () => ({ userId: legacyProofs.phone.userId,
      sessionBinding: legacyProofs.phone.sessionBinding }),
    revokeSessions: (input) => legacy.repository.revokeSessions(input),
  });
  assert.equal(await legacyCoupledLogout(legacy.request()), true); assert.equal(legacy.revoked.size, 0);
  legacyReleaseResolve(); assert.equal((await legacyConfirm).status, 200); assert.equal(legacy.mappings.size, 1);
  barrierGates.push("legacy_coupled_selector_red_reproduced"); checks++;
  // Rolling-disable barrier: an older enabled worker has reread both proofs and
  // is paused before its DB lock. A newer admission-off worker must still use
  // the independent revocation channel, so acknowledged logout wins the lock.
  const rolling = fixture(); const rollingIntent = await rolling.prepare(); const rollingProofs = rolling.proofs();
  const originalCommit = rolling.repository.commit.bind(rolling.repository);
  let enteredResolve!: () => void; let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  rolling.repository.commit = async (input) => { enteredResolve(); await release; return originalCommit(input); };
  const inFlightConfirm = rolling.service(rolling.request('{"action":"confirm","confirmLink":true}', rollingIntent));
  await entered;
  process.env[AIUSER_LINK_REVOCATION_ENV] = AIUSER_LINK_REVOCATION_MODE;
  delete process.env[AIUSER_LINK_ENV];
  assert.equal(aiUserAccountLinkSelected(), false); assert.equal(aiUserAccountLinkRevocationSelected(), true);
  const rollingLogout = createAiUserAccountLinkLogoutBarrier({
    revocationSelected: aiUserAccountLinkRevocationSelected,
    readAiuser: async () => ({ principalKey: rollingProofs.aiuser.principalKey,
      sessionBinding: rollingProofs.aiuser.sessionBinding }),
    readPhone: async () => ({ userId: rollingProofs.phone.userId,
      sessionBinding: rollingProofs.phone.sessionBinding }),
    revokeSessions: (input) => rolling.repository.revokeSessions(input),
  });
  assert.equal(await rollingLogout(rolling.request()), true);
  const firstRevocationSize = rolling.revoked.size;
  // The first response may be lost. Exact logout retry is append-only and
  // idempotent rather than turning the ambiguity into apparent failure.
  assert.equal(await rollingLogout(rolling.request()), true);
  assert.equal(rolling.revoked.size, firstRevocationSize); assert.equal(firstRevocationSize, 2);
  barrierGates.push("logout_retry_idempotent");
  releaseResolve();
  assert.notEqual((await inFlightConfirm).status, 200); assert.equal(rolling.mappings.size, 0);
  barrierGates.push("logout_first_blocks_waiting_confirm"); checks++;
  const conflictingLogout = createAiUserAccountLinkLogoutBarrier({
    revocationSelected: () => true,
    readAiuser: async () => ({ principalKey: digest("different-principal"),
      sessionBinding: rollingProofs.aiuser.sessionBinding }),
    readPhone: async () => null,
    revokeSessions: (input) => rolling.repository.revokeSessions(input),
  });
  assert.equal(await conflictingLogout(rolling.request()), false); assert.equal(rolling.revoked.size, 2);
  barrierGates.push("different_revocation_proof_rejected"); checks++;
  const failedDatabaseLogout = createAiUserAccountLinkLogoutBarrier({
    revocationSelected: () => true,
    readAiuser: async () => ({ principalKey: rollingProofs.aiuser.principalKey,
      sessionBinding: rollingProofs.aiuser.sessionBinding }),
    readPhone: async () => null,
    revokeSessions: async () => { throw Error("DATABASE_UNAVAILABLE"); },
  });
  assert.equal(await failedDatabaseLogout(rolling.request()), false);
  barrierGates.push("database_failure_not_acknowledged"); checks++;
  let baseLogoutCalls = 0;
  const failedDatabaseRoute = createAccountLogoutRouteHandler({
    revokeLinkSessions: async () => false,
    logoutBusinessSession: async () => { baseLogoutCalls++; return true; },
  });
  const failedDatabaseRouteResponse = await failedDatabaseRoute(new Request(origin + "/api/account/me", { method: "DELETE" }));
  assert.equal(failedDatabaseRouteResponse.status, 503);
  assert.deepEqual(await failedDatabaseRouteResponse.json(), { ok: false, code: "ACCOUNT_LOGOUT_UNAVAILABLE" });
  assert.equal(failedDatabaseRouteResponse.headers.getSetCookie().length, 0); assert.equal(baseLogoutCalls, 0);
  const failedBaseRoute = createAccountLogoutRouteHandler({
    revokeLinkSessions: async () => true,
    logoutBusinessSession: async () => { baseLogoutCalls++; return false; },
  });
  const failedBaseRouteResponse = await failedBaseRoute(new Request(origin + "/api/account/me", { method: "DELETE" }));
  assert.equal(failedBaseRouteResponse.status, 503); assert.equal(failedBaseRouteResponse.headers.getSetCookie().length, 0);
  barrierGates.push("route_delete_database_failure_503"); checks++;
  // Opposite lock order: confirm linearizes first, logout waits and then
  // tombstones. Only the pre-logout confirm succeeds; every retry after the
  // acknowledged logout is rejected.
  const confirmFirst = fixture(); const confirmFirstIntent = await confirmFirst.prepare();
  const confirmFirstProofs = confirmFirst.proofs(); const lock = confirmFirst.pauseCommitAfterLock();
  const confirmFirstResponse = confirmFirst.service(confirmFirst.request('{"action":"confirm","confirmLink":true}', confirmFirstIntent));
  await lock.entered;
  let revokeQueuedResolve!: () => void;
  const revokeQueued = new Promise<void>((resolve) => { revokeQueuedResolve = resolve; });
  const confirmFirstLogout = createAiUserAccountLinkLogoutBarrier({
    revocationSelected: () => true,
    readAiuser: async () => ({ principalKey: confirmFirstProofs.aiuser.principalKey,
      sessionBinding: confirmFirstProofs.aiuser.sessionBinding }),
    readPhone: async () => ({ userId: confirmFirstProofs.phone.userId,
      sessionBinding: confirmFirstProofs.phone.sessionBinding }),
    revokeSessions(input) { revokeQueuedResolve(); return confirmFirst.repository.revokeSessions(input); },
  });
  const queuedLogout = confirmFirstLogout(confirmFirst.request()); await revokeQueued; lock.release();
  assert.equal((await confirmFirstResponse).status, 200); assert.equal(await queuedLogout, true);
  assert.deepEqual(confirmFirst.serializedEvents, ["confirm", "logout"]);
  assert.notEqual((await confirmFirst.service(confirmFirst.request('{"action":"confirm","confirmLink":true}', confirmFirstIntent))).status, 200);
  barrierGates.push("confirm_first_then_logout_blocks_replay"); checks++;
  delete process.env[AIUSER_LINK_REVOCATION_ENV];
  const unstagedLogout = createAiUserAccountLinkLogoutBarrier({
    revocationSelected: () => false,
    readAiuser: async () => { throw Error("MUST_NOT_READ"); },
    readPhone: async () => { throw Error("MUST_NOT_READ"); },
    revokeSessions: async () => { throw Error("MUST_NOT_REVOKE"); },
  });
  assert.equal(await unstagedLogout(rolling.request()), true); checks++;
  for (const change of ["advance", "revoke", "freeze", "fail", "crossAi", "crossPhone"] as const) {
    const x = fixture(); const intent = await x.prepare();
    if (change === "advance") x.advance(60001); else x[change]();
    assert.notEqual((await x.service(x.request('{"action":"confirm","confirmLink":true}', intent))).status, 200);
    assert.equal(x.mappings.size, 0); assert.equal(x.intents.size, 0); assert.equal(x.prepared.size, 1); checks++;
  }
  for (const command of ['{}','{"action":"confirm","confirmLink":false}','{"action":"confirm","confirmLink":true,"userId":"override"}',
    '{"action":"prepare","action":"prepare"}', '{"action":"prepare","__proto__":{}}', 'x'.repeat(129)]) {
    assert.notEqual((await f.service(f.request(command, cookie))).status, 200); checks++;
  }
  const badHeaders: Array<Record<string, string>> = [{ origin: "null" }, { origin: "https://foreign.invalid" }, { origin: "" }, { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" }, { host: "foreign.invalid" }];
  for (const headers of badHeaders) {
    assert.notEqual((await f.service(f.request('{"action":"prepare"}', cookie, headers))).status, 200); checks++;
  }
  assert.notEqual((await f.service(f.request('{"action":"prepare"}', cookie, {}, origin + path + "?user=other"))).status, 200); checks++;
  const malformed = ["", cookie + "; " + cookie, cookie.slice(0, -3) + "xxx", "unrelated=value"];
  for (const value of malformed) { const x = fixture(); assert.notEqual((await x.service(x.request('{"action":"confirm","confirmLink":true}', value))).status, 200); checks++; }
  const limited = fixture(); limited.rate(); assert.equal((await limited.service(limited.request('{"action":"prepare"}'))).status, 403); checks++;
  const unauthenticatedFlood = fixture(); unauthenticatedFlood.revoke();
  assert.equal((await unauthenticatedFlood.service(unauthenticatedFlood.request('{"action":"prepare"}'))).status, 403);
  assert.equal(unauthenticatedFlood.rateCalls(), 0); checks++;
  for (const fail of ["posture", "shape", "rpc"]) {
    const repo = createAiUserAccountLinkRepository({ rpc: async (name) => { calls++; return name.endsWith("posture")
      ? { data: fail === "posture" ? "old" : AIUSER_LINK_GATE, error: null }
      : { data: fail === "shape" ? { internal: "do-not-return" } : false, error: fail === "rpc" ? {} : null }; } }, async () => {});
    await assert.rejects(() => repo.isLinked(digest("synthetic-principal")), /^Error: ACCOUNT_LINK_UNAVAILABLE$/); checks++;
  }
  const captured: unknown[] = [];
  const repo = createAiUserAccountLinkRepository({ rpc: async (name, args) => {
    calls++; if (name.endsWith("posture")) return { data: AIUSER_LINK_GATE, error: null };
    captured.push(args!.request_payload);
    return { data: name.endsWith("prepare") ? "prepared" : name.endsWith("confirm") ? "linked" : true, error: null };
  } }, async () => {}, () => base);
  const p = fixture().proofs();
  const input: AiUserLinkCommit = { schema: "aistory.aiuser-account-link-proof.v1", confirmation: { confirmLink: true }, ...p,
    intent: { id: digest("intent"), principalKey: p.aiuser.principalKey, phoneUserId: p.phone.userId,
      aiuserSessionBinding: p.aiuser.sessionBinding, phoneSessionBinding: p.phone.sessionBinding, createdAt: base, expiresAt: base + 60000, consumed: false } };
  await repo.prepare(input); assert.equal(await repo.commit(input), "linked");
  await repo.revokeSessions({ aiuser: { principalKey: p.aiuser.principalKey, sessionBinding: p.aiuser.sessionBinding }, phone: null });
  assert.equal(captured.length, 3); checks++;
  assert.equal(network, 0);
  console.log(JSON.stringify({ state: "PASS_LOCAL_LINK_SERVICE", checks, syntheticRpcCalls: calls, externalNetwork: network,
    credentialsRead: false, registrationCalls: 0, grants: 0, barrierGates,
    dbQualification: "SEPARATE_REQUIRED" }));
}
void run().finally(() => { globalThis.fetch = originalFetch; }).catch(() => { console.error("ACCOUNT_LINK_TEST_FAILED"); process.exitCode = 1; });
