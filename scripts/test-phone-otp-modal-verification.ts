import assert from "node:assert/strict";
import { verifyPhoneOtpForModal } from "../lib/auth/phoneOtpModalVerification";
import type { LocalClaimCommitResult } from "../lib/auth/anonymousClaimClient";

async function main() {
  // 1. Phone-proof mode must dispatch with the global receiver, must not
  //    prepare/apply anonymous assets, and must omit anonymousClaim.
  const calls: string[] = [];
  let body: Record<string, unknown> | undefined;
  const receiverSensitiveFetcher = async function (
    this: typeof globalThis,
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    assert.equal(this, globalThis, "fetch must receive the browser global as its receiver");
    assert.equal(url, "/api/auth/phone/verify");
    calls.push("fetch");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ account: { userId: "phone-user" } });
  };

  const outcome = await verifyPhoneOtpForModal({
    phone: " 13800000000 ",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: true,
    prepareClaim: async () => {
      calls.push("prepare");
      return { stories: ["must-not-send"] };
    },
    applyClaim: async () => {
      calls.push("apply");
      throw new Error("must-not-apply");
    },
    fetcher: receiverSensitiveFetcher,
    isActive: () => true,
    onPhoneProofSuccess: () => calls.push("success"),
  });

  assert.deepEqual(calls, ["fetch", "success"]);
  assert.deepEqual(body, {
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
  });
  assert.deepEqual(outcome, { kind: "phone-proof" });

  // 2. Pre-request staging: invalid input and a missing fetcher never call fetch.
  let invalidDispatched = false;
  const invalidInput = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "12345",
    phoneProofOnly: true,
    prepareClaim: async () => ({}),
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (async () => {
      invalidDispatched = true;
      throw new Error("must not be called");
    }) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => {
      throw new Error("must not succeed");
    },
  });
  assert.equal(invalidDispatched, false, "invalid input must not dispatch fetch");
  assert.deepEqual(invalidInput, { kind: "failed", stage: "pre-request", reason: "invalid-input" });

  let missingFetcherPrepared = false;
  const missingFetcher = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: true,
    prepareClaim: async () => {
      missingFetcherPrepared = true;
      return {};
    },
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: undefined as unknown as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => {
      throw new Error("must not succeed");
    },
  });
  assert.deepEqual(missingFetcher, { kind: "failed", stage: "pre-request", reason: "fetcher-unavailable" });
  assert.equal(missingFetcherPrepared, false, "fetcher validation must precede local claim work");

  // 3. A local claim that never settles is bounded: verify dispatches once,
  //    omits the optional claim and does not dispatch again on late resolution.
  let resolveLateClaim: ((value: unknown) => void) | undefined;
  const lateClaim = new Promise<unknown>((resolve) => {
    resolveLateClaim = resolve;
  });
  const timeoutDiagnostics: unknown[] = [];
  let timeoutDispatches = 0;
  let timeoutBody: Record<string, unknown> | undefined;
  const timedOutClaim = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge-timeout",
    code: "123456",
    phoneProofOnly: false,
    prepareClaim: () => lateClaim,
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (async (_, init) => {
      timeoutDispatches += 1;
      timeoutBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ account: { userId: "phone-user" } });
    }) as typeof fetch,
    claimPreparationTimeoutMs: 5,
    onDiagnostic: (diagnostic) => timeoutDiagnostics.push(diagnostic),
    isActive: () => true,
    onPhoneProofSuccess: () => {
      throw new Error("must not use proof-only callback");
    },
  });
  assert.equal(timedOutClaim.kind, "normal");
  assert.equal(timeoutDispatches, 1);
  assert.equal("anonymousClaim" in (timeoutBody ?? {}), false);
  assert.deepEqual(timeoutDiagnostics, [{
    stage: "pre-request",
    reason: "claim-preparation-timeout",
  }]);
  resolveLateClaim?.({ stories: ["late"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timeoutDispatches, 1, "late claim completion must not replay verify");

  // 4. A successful session response cannot be held hostage by a local claim
  //    commit that never settles. Authentication is announced once and a late
  //    commit completion does not replay it.
  let resolveLateApply: ((value: LocalClaimCommitResult) => void) | undefined;
  const lateApply = new Promise<LocalClaimCommitResult>((resolve) => {
    resolveLateApply = resolve;
  });
  let authenticated = 0;
  let applyCalls = 0;
  const applyDiagnostics: unknown[] = [];
  const timedOutApply = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge-apply-timeout",
    code: "123456",
    phoneProofOnly: false,
    prepareClaim: async () => ({ stories: [] }),
    applyClaim: () => {
      applyCalls += 1;
      return lateApply;
    },
    fetcher: (async () => Response.json({
      account: { userId: "phone-user" },
      claim: { status: "not_found" },
    })) as typeof fetch,
    claimApplyTimeoutMs: 5,
    onDiagnostic: (diagnostic) => applyDiagnostics.push(diagnostic),
    isActive: () => true,
    onAuthenticated: () => {
      authenticated += 1;
    },
    onPhoneProofSuccess: () => undefined,
  });
  assert.equal(applyCalls, 1);
  assert.equal(authenticated, 1);
  assert.equal(timedOutApply.kind, "normal");
  if (timedOutApply.kind === "normal") {
    assert.equal(timedOutApply.claimApplyFailed, true);
    assert.equal(timedOutApply.localClaim, undefined);
  }
  assert.deepEqual(applyDiagnostics, [{
    stage: "local-claim-apply",
    reason: "claim-apply-timeout",
  }]);
  resolveLateApply?.({
    migratedStories: 1,
    migratedAssignments: 0,
    missingStories: 0,
    replayed: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(authenticated, 1, "late local commit must not replay authentication");

  // 5. If the modal closes while the server request is in flight, a later 200
  //    still reconciles the newly installed session exactly once, but does not
  //    run modal-local claim application or rendering.
  let resolveLateResponse: ((response: Response) => void) | undefined;
  let active = true;
  let lateResponseAuthenticated = 0;
  let lateResponseApplyCalls = 0;
  const lateResponseOutcomePromise = verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge-close-race",
    code: "123456",
    phoneProofOnly: false,
    prepareClaim: async () => ({ stories: [] }),
    applyClaim: async () => {
      lateResponseApplyCalls += 1;
      return { migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false };
    },
    fetcher: (() => new Promise<Response>((resolve) => {
      resolveLateResponse = resolve;
    })) as typeof fetch,
    isActive: () => active,
    onAuthenticated: () => {
      lateResponseAuthenticated += 1;
    },
    onPhoneProofSuccess: () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  active = false;
  resolveLateResponse?.(Response.json({ account: { userId: "phone-user" } }));
  const lateResponseOutcome = await lateResponseOutcomePromise;
  assert.deepEqual(lateResponseOutcome, { kind: "inactive" });
  assert.equal(lateResponseAuthenticated, 1);
  assert.equal(lateResponseApplyCalls, 0);

  // 6. Request payload construction is separate from fetch dispatch.
  let cyclicDispatches = 0;
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const invalidPayload = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: false,
    prepareClaim: async () => cyclic,
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (async () => {
      cyclicDispatches += 1;
      return Response.json({});
    }) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => undefined,
  });
  assert.equal(cyclicDispatches, 0);
  assert.deepEqual(invalidPayload, {
    kind: "failed",
    stage: "pre-request",
    reason: "invalid-payload",
  });

  // 7. A synchronous dispatch throw is distinct from an asynchronously
  //    rejected fetch Promise.
  const dispatchThrew = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: true,
    prepareClaim: async () => ({}),
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (function () {
      throw new TypeError("Illegal invocation");
    }) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => undefined,
  });
  assert.deepEqual(dispatchThrew, {
    kind: "failed",
    stage: "fetch",
    reason: "dispatch-threw",
  });

  const fetchRejected = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: true,
    prepareClaim: async () => ({}),
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => {
      throw new Error("must not succeed");
    },
  });
  assert.deepEqual(fetchRejected, { kind: "failed", stage: "fetch", reason: "fetch-rejected" });

  // 8. Response-parse staging: a non-JSON response is a parse failure, not a
  //    network failure, and never reaches the success callback.
  const parseFailed = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: true,
    prepareClaim: async () => ({}),
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => {
      throw new Error("must not succeed");
    },
  });
  assert.deepEqual(parseFailed, { kind: "failed", stage: "response-parse", reason: "invalid-json" });

  // 9. Server rejection is still a normal response outcome.
  const rejected = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: true,
    prepareClaim: async () => ({}),
    applyClaim: async () => ({ migratedStories: 0, migratedAssignments: 0, missingStories: 0, replayed: false }),
    fetcher: (async () => Response.json({ code: "OTP_INVALID_OR_EXPIRED" }, { status: 400 })) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => {
      throw new Error("must not succeed");
    },
  });
  assert.deepEqual(rejected, { kind: "rejected", status: 400, code: "OTP_INVALID_OR_EXPIRED" });

  // 10. Ordinary login includes a claim that finishes inside the deadline.
  const normalCalls: string[] = [];
  let normalBody: Record<string, unknown> | undefined;
  const normal = await verifyPhoneOtpForModal({
    phone: "13800000000",
    challengeId: "challenge",
    code: "123456",
    phoneProofOnly: false,
    prepareClaim: async () => {
      normalCalls.push("prepare");
      return { stories: ["local-story"] };
    },
    applyClaim: async (userId) => {
      assert.equal(userId, "phone-user");
      normalCalls.push("apply");
      return { migratedStories: 1, migratedAssignments: 0, missingStories: 0, replayed: false };
    },
    fetcher: (async (_, init) => {
      normalCalls.push("fetch");
      normalBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ account: { userId: "phone-user" } });
    }) as typeof fetch,
    isActive: () => true,
    onPhoneProofSuccess: () => {
      normalCalls.push("unexpected-success");
    },
  });
  assert.deepEqual(normalCalls, ["prepare", "fetch", "apply"]);
  assert.deepEqual(normalBody?.anonymousClaim, { stories: ["local-story"] });
  assert.equal(normal.kind, "normal");
  if (normal.kind === "normal") assert.equal(normal.localClaim?.migratedStories, 1);

  console.log("Phone OTP verification: bounded claim, dispatch staging, proof-only and normal flows passed");
}

void main();
