import "server-only";

import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

import {
  assertProductionDatabaseGate,
  PRODUCTION_IDENTITY_DB_GATE_VERSION,
  ProductionDatabaseGateError,
} from "@/lib/production/databaseGate";
import { PhoneAuthError } from "./smsProvider";

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
};

export interface ProductionPhoneIdentityRepository {
  readonly source: "supabase";
  assertReady(): Promise<void>;
  createPendingChallenge(challenge: PendingPhoneChallenge): Promise<void>;
  markChallengeSent(challengeId: string): Promise<boolean>;
  invalidateChallenge(challengeId: string): Promise<void>;
  validateActiveUser(userId: string): Promise<boolean>;
  verifyAndRegister(input: {
    challengeId: string;
    phoneHash: string;
    otpHash: string;
    maskedPhone: string;
    locale: string;
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

export class SupabasePhoneIdentityRepository
  implements ProductionPhoneIdentityRepository {
  readonly source = "supabase" as const;
  private gateVerified = false;

  constructor(private readonly client: PhoneIdentityRpcClient) {}

  async assertReady(): Promise<void> {
    assertProductionDatabaseGate("identity");
    if (this.gateVerified) return;
    const result = await this.client.rpc("aistory_database_gate_status");
    if (result.error) rpcError(result.error);
    if (result.data !== PRODUCTION_IDENTITY_DB_GATE_VERSION) {
      throw new ProductionDatabaseGateError();
    }
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

  async verifyAndRegister(input: {
    challengeId: string;
    phoneHash: string;
    otpHash: string;
    maskedPhone: string;
    locale: string;
  }): Promise<VerifiedPhoneAccount | undefined> {
    await this.assertReady();
    const result = await this.client.rpc("aistory_verify_phone_and_register", {
      verification: {
        challenge_id: input.challengeId,
        phone_hash: input.phoneHash,
        otp_hash: input.otpHash,
        masked_phone: input.maskedPhone,
        locale: input.locale,
      },
    });
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
    };
  }
}

let productionRepository: SupabasePhoneIdentityRepository | undefined;

export function getProductionPhoneIdentityRepository():
  SupabasePhoneIdentityRepository {
  assertProductionDatabaseGate("identity");
  if (productionRepository) return productionRepository;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  productionRepository = new SupabasePhoneIdentityRepository(
    createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
  return productionRepository;
}
