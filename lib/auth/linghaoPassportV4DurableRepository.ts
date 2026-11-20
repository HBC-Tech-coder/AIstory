import "server-only";

import {
  LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION,
  assertLinghaoPassportV4DurableAuthorityGate,
  assertLinghaoPassportV4DurableHash,
  assertLinghaoPassportV4StateEnvelope,
  type LinghaoPassportV4BeginLogoutResult,
  type LinghaoPassportV4BeginRefreshResult,
  type LinghaoPassportV4CommitCallbackInput,
  type LinghaoPassportV4CommitCallbackResult,
  type LinghaoPassportV4CommitRefreshInput,
  type LinghaoPassportV4CommitRefreshResult,
  type LinghaoPassportV4ConsumeCallbackResult,
  type LinghaoPassportV4DurableAuthority,
  type LinghaoPassportV4LogoutResult,
  type LinghaoPassportV4LogoutInspection,
  type LinghaoPassportV4ReserveStartInput,
  type LinghaoPassportV4ReserveStartResult,
  type LinghaoPassportV4RevocationWork,
  type LinghaoPassportV4SessionRead,
} from "./linghaoPassportV4DurableAuthority";

export interface LinghaoPassportV4AuthRpcClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

function unavailable(): never {
  throw new Error("LINGHAO_PASSPORT_V4_DURABLE_AUTHORITY_UNAVAILABLE");
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    unavailable();
  }
  const output: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16) unavailable();
  for (const key of keys) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) unavailable();
    output[key] = descriptor.value;
  }
  return output;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const output = record(value);
  if (
    Object.keys(output).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(output, key))
  ) {
    unavailable();
  }
  return output;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) unavailable();
  return value as number;
}

function optionalEnvelope(value: unknown): string | null {
  return value === null ? null : assertLinghaoPassportV4StateEnvelope(value);
}

function refreshPair(fingerprint: unknown, envelope: unknown): void {
  if ((fingerprint === null) !== (envelope === null)) unavailable();
  if (fingerprint !== null) {
    assertLinghaoPassportV4DurableHash(fingerprint);
    assertLinghaoPassportV4StateEnvelope(envelope);
  }
}

export function createLinghaoPassportV4DurableAuthority(
  client: LinghaoPassportV4AuthRpcClient,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LinghaoPassportV4DurableAuthority {
  async function ready(): Promise<void> {
    assertLinghaoPassportV4DurableAuthorityGate(environment);
    const result = await client.rpc("aistory_linghao_passport_v4_auth_posture");
    if (
      result.error ||
      result.data !== LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION
    ) {
      unavailable();
    }
  }

  async function operation(name: string, requestPayload: Record<string, unknown>): Promise<unknown> {
    await ready();
    const result = await client.rpc(name, { request_payload: requestPayload });
    if (result.error) unavailable();
    return result.data;
  }

  return {
    assertReady: ready,

    async reserveStart(input: LinghaoPassportV4ReserveStartInput): Promise<LinghaoPassportV4ReserveStartResult> {
      for (const value of [input.familyHash, input.transactionHash, input.stateHash, input.nonceHash, input.rateBucketHash]) {
        assertLinghaoPassportV4DurableHash(value);
      }
      assertLinghaoPassportV4StateEnvelope(input.verifierEnvelope);
      const output = record(await operation("aistory_linghao_passport_v4_reserve_start", { ...input }));
      if (output.status === "rate_limited" && Object.keys(output).length === 1) return { status: "rate_limited" };
      const accepted = exact(output, ["status", "expiresAtMs"]);
      if (accepted.status !== "reserved") unavailable();
      return Object.freeze({ status: "reserved", expiresAtMs: integer(accepted.expiresAtMs) });
    },

    async cancelStart(transactionHash: string): Promise<void> {
      assertLinghaoPassportV4DurableHash(transactionHash);
      if (await operation("aistory_linghao_passport_v4_cancel_start", { transactionHash }) !== true) unavailable();
    },

    async consumeCallback(transactionHash: string, stateHash: string): Promise<LinghaoPassportV4ConsumeCallbackResult> {
      assertLinghaoPassportV4DurableHash(transactionHash);
      assertLinghaoPassportV4DurableHash(stateHash);
      const output = record(await operation("aistory_linghao_passport_v4_consume_callback", { transactionHash, stateHash }));
      if (output.status === "accepted") {
        const accepted = exact(output, ["status", "familyHash", "transactionHash", "nonceHash", "verifierEnvelope"]);
        return Object.freeze({ status: "accepted", familyHash: assertLinghaoPassportV4DurableHash(accepted.familyHash),
          transactionHash: assertLinghaoPassportV4DurableHash(accepted.transactionHash),
          nonceHash: assertLinghaoPassportV4DurableHash(accepted.nonceHash),
          verifierEnvelope: assertLinghaoPassportV4StateEnvelope(accepted.verifierEnvelope) });
      }
      if (output.status === "completed") {
        const completed = exact(output, ["status", "sessionResultEnvelope"]);
        return Object.freeze({ status: "completed", sessionResultEnvelope: assertLinghaoPassportV4StateEnvelope(completed.sessionResultEnvelope) });
      }
      const rejected = exact(output, ["status", "reason"]);
      if (rejected.status !== "rejected" || !["missing", "expired", "state_mismatch", "terminal"].includes(String(rejected.reason))) unavailable();
      return Object.freeze(rejected) as LinghaoPassportV4ConsumeCallbackResult;
    },

    async commitCallback(input: LinghaoPassportV4CommitCallbackInput): Promise<LinghaoPassportV4CommitCallbackResult> {
      for (const value of [input.transactionHash, input.familyHash, input.principalKey, input.sessionHash, input.completionHash,
        input.accessTokenFingerprint]) {
        assertLinghaoPassportV4DurableHash(value);
      }
      assertLinghaoPassportV4StateEnvelope(input.sessionResultEnvelope);
      assertLinghaoPassportV4StateEnvelope(input.accessTokenEnvelope);
      optionalEnvelope(input.idTokenHintEnvelope);
      refreshPair(input.refreshFingerprint, input.refreshEnvelope);
      integer(input.providerExpiresAtMs);
      const output = record(await operation("aistory_linghao_passport_v4_commit_callback", { ...input }));
      if ((output.status === "rejected" || output.status === "cleanup_required") && Object.keys(output).length === 1) {
        return { status: output.status };
      }
      const accepted = exact(output, ["status", "sessionResultEnvelope", "absoluteExpiresAtMs"]);
      if (accepted.status !== "committed" && accepted.status !== "replayed") unavailable();
      return Object.freeze({ status: accepted.status, sessionResultEnvelope: assertLinghaoPassportV4StateEnvelope(accepted.sessionResultEnvelope),
        absoluteExpiresAtMs: integer(accepted.absoluteExpiresAtMs) });
    },

    async readSession(sessionHash: string): Promise<LinghaoPassportV4SessionRead> {
      assertLinghaoPassportV4DurableHash(sessionHash);
      const output = record(await operation("aistory_linghao_passport_v4_read_session", { sessionHash }));
      if (output.status === "invalid" && Object.keys(output).length === 1) return { status: "invalid" };
      if (output.status === "refresh_required") {
        const refresh = exact(output, ["status", "familyHash"]);
        return Object.freeze({ status: "refresh_required", familyHash: assertLinghaoPassportV4DurableHash(refresh.familyHash) });
      }
      const session = exact(output, ["status", "principalKey", "familyHash", "sessionHash", "generation", "authenticatedAtMs", "expiresAtMs"]);
      if (session.status !== "authenticated") unavailable();
      return Object.freeze({ status: "authenticated", principalKey: assertLinghaoPassportV4DurableHash(session.principalKey),
        familyHash: assertLinghaoPassportV4DurableHash(session.familyHash), sessionHash: assertLinghaoPassportV4DurableHash(session.sessionHash),
        generation: integer(session.generation), authenticatedAtMs: integer(session.authenticatedAtMs), expiresAtMs: integer(session.expiresAtMs) });
    },

    async beginRefresh(sessionHash: string, attemptHash: string): Promise<LinghaoPassportV4BeginRefreshResult> {
      for (const value of [sessionHash, attemptHash]) assertLinghaoPassportV4DurableHash(value);
      const output = record(await operation("aistory_linghao_passport_v4_begin_refresh", { sessionHash, attemptHash }));
      if (output.status === "rejected" && Object.keys(output).length === 1) return { status: "rejected" };
      const claimed = exact(output, ["status", "familyHash", "sessionHash", "generation", "refreshContextHash", "refreshEnvelope"]);
      if (claimed.status !== "claimed") unavailable();
      return Object.freeze({ status: "claimed", familyHash: assertLinghaoPassportV4DurableHash(claimed.familyHash),
        sessionHash: assertLinghaoPassportV4DurableHash(claimed.sessionHash), generation: integer(claimed.generation),
        refreshContextHash: assertLinghaoPassportV4DurableHash(claimed.refreshContextHash),
        refreshEnvelope: assertLinghaoPassportV4StateEnvelope(claimed.refreshEnvelope) });
    },

    async commitRefresh(input: LinghaoPassportV4CommitRefreshInput): Promise<LinghaoPassportV4CommitRefreshResult> {
      for (const value of [input.attemptHash, input.completionHash, input.replacementFingerprint,
        input.accessTokenFingerprint]) assertLinghaoPassportV4DurableHash(value);
      assertLinghaoPassportV4StateEnvelope(input.replacementEnvelope);
      assertLinghaoPassportV4StateEnvelope(input.accessTokenEnvelope);
      optionalEnvelope(input.idTokenHintEnvelope);
      integer(input.providerExpiresAtMs);
      const output = exact(await operation("aistory_linghao_passport_v4_commit_refresh", { ...input }), ["status"]);
      if (!["committed", "replayed", "cleanup_required", "rejected"].includes(String(output.status))) unavailable();
      return Object.freeze(output) as LinghaoPassportV4CommitRefreshResult;
    },

    async failRefresh(attemptHash: string): Promise<void> {
      assertLinghaoPassportV4DurableHash(attemptHash);
      if (await operation("aistory_linghao_passport_v4_fail_refresh", { attemptHash }) !== true) unavailable();
    },

    async beginLogout(input): Promise<LinghaoPassportV4BeginLogoutResult> {
      for (const value of [input.familyHash, input.sessionHash, input.receiptHash, input.stateHash]) assertLinghaoPassportV4DurableHash(value);
      if (typeof input.upstreamReturnExpected !== "boolean") unavailable();
      const output = record(await operation("aistory_linghao_passport_v4_begin_logout", { ...input }));
      if (output.status === "missing") {
        const missing = exact(output, ["status", "localLoggedOut", "revocationPending", "idTokenHintEnvelope"]);
        if (missing.localLoggedOut !== true || missing.revocationPending !== false || missing.idTokenHintEnvelope !== null) unavailable();
        return Object.freeze(missing) as LinghaoPassportV4BeginLogoutResult;
      }
      const revoked = exact(output, ["status", "localLoggedOut", "revocationPending", "resultExpiresAtMs", "idTokenHintEnvelope"]);
      if (revoked.status !== "revoked" || revoked.localLoggedOut !== true || typeof revoked.revocationPending !== "boolean") unavailable();
      return Object.freeze({ ...revoked, resultExpiresAtMs: integer(revoked.resultExpiresAtMs),
        idTokenHintEnvelope: optionalEnvelope(revoked.idTokenHintEnvelope) }) as LinghaoPassportV4BeginLogoutResult;
    },

    async claimRevocation(outboxClaimHash: string): Promise<LinghaoPassportV4RevocationWork> {
      assertLinghaoPassportV4DurableHash(outboxClaimHash);
      const output = record(await operation("aistory_linghao_passport_v4_claim_revocation", { outboxClaimHash }));
      if (output.status === "empty" && Object.keys(output).length === 1) return { status: "empty" };
      const claimed = exact(output, ["status", "outboxHash", "tokenContextHash", "tokenKind", "tokenEnvelope"]);
      if (claimed.status !== "claimed" || (claimed.tokenKind !== "refresh_token" && claimed.tokenKind !== "access_token")) unavailable();
      return Object.freeze({ status: "claimed", outboxHash: assertLinghaoPassportV4DurableHash(claimed.outboxHash),
        tokenContextHash: assertLinghaoPassportV4DurableHash(claimed.tokenContextHash),
        tokenKind: claimed.tokenKind, tokenEnvelope: assertLinghaoPassportV4StateEnvelope(claimed.tokenEnvelope) });
    },

    async completeRevocation(outboxHash: string, confirmed: boolean): Promise<void> {
      assertLinghaoPassportV4DurableHash(outboxHash);
      if (typeof confirmed !== "boolean" || await operation("aistory_linghao_passport_v4_complete_revocation", { outboxHash, confirmed }) !== true) unavailable();
    },

    async inspectLogoutResult(receiptHash: string): Promise<LinghaoPassportV4LogoutInspection> {
      assertLinghaoPassportV4DurableHash(receiptHash);
      const output = record(await operation("aistory_linghao_passport_v4_inspect_logout_result", { receiptHash }));
      if (output.status === "invalid" && Object.keys(output).length === 1) return { status: "invalid" };
      const ready = exact(output, ["status", "revocationConfirmed"]);
      if (ready.status !== "ready" || typeof ready.revocationConfirmed !== "boolean") unavailable();
      return Object.freeze(ready) as LinghaoPassportV4LogoutInspection;
    },

    async consumeLogoutResult(receiptHash: string, stateHash: string, upstreamReturnConfirmed: boolean): Promise<LinghaoPassportV4LogoutResult> {
      assertLinghaoPassportV4DurableHash(receiptHash);
      assertLinghaoPassportV4DurableHash(stateHash);
      if (typeof upstreamReturnConfirmed !== "boolean") unavailable();
      const output = record(await operation("aistory_linghao_passport_v4_consume_logout_result", { receiptHash, stateHash, upstreamReturnConfirmed }));
      if (output.status === "invalid" && Object.keys(output).length === 1) return { status: "invalid" };
      const consumed = exact(output, ["status", "localLoggedOut", "revocationConfirmed", "upstreamReturnConfirmed"]);
      if (consumed.status !== "consumed" || consumed.localLoggedOut !== true || typeof consumed.revocationConfirmed !== "boolean" || typeof consumed.upstreamReturnConfirmed !== "boolean") unavailable();
      return Object.freeze(consumed) as LinghaoPassportV4LogoutResult;
    },
  };
}
