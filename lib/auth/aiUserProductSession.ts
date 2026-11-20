import "server-only";

import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { oidcData, type AiUserVerifiedIdentity, createAiUserOidcCallback, assertAiUserRequestOrigin,
  readAiUserTransactionHash, readAiUserTransactionLineage, readAiUserPendingRevocations,
  type AiUserOidcCallbackDependencies } from "./aiUserOidcCallback";
import { AIUSER_ACCOUNT_PATH, aiUserPublicAccount } from "./aiUserAccountPublic";
import { createAiUserLinkIntents } from "./aiUserAccountLinkSession";
import { AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION as AIUSER_PRODUCTION_BETA_REGISTRATION,
  AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256 as AIUSER_PRODUCTION_BETA_REGISTRATION_SHA256 } from "./aiUserOidcProductionBeta";

export const AIUSER_PRODUCT_SESSION_COOKIE = "__Host-aistory_aiuser_user_v1";
export const AIUSER_USER_INTEGRATION_MODE = "aistory-aiuser-user-integration-v1:enabled";
export const AIUSER_USER_INTEGRATION_ENV = "AISTORY_AIUSER_USER_INTEGRATION_MODE";
const issuer = AIUSER_PRODUCTION_BETA_REGISTRATION.issuerUrl;
const origin = AIUSER_PRODUCTION_BETA_REGISTRATION.publicOrigin;
const registration = AIUSER_PRODUCTION_BETA_REGISTRATION_SHA256;
const HEX = /^[a-f0-9]{64}$/;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const IDP_AUTH_TIME_SKEW_SECONDS = 5;

export type AiUserBusinessSession = Readonly<{
  /** A domain-separated application identifier, not a phone UUID. Server-private. */
  principalKey: string;
  sessionBinding: string;
  transactionHash: string;
  lineage: string;
  /** Local encrypted-product-session issuance time. Never a reauthentication proof. */
  sessionIssuedAt: number;
  /** Signed ID-token auth_time in milliseconds, or null when the IdP supplied no such evidence. */
  idpAuthenticatedAt: number | null;
  expiresAt: number;
  membershipGeneration: number;
}>;

export type AiUserSessionDependencies = {
  clientSecret: string;
  now: () => number;
  random?: (length: number) => Uint8Array;
  /** Both operations use the existing protected, shared, durable hash-only replay store. */
  isClaimed: (digest: string) => Promise<boolean>;
  claimOnce: (digest: string) => Promise<boolean>;
};

function reject(): never { throw new Error("AIUSER_SESSION_REJECTED"); }
async function hasEmptyDeleteBody(request: Request): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if ((contentLength !== null && contentLength !== "0") || request.headers.has("transfer-encoding")) return false;
  if (request.body === null) return true;
  const reader = request.body.getReader();
  try {
    // Next's Node adapter represents a completed zero-byte DELETE as a stream.
    // One read is sufficient: any yielded chunk is an ambiguous/non-empty body
    // and is rejected rather than draining attacker-controlled input.
    return (await reader.read()).done === true;
  } finally { await reader.cancel().catch(() => undefined); }
}
export function aiUserSessionDigest(domain: "session" | "transaction" | "lineage", value: string): string {
  if (!HEX.test(value)) return reject();
  return createHash("sha256").update(`aistory.aiuser.logout.${domain}.v1\0${value}`).digest("hex");
}
export function hasAiUserProductCookie(request: Request): boolean {
  return (request.headers.get("cookie") ?? "").split(";").some((item) => item.trim().startsWith(`${AIUSER_PRODUCT_SESSION_COOKIE}=`));
}
export function clearAiUserProductCookie(): string {
  return `${AIUSER_PRODUCT_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export function createAiUserProductSession(deps: AiUserSessionDependencies) {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(deps.clientSecret)) reject();
  const key = new Uint8Array(hkdfSync("sha256", deps.clientSecret, registration, "aistory.aiuser.business-session.v1", 32));
  const seconds = () => Math.floor(deps.now() / 1000);

  async function decode(request: Request, revocationOnly = false): Promise<AiUserBusinessSession | null> {
    try {
      const raw = request.headers.get("cookie") ?? "";
      const parts = raw.split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${AIUSER_PRODUCT_SESSION_COOKIE}=`));
      if (raw.length > 16384 || parts.length !== 1) return null;
      const token = parts[0]!.slice(AIUSER_PRODUCT_SESSION_COOKIE.length + 1);
      if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(token)) return null;
      const { payload, protectedHeader } = await jwtDecrypt(token, key, {
        issuer: origin, audience: "aistory-aiuser-business-v1", keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"], clockTolerance: 0,
        // Expired envelopes may identify a family for revocation only, never authentication.
        currentDate: new Date(revocationOnly ? 0 : deps.now()), requiredClaims: ["iat", "exp", "iss", "aud"],
      });
      oidcData(payload);
      const legacyFields = ["iss", "aud", "iat", "exp", "registration", "principalKey", "sid", "transactionHash", "lineage", "membershipGeneration"];
      const fields = [...legacyFields, "idpAuthenticatedAt"];
      const names = Object.keys(payload);
      const legacy = names.length === legacyFields.length && names.every((name) => legacyFields.includes(name));
      const current = names.length === fields.length && names.every((name) => fields.includes(name));
      const idpAuthenticatedAt = current ? payload.idpAuthenticatedAt : null;
      if (protectedHeader.typ !== "aistory-business+jwt" || (!legacy && !current) || payload.registration !== registration
        || typeof payload.principalKey !== "string" || !HEX.test(payload.principalKey)
        || typeof payload.sid !== "string" || !RANDOM.test(payload.sid)
        || typeof payload.transactionHash !== "string" || !HEX.test(payload.transactionHash)
        || typeof payload.lineage !== "string" || !HEX.test(payload.lineage)
        || !Number.isSafeInteger(payload.membershipGeneration) || (payload.membershipGeneration as number) < 1
        || (idpAuthenticatedAt !== null && (!Number.isSafeInteger(idpAuthenticatedAt)
          || (idpAuthenticatedAt as number) < 0 || (idpAuthenticatedAt as number) > payload.iat! + IDP_AUTH_TIME_SKEW_SECONDS))
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
        || payload.iat! > seconds() || (!revocationOnly && payload.exp! <= seconds()) || payload.exp! <= payload.iat!
        || payload.exp! - payload.iat! > 900) return null;
      const sessionBinding = createHash("sha256").update(payload.sid).digest("hex");
      return Object.freeze({ principalKey: payload.principalKey, sessionBinding,
        transactionHash: payload.transactionHash, lineage: payload.lineage, sessionIssuedAt: payload.iat! * 1000,
        idpAuthenticatedAt: idpAuthenticatedAt === null ? null : (idpAuthenticatedAt as number) * 1000,
        expiresAt: payload.exp! * 1000, membershipGeneration: payload.membershipGeneration as number });
    } catch { return null; }
  }

  async function read(request: Request): Promise<AiUserBusinessSession | null> {
    const session = await decode(request);
    if (!session) return null;
    try {
      if (await deps.isClaimed(aiUserSessionDigest("session", session.sessionBinding))
        || await deps.isClaimed(aiUserSessionDigest("transaction", session.transactionHash))
        || await deps.isClaimed(aiUserSessionDigest("lineage", session.lineage))) return null;
      return session;
    } catch { return null; }
  }

  async function revoke(request: Request, pendingTransactionHash?: string, pendingLineage?: string): Promise<void> {
    // Decode independently of the store: an unavailable revocation read must not
    // turn logout into apparent success while a reusable cookie remains valid.
    const session = await decode(request, true);
    if (session) {
      await deps.claimOnce(aiUserSessionDigest("session", session.sessionBinding));
      await deps.claimOnce(aiUserSessionDigest("transaction", session.transactionHash));
      await deps.claimOnce(aiUserSessionDigest("lineage", session.lineage));
    }
    if (pendingTransactionHash) await deps.claimOnce(aiUserSessionDigest("transaction", pendingTransactionHash));
    if (pendingLineage) await deps.claimOnce(aiUserSessionDigest("lineage", pendingLineage));
  }

  return {
    read, revoke,
    async lineage(request: Request): Promise<string | undefined> {
      const session = await decode(request, true);
      const lineage = session?.lineage ?? await readAiUserTransactionLineage(request, deps.clientSecret, seconds());
      if (lineage && await deps.isClaimed(aiUserSessionDigest("lineage", lineage))) reject();
      return lineage;
    },
    async establish(identity: AiUserVerifiedIdentity, transactionHash: string, request: Request, headers: Headers, lineage = transactionHash, completionDeadline?: number): Promise<Response> {
      const now = seconds();
      oidcData(identity);
      const idpAuthenticatedAt = identity.idpAuthenticatedAt ?? null;
      if (identity.issuer !== issuer || typeof identity.subject !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(identity.subject)
        || !Number.isSafeInteger(identity.membershipGeneration) || identity.membershipGeneration < 1
        || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now || identity.expiresAt - now > 900
        || (idpAuthenticatedAt !== null && (!Number.isSafeInteger(idpAuthenticatedAt) || idpAuthenticatedAt < 0
          || idpAuthenticatedAt > now + IDP_AUTH_TIME_SKEW_SECONDS))
        || !HEX.test(transactionHash) || !HEX.test(lineage)
        || (completionDeadline !== undefined && (!Number.isSafeInteger(completionDeadline) || completionDeadline <= now))
        || await deps.isClaimed(aiUserSessionDigest("transaction", transactionHash))
        || await deps.isClaimed(aiUserSessionDigest("lineage", lineage))) reject();
      // A fresh login rotates this browser's product session, without touching phone/admin cookies.
      const previous = await decode(request, true);
      if (previous) {
        if (previous.lineage !== lineage) reject();
        await deps.claimOnce(aiUserSessionDigest("session", previous.sessionBinding));
      }
      const bytes = (deps.random ?? randomBytes)(32);
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) reject();
      const sid = Buffer.from(bytes).toString("base64url");
      const principalKey = createHash("sha256").update(`aistory.aiuser.principal.v1\0${issuer}\0${AIUSER_PRODUCTION_BETA_REGISTRATION.clientId}\0${identity.subject}`).digest("hex");
      const token = await new EncryptJWT({ registration, principalKey, sid, transactionHash, lineage,
        membershipGeneration: identity.membershipGeneration, idpAuthenticatedAt })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "aistory-business+jwt" })
        .setIssuer(origin).setAudience("aistory-aiuser-business-v1").setIssuedAt(now)
        .setExpirationTime(identity.expiresAt).encrypt(key);
      // Store checks, rotation and encryption may cross either deadline. No
      // awaited work follows this final clock check before publishing headers.
      if (seconds() >= identity.expiresAt || (completionDeadline !== undefined && seconds() >= completionDeadline)) reject();
      headers.append("Set-Cookie", `${AIUSER_PRODUCT_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${identity.expiresAt - now}`);
      headers.set("Location", AIUSER_ACCOUNT_PATH);
      return new Response(null, { status: 303, headers });
    },
    async account(request: Request) {
      const session = await read(request);
      return session ? aiUserPublicAccount(session.expiresAt) : null;
    },
  };
}

/** Same composition for production and injected isolated HTTP tests; no environment bypass. */
export function createAiUserUserRuntime(deps: AiUserSessionDependencies & AiUserOidcCallbackDependencies) {
  const business = createAiUserProductSession(deps);
  const oidc = createAiUserOidcCallback({ ...deps,
    transactionLineage: business.lineage,
    onVerified: (identity, transaction, request, headers, lineage, completionDeadline) => business.establish(identity, transaction, request, headers, lineage, completionDeadline) });
  return { ...oidc, business: {
    read: business.read,
    startLinkReauth: oidc.startLinkReauth,
    assertLinkReauthOrigin(request: Request) {
      const url = assertAiUserRequestOrigin(request, "/api/auth/aiuser/account-link/reauth",
        deps.proxyRequestOrigin);
      if (url.search || request.method !== "POST"
        || request.headers.get("origin") !== origin
        || request.headers.get("sec-fetch-site") !== "same-origin"
        || request.headers.get("content-type") !== "application/json") reject();
    },
    linkIntents: createAiUserLinkIntents(deps.clientSecret, deps.now),
    assertLinkOrigin(request: Request) {
      const url = assertAiUserRequestOrigin(request, "/api/auth/aiuser/account-link", deps.proxyRequestOrigin);
      if (url.search || (request.method !== "GET" && request.headers.get("origin") !== origin)) reject();
    },
    async logout(request: Request) {
      const url = assertAiUserRequestOrigin(request, "/api/account/me", deps.proxyRequestOrigin);
      if (request.method !== "DELETE" || url.search || !(await hasEmptyDeleteBody(request))
        || request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") !== "same-origin") reject();
      const transaction = await readAiUserTransactionHash(request, deps.clientSecret, Math.floor(deps.now() / 1000));
      const lineage = await readAiUserTransactionLineage(request, deps.clientSecret, Math.floor(deps.now() / 1000));
      const pending = await readAiUserPendingRevocations(request, deps.clientSecret, Math.floor(deps.now() / 1000));
      await business.revoke(request, transaction, lineage);
      for (const attempt of pending) await business.revoke(request, attempt.transactionHash, attempt.lineage);
      return pending.map((attempt) => `${attempt.cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    },
  } };
}
