import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createParkAdapter,
  emptyParkStoreState,
  parkLockPath,
  parkStatePath,
  requestKey,
} from "@/lib/park-integration/index";
import type {
  ParkAssetBinding,
  ParkAuthorizer,
  ParkCapability,
  ParkEventReceipt,
  ParkIntegrationConfig,
  ParkOutcome,
  ParkOutboundPublishCommand,
  ParkOutboundRequestQuery,
  ParkOutboundTransport,
  ParkProjectBinding,
  ParkPublishReceipt,
  ParkReaders,
  ParkRedactedJobStatus,
  ParkRequestStatusReceipt,
  ParkTransportVerifier,
  PersistedRequest,
  TrustedConnectionContext,
} from "@/lib/park-integration/index";
import type { StoredGenerationJob } from "@/lib/generation-jobs/types";
import type { ProjectAsset } from "@/lib/project-assets/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 7;
const JOB_ID = "job-1";
const ASSET_ID = "asset-1";
const HASH = "hash-1";

function makeJob(): StoredGenerationJob {
  return {
    id: JOB_ID,
    provider: "localminidrama",
    modality: "image",
    status: "succeeded",
    progress: 100,
    requestFingerprint: "fp-1",
    idempotencyKey: "idem-1",
    attempts: 1,
    maxAttempts: 1,
    retryable: false,
    provenance: {
      purpose: "foreground",
      source: "aistory-studio",
      provider: "localminidrama",
    },
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:01.000Z",
    input: {
      dramaId: PROJECT_ID,
      prompt: "SECRET-PROMPT",
      idempotencyKey: "idem-1",
    },
  };
}

function makeAsset(): ProjectAsset {
  return {
    id: ASSET_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    provider: "localminidrama",
    modality: "image",
    status: "ready",
    name: "SECRET-NAME",
    url: "http://127.0.0.1/SECRET-URL",
    contentHash: HASH,
    contentType: "image/png",
    bytes: 123,
    orientation: "square",
    provenance: {
      source: "aistory-generation-job",
      requestFingerprint: "fp-1",
      generationStatus: "succeeded",
    },
    generatedAt: "2026-11-13T00:00:01.000Z",
    createdAt: "2026-11-13T00:00:02.000Z",
  };
}

function makeConfig(): ParkIntegrationConfig {
  const group = {
    capabilities: ["job.status", "group.publishResult"] as ParkCapability[],
    jobs: { "job-17": { jobId: JOB_ID, projectId: PROJECT_ID } },
    assets: {
      "asset-9": {
        assetId: ASSET_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        contentHash: HASH,
      } satisfies ParkAssetBinding,
    },
  };
  return {
    localInstance: "studio-dev",
    principals: {
      "park-alpha": {
        remoteInstance: "park",
        projects: {
          demo: {
            localProjectId: PROJECT_ID,
            groups: { "g-demo": group },
          },
        },
      },
      "park-beta": {
        remoteInstance: "park",
        projects: {
          demo: {
            localProjectId: PROJECT_ID,
            groups: { "g-demo": group },
          },
        },
      },
    },
  };
}

type MutableGroup = {
  capabilities: ParkCapability[];
  jobs: Record<string, { jobId: string; projectId: number }>;
  assets: Record<string, ParkAssetBinding>;
};

function mutableGroup(config: ParkIntegrationConfig): MutableGroup {
  const principal = config.principals["park-alpha"];
  const project = principal?.projects.demo;
  const group = project?.groups["g-demo"];
  if (!group) throw new Error("test config is missing the alpha group");
  return group as unknown as MutableGroup;
}

function cloneConfig(): ParkIntegrationConfig {
  return structuredClone(makeConfig());
}

function makeContexts(): Record<string, TrustedConnectionContext> {  const base = {
    localInstance: "studio-dev",
    remoteInstance: "park",
    project: "demo",
    group: "g-demo",
    capabilities: ["job.status", "group.publishResult"] as ParkCapability[],
  };
  return {
    "token-alpha": {
      ...base,
      principal: "park-alpha",
      connectionId: "conn-alpha",
    },
    "token-beta": {
      ...base,
      principal: "park-beta",
      connectionId: "conn-beta",
    },
  };
}

function makeVerifier(): (rawConnection: unknown) => TrustedConnectionContext | null {
  const contexts = makeContexts();
  return (rawConnection) => {
    if (typeof rawConnection !== "string") return null;
    return contexts[rawConnection] ?? null;
  };
}

type ReaderState = {
  jobs: StoredGenerationJob[];
  byProject: Record<number, ProjectAsset[]>;
  jobReads: number;
  assetReads: number;
};

function readerState(
  mutate?: (state: ReaderState) => void,
): ReaderState {
  const state: ReaderState = {
    jobs: [makeJob()],
    byProject: { [PROJECT_ID]: [makeAsset()] },
    jobReads: 0,
    assetReads: 0,
  };
  mutate?.(state);
  return state;
}

function makeReaders(state: ReaderState): ParkReaders {
  return {
    jobs: {
      async listJobs() {
        state.jobReads += 1;
        return structuredClone(state.jobs);
      },
    },
    assets: {
      async listAssets(projectId: number) {
        state.assetReads += 1;
        const items = structuredClone(state.byProject[projectId] ?? []);
        return { projectId, total: items.length, items };
      },
    },
  };
}

type Acl = {
  revoked?: boolean;
  calls?: number;
  allowCalls?: number;
};

function makeAuthorizer(acl: Acl = {}): ParkAuthorizer {
  return () => {
    acl.calls = (acl.calls ?? 0) + 1;
    if (acl.revoked) return false;
    if (acl.allowCalls !== undefined && (acl.calls ?? 0) > acl.allowCalls) {
      return false;
    }
    return true;
  };
}

class FakeTransport implements ParkOutboundTransport {
  sends: ParkOutboundPublishCommand[] = [];
  queries: ParkOutboundRequestQuery[] = [];
  sendResults: unknown[] = [];
  queryResults: unknown[] = [];
  sendDelayMs = 0;

  async send(command: ParkOutboundPublishCommand): Promise<unknown> {
    this.sends.push(structuredClone(command));
    if (this.sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    }
    const next = this.sendResults.length
      ? this.sendResults.shift()
      : { state: "succeeded", groupMessageRef: `msg-${this.sends.length}` };
    if (next instanceof Error) throw next;
    return next;
  }

  async query(query: ParkOutboundRequestQuery): Promise<unknown> {
    this.queries.push(structuredClone(query));
    const next = this.queryResults.length
      ? this.queryResults.shift()
      : { state: "unknown" };
    if (next instanceof Error) throw next;
    return next;
  }
}

type SetupOptions = {
  config?: ParkIntegrationConfig;
  readers?: ParkReaders;
  transport?: FakeTransport;
  acl?: Acl;
  storeDir?: string;
  authorize?: ParkAuthorizer;
  verifier?: ParkTransportVerifier;
};

async function setup(t: TestContext, options: SetupOptions = {}) {
  const ownsDir = options.storeDir === undefined;
  const dir =
    options.storeDir ??
    (await mkdtemp(path.join(os.tmpdir(), "park-adapter-")));
  if (ownsDir) {
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
  }
  const transport = "transport" in options ? options.transport : new FakeTransport();
  const acl = options.acl ?? {};
  const readers = options.readers ?? makeReaders(readerState());
  const adapter = await createParkAdapter({
    config: options.config ?? makeConfig(),
    storeDir: dir,
    verifier: options.verifier ?? makeVerifier(),
    authorize: options.authorize ?? makeAuthorizer(acl),
    readers,
    ...(transport === undefined ? {} : { transport }),
  });
  return {
    adapter,
    transport: transport as FakeTransport | undefined,
    dir,
    acl,
    readers,
  };
}

// ---------------------------------------------------------------------------
// Wire builders
// ---------------------------------------------------------------------------

function jobStatusCommand(
  overrides: Record<string, unknown> = {},
  inputOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    kind: "command",
    requestId: "req-101",
    from: "park",
    to: "studio-dev",
    project: "demo",
    group: "g-demo",
    capability: "job.status",
    version: 1,
    input: { jobRef: "job-17", ...inputOverrides },
    ...overrides,
  };
}

function publishCommand(
  overrides: Record<string, unknown> = {},
  inputOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    kind: "command",
    requestId: "req-201",
    from: "park",
    to: "studio-dev",
    project: "demo",
    group: "g-demo",
    capability: "group.publishResult",
    version: 1,
    input: { assetRef: "asset-9", title: "sample done", ...inputOverrides },
    ...overrides,
  };
}

function publishInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: "req-201", assetRef: "asset-9", title: "sample done", ...overrides };
}

function groupEvent(
  overrides: Record<string, unknown> = {},
  resultOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    kind: "event",
    eventId: "evt-201",
    requestId: "req-201",
    from: "park",
    to: "studio-dev",
    project: "demo",
    group: "g-demo",
    capability: "group.publishResult",
    version: 1,
    state: "succeeded",
    result: { groupMessageRef: "msg-38", assetRef: "asset-9", ...resultOverrides },
    ...overrides,
  };
}

function expectOk<T>(outcome: ParkOutcome<T>): T {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.result;
}

function expectFail(
  outcome: ParkOutcome<unknown>,
  code: string,
): void {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  if (!outcome.ok) assert.equal(outcome.error.code, code);
}

// ---------------------------------------------------------------------------
// Inbound job.status
// ---------------------------------------------------------------------------

test("job.status returns a redacted mapped status with an eligible asset", async (t) => {
  const { adapter } = await setup(t);
  const outcome = await adapter.handleCommand("token-alpha", jobStatusCommand());
  const result = expectOk(outcome) as ParkRedactedJobStatus;
  assert.deepEqual(result, {
    jobRef: "job-17",
    status: "succeeded",
    assetRef: "asset-9",
    contentHash: HASH,
  });
  const serialized = JSON.stringify(outcome);
  for (const secret of [
    "SECRET-PROMPT",
    "SECRET-NAME",
    "SECRET-URL",
    "providerTaskId",
    "idempotencyKey",
    "workflow",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("job.status replay re-reads current state instead of serving a stale receipt", async (t) => {
  const state = readerState();
  const readers = makeReaders(state);
  const { adapter } = await setup(t, { readers });
  expectOk(await adapter.handleCommand("token-alpha", jobStatusCommand()));
  const afterFirst = state.jobReads;
  assert.ok(afterFirst >= 1);

  // The cached response must resolve the CURRENT job/asset state.
  state.jobs[0] = { ...(state.jobs[0] as StoredGenerationJob), status: "running" };
  const replay = await adapter.handleCommand("token-alpha", jobStatusCommand());
  assert.equal(replay.ok && replay.duplicate, true);
  assert.equal(expectOk(replay).status, "running");
  assert.equal(expectOk(replay).assetRef, undefined);
  assert.ok(state.jobReads > afterFirst);
});

test("job.status rejects wrong project, group, instance and direction", async (t) => {
  const { adapter } = await setup(t);
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ project: "other" })),
    "forbidden",
  );
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ group: "g-other" })),
    "forbidden",
  );
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ from: "park-other" })),
    "forbidden",
  );
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ to: "other-instance" })),
    "forbidden",
  );
  expectFail(
    await adapter.handleCommand(
      "token-alpha",
      publishCommand({ capability: "group.publishResult" }),
    ),
    "unsupported_operation",
  );
  expectFail(await adapter.handleCommand("token-unknown", jobStatusCommand()), "unauthenticated");
});

test("job.status rejects unknown fields, bad versions and capabilities", async (t) => {
  const { adapter } = await setup(t);
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ extra: true })),
    "unknown_field",
  );
  expectFail(
    await adapter.handleCommand(
      "token-alpha",
      jobStatusCommand({}, { extra: true }),
    ),
    "unknown_field",
  );
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ v: 2 })),
    "unsupported_version",
  );
  expectFail(
    await adapter.handleCommand(
      "token-alpha",
      jobStatusCommand({ capability: "job.delete" }),
    ),
    "unsupported_capability",
  );
  expectFail(
    await adapter.handleCommand("token-alpha", jobStatusCommand({ requestId: "../escape" })),
    "invalid_request",
  );
});

test("job.status is unmapped for missing jobs and mismatched project relations", async (t) => {
  const missing = await setup(t, {
    readers: makeReaders(readerState((state) => { state.jobs = []; })),
  });
  expectFail(
    await missing.adapter.handleCommand("token-alpha", jobStatusCommand()),
    "unmapped",
  );

  const wrongDrama = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.jobs[0] = {
          ...(state.jobs[0] as Extract<StoredGenerationJob, { provider: "localminidrama" }>),
          input: {
            dramaId: 999,
            prompt: "SECRET-PROMPT",
            idempotencyKey: "idem-1",
          },
        };
      }),
    ),
  });
  expectFail(
    await wrongDrama.adapter.handleCommand("token-alpha", jobStatusCommand()),
    "unmapped",
  );

  const unmappedRef = await setup(t);
  expectFail(
    await unmappedRef.adapter.handleCommand(
      "token-alpha",
      jobStatusCommand({}, { jobRef: "job-unknown" }),
    ),
    "unmapped",
  );
});

// ---------------------------------------------------------------------------
// Outbound group.publishResult
// ---------------------------------------------------------------------------

test("publishResult sends once, caches a receipt and rejects conflicting content", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);

  const first = expectOk(await adapter.publishResult("token-alpha", publishInput())) as ParkPublishReceipt;
  assert.equal(first.state, "succeeded");
  assert.equal(first.assetRef, "asset-9");
  assert.equal(first.groupMessageRef, "msg-1");
  assert.equal(transport.sends.length, 1);

  const replay = await adapter.publishResult("token-alpha", publishInput());
  assert.equal(replay.ok, true);
  assert.equal(replay.ok && replay.duplicate, true);
  assert.equal(expectOk(replay).state, "succeeded");
  assert.equal(transport.sends.length, 1);

  const conflict = await adapter.publishResult(
    "token-alpha",
    publishInput({ title: "different title" }),
  );
  expectFail(conflict, "conflict");
  assert.equal(transport.sends.length, 1);
});

test("publishResult rejects mapped asset mismatch, failed jobs and non-publishable objects", async (t) => {
  // Asset content hash does not match the configured binding.
  const mismatch = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.byProject[PROJECT_ID] = [{ ...makeAsset(), contentHash: "hash-other" }];
      }),
    ),
  });
  expectFail(
    await mismatch.adapter.publishResult("token-alpha", publishInput()),
    "asset_mismatch",
  );
  assert.equal(mismatch.transport?.sends.length, 0);

  // Asset belongs to a different job.
  const wrongJob = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.byProject[PROJECT_ID] = [{ ...makeAsset(), jobId: "job-other" }];
      }),
    ),
  });
  expectFail(
    await wrongJob.adapter.publishResult("token-alpha", publishInput()),
    "asset_mismatch",
  );
  assert.equal(wrongJob.transport?.sends.length, 0);

  // Job did not succeed.
  const notSucceeded = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.jobs[0] = { ...state.jobs[0]!, status: "running" } as StoredGenerationJob;
      }),
    ),
  });
  expectFail(
    await notSucceeded.adapter.publishResult("token-alpha", publishInput()),
    "job_not_succeeded",
  );
  assert.equal(notSucceeded.transport?.sends.length, 0);

  // Job is non-publishable.
  const labJob = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.jobs[0] = {
          ...state.jobs[0]!,
          releaseClassification: "non_publishable",
        } as StoredGenerationJob;
      }),
    ),
  });
  expectFail(
    await labJob.adapter.publishResult("token-alpha", publishInput()),
    "not_publishable",
  );
  assert.equal(labJob.transport?.sends.length, 0);

  // Asset is non-publishable.
  const labAsset = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.byProject[PROJECT_ID] = [
          { ...makeAsset(), releaseClassification: "non_publishable" },
        ];
      }),
    ),
  });
  expectFail(
    await labAsset.adapter.publishResult("token-alpha", publishInput()),
    "not_publishable",
  );
  assert.equal(labAsset.transport?.sends.length, 0);

  // Explicit assetRef must be mapped.
  const unmapped = await setup(t);
  expectFail(
    await unmapped.adapter.publishResult(
      "token-alpha",
      publishInput({ assetRef: "asset-unknown" }),
    ),
    "unmapped",
  );
  assert.equal(unmapped.transport?.sends.length, 0);
});

test("publishResult rejects unknown fields, bad versions and unbounded titles", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  expectFail(
    await adapter.publishResult("token-alpha", { ...publishInput(), extra: true }),
    "unknown_field",
  );
  assert.equal(transport.sends.length, 0);
  expectFail(
    await adapter.publishResult("token-alpha", {
      ...publishInput(),
      title: "x".repeat(161),
    }),
    "invalid_request",
  );
  assert.equal(transport.sends.length, 0);
  expectFail(
    await adapter.publishResult("token-alpha", {
      ...publishInput(),
      requestId: "bad/id",
    }),
    "invalid_request",
  );
  assert.equal(transport.sends.length, 0);
});

test("publishResult is disabled when no outbound transport is injected", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "park-disabled-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const { adapter } = await setup(t, { transport: undefined, storeDir: dir });
  assert.equal(adapter.enabled, false);
  expectFail(
    await adapter.publishResult("token-alpha", publishInput()),
    "disabled",
  );
  await assert.rejects(readFile(parkStatePath(dir), "utf8"));
});

// ---------------------------------------------------------------------------
// Fresh authorization
// ---------------------------------------------------------------------------

test("revoked ACL blocks cached reads and blocks dispatch", async (t) => {
  // Revoked before replaying a cached inbound job.status result.
  const inbound = await setup(t);
  expectOk(await inbound.adapter.handleCommand("token-alpha", jobStatusCommand()));
  inbound.acl.revoked = true;
  expectFail(
    await inbound.adapter.handleCommand("token-alpha", jobStatusCommand()),
    "forbidden",
  );

  // Revoked before replaying a cached outbound receipt.
  const cached = await setup(t);
  expectOk(await cached.adapter.publishResult("token-alpha", publishInput()));
  cached.acl.revoked = true;
  expectFail(
    await cached.adapter.publishResult("token-alpha", publishInput()),
    "forbidden",
  );
  assert.equal(cached.transport?.sends.length, 1);

  // Revoked after acceptance but immediately before dispatch: zero sends.
  const acl: Acl = { allowCalls: 1 };
  const preDispatch = await setup(t, { acl });
  expectFail(
    await preDispatch.adapter.publishResult("token-alpha", publishInput()),
    "forbidden",
  );
  assert.equal(preDispatch.transport?.sends.length, 0);
});

test("cached inbound status re-resolves mappings and never leaks removed/remapped assets", async (t) => {
  const first = await setup(t);
  const dir = first.dir;
  expectOk(await first.adapter.handleCommand("token-alpha", jobStatusCommand()));

  // Asset map removed: the cached assetRef must not be disclosed.
  const removedConfig = cloneConfig();
  delete mutableGroup(removedConfig).assets["asset-9"];
  const removed = await setup(t, { storeDir: dir, config: removedConfig });
  const removedReplay = expectOk(
    await removed.adapter.handleCommand("token-alpha", jobStatusCommand()),
  ) as ParkRedactedJobStatus;
  assert.equal(removedReplay.assetRef, undefined);
  assert.equal(removedReplay.contentHash, undefined);

  // Same assetRef remapped to a different actual object: still no leak.
  const remapConfig = cloneConfig();
  mutableGroup(remapConfig).assets["asset-9"] = {
    assetId: "asset-2",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    contentHash: HASH,
  };
  const remapReaders = makeReaders(
    readerState((state) => {
      state.byProject[PROJECT_ID] = [{ ...makeAsset(), id: "asset-2" }];
    }),
  );
  const remapped = await setup(t, {
    storeDir: dir,
    config: remapConfig,
    readers: remapReaders,
  });
  const remapReplay = expectOk(
    await remapped.adapter.handleCommand("token-alpha", jobStatusCommand()),
  ) as ParkRedactedJobStatus;
  assert.equal(remapReplay.assetRef, undefined);

  // Same jobRef remapped to a different actual job: fail closed.
  const jobRemapConfig = cloneConfig();
  mutableGroup(jobRemapConfig).jobs["job-17"] = {
    jobId: "job-2",
    projectId: PROJECT_ID,
  };
  const jobReaders = makeReaders(
    readerState((state) => {
      state.jobs = [{ ...makeJob(), id: "job-2" } as StoredGenerationJob];
    }),
  );
  const jobRemapped = await setup(t, {
    storeDir: dir,
    config: jobRemapConfig,
    readers: jobReaders,
  });
  expectFail(
    await jobRemapped.adapter.handleCommand("token-alpha", jobStatusCommand()),
    "unmapped",
  );

  // Capability removed from the configured binding: cached read is forbidden.
  const noCapConfig = cloneConfig();
  mutableGroup(noCapConfig).capabilities = [];
  const noCap = await setup(t, { storeDir: dir, config: noCapConfig });
  expectFail(
    await noCap.adapter.handleCommand("token-alpha", jobStatusCommand()),
    "forbidden",
  );
});

test("cached publish receipt fails closed when the asset mapping is removed or remapped", async (t) => {
  const first = await setup(t);
  const dir = first.dir;
  const transport = first.transport;
  assert.ok(transport);
  expectOk(await first.adapter.publishResult("token-alpha", publishInput()));
  assert.equal(transport.sends.length, 1);

  const removedConfig = cloneConfig();
  delete mutableGroup(removedConfig).assets["asset-9"];
  const removed = await setup(t, {
    storeDir: dir,
    config: removedConfig,
    transport,
  });
  expectFail(
    await removed.adapter.publishResult("token-alpha", publishInput()),
    "unmapped",
  );
  assert.equal(transport.sends.length, 1);

  const remapConfig = cloneConfig();
  mutableGroup(remapConfig).assets["asset-9"] = {
    assetId: "asset-2",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    contentHash: HASH,
  };
  const remapReaders = makeReaders(
    readerState((state) => {
      state.byProject[PROJECT_ID] = [{ ...makeAsset(), id: "asset-2" }];
    }),
  );
  const remapped = await setup(t, {
    storeDir: dir,
    config: remapConfig,
    readers: remapReaders,
    transport,
  });
  expectFail(
    await remapped.adapter.publishResult("token-alpha", publishInput()),
    "unmapped",
  );
  assert.equal(transport.sends.length, 1);
});

test("queued cached publish re-checks ACL after the lock wait", async (t) => {
  const { adapter, transport, acl } = await setup(t);
  assert.ok(transport);
  transport.sendDelayMs = 60;

  const first = adapter.publishResult("token-alpha", publishInput());
  while (transport.sends.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // The first call holds the lock inside the transport. Queue an identical
  // call: its pre-lock authorization still succeeds.
  const callsBeforeQueue = acl.calls ?? 0;
  const queued = adapter.publishResult("token-alpha", publishInput());
  while ((acl.calls ?? 0) < callsBeforeQueue + 2) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // Revoke the ACL while the queued call is waiting for the lock.
  acl.revoked = true;

  const [firstOutcome, queuedOutcome] = await Promise.all([first, queued]);
  expectOk(firstOutcome);
  expectFail(queuedOutcome, "forbidden");
  assert.equal(transport.sends.length, 1);
});

test("request.status re-resolves current binding, mapping and object ACL", async (t) => {
  const first = await setup(t);
  const dir = first.dir;
  expectOk(await first.adapter.publishResult("token-alpha", publishInput()));

  const noCapConfig = cloneConfig();
  mutableGroup(noCapConfig).capabilities = ["job.status"];
  const noCap = await setup(t, { storeDir: dir, config: noCapConfig });
  expectFail(
    await noCap.adapter.requestStatus("token-alpha", { requestId: "req-201" }),
    "forbidden",
  );

  const removedConfig = cloneConfig();
  delete mutableGroup(removedConfig).assets["asset-9"];
  const removed = await setup(t, { storeDir: dir, config: removedConfig });
  expectFail(
    await removed.adapter.requestStatus("token-alpha", { requestId: "req-201" }),
    "unmapped",
  );

  const remapConfig = cloneConfig();
  mutableGroup(remapConfig).assets["asset-9"] = {
    assetId: "asset-2",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    contentHash: HASH,
  };
  const remapped = await setup(t, { storeDir: dir, config: remapConfig });
  expectFail(
    await remapped.adapter.requestStatus("token-alpha", { requestId: "req-201" }),
    "unmapped",
  );

  const denied = await setup(t, {
    storeDir: dir,
    authorize: (request) => request.object.kind !== "asset",
  });
  expectFail(
    await denied.adapter.requestStatus("token-alpha", { requestId: "req-201" }),
    "forbidden",
  );
});

test("request.status rejects a drifted project mapping", async (t) => {
  const first = await setup(t);
  const dir = first.dir;
  expectOk(await first.adapter.publishResult("token-alpha", publishInput()));

  const driftedConfig = cloneConfig();
  const project = driftedConfig.principals["park-alpha"]?.projects.demo;
  if (!project) throw new Error("test config is missing the demo project");
  project.localProjectId = PROJECT_ID + 1;

  const drifted = await setup(t, { storeDir: dir, config: driftedConfig });
  expectFail(
    await drifted.adapter.requestStatus("token-alpha", { requestId: "req-201" }),
    "unmapped",
  );
});

test("readJobStatus withholds assetRef for non-publishable objects and denied asset ACL", async (t) => {
  const labJob = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.jobs[0] = {
          ...state.jobs[0]!,
          releaseClassification: "non_publishable",
        } as StoredGenerationJob;
      }),
    ),
  });
  const jobStatus = expectOk(
    await labJob.adapter.handleCommand("token-alpha", jobStatusCommand()),
  ) as ParkRedactedJobStatus;
  assert.equal(jobStatus.assetRef, undefined);

  const labAsset = await setup(t, {
    readers: makeReaders(
      readerState((state) => {
        state.byProject[PROJECT_ID] = [
          { ...makeAsset(), releaseClassification: "non_publishable" },
        ];
      }),
    ),
  });
  const assetStatus = expectOk(
    await labAsset.adapter.handleCommand("token-alpha", jobStatusCommand()),
  ) as ParkRedactedJobStatus;
  assert.equal(assetStatus.assetRef, undefined);

  const denied = await setup(t, {
    authorize: (request) => request.object.kind !== "asset",
  });
  expectFail(
    await denied.adapter.handleCommand("token-alpha", jobStatusCommand()),
    "forbidden",
  );
});

test("events require exact success identity, full content state and fresh maps", async (t) => {
  const first = await setup(t);
  const dir = first.dir;
  const transport = first.transport;
  assert.ok(transport);
  transport.sendResults = [{ state: "accepted" }];
  expectOk(await first.adapter.publishResult("token-alpha", publishInput()));

  // A success event must carry a group message reference.
  expectFail(
    await first.adapter.handleEvent(
      "token-alpha",
      groupEvent({}, { groupMessageRef: undefined }),
    ),
    "invalid_request",
  );
  // A non-success event must not carry a group message reference.
  expectFail(
    await first.adapter.handleEvent(
      "token-alpha",
      groupEvent({ state: "accepted" }),
    ),
    "invalid_request",
  );

  // A mapped but different assetRef than the original request is rejected.
  const otherAssetConfig = cloneConfig();
  mutableGroup(otherAssetConfig).assets["asset-10"] = {
    assetId: ASSET_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    contentHash: HASH,
  };
  const otherAsset = await setup(t, {
    storeDir: dir,
    config: otherAssetConfig,
    transport,
  });
  expectFail(
    await otherAsset.adapter.handleEvent(
      "token-alpha",
      groupEvent({}, { assetRef: "asset-10" }),
    ),
    "event_conflict",
  );

  const applied = expectOk(
    await first.adapter.handleEvent("token-alpha", groupEvent()),
  ) as ParkEventReceipt;
  assert.equal(applied.applied, true);

  // Same eventId with a different fully-validated state is a conflict.
  expectFail(
    await first.adapter.handleEvent(
      "token-alpha",
      groupEvent({ state: "failed" }, { groupMessageRef: undefined }),
    ),
    "event_conflict",
  );

  // Removing the referenced asset map makes the cached event fail closed.
  const removedConfig = cloneConfig();
  delete mutableGroup(removedConfig).assets["asset-9"];
  const removed = await setup(t, {
    storeDir: dir,
    config: removedConfig,
    transport,
  });
  expectFail(
    await removed.adapter.handleEvent("token-alpha", groupEvent()),
    "unmapped",
  );
});

test("duplicate event rejects when the target pin drifts", async (t) => {
  const config = cloneConfig();
  const { adapter, transport } = await setup(t, { config });
  assert.ok(transport);
  transport.sendResults = [{ state: "accepted" }];
  expectOk(await adapter.publishResult("token-alpha", publishInput()));

  // A failed event may omit assetRef, so only the target request pin can
  // detect drift on a later duplicate.
  const event = groupEvent(
    { state: "failed" },
    { groupMessageRef: undefined, assetRef: undefined },
  );
  const applied = expectOk(
    await adapter.handleEvent("token-alpha", event),
  ) as ParkEventReceipt;
  assert.equal(applied.applied, true);

  mutableGroup(config).assets["asset-9"] = {
    assetId: "asset-2",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    contentHash: HASH,
  };
  expectFail(await adapter.handleEvent("token-alpha", event), "unmapped");
});

test("transport query failure stays unknown with zero new sends", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  transport.sendResults = [{ state: "unknown" }];
  const sent = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(sent.state, "unknown");
  assert.equal(transport.sends.length, 1);

  transport.queryResults = [new Error("query exploded")];
  const status = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  ) as ParkRequestStatusReceipt;
  assert.equal(status.state, "unknown");
  assert.equal(transport.queries.length, 1);
  assert.equal(transport.sends.length, 1);
});

test("malformed transport success without a group message ref never becomes success", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  transport.sendResults = [{ state: "succeeded" }];
  const receipt = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(receipt.state, "unknown");
  assert.equal(receipt.groupMessageRef, undefined);
  assert.equal(transport.sends.length, 1);
});

test("cross-principal identical request ids remain isolated", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  const alpha = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(alpha.groupMessageRef, "msg-1");
  expectFail(
    await adapter.requestStatus("token-beta", { requestId: "req-201" }),
    "not_found",
  );
  const beta = expectOk(
    await adapter.publishResult("token-beta", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(beta.groupMessageRef, "msg-2");
  assert.equal(transport.sends.length, 2);
  const alphaStatus = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  ) as ParkRequestStatusReceipt;
  assert.equal(alphaStatus.groupMessageRef, "msg-1");
});

test("cross-project identical request ids remain isolated", async (t) => {
  const config = cloneConfig();
  const alphaPrincipal = config.principals["park-alpha"];
  if (!alphaPrincipal) throw new Error("missing alpha principal");
  const demo = alphaPrincipal.projects.demo;
  if (!demo) throw new Error("missing demo project");
  const projects = alphaPrincipal.projects as Record<string, ParkProjectBinding>;
  projects["demo2"] = structuredClone(demo);

  const base = {
    localInstance: "studio-dev",
    remoteInstance: "park",
    group: "g-demo",
    capabilities: ["job.status", "group.publishResult"] as ParkCapability[],
  };
  const verifier: ParkTransportVerifier = (raw) => {
    if (raw === "token-alpha") {
      return {
        ...base,
        principal: "park-alpha",
        connectionId: "conn-alpha",
        project: "demo",
      };
    }
    if (raw === "token-alpha-demo2") {
      return {
        ...base,
        principal: "park-alpha",
        connectionId: "conn-alpha-demo2",
        project: "demo2",
      };
    }
    return null;
  };

  const { adapter, transport } = await setup(t, { config, verifier });
  assert.ok(transport);
  const alpha = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(alpha.groupMessageRef, "msg-1");
  expectFail(
    await adapter.requestStatus("token-alpha-demo2", { requestId: "req-201" }),
    "not_found",
  );
  const otherProject = expectOk(
    await adapter.publishResult("token-alpha-demo2", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(otherProject.groupMessageRef, "msg-2");
  assert.equal(transport.sends.length, 2);
});

// ---------------------------------------------------------------------------
// Restart / unknown / reconcile / request.status
// ---------------------------------------------------------------------------

async function writeSendingState(dir: string): Promise<void> {
  const state = emptyParkStoreState();
  const key = requestKey("park-alpha", "demo", "req-201");
  const timestamp = "2026-11-13T00:00:03.000Z";
  const request: PersistedRequest = {
    key,
    principal: "park-alpha",
    localInstance: "studio-dev",
    remoteInstance: "park",
    project: "demo",
    group: "g-demo",
    capability: "group.publishResult",
    version: 1,
    requestId: "req-201",
    digest: "digest-that-may-not-match",
    state: "sending",
    assetRef: "asset-9",
    assetId: ASSET_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    contentHash: HASH,
    title: "sample done",
    createdAt: timestamp,
    updatedAt: timestamp,
    sendAttempts: 1,
  };
  state.requests[key] = request;
  await mkdir(dir, { recursive: true });
  await writeFile(parkStatePath(dir), JSON.stringify(state), "utf8");
}

test("restart treats persisted sending as unknown and never resends", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "park-restart-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeSendingState(dir);

  const transport = new FakeTransport();
  transport.queryResults = [{ state: "succeeded", groupMessageRef: "msg-99" }];
  const adapter = await createParkAdapter({
    config: makeConfig(),
    storeDir: dir,
    verifier: makeVerifier(),
    authorize: makeAuthorizer(),
    readers: makeReaders(readerState()),
    transport,
  });

  const recovered = JSON.parse(await readFile(parkStatePath(dir), "utf8")) as {
    requests: Record<string, { state: string }>;
  };
  assert.equal(
    recovered.requests[requestKey("park-alpha", "demo", "req-201")]?.state,
    "unknown",
  );

  const receipt = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  ) as ParkRequestStatusReceipt;
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.groupMessageRef, "msg-99");
  assert.equal(transport.sends.length, 0);
  assert.equal(transport.queries.length, 1);

  // Already terminal: cached read, no further query and no resend.
  const again = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  );
  assert.equal(again.state, "succeeded");
  assert.equal(transport.queries.length, 1);
  assert.equal(transport.sends.length, 0);
});

test("response loss returns unknown then reconciles the original request result", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  transport.sendResults = [{ state: "unknown" }];

  const first = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  ) as ParkPublishReceipt;
  assert.equal(first.state, "unknown");
  assert.equal(transport.sends.length, 1);

  transport.queryResults = [{ state: "succeeded", groupMessageRef: "msg-77" }];
  const reconciled = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  ) as ParkRequestStatusReceipt;
  assert.equal(reconciled.state, "succeeded");
  assert.equal(reconciled.groupMessageRef, "msg-77");
  assert.equal(transport.sends.length, 1);
  assert.equal(transport.queries.length, 1);

  const cached = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  );
  assert.equal(cached.state, "succeeded");
  assert.equal(transport.queries.length, 1);
  assert.equal(transport.sends.length, 1);
});

test("request.status only observes its own authenticated request", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  expectOk(await adapter.publishResult("token-alpha", publishInput()));

  expectFail(
    await adapter.requestStatus("token-beta", { requestId: "req-201" }),
    "not_found",
  );
  expectFail(
    await adapter.requestStatus("token-alpha", { requestId: "req-other" }),
    "not_found",
  );
  expectFail(
    await adapter.requestStatus("token-alpha", { requestId: "../escape" }),
    "invalid_request",
  );
  expectFail(
    await adapter.requestStatus("token-unknown", { requestId: "req-201" }),
    "unauthenticated",
  );
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test("events apply terminal state, dedupe, reject conflicts and ignore late progress", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  transport.sendResults = [{ state: "accepted" }];
  expectOk(await adapter.publishResult("token-alpha", publishInput()));

  const applied = expectOk(await adapter.handleEvent("token-alpha", groupEvent())) as ParkEventReceipt;
  assert.deepEqual(applied, {
    eventId: "evt-201",
    state: "succeeded",
    applied: true,
    duplicate: false,
  });

  const duplicate = expectOk(
    await adapter.handleEvent("token-alpha", groupEvent()),
  ) as ParkEventReceipt;
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.duplicate, true);

  // Later progress uses a NEW eventId and cannot overwrite the terminal state.
  const late = expectOk(
    await adapter.handleEvent(
      "token-alpha",
      groupEvent(
        { eventId: "evt-202", state: "accepted" },
        { groupMessageRef: undefined },
      ),
    ),
  ) as ParkEventReceipt;
  assert.equal(late.applied, false);
  assert.equal(late.state, "succeeded");

  // Reusing the same eventId with a different state is a hard conflict.
  expectFail(
    await adapter.handleEvent(
      "token-alpha",
      groupEvent({ state: "failed" }, { groupMessageRef: undefined }),
    ),
    "event_conflict",
  );

  const conflict = await adapter.handleEvent(
    "token-alpha",
    groupEvent({}, { groupMessageRef: "msg-other" }),
  );
  expectFail(conflict, "event_conflict");

  // The bound outbound request is now terminal and reconciled from the event.
  const status = expectOk(
    await adapter.requestStatus("token-alpha", { requestId: "req-201" }),
  ) as ParkRequestStatusReceipt;
  assert.equal(status.state, "succeeded");
  assert.equal(status.groupMessageRef, "msg-38");
  assert.equal(transport.queries.length, 0);
  assert.equal(transport.sends.length, 1);
});

test("events reject wrong scope, malformed fields and unbound requests", async (t) => {
  const { adapter } = await setup(t);
  expectFail(
    await adapter.handleEvent("token-alpha", groupEvent({ group: "g-other" })),
    "forbidden",
  );
  expectFail(
    await adapter.handleEvent("token-alpha", groupEvent({ from: "park-other" })),
    "forbidden",
  );
  expectFail(
    await adapter.handleEvent("token-alpha", groupEvent({ eventId: "bad/id" })),
    "invalid_request",
  );
  expectFail(
    await adapter.handleEvent("token-alpha", groupEvent({ state: "publishing" })),
    "invalid_request",
  );
  expectFail(
    await adapter.handleEvent(
      "token-alpha",
      groupEvent({}, { groupMessageRef: "msg-1", extra: "x" }),
    ),
    "unknown_field",
  );
  expectFail(
    await adapter.handleEvent(
      "token-alpha",
      groupEvent({ requestId: "req-unbound" }),
    ),
    "unbound_request",
  );
  expectFail(
    await adapter.handleEvent("token-unknown", groupEvent()),
    "unauthenticated",
  );
});

// ---------------------------------------------------------------------------
// Concurrency and lock behavior
// ---------------------------------------------------------------------------

test("concurrent identical publish calls produce exactly one send", async (t) => {
  const { adapter, transport } = await setup(t);
  assert.ok(transport);
  transport.sendDelayMs = 20;
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () =>
      adapter.publishResult("token-alpha", publishInput()),
    ),
  );
  for (const outcome of outcomes) {
    assert.equal(expectOk(outcome).state, "succeeded");
  }
  assert.equal(transport.sends.length, 1);
});

test("a pre-existing lock file fails closed and is never stolen", async (t) => {
  const { adapter, transport, dir } = await setup(t);
  assert.ok(transport);
  const lockPath = parkLockPath(dir);
  await writeFile(lockPath, JSON.stringify({ pid: 999999, nonce: "stale" }), "utf8");
  expectFail(
    await adapter.publishResult("token-alpha", publishInput()),
    "lock_busy",
  );
  assert.equal(transport.sends.length, 0);
  assert.equal(typeof (await readFile(lockPath, "utf8")), "string");
  await unlink(lockPath);
  const afterManualUnlock = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  );
  assert.equal(afterManualUnlock.state, "succeeded");
  assert.equal(transport.sends.length, 1);
});

// ---------------------------------------------------------------------------
// Real reader wiring (readonly store snapshots) and zero scheduler usage
// ---------------------------------------------------------------------------

test("real store readers are injected and remain read-only", async (t) => {
  const jobsDir = await mkdtemp(path.join(os.tmpdir(), "park-real-jobs-"));
  const assetsDir = await mkdtemp(path.join(os.tmpdir(), "park-real-assets-"));
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "park-real-store-"));
  const previousJobs = process.env.AISTORY_GENERATION_JOB_DIR;
  const previousAssets = process.env.AISTORY_PROJECT_ASSET_DIR;
  process.env.AISTORY_GENERATION_JOB_DIR = jobsDir;
  process.env.AISTORY_PROJECT_ASSET_DIR = assetsDir;
  t.after(async () => {
    if (previousJobs === undefined) delete process.env.AISTORY_GENERATION_JOB_DIR;
    else process.env.AISTORY_GENERATION_JOB_DIR = previousJobs;
    if (previousAssets === undefined) delete process.env.AISTORY_PROJECT_ASSET_DIR;
    else process.env.AISTORY_PROJECT_ASSET_DIR = previousAssets;
    await rm(jobsDir, { recursive: true, force: true });
    await rm(assetsDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(jobsDir, "jobs.json"),
    JSON.stringify({ schemaVersion: 1, jobs: [makeJob()] }),
    "utf8",
  );
  await writeFile(
    path.join(assetsDir, "project-assets.json"),
    JSON.stringify({ schemaVersion: 1, assets: [makeAsset()] }),
    "utf8",
  );

  const { createRealParkReaders } = await import(
    "@/lib/park-integration/real-readers"
  );
  const transport = new FakeTransport();
  const adapter = await createParkAdapter({
    config: makeConfig(),
    storeDir,
    verifier: makeVerifier(),
    authorize: makeAuthorizer(),
    readers: createRealParkReaders(),
    transport,
  });

  const status = expectOk(
    await adapter.handleCommand("token-alpha", jobStatusCommand()),
  ) as ParkRedactedJobStatus;
  assert.deepEqual(status, {
    jobRef: "job-17",
    status: "succeeded",
    assetRef: "asset-9",
    contentHash: HASH,
  });
  const published = expectOk(
    await adapter.publishResult("token-alpha", publishInput()),
  );
  assert.equal(published.state, "succeeded");
  assert.equal(transport.sends.length, 1);
});

test("adapter source has zero scheduler/mutation imports or calls", async () => {
  // Scope the scan to the exact integration surface: the lib directory
  // recursively, plus the exact fixture. Scanning all of scripts/ or tests/
  // would pick up unrelated files, and this test source itself is excluded
  // because it contains the forbidden strings and internal imports by design.
  const libRoot = path.join(process.cwd(), "lib", "park-integration");
  const files: string[] = [];
  for (const entry of await readdir(libRoot, { recursive: true })) {
    const full = path.join(libRoot, entry);
    if (!full.endsWith(".ts")) continue;
    files.push(full);
  }
  files.push(path.join(process.cwd(), "scripts", "park-fixture.ts"));
  assert.ok(files.length > 0);
  const forbidden = [
    /@\/lib\/generation-jobs\/server/,
    /@\/lib\/project-assets\/server/,
    /@\/lib\/localminidrama\/server/,
    /@\/lib\/generation-jobs\/scheduler/,
    /saveStoredGenerationJob\s*\(/,
    /updateStoredGenerationJob\s*\(/,
    /recoverStoredGenerationJobs\s*\(/,
    /saveProjectAssetIfAbsent\s*\(/,
    /getStoredGenerationJob\s*\(/,
    /getProjectAsset\s*\(/,
    /adopt\w*\s*\(/i,
    /kick\s*\(/,
  ];
  const allowedLibImports = new Set([
    "@/lib/generation-jobs/types",
    "@/lib/project-assets/types",
    "@/lib/providers/comfyui/types",
    "@/lib/generation-jobs/store",
    "@/lib/project-assets/repository",
    "@/lib/park-integration/index",
    "@/lib/park-integration/real-readers",
  ]);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(text),
        false,
        `${path.relative(process.cwd(), file)} matched ${pattern}`,
      );
    }
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith("@/lib/")) {
        assert.equal(
          allowedLibImports.has(specifier),
          true,
          `${path.relative(process.cwd(), file)} imports ${specifier}`,
        );
      }
    }
  }
});
