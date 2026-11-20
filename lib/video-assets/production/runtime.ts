import "server-only";

import { createHash } from "node:crypto";

import { getProductionSupabaseServerUrl } from "@/lib/production/databaseGate";
import type {
  ProductionVideoAssetAdapter,
  VideoAssetServiceOptions,
} from "../server";
import {
  AliyunOssVideoObjectTransport,
  type AliyunOssClientFactory,
} from "./aliyunOssTransport";
import {
  loadProductionVideoAssetConfig,
  type ProductionVideoAssetEnvironment,
} from "./config";
import {
  createEcsRamRoleCredentialSource,
  type AliyunOssCredentialSource,
  type EcsRamRoleBuilderFactory,
} from "./credentials";
import {
  createProductionVideoByteProbe,
  type VideoProbeExecRunner,
} from "./probe";
import {
  SupabaseVideoAssetRepository,
  type VideoAssetRpcClientFactory,
} from "./supabaseRepository";

export type ProductionVideoAssetRuntimeDependencies = {
  credentialSource?: AliyunOssCredentialSource;
  credentialBuilderFactory?: EcsRamRoleBuilderFactory;
  ossClientFactory?: AliyunOssClientFactory;
  rpcClientFactory?: VideoAssetRpcClientFactory;
  probeExecRunner?: VideoProbeExecRunner;
};

let cachedRuntimeSignature: string | undefined;
let cachedRuntimeAdapter: ProductionVideoAssetAdapter | undefined;

function productionRuntimeSignature(
  env: ProductionVideoAssetEnvironment,
): string {
  const config = loadProductionVideoAssetConfig(env);
  return JSON.stringify({
    ...config,
    supabaseServerUrl: getProductionSupabaseServerUrl(env),
    serviceRoleKeyHash: createHash("sha256")
      .update(env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "")
      .digest("hex"),
  });
}

export function createProductionVideoAssetAdapter(
  env: ProductionVideoAssetEnvironment =
    process.env as ProductionVideoAssetEnvironment,
  dependencies: ProductionVideoAssetRuntimeDependencies = {},
): ProductionVideoAssetAdapter {
  const config = loadProductionVideoAssetConfig(env);
  const credentialSource = dependencies.credentialSource
    ?? createEcsRamRoleCredentialSource(
      config,
      dependencies.credentialBuilderFactory,
    );
  const repository = new SupabaseVideoAssetRepository(
    config.tenantId,
    dependencies.rpcClientFactory,
  );
  const objectStorage = new AliyunOssVideoObjectTransport(
    config,
    credentialSource,
    dependencies.ossClientFactory,
  );
  return {
    tenantId: config.tenantId,
    repository,
    objectStorage,
    probe: createProductionVideoByteProbe(
      config.ffprobePath,
      dependencies.probeExecRunner,
    ),
  };
}

/**
 * Route composition is intentionally lazy and fail-closed. Invalid or missing
 * production configuration returns no adapter; the service layer maps that to
 * its stable 503 response without contacting IMDS, Supabase, OSS, or ffprobe.
 */
export function getRuntimeVideoAssetServiceOptions(
  env: ProductionVideoAssetEnvironment =
    process.env as ProductionVideoAssetEnvironment,
): VideoAssetServiceOptions {
  if (env.AISTORY_VIDEO_ASSET_ADAPTER !== "aliyun_oss") {
    cachedRuntimeSignature = undefined;
    cachedRuntimeAdapter = undefined;
    return {};
  }
  try {
    const signature = productionRuntimeSignature(env);
    if (signature !== cachedRuntimeSignature || !cachedRuntimeAdapter) {
      cachedRuntimeAdapter = createProductionVideoAssetAdapter(env);
      cachedRuntimeSignature = signature;
    }
    return { production: cachedRuntimeAdapter };
  } catch {
    cachedRuntimeSignature = undefined;
    cachedRuntimeAdapter = undefined;
    return {};
  }
}
