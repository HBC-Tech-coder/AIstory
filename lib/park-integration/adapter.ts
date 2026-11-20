import "server-only";

import type { StoredGenerationJob } from "@/lib/generation-jobs/types";
import type { ProjectAsset } from "@/lib/project-assets/types";

import {
  boundedIdentifier,
  canonicalJson,
  isPlainObject,
  sha256Hex,
  validateCommand,
  validateConfig,
  validateEvent,
  validatePublishInput,
  validateRemoteReceipt,
  validateRequestStatusInput,
  type JobStatusCommandInput,
  type ValidatedCommand,
  type ValidatedEvent,
  type ValidatedRemoteReceipt,
} from "./contract";
import { ParkError, parkFail, parkOk, type ParkOutcome } from "./errors";
import {
  ParkDurableStore,
  type ParkStoreState,
  type PersistedRequest,
} from "./store";
import {
  PARK_CAPABILITIES,
  PARK_CONTRACT_VERSION,
  type CreateParkAdapterOptions,
  type ParkAssetBinding,
  type ParkCapability,
  type ParkCreatedAdapter,
  type ParkEventReceipt,
  type ParkEventState,
  type ParkGroupBinding,
  type ParkJobBinding,
  type ParkOutboundPublishCommand,
  type ParkOutboundRequestQuery,
  type ParkPublishInput,
  type ParkPublishReceipt,
  type ParkRedactedJobStatus,
  type ParkRequestStatusReceipt,
  type TrustedConnectionContext,
} from "./types";

const TERMINAL_STATES = new Set(["succeeded", "failed"]);

export function requestKey(
  principal: string,
  project: string,
  requestId: string,
): string {
  return [principal, project, requestId].join("\u0000");
}

export function eventKey(
  principal: string,
  remoteInstance: string,
  project: string,
  group: string,
  capability: ParkCapability,
  eventId: string,
): string {
  return [principal, remoteInstance, project, group, capability, eventId].join(
    "\u0000",
  );
}

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

function nowIso(): string {
  return new Date().toISOString();
}

function receiptOf(request: PersistedRequest): ParkPublishReceipt {
  return {
    requestId: request.requestId,
    state: request.state,
    assetRef: request.assetRef,
    ...(request.state === "succeeded" &&
    request.groupMessageRef !== undefined
      ? { groupMessageRef: request.groupMessageRef }
      : {}),
  };
}

function sameAssetFingerprint(
  left: {
    assetId: string;
    projectId: number;
    jobId: string;
    contentHash: string;
  },
  right: {
    assetId: string;
    projectId: number;
    jobId: string;
    contentHash: string;
  },
): boolean {
  return (
    left.assetId === right.assetId &&
    left.projectId === right.projectId &&
    left.jobId === right.jobId &&
    left.contentHash === right.contentHash
  );
}

function normalizeTrustedContext(value: unknown): TrustedConnectionContext {
  if (!isPlainObject(value)) throw new ParkError("unauthenticated");
  try {
    if (!Array.isArray(value.capabilities)) {
      throw new ParkError("unauthenticated");
    }
    const capabilities: ParkCapability[] = [];
    for (const capability of value.capabilities) {
      if (
        typeof capability !== "string" ||
        !(PARK_CAPABILITIES as readonly string[]).includes(capability)
      ) {
        throw new ParkError("unauthenticated");
      }
      capabilities.push(capability as ParkCapability);
    }
    return {
      principal: boundedIdentifier(value.principal, "principal"),
      connectionId: boundedIdentifier(value.connectionId, "connectionId"),
      localInstance: boundedIdentifier(value.localInstance, "localInstance"),
      remoteInstance: boundedIdentifier(value.remoteInstance, "remoteInstance"),
      project: boundedIdentifier(value.project, "project"),
      group: boundedIdentifier(value.group, "group"),
      capabilities,
    };
  } catch {
    throw new ParkError("unauthenticated");
  }
}

type ResolvedBinding = {
  project: {
    localProjectId: number;
    groups: Readonly<Record<string, ParkGroupBinding>>;
  };
  group: ParkGroupBinding;
};

function assertJobProjectRelation(
  job: StoredGenerationJob,
  projectId: number,
): void {
  if (job.provider === "localminidrama") {
    if (job.input.dramaId !== projectId) throw new ParkError("unmapped");
    return;
  }
  if (job.provider === "gpu-connector-lan") {
    if (
      job.input.projectId !== undefined &&
      job.input.projectId !== projectId
    ) {
      throw new ParkError("unmapped");
    }
  }
  // ComfyUI jobs have no project relation; only the explicit map authorizes.
}

export class DefaultParkAdapter implements ParkCreatedAdapter {
  readonly enabled: boolean;
  private readonly store: ParkDurableStore;

  constructor(private readonly options: CreateParkAdapterOptions) {
    this.enabled = options.transport !== undefined;
    this.store = new ParkDurableStore(options.storeDir);
  }

  private async verify(rawConnection: unknown): Promise<TrustedConnectionContext> {
    let verified: unknown;
    try {
      verified = await this.options.verifier(rawConnection);
    } catch {
      throw new ParkError("unauthenticated");
    }
    return normalizeTrustedContext(verified);
  }

  private resolveBinding(
    context: TrustedConnectionContext,
    capability: ParkCapability,
  ): ResolvedBinding {
    if (this.options.config.localInstance !== context.localInstance) {
      throw new ParkError("forbidden");
    }
    const principal = this.options.config.principals[context.principal];
    if (!principal || principal.remoteInstance !== context.remoteInstance) {
      throw new ParkError("forbidden");
    }
    const project = principal.projects[context.project];
    if (!project) throw new ParkError("forbidden");
    const group = project.groups[context.group];
    if (!group) throw new ParkError("forbidden");
    if (!group.capabilities.includes(capability)) {
      throw new ParkError("forbidden");
    }
    if (!context.capabilities.includes(capability)) {
      throw new ParkError("forbidden");
    }
    return { project, group };
  }

  private resolveJobMapping(
    binding: ResolvedBinding,
    jobRef: string,
  ): ParkJobBinding {
    const jobBinding = binding.group.jobs[jobRef];
    if (
      !jobBinding ||
      jobBinding.projectId !== binding.project.localProjectId
    ) {
      throw new ParkError("unmapped");
    }
    return jobBinding;
  }

  private resolveAssetMapping(
    binding: ResolvedBinding,
    assetRef: string,
  ): ParkAssetBinding {
    const assetBinding = binding.group.assets[assetRef];
    if (
      !assetBinding ||
      assetBinding.projectId !== binding.project.localProjectId
    ) {
      throw new ParkError("unmapped");
    }
    return assetBinding;
  }

  private findJobRefForJob(
    group: ParkGroupBinding,
    projectId: number,
    jobId: string,
  ): string | undefined {
    for (const [jobRef, binding] of Object.entries(group.jobs)) {
      if (binding.jobId === jobId && binding.projectId === projectId) {
        return jobRef;
      }
    }
    return undefined;
  }

  private assertEnvelopeIdentity(
    envelope: { from: string; to: string; project: string; group: string; capability: ParkCapability },
    context: TrustedConnectionContext,
  ): void {
    if (
      envelope.from !== context.remoteInstance ||
      envelope.to !== context.localInstance ||
      envelope.project !== context.project ||
      envelope.group !== context.group ||
      !context.capabilities.includes(envelope.capability)
    ) {
      throw new ParkError("forbidden");
    }
  }

  private async authorize(
    context: TrustedConnectionContext,
    capability: ParkCapability,
    kind: "job" | "asset" | "request" | "event",
    ref: string,
  ): Promise<void> {
    const allowed = await this.options.authorize({
      principal: context.principal,
      connectionId: context.connectionId,
      localInstance: context.localInstance,
      remoteInstance: context.remoteInstance,
      project: context.project,
      group: context.group,
      capability,
      object: { kind, ref },
    });
    if (!allowed) throw new ParkError("forbidden");
  }

  private async run<T>(operation: () => Promise<ParkOutcome<T>>): Promise<ParkOutcome<T>> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ParkError) {
        return parkFail(error.code, error.message);
      }
      return parkFail("internal_error");
    }
  }

  // ---------------------------------------------------------------------
  // Inbound: park -> AIstory, read-only job.status@1
  // ---------------------------------------------------------------------

  handleCommand(
    rawConnection: unknown,
    rawBody: unknown,
  ): Promise<ParkOutcome<ParkRedactedJobStatus>> {
    return this.run(async () => {
      const context = await this.verify(rawConnection);
      const command: ValidatedCommand = validateCommand(rawBody);
      this.assertEnvelopeIdentity(command, context);
      // Binding and capability are resolved before any cached result is
      // considered: a removed binding must never disclose an old record.
      const binding = this.resolveBinding(context, command.capability);
      if (command.capability !== "job.status") {
        throw new ParkError("unsupported_operation");
      }
      const input = command.input as JobStatusCommandInput;
      const jobMapping = this.resolveJobMapping(binding, input.jobRef);

      const digest = sha256Hex(canonicalJson(command));
      const key = requestKey(context.principal, context.project, command.requestId);

      return this.store.withLock(async () => {
        const state = await this.store.readState();
        const existing = state.inbound[key];
        if (existing) {
          if (existing.digest !== digest) throw new ParkError("conflict");
          // Pin the persisted original mapping identity against the current
          // map. A removed or remapped jobRef cannot return the old record.
          if (
            existing.jobId !== jobMapping.jobId ||
            existing.projectId !== binding.project.localProjectId
          ) {
            throw new ParkError("unmapped");
          }
          // Fresh job ACL and a freshly recomputed safe status; the persisted
          // result is never returned as-is because it may contain an assetRef
          // that has since been removed or remapped.
          await this.authorize(context, "job.status", "job", input.jobRef);
          const pinnedAsset =
            existing.assetId === undefined
              ? null
              : {
                  assetId: existing.assetId,
                  projectId: existing.projectId,
                  jobId: existing.jobId,
                  contentHash: existing.contentHash ?? "",
                };
          const result = await this.readJobStatus(
            context,
            binding,
            input.jobRef,
            jobMapping.jobId,
            pinnedAsset,
          );
          const refreshed = this.inboundFingerprint(
            binding,
            jobMapping,
            result,
          );
          existing.result = result;
          existing.assetId = refreshed.assetId;
          existing.contentHash = refreshed.contentHash;
          existing.updatedAt = nowIso();
          await this.store.writeState(state);
          return parkOk(result, true);
        }

        // Fresh authorization immediately before reading the local stores.
        await this.authorize(context, "job.status", "job", input.jobRef);
        const result = await this.readJobStatus(
          context,
          binding,
          input.jobRef,
          jobMapping.jobId,
          undefined,
        );
        const fingerprint = this.inboundFingerprint(binding, jobMapping, result);

        const timestamp = nowIso();
        state.inbound[key] = {
          key,
          principal: context.principal,
          localInstance: context.localInstance,
          remoteInstance: context.remoteInstance,
          project: context.project,
          group: context.group,
          capability: "job.status",
          version: PARK_CONTRACT_VERSION,
          requestId: command.requestId,
          digest,
          jobId: jobMapping.jobId,
          projectId: binding.project.localProjectId,
          ...(fingerprint.assetId === undefined
            ? {}
            : {
                assetId: fingerprint.assetId,
                contentHash: fingerprint.contentHash,
              }),
          result,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.store.writeState(state);
        return parkOk(result);
      });
    });
  }

  private inboundFingerprint(
    binding: ResolvedBinding,
    jobMapping: ParkJobBinding,
    result: ParkRedactedJobStatus,
  ): { assetId?: string; contentHash?: string } {
    if (result.assetRef === undefined) return {};
    const assetBinding = binding.group.assets[result.assetRef];
    if (!assetBinding) return {};
    return {
      assetId: assetBinding.assetId,
      contentHash: assetBinding.contentHash,
    };
  }

  /**
   * `assetPin` semantics:
   *  - undefined: first read, expose the first eligible mapped asset
   *  - null: the original safe result exposed no asset; expose none now
   *  - object: only expose that exact persisted asset identity
   */
  private async readJobStatus(
    context: TrustedConnectionContext,
    binding: ResolvedBinding,
    jobRef: string,
    jobId: string,
    assetPin:
      | {
          assetId: string;
          projectId: number;
          jobId: string;
          contentHash: string;
        }
      | null
      | undefined,
  ): Promise<ParkRedactedJobStatus> {
    const projectId = binding.project.localProjectId;
    const jobs = await this.options.readers.jobs.listJobs();
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new ParkError("unmapped");
    assertJobProjectRelation(job, projectId);

    const result: ParkRedactedJobStatus = {
      jobRef,
      status: job.status,
    };

    if (
      job.status !== "succeeded" ||
      job.releaseClassification === "non_publishable" ||
      assetPin === null
    ) {
      return result;
    }

    const list = await this.options.readers.assets.listAssets(projectId);
    for (const [assetRef, assetBinding] of Object.entries(binding.group.assets)) {
      if (
        assetBinding.projectId !== projectId ||
        assetBinding.jobId !== jobId
      ) {
        continue;
      }
      if (assetPin !== undefined && !sameAssetFingerprint(assetBinding, assetPin)) {
        continue;
      }
      const asset = list.items.find(
        (candidate) =>
          candidate.id === assetBinding.assetId &&
          candidate.projectId === projectId &&
          candidate.jobId === jobId &&
          candidate.contentHash === assetBinding.contentHash &&
          candidate.status === "ready" &&
          candidate.releaseClassification !== "non_publishable",
      );
      if (asset) {
        // Separate object ACL check for the asset before it is disclosed.
        await this.authorize(context, "job.status", "asset", assetRef);
        result.assetRef = assetRef;
        result.contentHash = asset.contentHash;
        break;
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Outbound: AIstory -> park, idempotent group.publishResult@1
  // ---------------------------------------------------------------------

  publishResult(
    rawConnection: unknown,
    rawInput: unknown,
  ): Promise<ParkOutcome<ParkPublishReceipt>> {
    return this.run(async () => {
      const context = await this.verify(rawConnection);
      const input: ParkPublishInput = validatePublishInput(rawInput);
      // Binding, capability and the current asset/job mapping are resolved
      // before the cached branch: a removed/remapped ref must fail closed.
      const binding = this.resolveBinding(context, "group.publishResult");
      const transport = this.options.transport;
      if (!transport) throw new ParkError("disabled");

      const assetBinding = this.resolveAssetMapping(binding, input.assetRef);
      await this.requireSucceededJob(
        binding.project.localProjectId,
        assetBinding.jobId,
      );
      await this.requireEligibleAsset(
        binding.project.localProjectId,
        assetBinding,
      );

      const command: ParkOutboundPublishCommand = {
        v: PARK_CONTRACT_VERSION,
        kind: "command",
        requestId: input.requestId,
        from: context.localInstance,
        to: context.remoteInstance,
        project: context.project,
        group: context.group,
        capability: "group.publishResult",
        version: PARK_CONTRACT_VERSION,
        input: { assetRef: input.assetRef, title: input.title },
      };
      const digest = sha256Hex(canonicalJson(command));
      const key = requestKey(context.principal, context.project, input.requestId);

      // Fresh authorization before any persisted/cached read.
      await this.authorize(
        context,
        "group.publishResult",
        "request",
        input.requestId,
      );
      await this.authorize(
        context,
        "group.publishResult",
        "asset",
        input.assetRef,
      );

      return this.store.withLock(async () => {
        const state = await this.store.readState();
        const existing = state.requests[key];

        // The binding, mapping and ACL observed before the lock may be stale:
        // waiting for the lock can outlive an ACL revocation or a remap.
        // Re-resolve under the lock, immediately before the cached return or
        // the outbound dispatch.
        const currentBinding = this.resolveBinding(
          context,
          "group.publishResult",
        );
        const currentAssetBinding = this.resolveAssetMapping(
          currentBinding,
          input.assetRef,
        );

        if (existing) {
          if (existing.digest !== digest) throw new ParkError("conflict");
          // Revalidate the persisted original pin against the mapping that is
          // current under the lock; a removed/remapped binding cannot return
          // the old receipt.
          if (
            existing.assetId !== currentAssetBinding.assetId ||
            existing.projectId !== currentAssetBinding.projectId ||
            existing.jobId !== currentAssetBinding.jobId ||
            existing.contentHash !== currentAssetBinding.contentHash
          ) {
            throw new ParkError("unmapped");
          }
          // Fresh object ACL immediately before the cached receipt is returned.
          await this.authorize(
            context,
            "group.publishResult",
            "request",
            input.requestId,
          );
          await this.authorize(
            context,
            "group.publishResult",
            "asset",
            input.assetRef,
          );
          return parkOk(receiptOf(existing), true);
        }

        // The mapping current under the lock must still match the one that was
        // validated before it; otherwise the persisted pin would be stale.
        if (!sameAssetFingerprint(currentAssetBinding, assetBinding)) {
          throw new ParkError("unmapped");
        }

        const timestamp = nowIso();
        const request: PersistedRequest = {
          key,
          principal: context.principal,
          localInstance: context.localInstance,
          remoteInstance: context.remoteInstance,
          project: context.project,
          group: context.group,
          capability: "group.publishResult",
          version: PARK_CONTRACT_VERSION,
          requestId: input.requestId,
          digest,
          state: "accepted",
          assetRef: input.assetRef,
          assetId: assetBinding.assetId,
          projectId: assetBinding.projectId,
          jobId: assetBinding.jobId,
          contentHash: assetBinding.contentHash,
          title: input.title,
          createdAt: timestamp,
          updatedAt: timestamp,
          sendAttempts: 0,
        };
        state.requests[key] = request;
        await this.store.writeState(state);

        // Fresh object authorization immediately before dispatch.
        try {
          await this.authorize(
            context,
            "group.publishResult",
            "request",
            input.requestId,
          );
          await this.authorize(
            context,
            "group.publishResult",
            "asset",
            input.assetRef,
          );
        } catch (error) {
          request.state = "failed";
          request.errorCode = "authorization_revoked";
          request.updatedAt = nowIso();
          await this.store.writeState(state);
          throw error;
        }

        // Persist `sending` BEFORE invoking the transport.
        request.state = "sending";
        request.sendAttempts += 1;
        request.updatedAt = nowIso();
        await this.store.writeState(state);

        let receipt: ValidatedRemoteReceipt;
        try {
          const raw = await transport.send({
            ...command,
            input: { ...command.input },
          });
          receipt = validateRemoteReceipt(raw);
        } catch {
          receipt = { state: "unknown" };
        }

        request.state = receipt.state;
        request.updatedAt = nowIso();
        if (receipt.state === "succeeded" && receipt.groupMessageRef !== undefined) {
          request.groupMessageRef = receipt.groupMessageRef;
        }
        if (receipt.state === "unknown") {
          request.errorCode = "transport_unknown";
        }
        await this.store.writeState(state);
        return parkOk(receiptOf(request));
      });
    });
  }

  private async requireSucceededJob(
    projectId: number,
    jobId: string,
  ): Promise<StoredGenerationJob> {
    const jobs = await this.options.readers.jobs.listJobs();
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new ParkError("unmapped");
    assertJobProjectRelation(job, projectId);
    if (job.status !== "succeeded") throw new ParkError("job_not_succeeded");
    if (job.releaseClassification === "non_publishable") {
      throw new ParkError("not_publishable");
    }
    return job;
  }

  private async requireEligibleAsset(
    projectId: number,
    binding: {
      assetId: string;
      projectId: number;
      jobId: string;
      contentHash: string;
    },
  ): Promise<ProjectAsset> {
    const list = await this.options.readers.assets.listAssets(projectId);
    const asset = list.items.find(
      (candidate) =>
        candidate.id === binding.assetId &&
        candidate.projectId === projectId &&
        candidate.jobId === binding.jobId &&
        candidate.contentHash === binding.contentHash,
    );
    if (!asset || asset.status !== "ready") {
      throw new ParkError("asset_mismatch");
    }
    if (asset.releaseClassification === "non_publishable") {
      throw new ParkError("not_publishable");
    }
    return asset;
  }

  // ---------------------------------------------------------------------
  // Own request.status: read persisted request, query, never resend
  // ---------------------------------------------------------------------

  requestStatus(
    rawConnection: unknown,
    rawInput: unknown,
  ): Promise<ParkOutcome<ParkRequestStatusReceipt>> {
    return this.run(async () => {
      const context = await this.verify(rawConnection);
      const input = validateRequestStatusInput(rawInput);
      // A removed binding/capability must not observe an old receipt.
      const binding = this.resolveBinding(context, "group.publishResult");
      const key = requestKey(context.principal, context.project, input.requestId);

      return this.store.withLock(async () => {
        const state = await this.store.readState();
        const request = state.requests[key];
        if (!request) throw new ParkError("not_found");
        // A request can only be observed by its own authenticated scope.
        if (
          request.localInstance !== context.localInstance ||
          request.remoteInstance !== context.remoteInstance ||
          request.group !== context.group
        ) {
          throw new ParkError("not_found");
        }

        // Current mapping must still resolve to exactly the persisted
        // original actual object and project identity.
        const assetBinding = binding.group.assets[request.assetRef];
        if (
          binding.project.localProjectId !== request.projectId ||
          !assetBinding ||
          assetBinding.assetId !== request.assetId ||
          assetBinding.projectId !== request.projectId ||
          assetBinding.jobId !== request.jobId ||
          assetBinding.contentHash !== request.contentHash
        ) {
          throw new ParkError("unmapped");
        }
        const jobRef = this.findJobRefForJob(
          binding.group,
          request.projectId,
          request.jobId,
        );
        if (jobRef === undefined) throw new ParkError("unmapped");

        // Fresh object authorization before reading the cached receipt.
        await this.authorize(
          context,
          request.capability,
          "request",
          input.requestId,
        );
        await this.authorize(
          context,
          request.capability,
          "job",
          jobRef,
        );
        await this.authorize(
          context,
          request.capability,
          "asset",
          request.assetRef,
        );

        if (request.state === "sending") {
          // A `sending` record observed after a restart is unknown, never resent.
          request.state = "unknown";
          request.errorCode = "transport_unknown";
          request.updatedAt = nowIso();
          await this.store.writeState(state);
        }

        if (
          request.state === "accepted" ||
          request.state === "unknown"
        ) {
          const transport = this.options.transport;
          if (transport) {
            // Fresh authorization immediately before the outbound query.
            await this.authorize(
              context,
              request.capability,
              "request",
              input.requestId,
            );
            const query: ParkOutboundRequestQuery = {
              v: PARK_CONTRACT_VERSION,
              kind: "request.status",
              requestId: request.requestId,
              from: context.localInstance,
              to: context.remoteInstance,
              project: context.project,
              group: context.group,
              capability: "group.publishResult",
              version: PARK_CONTRACT_VERSION,
            };
            let reconciled: ValidatedRemoteReceipt | undefined;
            try {
              reconciled = validateRemoteReceipt(await transport.query(query));
            } catch {
              reconciled = undefined;
            }
            if (reconciled && reconciled.state !== "unknown") {
              if (isTerminal(reconciled.state) && !isTerminal(request.state)) {
                request.state = reconciled.state;
                if (
                  reconciled.state === "succeeded" &&
                  reconciled.groupMessageRef !== undefined
                ) {
                  request.groupMessageRef = reconciled.groupMessageRef;
                }
                request.updatedAt = nowIso();
                await this.store.writeState(state);
              } else if (
                reconciled.state === "accepted" &&
                request.state === "unknown"
              ) {
                request.state = "accepted";
                request.updatedAt = nowIso();
                await this.store.writeState(state);
              }
            }
          }
        }

        return parkOk(receiptOf(request));
      });
    });
  }

  // ---------------------------------------------------------------------
  // Inbound authenticated events (dedupe scoped by source)
  // ---------------------------------------------------------------------

  handleEvent(
    rawConnection: unknown,
    rawBody: unknown,
  ): Promise<ParkOutcome<ParkEventReceipt>> {
    return this.run<ParkEventReceipt>(async () => {
      const context = await this.verify(rawConnection);
      const event: ValidatedEvent = validateEvent(rawBody);
      this.assertEnvelopeIdentity(event, context);
      // Current binding/capability and current job/asset map must resolve
      // before a cached dedupe result may be returned.
      const binding = this.resolveBinding(context, event.capability);
      const mapping = this.resolveEventMappings(binding, event);

      await this.authorize(
        context,
        event.capability,
        "event",
        event.eventId,
      );
      if (mapping.jobRef !== undefined) {
        await this.authorize(
          context,
          event.capability,
          "job",
          mapping.jobRef,
        );
      }
      if (mapping.assetRef !== undefined) {
        await this.authorize(
          context,
          event.capability,
          "asset",
          mapping.assetRef,
        );
      }

      return this.store.withLock(async () => {
        const storeState = await this.store.readState();
        // Full validated content digest, including the event state. Reusing
        // an eventId with any different state or content is a conflict.
        const contentDigest = sha256Hex(canonicalJson(event));
        const key = eventKey(
          context.principal,
          context.remoteInstance,
          context.project,
          context.group,
          event.capability,
          event.eventId,
        );
        const existing = storeState.events[key];
        if (existing) {
          if (existing.identityDigest !== contentDigest) {
            throw new ParkError("event_conflict");
          }
          // Fresh mapping/object checks still apply to a cached dedupe result.
          await this.assertEventTarget(context, binding, storeState, event);
          return parkOk({
            eventId: event.eventId,
            state: existing.state,
            applied: false,
            duplicate: true,
          });
        }

        const requestKeyValue = await this.assertEventTarget(
          context,
          binding,
          storeState,
          event,
        );

        const appliedState = applyEventToOutbound(
          storeState,
          requestKeyValue,
          event,
        );
        const timestamp = nowIso();
        storeState.events[key] = {
          key,
          principal: context.principal,
          remoteInstance: context.remoteInstance,
          project: context.project,
          group: context.group,
          eventId: event.eventId,
          identityDigest: contentDigest,
          ...(requestKeyValue === undefined
            ? {}
            : { requestKey: requestKeyValue }),
          state: event.state,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.store.writeState(storeState);
        return parkOk({
          eventId: event.eventId,
          state: appliedState.state,
          applied: appliedState.applied,
          duplicate: false,
        });
      });
    });
  }

  private async assertEventTarget(
    context: TrustedConnectionContext,
    binding: ResolvedBinding,
    storeState: ParkStoreState,
    event: ValidatedEvent,
  ): Promise<string | undefined> {
    const requestKeyValue = resolveEventBinding(storeState, context, event);
    if (event.capability !== "group.publishResult") return requestKeyValue;
    if (requestKeyValue === undefined) throw new ParkError("unbound_request");
    const target = storeState.requests[requestKeyValue];
    if (!target) throw new ParkError("unbound_request");
    const jobRef = this.findJobRefForJob(
      binding.group,
      target.projectId,
      target.jobId,
    );
    if (jobRef === undefined) throw new ParkError("unmapped");
    await this.authorize(context, event.capability, "job", jobRef);
    // The target request's original pin must still match the current mapping,
    // even when the duplicate event carries no assetRef of its own.
    const targetAsset = binding.group.assets[target.assetRef];
    if (
      !targetAsset ||
      !sameAssetFingerprint(targetAsset, {
        assetId: target.assetId,
        projectId: target.projectId,
        jobId: target.jobId,
        contentHash: target.contentHash,
      })
    ) {
      throw new ParkError("unmapped");
    }
    await this.authorize(
      context,
      event.capability,
      "asset",
      target.assetRef,
    );
    if (
      event.result.assetRef !== undefined &&
      event.result.assetRef !== target.assetRef
    ) {
      throw new ParkError("event_conflict");
    }
    if (event.state === "succeeded" && event.result.assetRef === undefined) {
      throw new ParkError("event_conflict");
    }
    return requestKeyValue;
  }

  private resolveEventMappings(
    binding: ResolvedBinding,
    event: ValidatedEvent,
  ): { jobRef?: string; assetRef?: string } {
    if (event.capability === "job.status") {
      const jobRef = event.result.jobRef;
      if (jobRef === undefined) throw new ParkError("invalid_request");
      const jobBinding = this.resolveJobMapping(binding, jobRef);
      const assetRef = event.result.assetRef;
      if (assetRef !== undefined) {
        const assetBinding = this.resolveAssetMapping(binding, assetRef);
        if (
          assetBinding.jobId !== jobBinding.jobId ||
          assetBinding.projectId !== jobBinding.projectId
        ) {
          throw new ParkError("asset_mismatch");
        }
        if (
          event.result.contentHash !== undefined &&
          event.result.contentHash !== assetBinding.contentHash
        ) {
          throw new ParkError("asset_mismatch");
        }
      }
      return assetRef === undefined
        ? { jobRef }
        : { jobRef, assetRef };
    }
    const assetRef = event.result.assetRef;
    if (assetRef !== undefined) {
      this.resolveAssetMapping(binding, assetRef);
    }
    return assetRef === undefined ? {} : { assetRef };
  }
}

function resolveEventBinding(
  state: ParkStoreState,
  context: TrustedConnectionContext,
  event: ValidatedEvent,
): string | undefined {
  if (event.requestId === undefined) return undefined;
  const key = requestKey(context.principal, context.project, event.requestId);
  const outbound = state.requests[key];
  if (outbound) {
    if (
      outbound.remoteInstance !== context.remoteInstance ||
      outbound.localInstance !== context.localInstance ||
      outbound.group !== context.group ||
      outbound.capability !== event.capability
    ) {
      throw new ParkError("unbound_request");
    }
    return key;
  }
  const inbound = state.inbound[key];
  if (inbound) {
    if (
      inbound.remoteInstance !== context.remoteInstance ||
      inbound.localInstance !== context.localInstance ||
      inbound.group !== context.group ||
      inbound.capability !== event.capability
    ) {
      throw new ParkError("unbound_request");
    }
    return key;
  }
  throw new ParkError("unbound_request");
}

function applyEventToOutbound(
  state: ParkStoreState,
  key: string | undefined,
  event: ValidatedEvent,
): { applied: boolean; state: ParkEventState } {
  if (key === undefined) return { applied: true, state: event.state };
  const request = state.requests[key];
  if (!request) return { applied: false, state: event.state };
  if (isTerminal(request.state)) {
    // Terminal state is monotonic: later (new-eventId) progress cannot change it.
    return { applied: false, state: request.state as ParkEventState };
  }
  if (!isTerminal(event.state)) {
    return { applied: false, state: request.state as ParkEventState };
  }
  request.state = event.state as "succeeded" | "failed";
  request.updatedAt = nowIso();
  if (event.state === "succeeded" && event.result.groupMessageRef !== undefined) {
    request.groupMessageRef = event.result.groupMessageRef;
  }
  return { applied: true, state: event.state };
}

export async function createParkAdapter(
  options: CreateParkAdapterOptions,
): Promise<ParkCreatedAdapter> {
  validateConfig(options.config);
  const adapter = new DefaultParkAdapter(options);
  const store = new ParkDurableStore(options.storeDir);
  await store.init();
  await store.recoverSending();
  return adapter;
}

export { validateConfig } from "./contract";
