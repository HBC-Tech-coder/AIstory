import "server-only";
import { assertProductionDatabaseGateReady, createProductionSupabaseServiceClient } from "@/lib/production/databaseGate";
import { decideAiUserAccountLink } from "./aiUserAccountLinkPolicy";
import type { AiUserAccountLinkRepository, AiUserLinkSessionRevocations } from "./aiUserAccountLinkService";

export const AIUSER_LINK_GATE = "20260901040000";
export interface AiUserLinkRpcClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
function unavailable(): never { throw Error("ACCOUNT_LINK_UNAVAILABLE"); }
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validRevocations(input: AiUserLinkSessionRevocations): boolean {
  return !!input && Object.keys(input).length === 2
    && (input.aiuser === null || (Object.keys(input.aiuser).length === 2
      && HEX.test(input.aiuser.principalKey) && HEX.test(input.aiuser.sessionBinding)))
    && (input.phone === null || (Object.keys(input.phone).length === 2
      && UUID.test(input.phone.userId) && HEX.test(input.phone.sessionBinding)))
    && (input.aiuser !== null || input.phone !== null);
}
export function createAiUserAccountLinkRepository(client: AiUserLinkRpcClient,
  baseReady: () => Promise<void>, now = Date.now): AiUserAccountLinkRepository {
  async function ready() {
    await baseReady();
    const result = await client.rpc("aistory_aiuser_link_posture_claims_v1");
    if (result.error || result.data !== AIUSER_LINK_GATE) unavailable();
  }
  return {
    assertReady: ready,
    async isLinked(principalKey) {
      if (!HEX.test(principalKey)) unavailable();
      await ready();
      const result = await client.rpc("aistory_aiuser_link_is_linked_claims_v1", { principal_hash: principalKey });
      if (result.error || typeof result.data !== "boolean") unavailable();
      return result.data;
    },
    async prepare(input) {
      if (!decideAiUserAccountLink({ ...input, existingByAiuser: null, existingByPhone: null }, now()).ok) unavailable();
      await ready();
      const result = await client.rpc("aistory_aiuser_link_prepare_claims_v1", { request_payload: input });
      if (result.error || result.data !== "prepared") unavailable();
    },
    async commit(input) {
      if (!decideAiUserAccountLink({ ...input, existingByAiuser: null, existingByPhone: null }, now()).ok) unavailable();
      await ready(); // Uncached independent posture at every mutation, also checked inside the RPC.
      const result = await client.rpc("aistory_aiuser_link_confirm_claims_v1", { request_payload: input });
      if (result.error || (result.data !== "linked" && result.data !== "already_linked")) unavailable();
      return result.data;
    },
    async revokeSessions(input) {
      if (!validRevocations(input)) unavailable();
      await ready();
      const result = await client.rpc("aistory_aiuser_link_revoke_sessions_claims_v1", { request_payload: input });
      if (result.error || result.data !== true) unavailable();
    },
  };
}
export function productionAiUserAccountLinkRepository(): AiUserAccountLinkRepository {
  const client = createProductionSupabaseServiceClient();
  return createAiUserAccountLinkRepository(client, () => assertProductionDatabaseGateReady("identity", client));
}
