import type { StoredGenerationJob } from "@/lib/generation-jobs/types";
import type { ProjectAssetList } from "@/lib/project-assets/types";

import type { ParkOutcome } from "./errors";

/**
 * Offline candidate for a two-way AIstory <-> park adapter.
 *
 * This module is deliberately server-only and transport-agnostic:
 *  - identity always comes from an injected transport verifier
 *  - the default state is disabled (no injected outbound transport)
 *  - the real reader only imports the two side-effect-free store readers
 *  - there is no HTTP route, UI, scheduler, generation or asset-write path
 */

export const PARK_CONTRACT_VERSION = 1 as const;

export const PARK_CAPABILITIES = ["job.status", "group.publishResult"] as const;
export type ParkCapability = (typeof PARK_CAPABILITIES)[number];

export const PARK_EVENT_STATES = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type ParkEventState = (typeof PARK_EVENT_STATES)[number];

export const PARK_REQUEST_STATES = [
  "accepted",
  "sending",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type ParkRequestState = (typeof PARK_REQUEST_STATES)[number];

export type ParkTerminalState = Extract<ParkRequestState, "succeeded" | "failed">;

/** Trusted context returned by the injected transport verifier. */
export type TrustedConnectionContext = {
  /** Authenticated principal on the remote (park) side. */
  principal: string;
  /** Opaque verifier-provided connection handle for auditing. */
  connectionId: string;
  /** AIstory instance that accepted the connection. */
  localInstance: string;
  /** Remote park instance bound to this connection. */
  remoteInstance: string;
  /** Park project reference already bound by the verifier. */
  project: string;
  /** Park group reference already bound by the verifier. */
  group: string;
  /** Capabilities currently granted to this connection. */
  capabilities: readonly ParkCapability[];
};

export type ParkTransportVerifier = (
  rawConnection: unknown,
) => Promise<TrustedConnectionContext | null> | TrustedConnectionContext | null;

export type ParkAuthorizeObject = {
  kind: "job" | "asset" | "request" | "event";
  ref: string;
};

export type ParkAuthorizeRequest = {
  principal: string;
  connectionId: string;
  localInstance: string;
  remoteInstance: string;
  project: string;
  group: string;
  capability: ParkCapability;
  object: ParkAuthorizeObject;
};

/**
 * Fresh authorization check. It is invoked immediately before every cached
 * result read and immediately before every dispatch. A revoked grant must
 * return false even when a prior result is already cached.
 */
export type ParkAuthorizer = (
  request: ParkAuthorizeRequest,
) => Promise<boolean> | boolean;

export type ParkJobBinding = {
  jobId: string;
  projectId: number;
};

export type ParkAssetBinding = {
  assetId: string;
  projectId: number;
  jobId: string;
  contentHash: string;
};

export type ParkGroupBinding = {
  capabilities: readonly ParkCapability[];
  /** park jobRef -> actual AIstory generation job */
  jobs: Readonly<Record<string, ParkJobBinding>>;
  /** park assetRef -> actual AIstory project asset */
  assets: Readonly<Record<string, ParkAssetBinding>>;
};

export type ParkProjectBinding = {
  /** Actual AIstory project id this park project reference resolves to. */
  localProjectId: number;
  groups: Readonly<Record<string, ParkGroupBinding>>;
};

export type ParkPrincipalBinding = {
  remoteInstance: string;
  projects: Readonly<Record<string, ParkProjectBinding>>;
};

/**
 * Explicit, trusted configuration map. Nothing here is derived from an
 * untrusted request body. `jobRef`/`assetRef` values are only meaningful
 * inside the matching principal + instance + project + group scope.
 */
export type ParkIntegrationConfig = {
  localInstance: string;
  principals: Readonly<Record<string, ParkPrincipalBinding>>;
};

export type ParkJobReader = {
  listJobs(): Promise<StoredGenerationJob[]>;
};

export type ParkAssetReader = {
  listAssets(projectId: number): Promise<ProjectAssetList>;
};

export type ParkReaders = {
  jobs: ParkJobReader;
  assets: ParkAssetReader;
};

/** Outbound command handed to the injected transport (already redacted). */
export type ParkOutboundPublishCommand = {
  v: typeof PARK_CONTRACT_VERSION;
  kind: "command";
  requestId: string;
  from: string;
  to: string;
  project: string;
  group: string;
  capability: "group.publishResult";
  version: typeof PARK_CONTRACT_VERSION;
  input: {
    assetRef: string;
    title: string;
  };
};

/** Read-only query for the original request id. Never causes a send. */
export type ParkOutboundRequestQuery = {
  v: typeof PARK_CONTRACT_VERSION;
  kind: "request.status";
  requestId: string;
  from: string;
  to: string;
  project: string;
  group: string;
  capability: "group.publishResult";
  version: typeof PARK_CONTRACT_VERSION;
};

/**
 * Injected outbound transport. Results are untrusted and are strictly
 * validated by the adapter. When this is absent the adapter stays disabled.
 */
export type ParkOutboundTransport = {
  send(command: ParkOutboundPublishCommand): Promise<unknown>;
  query(query: ParkOutboundRequestQuery): Promise<unknown>;
};

export type ParkRedactedJobStatus = {
  jobRef: string;
  status: StoredGenerationJob["status"];
  assetRef?: string;
  contentHash?: string;
};

export type ParkPublishInput = {
  requestId: string;
  assetRef: string;
  title: string;
};

export type ParkRequestStatusInput = {
  requestId: string;
};

export type ParkPublishReceipt = {
  requestId: string;
  state: ParkRequestState;
  assetRef: string;
  groupMessageRef?: string;
};

export type ParkRequestStatusReceipt = ParkPublishReceipt;

export type ParkEventReceipt = {
  eventId: string;
  state: ParkEventState;
  applied: boolean;
  duplicate: boolean;
};

export type ParkCommandOutcome = ParkRedactedJobStatus;

export type ParkCreatedAdapter = {
  /** True only when an outbound transport was explicitly injected. */
  readonly enabled: boolean;
  handleCommand(
    rawConnection: unknown,
    rawBody: unknown,
  ): Promise<ParkOutcome<ParkCommandOutcome>>;
  handleEvent(
    rawConnection: unknown,
    rawBody: unknown,
  ): Promise<ParkOutcome<ParkEventReceipt>>;
  publishResult(
    rawConnection: unknown,
    rawInput: unknown,
  ): Promise<ParkOutcome<ParkPublishReceipt>>;
  requestStatus(
    rawConnection: unknown,
    rawInput: unknown,
  ): Promise<ParkOutcome<ParkRequestStatusReceipt>>;
};

export type CreateParkAdapterOptions = {
  config: ParkIntegrationConfig;
  /** Absolute or workspace-relative path for the adapter's durable store. */
  storeDir: string;
  verifier: ParkTransportVerifier;
  authorize: ParkAuthorizer;
  readers: ParkReaders;
  /** Omit entirely to keep the adapter disabled (zero sends). */
  transport?: ParkOutboundTransport;
};
