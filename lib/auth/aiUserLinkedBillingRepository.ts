/**
 * Server-side resolver for an already committed AIUser-to-existing-phone link.
 *
 * Contract:
 * - Input is only the authenticated AIUser product-session `principalKey`. The
 *   browser never supplies a phone UUID and never receives the resolved one.
 * - The caller must have read an active, unexpired, non-revoked AIUser product
 *   session before calling this repository. This module does not read cookies
 *   and does not decide AIUser authentication.
 * - The repository rechecks the uncached database-owned billing posture and
 *   calls the service-role-only resolver RPC on every resolution.
 * - It never links accounts, grants credits, changes identity class, reads
 *   or writes Hosted BYOK, cloud-progress or administrator state.
 *
 * The production factory is asynchronous so the pure repository and its
 * dependency-injected contract can be tested without the installed Supabase
 * dependency forest. Import this module only from server code.
 */

export const AIUSER_LINKED_BILLING_GATE = "20261115000000";

const PRINCIPAL_HASH = /^[a-f0-9]{64}$/;
const PHONE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Opaque, server-private phone account UUID used only as a billing identity.
 * The type is intentionally not constructible through the public API without
 * validation; it must never be added to an account/me DTO, a route body, a
 * cookie, a redirect or a log line.
 */
export type AiUserLinkedBillingPhoneUserId = string & {
  readonly __aiUserLinkedBillingPhoneUserId: "AiUserLinkedBillingPhoneUserId";
};

export class AiUserLinkedBillingUnavailableError extends Error {
  readonly code = "LINKED_BILLING_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super("LINKED_BILLING_UNAVAILABLE");
    this.name = "AiUserLinkedBillingUnavailableError";
  }
}

export interface AiUserLinkedBillingRpcClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface AiUserLinkedBillingRepository {
  /** Uncached independent posture read. No mapping or balance read. */
  assertReady(): Promise<void>;
  /** No active committed mapping returns null; gate/ACL/shape failures throw. */
  resolvePhoneUserId(
    principalKey: string,
  ): Promise<AiUserLinkedBillingPhoneUserId | null>;
  /**
   * Strict variant for callers that require a billable account. It throws the
   * same fixed unavailable error for unlinked, inactive and gate failures.
   */
  requirePhoneUserId(
    principalKey: string,
  ): Promise<AiUserLinkedBillingPhoneUserId>;
}

function unavailable(): never {
  throw new AiUserLinkedBillingUnavailableError();
}

export function isAiUserLinkedBillingPrincipalKey(
  value: unknown,
): value is string {
  return typeof value === "string" && PRINCIPAL_HASH.test(value);
}

export function toAiUserLinkedBillingPhoneUserId(
  value: unknown,
): AiUserLinkedBillingPhoneUserId {
  if (typeof value !== "string" || !PHONE_UUID.test(value)) unavailable();
  return value as AiUserLinkedBillingPhoneUserId;
}

export function createAiUserLinkedBillingRepository(
  client: AiUserLinkedBillingRpcClient,
  baseReady: () => Promise<void>,
): AiUserLinkedBillingRepository {
  async function ready(): Promise<void> {
    try {
      await baseReady();
    } catch {
      unavailable();
    }
    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc("aistory_aiuser_linked_billing_posture_claims_v1");
    } catch {
      unavailable();
    }
    if (!result || result.error || result.data !== AIUSER_LINKED_BILLING_GATE) {
      unavailable();
    }
  }

  async function resolvePhoneUserId(
    principalKey: string,
  ): Promise<AiUserLinkedBillingPhoneUserId | null> {
    if (!isAiUserLinkedBillingPrincipalKey(principalKey)) unavailable();
    // The RPC also checks the gate inside the database; this uncached read is
    // the independent application-side gate and is repeated per resolution.
    await ready();
    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc("aistory_aiuser_linked_billing_resolve_claims_v1", {
        // Exactly one server-derived argument. Never a phone UUID.
        principal_hash: principalKey,
      });
    } catch {
      unavailable();
    }
    if (!result || result.error) unavailable();
    // SQL NULL is the only unlinked/inactive-account outcome. A non-null value
    // must be a strict canonical lowercase UUID or the call fails closed.
    if (result.data === null) return null;
    return toAiUserLinkedBillingPhoneUserId(result.data);
  }

  return {
    assertReady: ready,
    resolvePhoneUserId,
    async requirePhoneUserId(principalKey) {
      const phoneUserId = await resolvePhoneUserId(principalKey);
      if (phoneUserId === null) unavailable();
      return phoneUserId;
    },
  };
}

type ProductionDatabaseGateModule = {
  createProductionSupabaseServiceClient(): AiUserLinkedBillingRpcClient;
  assertProductionDatabaseGateReady(
    capability: "billing",
    client?: AiUserLinkedBillingRpcClient,
  ): Promise<void>;
};

/**
 * Production composition. The dynamic import keeps the database driver out of
 * the pure contract/tests; callers still await the same fail-closed interface.
 */
export async function productionAiUserLinkedBillingRepository(): Promise<AiUserLinkedBillingRepository> {
  // Defense in depth: the production composition itself refuses to build while
  // the exact billing selector is off. Callers should also short-circuit before
  // reading an AIUser session or the database gate.
  const { aiUserLinkedBillingSelected } = await import("./aiUserLinkedBillingConfig");
  if (!aiUserLinkedBillingSelected()) unavailable();
  const gate = await import("@/lib/production/databaseGate") as ProductionDatabaseGateModule;
  const client = gate.createProductionSupabaseServiceClient();
  return createAiUserLinkedBillingRepository(client, () =>
    gate.assertProductionDatabaseGateReady("billing", client));
}
