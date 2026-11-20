import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import {
  GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
  GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
  GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
  type GpuConnectorRuntimeBinding,
} from "./connectorCompatibility";
import {
  decodeCoordinatorHmacSecret,
  signCoordinatorResponse,
  verifyCoordinatorRequest,
} from "./hmac";
import {
  getLanGpuCoordinatorAdminStatus,
  LanGpuGenerationJobPort,
  requestLanGpuJobCancellation,
  submitLanGpuVideoJob,
  type LanGpuWorkflowAllowlistEntry,
} from "./generationJobAdapter";
import { RandomCoordinatorIdSource, SystemCoordinatorClock } from "./fake";
import { LanLabCoordinatorRepository } from "./labRepository";
import { GpuCoordinatorService } from "./service";
import { dispatchCoordinatorRequest } from "./transport";
import type { LanGpuVideoJobInput } from "@/lib/generation-jobs/types";
import type { GpuCoordinatorOperation } from "./types";
import type { CoordinatorResponseEnvelope } from "./types";
import { findFrozenLanGpuWorkflowCandidate } from "./labCandidates";

export type LanGpuCoordinatorCapability = {
  enabled: boolean;
  ready: boolean;
  mode: "disabled" | "lan_lab";
  reason:
    | "disabled"
    | "missing_connector_id"
    | "missing_expected_build_sha256"
    | "missing_expected_release_sha256"
    | "missing_expected_capability_digest_sha256"
    | "missing_expected_central_contract_sha256"
    | "invalid_expected_runner_mode"
    | "missing_hmac_key_id"
    | "missing_hmac_secret"
    | "missing_store"
    | "missing_coordinator_origin"
    | "missing_upload_origin"
    | "workflow_allowlist_empty"
    | "ready";
  workflowCount: number;
  concurrency: 1;
  speculativePrefetch: false;
};

type LanGpuCoordinatorRuntime = {
  capability: LanGpuCoordinatorCapability;
  connectorId?: string;
  allowlist: LanGpuWorkflowAllowlistEntry[];
  repository?: LanLabCoordinatorRepository;
  service?: GpuCoordinatorService;
  keyRing?: {
    current: {
      keyId: string;
      secret: Uint8Array;
    };
  };
  runtimeBinding?: GpuConnectorRuntimeBinding;
};

function cleanConnectorId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(trimmed)
    ? trimmed
    : undefined;
}

function cleanKeyId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed)
    ? trimmed
    : undefined;
}

function cleanSha256(value: string | undefined): string | undefined {
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function parseLanGpuWorkflowAllowlist(
  value: string | undefined,
): LanGpuWorkflowAllowlistEntry[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: LanGpuWorkflowAllowlistEntry[] = [];
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !["workflowId", "workflowSha256", "modality"].includes(key),
      )
    ) {
      return [];
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.workflowId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(candidate.workflowId) ||
      typeof candidate.workflowSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.workflowSha256) ||
      candidate.modality !== "video"
    ) {
      return [];
    }
    const frozen = findFrozenLanGpuWorkflowCandidate(
      candidate.workflowId,
      candidate.workflowSha256,
    );
    if (!frozen) return [];
    entries.push({
      workflowId: frozen.workflowId,
      workflowSha256: frozen.workflowSha256,
      purpose: frozen.purpose,
      modality: "video",
      classification: "non_publishable",
      parameterBindingSha256: frozen.parameterBindingSha256,
      fixedParameters: { ...frozen.fixedParameters },
      inputSlots: [...frozen.inputSlots],
      outputSlots: frozen.outputSlots.map((item) => ({ ...item })),
    });
  }
  return entries;
}

function parseExactHttpsOrigin(
  value: string | undefined,
): { origin: string; host: string; hostname: string } | undefined {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return { origin: url.origin, host: url.host, hostname: url.hostname };
  } catch {
    return undefined;
  }
}

export function inspectLanGpuCoordinatorEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): LanGpuCoordinatorCapability {
  if (env.AISTORY_GPU_LAN_LAB_ENABLED !== "true") {
    return {
      enabled: false,
      ready: false,
      mode: "disabled",
      reason: "disabled",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  const connectorId = cleanConnectorId(
    env.AISTORY_GPU_LAN_LAB_CONNECTOR_ID,
  );
  if (!connectorId) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_connector_id",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!cleanSha256(env[GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV])) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_expected_build_sha256",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!cleanSha256(env[GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV])) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_expected_release_sha256",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!cleanSha256(env[GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV])) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_expected_capability_digest_sha256",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!cleanSha256(env[GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV])) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_expected_central_contract_sha256",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (
    env[GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV] !==
    GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE.runnerMode
  ) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "invalid_expected_runner_mode",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!cleanKeyId(env.AISTORY_GPU_LAN_LAB_HMAC_KEY_ID)) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_hmac_key_id",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  try {
    decodeCoordinatorHmacSecret(
      env.AISTORY_GPU_LAN_LAB_HMAC_SECRET_BASE64 ?? "",
    );
  } catch {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_hmac_secret",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  const storeDir = env.AISTORY_GPU_LAN_LAB_STORE_DIR?.trim();
  if (!storeDir || !path.isAbsolute(storeDir)) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_store",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!parseExactHttpsOrigin(env.AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN)) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_coordinator_origin",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  if (!parseExactHttpsOrigin(env.AISTORY_GPU_LAN_LAB_UPLOAD_ORIGIN)) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "missing_upload_origin",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  const allowlist = parseLanGpuWorkflowAllowlist(
    env.AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON,
  );
  if (!allowlist.length) {
    return {
      enabled: true,
      ready: false,
      mode: "lan_lab",
      reason: "workflow_allowlist_empty",
      workflowCount: 0,
      concurrency: 1,
      speculativePrefetch: false,
    };
  }
  return {
    enabled: true,
    ready: true,
    mode: "lan_lab",
    reason: "ready",
    workflowCount: allowlist.length,
    concurrency: 1,
    speculativePrefetch: false,
  };
}

function createRuntime(
  env: NodeJS.ProcessEnv = process.env,
): LanGpuCoordinatorRuntime {
  const capability = inspectLanGpuCoordinatorEnvironment(env);
  if (!capability.ready) return { capability, allowlist: [] };
  const connectorId = cleanConnectorId(
    env.AISTORY_GPU_LAN_LAB_CONNECTOR_ID,
  )!;
  const keyId = cleanKeyId(env.AISTORY_GPU_LAN_LAB_HMAC_KEY_ID)!;
  const uploadOrigin = parseExactHttpsOrigin(
    env.AISTORY_GPU_LAN_LAB_UPLOAD_ORIGIN,
  )!;
  const allowlist = parseLanGpuWorkflowAllowlist(
    env.AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON,
  );
  const maxVideoBytes = Math.min(
    2 * 1024 * 1024 * 1024,
    Math.max(
      1024 * 1024,
      Number(env.AISTORY_GPU_LAN_LAB_MAX_VIDEO_BYTES) ||
        512 * 1024 * 1024,
    ),
  );
  const runtimeBinding: GpuConnectorRuntimeBinding = {
    expectedBuildSha256: env[GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV]!,
    expectedReleaseSha256: env[GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV]!,
    expectedCapabilityDigestSha256:
      env[GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV]!,
    expectedCentralContractSha256:
      env[GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV]!,
    expectedNetworkPosture: { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE },
  };
  const repository = new LanLabCoordinatorRepository(
    path.resolve(env.AISTORY_GPU_LAN_LAB_STORE_DIR!),
    [uploadOrigin.hostname],
    uploadOrigin.origin,
    maxVideoBytes,
  );
  const keyRing = {
    current: {
      keyId,
      secret: decodeCoordinatorHmacSecret(
        env.AISTORY_GPU_LAN_LAB_HMAC_SECRET_BASE64!,
      ),
    },
  };
  const idSource = new RandomCoordinatorIdSource();
  const service = new GpuCoordinatorService({
    repository,
    ticketIssuer: repository,
    clock: new SystemCoordinatorClock(),
    idSource,
    generationJobs: new LanGpuGenerationJobPort(repository),
    allowedConnectorId: connectorId,
    currentKeyId: keyId,
    acceptedKeyIds: [keyId],
    runtimeBinding,
  });
  return {
    capability,
    connectorId,
    allowlist,
    repository,
    service,
    keyRing,
    runtimeBinding,
  };
}

declare global {
  var __aistoryLanGpuCoordinatorRuntime:
    | {
        signature: string;
        runtime: LanGpuCoordinatorRuntime;
      }
    | undefined;
}

function runtimeSignature(env: NodeJS.ProcessEnv): string {
  const secretFingerprint = env.AISTORY_GPU_LAN_LAB_HMAC_SECRET_BASE64
    ? createHash("sha256")
        .update(env.AISTORY_GPU_LAN_LAB_HMAC_SECRET_BASE64)
        .digest("hex")
    : "";
  return [
    env.AISTORY_GPU_LAN_LAB_ENABLED,
    env.AISTORY_GPU_LAN_LAB_CONNECTOR_ID,
    env[GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV],
    env[GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV],
    env[GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV],
    env[GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV],
    env[GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV],
    env.AISTORY_GPU_LAN_LAB_HMAC_KEY_ID,
    secretFingerprint,
    env.AISTORY_GPU_LAN_LAB_STORE_DIR,
    env.AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN,
    env.AISTORY_GPU_LAN_LAB_UPLOAD_ORIGIN,
    env.AISTORY_GPU_LAN_LAB_WORKFLOW_ALLOWLIST_JSON,
    env.AISTORY_GPU_LAN_LAB_MAX_VIDEO_BYTES,
  ].join("|");
}

export function isLanGpuCoordinatorHostAllowed(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const coordinatorOrigin = parseExactHttpsOrigin(
    env.AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN,
  );
  const requestHost = headers.get("host")?.trim().toLowerCase();
  return Boolean(
    coordinatorOrigin &&
      requestHost &&
      requestHost === coordinatorOrigin.host.toLowerCase(),
  );
}

export function getLanGpuCoordinatorRuntime(): LanGpuCoordinatorRuntime {
  const signature = runtimeSignature(process.env);
  if (
    !globalThis.__aistoryLanGpuCoordinatorRuntime ||
    globalThis.__aistoryLanGpuCoordinatorRuntime.signature !== signature
  ) {
    globalThis.__aistoryLanGpuCoordinatorRuntime = {
      signature,
      runtime: createRuntime(),
    };
  }
  return globalThis.__aistoryLanGpuCoordinatorRuntime.runtime;
}

export function resetLanGpuCoordinatorRuntimeForTests(): void {
  globalThis.__aistoryLanGpuCoordinatorRuntime = undefined;
}

export async function handleLanGpuCoordinatorOperation(input: {
  operation: GpuCoordinatorOperation;
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array;
}) {
  const runtime = getLanGpuCoordinatorRuntime();
  if (
    !runtime.capability.ready ||
    !runtime.service ||
    !runtime.repository ||
    !runtime.keyRing
  ) {
    throw new Error("LAN GPU coordinator is unavailable.");
  }
  return dispatchCoordinatorRequest(
    {
      service: runtime.service,
      keyRing: runtime.keyRing,
      replayGuard: runtime.repository,
    },
    input,
  );
}

export async function handleLanGpuArtifactUpload(input: {
  ticketId: string;
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array;
}) {
  const runtime = getLanGpuCoordinatorRuntime();
  if (
    !runtime.capability.ready ||
    !runtime.repository ||
    !runtime.keyRing ||
    !runtime.service ||
    runtime.runtimeBinding?.expectedNetworkPosture.runnerMode ===
      "no_work_only"
  ) {
    throw new Error("LAN GPU coordinator is unavailable.");
  }
  const now = new Date();
  const verified = await verifyCoordinatorRequest({
    method: input.method,
    path: input.path,
    headers: input.headers,
    body: input.body,
    keyRing: runtime.keyRing,
    replayGuard: runtime.repository,
    now,
  });
  const declaredType = input.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (declaredType !== "video/mp4" && declaredType !== "video/webm") {
    throw new Error("LAN GPU artifact MIME is invalid.");
  }
  const accepted = await runtime.repository.acceptUpload({
    ticketId: input.ticketId,
    bytes: input.body,
    declaredType,
    now,
  });
  const envelope: CoordinatorResponseEnvelope = {
    protocolVersion: "1.0",
    requestId: verified.requestId,
    serverTime: now.toISOString(),
    sequence: 0,
    ok: true,
    control: runtime.service.control(),
    data: {
      accepted: true,
      sha256: accepted.sha256,
      bytes: accepted.bytes,
      contentType: accepted.contentType,
    },
  };
  const signed = signCoordinatorResponse({
    envelope,
    status: 201,
    path: input.path,
    key: runtime.keyRing.current,
    now,
  });
  return { status: 201, ...signed };
}

export async function handleLanGpuArtifactDownload(input: {
  ticketId: string;
}): Promise<{
  body: Uint8Array;
  contentType: "video/mp4" | "video/webm";
  sha256: string;
}> {
  const runtime = getLanGpuCoordinatorRuntime();
  if (
    !runtime.capability.ready ||
    !runtime.repository ||
    runtime.runtimeBinding?.expectedNetworkPosture.runnerMode ===
      "no_work_only"
  ) {
    throw new Error("LAN GPU coordinator is unavailable.");
  }
  const consumed = await runtime.repository.consumeInput({
    ticketId: input.ticketId,
    now: new Date(),
  });
  return {
    body: consumed.bytes,
    contentType: consumed.contentType,
    sha256: consumed.sha256,
  };
}

export async function submitConfiguredLanGpuVideoJob(
  input: LanGpuVideoJobInput,
): Promise<ReturnType<typeof submitLanGpuVideoJob> extends Promise<infer T> ? T : never> {
  const runtime = getLanGpuCoordinatorRuntime();
  if (
    !runtime.capability.ready ||
    !runtime.repository ||
    runtime.runtimeBinding?.expectedNetworkPosture.runnerMode ===
      "no_work_only"
  ) {
    throw new Error("LAN GPU coordinator is unavailable.");
  }
  return submitLanGpuVideoJob({
    job: input,
    allowlist: runtime.allowlist,
    repository: runtime.repository,
  });
}

export async function cancelConfiguredLanGpuJob(jobId: string) {
  const runtime = getLanGpuCoordinatorRuntime();
  if (
    !runtime.capability.ready ||
    !runtime.repository ||
    runtime.runtimeBinding?.expectedNetworkPosture.runnerMode ===
      "no_work_only"
  ) {
    throw new Error("LAN GPU coordinator is unavailable.");
  }
  return requestLanGpuJobCancellation({
    jobId,
    repository: runtime.repository,
  });
}

export async function configuredLanGpuAdminStatus() {
  const runtime = getLanGpuCoordinatorRuntime();
  const executionEnabled = Boolean(
    runtime.capability.ready &&
      runtime.runtimeBinding?.expectedNetworkPosture.runnerMode !==
        "no_work_only",
  );
  return getLanGpuCoordinatorAdminStatus({
    enabled: executionEnabled,
    connectorId: executionEnabled ? runtime.connectorId : undefined,
    workflowCount: executionEnabled ? runtime.allowlist.length : 0,
    repository: executionEnabled ? runtime.repository : undefined,
  });
}

export function configuredLanGpuWorkflows(): Array<{
  workflowId: string;
  workflowSha256: string;
  purpose: "generate" | "upscale";
  modality: "video";
  fixedParameters: LanGpuWorkflowAllowlistEntry["fixedParameters"];
  inputSlots: LanGpuWorkflowAllowlistEntry["inputSlots"];
}> {
  const runtime = getLanGpuCoordinatorRuntime();
  if (
    runtime.runtimeBinding?.expectedNetworkPosture.runnerMode ===
    "no_work_only"
  ) {
    return [];
  }
  return runtime.allowlist.map((item) => ({
    workflowId: item.workflowId,
    workflowSha256: item.workflowSha256,
    purpose: item.purpose,
    modality: item.modality,
    fixedParameters: { ...item.fixedParameters },
    inputSlots: [...item.inputSlots],
  }));
}
