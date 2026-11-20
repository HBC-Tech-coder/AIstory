import "server-only";

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  COMPANY_ACCOUNT_AUDIENCE,
  COMPANY_ACCOUNT_CHANNEL_ID,
  COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS,
  COMPANY_ACCOUNT_CLIENT_ID,
  COMPANY_ACCOUNT_PRODUCT_ID,
  COMPANY_ACCOUNT_SCHEMA_VERSION,
  COMPANY_ACCOUNT_SERVER_TENANT_ID,
  hasExactOwnKeys,
  isSafePublicId,
  readOwnDataValue,
  readStrictRecord,
  type CompanyAccountErrorCode,
} from "./contracts";

export const COMPANY_ACCOUNT_AUTHORIZATION_CODE_TTL_MS = 90_000;
export const COMPANY_ACCOUNT_ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const COMPANY_ACCOUNT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const COMPANY_ACCOUNT_SESSION_SCOPES = [
  "account:read",
  "credits:read",
  "session:refresh",
] as const;
export const COMPANY_ACCOUNT_SESSION_ISSUER = "hbc-company-account" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type AuthorizationCodeRecord = {
  recordId: string;
  authorizationAttemptId: string;
  codeHash: string;
  issuer: typeof COMPANY_ACCOUNT_SESSION_ISSUER;
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  channelId: typeof COMPANY_ACCOUNT_CHANNEL_ID;
  tenantId: typeof COMPANY_ACCOUNT_SERVER_TENANT_ID;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  scopes: typeof COMPANY_ACCOUNT_SESSION_SCOPES;
  issuedAt: number;
  expiresAt: number;
  status: "ready" | "consumed" | "expired";
  consumedFamilyId?: string;
};

type TokenFamilyRecord = {
  familyId: string;
  issuer: typeof COMPANY_ACCOUNT_SESSION_ISSUER;
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  channelId: typeof COMPANY_ACCOUNT_CHANNEL_ID;
  tenantId: typeof COMPANY_ACCOUNT_SERVER_TENANT_ID;
  userId: string;
  scopes: typeof COMPANY_ACCOUNT_SESSION_SCOPES;
  status: "active" | "revoked" | "compromised";
  createdAt: number;
  absoluteExpiresAt: number;
  currentRefreshGeneration: number;
};

type AccessTokenRecord = {
  tokenHash: string;
  familyId: string;
  issuedAt: number;
  expiresAt: number;
};

type RefreshTokenRecord = {
  tokenHash: string;
  familyId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  status: "current" | "used" | "revoked";
};

type NewSessionRecords = {
  family: TokenFamilyRecord;
  access: AccessTokenRecord;
  refresh: RefreshTokenRecord;
};

type ExchangeRepositoryInput = {
  codeHash: string;
  redirectUri: string;
  verifierChallenge: string;
  now: number;
  records: NewSessionRecords;
};

type ExchangeRepositoryResult =
  | {
      status: "created";
      userId: string;
      familyId: string;
      accessExpiresAt: number;
      refreshExpiresAt: number;
    }
  | { status: "invalid" | "expired" | "replay" };

type RefreshRepositoryInput = {
  refreshHash: string;
  now: number;
  access: AccessTokenRecord;
  refresh: RefreshTokenRecord;
};

type RefreshRepositoryResult =
  | {
      status: "rotated";
      userId: string;
      familyId: string;
      accessExpiresAt: number;
      refreshExpiresAt: number;
    }
  | { status: "invalid" | "expired" | "replay" };

type AuthorizationCodeInspectionResult =
  | { status: "ready"; userId: string }
  | { status: "invalid" | "expired" | "consumed" };

export type CompanyAccountSessionPrincipal = {
  issuer: typeof COMPANY_ACCOUNT_SESSION_ISSUER;
  schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
  userId: string;
  familyId: string;
  productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
  clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
  audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  channelId: typeof COMPANY_ACCOUNT_CHANNEL_ID;
  tenantId: typeof COMPANY_ACCOUNT_SERVER_TENANT_ID;
  authType: "phone";
  scopes: typeof COMPANY_ACCOUNT_SESSION_SCOPES;
};

export type CompanyAccountTrustedAuthorizationPrincipal = {
  identitySource: "verified_phone_identity";
  authType: "phone";
  userId: string;
};

export type CompanyAccountSessionRepository = {
  createAuthorizationCode(record: AuthorizationCodeRecord): Promise<boolean>;
  inspectAuthorizationCode(input: {
    codeHash: string;
    redirectUri: string;
    verifierChallenge: string;
    now: number;
  }): Promise<AuthorizationCodeInspectionResult>;
  exchangeAuthorizationCode(
    input: ExchangeRepositoryInput,
  ): Promise<ExchangeRepositoryResult>;
  rotateRefreshToken(
    input: RefreshRepositoryInput,
  ): Promise<RefreshRepositoryResult>;
  resolveAccessToken(input: {
    accessHash: string;
    now: number;
  }): Promise<CompanyAccountSessionPrincipal | null>;
  revokeFamilyByAccessToken(input: {
    accessHash: string;
    now: number;
  }): Promise<boolean>;
  revokeFamilyById(input: { familyId: string; now: number }): Promise<boolean>;
  snapshot(): Promise<CompanyAccountSessionRepositorySnapshot>;
};

export type CompanyAccountSessionRepositorySnapshot = {
  source: "memory";
  authorizationCodes: {
    total: number;
    ready: number;
    consumed: number;
    expired: number;
  };
  tokenFamilies: {
    total: number;
    active: number;
    revoked: number;
    compromised: number;
  };
  accessTokenRecords: number;
  refreshTokenRecords: number;
  rawSecretsStored: false;
};

export class CompanyAccountSessionError extends Error {
  constructor(readonly code: CompanyAccountErrorCode) {
    super(code);
    this.name = "CompanyAccountSessionError";
  }
}

export class CompanyAccountOpaqueSecret {
  readonly #value: string;

  constructor(value: string) {
    if (!OPAQUE_TOKEN_PATTERN.test(value)) {
      throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
    }
    this.#value = value;
  }

  revealForProtocolResponse(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

export type IssuedCompanyAccountSession = {
  secrets: {
    accessToken: CompanyAccountOpaqueSecret;
    refreshToken: CompanyAccountOpaqueSecret;
  };
  public: {
    schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
    tokenType: "Bearer";
    productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
    clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
    audience: typeof COMPANY_ACCOUNT_AUDIENCE;
    sessionFamilyId: string;
    accessExpiresInSeconds: number;
    refreshExpiresInSeconds: number;
  };
};

export type CompanyAccountSessionServiceDependencies = {
  repository: CompanyAccountSessionRepository;
  resolveTrustedAuthorizationPrincipal(input: {
    authorizationAttemptId: string;
    productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
    clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
    audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  }): Promise<CompanyAccountTrustedAuthorizationPrincipal | null>;
  validateActiveProductUser(input: {
    userId: string;
    productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
    clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
    audience: typeof COMPANY_ACCOUNT_AUDIENCE;
  }): Promise<boolean>;
  now?: () => number;
  randomOpaque?: () => string;
  randomId?: () => string;
};

function domainHash(domain: "code" | "access" | "refresh", value: string): string {
  return createHash("sha256")
    .update(`harnessdesk-company-account-v1:${domain}\0`, "utf8")
    .update(value, "ascii")
    .digest("hex");
}

function randomOpaque(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function hasExactSessionScopes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === COMPANY_ACCOUNT_SESSION_SCOPES.length &&
    value.every((scope, index) => scope === COMPANY_ACCOUNT_SESSION_SCOPES[index])
  );
}

function hasExactSessionNamespace(input: {
  issuer: unknown;
  schemaVersion: unknown;
  productId: unknown;
  clientId: unknown;
  audience: unknown;
  channelId: unknown;
  tenantId: unknown;
  scopes: unknown;
}): boolean {
  return (
    input.issuer === COMPANY_ACCOUNT_SESSION_ISSUER &&
    input.schemaVersion === COMPANY_ACCOUNT_SCHEMA_VERSION &&
    input.productId === COMPANY_ACCOUNT_PRODUCT_ID &&
    input.clientId === COMPANY_ACCOUNT_CLIENT_ID &&
    input.audience === COMPANY_ACCOUNT_AUDIENCE &&
    input.channelId === COMPANY_ACCOUNT_CHANNEL_ID &&
    input.tenantId === COMPANY_ACCOUNT_SERVER_TENANT_ID &&
    hasExactSessionScopes(input.scopes)
  );
}

function isExactSessionPrincipal(
  input: CompanyAccountSessionPrincipal | null,
): input is CompanyAccountSessionPrincipal {
  return Boolean(
    input &&
      hasExactSessionNamespace(input) &&
      input.authType === "phone" &&
      safeUuid(input.userId) &&
      safeUuid(input.familyId),
  );
}

function isSafeRepositoryExpiry(
  value: unknown,
  now: number,
  maximumTtlMs: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > now &&
    value <= now + maximumTtlMs
  );
}

export function derivePkceS256Challenge(verifier: string): string | null {
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) return null;
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function normalizeCompanyAccountRedirectUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 160) return null;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/callback" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65_535
    ) {
      return null;
    }
    return `http://127.0.0.1:${port}/callback`;
  } catch {
    return null;
  }
}

function hasExactClientIdentity(record: Record<string, unknown>): boolean {
  return (
    readOwnDataValue(record, "schemaVersion") ===
      COMPANY_ACCOUNT_SCHEMA_VERSION &&
    readOwnDataValue(record, "productId") === COMPANY_ACCOUNT_PRODUCT_ID &&
    readOwnDataValue(record, "clientId") === COMPANY_ACCOUNT_CLIENT_ID &&
    readOwnDataValue(record, "audience") === COMPANY_ACCOUNT_AUDIENCE &&
    readOwnDataValue(record, "channelId") === COMPANY_ACCOUNT_CHANNEL_ID
  );
}

function strictInput(
  input: unknown,
  additionalKeys: readonly string[],
): Record<string, unknown> {
  const record = readStrictRecord(input);
  if (
    !record ||
    !hasExactOwnKeys(record, [
      ...COMPANY_ACCOUNT_CLIENT_CONTEXT_KEYS,
      ...additionalKeys,
    ]) ||
    !hasExactClientIdentity(record)
  ) {
    throw new CompanyAccountSessionError("INVALID_REQUEST");
  }
  return record;
}

function safeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function parseTrustedPrincipal(
  input: unknown,
): CompanyAccountTrustedAuthorizationPrincipal | null {
  const record = readStrictRecord(input);
  if (
    !record ||
    !hasExactOwnKeys(record, ["identitySource", "authType", "userId"]) ||
    readOwnDataValue(record, "identitySource") !==
      "verified_phone_identity" ||
    readOwnDataValue(record, "authType") !== "phone"
  ) {
    return null;
  }
  const userId = safeUuid(readOwnDataValue(record, "userId"));
  return userId
    ? { identitySource: "verified_phone_identity", authType: "phone", userId }
    : null;
}

function safeOpaque(value: unknown): string | null {
  return typeof value === "string" && OPAQUE_TOKEN_PATTERN.test(value)
    ? value
    : null;
}

function safeNonce(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value)
    ? value
    : null;
}

function buildIssuedSession(input: {
  accessToken: string;
  refreshToken: string;
  familyId: string;
  now: number;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}): IssuedCompanyAccountSession {
  return {
    secrets: {
      accessToken: new CompanyAccountOpaqueSecret(input.accessToken),
      refreshToken: new CompanyAccountOpaqueSecret(input.refreshToken),
    },
    public: {
      schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
      tokenType: "Bearer",
      productId: COMPANY_ACCOUNT_PRODUCT_ID,
      clientId: COMPANY_ACCOUNT_CLIENT_ID,
      audience: COMPANY_ACCOUNT_AUDIENCE,
      sessionFamilyId: input.familyId,
      accessExpiresInSeconds: Math.max(
        0,
        Math.floor((input.accessExpiresAt - input.now) / 1000),
      ),
      refreshExpiresInSeconds: Math.max(
        0,
        Math.floor((input.refreshExpiresAt - input.now) / 1000),
      ),
    },
  };
}

export function createCompanyAccountSessionService(
  dependencies: CompanyAccountSessionServiceDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const nextOpaque = dependencies.randomOpaque ?? randomOpaque;
  const nextId = dependencies.randomId ?? randomUUID;

  async function activeProductUserStatus(
    userId: string,
  ): Promise<"active" | "inactive" | "unavailable"> {
    try {
      return (await dependencies.validateActiveProductUser({
          userId,
          productId: COMPANY_ACCOUNT_PRODUCT_ID,
          clientId: COMPANY_ACCOUNT_CLIENT_ID,
          audience: COMPANY_ACCOUNT_AUDIENCE,
        })) === true
        ? "active"
        : "inactive";
    } catch {
      return "unavailable";
    }
  }

  async function revokeFamily(familyId: string): Promise<void> {
    try {
      await dependencies.repository.revokeFamilyById({
        familyId,
        now: now(),
      });
    } catch {
      // The caller still receives a fixed fail-closed error.
    }
  }

  return {
    async issueAuthorizationCode(input: unknown): Promise<{
      authorizationCode: CompanyAccountOpaqueSecret;
      public: {
        schemaVersion: typeof COMPANY_ACCOUNT_SCHEMA_VERSION;
        productId: typeof COMPANY_ACCOUNT_PRODUCT_ID;
        clientId: typeof COMPANY_ACCOUNT_CLIENT_ID;
        audience: typeof COMPANY_ACCOUNT_AUDIENCE;
        expiresInSeconds: number;
      };
    }> {
      const record = strictInput(input, [
        "redirectUri",
        "codeChallenge",
        "codeChallengeMethod",
        "nonce",
        "authorizationAttemptId",
      ]);
      const redirectUri = normalizeCompanyAccountRedirectUri(
        readOwnDataValue(record, "redirectUri"),
      );
      const codeChallenge = readOwnDataValue(record, "codeChallenge");
      const nonce = safeNonce(readOwnDataValue(record, "nonce"));
      const authorizationAttemptId = readOwnDataValue(
        record,
        "authorizationAttemptId",
      );
      if (
        !redirectUri ||
        typeof codeChallenge !== "string" ||
        !PKCE_CHALLENGE_PATTERN.test(codeChallenge) ||
        readOwnDataValue(record, "codeChallengeMethod") !== "S256" ||
        !nonce ||
        !isSafePublicId(authorizationAttemptId, 16, 128)
      ) {
        throw new CompanyAccountSessionError("INVALID_REQUEST");
      }
      let principal: CompanyAccountTrustedAuthorizationPrincipal | null = null;
      try {
        principal = parseTrustedPrincipal(
          await dependencies.resolveTrustedAuthorizationPrincipal({
            authorizationAttemptId,
            productId: COMPANY_ACCOUNT_PRODUCT_ID,
            clientId: COMPANY_ACCOUNT_CLIENT_ID,
            audience: COMPANY_ACCOUNT_AUDIENCE,
          }),
        );
      } catch {
        principal = null;
      }
      if (!principal) {
        throw new CompanyAccountSessionError("ACCOUNT_UNAVAILABLE");
      }
      const activeStatus = await activeProductUserStatus(principal.userId);
      if (activeStatus === "unavailable") {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      if (activeStatus === "inactive") {
        throw new CompanyAccountSessionError("ACCOUNT_UNAVAILABLE");
      }
      const authorizationCode = nextOpaque();
      const recordId = nextId();
      if (!OPAQUE_TOKEN_PATTERN.test(authorizationCode)) {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      if (!safeUuid(recordId)) {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      const issuedAt = now();
      const created = await dependencies.repository.createAuthorizationCode({
        recordId,
        authorizationAttemptId,
        codeHash: domainHash("code", authorizationCode),
        issuer: COMPANY_ACCOUNT_SESSION_ISSUER,
        schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
        productId: COMPANY_ACCOUNT_PRODUCT_ID,
        clientId: COMPANY_ACCOUNT_CLIENT_ID,
        audience: COMPANY_ACCOUNT_AUDIENCE,
        channelId: COMPANY_ACCOUNT_CHANNEL_ID,
        tenantId: COMPANY_ACCOUNT_SERVER_TENANT_ID,
        userId: principal.userId,
        redirectUri,
        codeChallenge,
        nonce,
        scopes: COMPANY_ACCOUNT_SESSION_SCOPES,
        issuedAt,
        expiresAt: issuedAt + COMPANY_ACCOUNT_AUTHORIZATION_CODE_TTL_MS,
        status: "ready",
      });
      if (!created) {
        throw new CompanyAccountSessionError("IDEMPOTENCY_CONFLICT");
      }
      return {
        authorizationCode: new CompanyAccountOpaqueSecret(authorizationCode),
        public: {
          schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
          productId: COMPANY_ACCOUNT_PRODUCT_ID,
          clientId: COMPANY_ACCOUNT_CLIENT_ID,
          audience: COMPANY_ACCOUNT_AUDIENCE,
          expiresInSeconds:
            COMPANY_ACCOUNT_AUTHORIZATION_CODE_TTL_MS / 1000,
        },
      };
    },

    async exchangeAuthorizationCode(
      input: unknown,
    ): Promise<IssuedCompanyAccountSession> {
      const record = strictInput(input, [
        "authorizationCode",
        "codeVerifier",
        "redirectUri",
      ]);
      const authorizationCode = safeOpaque(
        readOwnDataValue(record, "authorizationCode"),
      );
      const codeVerifier = readOwnDataValue(record, "codeVerifier");
      const redirectUri = normalizeCompanyAccountRedirectUri(
        readOwnDataValue(record, "redirectUri"),
      );
      const verifierChallenge =
        typeof codeVerifier === "string"
          ? derivePkceS256Challenge(codeVerifier)
          : null;
      if (!authorizationCode || !redirectUri || !verifierChallenge) {
        throw new CompanyAccountSessionError("INVALID_REQUEST");
      }
      const issuedAt = now();
      const familyId = nextId();
      const accessToken = nextOpaque();
      const refreshToken = nextOpaque();
      if (
        !safeUuid(familyId) ||
        !OPAQUE_TOKEN_PATTERN.test(accessToken) ||
        !OPAQUE_TOKEN_PATTERN.test(refreshToken)
      ) {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      const codeHash = domainHash("code", authorizationCode);
      const inspection = await dependencies.repository.inspectAuthorizationCode({
        codeHash,
        redirectUri,
        verifierChallenge,
        now: issuedAt,
      });
      if (inspection.status === "expired") {
        throw new CompanyAccountSessionError("SESSION_EXPIRED");
      }
      if (inspection.status === "invalid") {
        throw new CompanyAccountSessionError("AUTH_REQUIRED");
      }
      if (inspection.status === "ready") {
        const activeStatus = await activeProductUserStatus(inspection.userId);
        if (activeStatus === "unavailable") {
          throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
        }
        if (activeStatus === "inactive") {
          throw new CompanyAccountSessionError("ACCOUNT_UNAVAILABLE");
        }
      }
      const result = await dependencies.repository.exchangeAuthorizationCode({
        codeHash,
        redirectUri,
        verifierChallenge,
        now: issuedAt,
        records: {
          family: {
            familyId,
            issuer: COMPANY_ACCOUNT_SESSION_ISSUER,
            schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
            productId: COMPANY_ACCOUNT_PRODUCT_ID,
            clientId: COMPANY_ACCOUNT_CLIENT_ID,
            audience: COMPANY_ACCOUNT_AUDIENCE,
            channelId: COMPANY_ACCOUNT_CHANNEL_ID,
            tenantId: COMPANY_ACCOUNT_SERVER_TENANT_ID,
            userId: "",
            scopes: COMPANY_ACCOUNT_SESSION_SCOPES,
            status: "active",
            createdAt: issuedAt,
            absoluteExpiresAt:
              issuedAt + COMPANY_ACCOUNT_REFRESH_TOKEN_TTL_MS,
            currentRefreshGeneration: 0,
          },
          access: {
            tokenHash: domainHash("access", accessToken),
            familyId,
            issuedAt,
            expiresAt: issuedAt + COMPANY_ACCOUNT_ACCESS_TOKEN_TTL_MS,
          },
          refresh: {
            tokenHash: domainHash("refresh", refreshToken),
            familyId,
            generation: 0,
            issuedAt,
            expiresAt: issuedAt + COMPANY_ACCOUNT_REFRESH_TOKEN_TTL_MS,
            status: "current",
          },
        },
      });
      if (result.status !== "created") {
        throw new CompanyAccountSessionError(
          result.status === "expired" ? "SESSION_EXPIRED" : "AUTH_REQUIRED",
        );
      }
      if (
        !safeUuid(result.userId) ||
        !safeUuid(result.familyId) ||
        result.familyId !== familyId ||
        !isSafeRepositoryExpiry(
          result.accessExpiresAt,
          issuedAt,
          COMPANY_ACCOUNT_ACCESS_TOKEN_TTL_MS,
        ) ||
        !isSafeRepositoryExpiry(
          result.refreshExpiresAt,
          issuedAt,
          COMPANY_ACCOUNT_REFRESH_TOKEN_TTL_MS,
        )
      ) {
        await revokeFamily(result.familyId);
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      const activeStatus = await activeProductUserStatus(result.userId);
      if (activeStatus !== "active") {
        await revokeFamily(result.familyId);
        throw new CompanyAccountSessionError(
          activeStatus === "inactive"
            ? "ACCOUNT_UNAVAILABLE"
            : "SERVICE_UNAVAILABLE",
        );
      }
      return buildIssuedSession({
        accessToken,
        refreshToken,
        familyId,
        now: issuedAt,
        accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt,
      });
    },

    async refreshSession(input: unknown): Promise<IssuedCompanyAccountSession> {
      const record = strictInput(input, ["refreshToken"]);
      const oldRefreshToken = safeOpaque(
        readOwnDataValue(record, "refreshToken"),
      );
      if (!oldRefreshToken) {
        throw new CompanyAccountSessionError("INVALID_REQUEST");
      }
      const issuedAt = now();
      const accessToken = nextOpaque();
      const refreshToken = nextOpaque();
      if (
        !OPAQUE_TOKEN_PATTERN.test(accessToken) ||
        !OPAQUE_TOKEN_PATTERN.test(refreshToken)
      ) {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      const provisionalFamilyId = nextId();
      if (!safeUuid(provisionalFamilyId)) {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      const result = await dependencies.repository.rotateRefreshToken({
        refreshHash: domainHash("refresh", oldRefreshToken),
        now: issuedAt,
        access: {
          tokenHash: domainHash("access", accessToken),
          familyId: provisionalFamilyId,
          issuedAt,
          expiresAt: issuedAt + COMPANY_ACCOUNT_ACCESS_TOKEN_TTL_MS,
        },
        refresh: {
          tokenHash: domainHash("refresh", refreshToken),
          familyId: provisionalFamilyId,
          generation: 0,
          issuedAt,
          expiresAt: issuedAt + COMPANY_ACCOUNT_REFRESH_TOKEN_TTL_MS,
          status: "current",
        },
      });
      if (result.status !== "rotated") {
        throw new CompanyAccountSessionError("SESSION_EXPIRED");
      }
      if (
        !safeUuid(result.userId) ||
        !safeUuid(result.familyId) ||
        !isSafeRepositoryExpiry(
          result.accessExpiresAt,
          issuedAt,
          COMPANY_ACCOUNT_ACCESS_TOKEN_TTL_MS,
        ) ||
        !isSafeRepositoryExpiry(
          result.refreshExpiresAt,
          issuedAt,
          COMPANY_ACCOUNT_REFRESH_TOKEN_TTL_MS,
        )
      ) {
        await revokeFamily(result.familyId);
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      const activeStatus = await activeProductUserStatus(result.userId);
      if (activeStatus !== "active") {
        await revokeFamily(result.familyId);
        throw new CompanyAccountSessionError(
          activeStatus === "inactive"
            ? "ACCOUNT_UNAVAILABLE"
            : "SERVICE_UNAVAILABLE",
        );
      }
      return buildIssuedSession({
        accessToken,
        refreshToken,
        familyId: result.familyId,
        now: issuedAt,
        accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt,
      });
    },

    async authenticateAccessToken(
      input: unknown,
    ): Promise<CompanyAccountSessionPrincipal> {
      const record = strictInput(input, ["accessToken"]);
      const accessToken = safeOpaque(readOwnDataValue(record, "accessToken"));
      if (!accessToken) {
        throw new CompanyAccountSessionError("INVALID_REQUEST");
      }
      const principal = await dependencies.repository.resolveAccessToken({
        accessHash: domainHash("access", accessToken),
        now: now(),
      });
      if (!isExactSessionPrincipal(principal)) {
        throw new CompanyAccountSessionError("AUTH_REQUIRED");
      }
      const activeStatus = await activeProductUserStatus(principal.userId);
      if (activeStatus === "unavailable") {
        throw new CompanyAccountSessionError("SERVICE_UNAVAILABLE");
      }
      if (activeStatus === "inactive") {
        await revokeFamily(principal.familyId);
        throw new CompanyAccountSessionError("ACCOUNT_UNAVAILABLE");
      }
      const rechecked = await dependencies.repository.resolveAccessToken({
        accessHash: domainHash("access", accessToken),
        now: now(),
      });
      if (
        !isExactSessionPrincipal(rechecked) ||
        rechecked.familyId !== principal.familyId ||
        rechecked.userId !== principal.userId
      ) {
        throw new CompanyAccountSessionError("AUTH_REQUIRED");
      }
      return rechecked;
    },

    async logout(input: unknown): Promise<{ ok: true }> {
      const record = strictInput(input, ["accessToken"]);
      const accessToken = safeOpaque(readOwnDataValue(record, "accessToken"));
      if (!accessToken) {
        throw new CompanyAccountSessionError("INVALID_REQUEST");
      }
      await dependencies.repository.revokeFamilyByAccessToken({
        accessHash: domainHash("access", accessToken),
        now: now(),
      });
      return { ok: true };
    },
  };
}

export class MemoryCompanyAccountSessionRepository
  implements CompanyAccountSessionRepository
{
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly authorizationAttempts = new Set<string>();
  private readonly families = new Map<string, TokenFamilyRecord>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  private async mutate<T>(callback: () => T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.mutationTail;
    this.mutationTail = previous.then(() => gate);
    await previous;
    try {
      return callback();
    } finally {
      release();
    }
  }

  private compromiseFamily(familyId: string): void {
    const family = this.families.get(familyId);
    if (!family) return;
    family.status = "compromised";
    for (const refresh of this.refreshTokens.values()) {
      if (refresh.familyId === familyId) refresh.status = "revoked";
    }
  }

  async createAuthorizationCode(record: AuthorizationCodeRecord): Promise<boolean> {
    return this.mutate(() => {
      if (
        this.authorizationCodes.has(record.codeHash) ||
        this.authorizationAttempts.has(record.authorizationAttemptId)
      ) {
        return false;
      }
      this.authorizationCodes.set(record.codeHash, structuredClone(record));
      this.authorizationAttempts.add(record.authorizationAttemptId);
      return true;
    });
  }

  async inspectAuthorizationCode(input: {
    codeHash: string;
    redirectUri: string;
    verifierChallenge: string;
    now: number;
  }): Promise<AuthorizationCodeInspectionResult> {
    return this.mutate(() => {
      const code = this.authorizationCodes.get(input.codeHash);
      if (
        !code ||
        code.redirectUri !== input.redirectUri ||
        !hasExactSessionNamespace(code) ||
        !safeUuid(code.userId) ||
        !safeEqualText(code.codeChallenge, input.verifierChallenge)
      ) {
        return { status: "invalid" };
      }
      if (code.status === "expired" || code.expiresAt <= input.now) {
        code.status = "expired";
        this.authorizationAttempts.delete(code.authorizationAttemptId);
        return { status: "expired" };
      }
      return code.status === "consumed"
        ? { status: "consumed" }
        : { status: "ready", userId: code.userId };
    });
  }

  async exchangeAuthorizationCode(
    input: ExchangeRepositoryInput,
  ): Promise<ExchangeRepositoryResult> {
    return this.mutate(() => {
      const code = this.authorizationCodes.get(input.codeHash);
      if (!code) return { status: "invalid" };
      if (
        code.redirectUri !== input.redirectUri ||
        !hasExactSessionNamespace(code) ||
        !safeUuid(code.userId) ||
        !safeEqualText(code.codeChallenge, input.verifierChallenge)
      ) {
        return { status: "invalid" };
      }
      if (code.status === "consumed") {
        if (code.consumedFamilyId) this.compromiseFamily(code.consumedFamilyId);
        return { status: "replay" };
      }
      if (code.status === "expired" || code.expiresAt <= input.now) {
        code.status = "expired";
        return { status: "expired" };
      }
      if (
        !hasExactSessionNamespace(input.records.family) ||
        !safeUuid(input.records.family.familyId) ||
        input.records.family.status !== "active" ||
        input.records.family.currentRefreshGeneration !== 0 ||
        input.records.access.familyId !== input.records.family.familyId ||
        input.records.refresh.familyId !== input.records.family.familyId ||
        input.records.refresh.generation !== 0 ||
        input.records.refresh.status !== "current" ||
        this.families.has(input.records.family.familyId) ||
        this.accessTokens.has(input.records.access.tokenHash) ||
        this.refreshTokens.has(input.records.refresh.tokenHash)
      ) {
        return { status: "invalid" };
      }
      const family = {
        ...structuredClone(input.records.family),
        userId: code.userId,
      };
      this.families.set(family.familyId, family);
      this.accessTokens.set(
        input.records.access.tokenHash,
        structuredClone(input.records.access),
      );
      this.refreshTokens.set(
        input.records.refresh.tokenHash,
        structuredClone(input.records.refresh),
      );
      code.status = "consumed";
      code.consumedFamilyId = family.familyId;
      return {
        status: "created",
        userId: code.userId,
        familyId: family.familyId,
        accessExpiresAt: input.records.access.expiresAt,
        refreshExpiresAt: input.records.refresh.expiresAt,
      };
    });
  }

  async rotateRefreshToken(
    input: RefreshRepositoryInput,
  ): Promise<RefreshRepositoryResult> {
    return this.mutate(() => {
      const current = this.refreshTokens.get(input.refreshHash);
      if (!current) return { status: "invalid" };
      const family = this.families.get(current.familyId);
      if (!family) return { status: "invalid" };
      if (
        !hasExactSessionNamespace(family) ||
        !safeUuid(family.userId) ||
        !safeUuid(family.familyId)
      ) {
        this.compromiseFamily(family.familyId);
        return { status: "invalid" };
      }
      if (current.generation !== family.currentRefreshGeneration) {
        this.compromiseFamily(family.familyId);
        return { status: "invalid" };
      }
      if (current.status !== "current") {
        this.compromiseFamily(family.familyId);
        return { status: "replay" };
      }
      if (
        family.status !== "active" ||
        current.expiresAt <= input.now ||
        family.absoluteExpiresAt <= input.now
      ) {
        current.status = "revoked";
        family.status = "revoked";
        return { status: "expired" };
      }
      if (
        this.accessTokens.has(input.access.tokenHash) ||
        this.refreshTokens.has(input.refresh.tokenHash)
      ) {
        this.compromiseFamily(family.familyId);
        return { status: "replay" };
      }
      current.status = "used";
      family.currentRefreshGeneration += 1;
      const access = {
        ...structuredClone(input.access),
        familyId: family.familyId,
        expiresAt: Math.min(input.access.expiresAt, family.absoluteExpiresAt),
      };
      const refresh = {
        ...structuredClone(input.refresh),
        familyId: family.familyId,
        generation: family.currentRefreshGeneration,
        expiresAt: Math.min(input.refresh.expiresAt, family.absoluteExpiresAt),
      };
      this.accessTokens.set(access.tokenHash, access);
      this.refreshTokens.set(refresh.tokenHash, refresh);
      return {
        status: "rotated",
        userId: family.userId,
        familyId: family.familyId,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt: refresh.expiresAt,
      };
    });
  }

  async resolveAccessToken(input: {
    accessHash: string;
    now: number;
  }): Promise<CompanyAccountSessionPrincipal | null> {
    await this.mutationTail;
    const access = this.accessTokens.get(input.accessHash);
    if (!access || access.expiresAt <= input.now) return null;
    const family = this.families.get(access.familyId);
    if (
      !family ||
      family.status !== "active" ||
      family.absoluteExpiresAt <= input.now ||
      !hasExactSessionNamespace(family) ||
      !safeUuid(family.userId) ||
      !safeUuid(family.familyId)
    ) {
      return null;
    }
    return {
      issuer: COMPANY_ACCOUNT_SESSION_ISSUER,
      schemaVersion: COMPANY_ACCOUNT_SCHEMA_VERSION,
      userId: family.userId,
      familyId: family.familyId,
      productId: COMPANY_ACCOUNT_PRODUCT_ID,
      clientId: COMPANY_ACCOUNT_CLIENT_ID,
      audience: COMPANY_ACCOUNT_AUDIENCE,
      channelId: COMPANY_ACCOUNT_CHANNEL_ID,
      tenantId: COMPANY_ACCOUNT_SERVER_TENANT_ID,
      authType: "phone",
      scopes: COMPANY_ACCOUNT_SESSION_SCOPES,
    };
  }

  async revokeFamilyByAccessToken(input: {
    accessHash: string;
    now: number;
  }): Promise<boolean> {
    return this.mutate(() => {
      const access = this.accessTokens.get(input.accessHash);
      if (!access) return false;
      const family = this.families.get(access.familyId);
      if (
        !family ||
        !hasExactSessionNamespace(family) ||
        !safeUuid(family.userId) ||
        !safeUuid(family.familyId)
      ) {
        return false;
      }
      if (family.status === "active") family.status = "revoked";
      for (const refresh of this.refreshTokens.values()) {
        if (refresh.familyId === family.familyId) refresh.status = "revoked";
      }
      return true;
    });
  }

  async revokeFamilyById(input: {
    familyId: string;
    now: number;
  }): Promise<boolean> {
    return this.mutate(() => {
      const family = this.families.get(input.familyId);
      if (
        !family ||
        !hasExactSessionNamespace(family) ||
        !safeUuid(family.userId) ||
        !safeUuid(family.familyId)
      ) {
        return false;
      }
      if (family.status === "active") family.status = "revoked";
      for (const refresh of this.refreshTokens.values()) {
        if (refresh.familyId === family.familyId) refresh.status = "revoked";
      }
      return true;
    });
  }

  async snapshot(): Promise<CompanyAccountSessionRepositorySnapshot> {
    await this.mutationTail;
    const codes = [...this.authorizationCodes.values()];
    const families = [...this.families.values()];
    return {
      source: "memory",
      authorizationCodes: {
        total: codes.length,
        ready: codes.filter((item) => item.status === "ready").length,
        consumed: codes.filter((item) => item.status === "consumed").length,
        expired: codes.filter((item) => item.status === "expired").length,
      },
      tokenFamilies: {
        total: families.length,
        active: families.filter((item) => item.status === "active").length,
        revoked: families.filter((item) => item.status === "revoked").length,
        compromised: families.filter((item) => item.status === "compromised")
          .length,
      },
      accessTokenRecords: this.accessTokens.size,
      refreshTokenRecords: this.refreshTokens.size,
      rawSecretsStored: false,
    };
  }

  async containsRawSecretForTest(values: readonly string[]): Promise<boolean> {
    await this.mutationTail;
    const serialized = JSON.stringify({
      authorizationCodes: [...this.authorizationCodes.entries()],
      authorizationAttempts: [...this.authorizationAttempts],
      families: [...this.families.entries()],
      accessTokens: [...this.accessTokens.entries()],
      refreshTokens: [...this.refreshTokens.entries()],
    });
    return values.some((value) => serialized.includes(value));
  }
}
