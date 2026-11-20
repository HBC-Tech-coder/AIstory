import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ANONYMOUS_CLAIM_SCHEMA_VERSION,
  emptyAnonymousClaimResult,
  type AnonymousClaimManifest,
  type AnonymousClaimResult,
  validateAnonymousClaimManifest,
} from "@/lib/auth/anonymousClaim";
import {
  prepareServerAnonymousClaim,
  type ServerAnonymousClaim,
} from "@/lib/auth/anonymousClaimServer";
import {
  getOrCreateAnonymousSubject,
  inspectAnonymousSubjectToken,
} from "@/lib/auth/anonymousSubject";
import {
  SupabasePhoneIdentityRepository,
  type PhoneIdentityRpcClient,
} from "@/lib/auth/phoneIdentityRepository";
import { requestPhoneOtp } from "@/lib/auth/phoneAuthService";
import {
  PRODUCTION_IDENTITY_DB_GATE_VERSION,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import {
  activeStoryNamespace,
  ANONYMOUS_STORY_NAMESPACE,
  setActiveStoryNamespace,
  storyStorageKey,
} from "@/lib/persistence/storyNamespace";

type RpcResult = {
  data: unknown;
  error: { message?: string; code?: string } | null;
};

type StoredClaim = {
  userId: string;
  idempotencyKey: string;
  fingerprint: string;
  result: Record<string, unknown>;
};

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class AtomicClaimRpcFixture {
  readonly users = new Map<string, string>();
  readonly initialGrants = new Set<string>();
  readonly subjectOwners = new Map<string, string>();
  readonly bySubject = new Map<string, StoredClaim>();
  readonly byIdempotency = new Map<string, StoredClaim>();
  readonly calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  private queue = Promise.resolve();

  readonly client: PhoneIdentityRpcClient = {
    rpc: async (name, args) =>
      this.rpc(name, args as Record<string, unknown> | undefined),
  };

  private async serialized<T>(operation: () => T): Promise<T> {
    const previous = this.queue;
    let release = () => undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  private account(
    verification: Record<string, unknown>,
  ): {
    userId: string;
    created: boolean;
    initialGrantApplied: boolean;
  } {
    const phoneHash = String(verification.phone_hash || "");
    let userId = this.users.get(phoneHash);
    const created = !userId;
    if (!userId) {
      userId = randomUUID();
      this.users.set(phoneHash, userId);
    }
    const initialGrantApplied = !this.initialGrants.has(userId);
    this.initialGrants.add(userId);
    return { userId, created, initialGrantApplied };
  }

  private claimResult(
    claim: ServerAnonymousClaim,
  ): AnonymousClaimResult {
    const claimId = randomUUID();
    const acceptedAssignments = claim.experimentAssignments;
    const skipped = Object.values(claim.skippedByReason).reduce(
      (sum, value) => sum + (value || 0),
      0,
    );
    return {
      ...emptyAnonymousClaimResult(
        claim.stories.length
          + claim.cacheReferences.length
          + acceptedAssignments.length > 0
          ? "claimed"
          : "empty",
      ),
      claimId,
      acceptedStoryRecordIds: claim.stories.map((story) => story.recordId),
      acceptedAssignmentKeys: acceptedAssignments.map(
        (assignment) =>
          `${assignment.experimentKey}:${assignment.experimentVersion}`,
      ),
      acceptedAssignments,
      counts: {
        submittedStories: claim.submittedStories,
        inheritedStories: claim.stories.length,
        inheritedCheckpoints: claim.stories.reduce(
          (sum, story) => sum + story.checkpointCount,
          0,
        ),
        inheritedCacheReferences: claim.cacheReferences.length,
        inheritedAssignments: acceptedAssignments.length,
        skipped,
      },
      skippedByReason: claim.skippedByReason,
    };
  }

  private wire(result: AnonymousClaimResult): Record<string, unknown> {
    return {
      status: result.status,
      claim_id: result.claimId,
      accepted_story_record_ids: result.acceptedStoryRecordIds,
      accepted_assignment_keys: result.acceptedAssignmentKeys,
      accepted_assignments: result.acceptedAssignments.map((assignment) => ({
        experiment_key: assignment.experimentKey,
        experiment_version: assignment.experimentVersion,
        variant_key: assignment.variantKey,
      })),
      counts: {
        submitted_stories: result.counts.submittedStories,
        inherited_stories: result.counts.inheritedStories,
        inherited_checkpoints: result.counts.inheritedCheckpoints,
        inherited_cache_references:
          result.counts.inheritedCacheReferences,
        inherited_assignments: result.counts.inheritedAssignments,
        skipped: result.counts.skipped,
      },
      skipped_by_reason: result.skippedByReason,
    };
  }

  private async rpc(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<RpcResult> {
    this.calls.push({ name, args });
    if (name === "aistory_database_gate_status") {
      return { data: PRODUCTION_IDENTITY_DB_GATE_VERSION, error: null };
    }
    if (name === "aistory_database_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_admin_rpc_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_phone_admin_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_hosted_byok_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_video_asset_security_posture") {
      return { data: true, error: null };
    }
    if (name === "aistory_get_anonymous_claim_receipt") {
      const stored = this.bySubject.get(
        String(args?.anonymous_subject_hash || ""),
      );
      if (!stored || stored.userId !== String(args?.app_user_id || "")) {
        return { data: null, error: null };
      }
      return {
        data: { ...stored.result, status: "replayed" },
        error: null,
      };
    }
    if (name !== "aistory_verify_phone_register_and_claim") {
      return { data: null, error: { message: "fixture RPC missing" } };
    }
    return this.serialized(() => {
      const verification =
        (args?.verification as Record<string, unknown> | undefined) || {};
      if (String(verification.challenge_id || "").startsWith("invalid")) {
        return { data: { status: "invalid" }, error: null };
      }
      const account = this.account(verification);
      const claim = verification.anonymous_claim as
        | ServerAnonymousClaim
        | undefined;
      let claimResult = emptyAnonymousClaimResult("not_found");
      if (claim) {
        const owner = this.subjectOwners.get(claim.anonymousSubjectHash);
        const existing = this.byIdempotency.get(claim.idempotencyKey);
        if (owner && owner !== account.userId) {
          claimResult = emptyAnonymousClaimResult("conflict");
          claimResult.counts.submittedStories = claim.submittedStories;
          claimResult.counts.skipped = claim.submittedStories;
          claimResult.skippedByReason = {
            manifest_invalid: claim.submittedStories,
          };
        } else if (existing) {
          if (
            existing.userId === account.userId
            && this.subjectOwners.get(claim.anonymousSubjectHash)
              === account.userId
            && existing.idempotencyKey === claim.idempotencyKey
            && existing.fingerprint === claim.requestFingerprint
          ) {
            claimResult = {
              ...parseWireClaim(existing.result),
              status: "replayed",
            };
          } else {
            claimResult = emptyAnonymousClaimResult("conflict");
            claimResult.counts.submittedStories = claim.submittedStories;
            claimResult.counts.skipped = claim.submittedStories;
            claimResult.skippedByReason = {
              manifest_invalid: claim.submittedStories,
            };
          }
        } else {
          claimResult = this.claimResult(claim);
          const stored = {
            userId: account.userId,
            idempotencyKey: claim.idempotencyKey,
            fingerprint: claim.requestFingerprint,
            result: this.wire(claimResult),
          };
          this.subjectOwners.set(claim.anonymousSubjectHash, account.userId);
          this.byIdempotency.set(claim.idempotencyKey, stored);
          this.bySubject.set(claim.anonymousSubjectHash, stored);
        }
      }
      return {
        data: {
          status: "verified",
          user_id: account.userId,
          masked_phone: String(verification.masked_phone || "+8613******00"),
          created: account.created,
          initial_grant_applied: account.initialGrantApplied,
          balance: 1000,
          claim: this.wire(claimResult),
        },
        error: null,
      };
    });
  }
}

function parseWireClaim(value: Record<string, unknown>): AnonymousClaimResult {
  const counts = value.counts as Record<string, number>;
  return {
    status: String(value.status) as AnonymousClaimResult["status"],
    ...(typeof value.claim_id === "string"
      ? { claimId: value.claim_id }
      : {}),
    acceptedStoryRecordIds:
      (value.accepted_story_record_ids as string[]) || [],
    acceptedAssignmentKeys:
      (value.accepted_assignment_keys as string[]) || [],
    acceptedAssignments: (
      (value.accepted_assignments as Array<Record<string, string>>) || []
    ).map((assignment) => ({
      experimentKey: assignment.experiment_key,
      experimentVersion: assignment.experiment_version,
      variantKey: assignment.variant_key,
    })),
    counts: {
      submittedStories: counts.submitted_stories || 0,
      inheritedStories: counts.inherited_stories || 0,
      inheritedCheckpoints: counts.inherited_checkpoints || 0,
      inheritedCacheReferences:
        counts.inherited_cache_references || 0,
      inheritedAssignments: counts.inherited_assignments || 0,
      skipped: counts.skipped || 0,
    },
    skippedByReason:
      (value.skipped_by_reason as AnonymousClaimResult["skippedByReason"])
      || {},
  };
}

function manifest(
  idempotencyKey = `claim:${randomUUID()}`,
): AnonymousClaimManifest {
  return validateAnonymousClaimManifest({
    schemaVersion: ANONYMOUS_CLAIM_SCHEMA_VERSION,
    idempotencyKey,
    stories: [{
      recordId: "story-record-1",
      storyId: "virtual-girlfriend-20260727",
      storyVersion: "author-locked-v1.1",
      currentNodeId: "vg11_ep1_reflection",
      currentBeatId: "beat-1",
      visitedNodeIds: ["vg11_ep1_start", "vg11_ep1_reflection"],
      activeBranchId: "branch-main",
      branchIds: ["branch-main"],
      selectedChoiceIds: ["choice-wake"],
      checkpointCount: 2,
      timelineRevision: "a".repeat(64),
      localRevision: 7,
      updatedAt: 1_790_000_000_000,
    }],
    cacheReferences: [{
      storyId: "virtual-girlfriend-20260727",
      storyVersion: "author-locked-v1.1",
      resourceKey:
        "/case-studies/virtual-girlfriend-20260727/pending.svg",
      contentHash: "b".repeat(64),
    }],
    experimentAssignments: [{
      experimentKey: "home-feed-layout",
      experimentVersion: "v1",
      variantKey: "compact",
    }],
  });
}

const originalEnv = { ...process.env };

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

try {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage,
      localStorage,
      dispatchEvent: () => true,
    },
  });
  const namespaceUserId = "018f47ac-2e26-7a4f-9e4e-8c7e14bda031";
  assert.equal(activeStoryNamespace(), ANONYMOUS_STORY_NAMESPACE);
  setActiveStoryNamespace(namespaceUserId);
  assert.equal(activeStoryNamespace(), namespaceUserId);
  assert.equal(
    storyStorageKey(namespaceUserId, "story-1"),
    `${namespaceUserId}::story-1`,
  );
  setActiveStoryNamespace();
  assert.equal(activeStoryNamespace(), ANONYMOUS_STORY_NAMESPACE);
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }

  const anonymousEnvironment = {
    AISTORY_ANONYMOUS_SESSION_SECRET:
      "fixture-anonymous-session-secret-123456789",
    AISTORY_ANONYMOUS_SUBJECT_PEPPER:
      "fixture-anonymous-subject-pepper-123456789",
    NODE_ENV: "production",
  };
  Object.assign(process.env, anonymousEnvironment, {
    AISTORY_PRODUCTION_IDENTITY_ENABLED: "true",
    AISTORY_IDENTITY_REPOSITORY: "supabase",
    AISTORY_ADMIN_REPOSITORY: "supabase",
    AISTORY_DATABASE_GATE_VERSION: PRODUCTION_IDENTITY_DB_GATE_VERSION,
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role-never-log",
    AISTORY_PHONE_ID_PEPPER:
      "fixture-phone-identity-pepper-123456789",
    AISTORY_SMS_OTP_SECRET: "fixture-sms-otp-secret-123456789012",
  });

  const now = Date.now();
  const created = getOrCreateAnonymousSubject(
    new Request("https://fixture.invalid/api/account/me"),
    anonymousEnvironment,
    now,
  );
  assert.ok(created?.created);
  assert.match(created!.subjectHash, /^[a-f0-9]{64}$/);
  assert.equal(created!.token.includes(created!.subjectHash), false);
  assert.deepEqual(
    inspectAnonymousSubjectToken(
      created!.token,
      anonymousEnvironment,
      now + 1,
    ),
    {
      subjectHash: created!.subjectHash,
      expiresAt: created!.expiresAt,
    },
  );
  assert.equal(
    inspectAnonymousSubjectToken(
      `${created!.token}tampered`,
      anonymousEnvironment,
      now + 1,
    ),
    undefined,
  );
  assert.equal(
    inspectAnonymousSubjectToken(
      created!.token,
      anonymousEnvironment,
      created!.expiresAt,
    ),
    undefined,
  );

  const request = new Request("https://fixture.invalid/api/auth/phone/verify", {
    headers: {
      cookie: `aistory_anonymous_subject=${encodeURIComponent(created!.token)}`,
    },
  });
  const prepared = await prepareServerAnonymousClaim(
    request,
    manifest("claim:fixture-first-registration"),
    {
      resolveStory: async () => true,
      resolveCacheReference: async () => true,
      resolveAssignment: async () => true,
    },
  );
  assert.ok(prepared);
  assert.equal(prepared!.anonymousSubjectHash, created!.subjectHash);
  assert.equal(prepared!.stories.length, 1);
  assert.equal(prepared!.cacheReferences.length, 1);
  assert.equal(prepared!.experimentAssignments.length, 1);
  const preparedJson = JSON.stringify(prepared);
  for (
    const forbidden of [
      "apiKey",
      "baseUrl",
      "demoCredits",
      "phoneHash",
      "otpHash",
      "prompt",
      created!.token,
    ]
  ) {
    assert.equal(preparedJson.includes(forbidden), false, forbidden);
  }
  assert.equal(
    await prepareServerAnonymousClaim(
      new Request("https://fixture.invalid/api/auth/phone/verify"),
      manifest(),
      {
        resolveStory: async () => true,
        resolveCacheReference: async () => true,
        resolveAssignment: async () => true,
      },
    ),
    undefined,
    "missing anonymous cookie must not fabricate a claim",
  );

  const restricted = await prepareServerAnonymousClaim(
    request,
    manifest("claim:fixture-restricted"),
    {
      resolveStory: async () => false,
      resolveCacheReference: async () => false,
      resolveAssignment: async () => false,
    },
  );
  assert.equal(restricted?.stories.length, 0);
  assert.deepEqual(restricted?.skippedByReason, {
    not_published: 1,
    resource_unavailable: 1,
    assignment_unavailable: 1,
  });

  assert.throws(
    () =>
      validateAnonymousClaimManifest({
        ...manifest(),
        apiKey: "forbidden",
      }),
    /forbidden field/,
  );
  assert.throws(
    () =>
      validateAnonymousClaimManifest({
        ...manifest(),
        stories: Array.from({ length: 51 }, (_, index) => ({
          ...manifest().stories[0],
          recordId: `story-${index}`,
        })),
      }),
    /collection is invalid/,
  );
  for (const forbiddenField of ["token", "prompt", "demoCredits", "baseUrl"]) {
    assert.throws(
      () =>
        validateAnonymousClaimManifest({
          ...manifest(),
          stories: [{
            ...manifest().stories[0],
            [forbiddenField]: "forbidden",
          }],
        }),
      /forbidden field/,
    );
  }

  const fixture = new AtomicClaimRpcFixture();
  const repository = new SupabasePhoneIdentityRepository(fixture.client);
  const first = await repository.verifyAndRegister({
    challengeId: "valid:first",
    phoneHash: "1".repeat(64),
    otpHash: "2".repeat(64),
    maskedPhone: "+8613******00",
    locale: "zh-CN",
    claim: prepared!,
  });
  assert.equal(first?.created, true);
  assert.equal(first?.initialGrantApplied, true);
  assert.equal(first?.balance, 1000);
  assert.equal(first?.claim?.status, "claimed");
  assert.equal(first?.claim?.counts.inheritedStories, 1);
  assert.deepEqual(first?.claim?.acceptedAssignments, [{
    experimentKey: "home-feed-layout",
    experimentVersion: "v1",
    variantKey: "compact",
  }]);

  const replay = await repository.verifyAndRegister({
    challengeId: "valid:replay",
    phoneHash: "1".repeat(64),
    otpHash: "2".repeat(64),
    maskedPhone: "+8613******00",
    locale: "zh-CN",
    claim: prepared!,
  });
  assert.equal(replay?.created, false);
  assert.equal(replay?.initialGrantApplied, false);
  assert.equal(replay?.claim?.status, "replayed");
  assert.equal(replay?.claim?.claimId, first?.claim?.claimId);

  const semanticConflict = await repository.verifyAndRegister({
    challengeId: "valid:semantic-conflict",
    phoneHash: "1".repeat(64),
    otpHash: "2".repeat(64),
    maskedPhone: "+8613******00",
    locale: "zh-CN",
    claim: {
      ...prepared!,
      requestFingerprint: "f".repeat(64),
    },
  });
  assert.equal(semanticConflict?.claim?.status, "conflict");

  const incrementalClaim: ServerAnonymousClaim = {
    ...prepared!,
    idempotencyKey: "claim:fixture-incremental-progress",
    requestFingerprint: "9".repeat(64),
  };
  const incremental = await repository.verifyAndRegister({
    challengeId: "valid:incremental",
    phoneHash: "1".repeat(64),
    otpHash: "2".repeat(64),
    maskedPhone: "+8613******00",
    locale: "zh-CN",
    claim: incrementalClaim,
  });
  assert.equal(incremental?.userId, first?.userId);
  assert.equal(incremental?.initialGrantApplied, false);
  assert.equal(incremental?.claim?.status, "claimed");
  assert.notEqual(incremental?.claim?.claimId, first?.claim?.claimId);

  const differentAccount = await repository.verifyAndRegister({
    challengeId: "valid:different-account",
    phoneHash: "3".repeat(64),
    otpHash: "4".repeat(64),
    maskedPhone: "+8615******00",
    locale: "zh-CN",
    claim: prepared!,
  });
  assert.equal(differentAccount?.claim?.status, "conflict");
  assert.notEqual(differentAccount?.userId, first?.userId);

  const receipt = await repository.getClaimReceipt(
    prepared!.anonymousSubjectHash,
    first!.userId,
  );
  assert.equal(receipt?.status, "replayed");
  assert.equal(receipt?.claimId, incremental?.claim?.claimId);
  assert.equal(
    await repository.getClaimReceipt(
      prepared!.anonymousSubjectHash,
      differentAccount!.userId,
    ),
    undefined,
  );

  const invalidBefore = fixture.bySubject.size;
  const invalid = await repository.verifyAndRegister({
    challengeId: "invalid:expired",
    phoneHash: "5".repeat(64),
    otpHash: "6".repeat(64),
    maskedPhone: "+8618******00",
    locale: "zh-CN",
    claim: {
      ...prepared!,
      anonymousSubjectHash: "e".repeat(64),
      idempotencyKey: "claim:invalid-otp",
      requestFingerprint: "d".repeat(64),
    },
  });
  assert.equal(invalid, undefined);
  assert.equal(fixture.bySubject.size, invalidBefore);

  const secondSubject = getOrCreateAnonymousSubject(
    new Request("https://fixture.invalid/api/account/me"),
    anonymousEnvironment,
    now + 10,
  )!;
  const secondRequest = new Request(
    "https://fixture.invalid/api/auth/phone/verify",
    {
      headers: {
        cookie:
          `aistory_anonymous_subject=${encodeURIComponent(secondSubject.token)}`,
      },
    },
  );
  const concurrentBase = await prepareServerAnonymousClaim(
    secondRequest,
    manifest("claim:concurrent-subject"),
    {
      resolveStory: async () => true,
      resolveCacheReference: async () => true,
      resolveAssignment: async () => true,
    },
  );
  const [concurrentOne, concurrentTwo] = await Promise.all([
    repository.verifyAndRegister({
      challengeId: "valid:concurrent-1",
      phoneHash: "7".repeat(64),
      otpHash: "8".repeat(64),
      maskedPhone: "+8617******00",
      locale: "zh-CN",
      claim: concurrentBase!,
    }),
    repository.verifyAndRegister({
      challengeId: "valid:concurrent-2",
      phoneHash: "9".repeat(64),
      otpHash: "0".repeat(64),
      maskedPhone: "+8619******00",
      locale: "zh-CN",
      claim: {
        ...concurrentBase!,
        idempotencyKey: "claim:concurrent-other-user",
        requestFingerprint: "c".repeat(64),
      },
    }),
  ]);
  assert.deepEqual(
    [concurrentOne?.claim?.status, concurrentTwo?.claim?.status].sort(),
    ["claimed", "conflict"],
  );

  const clientSource = await readFile(
    path.join(process.cwd(), "lib", "auth", "anonymousClaimClient.ts"),
    "utf8",
  );
  assert.equal(clientSource.includes("infiplot:model"), false);
  assert.equal(clientSource.includes("aistory:credit-ledger:v2"), false);
  assert.equal(clientSource.includes("Object.keys(window.localStorage)"), false);
  assert.equal(clientSource.includes("window.localStorage.length"), false);
  assert.equal(
    clientSource.includes("STORY_CLAIM_RECEIPTS_STORE"),
    true,
    "crash recovery must retain a durable local claim receipt",
  );
  assert.equal(
    clientSource.includes(
      "[STORIES_STORE, STORY_CLAIM_STAGING_STORE, STORY_CLAIM_RECEIPTS_STORE]",
    ),
    true,
    "copy, commit receipt and source cleanup must share one IDB transaction",
  );

  const migration = await readFile(
    path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "20260729183000_anonymous_phone_claim_gate.sql",
    ),
    "utf8",
  );
  for (
    const fragment of [
      "public.aistory_verify_phone_and_register",
      "public.anonymous_subject_bindings",
      "public.anonymous_subject_claims",
      "anonymous_subject_hash text primary key",
      "idempotency_key text not null unique",
      "pg_advisory_xact_lock",
      "deferrable initially deferred",
      "identity claim records are append-only",
      "public.aistory_get_anonymous_claim_receipt",
      "accepted_assignments",
      "force row level security",
      "revoke insert, update, delete",
      "to service_role",
    ]
  ) {
    assert.equal(
      migration.includes(fragment),
      true,
      `missing anonymous claim SQL contract: ${fragment}`,
    );
  }
  for (
    const forbidden of [
      "phone_plaintext",
      "otp_plaintext",
      "api_key",
      "demo_credit",
      "story_body",
      "prompt_text",
    ]
  ) {
    assert.equal(migration.includes(forbidden), false, forbidden);
  }

  delete process.env.AISTORY_ANONYMOUS_SESSION_SECRET;
  let providerCalls = 0;
  await assert.rejects(
    requestPhoneOtp({
      phone: "13800138000",
      ip: "203.0.113.9",
      provider: {
        id: "aliyun_dysms",
        available: true,
        async sendVerificationCode() {
          providerCalls += 1;
        },
      },
    }),
    ProductionDatabaseGateError,
  );
  assert.equal(
    providerCalls,
    0,
    "missing anonymous production gate must fail before SMS",
  );

  const serializedCalls = JSON.stringify(fixture.calls);
  for (
    const forbidden of [
      "fixture-service-role-never-log",
      created!.token,
      "13800138000",
      "apiKey",
      "prompt",
    ]
  ) {
    assert.equal(serializedCalls.includes(forbidden), false, forbidden);
  }

  console.log("anonymous browser to phone account claim tests passed");
} finally {
  restoreEnvironment(originalEnv);
}
