/**
 * Studio online projects: validation, ownership, gate, HTTP boundary and static
 * migration/route contract coverage.
 *
 * This is a pure/offline script. It injects an in-memory store and a fake RPC
 * client, so it never opens a network connection, never reads a credential, and
 * never applies the migration.
 *
 * Run from the repository root:
 *   cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/test-studio-online-projects.ts
 *
 * The script uses relative module specifiers so the same file can also be
 * compiled to CommonJS and executed offline where a bundler subprocess is not
 * permitted.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  StudioProjectsRepository,
  readStudioProjectsConfig,
  requireStudioProjectsConfig,
  type StudioProjectsConfig,
  type StudioProjectsRpcClient,
  type StudioProjectsRpcResult,
  type StudioProjectsStore,
} from "../lib/creator-studio/online/repository";
import {
  assertStudioSameOriginMutation,
  deriveStudioOwnerKey,
  handleStudioCreateProject,
  handleStudioGetOwnProject,
  handleStudioGetPublicProject,
  handleStudioListProjects,
  handleStudioPublishProject,
  handleStudioReviseProject,
  handleStudioSetVisibility,
  StudioProjectsService,
} from "../lib/creator-studio/online/service";
import {
  STUDIO_LIMITS,
  decodeStudioCursor,
  encodeStudioCursor,
  validateCreateProjectInput,
  validateDraftStructure,
  validatePublishProjectInput,
  validatePublishedStructure,
  validateReviseProjectInput,
  validateSetVisibilityInput,
} from "../lib/creator-studio/online/validation";
import {
  STUDIO_PROJECTS_GATE_VERSION,
  STUDIO_PROJECTS_MODE,
  StudioProjectsError,
  type StudioDraftV1,
  type StudioOwnerRecord,
  type StudioProjectVisibility,
  type StudioPublicRecord,
  type StudioPublishedSnapshotV1,
} from "../lib/creator-studio/online/types";

const ROOT = process.cwd();
const MIGRATION_PATH = path.join(
  ROOT,
  "supabase/migrations/20261115090000_studio_online_projects.sql",
);
const MODULE_DIR = path.join(ROOT, "lib/creator-studio/online");
const OWNER_ROUTES = [
  path.join(ROOT, "app/api/studio/projects/route.ts"),
  path.join(ROOT, "app/api/studio/projects/[id]/route.ts"),
];
const PUBLIC_ROUTE = path.join(ROOT, "app/api/studio/public/[id]/route.ts");

const ORIGIN = "https://studio.test";
const READ_URL = `${ORIGIN}/api/studio/public/${randomUUID()}`;

const fixtureDraft = (overrides: Partial<StudioDraftV1> = {}): StudioDraftV1 => ({
  v: 1,
  title: "第一幕：雨夜",
  synopsis: "主角在雨夜接到一通陌生电话。",
  authoringNotes: "PRIVATE-DRAFT-MARKER 不要把这段发布出去",
  scenes: [
    { id: "s1", heading: "街角", body: "雨落在霓虹灯上。" },
    { id: "s2", heading: "公寓", body: "她握紧了手机。" },
  ],
  ...overrides,
});

const fixturePublished = (
  overrides: Partial<StudioPublishedSnapshotV1> = {},
): StudioPublishedSnapshotV1 => ({
  v: 1,
  title: "第一幕：雨夜",
  synopsis: "主角在雨夜接到一通陌生电话。",
  scenes: [
    { id: "s1", heading: "街角", body: "雨落在霓虹灯上。" },
    { id: "s2", heading: "公寓", body: "她握紧了手机。" },
  ],
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

let failures = 0;
const started = Date.now();
const passed: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed.push(name);
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL  ${name}\n`);
    process.stdout.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
  }
}

async function expectsStudioError(
  fn: () => Promise<unknown>,
  expected: { code: string; status: number },
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(
      error instanceof StudioProjectsError,
      `expected StudioProjectsError, received ${String(error)}`,
    );
    assert.equal(error.code, expected.code);
    assert.equal(error.status, expected.status);
    return;
  }
  assert.fail(`expected ${expected.code} (${expected.status}) but the call resolved`);
}

function expectsStudioErrorSync(
  fn: () => unknown,
  expected: { code: string; status: number },
): void {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof StudioProjectsError,
      `expected StudioProjectsError, received ${String(error)}`,
    );
    assert.equal(error.code, expected.code);
    assert.equal(error.status, expected.status);
    return;
  }
  assert.fail(`expected ${expected.code} (${expected.status}) but the call resolved`);
}

/* ------------------------------------------------------------------ *
 * in-memory durable store with the same owner/revision contract
 * ------------------------------------------------------------------ */

type MemoryRow = {
  ownerKey: string;
  id: string;
  revision: number;
  draft: StudioDraftV1;
  visibility: StudioProjectVisibility;
  snapshot: StudioPublishedSnapshotV1 | null;
  publishedRevision: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

let clock = Date.parse("2026-11-15T00:00:00.000Z");
function nextTimestamp(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

class MemoryStore implements StudioProjectsStore {
  readonly source = "memory" as const;
  readonly rows = new Map<string, MemoryRow>();
  readyCalls = 0;

  async assertReady(): Promise<void> {
    this.readyCalls += 1;
  }

  private owned(ownerKey: string, id: string): MemoryRow {
    const row = this.rows.get(id);
    if (!row || row.ownerKey !== ownerKey) {
      throw new StudioProjectsError("not_found", 404, "Studio project not found.");
    }
    return row;
  }

  private static toRecord(row: MemoryRow): StudioOwnerRecord {
    return {
      id: row.id,
      revision: row.revision,
      draft: row.draft,
      visibility: row.visibility,
      published: row.snapshot !== null,
      publishedRevision: row.publishedRevision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
    };
  }

  async create(ownerKey: string, draft: StudioDraftV1): Promise<StudioOwnerRecord> {
    const count = [...this.rows.values()].filter((row) => row.ownerKey === ownerKey).length;
    if (count >= STUDIO_LIMITS.maxProjectsPerOwner) {
      throw new StudioProjectsError("limit_reached", 409, "limit reached");
    }
    const timestamp = nextTimestamp();
    const row: MemoryRow = {
      ownerKey,
      id: randomUUID(),
      revision: 1,
      draft,
      visibility: "hidden",
      snapshot: null,
      publishedRevision: null,
      publishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.rows.set(row.id, row);
    return MemoryStore.toRecord(row);
  }

  async revise(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    draft: StudioDraftV1,
  ): Promise<StudioOwnerRecord> {
    const row = this.owned(ownerKey, id);
    if (row.revision !== expectedRevision) {
      throw new StudioProjectsError("revision_conflict", 409, "conflict");
    }
    row.draft = draft;
    row.revision += 1;
    row.updatedAt = nextTimestamp();
    return MemoryStore.toRecord(row);
  }

  async publish(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    published: StudioPublishedSnapshotV1,
    visibility: StudioProjectVisibility,
  ): Promise<StudioOwnerRecord> {
    const row = this.owned(ownerKey, id);
    if (row.revision !== expectedRevision) {
      throw new StudioProjectsError("revision_conflict", 409, "conflict");
    }
    row.revision += 1;
    row.snapshot = published;
    row.publishedRevision = row.revision;
    row.publishedAt = nextTimestamp();
    row.visibility = visibility;
    row.updatedAt = row.publishedAt;
    return MemoryStore.toRecord(row);
  }

  async setVisibility(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    visibility: StudioProjectVisibility,
  ): Promise<StudioOwnerRecord> {
    const row = this.owned(ownerKey, id);
    if (row.revision !== expectedRevision) {
      throw new StudioProjectsError("revision_conflict", 409, "conflict");
    }
    if (!row.snapshot) {
      throw new StudioProjectsError("not_published", 409, "not published");
    }
    row.visibility = visibility;
    row.revision += 1;
    row.updatedAt = nextTimestamp();
    return MemoryStore.toRecord(row);
  }

  async getOwner(ownerKey: string, id: string): Promise<StudioOwnerRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.ownerKey !== ownerKey) return null;
    return MemoryStore.toRecord(row);
  }

  async listOwner(
    ownerKey: string,
    offset: number,
    limit: number,
  ): Promise<{ records: StudioOwnerRecord[]; hasMore: boolean }> {
    const owned = [...this.rows.values()]
      .filter((row) => row.ownerKey === ownerKey)
      .sort((a, b) => {
        const created = b.createdAt.localeCompare(a.createdAt);
        return created !== 0 ? created : a.id.localeCompare(b.id);
      });
    const page = owned.slice(offset, offset + limit);
    return {
      records: page.map(MemoryStore.toRecord),
      hasMore: offset + page.length < owned.length,
    };
  }

  async getPublic(id: string): Promise<StudioPublicRecord | null> {
    const row = this.rows.get(id);
    if (!row || !row.snapshot || row.visibility !== "public") return null;
    return {
      id: row.id,
      revision: row.publishedRevision ?? row.revision,
      publishedAt: row.publishedAt ?? row.createdAt,
      title: row.snapshot.title,
      ...(row.snapshot.synopsis === undefined ? {} : { synopsis: row.snapshot.synopsis }),
      scenes: row.snapshot.scenes,
    };
  }
}

/* ------------------------------------------------------------------ *
 * request helpers
 * ------------------------------------------------------------------ */

type MutationInit = {
  origin?: string | null;
  host?: string;
  contentType?: string;
  method?: string;
  contentLength?: string;
  fetchSite?: string;
};

function jsonMutation(
  url: string,
  body: unknown,
  init: MutationInit = {},
): Request {
  const headers = new Headers();
  headers.set("host", init.host ?? "studio.test");
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  headers.set("content-type", init.contentType ?? "application/json");
  if (init.contentLength !== undefined) headers.set("content-length", init.contentLength);
  if (init.fetchSite !== undefined) headers.set("sec-fetch-site", init.fetchSite);
  return new Request(url, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function rawMutation(
  url: string,
  raw: string,
  init: MutationInit = {},
): Request {
  const headers = new Headers();
  headers.set("host", init.host ?? "studio.test");
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  headers.set("content-type", init.contentType ?? "application/json");
  if (init.fetchSite !== undefined) headers.set("sec-fetch-site", init.fetchSite);
  return new Request(url, { method: init.method ?? "POST", headers, body: raw });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const PHONE_OWNER = { userId: "3f1c1f0e-9d5e-4c22-9b0a-2c4c6f1b0a11", authType: "phone" };
const OTHER_OWNER = {
  userId: "f".repeat(64),
  authType: "aiuser",
};

async function createProject(
  store: StudioProjectsStore,
  owner: { userId: string; authType: string } = PHONE_OWNER,
  draft: StudioDraftV1 = fixtureDraft(),
): Promise<Record<string, unknown>> {
  const response = await handleStudioCreateProject(
    jsonMutation(`${ORIGIN}/api/studio/projects`, { draft }),
    owner,
    store,
  );
  assert.equal(response.status, 201);
  return responseJson(response);
}

/* ------------------------------------------------------------------ *
 * fake RPC client for the gate
 * ------------------------------------------------------------------ */

class FakeGateRpc {
  gateVersion: unknown = STUDIO_PROJECTS_GATE_VERSION;
  posture: unknown = true;
  failOn: string | null = null;
  readonly calls: string[] = [];
  readonly client: StudioProjectsRpcClient = {
    rpc: async (name: string): Promise<StudioProjectsRpcResult> => {
      this.calls.push(name);
      if (this.failOn === name) return { data: null, error: { message: "boom" } };
      if (name === "aistory_studio_projects_gate_status") {
        return { data: this.gateVersion, error: null };
      }
      if (name === "aistory_studio_project_security_posture_claims_v1") {
        return { data: this.posture, error: null };
      }
      return { data: null, error: null };
    },
  };
}

const VALID_CONFIG: StudioProjectsConfig = {
  mode: STUDIO_PROJECTS_MODE,
  gateVersion: STUDIO_PROJECTS_GATE_VERSION,
  supabaseUrl: "https://supabase.test",
  serviceRoleKey: "service-role-fixture",
};

function gatedRepository(
  rpc: FakeGateRpc,
  config: StudioProjectsConfig = VALID_CONFIG,
): StudioProjectsRepository {
  return new StudioProjectsRepository({ client: rpc.client, config });
}

/* ------------------------------------------------------------------ *
 * 1. validation
 * ------------------------------------------------------------------ */

async function validationSuite(): Promise<void> {
  await test("validation: canonical draft keeps only allowlisted fields", () => {
    const draft = validateDraftStructure(fixtureDraft());
    assert.deepEqual(Object.keys(draft).sort(), [
      "authoringNotes",
      "scenes",
      "synopsis",
      "title",
      "v",
    ]);
    assert.equal(draft.scenes.length, 2);
  });

  await test("validation: unknown draft field is rejected", () => {
    expectsStudioErrorSync(
      () => validateDraftStructure({ ...fixtureDraft(), ownerKey: "leak" }),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: unknown scene field is rejected", () => {
    expectsStudioErrorSync(
      () =>
        validateDraftStructure(
          fixtureDraft({ scenes: [{ id: "s1", heading: "h", body: "b", url: "x" } as never] }),
        ),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: duplicate scene ids are rejected", () => {
    expectsStudioErrorSync(
      () =>
        validateDraftStructure({
          v: 1,
          title: "t",
          scenes: [
            { id: "dup", heading: "h", body: "b" },
            { id: "dup", heading: "h2", body: "b2" },
          ],
        }),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: scene count is bounded", () => {
    const scenes = Array.from({ length: STUDIO_LIMITS.maxScenes + 1 }, (_, index) => ({
      id: `s${index}`,
      heading: "h",
      body: "b",
    }));
    expectsStudioErrorSync(() => validateDraftStructure({ v: 1, title: "t", scenes }), {
      code: "invalid_request",
      status: 400,
    });
  });

  await test("validation: control characters and markup are rejected", () => {
    expectsStudioErrorSync(
      () => validateDraftStructure(fixtureDraft({ title: "bad\u0000title" })),
      { code: "invalid_request", status: 400 },
    );
    expectsStudioErrorSync(
      () => validateDraftStructure(fixtureDraft({ title: "<script>alert(1)</script>" })),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: title bounds and empty text are rejected", () => {
    expectsStudioErrorSync(() => validateDraftStructure(fixtureDraft({ title: "" })), {
      code: "invalid_request",
      status: 400,
    });
    expectsStudioErrorSync(
      () => validateDraftStructure(fixtureDraft({ title: "x".repeat(201) })),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: published snapshot rejects authoring-only fields", () => {
    expectsStudioErrorSync(
      () =>
        validatePublishedStructure({
          ...fixturePublished(),
          authoringNotes: "PRIVATE-DRAFT-MARKER",
        }),
      { code: "invalid_request", status: 400 },
    );
    const snapshot = validatePublishedStructure(fixturePublished());
    assert.equal("authoringNotes" in snapshot, false);
  });

  await test("validation: request envelopes are strict", () => {
    expectsStudioErrorSync(
      () => validateCreateProjectInput({ draft: fixtureDraft(), visibility: "public" }),
      { code: "invalid_request", status: 400 },
    );
    expectsStudioErrorSync(
      () =>
        validateReviseProjectInput({
          expectedRevision: 1,
          draft: fixtureDraft(),
          ownerKey: "leak",
        }),
      { code: "invalid_request", status: 400 },
    );
    expectsStudioErrorSync(
      () =>
        validatePublishProjectInput({
          expectedRevision: 1,
          published: fixturePublished(),
          ownerId: "leak",
        }),
      { code: "invalid_request", status: 400 },
    );
    expectsStudioErrorSync(
      () => validateSetVisibilityInput({ expectedRevision: 1, visibility: "world" }),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: expectedRevision bounds are enforced", () => {
    for (const value of [0, -1, 1.5, STUDIO_LIMITS.maxExpectedRevision + 1]) {
      expectsStudioErrorSync(
        () => validateReviseProjectInput({ expectedRevision: value, draft: fixtureDraft() }),
        { code: "invalid_request", status: 400 },
      );
    }
    expectsStudioErrorSync(
      () => validateReviseProjectInput({ draft: fixtureDraft() }),
      { code: "invalid_request", status: 400 },
    );
  });

  await test("validation: publish defaults visibility to public only when omitted", () => {
    const omitted = validatePublishProjectInput({
      expectedRevision: 1,
      published: fixturePublished(),
    });
    assert.equal(omitted.visibility, "public");
    const explicit = validatePublishProjectInput({
      expectedRevision: 1,
      visibility: "hidden",
      published: fixturePublished(),
    });
    assert.equal(explicit.visibility, "hidden");
  });

  await test("validation: list cursor round-trips and rejects tampering", () => {
    assert.equal(decodeStudioCursor(encodeStudioCursor(0)), 0);
    assert.equal(decodeStudioCursor(encodeStudioCursor(37)), 37);
    const cursor = encodeStudioCursor(20);
    for (const tampered of [cursor.slice(0, -2), "not-a-cursor", "", `${cursor}.1`]) {
      expectsStudioErrorSync(() => decodeStudioCursor(tampered), {
        code: "invalid_request",
        status: 400,
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 2. ownership derivation
 * ------------------------------------------------------------------ */

async function ownershipSuite(): Promise<void> {
  await test("ownership: key is stable, namespaced and opaque", () => {
    const first = deriveStudioOwnerKey(PHONE_OWNER);
    const again = deriveStudioOwnerKey({ ...PHONE_OWNER });
    assert.equal(first, again);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, PHONE_OWNER.userId);

    const asAiUser = deriveStudioOwnerKey({ ...PHONE_OWNER, authType: "aiuser" });
    assert.notEqual(first, asAiUser, "auth type must be part of the owner namespace");
    const asPassport = deriveStudioOwnerKey({ ...PHONE_OWNER, authType: "passport_v4" });
    assert.notEqual(first, asPassport, "Passport must not alias a legacy owner");
    assert.notEqual(asAiUser, asPassport, "Passport must not alias an AIUser owner");
  });

  await test("ownership: anonymous and unknown identities are unauthorized", () => {
    for (const owner of [
      { userId: "anonymous", authType: "anonymous" },
      { userId: "", authType: "phone" },
      { userId: PHONE_OWNER.userId, authType: "guest" },
      { userId: "x".repeat(513), authType: "phone" },
    ]) {
      expectsStudioErrorSync(() => deriveStudioOwnerKey(owner), {
        code: "unauthorized",
        status: 401,
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 3. selector + independent gate
 * ------------------------------------------------------------------ */

async function gateSuite(): Promise<void> {
  await test("gate: exact default-off selector", () => {
    assert.deepEqual(readStudioProjectsConfig({}), {
      ok: false,
      reason: "disabled",
      missing: ["feature_selector"],
    });
    assert.equal(
      readStudioProjectsConfig({ AISTORY_STUDIO_PROJECTS_MODE: "supabase" }).ok,
      false,
    );
    expectsStudioErrorSync(() => requireStudioProjectsConfig({}), {
      code: "disabled",
      status: 503,
    });
  });

  await test("gate: selector alone is not enough", () => {
    const status = readStudioProjectsConfig({
      AISTORY_STUDIO_PROJECTS_MODE: STUDIO_PROJECTS_MODE,
    });
    assert.equal(status.ok, false);
    if (status.ok) return;
    assert.equal(status.reason, "unavailable");
    for (const missing of [
      "supabase_url",
      "service_role",
      "studio_projects_gate_version",
    ]) {
      assert.ok(status.missing.includes(missing), `expected missing ${missing}`);
    }
  });

  await test("gate: exact configuration resolves", () => {
    const status = readStudioProjectsConfig({
      AISTORY_STUDIO_PROJECTS_MODE: STUDIO_PROJECTS_MODE,
      AISTORY_STUDIO_PROJECTS_GATE_VERSION: STUDIO_PROJECTS_GATE_VERSION,
      AISTORY_SUPABASE_SERVER_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-fixture",
    });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.config.gateVersion, STUDIO_PROJECTS_GATE_VERSION);
  });

  await test("gate: database version and posture are both required", async () => {
    const rpc = new FakeGateRpc();
    await gatedRepository(rpc).assertReady();
    assert.deepEqual(rpc.calls, [
      "aistory_studio_projects_gate_status",
      "aistory_studio_project_security_posture_claims_v1",
    ]);
  });

  await test("gate: version mismatch fails closed with 503", async () => {
    const rpc = new FakeGateRpc();
    rpc.gateVersion = "20260101000000";
    await expectsStudioError(() => gatedRepository(rpc).assertReady(), {
      code: "unavailable",
      status: 503,
    });
  });

  await test("gate: posture failure fails closed with 503", async () => {
    const rpc = new FakeGateRpc();
    rpc.posture = false;
    await expectsStudioError(() => gatedRepository(rpc).assertReady(), {
      code: "unavailable",
      status: 503,
    });
  });

  await test("gate: RPC transport error fails closed with 503", async () => {
    const rpc = new FakeGateRpc();
    rpc.failOn = "aistory_studio_project_security_posture_claims_v1";
    await expectsStudioError(() => gatedRepository(rpc).assertReady(), {
      code: "unavailable",
      status: 503,
    });
  });

  await test("gate: a stale repository pin cannot be used", async () => {
    const rpc = new FakeGateRpc();
    const repository = gatedRepository(rpc, {
      ...VALID_CONFIG,
      gateVersion: "20260101000000",
    });
    await expectsStudioError(() => repository.assertReady(), {
      code: "unavailable",
      status: 503,
    });
  });

  await test("gate: posture is checked again after an earlier successful read", async () => {
    const rpc = new FakeGateRpc();
    const repository = gatedRepository(rpc);
    await repository.assertReady();
    assert.deepEqual(rpc.calls, [
      "aistory_studio_projects_gate_status",
      "aistory_studio_project_security_posture_claims_v1",
    ]);
    rpc.posture = false;
    await expectsStudioError(() => repository.listOwner("a".repeat(64), 0, 20), {
      code: "unavailable", status: 503,
    });
    assert.deepEqual(rpc.calls, [
      "aistory_studio_projects_gate_status",
      "aistory_studio_project_security_posture_claims_v1",
      "aistory_studio_projects_gate_status",
      "aistory_studio_project_security_posture_claims_v1",
    ]);
  });

  await test("gate: operations never run before the gate passes", async () => {
    const rpc = new FakeGateRpc();
    rpc.posture = false;
    await expectsStudioError(() => gatedRepository(rpc).create("a".repeat(64), fixtureDraft()), {
      code: "unavailable",
      status: 503,
    });
    assert.deepEqual(rpc.calls, [
      "aistory_studio_projects_gate_status",
      "aistory_studio_project_security_posture_claims_v1",
    ]);
  });
}

/* ------------------------------------------------------------------ *
 * 4. repository shape strictness
 * ------------------------------------------------------------------ */

async function repositorySuite(): Promise<void> {
  await test("repository: unknown public id never reaches the RPC layer", async () => {
    const rpc = new FakeGateRpc();
    const repository = gatedRepository(rpc);
    assert.equal(await repository.getPublic("not-a-uuid"), null);
    assert.deepEqual(rpc.calls, []);
  });

  await test("repository: public projection shape is strictly parsed", async () => {
    const gateRpc = new FakeGateRpc();
    const base: Record<string, unknown> = {
      id: randomUUID(),
      revision: 3,
      published_at: "2026-11-15T00:00:00.000Z",
      title: "公开标题",
      synopsis: null,
      scenes: [{ id: "s1", heading: "h", body: "b" }],
    };
    const withPublic = (payload: unknown): StudioProjectsRpcClient => ({
      rpc: async (name: string): Promise<StudioProjectsRpcResult> => {
        if (name === "aistory_studio_project_get_public") return { data: payload, error: null };
        return gateRpc.client.rpc(name);
      },
    });
    const good = new StudioProjectsRepository({
      client: withPublic(base),
      config: VALID_CONFIG,
    });
    const project = await good.getPublic(base.id as string);
    assert.ok(project);
    assert.equal(project.title, "公开标题");
    assert.equal("synopsis" in project, false);

    const leaky = new StudioProjectsRepository({
      client: withPublic({ ...base, owner_key: "a".repeat(64) }),
      config: VALID_CONFIG,
    });
    await expectsStudioError(() => leaky.getPublic(base.id as string), {
      code: "unavailable",
      status: 503,
    });
  });

  await test("repository: invalid page bounds are rejected", async () => {
    const repository = gatedRepository(new FakeGateRpc());
    await expectsStudioError(() => repository.listOwner("a".repeat(64), 0, 51), {
      code: "invalid_request",
      status: 400,
    });
    await expectsStudioError(() => repository.listOwner("a".repeat(64), -1, 10), {
      code: "invalid_request",
      status: 400,
    });
  });

  await test("repository: an invalid owner key never queries the database", async () => {
    const rpc = new FakeGateRpc();
    const repository = gatedRepository(rpc);
    await expectsStudioError(() => repository.getOwner("owner", randomUUID()), {
      code: "unauthorized",
      status: 401,
    });
    assert.deepEqual(rpc.calls, []);
  });
}

/* ------------------------------------------------------------------ *
 * 5. domain + HTTP boundary
 * ------------------------------------------------------------------ */

async function domainSuite(): Promise<void> {
  await test("domain: create returns the private draft and no owner key", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const serialized = JSON.stringify(payload);
    assert.match(String(payload.id), /^[0-9a-f-]{36}$/);
    assert.equal(payload.revision, 1);
    assert.equal(payload.published, false);
    assert.equal(payload.visibility, "hidden");
    assert.equal(serialized.includes("ownerKey"), false);
    assert.equal(serialized.includes("owner_key"), false);
    assert.equal(serialized.includes(deriveStudioOwnerKey(PHONE_OWNER)), false);
  });

  await test("domain: anonymous callers get 401 on every owner route", async () => {
    const store = new MemoryStore();
    const anonymous = { userId: "anonymous", authType: "anonymous" };
    const responses = [
      await handleStudioCreateProject(
        jsonMutation(`${ORIGIN}/api/studio/projects`, { draft: fixtureDraft() }),
        anonymous,
        store,
      ),
      await handleStudioListProjects(
        new Request(`${ORIGIN}/api/studio/projects`),
        anonymous,
        store,
      ),
      await handleStudioGetOwnProject(
        new Request(`${ORIGIN}/api/studio/projects/${randomUUID()}`),
        randomUUID(),
        anonymous,
        store,
      ),
      await handleStudioReviseProject(
        jsonMutation(`${ORIGIN}/api/studio/projects/${randomUUID()}`, {
          expectedRevision: 1,
          draft: fixtureDraft(),
        }),
        randomUUID(),
        anonymous,
        store,
      ),
      await handleStudioPublishProject(
        jsonMutation(`${ORIGIN}/api/studio/projects/${randomUUID()}`, {
          expectedRevision: 1,
          published: fixturePublished(),
        }),
        randomUUID(),
        anonymous,
        store,
      ),
      await handleStudioSetVisibility(
        jsonMutation(`${ORIGIN}/api/studio/projects/${randomUUID()}`, {
          expectedRevision: 1,
          visibility: "hidden",
        }),
        randomUUID(),
        anonymous,
        store,
      ),
    ];
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.equal((await responseJson(response)).code, "unauthorized");
    }
    assert.equal(store.rows.size, 0);
  });

  await test("domain: cross-site and origin-less mutations are rejected", async () => {
    const store = new MemoryStore();
    const noOrigin = await handleStudioCreateProject(
      jsonMutation(`${ORIGIN}/api/studio/projects`, { draft: fixtureDraft() }, { origin: null }),
      PHONE_OWNER,
      store,
    );
    assert.equal(noOrigin.status, 400);
    assert.equal((await responseJson(noOrigin)).code, "csrf_rejected");

    const crossSite = await handleStudioCreateProject(
      jsonMutation(
        `${ORIGIN}/api/studio/projects`,
        { draft: fixtureDraft() },
        { origin: "https://evil.test" },
      ),
      PHONE_OWNER,
      store,
    );
    assert.equal(crossSite.status, 400);

    const secFetch = await handleStudioCreateProject(
      jsonMutation(
        `${ORIGIN}/api/studio/projects`,
        { draft: fixtureDraft() },
        { fetchSite: "cross-site" },
      ),
      PHONE_OWNER,
      store,
    );
    assert.equal(secFetch.status, 400);

    assert.equal(store.rows.size, 0);
  });

  await test("domain: same-origin guard accepts loopback http, rejects off-loopback http", () => {
    assertStudioSameOriginMutation(
      jsonMutation("http://127.0.0.1:4200/api/studio/projects", {}, {
        host: "127.0.0.1:4200",
        origin: "http://127.0.0.1:4200",
      }),
    );
    expectsStudioErrorSync(
      () =>
        assertStudioSameOriginMutation(
          jsonMutation("http://studio.test/api/studio/projects", {}, {
            origin: "http://studio.test",
          }),
        ),
      { code: "csrf_rejected", status: 400 },
    );
    expectsStudioErrorSync(
      () =>
        assertStudioSameOriginMutation(
          jsonMutation(`${ORIGIN}/api/studio/projects`, {}, { origin: `${ORIGIN}/path` }),
        ),
      { code: "csrf_rejected", status: 400 },
    );
  });

  await test("domain: pinned public origin accepts only the exact internal Next transport", () => {
    const previousExternal = process.env.AISTORY_STUDIO_PROJECTS_ORIGIN;
    const previousInternal = process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN;
    try {
      process.env.AISTORY_STUDIO_PROJECTS_ORIGIN = "https://studio.test";
      process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN = "http://127.0.0.1:4200";
      assertStudioSameOriginMutation(jsonMutation(
        "http://127.0.0.1:4200/api/studio/projects", {},
        { host: "studio.test", origin: "https://studio.test" },
      ));
      process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN = "https://127.0.0.1:4200";
      assertStudioSameOriginMutation(jsonMutation(
        "https://127.0.0.1:4200/api/studio/projects", {},
        { host: "studio.test", origin: "https://studio.test" },
      ));
      expectsStudioErrorSync(
        () => assertStudioSameOriginMutation(jsonMutation(
          "http://127.0.0.1:4200/api/studio/projects", {},
          { host: "studio.test", origin: "https://studio.test" },
        )),
        { code: "csrf_rejected", status: 400 },
      );
      process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN = "http://127.0.0.1:4200";
      expectsStudioErrorSync(
        () => assertStudioSameOriginMutation(jsonMutation(
          "http://127.0.0.1:4201/api/studio/projects", {},
          { host: "studio.test", origin: "https://studio.test" },
        )),
        { code: "csrf_rejected", status: 400 },
      );
      expectsStudioErrorSync(
        () => assertStudioSameOriginMutation(jsonMutation(
          "http://127.0.0.1:4200/api/studio/projects", {},
          { host: "studio.test", origin: "https://evil.test" },
        )),
        { code: "csrf_rejected", status: 400 },
      );
      delete process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN;
      expectsStudioErrorSync(
        () => assertStudioSameOriginMutation(jsonMutation(
          "http://127.0.0.1:4200/api/studio/projects", {},
          { host: "studio.test", origin: "https://studio.test" },
        )),
        { code: "csrf_rejected", status: 400 },
      );
    } finally {
      if (previousExternal === undefined) delete process.env.AISTORY_STUDIO_PROJECTS_ORIGIN;
      else process.env.AISTORY_STUDIO_PROJECTS_ORIGIN = previousExternal;
      if (previousInternal === undefined) delete process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN;
      else process.env.AISTORY_STUDIO_PROJECTS_INTERNAL_ORIGIN = previousInternal;
    }
  });

  await test("domain: malformed and oversized payloads are rejected", async () => {
    const store = new MemoryStore();
    const malformed = await handleStudioCreateProject(
      rawMutation(`${ORIGIN}/api/studio/projects`, "{not json"),
      PHONE_OWNER,
      store,
    );
    assert.equal(malformed.status, 400);

    const wrongType = await handleStudioCreateProject(
      jsonMutation(`${ORIGIN}/api/studio/projects`, { draft: fixtureDraft() }, {
        contentType: "text/plain",
      }),
      PHONE_OWNER,
      store,
    );
    assert.equal(wrongType.status, 400);

    const oversized = await handleStudioCreateProject(
      rawMutation(
        `${ORIGIN}/api/studio/projects`,
        JSON.stringify({ draft: fixtureDraft(), pad: "x".repeat(STUDIO_LIMITS.maxRequestBodyBytes) }),
      ),
      PHONE_OWNER,
      store,
    );
    assert.equal(oversized.status, 413);
    assert.equal((await responseJson(oversized)).code, "payload_too_large");

    const unknownField = await handleStudioCreateProject(
      jsonMutation(`${ORIGIN}/api/studio/projects`, {
        draft: fixtureDraft(),
        ownerKey: "leak",
      }),
      PHONE_OWNER,
      store,
    );
    assert.equal(unknownField.status, 400);

    assert.equal(store.rows.size, 0);
  });

  await test("domain: list is owner-scoped and cursor-paged", async () => {
    const store = new MemoryStore();
    const service = new StudioProjectsService({ store });
    for (let index = 0; index < 3; index += 1) {
      await service.create(PHONE_OWNER, {
        draft: fixtureDraft({ title: `作品 ${index}` }),
      });
    }
    await service.create(OTHER_OWNER, { draft: fixtureDraft({ title: "别人的作品" }) });

    const first = await service.list(PHONE_OWNER, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.items.every((item) => item.title.startsWith("作品")), true);
    assert.ok(first.nextCursor);

    const second = await service.list(PHONE_OWNER, {
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);

    const response = await handleStudioListProjects(
      new Request(`${ORIGIN}/api/studio/projects?limit=1`),
      OTHER_OWNER,
      store,
    );
    assert.equal(response.status, 200);
    const page = await responseJson(response);
    assert.equal((page.items as unknown[]).length, 1);

    const badQuery = await handleStudioListProjects(
      new Request(`${ORIGIN}/api/studio/projects?mine=1`),
      PHONE_OWNER,
      store,
    );
    assert.equal(badQuery.status, 400);
  });

  await test("domain: reading another owner's work is indistinguishable from unknown", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const id = payload.id as string;

    const mine = await handleStudioGetOwnProject(
      new Request(`${ORIGIN}/api/studio/projects/${id}`),
      id,
      PHONE_OWNER,
      store,
    );
    assert.equal(mine.status, 200);
    assert.equal((await responseJson(mine)).revision, 1);

    const theirs = await handleStudioGetOwnProject(
      new Request(`${ORIGIN}/api/studio/projects/${id}`),
      id,
      OTHER_OWNER,
      store,
    );
    const unknown = await handleStudioGetOwnProject(
      new Request(`${ORIGIN}/api/studio/projects/${randomUUID()}`),
      randomUUID(),
      PHONE_OWNER,
      store,
    );
    assert.equal(theirs.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await responseJson(theirs), await responseJson(unknown));

    const crossOwnerMutation = await handleStudioReviseProject(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 1,
        draft: fixtureDraft({ title: "hijack" }),
      }),
      id,
      OTHER_OWNER,
      store,
    );
    assert.equal(crossOwnerMutation.status, 404);
  });

  await test("domain: optimistic revision conflict is 409", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const id = payload.id as string;

    const ok = await handleStudioReviseProject(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 1,
        draft: fixtureDraft({ title: "第二稿" }),
      }),
      id,
      PHONE_OWNER,
      store,
    );
    assert.equal(ok.status, 200);
    assert.equal((await responseJson(ok)).revision, 2);

    const stale = await handleStudioReviseProject(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 1,
        draft: fixtureDraft({ title: "过期稿" }),
      }),
      id,
      PHONE_OWNER,
      store,
    );
    assert.equal(stale.status, 409);
    assert.equal((await responseJson(stale)).code, "revision_conflict");
  });

  await test("domain: draft stays private until an explicit publish", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const id = payload.id as string;

    const beforePublish = await handleStudioGetPublicProject(
      new Request(READ_URL),
      id,
      store,
    );
    assert.equal(beforePublish.status, 404);
    assert.equal((await responseJson(beforePublish)).code, "not_found");

    const service = new StudioProjectsService({ store });
    await expectsStudioError(
      () => service.setVisibility(PHONE_OWNER, id, { expectedRevision: 1, visibility: "public" }),
      { code: "not_published", status: 409 },
    );
  });

  await test("domain: publish defaults to public and the public view is safe", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const id = payload.id as string;

    const published = await handleStudioPublishProject(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 1,
        published: fixturePublished(),
      }),
      id,
      PHONE_OWNER,
      store,
    );
    assert.equal(published.status, 200);
    const summary = await responseJson(published);
    assert.equal(summary.published, true);
    assert.equal(summary.visibility, "public");

    const publicResponse = await handleStudioGetPublicProject(
      new Request(READ_URL),
      id,
      store,
    );
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get("cache-control"), "no-store");
    assert.equal(publicResponse.headers.get("referrer-policy"), "no-referrer");
    const publicBody = await responseJson(publicResponse);
    assert.deepEqual(Object.keys(publicBody).sort(), [
      "id",
      "publishedAt",
      "revision",
      "scenes",
      "synopsis",
      "title",
    ]);
    const serialized = JSON.stringify(publicBody);
    for (const forbidden of [
      "PRIVATE-DRAFT-MARKER",
      "authoringNotes",
      "authoring_notes",
      "draft",
      "ownerKey",
      "owner_key",
      deriveStudioOwnerKey(PHONE_OWNER),
      PHONE_OWNER.userId,
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `public projection leaked ${forbidden}`,
      );
    }
  });

  await test("domain: hidden and unknown are indistinguishable 404s", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const id = payload.id as string;
    await handleStudioPublishProject(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 1,
        published: fixturePublished(),
      }),
      id,
      PHONE_OWNER,
      store,
    );

    const visible = await handleStudioGetPublicProject(new Request(READ_URL), id, store);
    assert.equal(visible.status, 200);

    const hidden = await handleStudioSetVisibility(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 2,
        visibility: "hidden",
      }),
      id,
      PHONE_OWNER,
      store,
    );
    assert.equal(hidden.status, 200);

    const hiddenRead = await handleStudioGetPublicProject(new Request(READ_URL), id, store);
    const unknownRead = await handleStudioGetPublicProject(
      new Request(READ_URL),
      randomUUID(),
      store,
    );
    assert.equal(hiddenRead.status, 404);
    assert.equal(unknownRead.status, 404);
    const hiddenBody = await hiddenRead.text();
    const unknownBody = await unknownRead.text();
    assert.equal(hiddenBody, unknownBody);
    assert.deepEqual(JSON.parse(hiddenBody), JSON.parse(unknownBody));
  });

  await test("domain: publishing an unsafe snapshot is rejected", async () => {
    const store = new MemoryStore();
    const payload = await createProject(store);
    const id = payload.id as string;
    const response = await handleStudioPublishProject(
      jsonMutation(`${ORIGIN}/api/studio/projects/${id}`, {
        expectedRevision: 1,
        published: {
          ...fixturePublished(),
          authoringNotes: "PRIVATE-DRAFT-MARKER",
        },
      }),
      id,
      PHONE_OWNER,
      store,
    );
    assert.equal(response.status, 400);
    assert.equal(store.rows.size, 1);
    assert.equal([...store.rows.values()][0]?.snapshot, null);
  });

  await test("domain: an unavailable gate is an honest 503, never a 404", async () => {
    const rpc = new FakeGateRpc();
    rpc.gateVersion = "20260101000000";
    const repository = gatedRepository(rpc);
    const response = await handleStudioGetPublicProject(
      new Request(READ_URL),
      randomUUID(),
      repository,
    );
    assert.equal(response.status, 503);
    const body = await responseJson(response);
    assert.equal(body.code, "unavailable");
    assert.equal(String(body.error).includes("boom"), false);
  });
}

/* ------------------------------------------------------------------ *
 * 6. static migration / route contract
 * ------------------------------------------------------------------ */

function countMatches(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

async function staticSuite(): Promise<void> {
  const migration = await readFile(MIGRATION_PATH, "utf8");

  await test("static: migration forces RLS with no policy and no table grant", () => {
    assert.match(migration, /alter table public\.studio_projects enable row level security;/);
    assert.match(migration, /alter table public\.studio_projects force row level security;/);
    assert.equal(countMatches(migration, /create policy/gi), 0);
    assert.match(
      migration,
      /revoke all on public\.studio_projects from public, anon, authenticated, service_role;/,
    );
    assert.equal(countMatches(migration, /grant\s+\w+.*on public\.studio_projects/gi), 0);
    assert.match(migration, /visibility text not null default 'hidden'/);
    assert.equal(migration.includes("default 'public'"), false);
  });

  await test("static: every RPC is security definer with a pinned search_path", () => {
    assert.equal(countMatches(migration, /security definer/g), 10);
    assert.equal(countMatches(migration, /set search_path = pg_catalog, public/g), 9);
    assert.match(migration, /create or replace function public\.aistory_studio_project_security_posture\(\)[\s\S]*?set search_path=pg_catalog/);
    assert.equal(
      countMatches(migration, /grant execute on function public\.aistory_studio_project/g),
      9,
    );
    assert.equal(
      countMatches(
        migration,
        /revoke all on function public\.aistory_studio_project[\s\S]{0,120}?from anon, authenticated;/g,
      ),
      9,
    );
  });

  await test("static: mutations validate owner and revision atomically", () => {
    assert.ok(
      countMatches(migration, /and revision = v_expected/g) >= 3,
      "every mutation must compare owner + exact revision in the same statement",
    );
    assert.match(migration, /and owner_key = v_owner/g);
    assert.match(migration, /project\.owner_key = v_owner/);
    assert.match(migration, /row_value\.owner_key = v_owner/);
    assert.match(migration, /visibility = 'public'/);
    assert.match(migration, /published_snapshot is not null/);
  });

  await test("static: the gate is independent and version-pinned", () => {
    assert.match(migration, /values \('studio_online_projects', '20261115090000'\)/);
    assert.match(migration, /function public\.aistory_studio_projects_gate_status\(\)/);
    assert.match(migration, /function public\.aistory_studio_project_security_posture\(\)/);
    assert.match(migration, /relrowsecurity and relforcerowsecurity/);
    assert.match(migration, /pg_catalog\.pg_policies/);
    assert.match(migration, /r\.rolsuper or r\.rolbypassrls/);
    // The slice must not rewrite or relax the shared production gate row.
    assert.equal(migration.includes("'production_identity_billing'"), false);
  });

  await test("static: first install and catalog drift fail closed", () => {
    assert.match(migration, /STUDIO_PROJECT_GATE_PRESTATE_REJECTED/);
    assert.match(migration, /create table public\.studio_project_catalog_manifest/);
    assert.match(migration, /create trigger studio_project_catalog_immutable/);
    assert.match(migration, /a\.grantee not in \('postgres'::regrole,'service_role'::regrole\)/);
    assert.match(migration, /definition_sha256 from public\.aistory_studio_project_catalog\(\)/);
    assert.match(migration, /except select object_key,definition_sha256 from public\.studio_project_catalog_manifest/);
    assert.doesNotMatch(migration, /create table if not exists public\.studio_projects/);
    assert.doesNotMatch(migration, /on conflict \(gate_name\) do update/);
  });

  await test("static: routes authenticate before touching ids", async () => {
    for (const routePath of OWNER_ROUTES) {
      const route = await readFile(routePath, "utf8");
      assert.match(route, /export const runtime = "nodejs";/);
      assert.match(route, /requireUser/);
      const authIndex = route.indexOf("await requireUser()");
      const paramIndex = route.indexOf("await context.params");
      assert.ok(authIndex >= 0, `${routePath} must call requireUser`);
      if (paramIndex >= 0) {
        assert.ok(
          authIndex < paramIndex,
          `${routePath} must authenticate before resolving the id`,
        );
      }
    }
    const publicRoute = await readFile(PUBLIC_ROUTE, "utf8");
    assert.match(publicRoute, /export const runtime = "nodejs";/);
    assert.equal(publicRoute.includes("requireUser"), false);
  });

  await test("static: every mutation passes the same-origin guard", async () => {
    const source = await readFile(path.join(MODULE_DIR, "service.ts"), "utf8");
    assert.equal(countMatches(source, /assertStudioSameOriginMutation\(request\)/g), 4);
    const publicHandler = source.slice(source.indexOf("handleStudioGetPublicProject"));
    assert.equal(publicHandler.includes("assertStudioSameOriginMutation"), false);
  });

  await test("static: no provider task, GPU, or donor iframe surface", async () => {
    const files = [
      "types.ts",
      "validation.ts",
      "repository.ts",
      "service.ts",
    ].map((name) => path.join(MODULE_DIR, name));
    files.push(...OWNER_ROUTES, PUBLIC_ROUTE);
    for (const file of files) {
      const source = (await readFile(file, "utf8")).toLowerCase();
      for (const forbidden of [
        "comfyui",
        "localminidrama",
        "generation-jobs",
        "<iframe",
        "iframe src",
        "workflow_json",
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `${path.basename(file)} must not reference ${forbidden}`,
        );
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await validationSuite();
  await ownershipSuite();
  await gateSuite();
  await repositorySuite();
  await domainSuite();
  await staticSuite();

  const elapsed = Date.now() - started;
  process.stdout.write(
    `\n${passed.length} passed, ${failures} failed in ${elapsed}ms\n`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main();
