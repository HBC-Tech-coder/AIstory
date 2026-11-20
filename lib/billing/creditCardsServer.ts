import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CREDIT_CARD_DATABASE_GATE_VERSION,
  CREDIT_CARD_RUNTIME_SCHEMA_VERSION,
  CREDIT_CARD_SCHEMA_VERSION,
  CREDIT_CARD_STATUS,
  formatCreditCardNumber,
  formatCreditCardPin,
  normalizeCreditCardNumber,
  normalizeCreditCardPin,
  type CreditCardBatchSummary,
  type CreditCardOneTimeCard,
  type CreditCardRedeemResponse,
} from "./creditCards";
import type { IndependentAdminPrincipalDatabaseSessionContext } from
  "@/lib/admin/independentPrincipalRepository";
import {
  INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV,
} from "@/lib/admin/independentPrincipalRepository";
import {
  inspectIndependentAdminPrincipalProductionGate,
} from "@/lib/admin/independentPrincipalServer";
import {
  assertProductionDatabaseGateReady,
  createProductionSupabaseServiceClient,
} from "@/lib/production/databaseGate";

export const CREDIT_CARD_MODE_ENV = "AISTORY_CREDIT_CARD_MODE";
export const CREDIT_CARD_CONFIG_FILE_ENV = "AISTORY_CREDIT_CARD_CONFIG_FILE";
export const CREDIT_CARD_DATABASE_GATE_ENV =
  "AISTORY_CREDIT_CARD_DATABASE_GATE_VERSION";
export const CREDIT_CARD_PUBLIC_ORIGIN_ENV =
  "AISTORY_CREDIT_CARD_PUBLIC_ORIGIN";
export const CREDIT_CARD_PRODUCTION_MODE = "production_v1";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^cck_[A-Za-z0-9_-]{8,64}$/;
const POLICY_VERSION_PATTERN = /^credit-card-policy-v1\.[A-Za-z0-9_-]{1,48}$/;
const BATCH_ID_PATTERN = /^ccb_[A-Za-z0-9_-]{24,96}$/;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_BATCH_COUNT_HARD = 100;
const MAX_BATCH_CREDITS_HARD = 10_000_000;
const MAX_DENOMINATION_HARD = 1_000_000;
const MAX_VALIDITY_DAYS_HARD = 365;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type ServerEnvironment = Record<string, string | undefined>;

export type CreditCardRuntimePolicy = Readonly<{
  schemaVersion: typeof CREDIT_CARD_RUNTIME_SCHEMA_VERSION;
  policyVersion: string;
  keyId: string;
  key: Buffer;
  keyBindingSha256: string;
  policyFingerprint: string;
  allowedDenominations: readonly number[];
  allowedValidityDays: readonly number[];
  maxBatchCount: number;
  maxBatchCredits: number;
}>;

export type CreditCardProductionGateStatus = Readonly<{
  ready: boolean;
  expectedVersion: typeof CREDIT_CARD_DATABASE_GATE_VERSION;
  missing: readonly (
    | "mode"
    | "config_reference"
    | "database_gate_version"
    | "public_origin"
    | "origin_binding"
    | "independent_admin_gate"
  )[];
}>;

export type CreditCardAdminAuthorization = Readonly<{
  binding: IndependentAdminPrincipalDatabaseSessionContext["binding"];
  sessionIdHash: string;
}>;

export type CreditCardStoredDigest = Readonly<{
  locatorHash: string;
  verifierHash: string;
}>;

export type CreditCardIssueStoreInput = Readonly<{
  authorization: CreditCardAdminAuthorization;
  batchId: string;
  denominationCredits: number;
  quantity: number;
  createdAt: string;
  expiresAt: string;
  policyVersion: string;
  policyFingerprint: string;
  keyId: string;
  keyBindingSha256: string;
  activationTokenHash: string;
  idempotencyKey: string;
  requestFingerprint: string;
  cards: readonly CreditCardStoredDigest[];
}>;

export type CreditCardRedeemStoreInput = Readonly<{
  userId: string;
  keyId: string;
  keyBindingSha256: string;
  locatorHash: string;
  verifierHash: string;
  idempotencyKey: string;
  requestFingerprint: string;
  occurredAt: string;
}>;

export type CreditCardStoreRedeemResult =
  | Readonly<{
    kind: "redeemed";
    creditedCredits: number;
    balanceAfter: number;
    redeemedAt: string;
    replayed: boolean;
  }>
  | Readonly<{
    kind: "unavailable";
  }>
  | Readonly<{
    kind: "rate_limited";
    retryAfterSeconds: number;
  }>;

export interface CreditCardRepository {
  assertGateReady(keyBindingSha256: string): Promise<void>;
  listBatches(
    authorization: CreditCardAdminAuthorization,
    occurredAt: string,
  ): Promise<readonly CreditCardBatchSummary[]>;
  issueBatch(input: CreditCardIssueStoreInput): Promise<Readonly<{
    batch: CreditCardBatchSummary;
    replayed: boolean;
  }>>;
  activateBatch(input: Readonly<{
    authorization: CreditCardAdminAuthorization;
    batchId: string;
    activationTokenHash: string;
    occurredAt: string;
  }>): Promise<CreditCardBatchSummary>;
  disableBatch(input: Readonly<{
    authorization: CreditCardAdminAuthorization;
    batchId: string;
    occurredAt: string;
  }>): Promise<CreditCardBatchSummary>;
  disableCard(input: Readonly<{
    authorization: CreditCardAdminAuthorization;
    keyId: string;
    locatorHash: string;
    occurredAt: string;
  }>): Promise<CreditCardBatchSummary>;
  redeem(input: CreditCardRedeemStoreInput): Promise<CreditCardStoreRedeemResult>;
}

export class CreditCardServerError extends Error {
  readonly code = "CREDIT_CARD_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super("Credit card service is unavailable.");
    this.name = "CreditCardServerError";
  }
}

export class CreditCardRequestError extends Error {
  readonly code: "CREDIT_CARD_INVALID_REQUEST" | "CREDIT_CARD_RATE_LIMITED";
  readonly status: 400 | 429;
  readonly retryAfterSeconds?: number;

  constructor(
    code: "CREDIT_CARD_INVALID_REQUEST" | "CREDIT_CARD_RATE_LIMITED",
    retryAfterSeconds?: number,
  ) {
    super("Credit card request was not accepted.");
    this.name = "CreditCardRequestError";
    this.code = code;
    this.status = code === "CREDIT_CARD_RATE_LIMITED" ? 429 : 400;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function fail(): never {
  throw new CreditCardServerError();
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length && keys.every((key) => {
    if (typeof key !== "string" || !expectedKeys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor
      && "value" in descriptor
      && descriptor.get === undefined
      && descriptor.set === undefined;
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(",")}}`;
}

function sha256(...values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value, "utf8");
  return hash.digest("hex");
}

function hmac(key: Buffer, domain: string, ...values: string[]): string {
  const value = createHmac("sha256", key);
  value.update(domain, "utf8");
  for (const part of values) {
    value.update("\0", "utf8");
    value.update(part, "utf8");
  }
  return value.digest("hex");
}

function positiveIntegerList(
  value: unknown,
  maximum: number,
): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    return undefined;
  }
  const numbers: number[] = [];
  for (const item of value) {
    if (!Number.isSafeInteger(item) || Number(item) < 1 || Number(item) > maximum) {
      return undefined;
    }
    numbers.push(Number(item));
  }
  if (new Set(numbers).size !== numbers.length) return undefined;
  const sorted = [...numbers].sort((left, right) => left - right);
  if (numbers.some((item, index) => item !== sorted[index])) return undefined;
  return Object.freeze(numbers);
}

export function parseCreditCardRuntimePolicy(
  value: unknown,
): CreditCardRuntimePolicy {
  if (!exactRecord(value, [
    "schemaVersion",
    "policyVersion",
    "keyId",
    "hmacKeyBase64url",
    "allowedDenominations",
    "allowedValidityDays",
    "maxBatchCount",
    "maxBatchCredits",
  ])) fail();
  const denominations = positiveIntegerList(
    value.allowedDenominations,
    MAX_DENOMINATION_HARD,
  );
  const validityDays = positiveIntegerList(
    value.allowedValidityDays,
    MAX_VALIDITY_DAYS_HARD,
  );
  if (
    value.schemaVersion !== CREDIT_CARD_RUNTIME_SCHEMA_VERSION
    || typeof value.policyVersion !== "string"
    || !POLICY_VERSION_PATTERN.test(value.policyVersion)
    || typeof value.keyId !== "string"
    || !KEY_ID_PATTERN.test(value.keyId)
    || typeof value.hmacKeyBase64url !== "string"
    || !/^[A-Za-z0-9_-]{43,128}$/.test(value.hmacKeyBase64url)
    || !denominations
    || !validityDays
    || !Number.isSafeInteger(value.maxBatchCount)
    || Number(value.maxBatchCount) < 1
    || Number(value.maxBatchCount) > MAX_BATCH_COUNT_HARD
    || !Number.isSafeInteger(value.maxBatchCredits)
    || Number(value.maxBatchCredits) < 1
    || Number(value.maxBatchCredits) > MAX_BATCH_CREDITS_HARD
    || denominations.some((item) => item > Number(value.maxBatchCredits))
  ) fail();
  let key: Buffer;
  try {
    key = Buffer.from(value.hmacKeyBase64url, "base64url");
  } catch {
    fail();
  }
  if (key.byteLength < 32 || key.byteLength > 96) fail();
  if (key.toString("base64url") !== value.hmacKeyBase64url) fail();
  const publicPolicy = {
    schemaVersion: value.schemaVersion,
    policyVersion: value.policyVersion,
    keyId: value.keyId,
    allowedDenominations: denominations,
    allowedValidityDays: validityDays,
    maxBatchCount: Number(value.maxBatchCount),
    maxBatchCredits: Number(value.maxBatchCredits),
  };
  return Object.freeze({
    ...publicPolicy,
    key,
    keyBindingSha256: sha256(
      "aistory:credit-card:key-binding:v1\n",
      value.keyId,
      "\n",
      value.hmacKeyBase64url,
    ),
    policyFingerprint: sha256(
      "aistory:credit-card:policy:v1\n",
      stableJson(publicPolicy),
    ),
  });
}

function parseHttpsOrigin(value: string | undefined): string | undefined {
  if (!value || value !== value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function inspectCreditCardProductionGate(
  env: ServerEnvironment = process.env,
): CreditCardProductionGateStatus {
  const missing: CreditCardProductionGateStatus["missing"][number][] = [];
  if (env[CREDIT_CARD_MODE_ENV] !== CREDIT_CARD_PRODUCTION_MODE) {
    missing.push("mode");
  }
  if (!env[CREDIT_CARD_CONFIG_FILE_ENV]?.trim()) {
    missing.push("config_reference");
  }
  if (
    env[CREDIT_CARD_DATABASE_GATE_ENV]
      !== CREDIT_CARD_DATABASE_GATE_VERSION
  ) missing.push("database_gate_version");
  const publicOrigin = parseHttpsOrigin(env[CREDIT_CARD_PUBLIC_ORIGIN_ENV]);
  if (!publicOrigin) {
    missing.push("public_origin");
  }
  const adminOrigin = parseHttpsOrigin(
    env[INDEPENDENT_ADMIN_PRINCIPAL_ORIGIN_ENV],
  );
  if (publicOrigin && publicOrigin !== adminOrigin) {
    missing.push("origin_binding");
  }
  if (!inspectIndependentAdminPrincipalProductionGate(env).ready) {
    missing.push("independent_admin_gate");
  }
  return Object.freeze({
    ready: missing.length === 0,
    expectedVersion: CREDIT_CARD_DATABASE_GATE_VERSION,
    missing: Object.freeze(missing),
  });
}

export function isCreditCardSameOriginRequest(
  request: Request,
  expectedOrigin: string,
): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const expected = new URL(expectedOrigin);
    const supplied = new URL(origin);
    const requestUrl = new URL(request.url);
    return expected.protocol === "https:"
      && !expected.username
      && !expected.password
      && expected.pathname === "/"
      && !expected.search
      && !expected.hash
      && !supplied.username
      && !supplied.password
      && supplied.pathname === "/"
      && !supplied.search
      && !supplied.hash
      && supplied.origin === expected.origin
      && requestUrl.origin === expected.origin
      && host.trim().toLowerCase() === expected.host.toLowerCase();
  } catch {
    return false;
  }
}

export async function readCreditCardJsonBody(
  request: Request,
  maximumBytes = 8192,
): Promise<unknown | undefined> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(
    request.headers.get("content-type")?.trim() ?? "",
  )) return undefined;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    return undefined;
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let actualBytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      actualBytes += result.value.byteLength;
      if (actualBytes > maximumBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
    if (declared !== null && Number(declared) !== actualBytes) return undefined;
    const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      .toString("utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function loadCreditCardRuntimePolicy(options: Readonly<{
  env?: ServerEnvironment;
  workspaceRoot?: string;
  readFileImpl?: typeof readFile;
  lstatImpl?: typeof lstat;
  statImpl?: typeof stat;
}> = {}): Promise<CreditCardRuntimePolicy> {
  const env = options.env ?? process.env;
  if (!inspectCreditCardProductionGate(env).ready) fail();
  const reference = env[CREDIT_CARD_CONFIG_FILE_ENV]?.trim();
  if (!reference || !path.isAbsolute(reference)) fail();
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const resolved = path.resolve(reference);
  const relative = path.relative(workspaceRoot, resolved);
  const isOutsideWorkspace = relative === ".."
    || relative.startsWith(`..${path.sep}`);
  if (!isOutsideWorkspace || path.isAbsolute(relative)) fail();
  const read = options.readFileImpl ?? readFile;
  const readLstat = options.lstatImpl ?? lstat;
  const readStat = options.statImpl ?? stat;
  try {
    const [linkInfo, fileInfo] = await Promise.all([
      readLstat(resolved),
      readStat(resolved),
    ]);
    if (
      linkInfo.isSymbolicLink()
      || !linkInfo.isFile()
      || !fileInfo.isFile()
      || fileInfo.nlink !== 1
      || fileInfo.size < 128
      || fileInfo.size > MAX_CONFIG_BYTES
      || (process.platform !== "win32" && (
        fileInfo.uid !== 0 || (fileInfo.mode & 0o077) !== 0
      ))
    ) fail();
    const raw = await read(resolved, "utf8");
    if (Buffer.byteLength(raw, "utf8") !== fileInfo.size) fail();
    return parseCreditCardRuntimePolicy(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof CreditCardServerError) throw error;
    fail();
  }
}

function encodeCrockford128(bytes: Buffer): string {
  if (bytes.byteLength !== 16) fail();
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let output = "";
  for (let index = 0; index < 26; index += 1) {
    output = CROCKFORD_ALPHABET[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}

function randomToken(random: (size: number) => Buffer, prefix = ""): string {
  const bytes = random(16);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 16) fail();
  return `${prefix}${encodeCrockford128(bytes)}`;
}

function cardDigests(
  policy: CreditCardRuntimePolicy,
  cardNumber: string,
  pin: string,
): CreditCardStoredDigest {
  const normalizedCard = normalizeCreditCardNumber(cardNumber);
  const normalizedPin = normalizeCreditCardPin(pin);
  if (!normalizedCard || !normalizedPin) fail();
  return Object.freeze({
    locatorHash: hmac(
      policy.key,
      "aistory:credit-card:v1:locator",
      normalizedCard,
    ),
    verifierHash: hmac(
      policy.key,
      "aistory:credit-card:v1:verifier",
      normalizedCard,
      normalizedPin,
    ),
  });
}

function activationDigest(
  policy: CreditCardRuntimePolicy,
  batchId: string,
  activationToken: string,
): string {
  const normalized = normalizeCreditCardPin(activationToken);
  if (!normalized || !BATCH_ID_PATTERN.test(batchId)) fail();
  return hmac(
    policy.key,
    "aistory:credit-card:v1:activation",
    batchId,
    normalized,
  );
}

function isoTime(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) fail();
  try {
    return new Date(value).toISOString();
  } catch {
    fail();
  }
}

function assertIssuePolicy(
  policy: CreditCardRuntimePolicy,
  denominationCredits: number,
  quantity: number,
  validityDays: number,
): void {
  if (
    !policy.allowedDenominations.includes(denominationCredits)
    || !policy.allowedValidityDays.includes(validityDays)
    || !Number.isSafeInteger(quantity)
    || quantity < 1
    || quantity > policy.maxBatchCount
    || denominationCredits * quantity > policy.maxBatchCredits
  ) throw new CreditCardRequestError("CREDIT_CARD_INVALID_REQUEST");
}

export async function issueCreditCardBatch(input: Readonly<{
  repository: CreditCardRepository;
  authorization: CreditCardAdminAuthorization;
  policy: CreditCardRuntimePolicy;
  denominationCredits: number;
  quantity: number;
  validityDays: number;
  idempotencyKey: string;
  now?: number;
  random?: (size: number) => Buffer;
}>): Promise<Readonly<{
  batch: CreditCardBatchSummary;
  oneTimeDelivery?: Readonly<{
    batchId: string;
    activationToken: string;
    cards: readonly CreditCardOneTimeCard[];
  }>;
  deliveryAvailable: boolean;
}>> {
  assertIssuePolicy(
    input.policy,
    input.denominationCredits,
    input.quantity,
    input.validityDays,
  );
  const now = input.now ?? Date.now();
  const random = input.random ?? randomBytes;
  const batchId = `ccb_${random(18).toString("base64url")}`;
  if (!BATCH_ID_PATTERN.test(batchId)) fail();
  const activationToken = randomToken(random);
  const cards: CreditCardOneTimeCard[] = [];
  const digests: CreditCardStoredDigest[] = [];
  const locatorSet = new Set<string>();
  for (let index = 0; index < input.quantity; index += 1) {
    const cardNumber = formatCreditCardNumber(randomToken(random, "AC1"));
    const pin = formatCreditCardPin(randomToken(random));
    const digest = cardDigests(input.policy, cardNumber, pin);
    if (locatorSet.has(digest.locatorHash)) fail();
    locatorSet.add(digest.locatorHash);
    cards.push(Object.freeze({ cardNumber, pin }));
    digests.push(digest);
  }
  const createdAt = isoTime(now);
  const expiresAt = isoTime(
    now + input.validityDays * 24 * 60 * 60 * 1000,
  );
  const requestFingerprint = sha256(
    "aistory:credit-card:issue-request:v1\n",
    stableJson({
      principalRef: input.authorization.binding.principalId,
      denominationCredits: input.denominationCredits,
      quantity: input.quantity,
      validityDays: input.validityDays,
      idempotencyKey: input.idempotencyKey,
      policyFingerprint: input.policy.policyFingerprint,
    }),
  );
  const result = await input.repository.issueBatch({
    authorization: input.authorization,
    batchId,
    denominationCredits: input.denominationCredits,
    quantity: input.quantity,
    createdAt,
    expiresAt,
    policyVersion: input.policy.policyVersion,
    policyFingerprint: input.policy.policyFingerprint,
    keyId: input.policy.keyId,
    keyBindingSha256: input.policy.keyBindingSha256,
    activationTokenHash: activationDigest(
      input.policy,
      batchId,
      activationToken,
    ),
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    cards: Object.freeze(digests),
  });
  if (result.replayed) {
    return Object.freeze({
      batch: result.batch,
      deliveryAvailable: false,
    });
  }
  return Object.freeze({
    batch: result.batch,
    oneTimeDelivery: Object.freeze({
      batchId,
      activationToken: formatCreditCardPin(activationToken),
      cards: Object.freeze(cards),
    }),
    deliveryAvailable: true,
  });
}

export async function activateCreditCardBatch(input: Readonly<{
  repository: CreditCardRepository;
  authorization: CreditCardAdminAuthorization;
  policy: CreditCardRuntimePolicy;
  batchId: string;
  activationToken: string;
  now?: number;
}>): Promise<CreditCardBatchSummary> {
  return input.repository.activateBatch({
    authorization: input.authorization,
    batchId: input.batchId,
    activationTokenHash: activationDigest(
      input.policy,
      input.batchId,
      input.activationToken,
    ),
    occurredAt: isoTime(input.now ?? Date.now()),
  });
}

export async function disableCreditCardBatch(input: Readonly<{
  repository: CreditCardRepository;
  authorization: CreditCardAdminAuthorization;
  batchId: string;
  now?: number;
}>): Promise<CreditCardBatchSummary> {
  if (!BATCH_ID_PATTERN.test(input.batchId)) {
    throw new CreditCardRequestError("CREDIT_CARD_INVALID_REQUEST");
  }
  return input.repository.disableBatch({
    authorization: input.authorization,
    batchId: input.batchId,
    occurredAt: isoTime(input.now ?? Date.now()),
  });
}

export async function disableCreditCard(input: Readonly<{
  repository: CreditCardRepository;
  authorization: CreditCardAdminAuthorization;
  policy: CreditCardRuntimePolicy;
  cardNumber: string;
  now?: number;
}>): Promise<CreditCardBatchSummary> {
  const normalized = normalizeCreditCardNumber(input.cardNumber);
  if (!normalized) {
    throw new CreditCardRequestError("CREDIT_CARD_INVALID_REQUEST");
  }
  return input.repository.disableCard({
    authorization: input.authorization,
    keyId: input.policy.keyId,
    locatorHash: hmac(
      input.policy.key,
      "aistory:credit-card:v1:locator",
      normalized,
    ),
    occurredAt: isoTime(input.now ?? Date.now()),
  });
}

export async function redeemCreditCard(input: Readonly<{
  repository: CreditCardRepository;
  policy: CreditCardRuntimePolicy;
  userId: string;
  cardNumber: string;
  pin: string;
  idempotencyKey: string;
  now?: number;
}>): Promise<CreditCardRedeemResponse> {
  const cardNumber = normalizeCreditCardNumber(input.cardNumber);
  const pin = normalizeCreditCardPin(input.pin);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.userId)
    || !cardNumber
    || !pin
  ) throw new CreditCardRequestError("CREDIT_CARD_INVALID_REQUEST");
  const digest = cardDigests(input.policy, cardNumber, pin);
  const occurredAt = isoTime(input.now ?? Date.now());
  const result = await input.repository.redeem({
    userId: input.userId,
    keyId: input.policy.keyId,
    keyBindingSha256: input.policy.keyBindingSha256,
    ...digest,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: sha256(
      "aistory:credit-card:redeem-request:v1\n",
      stableJson({
        userId: input.userId,
        locatorHash: digest.locatorHash,
        verifierHash: digest.verifierHash,
        idempotencyKey: input.idempotencyKey,
        policyFingerprint: input.policy.policyFingerprint,
      }),
    ),
    occurredAt,
  });
  if (result.kind === "rate_limited") {
    throw new CreditCardRequestError(
      "CREDIT_CARD_RATE_LIMITED",
      result.retryAfterSeconds,
    );
  }
  if (result.kind === "unavailable") {
    throw new CreditCardRequestError("CREDIT_CARD_INVALID_REQUEST");
  }
  return Object.freeze({
    schemaVersion: CREDIT_CARD_SCHEMA_VERSION,
    ok: true,
    creditedCredits: result.creditedCredits,
    balanceAfter: result.balanceAfter,
    redeemedAt: result.redeemedAt,
    replayed: result.replayed,
  });
}

type RpcResult = Readonly<{
  data: unknown;
  error: Readonly<{ message?: string }> | null;
}>;

export interface CreditCardRpcClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

function bindingPayload(
  binding: IndependentAdminPrincipalDatabaseSessionContext["binding"],
): Record<string, unknown> {
  return {
    principal_ref: binding.principalId,
    credential_binding_sha256: binding.credentialBindingSha256,
    credential_epoch_sha256: binding.credentialEpochSha256,
    password_verifier_reference_sha256:
      binding.passwordVerifierReferenceSha256,
    password_algorithm: binding.passwordAlgorithm,
    password_parameters: binding.passwordParameters,
  };
}

function authorizationPayload(
  authorization: CreditCardAdminAuthorization,
): Record<string, unknown> {
  if (!HASH_PATTERN.test(authorization.sessionIdHash)) fail();
  return {
    ...bindingPayload(authorization.binding),
    session_hash: authorization.sessionIdHash,
    tenant_id: "platform",
  };
}

function parseBatchSummary(value: unknown): CreditCardBatchSummary {
  if (!exactRecord(value, [
    "batch_id",
    "denomination_credits",
    "quantity",
    "redeemed_count",
    "remaining_count",
    "disabled_count",
    "expired_count",
    "state",
    "created_at",
    "expires_at",
    "activated_at",
    "disabled_at",
  ])) fail();
  if (
    typeof value.batch_id !== "string"
    || !BATCH_ID_PATTERN.test(value.batch_id)
    || !Number.isSafeInteger(value.denomination_credits)
    || Number(value.denomination_credits) < 1
    || !Number.isSafeInteger(value.quantity)
    || Number(value.quantity) < 1
    || !Number.isSafeInteger(value.redeemed_count)
    || !Number.isSafeInteger(value.remaining_count)
    || !Number.isSafeInteger(value.disabled_count)
    || !Number.isSafeInteger(value.expired_count)
    || !["pending_activation", "active", "disabled"].includes(
      String(value.state),
    )
    || typeof value.created_at !== "string"
    || typeof value.expires_at !== "string"
    || (value.activated_at !== null && typeof value.activated_at !== "string")
    || (value.disabled_at !== null && typeof value.disabled_at !== "string")
  ) fail();
  const redeemedCount = Number(value.redeemed_count);
  const remainingCount = Number(value.remaining_count);
  const disabledCount = Number(value.disabled_count);
  const expiredCount = Number(value.expired_count);
  const counts = [redeemedCount, remainingCount, disabledCount, expiredCount];
  if (counts.some((item) => item < 0 || item > Number(value.quantity))) fail();
  return Object.freeze({
    batchId: value.batch_id,
    denominationCredits: Number(value.denomination_credits),
    quantity: Number(value.quantity),
    redeemedCount,
    remainingCount,
    disabledCount,
    expiredCount,
    state: value.state as CreditCardBatchSummary["state"],
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    ...(value.activated_at ? { activatedAt: value.activated_at } : {}),
    ...(value.disabled_at ? { disabledAt: value.disabled_at } : {}),
  });
}

function storeInputPayload(input: CreditCardIssueStoreInput) {
  return {
    authorization: authorizationPayload(input.authorization),
    batch_id: input.batchId,
    denomination_credits: input.denominationCredits,
    quantity: input.quantity,
    created_at: input.createdAt,
    expires_at: input.expiresAt,
    policy_version: input.policyVersion,
    policy_fingerprint: input.policyFingerprint,
    key_id: input.keyId,
    key_binding_sha256: input.keyBindingSha256,
    activation_token_hash: input.activationTokenHash,
    idempotency_key: input.idempotencyKey,
    request_fingerprint: input.requestFingerprint,
    cards: input.cards.map((item) => ({
      locator_hash: item.locatorHash,
      verifier_hash: item.verifierHash,
    })),
  };
}

export class SupabaseCreditCardRepository implements CreditCardRepository {
  constructor(private readonly client: CreditCardRpcClient) {}

  async assertGateReady(keyBindingSha256: string): Promise<void> {
    if (!HASH_PATTERN.test(keyBindingSha256)) fail();
    const [gate, posture, keyBinding] = await Promise.all([
      this.client.rpc("aistory_credit_card_gate_status"),
      this.client.rpc("aistory_credit_card_security_posture"),
      this.client.rpc("aistory_credit_card_key_binding_status", {
        supplied_key_binding_sha256: keyBindingSha256,
      }),
    ]);
    if (
      gate.error
      || gate.data !== CREDIT_CARD_DATABASE_GATE_VERSION
      || posture.error
      || posture.data !== true
      || keyBinding.error
      || keyBinding.data !== true
    ) fail();
  }

  async listBatches(
    authorization: CreditCardAdminAuthorization,
    occurredAt: string,
  ): Promise<readonly CreditCardBatchSummary[]> {
    const result = await this.client.rpc("aistory_credit_card_admin_read", {
      request: {
        authorization: authorizationPayload(authorization),
        occurred_at: occurredAt,
      },
    });
    if (result.error || !Array.isArray(result.data)) fail();
    return Object.freeze(result.data.map(parseBatchSummary));
  }

  async issueBatch(input: CreditCardIssueStoreInput): Promise<Readonly<{
    batch: CreditCardBatchSummary;
    replayed: boolean;
  }>> {
    const result = await this.client.rpc("aistory_credit_card_admin_create_batch", {
      request: storeInputPayload(input),
    });
    if (
      result.error
      || !exactRecord(result.data, ["batch", "replayed"])
      || typeof result.data.replayed !== "boolean"
    ) fail();
    return Object.freeze({
      batch: parseBatchSummary(result.data.batch),
      replayed: result.data.replayed,
    });
  }

  async activateBatch(input: Readonly<{
    authorization: CreditCardAdminAuthorization;
    batchId: string;
    activationTokenHash: string;
    occurredAt: string;
  }>): Promise<CreditCardBatchSummary> {
    return this.mutate("activate", {
      authorization: authorizationPayload(input.authorization),
      batch_id: input.batchId,
      activation_token_hash: input.activationTokenHash,
      occurred_at: input.occurredAt,
    });
  }

  async disableBatch(input: Readonly<{
    authorization: CreditCardAdminAuthorization;
    batchId: string;
    occurredAt: string;
  }>): Promise<CreditCardBatchSummary> {
    return this.mutate("disable_batch", {
      authorization: authorizationPayload(input.authorization),
      batch_id: input.batchId,
      occurred_at: input.occurredAt,
    });
  }

  async disableCard(input: Readonly<{
    authorization: CreditCardAdminAuthorization;
    keyId: string;
    locatorHash: string;
    occurredAt: string;
  }>): Promise<CreditCardBatchSummary> {
    return this.mutate("disable_card", {
      authorization: authorizationPayload(input.authorization),
      key_id: input.keyId,
      locator_hash: input.locatorHash,
      occurred_at: input.occurredAt,
    });
  }

  private async mutate(
    action: "activate" | "disable_batch" | "disable_card",
    payload: Record<string, unknown>,
  ): Promise<CreditCardBatchSummary> {
    const result = await this.client.rpc("aistory_credit_card_admin_mutate", {
      request: { action, ...payload },
    });
    if (result.error) fail();
    return parseBatchSummary(result.data);
  }

  async redeem(input: CreditCardRedeemStoreInput): Promise<CreditCardStoreRedeemResult> {
    const result = await this.client.rpc("aistory_credit_card_redeem", {
      request: {
        user_id: input.userId,
        key_id: input.keyId,
        key_binding_sha256: input.keyBindingSha256,
        locator_hash: input.locatorHash,
        verifier_hash: input.verifierHash,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        occurred_at: input.occurredAt,
      },
    });
    if (result.error || !result.data || typeof result.data !== "object") fail();
    const status = (result.data as Record<string, unknown>).status;
    if (status === "unavailable") return Object.freeze({ kind: "unavailable" });
    if (status === "rate_limited") {
      const retry = (result.data as Record<string, unknown>).retry_after_seconds;
      if (!Number.isSafeInteger(retry) || Number(retry) < 1 || Number(retry) > 900) {
        fail();
      }
      return Object.freeze({
        kind: "rate_limited",
        retryAfterSeconds: Number(retry),
      });
    }
    if (!exactRecord(result.data, [
      "status",
      "credited_credits",
      "balance_after",
      "redeemed_at",
      "replayed",
    ])
      || status !== "redeemed"
      || !Number.isSafeInteger(result.data.credited_credits)
      || Number(result.data.credited_credits) < 1
      || !Number.isSafeInteger(result.data.balance_after)
      || typeof result.data.redeemed_at !== "string"
      || typeof result.data.replayed !== "boolean"
    ) fail();
    return Object.freeze({
      kind: "redeemed",
      creditedCredits: Number(result.data.credited_credits),
      balanceAfter: Number(result.data.balance_after),
      redeemedAt: result.data.redeemed_at,
      replayed: result.data.replayed,
    });
  }
}

export type CreditCardProductionRuntime = Readonly<{
  policy: CreditCardRuntimePolicy;
  repository: CreditCardRepository;
  publicOrigin: string;
}>;

export async function createCreditCardProductionRuntime(options: Readonly<{
  env?: ServerEnvironment;
  workspaceRoot?: string;
  client?: SupabaseClient & CreditCardRpcClient;
  policy?: CreditCardRuntimePolicy;
}> = {}): Promise<CreditCardProductionRuntime> {
  const env = options.env ?? process.env;
  if (!inspectCreditCardProductionGate(env).ready) fail();
  const publicOrigin = parseHttpsOrigin(env[CREDIT_CARD_PUBLIC_ORIGIN_ENV]);
  if (!publicOrigin) fail();
  const policy = options.policy ?? await loadCreditCardRuntimePolicy({
    env,
    workspaceRoot: options.workspaceRoot,
  });
  const client = options.client ?? (
    createProductionSupabaseServiceClient(env) as (
      SupabaseClient & CreditCardRpcClient
    )
  );
  await assertProductionDatabaseGateReady("identity", client, env);
  const repository = new SupabaseCreditCardRepository(client);
  await repository.assertGateReady(policy.keyBindingSha256);
  return Object.freeze({ policy, repository, publicOrigin });
}

export function projectCreditCardAdminSnapshot(
  policy: CreditCardRuntimePolicy,
  batches: readonly CreditCardBatchSummary[],
) {
  return Object.freeze({
    schemaVersion: CREDIT_CARD_SCHEMA_VERSION,
    status: CREDIT_CARD_STATUS.ready,
    policyVersion: policy.policyVersion,
    allowedDenominations: policy.allowedDenominations,
    allowedValidityDays: policy.allowedValidityDays,
    maxBatchCount: policy.maxBatchCount,
    maxBatchCredits: policy.maxBatchCredits,
    batches: Object.freeze([...batches]),
  });
}
