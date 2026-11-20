import "server-only";

import {
  createHash,
  randomUUID,
} from "node:crypto";

import type { CredentialModality } from "@/lib/credentials/types";
import {
  findHostedCredentialRule,
  type HostedCredentialConfig,
  HostedCredentialUnavailableError,
  inspectHostedCredentialFeature,
  readHostedCredentialConfig,
} from "./config";
import {
  decryptHostedCredential,
  encryptHostedCredential,
  type HostedCredentialEnvelope,
  type HostedCredentialPlaintext,
  rewrapHostedCredentialDek,
} from "./crypto";
import {
  getProductionHostedCredentialRepository,
  type HostedCredentialMutation,
  type HostedCredentialRepository,
} from "./repository";
import type {
  HostedCredentialFeatureStatus,
  HostedCredentialProvider,
  HostedCredentialSummary,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/;
const SAFE_REASON = /^[^\u0000-\u001f\u007f]{3,200}$/;
const TENANT_ID = "platform";

export const HOSTED_BYOK_PLATFORM_CREDIT_COST = 0 as const;

export type HostedCredentialActor = {
  userId: string;
  tenantId: "platform";
  authType: "phone";
  verifiedAt: number;
};

export type HostedCredentialServiceDependencies = {
  config?: HostedCredentialConfig;
  repository?: HostedCredentialRepository;
  now?: () => number;
};

function dependencies(
  input?: HostedCredentialServiceDependencies,
): Required<HostedCredentialServiceDependencies> {
  return {
    config: input?.config ?? readHostedCredentialConfig(),
    repository: input?.repository ?? getProductionHostedCredentialRepository(),
    now: input?.now ?? Date.now,
  };
}

function assertActor(
  actor: HostedCredentialActor,
  config: HostedCredentialConfig,
  now: number,
  requireStepUp: boolean,
): void {
  if (
    actor.authType !== "phone"
    || actor.tenantId !== TENANT_ID
    || !UUID.test(actor.userId)
  ) throw new HostedCredentialUnavailableError("identity_gate_unavailable", 401);
  if (
    requireStepUp
    && (
      !Number.isFinite(actor.verifiedAt)
      || actor.verifiedAt > now + 30_000
      || now - actor.verifiedAt > config.stepUpMaxAgeMs
    )
  ) throw new HostedCredentialUnavailableError("step_up_unavailable", 403);
}

function uniqueCapabilities(
  capabilities: CredentialModality[],
  allowed: CredentialModality[],
): CredentialModality[] {
  const result = [...new Set(capabilities)];
  if (
    result.length === 0
    || result.length > 5
    || result.some((capability) => !allowed.includes(capability))
  ) throw new HostedCredentialUnavailableError("provider_allowlist_unavailable", 403);
  return result;
}

function mutationId(actorUserId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update(`aistory-hosted-byok:${actorUserId}:${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mutationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertMutationFields(idempotencyKey: string, reason: string): void {
  if (!SAFE_IDEMPOTENCY.test(idempotencyKey) || !SAFE_REASON.test(reason)) {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  }
}

function maskedLabel(provider: HostedCredentialProvider, capabilities: CredentialModality[]): string {
  return `${provider} · ${capabilities.join("/")}`.slice(0, 80);
}

export function getHostedCredentialFeatureStatus(): HostedCredentialFeatureStatus {
  return inspectHostedCredentialFeature();
}

export async function listHostedCredentials(
  actor: HostedCredentialActor,
  deps?: HostedCredentialServiceDependencies,
): Promise<HostedCredentialSummary[]> {
  const resolved = dependencies(deps);
  assertActor(actor, resolved.config, resolved.now(), false);
  await resolved.repository.assertReady();
  return resolved.repository.list(actor.userId, actor.tenantId);
}

export async function createHostedCredential(input: {
  actor: HostedCredentialActor;
  provider: HostedCredentialProvider;
  capabilities: CredentialModality[];
  defaultFor?: CredentialModality[];
  plaintext: HostedCredentialPlaintext;
  idempotencyKey: string;
  reason: string;
}, deps?: HostedCredentialServiceDependencies): Promise<HostedCredentialSummary> {
  const resolved = dependencies(deps);
  assertActor(input.actor, resolved.config, resolved.now(), true);
  assertMutationFields(input.idempotencyKey, input.reason);
  const rule = findHostedCredentialRule(resolved.config, input.provider);
  const capabilities = uniqueCapabilities(input.capabilities, rule.capabilities);
  const defaultFor = uniqueCapabilities(
    input.defaultFor?.length ? input.defaultFor : capabilities,
    capabilities,
  );
  const credentialId = mutationId(input.actor.userId, input.idempotencyKey);
  const envelope = encryptHostedCredential({
    config: resolved.config,
    credentialId,
    ownerUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    provider: input.provider,
    capabilities,
    defaultFor,
    maskedLabel: maskedLabel(input.provider, capabilities),
    plaintext: input.plaintext,
  });
  const mutation: HostedCredentialMutation = {
    action: "create",
    actorUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    mutationFingerprint: mutationFingerprint({
      action: "create",
      actor: input.actor.userId,
      credentialId,
      provider: input.provider,
      capabilities,
      defaultFor,
      plaintext: input.plaintext,
    }),
    envelope,
  };
  return (await resolved.repository.applyMutation(mutation)).credential;
}

export async function replaceHostedCredential(input: {
  actor: HostedCredentialActor;
  credentialId: string;
  capabilities: CredentialModality[];
  defaultFor?: CredentialModality[];
  plaintext: HostedCredentialPlaintext;
  idempotencyKey: string;
  reason: string;
}, deps?: HostedCredentialServiceDependencies): Promise<HostedCredentialSummary> {
  const resolved = dependencies(deps);
  assertActor(input.actor, resolved.config, resolved.now(), true);
  assertMutationFields(input.idempotencyKey, input.reason);
  if (!UUID.test(input.credentialId)) {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  }
  const existing = await resolved.repository.readEncrypted({
    ownerUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId: input.credentialId,
  });
  if (!existing) throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  const rule = findHostedCredentialRule(resolved.config, existing.provider);
  const capabilities = uniqueCapabilities(input.capabilities, rule.capabilities);
  const defaultFor = uniqueCapabilities(
    input.defaultFor?.length ? input.defaultFor : capabilities,
    capabilities,
  );
  const envelope = encryptHostedCredential({
    config: resolved.config,
    credentialId: input.credentialId,
    ownerUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    provider: existing.provider,
    capabilities,
    defaultFor,
    maskedLabel: maskedLabel(existing.provider, capabilities),
    plaintext: input.plaintext,
  });
  return (await resolved.repository.applyMutation({
    action: "replace",
    actorUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId: input.credentialId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    mutationFingerprint: mutationFingerprint({
      action: "replace",
      actor: input.actor.userId,
      credentialId: input.credentialId,
      capabilities,
      defaultFor,
      plaintext: input.plaintext,
    }),
    envelope,
  })).credential;
}

export async function deleteHostedCredential(input: {
  actor: HostedCredentialActor;
  credentialId: string;
  idempotencyKey: string;
  reason: string;
}, deps?: HostedCredentialServiceDependencies): Promise<HostedCredentialSummary> {
  const resolved = dependencies(deps);
  assertActor(input.actor, resolved.config, resolved.now(), true);
  assertMutationFields(input.idempotencyKey, input.reason);
  if (!UUID.test(input.credentialId)) {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  }
  return (await resolved.repository.applyMutation({
    action: "delete",
    actorUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId: input.credentialId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    mutationFingerprint: mutationFingerprint({
      action: "delete",
      actor: input.actor.userId,
      credentialId: input.credentialId,
    }),
  })).credential;
}

export async function rotateHostedCredentialEnvelope(input: {
  actor: HostedCredentialActor;
  credentialId: string;
  idempotencyKey: string;
  reason: string;
}, deps?: HostedCredentialServiceDependencies): Promise<HostedCredentialSummary> {
  const resolved = dependencies(deps);
  assertActor(input.actor, resolved.config, resolved.now(), true);
  assertMutationFields(input.idempotencyKey, input.reason);
  const existing = await resolved.repository.readEncrypted({
    ownerUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId: input.credentialId,
  });
  if (!existing) throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  const envelope = rewrapHostedCredentialDek(existing, resolved.config);
  return (await resolved.repository.applyMutation({
    action: "rotate",
    actorUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId: input.credentialId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    mutationFingerprint: mutationFingerprint({
      action: "rotate",
      actor: input.actor.userId,
      credentialId: input.credentialId,
      to: envelope.kekVersion,
    }),
    envelope,
  })).credential;
}

export async function withResolvedHostedCredential<T>(input: {
  actor: HostedCredentialActor;
  credentialId: string;
  capability: CredentialModality;
  speculativeDepth: 0 | 1;
  speculative: boolean;
  operation: (credential: Readonly<HostedCredentialPlaintext>) => Promise<T>;
}, deps?: HostedCredentialServiceDependencies): Promise<T> {
  if (input.speculative && input.speculativeDepth === 0) {
    throw new HostedCredentialUnavailableError("disabled", 403);
  }
  const resolved = dependencies(deps);
  assertActor(input.actor, resolved.config, resolved.now(), false);
  const envelope = await resolved.repository.readEncrypted({
    ownerUserId: input.actor.userId,
    tenantId: input.actor.tenantId,
    credentialId: input.credentialId,
    capability: input.capability,
  });
  if (
    !envelope
    || envelope.ownerUserId !== input.actor.userId
    || envelope.tenantId !== input.actor.tenantId
    || !envelope.capabilities.includes(input.capability)
  ) throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  const plaintext = decryptHostedCredential(envelope, resolved.config);
  try {
    const result = await input.operation(plaintext);
    await resolved.repository.markUsed({
      ownerUserId: input.actor.userId,
      tenantId: input.actor.tenantId,
      credentialId: input.credentialId,
      capability: input.capability,
    });
    return result;
  } finally {
    plaintext.apiKey = "";
    plaintext.baseUrl = "";
    plaintext.model = "";
  }
}

export function isHostedCredentialEnvelope(value: unknown): value is HostedCredentialEnvelope {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { envelopeVersion?: unknown }).envelopeVersion === 1;
}

export function createSyntheticHostedCredentialId(): string {
  return randomUUID();
}
