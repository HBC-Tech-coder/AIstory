import "server-only";

import {
  assertProductionDatabaseGateReady,
  createProductionSupabaseServiceClient,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import type { HostedCredentialEnvelope } from "./crypto";
import type {
  HostedCredentialStatus,
  HostedCredentialSummary,
} from "./types";

export type HostedCredentialMutationAction =
  | "create"
  | "replace"
  | "delete"
  | "rotate";

export type HostedCredentialMutation = {
  action: HostedCredentialMutationAction;
  actorUserId: string;
  tenantId: string;
  credentialId: string;
  reason: string;
  idempotencyKey: string;
  mutationFingerprint: string;
  envelope?: HostedCredentialEnvelope;
};

export type HostedCredentialMutationResult = {
  credential: HostedCredentialSummary;
  replayed: boolean;
};

export interface HostedCredentialRepository {
  readonly source: "supabase" | "fake";
  assertReady(): Promise<void>;
  list(ownerUserId: string, tenantId: string): Promise<HostedCredentialSummary[]>;
  readEncrypted(input: {
    ownerUserId: string;
    tenantId: string;
    credentialId: string;
    capability?: string;
  }): Promise<HostedCredentialEnvelope | undefined>;
  applyMutation(
    mutation: HostedCredentialMutation,
  ): Promise<HostedCredentialMutationResult>;
  markUsed(input: {
    ownerUserId: string;
    tenantId: string;
    credentialId: string;
    capability: string;
  }): Promise<void>;
}

export interface HostedCredentialRpcClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSummary(value: unknown): HostedCredentialSummary {
  const row = record(value);
  const status = row?.status;
  if (
    !row
    || typeof row.id !== "string"
    || typeof row.provider !== "string"
    || typeof row.masked_label !== "string"
    || typeof row.created_at !== "string"
    || typeof row.updated_at !== "string"
    || !["active", "revoked", "deleted"].includes(String(status))
  ) throw new ProductionDatabaseGateError();
  return {
    id: row.id,
    provider: row.provider as HostedCredentialSummary["provider"],
    capabilities: stringArray(row.capabilities) as HostedCredentialSummary["capabilities"],
    defaultFor: stringArray(row.default_for) as HostedCredentialSummary["defaultFor"],
    maskedLabel: row.masked_label,
    status: status as HostedCredentialStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(typeof row.last_used_at === "string" ? { lastUsedAt: row.last_used_at } : {}),
  };
}

function parseEnvelope(value: unknown): HostedCredentialEnvelope | undefined {
  const row = record(value);
  if (!row) return undefined;
  const required = [
    "credential_id",
    "owner_user_id",
    "tenant_id",
    "provider",
    "masked_label",
    "ciphertext",
    "nonce",
    "tag",
    "wrapped_dek",
    "wrap_nonce",
    "wrap_tag",
    "kek_version",
  ] as const;
  if (required.some((key) => typeof row[key] !== "string")) {
    throw new ProductionDatabaseGateError();
  }
  if (Number(row.envelope_version) !== 1) throw new ProductionDatabaseGateError();
  return {
    envelopeVersion: 1,
    credentialId: row.credential_id as string,
    ownerUserId: row.owner_user_id as string,
    tenantId: row.tenant_id as string,
    provider: row.provider as HostedCredentialEnvelope["provider"],
    capabilities: stringArray(row.capabilities) as HostedCredentialEnvelope["capabilities"],
    defaultFor: stringArray(row.default_for) as HostedCredentialEnvelope["defaultFor"],
    maskedLabel: row.masked_label as string,
    ciphertext: row.ciphertext as string,
    nonce: row.nonce as string,
    tag: row.tag as string,
    wrappedDek: row.wrapped_dek as string,
    wrapNonce: row.wrap_nonce as string,
    wrapTag: row.wrap_tag as string,
    kekVersion: row.kek_version as string,
  };
}

export class SupabaseHostedCredentialRepository
  implements HostedCredentialRepository {
  readonly source = "supabase" as const;
  private ready = false;

  constructor(private readonly client: HostedCredentialRpcClient) {}

  async assertReady(): Promise<void> {
    if (this.ready) return;
    await assertProductionDatabaseGateReady("identity", this.client);
    this.ready = true;
  }

  async list(
    ownerUserId: string,
    tenantId: string,
  ): Promise<HostedCredentialSummary[]> {
    await this.assertReady();
    const result = await this.client.rpc("aistory_hosted_byok_list", {
      owner_user_id: ownerUserId,
      owner_tenant: tenantId,
    });
    if (result.error || !Array.isArray(result.data)) {
      throw new ProductionDatabaseGateError();
    }
    return result.data.map(parseSummary);
  }

  async readEncrypted(input: {
    ownerUserId: string;
    tenantId: string;
    credentialId: string;
    capability?: string;
  }): Promise<HostedCredentialEnvelope | undefined> {
    await this.assertReady();
    const result = await this.client.rpc("aistory_hosted_byok_read_encrypted", {
      owner_user_id: input.ownerUserId,
      owner_tenant: input.tenantId,
      credential_id: input.credentialId,
      requested_capability: input.capability ?? null,
    });
    if (result.error) throw new ProductionDatabaseGateError();
    return parseEnvelope(result.data);
  }

  async applyMutation(
    mutation: HostedCredentialMutation,
  ): Promise<HostedCredentialMutationResult> {
    await this.assertReady();
    const envelope = mutation.envelope;
    const result = await this.client.rpc("aistory_hosted_byok_apply_mutation", {
      mutation: {
        action: mutation.action,
        actor_user_id: mutation.actorUserId,
        tenant_id: mutation.tenantId,
        credential_id: mutation.credentialId,
        reason: mutation.reason,
        idempotency_key: mutation.idempotencyKey,
        mutation_fingerprint: mutation.mutationFingerprint,
        ...(envelope ? {
          envelope_version: envelope.envelopeVersion,
          provider: envelope.provider,
          capabilities: envelope.capabilities,
          default_for: envelope.defaultFor,
          masked_label: envelope.maskedLabel,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
          tag: envelope.tag,
          wrapped_dek: envelope.wrappedDek,
          wrap_nonce: envelope.wrapNonce,
          wrap_tag: envelope.wrapTag,
          kek_version: envelope.kekVersion,
        } : {}),
      },
    });
    const payload = record(result.data);
    if (result.error || !payload) throw new ProductionDatabaseGateError();
    return {
      credential: parseSummary(payload.credential),
      replayed: payload.replayed === true,
    };
  }

  async markUsed(input: {
    ownerUserId: string;
    tenantId: string;
    credentialId: string;
    capability: string;
  }): Promise<void> {
    await this.assertReady();
    const result = await this.client.rpc("aistory_hosted_byok_mark_used", {
      owner_user_id: input.ownerUserId,
      owner_tenant: input.tenantId,
      credential_id: input.credentialId,
      requested_capability: input.capability,
    });
    if (result.error || result.data !== true) {
      throw new ProductionDatabaseGateError();
    }
  }
}

let productionRepository: HostedCredentialRepository | undefined;

export function getProductionHostedCredentialRepository(): HostedCredentialRepository {
  productionRepository ??= new SupabaseHostedCredentialRepository(
    createProductionSupabaseServiceClient() as unknown as HostedCredentialRpcClient,
  );
  return productionRepository;
}

