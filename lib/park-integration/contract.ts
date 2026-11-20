import { createHash } from "node:crypto";

import { ParkError } from "./errors";
import {
  PARK_CAPABILITIES,
  PARK_CONTRACT_VERSION,
  PARK_EVENT_STATES,
  type ParkAssetBinding,
  type ParkCapability,
  type ParkEventState,
  type ParkGroupBinding,
  type ParkIntegrationConfig,
  type ParkJobBinding,
} from "./types";

const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_TITLE_LENGTH = 160;

const CAPABILITY_SET = new Set<string>(PARK_CAPABILITIES);
const EVENT_STATE_SET = new Set<string>(PARK_EVENT_STATES);

const JOB_STATUS_SET = new Set<string>([
  "queued",
  "running",
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ParkError("unknown_field", `Unknown field in ${label}.`);
    }
  }
}

export function boundedIdentifier(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !BOUNDED_ID.test(value)) {
    throw new ParkError("invalid_request", `Invalid ${label}.`);
  }
  return value;
}

export function boundedTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new ParkError("invalid_request", "Invalid title.");
  }
  if (
    value.length < 1 ||
    value.length > MAX_TITLE_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ParkError("invalid_request", "Invalid title.");
  }
  return value;
}

function requireContractVersion(v: unknown, version: unknown): void {
  if (v !== PARK_CONTRACT_VERSION || version !== PARK_CONTRACT_VERSION) {
    throw new ParkError("unsupported_version");
  }
}

function requireCapability(value: unknown): ParkCapability {
  if (typeof value !== "string" || !CAPABILITY_SET.has(value)) {
    throw new ParkError("unsupported_capability");
  }
  return value as ParkCapability;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ParkError("invalid_request", `Invalid ${label}.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ParkError("invalid_request", `Invalid ${label}.`);
  }
  return value;
}

export type JobStatusCommandInput = { jobRef: string };
export type PublishResultCommandInput = { assetRef: string; title: string };

export type ValidatedCommand = {
  v: typeof PARK_CONTRACT_VERSION;
  kind: "command";
  requestId: string;
  from: string;
  to: string;
  project: string;
  group: string;
  capability: ParkCapability;
  version: typeof PARK_CONTRACT_VERSION;
  input: JobStatusCommandInput | PublishResultCommandInput;
};

export type ValidatedEvent = {
  v: typeof PARK_CONTRACT_VERSION;
  kind: "event";
  eventId: string;
  requestId?: string;
  from: string;
  to: string;
  project: string;
  group: string;
  capability: ParkCapability;
  version: typeof PARK_CONTRACT_VERSION;
  state: ParkEventState;
  result: Readonly<Record<string, string>>;
};

const COMMAND_KEYS = [
  "v",
  "kind",
  "requestId",
  "from",
  "to",
  "project",
  "group",
  "capability",
  "version",
  "input",
] as const;

const EVENT_KEYS = [
  "v",
  "kind",
  "eventId",
  "requestId",
  "from",
  "to",
  "project",
  "group",
  "capability",
  "version",
  "state",
  "result",
] as const;

function validateCommandInput(
  capability: ParkCapability,
  raw: unknown,
): JobStatusCommandInput | PublishResultCommandInput {
  const input = requireObject(raw, "command input");
  if (capability === "job.status") {
    rejectUnknownKeys(input, ["jobRef"], "command input");
    return { jobRef: boundedIdentifier(input.jobRef, "jobRef") };
  }
  rejectUnknownKeys(input, ["assetRef", "title"], "command input");
  return {
    assetRef: boundedIdentifier(input.assetRef, "assetRef"),
    title: boundedTitle(input.title),
  };
}

export function validateCommand(raw: unknown): ValidatedCommand {
  const body = requireObject(raw, "command");
  rejectUnknownKeys(body, COMMAND_KEYS, "command");
  requireContractVersion(body.v, body.version);
  if (body.kind !== "command") throw new ParkError("invalid_request");
  const capability = requireCapability(body.capability);
  return {
    v: PARK_CONTRACT_VERSION,
    kind: "command",
    requestId: boundedIdentifier(body.requestId, "requestId"),
    from: boundedIdentifier(body.from, "from"),
    to: boundedIdentifier(body.to, "to"),
    project: boundedIdentifier(body.project, "project"),
    group: boundedIdentifier(body.group, "group"),
    capability,
    version: PARK_CONTRACT_VERSION,
    input: validateCommandInput(capability, body.input),
  };
}

function validateEventResult(
  capability: ParkCapability,
  state: ParkEventState,
  raw: unknown,
): Readonly<Record<string, string>> {
  const input = requireObject(raw, "event result");
  const result: Record<string, string> = {};
  if (capability === "job.status") {
    rejectUnknownKeys(
      input,
      ["jobRef", "jobState", "assetRef", "contentHash"],
      "event result",
    );
    result.jobRef = boundedIdentifier(input.jobRef, "jobRef");
    if (input.jobState !== undefined) {
      const state = requireString(input.jobState, "jobState");
      if (!JOB_STATUS_SET.has(state)) throw new ParkError("invalid_request");
      result.jobState = state;
    }
    if (input.assetRef !== undefined) {
      result.assetRef = boundedIdentifier(input.assetRef, "assetRef");
    }
    if (input.contentHash !== undefined) {
      result.contentHash = boundedIdentifier(input.contentHash, "contentHash");
    }
  } else {
    rejectUnknownKeys(
      input,
      ["groupMessageRef", "assetRef"],
      "event result",
    );
    if (input.groupMessageRef !== undefined) {
      result.groupMessageRef = boundedIdentifier(
        input.groupMessageRef,
        "groupMessageRef",
      );
    }
    if (input.assetRef !== undefined) {
      result.assetRef = boundedIdentifier(input.assetRef, "assetRef");
    }
    if (state === "succeeded") {
      // A publish success must identify the group message and the exact
      // asset that was published; it cannot be inferred later.
      if (result.groupMessageRef === undefined || result.assetRef === undefined) {
        throw new ParkError("invalid_request", "Invalid success event result.");
      }
    } else if (result.groupMessageRef !== undefined) {
      // Only a success may carry a group message reference.
      throw new ParkError("invalid_request", "Invalid event result.");
    }
  }
  return result;
}

export function validateEvent(raw: unknown): ValidatedEvent {
  const body = requireObject(raw, "event");
  rejectUnknownKeys(body, EVENT_KEYS, "event");
  requireContractVersion(body.v, body.version);
  if (body.kind !== "event") throw new ParkError("invalid_request");
  const capability = requireCapability(body.capability);
  if (typeof body.state !== "string" || !EVENT_STATE_SET.has(body.state)) {
    throw new ParkError("invalid_request", "Invalid event state.");
  }
  const requestId =
    body.requestId === undefined
      ? undefined
      : boundedIdentifier(body.requestId, "requestId");
  return {
    v: PARK_CONTRACT_VERSION,
    kind: "event",
    eventId: boundedIdentifier(body.eventId, "eventId"),
    ...(requestId === undefined ? {} : { requestId }),
    from: boundedIdentifier(body.from, "from"),
    to: boundedIdentifier(body.to, "to"),
    project: boundedIdentifier(body.project, "project"),
    group: boundedIdentifier(body.group, "group"),
    capability,
    version: PARK_CONTRACT_VERSION,
    state: body.state as ParkEventState,
    result: validateEventResult(
      capability,
      body.state as ParkEventState,
      body.result,
    ),
  };
}

export function validatePublishInput(raw: unknown): {
  requestId: string;
  assetRef: string;
  title: string;
} {
  const input = requireObject(raw, "publish input");
  rejectUnknownKeys(
    input,
    ["requestId", "assetRef", "title"],
    "publish input",
  );
  return {
    requestId: boundedIdentifier(input.requestId, "requestId"),
    assetRef: boundedIdentifier(input.assetRef, "assetRef"),
    title: boundedTitle(input.title),
  };
}

export function validateRequestStatusInput(raw: unknown): { requestId: string } {
  const input = requireObject(raw, "request status input");
  rejectUnknownKeys(input, ["requestId"], "request status input");
  return { requestId: boundedIdentifier(input.requestId, "requestId") };
}

export type ValidatedRemoteReceipt = {
  state: "accepted" | "succeeded" | "failed" | "unknown";
  groupMessageRef?: string;
};

const RECEIPT_STATES = new Set<string>([
  "accepted",
  "succeeded",
  "failed",
  "unknown",
]);

/**
 * Remote transport responses are untrusted. Only the exact receipt keys are
 * accepted; anything else is treated as an invalid (unknown) result.
 */
export function validateRemoteReceipt(raw: unknown): ValidatedRemoteReceipt {
  const receipt = requireObject(raw, "transport result");
  rejectUnknownKeys(receipt, ["state", "groupMessageRef"], "transport result");
  if (typeof receipt.state !== "string" || !RECEIPT_STATES.has(receipt.state)) {
    throw new ParkError("invalid_transport_result");
  }
  const state = receipt.state as ValidatedRemoteReceipt["state"];
  if (state === "succeeded" && receipt.groupMessageRef === undefined) {
    throw new ParkError("invalid_transport_result");
  }
  const groupMessageRef =
    receipt.groupMessageRef === undefined
      ? undefined
      : boundedIdentifier(receipt.groupMessageRef, "groupMessageRef");
  return groupMessageRef === undefined ? { state } : { state, groupMessageRef };
}

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === "number" ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (isPlainObject(input)) {
      if (seen.has(input)) {
        throw new ParkError("invalid_request", "Cyclic value.");
      }
      seen.add(input);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        output[key] = normalize(input[key]);
      }
      seen.delete(input);
      return output;
    }
    throw new ParkError("invalid_request", "Non-JSON value.");
  };
  return JSON.stringify(normalize(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new ParkError("invalid_request", `Invalid ${label}.`);
  }
  return value;
}

export function validateConfig(config: ParkIntegrationConfig): void {
  if (!isPlainObject(config)) throw new ParkError("invalid_request");
  boundedIdentifier(config.localInstance, "localInstance");
  if (!isPlainObject(config.principals)) throw new ParkError("invalid_request");
  for (const [principalId, principal] of Object.entries(config.principals)) {
    boundedIdentifier(principalId, "principal");
    if (!isPlainObject(principal)) throw new ParkError("invalid_request");
    boundedIdentifier(principal.remoteInstance, "remoteInstance");
    if (!isPlainObject(principal.projects)) throw new ParkError("invalid_request");
    for (const [projectRef, project] of Object.entries(principal.projects)) {
      boundedIdentifier(projectRef, "project");
      if (!isPlainObject(project)) throw new ParkError("invalid_request");
      requirePositiveInteger(project.localProjectId, "localProjectId");
      if (!isPlainObject(project.groups)) throw new ParkError("invalid_request");
      for (const [groupRef, group] of Object.entries(project.groups)) {
        validateGroupBinding(groupRef, group);
      }
    }
  }
}

function validateGroupBinding(groupRef: string, group: ParkGroupBinding): void {
  boundedIdentifier(groupRef, "group");
  if (!isPlainObject(group)) throw new ParkError("invalid_request");
  if (!Array.isArray(group.capabilities)) throw new ParkError("invalid_request");
  for (const capability of group.capabilities) {
    if (!CAPABILITY_SET.has(capability)) throw new ParkError("invalid_request");
  }
  if (!isPlainObject(group.jobs)) throw new ParkError("invalid_request");
  for (const [jobRef, binding] of Object.entries(group.jobs)) {
    validateJobBinding(jobRef, binding);
  }
  if (!isPlainObject(group.assets)) throw new ParkError("invalid_request");
  for (const [assetRef, binding] of Object.entries(group.assets)) {
    validateAssetBinding(assetRef, binding);
  }
}

function validateJobBinding(jobRef: string, binding: ParkJobBinding): void {
  boundedIdentifier(jobRef, "jobRef");
  if (!isPlainObject(binding)) throw new ParkError("invalid_request");
  boundedIdentifier(binding.jobId, "jobId");
  requirePositiveInteger(binding.projectId, "job binding projectId");
}

function validateAssetBinding(
  assetRef: string,
  binding: ParkAssetBinding,
): void {
  boundedIdentifier(assetRef, "assetRef");
  if (!isPlainObject(binding)) throw new ParkError("invalid_request");
  boundedIdentifier(binding.assetId, "assetId");
  requirePositiveInteger(binding.projectId, "asset binding projectId");
  boundedIdentifier(binding.jobId, "asset binding jobId");
  boundedIdentifier(binding.contentHash, "asset binding contentHash");
}
