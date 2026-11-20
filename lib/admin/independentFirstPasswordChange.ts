import "server-only";

import { randomBytes } from "node:crypto";
import {
  projectIndependentAdminPrincipalCredentialBinding,
  validateIndependentAdminPrincipalCredential,
  type IndependentAdminPrincipalCredential,
} from "./independentPrincipal";
import {
  SupabaseIndependentAdminPrincipalRepository,
  IndependentAdminPrincipalRepositoryError,
  type IndependentAdminPrincipalRpcClient,
} from "./independentPrincipalRepository";

export const FIRST_PASSWORD_CHANGE_GATE = "20260831113000";
export const FIRST_PASSWORD_CHANGE_ENV = "AISTORY_ADMIN_FIRST_PASSWORD_CHANGE_VERSION";
// Admission v2 is an explicit opt-in. The already-applied DB adjunct and its
// atomic verifier/family/audit contract keep their immutable v1 gate identity.
export const FIRST_PASSWORD_CHANGE_POLICY = "independent_admin_pending_activation_v2";
export type FirstPasswordState = Readonly<{
  credential: IndependentAdminPrincipalCredential;
  mustChangePassword: boolean;
  revision: number;
}>;

export function exactFirstChangeRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === "string"
    && keys.includes(key) && !!Object.getOwnPropertyDescriptor(value, key)
    && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}

function fail(): never { throw new IndependentAdminPrincipalRepositoryError(); }

export function firstChangeBinding(credential: IndependentAdminPrincipalCredential) {
  const b = projectIndependentAdminPrincipalCredentialBinding(credential);
  return { principal_ref: b.principalId, credential_binding_sha256: b.credentialBindingSha256,
    credential_epoch_sha256: b.credentialEpochSha256,
    password_verifier_reference_sha256: b.passwordVerifierReferenceSha256,
    password_algorithm: b.passwordAlgorithm, password_parameters: b.passwordParameters };
}

export function firstChangePasswordState(credential: IndependentAdminPrincipalCredential) {
  return { credentialEpoch: credential.credentialEpoch, passwordVerifier: credential.passwordVerifier };
}

export async function assertFirstPasswordChangeGate(client: IndependentAdminPrincipalRpcClient) {
  const result = await client.rpc("aistory_iap_first_change_posture");
  if (result.error || result.data !== FIRST_PASSWORD_CHANGE_GATE) fail();
}

export async function readFirstPasswordState(client: IndependentAdminPrincipalRpcClient,
  seed: IndependentAdminPrincipalCredential): Promise<FirstPasswordState> {
  await assertFirstPasswordChangeGate(client);
  const root = projectIndependentAdminPrincipalCredentialBinding(seed);
  const result = await client.rpc("aistory_iap_first_change_read_credential", { request_payload: {
    principal_ref: root.principalId, root_binding_sha256: root.credentialBindingSha256,
  } });
  const d = result.data;
  if (result.error || !exactFirstChangeRecord(d, ["password_state", "must_change_password", "revision", "binding"])
    || !exactFirstChangeRecord(d.password_state, ["credentialEpoch", "passwordVerifier"])
    || typeof d.must_change_password !== "boolean" || !Number.isSafeInteger(d.revision)
    || (d.revision as number) < 1 || (d.must_change_password ? d.revision !== 1 : d.revision !== 2)) fail();
  const credential = validateIndependentAdminPrincipalCredential({ ...seed, ...d.password_state });
  const expected = firstChangeBinding(credential);
  const receivedBinding = d.binding;
  if (!exactFirstChangeRecord(receivedBinding, Object.keys(expected))) fail();
  const parameters = receivedBinding.password_parameters;
  if (!exactFirstChangeRecord(parameters, Object.keys(expected.password_parameters))
    || Object.entries(expected.password_parameters).some(([k,v]) => parameters[k] !== v)
    || Object.entries(expected).some(([k,v]) => k !== "password_parameters" && receivedBinding[k] !== v)) fail();
  return Object.freeze({ credential, revision: d.revision as number, mustChangePassword: d.must_change_password });
}

export class FirstPasswordChangeRepository extends SupabaseIndependentAdminPrincipalRepository {
  constructor(private readonly firstClient: IndependentAdminPrincipalRpcClient,
    readonly state: FirstPasswordState) {
    super(firstClient, projectIndependentAdminPrincipalCredentialBinding(state.credential));
  }

  override async isSessionCurrent(input: { principalId: string; sessionIdHash: string; now: number }): Promise<boolean> {
    if (input.principalId !== this.state.credential.principalId || !/^[a-f0-9]{64}$/.test(input.sessionIdHash)
      || !Number.isSafeInteger(input.now)) fail();
    const result = await this.firstClient.rpc("aistory_iap_first_change_verify_session", { request_payload: {
      ...firstChangeBinding(this.state.credential), session_hash: input.sessionIdHash,
      occurred_at: new Date(input.now).toISOString(),
    } });
    if (result.error) fail();
    if (result.data === null) return false;
    if (!exactFirstChangeRecord(result.data, ["active", "must_change_password"])
      || result.data.active !== true || result.data.must_change_password !== this.state.mustChangePassword) fail();
    return true;
  }

  async reservePasswordChange(sessionHash: string): Promise<string | undefined> {
    const ticket = randomBytes(32).toString("hex");
    const result = await this.firstClient.rpc("aistory_iap_first_change_reserve", { request_payload: {
      ...firstChangeBinding(this.state.credential), session_hash: sessionHash, ticket_hash: ticket,
    } });
    if (result.error || !exactFirstChangeRecord(result.data, ["allowed"]) || typeof result.data.allowed !== "boolean") fail();
    return result.data.allowed ? ticket : undefined;
  }

  async recordRestrictedAccess(sessionHash: string): Promise<void> {
    const result = await this.firstClient.rpc("aistory_iap_first_change_access_denied", { request_payload: {
      ...firstChangeBinding(this.state.credential), session_hash: sessionHash,
    } });
    if (result.error || result.data !== true) fail();
  }

  async changePassword(input: { sessionHash: string; ticket: string; next: IndependentAdminPrincipalCredential }): Promise<void> {
    const result = await this.firstClient.rpc("aistory_iap_first_change_complete", { request_payload: {
      current_binding: firstChangeBinding(this.state.credential), session_hash: input.sessionHash,
      ticket_hash: input.ticket, next_binding: firstChangeBinding(input.next),
      password_state: firstChangePasswordState(input.next),
      request_id: `ipr_${randomBytes(32).toString("base64url")}`,
    } });
    // Uncertain commits never issue a cookie or retry. Re-login with the new
    // password is the recovery path if the DB committed but its reply was lost.
    if (result.error || result.data !== true) fail();
  }
}
