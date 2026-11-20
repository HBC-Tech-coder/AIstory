import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type IndependentAdminPrincipalAuditEvent,
  type IndependentAdminPrincipalAuthStateStore,
  type IndependentAdminPrincipalCredentialBinding,
} from "./independentPrincipal";

export const INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION = "20260829063000";
export const INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_ENV =
  "AISTORY_ADMIN_PRINCIPAL_DATABASE_GATE_VERSION";
export const INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV =
  "AISTORY_ADMIN_PRINCIPAL_PUBLIC_ORIGIN";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PRINCIPAL_PATTERN = /^iap_[a-f0-9]{32}$/;
const REQUEST_PATTERN = /^ipr_[A-Za-z0-9_-]{32,96}$/;
const MAX_RETRY_SECONDS = 15 * 60;
const SESSION_TTL_MS = 15 * 60 * 1000;
const SNAPSHOT_DATASETS = [
  "users",
  "roles",
  "accounts",
  "ledger",
  "events",
  "settings",
  "payment_configs",
  "provider_configs",
  "domains",
  "channel_apps",
  "audit",
  "billing_policies",
] as const;

export type IndependentAdminPrincipalRpcResult = Readonly<{
  data: unknown;
  error: Readonly<{ message?: string }> | null;
}>;

export interface IndependentAdminPrincipalRpcClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<IndependentAdminPrincipalRpcResult>;
}

export class IndependentAdminPrincipalRepositoryError extends Error {
  readonly code = "INDEPENDENT_ADMIN_PRINCIPAL_REPOSITORY_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super("Independent administrator repository is unavailable.");
    this.name = "IndependentAdminPrincipalRepositoryError";
  }
}

export type IndependentAdminPrincipalRegistration = Readonly<{
  binding: IndependentAdminPrincipalCredentialBinding;
  requestId: string;
}>;

export type IndependentAdminPrincipalDatabaseSessionContext = Readonly<{
  binding: IndependentAdminPrincipalCredentialBinding;
  sessionIdHash: string;
}>;

function fail(): never {
  throw new IndependentAdminPrincipalRepositoryError();
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => {
      if (typeof key !== "string" || !expectedKeys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor
        && "value" in descriptor
        && descriptor.get === undefined
        && descriptor.set === undefined;
    });
}

function assertBinding(
  binding: IndependentAdminPrincipalCredentialBinding,
): void {
  if (
    !exactRecord(binding, [
      "principalId",
      "credentialBindingSha256",
      "credentialEpochSha256",
      "passwordVerifierReferenceSha256",
      "passwordAlgorithm",
      "passwordParameters",
    ])
    || !exactRecord(binding.passwordParameters, [
      "N",
      "r",
      "p",
      "keyLength",
      "maxmem",
    ])
    || !PRINCIPAL_PATTERN.test(binding.principalId)
    || !HASH_PATTERN.test(binding.credentialBindingSha256)
    || !HASH_PATTERN.test(binding.credentialEpochSha256)
    || !HASH_PATTERN.test(binding.passwordVerifierReferenceSha256)
    || binding.passwordAlgorithm !== "scrypt-v1"
    || binding.passwordParameters.N !== 131_072
    || binding.passwordParameters.r !== 8
    || binding.passwordParameters.p !== 1
    || binding.passwordParameters.keyLength !== 64
    || binding.passwordParameters.maxmem !== 256 * 1024 * 1024
  ) fail();
}

function bindingPayload(binding: IndependentAdminPrincipalCredentialBinding) {
  assertBinding(binding);
  return {
    principal_ref: binding.principalId,
    credential_binding_sha256: binding.credentialBindingSha256,
    credential_epoch_sha256: binding.credentialEpochSha256,
    password_verifier_reference_sha256:
      binding.passwordVerifierReferenceSha256,
    password_algorithm: binding.passwordAlgorithm,
    password_parameters: {
      N: binding.passwordParameters.N,
      r: binding.passwordParameters.r,
      p: binding.passwordParameters.p,
      keyLength: binding.passwordParameters.keyLength,
      maxmem: binding.passwordParameters.maxmem,
    },
  };
}

function isoTime(value: number): string {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > 8_640_000_000_000_000
  ) fail();
  try {
    return new Date(value).toISOString();
  } catch {
    fail();
  }
}

function familyHash(sessionIdHash: string): string {
  if (!HASH_PATTERN.test(sessionIdHash)) fail();
  return createHash("sha256")
    .update("aistory:independent-admin:session-family:v1\n", "utf8")
    .update(sessionIdHash, "utf8")
    .digest("hex");
}

function assertRequestId(value: string): void {
  if (!REQUEST_PATTERN.test(value)) fail();
}

export class SupabaseIndependentAdminPrincipalRepository
implements IndependentAdminPrincipalAuthStateStore {
  constructor(
    private readonly client: IndependentAdminPrincipalRpcClient,
    readonly binding: IndependentAdminPrincipalCredentialBinding,
  ) {
    assertBinding(binding);
  }

  async assertGateReady(): Promise<void> {
    const [gate, posture] = await Promise.all([
      this.client.rpc("aistory_independent_admin_gate_status"),
      this.client.rpc("aistory_independent_admin_security_posture"),
    ]);
    if (
      gate.error
      || gate.data !== INDEPENDENT_ADMIN_PRINCIPAL_DB_GATE_VERSION
      || posture.error
      || posture.data !== true
    ) fail();
  }

  async initializeOnce(
    registration: IndependentAdminPrincipalRegistration,
  ): Promise<Readonly<{ initialized: true; replayed: boolean }>> {
    if (!exactRecord(registration, ["binding", "requestId"])) fail();
    assertBinding(registration.binding);
    assertRequestId(registration.requestId);
    const result = await this.client.rpc(
      "aistory_independent_admin_initialize",
      {
        registration: {
          ...bindingPayload(registration.binding),
          request_id: registration.requestId,
        },
      },
    );
    if (
      result.error
      || !exactRecord(result.data, ["initialized", "replayed"])
      || result.data.initialized !== true
      || typeof result.data.replayed !== "boolean"
    ) fail();
    return Object.freeze({
      initialized: true,
      replayed: result.data.replayed,
    });
  }

  async rotateCredential(input: {
    currentBinding: IndependentAdminPrincipalCredentialBinding;
    nextBinding: IndependentAdminPrincipalCredentialBinding;
    requestId: string;
  }): Promise<Readonly<{ rotated: true; replayed: boolean }>> {
    if (!exactRecord(input, ["currentBinding", "nextBinding", "requestId"])) {
      fail();
    }
    assertBinding(input.currentBinding);
    assertBinding(input.nextBinding);
    assertRequestId(input.requestId);
    if (input.currentBinding.principalId !== input.nextBinding.principalId) {
      fail();
    }
    const result = await this.client.rpc(
      "aistory_independent_admin_rotate_credential",
      {
        rotation: {
          current_credential_binding_sha256:
            input.currentBinding.credentialBindingSha256,
          next: bindingPayload(input.nextBinding),
          request_id: input.requestId,
        },
      },
    );
    if (
      result.error
      || !exactRecord(result.data, ["rotated", "replayed"])
      || result.data.rotated !== true
      || typeof result.data.replayed !== "boolean"
    ) fail();
    return Object.freeze({ rotated: true, replayed: result.data.replayed });
  }

  async reserveLoginAttempts(
    bucketHashes: readonly [string, string],
    now: number,
  ): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>> {
    if (
      bucketHashes[0] === bucketHashes[1]
      || bucketHashes.some((item) => !HASH_PATTERN.test(item))
    ) fail();
    const result = await this.client.rpc(
      "aistory_independent_admin_reserve_login",
      {
        attempt: {
          ...bindingPayload(this.binding),
          global_bucket_hash: bucketHashes[0],
          subject_bucket_hash: bucketHashes[1],
          occurred_at: isoTime(now),
        },
      },
    );
    if (
      result.error
      || !exactRecord(result.data, ["allowed", "retry_after_seconds"])
      || typeof result.data.allowed !== "boolean"
      || !Number.isSafeInteger(result.data.retry_after_seconds)
      || (result.data.retry_after_seconds as number) < 0
      || (result.data.retry_after_seconds as number) > MAX_RETRY_SECONDS
      || (result.data.allowed === true
        ? result.data.retry_after_seconds !== 0
        : (result.data.retry_after_seconds as number) < 1)
    ) fail();
    return Object.freeze({
      allowed: result.data.allowed,
      retryAfterSeconds: result.data.retry_after_seconds as number,
    });
  }

  async recordInvalidCredentials(now: number): Promise<void> {
    await this.appendSecurityEvent({
      event: "invalid_credentials",
      occurredAt: now,
    });
  }

  async commitLoginSuccess(input: {
    principalId: string;
    sessionIdHash: string;
    expiresAt: number;
    bucketHashes: readonly string[];
    now: number;
  }): Promise<void> {
    if (
      input.principalId !== this.binding.principalId
      || !HASH_PATTERN.test(input.sessionIdHash)
      || input.bucketHashes.length !== 2
      || input.bucketHashes.some((item) => !HASH_PATTERN.test(item))
      || input.expiresAt - input.now !== SESSION_TTL_MS
    ) fail();
    const result = await this.client.rpc(
      "aistory_independent_admin_commit_login",
      {
        login: {
          ...bindingPayload(this.binding),
          family_hash: familyHash(input.sessionIdHash),
          session_hash: input.sessionIdHash,
          bucket_hashes: [...input.bucketHashes].sort(),
          occurred_at: isoTime(input.now),
          expires_at: isoTime(input.expiresAt),
        },
      },
    );
    if (result.error || result.data !== true) fail();
  }

  async isSessionCurrent(input: {
    principalId: string;
    sessionIdHash: string;
    now: number;
  }): Promise<boolean> {
    if (
      input.principalId !== this.binding.principalId
      || !HASH_PATTERN.test(input.sessionIdHash)
    ) return false;
    const result = await this.client.rpc(
      "aistory_independent_admin_verify_session",
      {
        session: {
          ...bindingPayload(this.binding),
          session_hash: input.sessionIdHash,
          occurred_at: isoTime(input.now),
        },
      },
    );
    if (result.error) fail();
    if (result.data === null) return false;
    if (
      !exactRecord(result.data, ["active", "role"])
      || result.data.active !== true
      || result.data.role !== "super_admin"
    ) fail();
    return true;
  }

  async revokeSession(input: {
    principalId: string;
    sessionIdHash: string;
    now: number;
  }): Promise<void> {
    if (
      input.principalId !== this.binding.principalId
      || !HASH_PATTERN.test(input.sessionIdHash)
    ) return;
    const result = await this.client.rpc(
      "aistory_independent_admin_revoke_session",
      {
        session: {
          ...bindingPayload(this.binding),
          session_hash: input.sessionIdHash,
          occurred_at: isoTime(input.now),
        },
      },
    );
    if (result.error || typeof result.data !== "boolean") fail();
  }

  async rotateSession(input: {
    principalId: string;
    currentSessionIdHash: string;
    nextSessionIdHash: string;
    nextExpiresAt: number;
    now: number;
  }): Promise<void> {
    if (
      input.principalId !== this.binding.principalId
      || !HASH_PATTERN.test(input.currentSessionIdHash)
      || !HASH_PATTERN.test(input.nextSessionIdHash)
      || input.currentSessionIdHash === input.nextSessionIdHash
      || input.nextExpiresAt <= input.now
      || input.nextExpiresAt - input.now > SESSION_TTL_MS
    ) fail();
    const result = await this.client.rpc(
      "aistory_independent_admin_rotate_session",
      {
        rotation: {
          ...bindingPayload(this.binding),
          current_session_hash: input.currentSessionIdHash,
          next_session_hash: input.nextSessionIdHash,
          occurred_at: isoTime(input.now),
          next_expires_at: isoTime(input.nextExpiresAt),
        },
      },
    );
    if (result.error || result.data !== true) fail();
  }

  async appendSecurityEvent(
    event: Omit<IndependentAdminPrincipalAuditEvent, "sequence">,
  ): Promise<void> {
    if (
      (event.event !== "origin_rejected"
        && event.event !== "invalid_credentials")
      || !exactRecord(event, event.principalId === undefined
        ? ["event", "occurredAt"]
        : ["event", "principalId", "occurredAt"])
      ||
      event.principalId !== undefined
      && event.principalId !== this.binding.principalId
    ) fail();
    const result = await this.client.rpc(
      "aistory_independent_admin_append_security_event",
      {
        security_event: {
          ...bindingPayload(this.binding),
          event: event.event,
          occurred_at: isoTime(event.occurredAt),
        },
      },
    );
    if (result.error || result.data !== true) fail();
  }

  async readAdminSnapshot(
    context: IndependentAdminPrincipalDatabaseSessionContext,
  ): Promise<Record<string, unknown>> {
    assertBinding(context.binding);
    if (
      context.binding.credentialBindingSha256
        !== this.binding.credentialBindingSha256
      || !HASH_PATTERN.test(context.sessionIdHash)
    ) fail();
    const result = await this.client.rpc(
      "aistory_independent_admin_read_snapshot",
      {
        request_payload: {
          ...bindingPayload(context.binding),
          session_hash: context.sessionIdHash,
          tenant_id: "platform",
        },
      },
    );
    if (result.error || !exactRecord(result.data, SNAPSHOT_DATASETS)) fail();
    const snapshot = result.data;
    if (SNAPSHOT_DATASETS.some((dataset) => !Array.isArray(snapshot[dataset]))) {
      fail();
    }
    return snapshot;
  }
}

export function createSupabaseIndependentAdminPrincipalRepository(
  client: SupabaseClient,
  binding: IndependentAdminPrincipalCredentialBinding,
): SupabaseIndependentAdminPrincipalRepository {
  return new SupabaseIndependentAdminPrincipalRepository(client, binding);
}
