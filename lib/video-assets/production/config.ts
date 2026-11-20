import "server-only";

import path from "node:path";

import { getProductionSupabaseServerUrl } from "@/lib/production/databaseGate";
import { VideoAssetUnavailableError } from "../errors";
import { ALIYUN_OSS_VIDEO_PREFIX } from "../objectStorage";

export const PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION = "20260811193000";

export type ProductionVideoAssetEnvironment = Partial<Record<
  | "AISTORY_VIDEO_ASSET_ADAPTER"
  | "AISTORY_VIDEO_METADATA_REPOSITORY"
  | "AISTORY_VIDEO_ASSET_TENANT_ID"
  | "AISTORY_VIDEO_DATABASE_GATE_VERSION"
  | "AISTORY_DATABASE_GATE_VERSION"
  | "AISTORY_VIDEO_OSS_BUCKET"
  | "AISTORY_VIDEO_OSS_REGION"
  | "AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT"
  | "AISTORY_VIDEO_OSS_PREFIX"
  | "AISTORY_VIDEO_OSS_CREDENTIAL_SOURCE"
  | "AISTORY_VIDEO_OSS_ECS_RAM_ROLE_NAME"
  | "AISTORY_VIDEO_OSS_TIMEOUT_MS"
  | "AISTORY_VIDEO_IMDS_CONNECT_TIMEOUT_MS"
  | "AISTORY_VIDEO_IMDS_READ_TIMEOUT_MS"
  | "AISTORY_VIDEO_FFPROBE_PATH"
  | "AISTORY_SUPABASE_SERVER_URL"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "DEBUG"
  | "NODE_TLS_REJECT_UNAUTHORIZED",
  string | undefined
>>;

export type ProductionVideoAssetConfig = {
  tenantId: string;
  bucket: string;
  region: string;
  endpoint: string;
  prefix: typeof ALIYUN_OSS_VIDEO_PREFIX;
  roleName: string;
  ossTimeoutMs: number;
  imdsConnectTimeoutMs: number;
  imdsReadTimeoutMs: number;
  ffprobePath: string;
};

export type ProductionVideoAssetConfigStatus = {
  ready: boolean;
  missing: string[];
};

function clean(value: string | undefined): string {
  return value?.trim() || "";
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (!clean(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function expectedEndpoint(region: string): string {
  return `https://${region}-internal.aliyuncs.com`;
}

function isExactInternalEndpoint(value: string, region: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
      && parsed.hostname === `${region}-internal.aliyuncs.com`
      && parsed.toString() === `${expectedEndpoint(region)}/`;
  } catch {
    return false;
  }
}

function debugPatternMatches(namespace: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(namespace);
}

function enablesAliOssDebug(value: string | undefined): boolean {
  const patterns = clean(value)
    .replace(/\s+/g, ",")
    .split(",")
    .filter(Boolean);
  const includes = patterns.filter((pattern) => !pattern.startsWith("-"));
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("-"))
    .map((pattern) => pattern.slice(1));
  return [
    "ali-oss",
    "ali-oss:object",
    "ali-oss:sts",
    "ali-oss:multipart-copy",
  ].some(
    (namespace) =>
      !excludes.some((pattern) => debugPatternMatches(namespace, pattern))
      && includes.some((pattern) => debugPatternMatches(namespace, pattern)),
  );
}

export function inspectProductionVideoAssetConfig(
  env: ProductionVideoAssetEnvironment =
    process.env as ProductionVideoAssetEnvironment,
): ProductionVideoAssetConfigStatus {
  const missing: string[] = [];
  const tenantId = clean(env.AISTORY_VIDEO_ASSET_TENANT_ID).toLowerCase();
  const bucket = clean(env.AISTORY_VIDEO_OSS_BUCKET).toLowerCase();
  const region = clean(env.AISTORY_VIDEO_OSS_REGION).toLowerCase();
  const endpoint = clean(env.AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT).toLowerCase();
  const roleName = clean(env.AISTORY_VIDEO_OSS_ECS_RAM_ROLE_NAME);
  const ffprobePath = clean(env.AISTORY_VIDEO_FFPROBE_PATH);

  if (env.AISTORY_VIDEO_ASSET_ADAPTER !== "aliyun_oss") {
    missing.push("adapter");
  }
  if (env.AISTORY_VIDEO_METADATA_REPOSITORY !== "supabase") {
    missing.push("metadata_repository");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenantId)) {
    missing.push("tenant");
  }
  if (
    env.AISTORY_VIDEO_DATABASE_GATE_VERSION !==
      PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION
  ) {
    missing.push("database_gate");
  }
  if (
    env.AISTORY_DATABASE_GATE_VERSION !==
      PRODUCTION_VIDEO_ASSET_DB_GATE_VERSION
  ) {
    missing.push("identity_database_gate");
  }
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
  ) {
    missing.push("bucket");
  }
  if (!/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) {
    missing.push("region");
  }
  if (!region || !isExactInternalEndpoint(endpoint, region)) {
    missing.push("internal_endpoint");
  }
  if (clean(env.AISTORY_VIDEO_OSS_PREFIX) !== ALIYUN_OSS_VIDEO_PREFIX) {
    missing.push("prefix");
  }
  if (env.AISTORY_VIDEO_OSS_CREDENTIAL_SOURCE !== "ecs_ram_role") {
    missing.push("credential_source");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,63}$/.test(roleName)) {
    missing.push("ecs_role");
  }
  if (!ffprobePath || !path.isAbsolute(ffprobePath)) {
    missing.push("ffprobe");
  }
  if (!getProductionSupabaseServerUrl(env)) {
    missing.push("supabase_url");
  }
  if (!clean(env.SUPABASE_SERVICE_ROLE_KEY)) {
    missing.push("service_role");
  }
  if (enablesAliOssDebug(env.DEBUG)) {
    missing.push("debug_logging");
  }
  if (clean(env.NODE_TLS_REJECT_UNAUTHORIZED) === "0") {
    missing.push("tls_verification");
  }
  for (const [name, value] of [
    ["oss_timeout", boundedInteger(env.AISTORY_VIDEO_OSS_TIMEOUT_MS, 15_000, 1_000, 60_000)],
    ["imds_connect_timeout", boundedInteger(env.AISTORY_VIDEO_IMDS_CONNECT_TIMEOUT_MS, 1_000, 100, 5_000)],
    ["imds_read_timeout", boundedInteger(env.AISTORY_VIDEO_IMDS_READ_TIMEOUT_MS, 1_000, 100, 5_000)],
  ] as const) {
    if (value === null) missing.push(name);
  }
  return { ready: missing.length === 0, missing };
}

export function loadProductionVideoAssetConfig(
  env: ProductionVideoAssetEnvironment =
    process.env as ProductionVideoAssetEnvironment,
): ProductionVideoAssetConfig {
  if (!inspectProductionVideoAssetConfig(env).ready) {
    throw new VideoAssetUnavailableError();
  }
  return {
    tenantId: clean(env.AISTORY_VIDEO_ASSET_TENANT_ID).toLowerCase(),
    bucket: clean(env.AISTORY_VIDEO_OSS_BUCKET).toLowerCase(),
    region: clean(env.AISTORY_VIDEO_OSS_REGION).toLowerCase(),
    endpoint: clean(env.AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT).toLowerCase(),
    prefix: ALIYUN_OSS_VIDEO_PREFIX,
    roleName: clean(env.AISTORY_VIDEO_OSS_ECS_RAM_ROLE_NAME),
    ossTimeoutMs: boundedInteger(
      env.AISTORY_VIDEO_OSS_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
    )!,
    imdsConnectTimeoutMs: boundedInteger(
      env.AISTORY_VIDEO_IMDS_CONNECT_TIMEOUT_MS,
      1_000,
      100,
      5_000,
    )!,
    imdsReadTimeoutMs: boundedInteger(
      env.AISTORY_VIDEO_IMDS_READ_TIMEOUT_MS,
      1_000,
      100,
      5_000,
    )!,
    ffprobePath: clean(env.AISTORY_VIDEO_FFPROBE_PATH),
  };
}
