import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  LINGHAO_PASSPORT_V4_DRAFT_MAX_BYTES,
  LINGHAO_PASSPORT_V4_DISPLAY_NAME,
  LINGHAO_PASSPORT_V4_MAX_FAMILIES,
  LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS,
  LINGHAO_PASSPORT_V4_MAX_PROFILES,
  LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS,
  LINGHAO_PASSPORT_V4_MAX_SESSIONS,
  LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS,
} from "./linghaoPassportV4Config";
import type { LinghaoPassportV4Identity } from "./linghaoPassportV4Oidc";

export type LinghaoPassportV4SessionRandomBytes = (size: number) => Uint8Array;

export interface LinghaoPassportV4Session {
  readonly id: string;
  readonly profileId: string;
  readonly createdAt: number;
  lastSeenAt: number;
  readonly absoluteExpiresAt: number;
  identity: LinghaoPassportV4Identity;
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  revoked?: boolean;
}

export interface AuthenticatedSessionInput {
  readonly profileId: string;
  readonly identity: LinghaoPassportV4Identity;
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: number;
}

export interface RefreshTicket {
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly subject: string;
  readonly nonce?: string;
}

export interface RefreshedSessionInput {
  readonly identity: LinghaoPassportV4Identity;
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: number;
}

export interface PassportSafeProfile {
  readonly localTestOnly: true;
  readonly displayName: typeof LINGHAO_PASSPORT_V4_DISPLAY_NAME;
  readonly profileId: string;
  readonly balance: null;
  readonly ledger: readonly [];
  readonly capabilities: {
    readonly administrator: false;
    readonly phoneAccount: false;
    readonly formalWallet: false;
    readonly legacyWorks: false;
    readonly cloudProgress: false;
    readonly hostedByok: false;
  };
}

export interface PassportSafeSession {
  readonly authenticated: true;
  readonly profile: PassportSafeProfile;
  readonly session: {
    readonly idleExpiresAt: number;
    readonly absoluteExpiresAt: number;
  };
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_DOMAIN = "aistory:linghao-passport-v4:profile:v1\u0000";

function fail(message: string): never {
  throw new Error(message);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
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

function drawOpaqueIdentifier(
  randomBytes: LinghaoPassportV4SessionRandomBytes,
  size = 32,
): string {
  const bytes = randomBytes(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    fail("secure random source returned an invalid length");
  }
  return base64Url(bytes);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function lengthPrefix(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
}

/**
 * Opaque, RFC-4122-shaped UUID derived from the exact issuer and subject. The
 * domain separator and length-prefixed inputs keep the derivation unambiguous.
 * Raw subject or email values are never part of the safe profile DTO.
 */
export function deriveLinghaoPassportV4ProfileId(
  issuer: string,
  subject: string,
): string {
  if (
    typeof issuer !== "string" ||
    issuer.length === 0 ||
    issuer.length > 2048 ||
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > 512
  ) {
    fail("profile identity is invalid");
  }
  const digest = createHash("sha256")
    .update(PROFILE_DOMAIN, "utf8")
    .update(lengthPrefix(issuer))
    .update(lengthPrefix(subject))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class LinghaoPassportV4SessionStore {
  private readonly sessions = new Map<string, LinghaoPassportV4Session>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly randomBytes: LinghaoPassportV4SessionRandomBytes;

  constructor(options: {
    idleMs: number;
    absoluteMs: number;
    maxSessions?: number;
    now?: () => number;
    randomBytes?: LinghaoPassportV4SessionRandomBytes;
  }) {
    this.idleMs = options.idleMs;
    this.absoluteMs = options.absoluteMs;
    this.maxSessions = options.maxSessions ?? LINGHAO_PASSPORT_V4_MAX_SESSIONS;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    if (
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      this.maxSessions > 1024
    ) {
      fail("session capacity is invalid");
    }
  }

  /**
   * Replaces the caller's previous live session, then enforces the explicit
   * session cap. An active security binding is never evicted to make room.
   */
  createAuthenticated(
    existingSessionId: string | undefined,
    input: AuthenticatedSessionInput,
  ): LinghaoPassportV4Session | null {
    this.sweep();
    if (existingSessionId) {
      this.sessions.delete(existingSessionId);
    }
    if (this.sessions.size >= this.maxSessions) return null;
    const timestamp = this.now();
    const session: LinghaoPassportV4Session = {
      id: drawOpaqueIdentifier(this.randomBytes),
      profileId: input.profileId,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      absoluteExpiresAt: timestamp + this.absoluteMs,
      identity: input.identity,
      idToken: input.idToken,
      accessToken: input.accessToken,
      ...(input.refreshToken === undefined
        ? {}
        : { refreshToken: input.refreshToken }),
      ...(input.accessTokenExpiresAt === undefined
        ? {}
        : { accessTokenExpiresAt: input.accessTokenExpiresAt }),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string | undefined): LinghaoPassportV4Session | null {
    this.sweep();
    if (!isOpaqueIdentifier(sessionId)) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.revoked === true) {
      if (session) this.sessions.delete(session.id);
      return null;
    }
    const timestamp = this.now();
    if (
      timestamp - session.lastSeenAt > this.idleMs ||
      timestamp >= session.absoluteExpiresAt
    ) {
      this.sessions.delete(session.id);
      return null;
    }
    if (
      session.identity.expiresAt * 1000 <= timestamp &&
      session.refreshToken === undefined
    ) {
      this.sessions.delete(session.id);
      return null;
    }
    session.lastSeenAt = timestamp;
    return session;
  }

  peek(sessionId: string | undefined): LinghaoPassportV4Session | null {
    this.sweep();
    if (!isOpaqueIdentifier(sessionId)) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.revoked === true) return null;
    const timestamp = this.now();
    if (
      timestamp - session.lastSeenAt > this.idleMs ||
      timestamp >= session.absoluteExpiresAt
    ) {
      return null;
    }
    return session;
  }

  needsRefresh(
    session: LinghaoPassportV4Session,
    force = false,
    skewMs = 60_000,
  ): boolean {
    if (session.revoked === true) return false;
    if (force) return true;
    if (session.refreshToken === undefined) return false;
    const timestamp = this.now();
    if (session.identity.expiresAt * 1000 <= timestamp + skewMs) {
      return true;
    }
    return (
      session.accessTokenExpiresAt !== undefined &&
      session.accessTokenExpiresAt <= timestamp + skewMs
    );
  }

  beginRefresh(session: LinghaoPassportV4Session): RefreshTicket | null {
    this.sweep();
    if (
      session.revoked === true ||
      session.refreshToken === undefined ||
      !this.sessions.has(session.id)
    ) {
      return null;
    }
    return {
      sessionId: session.id,
      refreshToken: session.refreshToken,
      subject: session.identity.subject,
      ...(session.identity.nonce === undefined
        ? {}
        : { nonce: session.identity.nonce }),
    };
  }

  applyRefresh(
    sessionId: string,
    usedRefreshToken: string,
    input: RefreshedSessionInput,
  ): boolean {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.revoked === true) return false;
    if (session.refreshToken !== usedRefreshToken) return false;
    if (input.identity.subject !== session.identity.subject) return false;
    if (
      typeof input.refreshToken !== "string" ||
      input.refreshToken.length === 0 ||
      input.refreshToken === usedRefreshToken
    ) {
      return false;
    }
    session.identity = input.identity;
    session.idToken = input.idToken;
    session.accessToken = input.accessToken;
    session.refreshToken = input.refreshToken;
    if (input.accessTokenExpiresAt === undefined) {
      delete session.accessTokenExpiresAt;
    } else {
      session.accessTokenExpiresAt = input.accessTokenExpiresAt;
    }
    return true;
  }

  invalidateAfterRefreshFailure(
    sessionId: string,
    usedRefreshToken: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session && session.refreshToken === usedRefreshToken) {
      this.sessions.delete(sessionId);
    }
  }

  beginLogout(
    sessionId: string | undefined,
  ): LinghaoPassportV4Session | null {
    this.sweep();
    if (!isOpaqueIdentifier(sessionId)) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.revoked = true;
    this.sessions.delete(session.id);
    return { ...session };
  }

  destroy(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  size(): number {
    this.sweep();
    return this.sessions.size;
  }

  sweep(): void {
    const timestamp = this.now();
    for (const [id, session] of this.sessions) {
      if (
        session.revoked === true ||
        timestamp - session.lastSeenAt > this.idleMs ||
        timestamp >= session.absoluteExpiresAt ||
        (session.identity.expiresAt * 1000 <= timestamp &&
          session.refreshToken === undefined)
      ) {
        this.sessions.delete(id);
      }
    }
  }
}

/**
 * Bounded index of opaque browser-family identifiers. A family can have at most
 * one live local session; a successful callback atomically rebinds it.
 */
export class LinghaoPassportV4FamilyStore {
  private readonly families = new Map<
    string,
    {
      sessionId: string | null;
      createdAt: number;
      lastSeenAt: number;
      readonly expiresAt: number;
    }
  >();
  private readonly ttlMs: number;
  private readonly maxFamilies: number;
  private readonly now: () => number;

  constructor(options: {
    ttlMs: number;
    maxFamilies?: number;
    now?: () => number;
  }) {
    this.ttlMs = options.ttlMs;
    this.maxFamilies = options.maxFamilies ?? LINGHAO_PASSPORT_V4_MAX_FAMILIES;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.maxFamilies) ||
      this.maxFamilies < 1 ||
      this.maxFamilies > 1024
    ) {
      fail("browser-family capacity is invalid");
    }
  }

  reserve(familyId: string): boolean {
    this.sweep();
    if (!isOpaqueIdentifier(familyId)) return false;
    const existing = this.families.get(familyId);
    const timestamp = this.now();
    if (existing) {
      existing.lastSeenAt = timestamp;
      return true;
    }
    if (this.families.size >= this.maxFamilies) return false;
    this.families.set(familyId, {
      sessionId: null,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: timestamp + this.ttlMs,
    });
    return true;
  }

  getSessionId(familyId: string | undefined): string | null {
    this.sweep();
    if (!isOpaqueIdentifier(familyId)) return null;
    return this.families.get(familyId)?.sessionId ?? null;
  }

  has(familyId: string | undefined): boolean {
    this.sweep();
    if (!isOpaqueIdentifier(familyId)) return false;
    return this.families.has(familyId);
  }

  bind(familyId: string, sessionId: string): boolean {
    this.sweep();
    const family = this.families.get(familyId);
    if (!family || !isOpaqueIdentifier(sessionId)) return false;
    family.sessionId = sessionId;
    family.lastSeenAt = this.now();
    return true;
  }

  unbindSession(sessionId: string): void {
    for (const family of this.families.values()) {
      if (family.sessionId === sessionId) family.sessionId = null;
    }
  }

  remove(familyId: string | undefined): void {
    if (familyId) this.families.delete(familyId);
  }

  size(): number {
    this.sweep();
    return this.families.size;
  }

  sweep(): void {
    const timestamp = this.now();
    for (const [id, family] of this.families) {
      if (
        timestamp >= family.expiresAt ||
        timestamp - family.lastSeenAt > this.ttlMs
      ) {
        this.families.delete(id);
      }
    }
  }
}

export type ConsumeTransactionResult =
  | {
      readonly ok: true;
      readonly transaction: LinghaoPassportV4PendingTransaction;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "expired" | "state_mismatch";
    };

export interface LinghaoPassportV4PendingTransaction {
  readonly id: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
}

export class LinghaoPassportV4TransactionStore {
  private readonly transactions = new Map<
    string,
    LinghaoPassportV4PendingTransaction
  >();
  private readonly ttlMs: number;
  private readonly maxTransactions: number;
  private readonly now: () => number;
  private readonly randomBytes: LinghaoPassportV4SessionRandomBytes;

  constructor(options: {
    ttlMs: number;
    maxTransactions?: number;
    now?: () => number;
    randomBytes?: LinghaoPassportV4SessionRandomBytes;
  }) {
    this.ttlMs = options.ttlMs;
    this.maxTransactions =
      options.maxTransactions ?? LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    if (
      !Number.isSafeInteger(this.maxTransactions) ||
      this.maxTransactions < 1 ||
      this.maxTransactions > 1024
    ) {
      fail("transaction capacity is invalid");
    }
  }

  create(input: {
    state: string;
    nonce: string;
    codeVerifier: string;
  }): LinghaoPassportV4PendingTransaction | null {
    this.sweep();
    if (
      !isOpaqueIdentifier(input.state) ||
      !isOpaqueIdentifier(input.nonce) ||
      typeof input.codeVerifier !== "string" ||
      input.codeVerifier.length < 43 ||
      input.codeVerifier.length > 128
    ) {
      return null;
    }
    if (this.transactions.size >= this.maxTransactions) return null;
    const transaction: LinghaoPassportV4PendingTransaction = {
      id: drawOpaqueIdentifier(this.randomBytes),
      state: input.state,
      nonce: input.nonce,
      codeVerifier: input.codeVerifier,
      createdAt: this.now(),
    };
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  consume(
    transactionId: string | undefined,
    state: string | undefined,
  ): ConsumeTransactionResult {
    this.sweep();
    if (!isOpaqueIdentifier(transactionId)) {
      return { ok: false, reason: "missing" };
    }
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { ok: false, reason: "missing" };
    }
    // One-time consumption happens before any state comparison, expiry check,
    // token exchange, or JWKS fetch.
    this.transactions.delete(transactionId);
    if (this.now() - transaction.createdAt > this.ttlMs) {
      return { ok: false, reason: "expired" };
    }
    if (
      typeof state !== "string" ||
      !safeEqualString(transaction.state, state)
    ) {
      return { ok: false, reason: "state_mismatch" };
    }
    return { ok: true, transaction };
  }

  remove(transactionId: string | undefined): void {
    if (transactionId) this.transactions.delete(transactionId);
  }

  size(): number {
    this.sweep();
    return this.transactions.size;
  }

  sweep(): void {
    const timestamp = this.now();
    for (const [id, transaction] of this.transactions) {
      if (timestamp - transaction.createdAt > this.ttlMs) {
        this.transactions.delete(id);
      }
    }
  }
}

export interface LinghaoPassportV4LogoutResult {
  readonly cookieId: string;
  readonly state: string;
  readonly revocationConfirmed: boolean;
  readonly upstreamReturnExpected: boolean;
  readonly createdAt: number;
}

export class LinghaoPassportV4LogoutStateStore {
  private readonly results = new Map<string, LinghaoPassportV4LogoutResult>();
  private readonly ttlMs: number;
  private readonly maxResults: number;
  private readonly now: () => number;
  private readonly randomBytes: LinghaoPassportV4SessionRandomBytes;

  constructor(options: {
    ttlMs: number;
    maxResults?: number;
    now?: () => number;
    randomBytes?: LinghaoPassportV4SessionRandomBytes;
  }) {
    this.ttlMs = options.ttlMs;
    this.maxResults =
      options.maxResults ?? LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    if (
      !Number.isSafeInteger(this.maxResults) ||
      this.maxResults < 1 ||
      this.maxResults > 1024
    ) {
      fail("logout-result capacity is invalid");
    }
  }

  create(input: {
    revocationConfirmed: boolean;
    upstreamReturnExpected: boolean;
  }): LinghaoPassportV4LogoutResult | null {
    this.sweep();
    if (this.results.size >= this.maxResults) return null;
    const result: LinghaoPassportV4LogoutResult = {
      cookieId: drawOpaqueIdentifier(this.randomBytes),
      state: drawOpaqueIdentifier(this.randomBytes),
      revocationConfirmed: input.revocationConfirmed === true,
      upstreamReturnExpected: input.upstreamReturnExpected === true,
      createdAt: this.now(),
    };
    this.results.set(result.cookieId, result);
    return result;
  }

  consume(
    cookieId: string | undefined,
    state: string | undefined,
  ): LinghaoPassportV4LogoutResult | null {
    this.sweep();
    if (!isOpaqueIdentifier(cookieId)) return null;
    const result = this.results.get(cookieId);
    if (!result) return null;
    this.results.delete(cookieId);
    if (this.now() - result.createdAt > this.ttlMs) return null;
    if (typeof state !== "string") return null;
    return safeEqualString(result.state, state) ? result : null;
  }

  remove(cookieId: string | undefined): void {
    if (cookieId) this.results.delete(cookieId);
  }

  size(): number {
    this.sweep();
    return this.results.size;
  }

  sweep(): void {
    const timestamp = this.now();
    for (const [id, result] of this.results) {
      if (timestamp - result.createdAt > this.ttlMs) {
        this.results.delete(id);
      }
    }
  }
}

export class LinghaoPassportV4ProfileStore {
  private readonly profiles = new Map<
    string,
    {
      readonly profileId: string;
      readonly createdAt: number;
      lastSeenAt: number;
    }
  >();
  private readonly drafts = new Map<
    string,
    { text: string; lastSeenAt: number }
  >();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxProfiles: number;

  constructor(options?: {
    now?: () => number;
    ttlMs?: number;
    maxProfiles?: number;
  }) {
    this.now = options?.now ?? Date.now;
    this.ttlMs = options?.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxProfiles =
      options?.maxProfiles ?? LINGHAO_PASSPORT_V4_MAX_PROFILES;
    if (
      !Number.isSafeInteger(this.maxProfiles) ||
      this.maxProfiles < 1 ||
      this.maxProfiles > 2048
    ) {
      fail("profile capacity is invalid");
    }
  }

  getOrCreate(issuer: string, subject: string) {
    this.sweep();
    const profileId = deriveLinghaoPassportV4ProfileId(issuer, subject);
    const timestamp = this.now();
    const existing = this.profiles.get(profileId);
    if (existing) {
      existing.lastSeenAt = timestamp;
      return existing;
    }
    if (this.profiles.size >= this.maxProfiles) return null;
    const record = {
      profileId,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.profiles.set(profileId, record);
    return record;
  }

  get(profileId: string) {
    this.sweep();
    const record = this.profiles.get(profileId);
    if (record) record.lastSeenAt = this.now();
    return record ?? null;
  }

  getDraft(profileId: string): string | null {
    this.sweep();
    if (!this.profiles.has(profileId)) return null;
    return this.drafts.get(profileId)?.text ?? "";
  }

  setDraft(profileId: string, text: string): boolean {
    this.sweep();
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > LINGHAO_PASSPORT_V4_DRAFT_MAX_BYTES
    ) {
      return false;
    }
    if (!this.profiles.has(profileId)) return false;
    if (!this.drafts.has(profileId) && this.drafts.size >= this.maxProfiles) {
      return false;
    }
    this.drafts.set(profileId, { text, lastSeenAt: this.now() });
    return true;
  }

  size(): number {
    this.sweep();
    return this.profiles.size;
  }

  draftSize(): number {
    this.sweep();
    return this.drafts.size;
  }

  sweep(): void {
    const timestamp = this.now();
    for (const [id, profile] of this.profiles) {
      if (timestamp - profile.lastSeenAt > this.ttlMs) {
        this.profiles.delete(id);
        this.drafts.delete(id);
      }
    }
    for (const [id, draft] of this.drafts) {
      if (
        !this.profiles.has(id) ||
        timestamp - draft.lastSeenAt > this.ttlMs
      ) {
        this.drafts.delete(id);
      }
    }
  }
}

/**
 * A bounded local start-rate limiter. When the bucket table is saturated and no
 * expired bucket exists, the limiter fails closed instead of growing.
 */
export class LinghaoPassportV4StartRateLimiter {
  private readonly buckets = new Map<
    string,
    { windowStartedAt: number; count: number }
  >();
  private readonly windowMs: number;
  private readonly maximum: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;

  constructor(options: {
    windowMs: number;
    maximum: number;
    maxBuckets?: number;
    now?: () => number;
  }) {
    this.windowMs = options.windowMs;
    this.maximum = options.maximum;
    this.maxBuckets =
      options.maxBuckets ?? LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.windowMs) ||
      this.windowMs < 1 ||
      !Number.isSafeInteger(this.maximum) ||
      this.maximum < 1 ||
      !Number.isSafeInteger(this.maxBuckets) ||
      this.maxBuckets < 1 ||
      this.maxBuckets > 1024
    ) {
      fail("start-rate limiter configuration is invalid");
    }
  }

  take(key: string): boolean {
    this.sweep();
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      return false;
    }
    const timestamp = this.now();
    const existing = this.buckets.get(key);
    if (!existing) {
      if (this.buckets.size >= this.maxBuckets) return false;
      this.buckets.set(key, { windowStartedAt: timestamp, count: 1 });
      return true;
    }
    if (timestamp - existing.windowStartedAt >= this.windowMs) {
      existing.windowStartedAt = timestamp;
      existing.count = 1;
      return true;
    }
    if (existing.count >= this.maximum) return false;
    existing.count += 1;
    return true;
  }

  size(): number {
    this.sweep();
    return this.buckets.size;
  }

  sweep(): void {
    const timestamp = this.now();
    for (const [key, bucket] of this.buckets) {
      if (timestamp - bucket.windowStartedAt >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}

export function linghaoPassportV4SafeProfile(
  profileId: string,
): PassportSafeProfile {
  if (!UUID_PATTERN.test(profileId)) {
    fail("profile id is invalid");
  }
  return {
    localTestOnly: true,
    displayName: LINGHAO_PASSPORT_V4_DISPLAY_NAME,
    profileId,
    balance: null,
    ledger: [],
    capabilities: {
      administrator: false,
      phoneAccount: false,
      formalWallet: false,
      legacyWorks: false,
      cloudProgress: false,
      hostedByok: false,
    },
  };
}

export function linghaoPassportV4SafeSession(
  session: LinghaoPassportV4Session,
  idleMs: number,
): PassportSafeSession {
  return {
    authenticated: true,
    profile: linghaoPassportV4SafeProfile(session.profileId),
    session: {
      idleExpiresAt: session.lastSeenAt + idleMs,
      absoluteExpiresAt: session.absoluteExpiresAt,
    },
  };
}

export function parsePassportCookieHeader(
  header: string | undefined,
): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Invalid cookie encoding is ignored rather than reflected.
    }
  }
  return cookies;
}

export type SingleCookieResult =
  | { readonly present: false }
  | { readonly present: true; readonly value: string }
  | { readonly present: "duplicate" | "invalid" };

export function readSinglePassportCookie(
  cookieHeader: string | undefined,
  name: string,
): SingleCookieResult {
  if (!cookieHeader) return { present: false };
  let count = 0;
  let value: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const candidateName = part.slice(0, separator).trim();
    if (candidateName !== name) continue;
    count += 1;
    if (count > 1) return { present: "duplicate" };
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return { present: "invalid" };
    }
  }
  if (count === 0 || value === undefined) return { present: false };
  return { present: true, value };
}

export interface PassportCookieOptions {
  readonly path: string;
  readonly maxAgeSeconds: number;
}

export function serializePassportCookie(
  name: string,
  value: string,
  options: PassportCookieOptions,
): string {
  if (!isOpaqueIdentifier(value)) fail("cookie value is invalid");
  const maxAge = Math.max(
    0,
    Math.min(7 * 24 * 60 * 60, Math.floor(options.maxAgeSeconds)),
  );
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearPassportCookie(
  name: string,
  path: string,
): string {
  return [
    `${name}=`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export function isPassportOpaqueIdentifier(value: unknown): value is string {
  return isOpaqueIdentifier(value);
}

