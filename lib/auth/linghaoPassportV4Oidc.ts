import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import {
  LINGHAO_PASSPORT_V4_CLIENT_ID,
  LINGHAO_PASSPORT_V4_ISSUER,
  LINGHAO_PASSPORT_V4_SCOPES,
} from "./linghaoPassportV4Config";

export type LinghaoPassportV4Fetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LinghaoPassportV4RandomBytes = (size: number) => Uint8Array;

export interface LinghaoPassportV4AuthorizationSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface LinghaoPassportV4Discovery {
  readonly issuer: string;
  readonly authorizationEndpoint: URL;
  readonly tokenEndpoint: URL;
  readonly jwksUri: URL;
  readonly endSessionEndpoint: URL;
  readonly revocationEndpoint: URL;
}

export interface LinghaoPassportV4Identity {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly nonce?: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly name?: string;
  readonly preferredUsername?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
}

export interface LinghaoPassportV4Tokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly expiresIn: number;
}

export interface LinghaoPassportV4AuthenticationResult {
  readonly tokens: LinghaoPassportV4Tokens;
  readonly identity: LinghaoPassportV4Identity;
}

export interface PassportOidcOptions {
  readonly config: LinghaoPassportV4OidcConfig;
  readonly fetch: LinghaoPassportV4Fetch;
  readonly now?: () => number;
  readonly randomBytes?: LinghaoPassportV4RandomBytes;
  readonly requestTimeoutMs?: number;
  readonly clockToleranceSeconds?: number;
  /** Local remains the default so the existing loopback fixture cannot widen. */
  readonly endpointPolicy?: "local_loopback" | "production_https";
  /** Local qualification requires refresh rotation; production may use a short non-refresh session. */
  readonly requireRefreshToken?: boolean;
}

export interface LinghaoPassportV4OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly publicOrigin: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
  readonly scopes: readonly string[];
}

export interface VerifyPassportIdTokenOptions {
  readonly idToken: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly keys: JWTVerifyGetKey;
  readonly now?: Date;
  readonly expectedNonce?: string;
  readonly allowMissingNonce?: boolean;
  readonly expectedSubject?: string;
  readonly clockToleranceSeconds?: number;
}

const RS256 = "RS256";
const JSON_MEDIA_TYPE = "application/json";
const JWKS_MEDIA_TYPE = "application/jwk-set+json";
const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;
const MAX_REVOCATION_BYTES = 4096;
const MAX_ID_TOKEN_LENGTH = 32_768;
const MAX_OPAQUE_TOKEN_LENGTH = 32_768;
const MAX_SUBJECT_LENGTH = 512;
const MAX_CODE_LENGTH = 4096;
const CLOCK_SKEW_SECONDS = 30;
const ISSUED_AT_FUTURE_SECONDS = 60;
const MAX_ID_TOKEN_LIFETIME_SECONDS = 3660;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function fail(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeEqualString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function boundedString(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} is missing or invalid`);
  }
  return value;
}

function optionalBoundedString(
  payload: JWTPayload,
  name: string,
  maximum: number,
): string | undefined {
  const value = payload[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    fail(`ID token ${name} claim is invalid`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertOpaqueIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function createLinghaoPassportV4AuthorizationSecrets(
  randomBytes: LinghaoPassportV4RandomBytes = nodeRandomBytes,
): LinghaoPassportV4AuthorizationSecrets {
  const draw = (size: number): string => {
    const bytes = randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      fail("secure random source returned an invalid length");
    }
    return base64Url(bytes);
  };
  return Object.freeze({
    state: draw(32),
    nonce: draw(32),
    codeVerifier: draw(48),
  });
}

export function computeLinghaoPassportV4PkceChallenge(
  codeVerifier: string,
): string {
  if (
    typeof codeVerifier !== "string" ||
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !BASE64URL_PATTERN.test(codeVerifier)
  ) {
    fail("PKCE code verifier is invalid");
  }
  return base64Url(createHash("sha256").update(codeVerifier, "ascii").digest());
}

function assertAuthorizationSecrets(
  secrets: LinghaoPassportV4AuthorizationSecrets,
): void {
  assertOpaqueIdentifier(secrets.state, "authorization state");
  assertOpaqueIdentifier(secrets.nonce, "authorization nonce");
  if (
    !BASE64URL_PATTERN.test(secrets.codeVerifier) ||
    secrets.codeVerifier.length < 43 ||
    secrets.codeVerifier.length > 128
  ) {
    fail("PKCE code verifier is invalid");
  }
}

function parseAbsoluteHttpUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    fail(`${label} is missing or invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    fail(`${label} must not contain credentials`);
  }
  if (url.search || url.hash) {
    fail(`${label} must not contain a query string or fragment`);
  }
  return url;
}

function isLiteralLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && url.hostname === "127.0.0.1";
}

function assertIssuer(
  url: URL,
  policy: "local_loopback" | "production_https",
): void {
  const local = isLiteralLoopbackHttp(url) && url.port === "8000";
  const production = url.protocol === "https:" && url.hostname !== "localhost"
    && url.hostname !== "127.0.0.1" && url.hostname !== "::1" && url.port === "";
  if (url.pathname !== "/" || (policy === "local_loopback" ? !local : !production)) {
    fail("OIDC issuer violates the selected endpoint policy");
  }
}

function assertEndpoint(
  value: unknown,
  issuer: URL,
  label: string,
  policy: "local_loopback" | "production_https",
): URL {
  const endpoint = parseAbsoluteHttpUrl(value, label);
  if (
    (policy === "local_loopback" && !isLiteralLoopbackHttp(endpoint)) ||
    (policy === "production_https" && endpoint.protocol !== "https:")
  ) {
    fail(`${label} violates the selected endpoint policy`);
  }
  if (endpoint.origin !== issuer.origin) {
    fail(`${label} must share the configured issuer origin`);
  }
  return endpoint;
}

function readStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(
      (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128,
    )
  ) {
    fail(`${label} is missing or invalid`);
  }
  return value;
}

function validateDiscoveryDocument(
  document: Record<string, unknown>,
  config: LinghaoPassportV4OidcConfig,
  policy: "local_loopback" | "production_https",
): LinghaoPassportV4Discovery {
  if (document.issuer !== config.issuer) {
    fail("discovered issuer does not exactly match the configured issuer");
  }
  const issuer = parseAbsoluteHttpUrl(document.issuer, "discovered issuer");
  assertIssuer(issuer, policy);

  const authorizationEndpoint = assertEndpoint(
    document.authorization_endpoint,
    issuer,
    "authorization_endpoint",
    policy,
  );
  const tokenEndpoint = assertEndpoint(
    document.token_endpoint,
    issuer,
    "token_endpoint",
    policy,
  );
  const jwksUri = assertEndpoint(document.jwks_uri, issuer, "jwks_uri", policy);
  const endSessionEndpoint = assertEndpoint(
    document.end_session_endpoint,
    issuer,
    "end_session_endpoint",
    policy,
  );
  const revocationEndpoint = assertEndpoint(
    document.revocation_endpoint,
    issuer,
    "revocation_endpoint",
    policy,
  );

  const responseTypes = readStringArray(
    document.response_types_supported,
    "response_types_supported",
  );
  if (!responseTypes.includes("code")) {
    fail("issuer does not advertise the authorization code response type");
  }

  const pkceMethods = readStringArray(
    document.code_challenge_methods_supported,
    "code_challenge_methods_supported",
  );
  if (!pkceMethods.includes("S256")) {
    fail("issuer does not advertise PKCE S256");
  }

  const signingAlgorithms = readStringArray(
    document.id_token_signing_alg_values_supported,
    "id_token_signing_alg_values_supported",
  );
  if (!signingAlgorithms.includes(RS256)) {
    fail("issuer does not advertise RS256 ID tokens");
  }

  const authMethods = readStringArray(
    document.token_endpoint_auth_methods_supported,
    "token_endpoint_auth_methods_supported",
  );
  if (!authMethods.includes("client_secret_basic")) {
    fail("issuer does not advertise client_secret_basic");
  }

  if (document.scopes_supported !== undefined) {
    const scopes = readStringArray(
      document.scopes_supported,
      "scopes_supported",
    );
    for (const required of config.scopes) {
      if (!scopes.includes(required)) {
        fail(`issuer does not advertise required scope ${required}`);
      }
    }
  }

  return Object.freeze({
    issuer: config.issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    endSessionEndpoint,
    revocationEndpoint,
  });
}

export function createLinghaoPassportV4LocalJwks(
  document: unknown,
): JWTVerifyGetKey {
  if (!isPlainObject(document) || !Array.isArray(document.keys)) {
    fail("JWKS document is invalid");
  }
  if (document.keys.length === 0 || document.keys.length > 32) {
    fail("JWKS must contain a bounded set of keys");
  }

  const seenKids = new Set<string>();
  const keys: Record<string, unknown>[] = [];
  for (const candidate of document.keys) {
    if (!isPlainObject(candidate)) {
      fail("JWKS key is invalid");
    }
    if (candidate.kty !== "RSA") {
      fail("JWKS may contain only RSA signing keys");
    }
    const kid = boundedString(candidate.kid, 256, "JWKS kid");
    if (seenKids.has(kid)) {
      fail("JWKS contains duplicate kid values");
    }
    seenKids.add(kid);
    if (
      candidate.d !== undefined ||
      candidate.p !== undefined ||
      candidate.q !== undefined ||
      candidate.dp !== undefined ||
      candidate.dq !== undefined ||
      candidate.qi !== undefined ||
      candidate.oth !== undefined
    ) {
      fail("JWKS must not contain private key material");
    }
    if (candidate.use !== undefined && candidate.use !== "sig") {
      fail("JWKS key use must be sig");
    }
    if (candidate.alg !== undefined && candidate.alg !== RS256) {
      fail("JWKS key algorithm must be RS256");
    }
    if (
      candidate.key_ops !== undefined &&
      (!Array.isArray(candidate.key_ops) ||
        candidate.key_ops.length !== 1 ||
        candidate.key_ops[0] !== "verify")
    ) {
      fail("JWKS key_ops must be exactly verification-only");
    }

    const modulus = boundedString(candidate.n, 4096, "JWKS modulus");
    const exponent = boundedString(candidate.e, 32, "JWKS exponent");
    if (
      !BASE64URL_PATTERN.test(modulus) ||
      Buffer.from(modulus, "base64url").byteLength < 256
    ) {
      fail("JWKS RSA modulus is too small");
    }
    if (
      !BASE64URL_PATTERN.test(exponent) ||
      Buffer.from(exponent, "base64url").byteLength < 3
    ) {
      fail("JWKS RSA exponent is invalid");
    }
    keys.push({ ...candidate });
  }

  return createLocalJWKSet({ keys } as JSONWebKeySet);
}

function assertAudienceAndAzp(payload: JWTPayload, clientId: string): void {
  const rawAudience = payload.aud;
  const audiences =
    typeof rawAudience === "string" ? [rawAudience] : rawAudience;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.length > 16 ||
    !audiences.every(
      (audience) => typeof audience === "string" && audience.length > 0,
    )
  ) {
    fail("ID token audience is missing or malformed");
  }
  if (!audiences.includes(clientId)) {
    fail("ID token audience does not include this client");
  }
  if (audiences.length > 1 && payload.azp !== clientId) {
    fail("ID token with multiple audiences must name this client as azp");
  }
  if (payload.azp !== undefined && payload.azp !== clientId) {
    fail("ID token azp does not name this client");
  }
}

/**
 * Explicit jose-based validation. The signature is verified against the
 * discovered JWKS, and algorithm, kid, issuer, audience/azp, required claims,
 * nonce, expiry, and issued-at are pinned independently of library defaults.
 */
export async function verifyLinghaoPassportV4IdToken(
  options: VerifyPassportIdTokenOptions,
): Promise<LinghaoPassportV4Identity> {
  if (
    typeof options.idToken !== "string" ||
    options.idToken.length === 0 ||
    options.idToken.length > MAX_ID_TOKEN_LENGTH ||
    options.idToken.split(".").length !== 3
  ) {
    fail("ID token is missing, malformed, or too large");
  }

  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(options.idToken) as Record<string, unknown>;
  } catch {
    fail("ID token protected header is invalid");
  }
  if (header.alg !== RS256) {
    fail("ID token signing algorithm is not allowed");
  }
  if (!boundedString(header.kid, 256, "ID token kid")) {
    fail("ID token kid is missing");
  }
  if (
    header.jku !== undefined ||
    header.x5u !== undefined ||
    header.jwk !== undefined ||
    header.x5c !== undefined ||
    header.crit !== undefined
  ) {
    fail("ID token contains a forbidden key header");
  }
  if (header.typ !== "JWT") {
    fail("ID token typ must be exactly JWT");
  }

  const allowMissingNonce = options.allowMissingNonce === true;
  if (!allowMissingNonce && !options.expectedNonce) {
    fail("expected nonce is required");
  }

  const now = options.now ?? new Date();
  let result: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    result = await jwtVerify(options.idToken, options.keys, {
      issuer: options.issuer,
      audience: options.clientId,
      algorithms: [RS256],
      requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      clockTolerance:
        options.clockToleranceSeconds ?? CLOCK_SKEW_SECONDS,
      currentDate: now,
    });
  } catch {
    fail("ID token signature or registered claims are invalid");
  }

  if (result.protectedHeader.alg !== RS256) {
    fail("ID token signing algorithm is not allowed");
  }

  const payload = result.payload;
  if (payload.iss !== options.issuer) {
    fail("ID token issuer does not match the configured issuer");
  }
  assertAudienceAndAzp(payload, options.clientId);

  const subject = boundedString(payload.sub, MAX_SUBJECT_LENGTH, "ID token sub");
  if (
    options.expectedSubject !== undefined &&
    !safeEqualString(subject, options.expectedSubject)
  ) {
    fail("ID token subject does not match the authenticated session");
  }

  let nonce: string | undefined;
  const nonceClaim = payload.nonce;
  if (nonceClaim === undefined || nonceClaim === "") {
    if (!allowMissingNonce) {
      fail("ID token nonce is missing");
    }
  } else {
    if (typeof nonceClaim !== "string" || nonceClaim.length > 512) {
      fail("ID token nonce claim is invalid");
    }
    if (
      options.expectedNonce !== undefined &&
      !safeEqualString(nonceClaim, options.expectedNonce)
    ) {
      fail("ID token nonce does not match this authorization request");
    }
    nonce = nonceClaim;
  }

  const exp = payload.exp;
  const iat = payload.iat;
  if (
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    exp < 0
  ) {
    fail("ID token expiry must be a nonnegative safe integer");
  }
  if (
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    iat < 0
  ) {
    fail("ID token issued-at must be a nonnegative safe integer");
  }
  const nowSeconds = now.getTime() / 1000;
  if (exp <= nowSeconds) {
    fail("ID token is expired");
  }
  if (iat > nowSeconds + ISSUED_AT_FUTURE_SECONDS) {
    fail("ID token issued-at claim is in the future");
  }
  if (exp <= iat) {
    fail("ID token expiry must be after issued-at");
  }
  if (exp - iat > MAX_ID_TOKEN_LIFETIME_SECONDS) {
    fail("ID token lifetime exceeds the allowed one-hour-plus-skew bound");
  }

  const emailVerified = payload.email_verified;
  if (emailVerified !== undefined && typeof emailVerified !== "boolean") {
    fail("ID token email_verified claim is invalid");
  }

  const name = optionalBoundedString(payload, "name", 512);
  const preferredUsername = optionalBoundedString(
    payload,
    "preferred_username",
    512,
  );
  const email = optionalBoundedString(payload, "email", 320);

  return Object.freeze({
    issuer: options.issuer,
    clientId: options.clientId,
    subject,
    ...(nonce === undefined ? {} : { nonce }),
    expiresAt: exp,
    issuedAt: iat,
    ...(name === undefined ? {} : { name }),
    ...(preferredUsername === undefined
      ? {}
      : { preferredUsername }),
    ...(email === undefined ? {} : { email }),
    ...(emailVerified === undefined ? {} : { emailVerified }),
  });
}

function parseTokenResponse(
  document: Record<string, unknown>,
  requireRefreshToken: boolean,
): LinghaoPassportV4Tokens {
  const accessToken = boundedString(
    document.access_token,
    MAX_OPAQUE_TOKEN_LENGTH,
    "access_token",
  );
  const idToken = boundedString(
    document.id_token,
    MAX_ID_TOKEN_LENGTH,
    "id_token",
  );
  if (idToken.split(".").length !== 3) {
    fail("id_token is not a compact JWT");
  }

  const refreshToken = document.refresh_token === undefined && !requireRefreshToken
    ? undefined
    : boundedString(
        document.refresh_token,
        MAX_OPAQUE_TOKEN_LENGTH,
        "refresh_token",
      );

  if (
    typeof document.expires_in !== "number" ||
    !Number.isSafeInteger(document.expires_in) ||
    document.expires_in <= 0 ||
    document.expires_in > 365 * 24 * 60 * 60
  ) {
    fail("expires_in must be a positive safe integer");
  }
  const expiresIn = document.expires_in;

  let tokenType: string | undefined;
  if (document.token_type !== undefined) {
    tokenType = boundedString(document.token_type, 64, "token_type");
    if (tokenType.toLowerCase() !== "bearer") {
      fail("token_type is not Bearer");
    }
  }

  return {
    accessToken,
    idToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(tokenType === undefined ? {} : { tokenType }),
    expiresIn,
  };
}

function formEncode(value: string): string {
  const encoded = new URLSearchParams([["value", value]]).toString();
  return encoded.slice("value=".length);
}

function encodeBasicCredentials(clientId: string, clientSecret: string): string {
  const userPass = `${formEncode(clientId)}:${formEncode(clientSecret)}`;
  return `Basic ${Buffer.from(userPass, "utf8").toString("base64")}`;
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  raceDeadline: <T>(operation: Promise<T>) => Promise<T>,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (
      !/^(?:0|[1-9]\d*)$/.test(declaredLength) ||
      Number(declaredLength) > maximumBytes
    ) {
      throw new Error("HTTP response exceeds the allowed size");
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(
      await raceDeadline(response.arrayBuffer()),
    );
    if (bytes.byteLength > maximumBytes) {
      throw new Error("HTTP response exceeds the allowed size");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const next = await raceDeadline(reader.read());
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        throw new Error("HTTP response exceeds the allowed size");
      }
      chunks.push(next.value);
    }
  } finally {
    if (!completed) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The deadline or a peer failure already settled the request.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A partially cancelled stream may keep the lock until its rejection.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeJsonResponse(
  response: Response,
  bytes: Uint8Array,
  acceptedMediaTypes: readonly string[],
): Record<string, unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!acceptedMediaTypes.includes(mediaType)) {
    fail("HTTP response content type is invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("HTTP response is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("HTTP response is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    fail("HTTP response JSON must be an object");
  }
  return parsed;
}

export class LinghaoPassportV4OidcClient {
  private readonly config: LinghaoPassportV4OidcConfig;
  private readonly fetchImpl: LinghaoPassportV4Fetch;
  private readonly now: () => number;
  private readonly randomBytes: LinghaoPassportV4RandomBytes;
  private readonly requestTimeoutMs: number;
  private readonly clockToleranceSeconds: number;
  private readonly endpointPolicy: "local_loopback" | "production_https";
  private readonly requireRefreshToken: boolean;
  private discoveryPromise: Promise<LinghaoPassportV4Discovery> | null = null;
  private jwksPromise: Promise<JWTVerifyGetKey> | null = null;
  private jwksKids = new Set<string>();

  constructor(options: PassportOidcOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.clockToleranceSeconds =
      options.clockToleranceSeconds ?? CLOCK_SKEW_SECONDS;
    this.endpointPolicy = options.endpointPolicy ?? "local_loopback";
    this.requireRefreshToken = options.requireRefreshToken ?? true;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 50 ||
      this.requestTimeoutMs > 30_000
    ) {
      fail("OIDC request timeout is invalid");
    }
  }

  async discover(): Promise<LinghaoPassportV4Discovery> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = this.fetchDiscovery().catch((error) => {
        this.discoveryPromise = null;
        throw error;
      });
    }
    return this.discoveryPromise;
  }

  async createAuthorizationUrl(
    secrets: LinghaoPassportV4AuthorizationSecrets,
  ): Promise<string> {
    assertAuthorizationSecrets(secrets);
    const discovery = await this.discover();
    const url = new URL(discovery.authorizationEndpoint.href);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", secrets.state);
    url.searchParams.set("nonce", secrets.nonce);
    url.searchParams.set(
      "code_challenge",
      computeLinghaoPassportV4PkceChallenge(secrets.codeVerifier),
    );
    url.searchParams.set("code_challenge_method", "S256");
    if (url.origin !== new URL(this.config.issuer).origin) {
      fail("authorization URL does not share the issuer origin");
    }
    return url.href;
  }

  async exchangeAuthorizationCode(
    code: string,
    secrets: LinghaoPassportV4AuthorizationSecrets,
  ): Promise<LinghaoPassportV4AuthenticationResult> {
    assertAuthorizationSecrets(secrets);
    boundedString(code, MAX_CODE_LENGTH, "authorization code");
    const discovery = await this.discover();

    const tokens = await this.requestTokens(discovery, {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: secrets.codeVerifier,
    });
    const identity = await verifyLinghaoPassportV4IdToken({
      idToken: tokens.idToken,
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      expectedNonce: secrets.nonce,
      keys: await this.keysForIdToken(discovery, tokens.idToken),
      now: new Date(this.now()),
      clockToleranceSeconds: this.clockToleranceSeconds,
    });
    return { tokens, identity };
  }

  async refresh(
    refreshToken: string,
    expectedSubject: string,
    expectedNonce?: string,
  ): Promise<LinghaoPassportV4AuthenticationResult> {
    boundedString(
      refreshToken,
      MAX_OPAQUE_TOKEN_LENGTH,
      "refresh token",
    );
    boundedString(expectedSubject, MAX_SUBJECT_LENGTH, "expected subject");
    const discovery = await this.discover();
    const tokens = await this.requestTokens(discovery, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (
      typeof tokens.refreshToken !== "string" ||
      tokens.refreshToken.length === 0 ||
      tokens.refreshToken === refreshToken
    ) {
      fail("refresh token rotation did not return a new token");
    }
    const identity = await verifyLinghaoPassportV4IdToken({
      idToken: tokens.idToken,
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      expectedSubject,
      allowMissingNonce: true,
      ...(expectedNonce === undefined ? {} : { expectedNonce }),
      keys: await this.keysForIdToken(discovery, tokens.idToken),
      now: new Date(this.now()),
      clockToleranceSeconds: this.clockToleranceSeconds,
    });
    return { tokens, identity };
  }

  async buildEndSessionUrl(idToken: string, state: string): Promise<string> {
    boundedString(idToken, MAX_ID_TOKEN_LENGTH, "ID token hint");
    assertOpaqueIdentifier(state, "logout state");
    const discovery = await this.discover();
    const url = new URL(discovery.endSessionEndpoint.href);
    url.searchParams.set("id_token_hint", idToken);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set(
      "post_logout_redirect_uri",
      this.config.postLogoutRedirectUri,
    );
    url.searchParams.set("state", state);
    if (url.origin !== new URL(this.config.issuer).origin) {
      fail("end-session URL does not share the issuer origin");
    }
    return url.href;
  }

  async revokeToken(
    token: string,
    tokenTypeHint: "access_token" | "refresh_token",
  ): Promise<void> {
    boundedString(token, MAX_OPAQUE_TOKEN_LENGTH, "revocation token");
    const discovery = await this.discover();
    const body = new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
    });
    const result = await this.fetchBoundedResponse(
      discovery.revocationEndpoint,
      {
        method: "POST",
        headers: {
          Accept: JSON_MEDIA_TYPE,
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: encodeBasicCredentials(
            this.config.clientId,
            this.config.clientSecret,
          ),
        },
        body: body.toString(),
      },
      MAX_REVOCATION_BYTES,
    );
    if (result.response.status !== 200) {
      fail("token revocation was rejected");
    }
  }

  private async discoveredJwks(
    discovery: LinghaoPassportV4Discovery,
  ): Promise<JWTVerifyGetKey> {
    if (!this.jwksPromise) {
      this.jwksPromise = this.fetchJwks(discovery).catch((error) => {
        this.jwksPromise = null;
        throw error;
      });
    }
    return this.jwksPromise;
  }

  private async keysForIdToken(
    discovery: LinghaoPassportV4Discovery,
    idToken: string,
  ): Promise<JWTVerifyGetKey> {
    let keys = await this.discoveredJwks(discovery);
    let kid: unknown;
    try {
      kid = decodeProtectedHeader(idToken).kid;
    } catch {
      return keys;
    }
    if (typeof kid === "string" && kid.length > 0 && !this.jwksKids.has(kid)) {
      // A new signing kid is the normal OIDC key-rotation signal. Refresh the
      // pinned JWKS endpoint once; verification still fails closed if the key
      // is absent or the replacement document is invalid.
      this.jwksPromise = null;
      this.jwksKids.clear();
      keys = await this.discoveredJwks(discovery);
    }
    return keys;
  }

  private async requestTokens(
    discovery: LinghaoPassportV4Discovery,
    fields: Record<string, string>,
  ): Promise<LinghaoPassportV4Tokens> {
    const body = new URLSearchParams(fields);
    const result = await this.fetchBoundedResponse(
      discovery.tokenEndpoint,
      {
        method: "POST",
        headers: {
          Accept: JSON_MEDIA_TYPE,
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: encodeBasicCredentials(
            this.config.clientId,
            this.config.clientSecret,
          ),
        },
        body: body.toString(),
      },
      MAX_TOKEN_BYTES,
    );
    if (result.response.status !== 200) {
      fail("token endpoint rejected the request");
    }
    return parseTokenResponse(
      decodeJsonResponse(result.response, result.bytes, [JSON_MEDIA_TYPE]),
      this.requireRefreshToken,
    );
  }

  private async fetchDiscovery(): Promise<LinghaoPassportV4Discovery> {
    const issuerUrl = parseAbsoluteHttpUrl(
      this.config.issuer,
      "configured OIDC issuer",
    );
    assertIssuer(issuerUrl, this.endpointPolicy);
    if (
      this.endpointPolicy === "local_loopback" &&
      this.config.issuer !== LINGHAO_PASSPORT_V4_ISSUER
    ) {
      fail("configured issuer is not the pinned issuer");
    }
    if (
      this.endpointPolicy === "local_loopback" &&
      this.config.clientId !== LINGHAO_PASSPORT_V4_CLIENT_ID
    ) {
      fail("configured client id is not the pinned client");
    }
    if (
      this.config.scopes.length !== LINGHAO_PASSPORT_V4_SCOPES.length ||
      !LINGHAO_PASSPORT_V4_SCOPES.every(
        (scope, index) => this.config.scopes[index] === scope,
      )
    ) {
      fail("OIDC scopes are pinned to openid profile email");
    }

    const discoveryUrl = new URL(
      "/.well-known/openid-configuration",
      issuerUrl,
    );
    const result = await this.fetchBoundedResponse(
      discoveryUrl,
      {
        method: "GET",
        headers: { Accept: JSON_MEDIA_TYPE },
      },
      MAX_DISCOVERY_BYTES,
    );
    if (result.response.status !== 200) {
      fail("discovery endpoint returned an unexpected status");
    }
    const document = decodeJsonResponse(result.response, result.bytes, [
      JSON_MEDIA_TYPE,
    ]);
    return validateDiscoveryDocument(
      document,
      this.config,
      this.endpointPolicy,
    );
  }

  private async fetchJwks(
    discovery: LinghaoPassportV4Discovery,
  ): Promise<JWTVerifyGetKey> {
    const result = await this.fetchBoundedResponse(
      discovery.jwksUri,
      {
        method: "GET",
        headers: { Accept: JSON_MEDIA_TYPE },
      },
      MAX_JWKS_BYTES,
    );
    if (result.response.status !== 200) {
      fail("JWKS endpoint returned an unexpected status");
    }
    const document = decodeJsonResponse(result.response, result.bytes, [
      JSON_MEDIA_TYPE,
      JWKS_MEDIA_TYPE,
    ]);
    const keys = createLinghaoPassportV4LocalJwks(document);
    const keyRecords = (document as { keys: Array<{ kid: string }> }).keys;
    this.jwksKids = new Set(keyRecords.map((key) => key.kid));
    return keys;
  }

  private async fetchBoundedResponse(
    url: URL,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
    const controller = new AbortController();
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error("outbound request deadline exceeded"));
    }, this.requestTimeoutMs);
    const raceDeadline = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, deadline]);
    try {
      const response = await raceDeadline(
        this.fetchImpl(url.href, {
          ...init,
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        }),
      );
      if (response.redirected) {
        fail("redirects are not accepted");
      }
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^(?:0|[1-9]\d*)$/.test(declaredLength) ||
          Number(declaredLength) > maximumBytes)
      ) {
        fail("HTTP response exceeds the allowed size");
      }
      // The same controller, timer, and raced deadline remain active until the
      // entire response body has settled. Headers alone never disarm them.
      const bytes = await readBoundedBytes(
        response,
        maximumBytes,
        raceDeadline,
      );
      return { response, bytes };
    } catch {
      controller.abort();
      fail("outbound request failed");
    } finally {
      clearTimeout(timer);
    }
    return fail("outbound request failed");
  }
}

