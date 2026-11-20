import "server-only";

import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createLocalJWKSet, decodeProtectedHeader, EncryptJWT, jwtDecrypt, jwtVerify,
  type JSONWebKeySet, type JWTPayload,
} from "jose";
import {
  AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION as registration,
  AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256 as registrationSha256,
} from "./aiUserOidcProductionBeta";

export const AIUSER_CALLBACK_MODE = "aistory-aiuser-oidc-callback-v1:enabled";
export const AIUSER_REGISTRY_BINDING_SHA256 = "9b94b64cfc06ec5c2fc42726dffa3138f55d95adde7c87a1d5efbc041eebdde5";
export const AIUSER_ENDPOINTS = Object.freeze({
  discovery: `${registration.issuerUrl}/.well-known/openid-configuration`,
  authorization: `${registration.issuerUrl}/v1/oauth/authorize`,
  token: `${registration.issuerUrl}/v1/oauth/token`,
  jwks: `${registration.issuerUrl}/v1/oauth/jwks`,
});
export const AIUSER_TRANSACTION_COOKIE = "__Host-aistory_aiuser_transaction_v1";
export const AIUSER_IDENTITY_COOKIE = "__Host-aistory_aiuser_identity_v1";
export const AIUSER_PENDING_COOKIE_PREFIX = "__Host-aistory_aiuser_pending_v1_";
const SCOPE = "openid product.access";
const START_PATH = "/api/auth/aiuser/start";
const CALLBACK_PATH = "/api/auth/aiuser/callback";
const LINK_REAUTH_PATH = "/api/auth/aiuser/account-link/reauth";
const LINK_REAUTH_PURPOSE = "account_link_reauth_v1";
const CODE_SECONDS = 90;
// AIUser owns a separate ten-minute human interaction. Its 90-second
// authorization code is minted only after that interaction finishes, so the
// product transaction must cover both bounded phases rather than expiring
// while the user is still signing in or explicitly joining the product.
const INTERACTION_SECONDS = 600;
const TRANSACTION_SECONDS = INTERACTION_SECONDS + CODE_SECONDS;
const TOKEN_SECONDS = 900;
const SKEW_SECONDS = 5;
const REVOCATION_SECONDS = TRANSACTION_SECONDS + TOKEN_SECONDS + SKEW_SECONDS;
const HASH = /^[a-f0-9]{64}$/;

function fail(): never { throw new Error("aiuser_oidc_rejected"); }

// Inspect descriptors, never execute getters/toJSON from configuration or injected adapters.
export function oidcData(value: unknown, depth = 0): unknown {
  if (depth > 12) return fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return fail();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return fail();
  const out: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128) return fail();
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail();
    out[key] = oidcData(descriptor.value, depth + 1);
  }
  if (!array) return Object.fromEntries(Object.entries(out));
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length > 64 || keys.length !== length + 1) return fail();
  return Array.from({ length }, (_, i) => Object.hasOwn(out, String(i)) ? out[String(i)] : fail());
}

function record(value: unknown): Record<string, unknown> {
  const clean = oidcData(value);
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) return fail();
  return clean as Record<string, unknown>;
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) return fail();
  return result;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail();
  return value;
}

function same(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length > 4096) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function privatePath(value: unknown, root: string): string {
  if (typeof value !== "string" || !value.startsWith(`${root}/`)
    || value.length > 240 || !/^\/[A-Za-z0-9_./-]+$/.test(value)
    || value.split("/").slice(1).some((part) => !part || part === "." || part === "..")) return fail();
  return value;
}

function proxyOrigin(value: unknown): string {
  if (typeof value !== "string") return fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.origin !== value || url.username || url.password || url.search || url.hash) return fail();
  return value;
}

export type AiUserCallbackConfiguration = {
  schema: "aistory.aiuser-oidc-callback-config.v1";
  registrationSha256: string;
  registryBindingSha256: string;
  secretRef: string;
  secretFile: string;
  hostReceiptFile: string;
  hostReceiptSha256: string;
  replayDirectory: string;
  recipientUid: number;
  recipientGid: number;
  proxyRequestOrigin: string;
};

export function validateAiUserCallbackConfiguration(value: unknown): AiUserCallbackConfiguration {
  const data = exact(value, ["schema", "registrationSha256", "registryBindingSha256", "secretRef", "secretFile",
    "hostReceiptFile", "hostReceiptSha256", "replayDirectory", "recipientUid", "recipientGid", "proxyRequestOrigin"]);
  if (data.schema !== "aistory.aiuser-oidc-callback-config.v1" || data.registrationSha256 !== registrationSha256
    || data.registryBindingSha256 !== AIUSER_REGISTRY_BINDING_SHA256
    || data.secretRef !== registration.credentialReference.referenceId
    || typeof data.hostReceiptSha256 !== "string" || !HASH.test(data.hostReceiptSha256)) return fail();
  privatePath(data.secretFile, "/etc/aistory/aiuser-oidc");
  privatePath(data.hostReceiptFile, "/etc/aistory/aiuser-oidc");
  privatePath(data.replayDirectory, "/var/lib/aistory");
  if (data.secretFile === data.hostReceiptFile) return fail();
  integer(data.recipientUid, 0, 2147483647);
  integer(data.recipientGid, 0, 2147483647);
  proxyOrigin(data.proxyRequestOrigin);
  return Object.freeze(data) as AiUserCallbackConfiguration;
}

// Root/owner-protected local acceptance record, pinned by its raw bytes in config.
// This is not self-asserted browser input and does not substitute for host verification.
export function validateAiUserHostReceipt(value: unknown, config: AiUserCallbackConfiguration): void {
  const data = exact(value, ["schema", "registryBindingSha256", "registrationSha256", "registryReleaseSha256",
    "secretRef", "secretFile", "recipientUid", "recipientGid", "registryActivated", "distinctSecretDelivered",
    "recipientAclVerified", "ingressRedactionVerified", "startRateLimitVerified", "sharedReplayDirectoryVerified",
    "proxyRequestOrigin", "loopbackIngressVerified", "forwardedHeaderScrubbingVerified"]);
  if (data.schema !== "aistory.aiuser-oidc-host-acceptance.v1"
    || data.registrationSha256 !== config.registrationSha256
    || data.registryBindingSha256 !== config.registryBindingSha256
    || data.secretRef !== config.secretRef || data.secretFile !== config.secretFile
    || data.recipientUid !== config.recipientUid || data.recipientGid !== config.recipientGid
    || data.proxyRequestOrigin !== config.proxyRequestOrigin
    || typeof data.registryReleaseSha256 !== "string" || !HASH.test(data.registryReleaseSha256)) return fail();
  for (const key of ["registryActivated", "distinctSecretDelivered", "recipientAclVerified", "ingressRedactionVerified",
    "startRateLimitVerified", "sharedReplayDirectoryVerified", "loopbackIngressVerified",
    "forwardedHeaderScrubbingVerified"]) if (data[key] !== true) return fail();
}

export interface AiUserOidcCallbackDependencies {
  /** The composition root has checked protected config + receipt + actual UID/ACL on every request. */
  clientSecret: string;
  fetch: typeof fetch;
  now: () => number;
  random?: (bytes: number) => Uint8Array;
  /** Must atomically persist a hash-only claim shared by all workers; never an in-memory production map. */
  claimOnce: (stateSha256: string) => Promise<boolean>;
  allowStart: () => boolean;
  /** Exact framework-normalized internal request origin from verified loopback/proxy receipt. */
  proxyRequestOrigin?: string;
  /** Optional application composition, called only after complete ID/resource verification. */
  onVerified?: (identity: AiUserVerifiedIdentity, transactionHash: string, request: Request, headers: Headers, lineage?: string, completionDeadline?: number) => Promise<Response>;
  /** Fixed-enum, server-private rejection phase only; never receives request, token, claim, cookie, URL or error data. */
  onCallbackRejected?: (stage: AiUserCallbackRejectionStage) => void;
  transactionLineage?: (request: Request) => Promise<string | undefined>;
}

export const AIUSER_CALLBACK_REJECTION_STAGES = Object.freeze([
  "transaction", "claimOnce", "discovery", "token_exchange", "token_shape", "jwks",
  "id_verify", "access_verify", "claims", "completion_deadline", "session_establish",
] as const);

export type AiUserCallbackRejectionStage = typeof AIUSER_CALLBACK_REJECTION_STAGES[number];

function key(secret: string, purpose: "transaction" | "identity" | "revocation"): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(secret)) return fail();
  return new Uint8Array(hkdfSync("sha256", secret, registrationSha256, `aistory.aiuser.${purpose}.v1`, 32));
}

function fixedHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store, max-age=0", Pragma: "no-cache",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function aiUserOidcUnavailable(): Response {
  return Response.json({ ok: false, code: "AIUSER_LOGIN_UNAVAILABLE" }, { status: 503, headers: fixedHeaders() });
}

function deniedResponse(preservePending = false): Response {
  const headers = fixedHeaders();
  // A rejected/replayed sibling callback must not erase the only browser-side
  // revocation correlation for an already admitted first-login callback.
  if (!preservePending) headers.append("Set-Cookie", cookie(AIUSER_TRANSACTION_COOKIE, "", 0));
  return Response.json({ ok: false, code: "AIUSER_LOGIN_FAILED" }, { status: 400, headers });
}

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("cookie") ?? "";
  if (raw.length > 16384) return fail();
  const matches = raw.split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${name}=`));
  if (matches.length !== 1) return fail();
  const value = matches[0]!.slice(name.length + 1);
  if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(value)) return fail();
  return value;
}

export function assertAiUserRequestOrigin(request: Request, path: string, internalOrigin?: string): URL {
  const url = new URL(request.url);
  if (url.pathname !== path || url.hash || url.username || url.password) return fail();
  const host = request.headers.get("host");
  const publicHost = new URL(registration.publicOrigin).host;
  if (host !== null && host !== publicHost) return fail();
  if (url.origin !== registration.publicOrigin) {
    if (!internalOrigin || url.origin !== internalOrigin || host !== publicHost
      || request.headers.get("x-forwarded-proto") !== "https"
      || request.headers.get("x-forwarded-host") !== publicHost) return fail();
  }
  // No arbitrary forwarded URL. This alternate transport is root-configured and
  // accepted only behind the host-verified loopback listener/header-scrubbing proxy.
  return url;
}

async function seal(payload: JWTPayload, secret: string, purpose: "transaction" | "identity" | "revocation", now: number, ttl: number) {
  return new EncryptJWT(payload).setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: `aistory-${purpose}+jwt` })
    .setIssuer(registration.publicOrigin).setAudience(`aistory-aiuser-${purpose}-v1`)
    .setIssuedAt(now).setExpirationTime(now + ttl).encrypt(key(secret, purpose));
}

async function unseal(token: string, secret: string, purpose: "transaction" | "identity" | "revocation", now: number, revocationOnly = false) {
  const { payload, protectedHeader } = await jwtDecrypt(token, key(secret, purpose), {
    issuer: registration.publicOrigin, audience: `aistory-aiuser-${purpose}-v1`,
    keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
    clockTolerance: SKEW_SECONDS, currentDate: new Date((revocationOnly ? 0 : now) * 1000),
    requiredClaims: ["iat", "exp"],
  });
  if (protectedHeader.typ !== `aistory-${purpose}+jwt` || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp) || payload.iat! > now + SKEW_SECONDS
    || (revocationOnly && (purpose !== "transaction" || now > payload.iat! + REVOCATION_SECONDS))) return fail();
  return payload;
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_QUOTED_VALUE = /^"(?:[\t\x20-\x21\x23-\x5B\x5D-\x7E]|\\[\t\x20-\x7E])*"$/;

function contentTypeParts(value: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ";") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
}

function jsonContentTypeAllowed(value: string | null, url: string): boolean {
  if (!value || value.length > 256 || /[\r\n,]/.test(value)) return false;
  const parts = contentTypeParts(value);
  if (!parts) return false;
  const mediaType = parts.shift()?.trim().toLowerCase();
  if (mediaType !== "application/json"
    && !(url === AIUSER_ENDPOINTS.jwks && mediaType === "application/jwk-set+json")) return false;
  if (parts.length > 8) return false;
  const names = new Set<string>();
  for (const raw of parts) {
    const separator = raw.indexOf("=");
    if (separator < 1) return false;
    const name = raw.slice(0, separator).trim().toLowerCase();
    const parameter = raw.slice(separator + 1).trim();
    if (!HTTP_TOKEN.test(name) || names.has(name)
      || !(HTTP_TOKEN.test(parameter) || HTTP_QUOTED_VALUE.test(parameter))) return false;
    names.add(name);
  }
  return true;
}

async function jsonRequest(deps: AiUserOidcCallbackDependencies, url: string, init: RequestInit = {}) {
  if (!([AIUSER_ENDPOINTS.discovery, AIUSER_ENDPOINTS.token, AIUSER_ENDPOINTS.jwks] as string[]).includes(url)) return fail();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await deps.fetch(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store",
      signal: abort.signal, headers: { Accept: "application/json", ...init.headers } });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url)
      || !jsonContentTypeAllowed(response.headers.get("content-type"), url)) return fail();
    const limit = url === AIUSER_ENDPOINTS.token ? 32768 : 65536;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return fail();
    const reader = response.body?.getReader();
    if (!reader) return fail();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) return fail();
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
  } finally { clearTimeout(timeout); }
}

function contains(value: unknown, required: string[]): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    && new Set(value).size === value.length && required.every((entry) => value.includes(entry));
}

function discovery(value: Record<string, unknown>): void {
  if (value.issuer !== registration.issuerUrl || value.authorization_endpoint !== AIUSER_ENDPOINTS.authorization
    || value.token_endpoint !== AIUSER_ENDPOINTS.token || value.jwks_uri !== AIUSER_ENDPOINTS.jwks
    || !contains(value.response_types_supported, ["code"])
    || !contains(value.code_challenge_methods_supported, ["S256"])
    || !contains(value.token_endpoint_auth_methods_supported, ["client_secret_basic"])
    || !contains(value.id_token_signing_alg_values_supported, ["ES256"])
    || !contains(value.scopes_supported, registration.scopes.slice())) return fail();
}

function jwks(value: unknown): JSONWebKeySet {
  const data = exact(value, ["keys"]);
  if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 32) return fail();
  const kids = new Set<string>();
  for (const input of data.keys) {
    const item = record(input);
    if (Object.keys(item).some((name) => !["kty", "crv", "use", "alg", "kid", "x", "y", "key_ops"].includes(name))
      || item.kty !== "EC" || item.crv !== "P-256" || item.use !== "sig" || item.alg !== "ES256"
      || typeof item.kid !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.kid) || kids.has(item.kid)
      || (item.key_ops !== undefined && JSON.stringify(item.key_ops) !== '["verify"]')) return fail();
    for (const name of ["x", "y"]) {
      if (typeof item[name] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item[name])
        || Buffer.from(item[name], "base64url").toString("base64url") !== item[name]) return fail();
    }
    kids.add(item.kid);
  }
  return data as unknown as JSONWebKeySet;
}

function tokenHeader(token: unknown, kind: "id" | "access") {
  if (typeof token !== "string" || token.length > 8192 || token.split(".").length !== 3) return fail();
  const header = record(decodeProtectedHeader(token));
  if (Object.keys(header).some((name) => !["alg", "kid", "typ"].includes(name)) || header.alg !== "ES256"
    || typeof header.kid !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid)
    || (kind === "access" ? header.typ !== "at+jwt" : header.typ !== undefined && header.typ !== "JWT")) return fail();
  return { token, kid: header.kid };
}

function tokenTime(payload: JWTPayload, now: number, transactionIat: number): void {
  const iat = integer(payload.iat, 0, Number.MAX_SAFE_INTEGER);
  const exp = integer(payload.exp, 0, Number.MAX_SAFE_INTEGER);
  if (exp <= iat || exp - iat > TOKEN_SECONDS || iat > now + SKEW_SECONDS || iat < transactionIat - SKEW_SECONDS
    || typeof payload.sub !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(payload.sub)) return fail();
}

export type AiUserVerifiedIdentity = Readonly<{
  issuer: string; subject: string; membershipGeneration: number; expiresAt: number;
  /** Signed ID-token auth_time in epoch seconds; null means the IdP supplied no recent-auth evidence. */
  idpAuthenticatedAt?: number | null;
}>;

function verifiedIdpAuthenticationTime(payload: JWTPayload, now: number): number | null {
  if (!Object.hasOwn(payload, "auth_time")) return null;
  const value = integer(payload.auth_time, 0, Number.MAX_SAFE_INTEGER);
  const issuedAt = integer(payload.iat, 0, Number.MAX_SAFE_INTEGER);
  if (value > now + SKEW_SECONDS || value > issuedAt + SKEW_SECONDS) return fail();
  return value;
}

async function emptyStartBody(request: Request): Promise<boolean> {
  const reader = request.body?.getReader();
  if (!reader) return false;
  let body = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return body === "{}";
      if (part.value.byteLength + body.length > 2) return false;
      body += new TextDecoder("utf-8", { fatal: true }).decode(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

// Server-private identity only. This does not resolve a phone UUID or authorize any product operation.
export async function readAiUserIdentitySession(request: Request, secret: string, now: number): Promise<AiUserVerifiedIdentity | null> {
  try {
    const payload = await unseal(readCookie(request, AIUSER_IDENTITY_COOKIE), secret, "identity", now);
    if (payload.authority !== registration.issuerUrl || payload.registration !== registrationSha256
      || typeof payload.sub !== "string" || payload.exp! - payload.iat! > TOKEN_SECONDS) return null;
    const idpAuthenticatedAt = payload.idpAuthenticatedAt === undefined || payload.idpAuthenticatedAt === null
      ? null : integer(payload.idpAuthenticatedAt, 0, Number.MAX_SAFE_INTEGER);
    if (idpAuthenticatedAt !== null && idpAuthenticatedAt > payload.iat! + SKEW_SECONDS) return null;
    return Object.freeze({ issuer: registration.issuerUrl, subject: payload.sub,
      membershipGeneration: integer(payload.membershipGeneration, 1, Number.MAX_SAFE_INTEGER),
      expiresAt: payload.exp!, idpAuthenticatedAt });
  } catch { return null; }
}

/** Logout can cancel an in-flight callback without exposing state/nonce/PKCE to its caller. */
export async function readAiUserTransactionHash(request: Request, secret: string, now: number): Promise<string | undefined> {
  try {
    const payload = await unseal(readCookie(request, AIUSER_TRANSACTION_COOKIE), secret, "transaction", now, true);
    if (payload.registration !== registrationSha256 || payload.exp! - payload.iat! !== TRANSACTION_SECONDS
      || typeof payload.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.state)) return undefined;
    return createHash("sha256").update(`aistory.aiuser.transaction.v1\0${payload.state}`).digest("hex");
  } catch { return undefined; }
}

export async function readAiUserTransactionLineage(request: Request, secret: string, now: number): Promise<string | undefined> {
  try {
    const payload = await unseal(readCookie(request, AIUSER_TRANSACTION_COOKIE), secret, "transaction", now, true);
    if (payload.registration !== registrationSha256 || payload.exp! - payload.iat! !== TRANSACTION_SECONDS
      || typeof payload.lineage !== "string" || !HASH.test(payload.lineage)) return undefined;
    return payload.lineage;
  } catch { return undefined; }
}

/** Separate cookies prevent a late parallel start response from overwriting
 * another admitted callback's logout correlation. These never authenticate. */
export function aiUserPendingCookieNames(request: Request): string[] {
  const raw = request.headers.get("cookie") ?? "";
  if (raw.length > 16384) return fail();
  const names = raw.split(";").map((item) => item.trim().split("=")[0]!)
    .filter((name) => name.startsWith(AIUSER_PENDING_COOKIE_PREFIX));
  if (names.length > 8 || new Set(names).size !== names.length
    || names.some((name) => !HASH.test(name.slice(AIUSER_PENDING_COOKIE_PREFIX.length)))) return fail();
  return names;
}

export async function readAiUserPendingRevocations(request: Request, secret: string, now: number) {
  const result: Array<{ cookieName: string; transactionHash: string; lineage: string }> = [];
  for (const name of aiUserPendingCookieNames(request)) {
    const payload = await unseal(readCookie(request, name), secret, "revocation", now);
    const data = exact(payload, ["iss", "aud", "iat", "exp", "registration", "transactionHash", "lineage"]);
    if (data.registration !== registrationSha256 || payload.exp! - payload.iat! !== REVOCATION_SECONDS
      || typeof data.transactionHash !== "string" || !HASH.test(data.transactionHash)
      || name !== AIUSER_PENDING_COOKIE_PREFIX + data.transactionHash
      || typeof data.lineage !== "string" || !HASH.test(data.lineage)) return fail();
    result.push({ cookieName: name, transactionHash: data.transactionHash, lineage: data.lineage });
  }
  return result;
}

export function createAiUserOidcCallback(deps: AiUserOidcCallbackDependencies) {
  const denied = () => deniedResponse(!!deps.onVerified);
  key(deps.clientSecret, "transaction");
  if (deps.proxyRequestOrigin !== undefined) proxyOrigin(deps.proxyRequestOrigin);
  async function beginStart(request: Request, linkReauth: boolean): Promise<Response> {
      try {
        const url = assertAiUserRequestOrigin(request, linkReauth ? LINK_REAUTH_PATH : START_PATH,
          deps.proxyRequestOrigin);
        if (request.method !== "POST" || url.search || request.headers.get("origin") !== registration.publicOrigin
          || request.headers.get("sec-fetch-site") !== "same-origin"
          || request.headers.get("content-type") !== "application/json"
          || (request.headers.get("content-length") !== null && request.headers.get("content-length") !== "2")
          || !(await emptyStartBody(request)) || !deps.allowStart()
          || (linkReauth && !deps.onVerified)) return denied();
        // Cap normal outstanding attempts; excessive/ambiguous cookie input
        // fails closed rather than silently dropping logout correlations.
        if (deps.onVerified && aiUserPendingCookieNames(request).length >= 4) return denied();
        const generate = () => {
          const bytes = (deps.random ?? randomBytes)(32);
          if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return fail();
          return Buffer.from(bytes).toString("base64url");
        };
        const state = generate();
        const nonce = generate();
        const verifier = generate();
        if (new Set([state, nonce, verifier]).size !== 3) return fail();
        const now = Math.floor(deps.now() / 1000);
        const lineage = deps.transactionLineage ? await deps.transactionLineage(request)
          ?? createHash("sha256").update(`aistory.aiuser.transaction.v1\0${state}`).digest("hex") : undefined;
        if (lineage !== undefined && !HASH.test(lineage)) return denied();
        const transaction = await seal({ state, nonce, verifier, registration: registrationSha256,
          ...(linkReauth ? { purpose: LINK_REAUTH_PURPOSE } : {}),
          ...(lineage ? { lineage } : {}) }, deps.clientSecret, "transaction", now, TRANSACTION_SECONDS);
        const target = new URL(AIUSER_ENDPOINTS.authorization);
        target.search = new URLSearchParams({ client_id: registration.clientId, redirect_uri: registration.redirectUri,
          response_type: "code", scope: SCOPE, resource: registration.resource, state, nonce,
          code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          ...(linkReauth ? { max_age: "0" } : {}) }).toString();
        const headers = fixedHeaders();
        // Business login keeps the encrypted pending envelope for revocation only
        // through the latest possible product expiry. Its authentication exp stays90s.
        headers.append("Set-Cookie", cookie(AIUSER_TRANSACTION_COOKIE, transaction,
          deps.onVerified ? REVOCATION_SECONDS : TRANSACTION_SECONDS));
        if (deps.onVerified) {
          const transactionHash = createHash("sha256").update(`aistory.aiuser.transaction.v1\0${state}`).digest("hex");
          const revocation = await seal({ registration: registrationSha256, transactionHash, lineage },
            deps.clientSecret, "revocation", now, REVOCATION_SECONDS);
          headers.append("Set-Cookie", cookie(AIUSER_PENDING_COOKIE_PREFIX + transactionHash, revocation,
            REVOCATION_SECONDS));
        }
        // A same-origin fetch cannot turn a 303 into top-level cross-origin navigation.
        // The caller must explicitly navigate to this fixed-authority URL; it is not a token DTO.
        return Response.json({ authorizationUrl: target.toString() }, { headers });
      } catch { return denied(); }
  }
  return {
    start(request: Request): Promise<Response> { return beginStart(request, false); },
    startLinkReauth(request: Request): Promise<Response> { return beginStart(request, true); },
    async callback(request: Request): Promise<Response> {
      let rejectionStage: AiUserCallbackRejectionStage = "transaction";
      const reject = () => {
        try { deps.onCallbackRejected?.(rejectionStage); } catch { /* Diagnostics never weaken or alter rejection. */ }
        return denied();
      };
      try {
        const url = assertAiUserRequestOrigin(request, CALLBACK_PATH, deps.proxyRequestOrigin);
        if (request.method !== "GET" || url.search.length > 4096) return reject();
        const fields = Array.from(url.searchParams.keys());
        if (new Set(fields).size !== fields.length || fields.some((name) => !["code", "state", "iss", "error", "error_description"].includes(name))
          || !url.searchParams.has("state") || (url.searchParams.has("code") === url.searchParams.has("error"))
          || (url.searchParams.has("error_description") && !url.searchParams.has("error"))
          || (url.searchParams.has("iss") && url.searchParams.get("iss") !== registration.issuerUrl)) return reject();
        const now = Math.floor(deps.now() / 1000);
        const transaction = await unseal(readCookie(request, AIUSER_TRANSACTION_COOKIE), deps.clientSecret, "transaction", now);
        if (transaction.registration !== registrationSha256 || transaction.exp! - transaction.iat! !== TRANSACTION_SECONDS
          || (transaction.purpose !== undefined && transaction.purpose !== LINK_REAUTH_PURPOSE)
          || (deps.transactionLineage && (typeof transaction.lineage !== "string" || !HASH.test(transaction.lineage)))
          || !same(url.searchParams.get("state"), String(transaction.state))
          || ![transaction.state, transaction.nonce, transaction.verifier].every((entry) => typeof entry === "string" && /^[A-Za-z0-9_-]{43}$/.test(entry))) return reject();
        const claim = createHash("sha256").update(`aistory.aiuser.transaction.v1\0${transaction.state}`).digest("hex");
        rejectionStage = "claimOnce";
        if (!(await deps.claimOnce(claim)) || url.searchParams.has("error")) return reject();
        const code = url.searchParams.get("code");
        if (!code || !/^[A-Za-z0-9_.~-]{16,1024}$/.test(code)) return reject();
        rejectionStage = "discovery";
        discovery(await jsonRequest(deps, AIUSER_ENDPOINTS.discovery));
        const credentials = `${encodeURIComponent(registration.clientId)}:${encodeURIComponent(deps.clientSecret)}`;
        // AIUser binds the resource at authorization and rejects ANY exchange-time resource override.
        rejectionStage = "token_exchange";
        const tokens = await jsonRequest(deps, AIUSER_ENDPOINTS.token, { method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: registration.redirectUri,
            code_verifier: transaction.verifier as string }).toString() });
        rejectionStage = "token_shape";
        if (tokens.token_type !== "Bearer" || Object.hasOwn(tokens, "refresh_token")
          || (tokens.expires_in !== undefined && (typeof tokens.expires_in !== "number"
            || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 1 || tokens.expires_in > TOKEN_SECONDS))
          || (tokens.scope !== undefined && tokens.scope !== SCOPE && tokens.scope !== "product.access")) return reject();
        const id = tokenHeader(tokens.id_token, "id");
        const access = tokenHeader(tokens.access_token, "access");
        rejectionStage = "jwks";
        let keys = jwks(await jsonRequest(deps, AIUSER_ENDPOINTS.jwks));
        // No invented cache TTL: fetch fresh. Unknown kid gets exactly one extra fresh fetch, never token retry.
        if ([id.kid, access.kid].some((kid) => !keys.keys.some((item) => item.kid === kid))) {
          keys = jwks(await jsonRequest(deps, AIUSER_ENDPOINTS.jwks));
          if ([id.kid, access.kid].some((kid) => !keys.keys.some((item) => item.kid === kid))) return reject();
        }
        const localKeys = createLocalJWKSet(keys);
        const verifiedNow = Math.floor(deps.now() / 1000);
        const options = { issuer: registration.issuerUrl, algorithms: ["ES256"], clockTolerance: SKEW_SECONDS,
          currentDate: new Date(verifiedNow * 1000), requiredClaims: ["iss", "aud", "sub", "iat", "exp"] };
        rejectionStage = "id_verify";
        const idResult = await jwtVerify(id.token, localKeys, { ...options, audience: registration.clientId });
        rejectionStage = "access_verify";
        const accessResult = await jwtVerify(access.token, localKeys, { ...options, audience: registration.audience });
        rejectionStage = "claims";
        const idClaims = idResult.payload;
        const accessClaims = accessResult.payload;
        tokenTime(idClaims, verifiedNow, transaction.iat!);
        tokenTime(accessClaims, verifiedNow, transaction.iat!);
        if (idClaims.aud !== registration.clientId || accessClaims.aud !== registration.audience
          || !same(idClaims.nonce, transaction.nonce as string) || idClaims.sub !== accessClaims.sub
          || accessClaims.product_id !== registration.productId || accessClaims.scope !== "product.access") return reject();
        const generation = integer(accessClaims.membership_generation, 1, Number.MAX_SAFE_INTEGER);
        const idpAuthenticatedAt = verifiedIdpAuthenticationTime(idClaims, verifiedNow);
        const linkReauth = transaction.purpose === LINK_REAUTH_PURPOSE;
        if (linkReauth
          && (idpAuthenticatedAt === null || idpAuthenticatedAt < transaction.iat! - SKEW_SECONDS
            || verifiedNow - idpAuthenticatedAt > 300)) return reject();
        const lifetime = Math.min(idClaims.exp!, accessClaims.exp!) - verifiedNow;
        if (lifetime <= 0 || lifetime > TOKEN_SECONDS + SKEW_SECONDS) return reject();
        // Link reauthentication proves freshness at the IdP's `auth_time`, not
        // at our later callback.  Keep the resulting proof's whole lifetime
        // within the same 900-second window; otherwise any redirect/network
        // delay makes `expiresAt - idpAuthenticatedAt` exceed the account-link
        // policy even though reauthentication just succeeded.
        const sessionLifetime = linkReauth
          ? Math.min(lifetime, TOKEN_SECONDS, idpAuthenticatedAt! + TOKEN_SECONDS - verifiedNow)
          : Math.min(lifetime, TOKEN_SECONDS);
        if (sessionLifetime <= 0) return reject();
        rejectionStage = "completion_deadline";
        const identity = await seal({ authority: registration.issuerUrl, sub: idClaims.sub,
          membershipGeneration: generation, idpAuthenticatedAt, registration: registrationSha256 },
        deps.clientSecret, "identity", verifiedNow, sessionLifetime);
        const headers = fixedHeaders();
        if (Math.floor(deps.now() / 1000) >= transaction.exp! + SKEW_SECONDS) return reject();
        headers.append("Set-Cookie", cookie(AIUSER_TRANSACTION_COOKIE, "", 0));
        headers.append("Set-Cookie", cookie(AIUSER_IDENTITY_COOKIE, identity, sessionLifetime));
        if (deps.onVerified) headers.append("Set-Cookie", cookie(AIUSER_PENDING_COOKIE_PREFIX + claim, "", 0));
        if (deps.onVerified) {
          rejectionStage = "session_establish";
          return await deps.onVerified(Object.freeze({ issuer: registration.issuerUrl,
            subject: idClaims.sub!, membershipGeneration: generation,
            expiresAt: verifiedNow + sessionLifetime, idpAuthenticatedAt }), claim, request, headers,
          transaction.lineage as string | undefined,
            transaction.exp! + SKEW_SECONDS);
        }
        return Response.json({ ok: true, status: "OIDC_IDENTITY_VERIFIED_ONLY", accountLinked: false,
          membershipCreated: false, entitlementGranted: false, creditsGranted: false }, { headers });
      } catch { return reject(); }
    },
  };
}
