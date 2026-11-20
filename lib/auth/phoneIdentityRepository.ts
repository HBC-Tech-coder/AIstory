import "server-only";

import {
  type SupabaseClient,
} from "@supabase/supabase-js";

import {
  assertProductionDatabaseGate,
  assertProductionDatabaseGateReady,
  createProductionSupabaseServiceClient,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import { PhoneAuthError } from "./smsProvider";
import {
  emptyAnonymousClaimResult,
  type AnonymousClaimResult,
  type AnonymousClaimSkipReason,
} from "./anonymousClaim";
import type { ServerAnonymousClaim } from "./anonymousClaimServer";
import { PHONE_OTP_COOLDOWN_SECONDS } from "./phoneOtpPolicy";

export type PendingPhoneChallenge = {
  id: string;
  phoneHash: string;
  otpHash: string;
  requestIpHash: string;
};

export type VerifiedPhoneAccount = {
  userId: string;
  maskedPhone: string;
  created: boolean;
  initialGrantApplied: boolean;
  balance: number;
  claim?: AnonymousClaimResult;
};

export interface ProductionPhoneIdentityRepository {
  readonly source: "supabase";
  assertReady(): Promise<void>;
  createPendingChallenge(challenge: PendingPhoneChallenge): Promise<void>;
  markChallengeSent(challengeId: string): Promise<boolean>;
  invalidateChallenge(challengeId: string): Promise<void>;
  validateActiveUser(userId: string): Promise<boolean>;
  getClaimReceipt(
    anonymousSubjectHash: string,
    userId: string,
  ): Promise<AnonymousClaimResult | undefined>;
  verifyAndRegister(input: {
    challengeId: string;
    phoneHash: string;
    otpHash: string;
    maskedPhone: string;
    locale: string;
    claim?: ServerAnonymousClaim;
  }): Promise<VerifiedPhoneAccount | undefined>;
}

type RpcError = { message?: string; code?: string } | null;
export type PhoneIdentityRpcClient = Pick<SupabaseClient, "rpc">;

function rpcError(
  error: RpcError,
  options?: { rateLimited?: boolean },
): never {
  if (
    options?.rateLimited
    && (
      error?.message?.includes("SMS_RATE_LIMITED")
      || error?.code === "SMS_RATE_LIMITED"
    )
  ) {
    throw new PhoneAuthError(
      "SMS_RATE_LIMITED",
      429,
      "验证码请求过于频繁，请稍后再试。",
      PHONE_OTP_COOLDOWN_SECONDS,
    );
  }
  throw new ProductionDatabaseGateError();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function integerValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

const SAFE_CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const SAFE_ASSIGNMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,320}$/;

function parseClaimResult(value: unknown): AnonymousClaimResult | undefined {
  const data = record(value);
  if (!data) return undefined;
  const status = String(data.status || "");
  if (
    !["claimed", "replayed", "not_found", "conflict", "empty"].includes(
      status,
    )
  ) {
    return undefined;
  }
  const rawStoryRecordIds = Array.isArray(data.accepted_story_record_ids)
    ? data.accepted_story_record_ids
    : [];
  const acceptedStoryRecordIds = rawStoryRecordIds.filter(
    (item): item is string =>
      typeof item === "string" && SAFE_CLAIM_ID.test(item),
  );
  const rawAssignmentKeys = Array.isArray(data.accepted_assignment_keys)
    ? data.accepted_assignment_keys
    : [];
  const acceptedAssignmentKeys = rawAssignmentKeys.filter(
    (item): item is string =>
      typeof item === "string" && SAFE_ASSIGNMENT_KEY.test(item),
  );
  const acceptedAssignments = Array.isArray(data.accepted_assignments)
    ? data.accepted_assignments.flatMap((value) => {
        const item = record(value);
        const experimentKey = stringValue(item?.experiment_key);
        const experimentVersion = stringValue(item?.experiment_version);
        const variantKey = stringValue(item?.variant_key);
        if (
          !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(experimentKey)
          || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(
            experimentVersion,
          )
          || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(variantKey)
        ) {
          return [];
        }
        return [{ experimentKey, experimentVersion, variantKey }];
      })
    : [];
  const counts = record(data.counts) || {};
  const skippedByReason = record(data.skipped_by_reason) || {};
  const parsedCounts = {
    submittedStories: integerValue(counts.submitted_stories),
    inheritedStories: integerValue(counts.inherited_stories),
    inheritedCheckpoints: integerValue(counts.inherited_checkpoints),
    inheritedCacheReferences: integerValue(
      counts.inherited_cache_references,
    ),
    inheritedAssignments: integerValue(counts.inherited_assignments),
    skipped: integerValue(counts.skipped),
  };
  if (
    parsedCounts.submittedStories === undefined
    || parsedCounts.submittedStories < 0
    || parsedCounts.submittedStories > 50
    || parsedCounts.inheritedStories === undefined
    || parsedCounts.inheritedStories < 0
    || parsedCounts.inheritedStories > 50
    || parsedCounts.inheritedCheckpoints === undefined
    || parsedCounts.inheritedCheckpoints < 0
    || parsedCounts.inheritedCheckpoints > 25_600
    || parsedCounts.inheritedCacheReferences === undefined
    || parsedCounts.inheritedCacheReferences < 0
    || parsedCounts.inheritedCacheReferences > 100
    || parsedCounts.inheritedAssignments === undefined
    || parsedCounts.inheritedAssignments < 0
    || parsedCounts.inheritedAssignments > 32
    || parsedCounts.skipped === undefined
    || parsedCounts.skipped < 0
    || parsedCounts.skipped > 182
  ) {
    throw new ProductionDatabaseGateError();
  }
  const result: AnonymousClaimResult = {
    ...emptyAnonymousClaimResult(
      status as AnonymousClaimResult["status"],
    ),
    ...(typeof data.claim_id === "string"
      ? { claimId: data.claim_id }
      : {}),
    acceptedStoryRecordIds,
    acceptedAssignmentKeys,
    acceptedAssignments,
    counts: parsedCounts as AnonymousClaimResult["counts"],
    skippedByReason: Object.fromEntries(
      Object.entries(skippedByReason).flatMap(([key, amount]) => {
        const parsed = integerValue(amount);
        return parsed !== undefined
          && parsed >= 0
          && CLAIM_SKIP_REASONS.has(key as AnonymousClaimSkipReason)
          ? [[key, parsed]]
          : [];
      }),
    ),
  };
  if (
    acceptedStoryRecordIds.length !== rawStoryRecordIds.length ||
    acceptedAssignmentKeys.length !== rawAssignmentKeys.length ||
    result.acceptedStoryRecordIds.length > 50 ||
    result.acceptedAssignmentKeys.length > 32 ||
    result.acceptedAssignments.length > 32 ||
    new Set(result.acceptedStoryRecordIds).size
      !== result.acceptedStoryRecordIds.length ||
    new Set(result.acceptedAssignmentKeys).size
      !== result.acceptedAssignmentKeys.length ||
    new Set(
      result.acceptedAssignments.map(
        (assignment) =>
          `${assignment.experimentKey}:${assignment.experimentVersion}`,
      ),
    ).size !== result.acceptedAssignments.length ||
    result.acceptedAssignmentKeys.some(
      (key) =>
        !result.acceptedAssignments.some(
          (assignment) =>
            `${assignment.experimentKey}:${assignment.experimentVersion}`
              === key,
        ),
    ) ||
    (
      ["claimed", "replayed", "empty"].includes(result.status) &&
      !result.claimId
    )
  ) {
    throw new ProductionDatabaseGateError();
  }
  return result;
}

const CLAIM_SKIP_REASONS = new Set<AnonymousClaimSkipReason>([
  "not_published",
  "version_mismatch",
  "node_unavailable",
  "resource_unavailable",
  "assignment_unavailable",
  "manifest_invalid",
]);

export class SupabasePhoneIdentityRepository
  implements ProductionPhoneIdentityRepository {
  readonly source = "supabase" as const;
  private gateVerified = false;

  constructor(private readonly client: PhoneIdentityRpcClient) {}

  async assertReady(): Promise<void> {
    if (this.gateVerified) return;
    await assertProductionDatabaseGateReady("identity", this.client);
    this.gateVerified = true;
  }

  async createPendingChallenge(
    challenge: PendingPhoneChallenge,
  ): Promise<void> {
    await this.assertReady();
    const result = await this.client.rpc("aistory_create_phone_challenge", {
      challenge: {
        id: challenge.id,
        phone_hash: challenge.phoneHash,
        otp_hash: challenge.otpHash,
        request_ip_hash: challenge.requestIpHash,
      },
    });
    if (result.error) rpcError(result.error, { rateLimited: true });
    if (result.data !== challenge.id) {
      throw new ProductionDatabaseGateError();
    }
  }

  async markChallengeSent(challengeId: string): Promise<boolean> {
    await this.assertReady();
    const result = await this.client.rpc("aistory_mark_phone_challenge_sent", {
      challenge_id: challengeId,
    });
    if (result.error) rpcError(result.error);
    return result.data === true;
  }

  async invalidateChallenge(challengeId: string): Promise<void> {
    await this.assertReady();
    const result = await this.client.rpc(
      "aistory_invalidate_phone_challenge",
      { challenge_id: challengeId },
    );
    if (result.error) rpcError(result.error);
  }

  async validateActiveUser(userId: string): Promise<boolean> {
    await this.assertReady();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(userId)
    ) return false;
    const result = await this.client.rpc("aistory_validate_phone_session", {
      app_user_id: userId,
    });
    if (result.error) rpcError(result.error);
    return result.data === true;
  }

  async getClaimReceipt(
    anonymousSubjectHash: string,
    userId: string,
  ): Promise<AnonymousClaimResult | undefined> {
    await this.assertReady();
    if (
      !/^[a-f0-9]{64}$/.test(anonymousSubjectHash) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(userId)
    ) {
      return undefined;
    }
    const result = await this.client.rpc(
      "aistory_get_anonymous_claim_receipt",
      {
        anonymous_subject_hash: anonymousSubjectHash,
        app_user_id: userId,
      },
    );
    if (result.error) rpcError(result.error);
    return parseClaimResult(result.data);
  }

  async verifyAndRegister(input: {
    challengeId: string;
    phoneHash: string;
    otpHash: string;
    maskedPhone: string;
    locale: string;
    claim?: ServerAnonymousClaim;
  }): Promise<VerifiedPhoneAccount | undefined> {
    await this.assertReady();
    const result = await this.client.rpc(
      "aistory_verify_phone_register_and_claim",
      {
        verification: {
          challenge_id: input.challengeId,
          phone_hash: input.phoneHash,
          otp_hash: input.otpHash,
          masked_phone: input.maskedPhone,
          locale: input.locale,
          ...(input.claim ? { anonymous_claim: input.claim } : {}),
        },
      },
    );
    if (result.error) rpcError(result.error);
    const data = record(result.data);
    if (!data || data.status !== "verified") return undefined;
    const userId = stringValue(data.user_id);
    const maskedPhone = stringValue(data.masked_phone);
    const balance = integerValue(data.balance);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(userId)
      || !maskedPhone.includes("*")
      || balance === undefined
    ) {
      throw new ProductionDatabaseGateError();
    }
    return {
      userId,
      maskedPhone,
      created: booleanValue(data.created),
      initialGrantApplied: booleanValue(data.initial_grant_applied),
      balance,
      ...(data.claim ? { claim: parseClaimResult(data.claim) } : {}),
    };
  }
}

let productionRepository: SupabasePhoneIdentityRepository | undefined;

export function getProductionPhoneIdentityRepository():
  SupabasePhoneIdentityRepository {
  assertProductionDatabaseGate("identity");
  if (productionRepository) return productionRepository;
  productionRepository = new SupabasePhoneIdentityRepository(
    createProductionSupabaseServiceClient(),
  );
  return productionRepository;
}
