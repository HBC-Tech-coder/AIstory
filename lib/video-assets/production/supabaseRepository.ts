import "server-only";

import { createProductionSupabaseServiceClient } from "@/lib/production/databaseGate";
import {
  VideoAssetMetadataWriteRejectedError,
  VideoAssetUnavailableError,
} from "../errors";
import type {
  StoredVideoAsset,
  VideoAssetAudit,
  VideoAssetIdempotency,
  VideoAssetRepository,
} from "../repository";
import { PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION } from "./config";

export interface VideoAssetRpcClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export type VideoAssetRpcClientFactory = () => VideoAssetRpcClient;

function defaultClientFactory(): VideoAssetRpcClient {
  return createProductionSupabaseServiceClient();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDefiniteTransactionRejection(value: unknown): boolean {
  if (!isRecord(value) || typeof value.code !== "string") return false;
  // Gate14 intentionally raises P0001 for every reviewed business rejection.
  // The narrow data/constraint codes below also abort the RPC transaction.
  // Never broaden this to arbitrary SQLSTATEs: 08007 and 40003 explicitly
  // mean that the transaction/statement completion outcome is unknown.
  return [
    "P0001",
    "23502",
    "23503",
    "23505",
    "23514",
    "22P02",
    "22003",
  ].includes(value.code);
}

function asAsset(value: unknown): StoredVideoAsset {
  if (!isRecord(value)) throw new Error("Invalid video asset RPC response.");
  return structuredClone(value) as StoredVideoAsset;
}

function asIdempotency(value: unknown): VideoAssetIdempotency {
  if (!isRecord(value)) {
    throw new Error("Invalid video asset idempotency RPC response.");
  }
  const record = value as Partial<VideoAssetIdempotency>;
  if (
    typeof record.key !== "string"
    || typeof record.fingerprint !== "string"
    || typeof record.assetId !== "string"
    || !["upload", "adopt", "mutation"].includes(record.operation ?? "")
    || typeof record.createdAt !== "string"
  ) {
    throw new Error("Invalid video asset idempotency RPC response.");
  }
  return structuredClone(record) as VideoAssetIdempotency;
}

export class SupabaseVideoAssetRepository implements VideoAssetRepository {
  readonly source = "production_database" as const;
  private clientInstance: VideoAssetRpcClient | undefined;
  private gateVerified = false;

  constructor(
    readonly tenantId: string,
    private readonly clientFactory: VideoAssetRpcClientFactory = defaultClientFactory,
  ) {}

  private client(): VideoAssetRpcClient {
    this.clientInstance ??= this.clientFactory();
    return this.clientInstance;
  }

  private async rpc(
    name: string,
    args?: Record<string, unknown>,
    options: { metadataWrite?: boolean } = {},
  ): Promise<unknown> {
    try {
      const client = this.client();
      if (!this.gateVerified) {
        const gate = await client.rpc("aistory_database_gate_status");
        if (
          gate.error
          || gate.data !== PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION
        ) {
          throw new Error("Video asset database gate unavailable.");
        }
        const posture = await client.rpc("aistory_video_asset_security_posture");
        if (posture.error || posture.data !== true) {
          throw new Error("Video asset database posture unavailable.");
        }
        this.gateVerified = true;
      }
      const result = await client.rpc(name, args);
      if (result.error) {
        if (options.metadataWrite && isDefiniteTransactionRejection(result.error)) {
          throw new VideoAssetMetadataWriteRejectedError();
        }
        throw new Error("Video asset RPC failed.");
      }
      return result.data;
    } catch (error) {
      if (error instanceof VideoAssetMetadataWriteRejectedError) throw error;
      throw new VideoAssetUnavailableError();
    }
  }

  async list(): Promise<StoredVideoAsset[]> {
    const data = await this.rpc("aistory_video_asset_list", {
      requested_tenant_id: this.tenantId,
      requested_limit: 500,
    });
    if (!Array.isArray(data)) throw new VideoAssetUnavailableError();
    return data.map(asAsset);
  }

  async get(id: string): Promise<StoredVideoAsset | undefined> {
    const data = await this.rpc("aistory_video_asset_get", {
      requested_tenant_id: this.tenantId,
      requested_asset_id: id,
    });
    return data === null ? undefined : asAsset(data);
  }

  async findIdempotency(
    key: string,
  ): Promise<VideoAssetIdempotency | undefined> {
    const data = await this.rpc("aistory_video_asset_find_idempotency", {
      requested_tenant_id: this.tenantId,
      requested_key: key,
    });
    return data === null ? undefined : asIdempotency(data);
  }

  async hasObjectReference(objectKey: string): Promise<boolean> {
    const data = await this.rpc("aistory_video_asset_has_object_reference", {
      requested_tenant_id: this.tenantId,
      requested_object_key: objectKey,
    });
    if (typeof data !== "boolean") throw new VideoAssetUnavailableError();
    return data;
  }

  async create(
    asset: StoredVideoAsset,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
  ): Promise<{ asset: StoredVideoAsset; created: boolean }> {
    const data = await this.rpc("aistory_video_asset_create", {
      request_payload: {
        tenantId: this.tenantId,
        asset,
        idempotency,
        audit,
      },
    }, { metadataWrite: true });
    if (!isRecord(data) || typeof data.created !== "boolean") {
      throw new VideoAssetUnavailableError();
    }
    return { asset: asAsset(data.asset), created: data.created };
  }

  async mutateAsset(
    id: string,
    idempotency: VideoAssetIdempotency,
    audit: VideoAssetAudit,
    update: (asset: StoredVideoAsset) => void,
  ): Promise<{ asset: StoredVideoAsset; changed: boolean }> {
    const current = await this.get(id);
    if (!current) throw new VideoAssetUnavailableError();
    const next = structuredClone(current);
    update(next);
    const data = await this.rpc("aistory_video_asset_mutate", {
      request_payload: {
        tenantId: this.tenantId,
        assetId: id,
        expectedRevision: current.revision,
        next,
        idempotency,
        audit,
      },
    }, { metadataWrite: true });
    if (!isRecord(data) || typeof data.changed !== "boolean") {
      throw new VideoAssetUnavailableError();
    }
    return { asset: asAsset(data.asset), changed: data.changed };
  }
}
