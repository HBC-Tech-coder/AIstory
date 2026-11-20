import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GPU_CONNECTOR_COMPATIBILITY_CONTRACT,
  GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
  GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
  GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
} from "../lib/gpu-coordinator/connectorCompatibility";
import { LTX23_R0_LAN_LAB_CANDIDATE } from "../lib/gpu-coordinator/labCandidates";
import { stableCoordinatorJson } from "../lib/gpu-coordinator/protocol";
import {
  CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
  CONNECTOR_HEARTBEAT_REQUEST_STATES,
  CONNECTOR_RECONCILE_REQUEST_STATES,
} from "../lib/gpu-coordinator/types";

const sourceNames = [
  "types.ts",
  "connectorCompatibility.ts",
  "protocol.ts",
  "service.ts",
  "server.ts",
] as const;
const root = process.cwd();
const requestedOutput = process.argv.slice(2).find((argument) => argument !== "--");
const outputPath = path.resolve(
  root,
  requestedOutput ?? ".aistory-gpu/central-golden-contract-v1.json",
);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const sourceDigests = await Promise.all(
  sourceNames.map(async (name) => ({
    name,
    sha256: sha256(
      await readFile(path.join(root, "lib", "gpu-coordinator", name)),
    ),
  })),
);

const promptIdentitySha256 = sha256("aistory-central-golden-prompt-v1");
const GOLDEN_LEASE_POLL_INTERVAL_MS = 3_000;
const commonLease = {
  jobId: "job-golden-0001",
  leaseId: "lease-golden-0001",
  idempotencyKey: "request-golden-0001",
  promptIdentitySha256,
  modality: "video" as const,
  workflowId: LTX23_R0_LAN_LAB_CANDIDATE.workflowId,
  workflowSha256: LTX23_R0_LAN_LAB_CANDIDATE.workflowSha256,
  parameterBindingSha256:
    LTX23_R0_LAN_LAB_CANDIDATE.parameterBindingSha256,
  allowedOutputs: LTX23_R0_LAN_LAB_CANDIDATE.outputSlots,
  businessParameters: {
    prompt: "[redacted-golden-fixture]",
    negativePrompt: "",
    seed: 40902000,
    width: 768,
    height: 480,
    frames: 81,
    fps: 24,
  },
  inputTickets: {},
  expiresAt: "2030-01-01T00:10:00.000Z",
};

const contract = {
  schemaVersion: "1.1",
  producer: "AIstory Central gpu-coordinator",
  sourceDigests,
  connectorCompatibility: GPU_CONNECTOR_COMPATIBILITY_CONTRACT,
  runtimePosture: {
    centralDefaultEnabled: false,
    expectedBindingEnvironment: {
      buildSha256: GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
      releaseSha256: GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
      capabilityDigestSha256:
        GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
      centralContractSha256:
        GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
      runnerMode: GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
    },
    requiredRegistrationPosture: {
      ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
    },
    noWorkOnlyBeforeLeaseClaim: true,
    signedDeclarationIsNotRemoteNetworkProof: true,
  },
  schemas: {
    registration: {
      required: [
        "protocolVersion",
        "connectorId",
        "connectorVersion",
        "buildSha256",
        "releaseSha256",
        "capabilityDigestSha256",
        "centralContractSha256",
        "networkPosture",
      ],
      networkPostureRequired: [
        "productionNetworkEnabled",
        "lanLabNetworkEnabled",
        "runnerMode",
      ],
    },
    heartbeat: {
      firstState: "idle",
      requestStates: [...CONNECTOR_HEARTBEAT_REQUEST_STATES],
    },
    reconcile: {
      requestStates: [...CONNECTOR_RECONCILE_REQUEST_STATES],
      responseAuthoritativeStates: [
        ...CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
      ],
    },
    lease: {
      required: Object.keys(commonLease),
      immutableIdentity: [
        "jobId",
        "leaseId",
        "idempotencyKey",
        "workflowId",
        "workflowSha256",
        "parameterBindingSha256",
        "promptIdentitySha256",
        "modality",
        "expiresAt",
      ],
      inputTicketSlots: [
        "referenceImage",
        "firstFrame",
        "lastFrame",
        "sourceVideo",
      ],
      assetTicketMethods: ["GET", "PUT"],
    },
    operationRequests: {
      acknowledge: [
        "protocolVersion",
        "connectorId",
        "sessionId",
        "sequence",
        "jobId",
        "leaseId",
        "idempotencyKey",
        "promptIdentitySha256",
      ],
      cancelPoll: [
        "protocolVersion",
        "connectorId",
        "sessionId",
        "sequence",
        "jobId",
        "leaseId",
        "idempotencyKey",
        "promptIdentitySha256",
      ],
      uploadTicket: [
        "protocolVersion",
        "connectorId",
        "sessionId",
        "sequence",
        "jobId",
        "leaseId",
        "idempotencyKey",
        "promptIdentitySha256",
        "artifact",
      ],
      reconcileRecord: [
        "jobId",
        "leaseId",
        "idempotencyKey",
        "workflowId",
        "workflowSha256",
        "parameterBindingSha256",
        "promptIdentitySha256",
        "modality",
        "expiresAt",
        "state",
        "artifact?",
      ],
    },
    operationResponses: {
      acknowledge: ["acknowledged", "expiresAt"],
      renew: ["renewed", "previousExpiresAt", "expiresAt"],
      progress: ["acceptedSequence", "cancelRequested"],
      terminal: ["accepted", "authoritativeState"],
    },
  },
  transcripts: [
    {
      name: "lease-no-work-only-gate",
      operation: "lease",
      responseData: {
        kind: "no_work",
        nextPollAfterMs: GOLDEN_LEASE_POLL_INTERVAL_MS,
        reason: "runner_mode_no_work_only",
      },
    },
    {
      name: "register-no-work-only-attestation",
      operation: "register",
      requestShape: {
        centralContractSha256: "sha256",
        networkPosture: { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE },
      },
    },
    {
      name: "first-heartbeat-idle",
      operation: "heartbeat",
      requestShape: {
        sequence: 0,
        state: "idle",
      },
    },
    {
      name: "lease-original-video-fixed",
      operation: "lease",
      responseData: { kind: "lease", lease: commonLease },
    },
    {
      name: "cancel-poll-full-identity",
      operation: "cancel-poll",
      request: {
        protocolVersion: "1.0",
        connectorId: "connector-golden-0001",
        sessionId: "session-golden-0001",
        sequence: 8,
        jobId: commonLease.jobId,
        leaseId: commonLease.leaseId,
        idempotencyKey: commonLease.idempotencyKey,
        promptIdentitySha256,
      },
    },
    {
      name: "reconcile-full-identity",
      operation: "reconcile",
      record: {
        jobId: commonLease.jobId,
        leaseId: commonLease.leaseId,
        idempotencyKey: commonLease.idempotencyKey,
        workflowId: commonLease.workflowId,
        workflowSha256: commonLease.workflowSha256,
        parameterBindingSha256: commonLease.parameterBindingSha256,
        promptIdentitySha256,
        modality: "video",
        expiresAt: commonLease.expiresAt,
        state: "running",
      },
    },
    {
      name: "upscale-source-video-ticket-shape",
      operation: "lease",
      inputSlot: "sourceVideo",
      ticket: {
        ticketId: "input-golden-0001",
        url: "https://coordinator.invalid/api/gpu-coordinator/v1/artifacts/input-golden-0001",
        exactHost: "coordinator.invalid",
        method: "GET",
        mimeType: "video/mp4",
        bytes: 24,
        sha256: sha256("synthetic-video-fixture"),
        expiresAt: "2030-01-01T00:05:00.000Z",
        checksumHeader: {
          name: "x-aistory-content-sha256",
          value: sha256("synthetic-video-fixture"),
        },
        chunkBytes: 1048576,
      },
      note: "shape_only_not_an_allowlisted_workflow",
    },
  ],
};

const encoded = `${stableCoordinatorJson(contract)}\n`;
const bundleSha256 = sha256(encoded);
const checksumPath = `${outputPath}.sha256`;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, encoded, { encoding: "utf8", mode: 0o600 });
await writeFile(
  checksumPath,
  `${bundleSha256}  ${path.basename(outputPath)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({
    outputPath,
    checksumPath,
    bytes: Buffer.byteLength(encoded),
    sha256: bundleSha256,
    sourceDigests,
  })}\n`,
);
