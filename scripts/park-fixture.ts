/**
 * Offline synthetic fixture for the AIstory <-> park adapter candidate.
 *
 * - uses temporary directories only
 * - uses the real, read-only store readers (listStoredGenerationJobs /
 *   listProjectAssets) against synthetic JSON files
 * - uses an injected fake authenticated transport and a fake verifier
 * - performs no network / provider / GPU / production call
 *
 * Run with:
 *   npm run fixture
 * (which sets NODE_OPTIONS=--conditions=react-server)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createParkAdapter,
  type ParkAuthorizer,
  type ParkIntegrationConfig,
  type ParkOutboundPublishCommand,
  type ParkOutboundRequestQuery,
  type ParkOutboundTransport,
  type ParkRedactedJobStatus,
  type TrustedConnectionContext,
} from "@/lib/park-integration/index";
import { createRealParkReaders } from "@/lib/park-integration/real-readers";
import type { StoredGenerationJob } from "@/lib/generation-jobs/types";
import type { ProjectAsset } from "@/lib/project-assets/types";

const PROJECT_ID = 7;
const JOB_ID = "job-1";
const ASSET_ID = "asset-1";
const HASH = "hash-1";

const job: StoredGenerationJob = {
  id: JOB_ID,
  provider: "localminidrama",
  modality: "image",
  status: "succeeded",
  progress: 100,
  requestFingerprint: "fixture-fingerprint",
  idempotencyKey: "fixture-idempotency",
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
    prompt: "SYNTHETIC-PROMPT-NEVER-STORE-OUTSIDE-TEMP",
    idempotencyKey: "fixture-idempotency",
  },
};

const asset: ProjectAsset = {
  id: ASSET_ID,
  projectId: PROJECT_ID,
  jobId: JOB_ID,
  provider: "localminidrama",
  modality: "image",
  status: "ready",
  name: "synthetic-fixture-asset",
  url: "http://127.0.0.1/synthetic-fixture-asset",
  contentHash: HASH,
  contentType: "image/png",
  bytes: 128,
  orientation: "square",
  provenance: {
    source: "aistory-generation-job",
    requestFingerprint: "fixture-fingerprint",
    generationStatus: "succeeded",
  },
  generatedAt: "2026-11-13T00:00:01.000Z",
  createdAt: "2026-11-13T00:00:02.000Z",
};

const config: ParkIntegrationConfig = {
  localInstance: "studio-dev",
  principals: {
    "fixture-park": {
      remoteInstance: "park",
      projects: {
        demo: {
          localProjectId: PROJECT_ID,
          groups: {
            "g-demo": {
              capabilities: ["job.status", "group.publishResult"],
              jobs: { "job-17": { jobId: JOB_ID, projectId: PROJECT_ID } },
              assets: {
                "asset-9": {
                  assetId: ASSET_ID,
                  projectId: PROJECT_ID,
                  jobId: JOB_ID,
                  contentHash: HASH,
                },
              },
            },
          },
        },
      },
    },
  },
};

const context: TrustedConnectionContext = {
  principal: "fixture-park",
  connectionId: "fixture-connection",
  localInstance: "studio-dev",
  remoteInstance: "park",
  project: "demo",
  group: "g-demo",
  capabilities: ["job.status", "group.publishResult"],
};

class FixtureTransport implements ParkOutboundTransport {
  sends: ParkOutboundPublishCommand[] = [];
  queries: ParkOutboundRequestQuery[] = [];
  async send(command: ParkOutboundPublishCommand): Promise<unknown> {
    this.sends.push(command);
    return { state: "succeeded", groupMessageRef: `fixture-msg-${this.sends.length}` };
  }
  async query(query: ParkOutboundRequestQuery): Promise<unknown> {
    this.queries.push(query);
    return { state: "succeeded", groupMessageRef: "fixture-msg-reconciled" };
  }
}

async function main(): Promise<void> {
  const jobsDir = await mkdtemp(path.join(os.tmpdir(), "park-fixture-jobs-"));
  const assetsDir = await mkdtemp(path.join(os.tmpdir(), "park-fixture-assets-"));
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "park-fixture-store-"));
  const disabledStore = await mkdtemp(path.join(os.tmpdir(), "park-fixture-disabled-"));

  const previousJobs = process.env.AISTORY_GENERATION_JOB_DIR;
  const previousAssets = process.env.AISTORY_PROJECT_ASSET_DIR;
  process.env.AISTORY_GENERATION_JOB_DIR = jobsDir;
  process.env.AISTORY_PROJECT_ASSET_DIR = assetsDir;

  try {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(jobsDir, "jobs.json"),
      JSON.stringify({ schemaVersion: 1, jobs: [job] }),
      "utf8",
    );
    await writeFile(
      path.join(assetsDir, "project-assets.json"),
      JSON.stringify({ schemaVersion: 1, assets: [asset] }),
      "utf8",
    );

    const transport = new FixtureTransport();
    let authorizationChecks = 0;
    const authorize: ParkAuthorizer = () => {
      authorizationChecks += 1;
      return true;
    };
    const verifier = (raw: unknown): TrustedConnectionContext | null =>
      raw === "fixture-token" ? context : null;

    const adapter = await createParkAdapter({
      config,
      storeDir,
      verifier,
      authorize,
      readers: createRealParkReaders(),
      transport,
    });

    const command = {
      v: 1,
      kind: "command",
      requestId: "fixture-req-101",
      from: "park",
      to: "studio-dev",
      project: "demo",
      group: "g-demo",
      capability: "job.status",
      version: 1,
      input: { jobRef: "job-17" },
    };
    const status = await adapter.handleCommand("fixture-token", command);
    const statusReplay = await adapter.handleCommand("fixture-token", command);

    const wrongProject = await adapter.handleCommand(
      "fixture-token",
      { ...command, requestId: "fixture-req-102", project: "other" },
    );

    const publish = await adapter.publishResult("fixture-token", {
      requestId: "fixture-req-201",
      assetRef: "asset-9",
      title: "fixture sample done",
    });
    const publishReplay = await adapter.publishResult("fixture-token", {
      requestId: "fixture-req-201",
      assetRef: "asset-9",
      title: "fixture sample done",
    });
    const requestStatus = await adapter.requestStatus("fixture-token", {
      requestId: "fixture-req-201",
    });

    const event = await adapter.handleEvent("fixture-token", {
      v: 1,
      kind: "event",
      eventId: "fixture-evt-201",
      requestId: "fixture-req-201",
      from: "park",
      to: "studio-dev",
      project: "demo",
      group: "g-demo",
      capability: "group.publishResult",
      version: 1,
      state: "succeeded",
      result: { groupMessageRef: "fixture-msg-201", assetRef: "asset-9" },
    });

    const foreignContextToken = "fixture-foreign-token";
    const foreignContext: TrustedConnectionContext = {
      ...context,
      principal: "other-park",
      connectionId: "fixture-connection-foreign",
    };
    const foreignAdapter = await createParkAdapter({
      config: {
        ...config,
        principals: {
          ...config.principals,
          "other-park": config.principals["fixture-park"]!,
        },
      },
      storeDir,
      verifier: (raw) => {
        if (raw === "fixture-token") return context;
        if (raw === foreignContextToken) return foreignContext;
        return null;
      },
      authorize,
      readers: createRealParkReaders(),
      transport,
    });
    const foreignRequest = await foreignAdapter.requestStatus(
      foreignContextToken,
      { requestId: "fixture-req-201" },
    );

    const disabledAdapter = await createParkAdapter({
      config,
      storeDir: disabledStore,
      verifier,
      authorize,
      readers: createRealParkReaders(),
    });
    const disabledPublish = await disabledAdapter.publishResult(
      "fixture-token",
      { requestId: "fixture-req-301", assetRef: "asset-9", title: "disabled" },
    );

    const evidence = {
      mode: "offline-synthetic-fixture",
      injectedFakeTransport: true,
      realIntegration: false,
      claimsLiveTransport: false,
      network: false,
      evidence: {
        jobStatus: status,
        jobStatusReplay: statusReplay,
        wrongProject,
        publish,
        publishReplay,
        requestStatus,
        event,
        foreignRequest,
        disabledPublish,
      },
      counts: {
        outboundSends: transport.sends.length,
        outboundQueries: transport.queries.length,
        eventsApplied: event.ok && event.result.applied ? 1 : 0,
        authorizationChecks,
        disabledTransportSends: 0,
        generationCalls: 0,
        schedulerCalls: 0,
        retryCalls: 0,
        adoptCalls: 0,
      },
      safeDto: (status.ok ? status.result : undefined) as
        | ParkRedactedJobStatus
        | undefined,
    };
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (previousJobs === undefined) delete process.env.AISTORY_GENERATION_JOB_DIR;
    else process.env.AISTORY_GENERATION_JOB_DIR = previousJobs;
    if (previousAssets === undefined) delete process.env.AISTORY_PROJECT_ASSET_DIR;
    else process.env.AISTORY_PROJECT_ASSET_DIR = previousAssets;
    await rm(jobsDir, { recursive: true, force: true });
    await rm(assetsDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
    await rm(disabledStore, { recursive: true, force: true });
  }
}

await main();
