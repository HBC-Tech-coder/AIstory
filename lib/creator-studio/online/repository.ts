import "server-only";

import { createHash } from "node:crypto";

import { createProductionSupabaseServiceClient } from "@/lib/production/databaseGate";

import {
  STUDIO_LIMITS,
  isOwnerKey,
  isProjectId,
  isStudioVisibility,
  validateDraftStructure,
  validatePublishedStructure,
} from "./validation";
import {
  STUDIO_PROJECTS_GATE_VERSION,
  STUDIO_PROJECTS_MODE,
  StudioProjectsError,
  type StudioDraftV1,
  type StudioOwnerRecord,
  type StudioProjectVisibility,
  type StudioPublicRecord,
  type StudioPublishedSnapshotV1,
} from "./types";

/**
 * Durable, server-only repository for Studio online projects.
 *
 * Every read and write is a security-definer RPC owned by the migration. The
 * table itself is never reachable through the PostgREST surface: forced RLS is
 * enabled with no policy and no grant for anon, authenticated, or service_role.
 * Any transport/RPC/shape problem fails closed as a 503 instead of degrading to
 * an unauthenticated or partially owned read.
 *
 * The slice ships its own exact feature selector and its own database
 * version/posture gate. It deliberately does not infer coverage from the shared
 * production identity/billing gate.
 */

export type StudioProjectsRpcResult = {
  data: unknown;
  error: { message?: string; code?: string } | null;
  status?: number;
};

const STUDIO_RPC_NAMES = [
  "aistory_studio_projects_gate_status",
  "aistory_studio_project_security_posture_claims_v1",
  "aistory_studio_project_create",
  "aistory_studio_project_revise",
  "aistory_studio_project_publish",
  "aistory_studio_project_set_visibility",
  "aistory_studio_project_get_owner",
  "aistory_studio_project_list_owner",
  "aistory_studio_project_get_public",
] as const;
type StudioRpcName = (typeof STUDIO_RPC_NAMES)[number];

/** Only fixed fields are logged; provider text and request data stay private. */
function logStudioRpcFailure(
  stage: "transport" | "rpc",
  rpc: StudioRpcName,
  result?: StudioProjectsRpcResult,
): void {
  const code = result?.error?.code;
  const status = result?.status;
  console.error("[studio-online-rpc]", {
    stage,
    rpc,
    ...(typeof code === "string" && /^[A-Z0-9]{5,10}$/.test(code) ? { code } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status } : {}),
  });
}

export interface StudioProjectsRpcClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<StudioProjectsRpcResult>;
}

export type StudioProjectsConfig = {
  mode: typeof STUDIO_PROJECTS_MODE;
  gateVersion: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

export type StudioProjectsConfigStatus =
  | { ok: true; config: StudioProjectsConfig }
  | { ok: false; reason: "disabled"; missing: string[] }
  | { ok: false; reason: "unavailable"; missing: string[] };

type Env = Record<string, string | undefined>;

function disabled(): StudioProjectsError {
  return new StudioProjectsError(
    "disabled",
    503,
    "Studio online projects are not enabled.",
  );
}

function unavailable(): StudioProjectsError {
  return new StudioProjectsError(
    "unavailable",
    503,
    "Studio online projects are temporarily unavailable.",
  );
}

function notFound(): StudioProjectsError {
  return new StudioProjectsError("not_found", 404, "Studio project not found.");
}

function revisionConflict(): StudioProjectsError {
  return new StudioProjectsError(
    "revision_conflict",
    409,
    "The Studio project changed; refresh and retry.",
  );
}

function notPublished(): StudioProjectsError {
  return new StudioProjectsError(
    "not_published",
    409,
    "Publish the Studio project before changing its visibility.",
  );
}

function limitReached(): StudioProjectsError {
  return new StudioProjectsError(
    "limit_reached",
    409,
    "The Studio project limit for this account was reached.",
  );
}

/** Exact, default-off selector plus exact migration pin. */
export function readStudioProjectsConfig(
  env: Env = process.env,
): StudioProjectsConfigStatus {
  if (env.AISTORY_STUDIO_PROJECTS_MODE?.trim() !== STUDIO_PROJECTS_MODE) {
    return { ok: false, reason: "disabled", missing: ["feature_selector"] };
  }
  const missing: string[] = [];
  const supabaseUrl = (
    env.AISTORY_SUPABASE_SERVER_URL?.trim()
    || env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    || ""
  );
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!supabaseUrl) missing.push("supabase_url");
  if (!serviceRoleKey) missing.push("service_role");
  if (env.AISTORY_STUDIO_PROJECTS_GATE_VERSION?.trim() !== STUDIO_PROJECTS_GATE_VERSION) {
    missing.push("studio_projects_gate_version");
  }
  if (missing.length > 0) {
    return { ok: false, reason: "unavailable", missing };
  }
  return {
    ok: true,
    config: {
      mode: STUDIO_PROJECTS_MODE,
      gateVersion: STUDIO_PROJECTS_GATE_VERSION,
      supabaseUrl,
      serviceRoleKey,
    },
  };
}

export function requireStudioProjectsConfig(env: Env = process.env): StudioProjectsConfig {
  const status = readStudioProjectsConfig(env);
  if (status.ok) return status.config;
  throw status.reason === "disabled" ? disabled() : unavailable();
}

/** Owner-scoped durable store contract. Implementations must fail closed. */
export interface StudioProjectsStore {
  readonly source: "supabase" | "memory";
  assertReady(): Promise<void>;
  create(ownerKey: string, draft: StudioDraftV1): Promise<StudioOwnerRecord>;
  revise(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    draft: StudioDraftV1,
  ): Promise<StudioOwnerRecord>;
  publish(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    published: StudioPublishedSnapshotV1,
    visibility: StudioProjectVisibility,
  ): Promise<StudioOwnerRecord>;
  setVisibility(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    visibility: StudioProjectVisibility,
  ): Promise<StudioOwnerRecord>;
  getOwner(ownerKey: string, id: string): Promise<StudioOwnerRecord | null>;
  listOwner(
    ownerKey: string,
    offset: number,
    limit: number,
  ): Promise<{ records: StudioOwnerRecord[]; hasMore: boolean }>;
  getPublic(id: string): Promise<StudioPublicRecord | null>;
}

const OWNER_RECORD_KEYS = [
  "id",
  "revision",
  "draft",
  "visibility",
  "published",
  "published_revision",
  "created_at",
  "updated_at",
  "published_at",
] as const;

const PUBLIC_RECORD_KEYS = [
  "id",
  "revision",
  "published_at",
  "title",
  "synopsis",
  "scenes",
] as const;

function hashDocument(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw unavailable();
  }
}

function readIsoTimestamp(value: unknown): string {
  if (typeof value !== "string") throw unavailable();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw unavailable();
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw unavailable();
  return canonical;
}

function readNullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return readIsoTimestamp(value);
}

function readInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw unavailable();
  }
  return value;
}

function readRevision(value: unknown): number {
  const revision = readInteger(value);
  if (revision > STUDIO_LIMITS.maxExpectedRevision) throw unavailable();
  return revision;
}

function readNullableRevision(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return readInteger(value);
}

function parseOwnerRecord(value: unknown): StudioOwnerRecord {
  const record = asRecord(value);
  if (!record) throw unavailable();
  assertAllowedKeys(record, OWNER_RECORD_KEYS);
  if (!isProjectId(record.id)) throw unavailable();
  const revision = readRevision(record.revision);
  if (!isStudioVisibility(record.visibility)) throw unavailable();
  if (typeof record.published !== "boolean") throw unavailable();

  let draft: StudioDraftV1;
  try {
    draft = validateDraftStructure(record.draft);
  } catch {
    throw unavailable();
  }

  const publishedRevision = readNullableRevision(record.published_revision);
  const publishedAt = readNullableTimestamp(record.published_at);
  const createdAt = readIsoTimestamp(record.created_at);
  const updatedAt = readIsoTimestamp(record.updated_at);

  // An unpublished row must stay private: no published pointer, hidden default.
  if (!record.published) {
    if (publishedRevision !== null || publishedAt !== null) throw unavailable();
    if (record.visibility !== "hidden") throw unavailable();
  } else if (publishedRevision === null || publishedAt === null) {
    throw unavailable();
  }

  return {
    id: record.id,
    revision,
    draft,
    visibility: record.visibility,
    published: record.published,
    publishedRevision,
    createdAt,
    updatedAt,
    publishedAt,
  };
}

function parsePublicRecord(value: unknown): StudioPublicRecord {
  const record = asRecord(value);
  if (!record) throw unavailable();
  assertAllowedKeys(record, PUBLIC_RECORD_KEYS);
  if (!isProjectId(record.id)) throw unavailable();
  const revision = readRevision(record.revision);
  const publishedAt = readIsoTimestamp(record.published_at);
  const rawSynopsis = record.synopsis;
  const synopsis =
    rawSynopsis === null || rawSynopsis === undefined ? undefined : rawSynopsis;

  let snapshot: StudioPublishedSnapshotV1;
  try {
    snapshot = validatePublishedStructure({
      v: 1,
      title: record.title,
      ...(synopsis === undefined ? {} : { synopsis }),
      scenes: record.scenes,
    });
  } catch {
    throw unavailable();
  }

  return {
    id: record.id,
    revision,
    publishedAt,
    title: snapshot.title,
    ...(snapshot.synopsis === undefined ? {} : { synopsis: snapshot.synopsis }),
    scenes: snapshot.scenes,
  };
}

export type StudioProjectsRepositoryOptions = {
  /** Injected for qualification tests; never used by the production factory. */
  client?: StudioProjectsRpcClient;
  config?: StudioProjectsConfig;
};

export class StudioProjectsRepository implements StudioProjectsStore {
  readonly source = "supabase" as const;
  private readonly client: StudioProjectsRpcClient;
  private readonly config: StudioProjectsConfig;

  constructor(options: StudioProjectsRepositoryOptions) {
    if (options.client) {
      this.client = options.client;
      this.config = options.config ?? requireStudioProjectsConfig();
      return;
    }
    const config = options.config ?? requireStudioProjectsConfig();
    const supabase = createProductionSupabaseServiceClient({
      AISTORY_SUPABASE_SERVER_URL: config.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey,
    });
    this.client = {
      rpc: (name, args) =>
        supabase.rpc(name, args) as unknown as PromiseLike<StudioProjectsRpcResult>,
    };
    this.config = config;
  }

  private async call(
    name: StudioRpcName,
    args?: Record<string, unknown>,
  ): Promise<StudioProjectsRpcResult> {
    let result: StudioProjectsRpcResult;
    try {
      result = await this.client.rpc(name, args);
    } catch {
      logStudioRpcFailure("transport", name);
      throw unavailable();
    }
    if (!result || result.error) {
      logStudioRpcFailure("rpc", name, result);
      throw unavailable();
    }
    return result;
  }

  /**
   * Independent gate: exact database-owned version plus forced-RLS/ACL posture
   * for this table and these RPCs. The env pin alone never proves the migration
   * was applied.
   */
  async assertReady(): Promise<void> {
    if (this.config.mode !== STUDIO_PROJECTS_MODE) throw disabled();
    if (this.config.gateVersion !== STUDIO_PROJECTS_GATE_VERSION) throw unavailable();
    const status = await this.call("aistory_studio_projects_gate_status");
    if (status.data !== STUDIO_PROJECTS_GATE_VERSION) throw unavailable();

    const posture = await this.call("aistory_studio_project_security_posture_claims_v1");
    if (posture.data !== true) throw unavailable();

  }

  private static assertOwnerKey(ownerKey: string): void {
    if (!isOwnerKey(ownerKey)) {
      throw new StudioProjectsError("unauthorized", 401, "Login required.");
    }
  }

  private static assertProjectId(id: string): void {
    if (!isProjectId(id)) throw notFound();
  }

  private static readOutcome(
    value: unknown,
  ): { outcome: string; project?: unknown } {
    const record = asRecord(value);
    if (!record || typeof record.outcome !== "string") throw unavailable();
    return { outcome: record.outcome, project: record.project };
  }

  async create(ownerKey: string, draft: StudioDraftV1): Promise<StudioOwnerRecord> {
    StudioProjectsRepository.assertOwnerKey(ownerKey);
    await this.assertReady();
    const result = await this.call("aistory_studio_project_create", {
      payload: {
        owner_key: ownerKey,
        draft,
        draft_hash: hashDocument(draft),
      },
    });
    const parsed = StudioProjectsRepository.readOutcome(result.data);
    if (parsed.outcome === "limit_reached") throw limitReached();
    if (parsed.outcome !== "created") throw unavailable();
    return parseOwnerRecord(parsed.project);
  }

  async revise(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    draft: StudioDraftV1,
  ): Promise<StudioOwnerRecord> {
    StudioProjectsRepository.assertOwnerKey(ownerKey);
    StudioProjectsRepository.assertProjectId(id);
    await this.assertReady();
    const result = await this.call("aistory_studio_project_revise", {
      payload: {
        owner_key: ownerKey,
        project_id: id,
        expected_revision: expectedRevision,
        draft,
        draft_hash: hashDocument(draft),
      },
    });
    return this.readMutation(result.data);
  }

  async publish(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    published: StudioPublishedSnapshotV1,
    visibility: StudioProjectVisibility,
  ): Promise<StudioOwnerRecord> {
    StudioProjectsRepository.assertOwnerKey(ownerKey);
    StudioProjectsRepository.assertProjectId(id);
    await this.assertReady();
    const result = await this.call("aistory_studio_project_publish", {
      payload: {
        owner_key: ownerKey,
        project_id: id,
        expected_revision: expectedRevision,
        visibility,
        published,
        published_hash: hashDocument(published),
      },
    });
    return this.readMutation(result.data);
  }

  async setVisibility(
    ownerKey: string,
    id: string,
    expectedRevision: number,
    visibility: StudioProjectVisibility,
  ): Promise<StudioOwnerRecord> {
    StudioProjectsRepository.assertOwnerKey(ownerKey);
    StudioProjectsRepository.assertProjectId(id);
    await this.assertReady();
    const result = await this.call("aistory_studio_project_set_visibility", {
      payload: {
        owner_key: ownerKey,
        project_id: id,
        expected_revision: expectedRevision,
        visibility,
      },
    });
    return this.readMutation(result.data);
  }

  private readMutation(value: unknown): StudioOwnerRecord {
    const parsed = StudioProjectsRepository.readOutcome(value);
    if (parsed.outcome === "not_found") throw notFound();
    if (parsed.outcome === "conflict") throw revisionConflict();
    if (parsed.outcome === "not_published") throw notPublished();
    if (parsed.outcome !== "updated" && parsed.outcome !== "published") {
      throw unavailable();
    }
    return parseOwnerRecord(parsed.project);
  }

  async getOwner(ownerKey: string, id: string): Promise<StudioOwnerRecord | null> {
    StudioProjectsRepository.assertOwnerKey(ownerKey);
    StudioProjectsRepository.assertProjectId(id);
    await this.assertReady();
    const result = await this.call("aistory_studio_project_get_owner", {
      owner_key: ownerKey,
      project_id: id,
    });
    if (result.data === null || result.data === undefined) return null;
    return parseOwnerRecord(result.data);
  }

  async listOwner(
    ownerKey: string,
    offset: number,
    limit: number,
  ): Promise<{ records: StudioOwnerRecord[]; hasMore: boolean }> {
    StudioProjectsRepository.assertOwnerKey(ownerKey);
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > STUDIO_LIMITS.maxListLimit
    ) {
      throw new StudioProjectsError("invalid_request", 400, "Invalid list cursor or limit.");
    }
    await this.assertReady();
    const result = await this.call("aistory_studio_project_list_owner", {
      owner_key: ownerKey,
      page_offset: offset,
      page_limit: limit,
    });
    const record = asRecord(result.data);
    if (!record || !Array.isArray(record.items) || typeof record.has_more !== "boolean") {
      throw unavailable();
    }
    for (const key of Object.keys(record)) {
      if (key !== "items" && key !== "has_more") throw unavailable();
    }
    return {
      records: record.items.map(parseOwnerRecord),
      hasMore: record.has_more,
    };
  }

  async getPublic(id: string): Promise<StudioPublicRecord | null> {
    if (!isProjectId(id)) return null;
    await this.assertReady();
    const result = await this.call("aistory_studio_project_get_public", {
      project_id: id,
    });
    if (result.data === null || result.data === undefined) return null;
    return parsePublicRecord(result.data);
  }
}

/**
 * Production wiring. Configuration is read per call so enablement is a request
 * concern and never a compile-time constant. There is no memory fallback.
 */
export function createStudioProjectsRepositoryFromEnv(
  env: Env = process.env,
): StudioProjectsRepository {
  const config = requireStudioProjectsConfig(env);
  return new StudioProjectsRepository({ config });
}
