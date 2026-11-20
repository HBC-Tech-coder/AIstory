/**
 * AIstory explicit account-link policy helper.
 *
 * Pure, side-effect-free decision logic for linking an AIUser (ordinary AIUser
 * session) to a phone account. This module only *decides*; it never persists,
 * never claims concurrency safety, and never mutates its input. Operational
 * callers must recheck the granted decision inside their atomic repository
 * transaction.
 *
 * Data-adapter contract:
 * - Every object read (root and all nested) must be a plain data object: own
 *   `Object.prototype` (identity), no array, no symbol keys, and every own
 *   property must be an enumerable data property (accessors rejected).
 * - Values are read from property descriptors, never through property access,
 *   so user getters are never executed and arbitrary input is never
 *   serialized.
 * - Any thrown descriptor/prototype error (e.g. revoked proxies) collapses
 *   into the fixed DENIED decision; failures never contain user-controlled
 *   strings.
 * - Proxies are outside this contract in the sense that we do not defend
 *   against adversarial proxy *traps* (time-of-check/time-of-use), but every
 *   trap that throws is still caught and becomes DENIED.
 */

// ---------------------------------------------------------------------------
// Exported types (documentation of the wire contract; stripped at runtime)
// ---------------------------------------------------------------------------

/** Exactly `{ confirmLink: true }` as parsed by `parseAiUserAccountLinkConfirmation`. */
export interface AiUserAccountLinkConfirmation {
  confirmLink: true;
}

/** Active, unexpired AIUser (ordinary AIUser session) proof. */
export interface AiUserProof {
  /** Lowercase hex64: 64 lowercase hexadecimal characters (SHA-256). */
  principalKey: string;
  /** Lowercase hex64 session binding, must match the intent binding. */
  sessionBinding: string;
  /** Issuance instant, nonnegative safe integer milliseconds. */
  authenticatedAt: number;
  /** Expiry instant, nonnegative safe integer milliseconds. */
  expiresAt: number;
  /** Positive safe integer membership generation. */
  membershipGeneration: number;
}

/** Active, unexpired phone proof. */
export interface PhoneProof {
  /** Lowercase canonical RFC 4122 UUID, version 1..8, variant 8..b. */
  userId: string;
  /** Lowercase hex64 session binding, must match the intent binding. */
  sessionBinding: string;
  /** Issuance instant, nonnegative safe integer milliseconds. */
  authenticatedAt: number;
  /** Expiry instant, nonnegative safe integer milliseconds. */
  expiresAt: number;
  /** Proof must be explicitly active. */
  active: true;
}

/** The link intent: what the client asked to link, with proof bindings. */
export interface LinkIntent {
  /** Lowercase hex64 intent id (returned on success as `intentId`). */
  id: string;
  principalKey: string;
  phoneUserId: string;
  aiuserSessionBinding: string;
  phoneSessionBinding: string;
  createdAt: number;
  expiresAt: number;
  /** Intent must not be consumed. */
  consumed: false;
}

/** Existing mapping history entry (server-side index). */
export interface ExistingMapping {
  principalKey: string;
  phoneUserId: string;
}

/** The exact accepted input shape of `decideAiUserAccountLink`. */
export interface AiUserAccountLinkInput {
  schema: 'aistory.aiuser-account-link-proof.v1';
  confirmation: AiUserAccountLinkConfirmation;
  aiuser: AiUserProof;
  phone: PhoneProof;
  intent: LinkIntent;
  existingByAiuser: ExistingMapping | null;
  existingByPhone: ExistingMapping | null;
}

export type AccountLinkStatus = 'link_allowed' | 'already_linked';

/** Fixed, fully redacted failure decision. */
export type AccountLinkRejected = {
  ok: false;
  code: 'ACCOUNT_LINK_REJECTED';
};

/**
 * Granted decision. Contains server-private identifiers only; must never be
 * exposed as a browser DTO. No account fields (id, balances, saves, ownership,
 * roles) are changed; `assetsMerged`, `creditsGranted` and
 * `administratorGranted` are always false.
 */
export type AccountLinkGranted = {
  ok: true;
  status: AccountLinkStatus;
  principalKey: string;
  phoneUserId: string;
  intentId: string;
  assetsMerged: false;
  creditsGranted: false;
  administratorGranted: false;
};

export type LinkDecision = AccountLinkRejected | AccountLinkGranted;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA = 'aistory.aiuser-account-link-proof.v1';

/** Both proofs must be at most this old (ms). */
const PROOF_MAX_AGE_MS = 300_000;
/** AIUser proof maximum lifetime (ms). */
const AIUSER_LIFETIME_MAX_MS = 900_000;
/** Phone proof maximum lifetime (ms). */
const PHONE_LIFETIME_MAX_MS = 604_800_000;
/** Intent maximum TTL (ms). */
const INTENT_TTL_MAX_MS = 60_000;

/** Lowercase hex64: exactly 64 lowercase hex digits. */
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Lowercase canonical RFC 4122 UUID, version 1..8, variant 8..b. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Low-level data-adapter primitives (never execute user getters)
// ---------------------------------------------------------------------------

/**
 * True only for a plain data object: non-null object, not an array, own
 * prototype is exactly `Object.prototype` (identity), no symbol keys, and
 * every own property is an enumerable data property (accessors and
 * non-enumerable fields rejected). Descriptor/prototype errors become false.
 */
function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
  } catch {
    return false; // e.g. revoked proxy: IsArray throws
  }
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  if (proto !== Object.prototype) return false;
  let names: string[];
  let symbols: symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return false;
  }
  if (symbols.length !== 0) return false;
  for (const name of names) {
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      return false;
    }
    if (desc === undefined) return false;
    if (!('value' in desc)) return false; // accessor descriptor
    if (desc.enumerable !== true) return false;
  }
  return true;
}

/**
 * A plain data object whose own string keys are exactly `expectedKeys`
 * (order-insensitive). Returns the record or null. Extra, missing, symbol,
 * accessor or non-enumerable fields all fail.
 */
function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainDataObject(value)) return null;
  let names: string[];
  try {
    names = Object.getOwnPropertyNames(value);
  } catch {
    return null;
  }
  const sorted = [...names].sort();
  const expected = [...expectedKeys].sort();
  if (sorted.length !== expected.length) return null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== expected[i]) return null;
  }
  return value;
}

/**
 * Reads an own property value from a record already validated by
 * `strictRecord`, via the property descriptor so user getters are never
 * executed. Returns undefined on any descriptor error.
 */
function readDataProp(record: Record<string, unknown>, key: string): unknown {
  try {
    const desc = Object.getOwnPropertyDescriptor(record, key);
    if (desc === undefined) return undefined;
    if (!('value' in desc)) return undefined;
    return desc.value;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Value validators
// ---------------------------------------------------------------------------

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_RE.test(value);
}

function isLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isNonnegSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

// ---------------------------------------------------------------------------
// Nested parsers
// ---------------------------------------------------------------------------

interface ParsedAiuserProof {
  principalKey: string;
  sessionBinding: string;
  authenticatedAt: number;
  expiresAt: number;
  membershipGeneration: number;
}

function parseAiuserProof(value: unknown): ParsedAiuserProof | null {
  const record = strictRecord(value, [
    'principalKey',
    'sessionBinding',
    'authenticatedAt',
    'expiresAt',
    'membershipGeneration',
  ]);
  if (record === null) return null;
  const principalKey = readDataProp(record, 'principalKey');
  const sessionBinding = readDataProp(record, 'sessionBinding');
  const authenticatedAt = readDataProp(record, 'authenticatedAt');
  const expiresAt = readDataProp(record, 'expiresAt');
  const membershipGeneration = readDataProp(record, 'membershipGeneration');
  if (!isHex64(principalKey)) return null;
  if (!isHex64(sessionBinding)) return null;
  if (!isNonnegSafeInteger(authenticatedAt)) return null;
  if (!isNonnegSafeInteger(expiresAt)) return null;
  if (!isPositiveSafeInteger(membershipGeneration)) return null;
  return {
    principalKey,
    sessionBinding,
    authenticatedAt,
    expiresAt,
    membershipGeneration,
  };
}

interface ParsedPhoneProof {
  userId: string;
  sessionBinding: string;
  authenticatedAt: number;
  expiresAt: number;
  active: true;
}

function parsePhoneProof(value: unknown): ParsedPhoneProof | null {
  const record = strictRecord(value, [
    'userId',
    'sessionBinding',
    'authenticatedAt',
    'expiresAt',
    'active',
  ]);
  if (record === null) return null;
  const userId = readDataProp(record, 'userId');
  const sessionBinding = readDataProp(record, 'sessionBinding');
  const authenticatedAt = readDataProp(record, 'authenticatedAt');
  const expiresAt = readDataProp(record, 'expiresAt');
  const active = readDataProp(record, 'active');
  if (!isLowercaseUuid(userId)) return null;
  if (!isHex64(sessionBinding)) return null;
  if (!isNonnegSafeInteger(authenticatedAt)) return null;
  if (!isNonnegSafeInteger(expiresAt)) return null;
  if (active !== true) return null;
  return { userId, sessionBinding, authenticatedAt, expiresAt, active: true };
}

interface ParsedLinkIntent {
  id: string;
  principalKey: string;
  phoneUserId: string;
  aiuserSessionBinding: string;
  phoneSessionBinding: string;
  createdAt: number;
  expiresAt: number;
  consumed: false;
}

function parseIntent(value: unknown): ParsedLinkIntent | null {
  const record = strictRecord(value, [
    'id',
    'principalKey',
    'phoneUserId',
    'aiuserSessionBinding',
    'phoneSessionBinding',
    'createdAt',
    'expiresAt',
    'consumed',
  ]);
  if (record === null) return null;
  const id = readDataProp(record, 'id');
  const principalKey = readDataProp(record, 'principalKey');
  const phoneUserId = readDataProp(record, 'phoneUserId');
  const aiuserSessionBinding = readDataProp(record, 'aiuserSessionBinding');
  const phoneSessionBinding = readDataProp(record, 'phoneSessionBinding');
  const createdAt = readDataProp(record, 'createdAt');
  const expiresAt = readDataProp(record, 'expiresAt');
  const consumed = readDataProp(record, 'consumed');
  if (!isHex64(id)) return null;
  if (!isHex64(principalKey)) return null;
  if (!isLowercaseUuid(phoneUserId)) return null;
  if (!isHex64(aiuserSessionBinding)) return null;
  if (!isHex64(phoneSessionBinding)) return null;
  if (!isNonnegSafeInteger(createdAt)) return null;
  if (!isNonnegSafeInteger(expiresAt)) return null;
  if (consumed !== false) return null;
  return {
    id,
    principalKey,
    phoneUserId,
    aiuserSessionBinding,
    phoneSessionBinding,
    createdAt,
    expiresAt,
    consumed: false,
  };
}

/**
 * True only if `value` is a plain data object that is exactly the requested
 * mapping pair `{ principalKey, phoneUserId }` (no extra fields, exact values).
 */
function isExactMapping(
  value: unknown,
  principalKey: string,
  phoneUserId: string,
): boolean {
  const record = strictRecord(value, ['principalKey', 'phoneUserId']);
  if (record === null) return false;
  return (
    readDataProp(record, 'principalKey') === principalKey &&
    readDataProp(record, 'phoneUserId') === phoneUserId
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses an account-link confirmation into `{ confirmLink: true }`.
 *
 * Accepts ONLY a plain data object with exactly the single enumerable own
 * data field `confirmLink: true`. Rejects arrays, null/custom prototypes,
 * symbol keys, accessors, non-enumerable fields, `toJSON` (or any other
 * unknown/missing field). Never executes getters and never serializes the
 * input. Descriptor/prototype errors return null.
 */
export function parseAiUserAccountLinkConfirmation(
  value: unknown,
): { confirmLink: true } | null {
  if (typeof value !== 'object' || value === null) return null;
  try {
    if (Array.isArray(value)) return null;
  } catch {
    return null; // e.g. revoked proxy: IsArray throws
  }
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (proto !== Object.prototype) return null;
  let names: string[];
  let symbols: symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return null;
  }
  if (symbols.length !== 0) return null;
  if (names.length !== 1 || names[0] !== 'confirmLink') return null;
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(value, 'confirmLink');
  } catch {
    return null;
  }
  if (desc === undefined) return null;
  if (!('value' in desc)) return null; // accessor descriptor
  if (desc.enumerable !== true) return null;
  if (desc.value !== true) return null;
  return { confirmLink: true };
}

/**
 * Decides whether the account-link intent may be applied.
 *
 * Validates the exact `aistory.aiuser-account-link-proof.v1` shape: both
 * proofs active and unexpired (`now < expiresAt`), issued at/before `now` and
 * at most 300000ms old, proof expiry exceeding authentication time, AIUser
 * lifetime <= 900000ms, phone lifetime <= 604800000ms; the intent
 * `createdAt <= now < expiresAt` with positive TTL <= 60000ms, created no
 * earlier than either proof, with bindings exactly equal to the proofs and not
 * consumed; and existing mapping history that is either both null (link
 * allowed) or both the exact requested pair (already linked).
 *
 * The decision is server-private; the granted result must never be a browser
 * DTO. Failure is always the fixed `ACCOUNT_LINK_REJECTED` decision with no
 * user-controlled strings. Input is never mutated; malformed values collapse
 * into the fixed decision instead of throwing.
 */
export function decideAiUserAccountLink(
  value: unknown,
  nowMs: number,
): LinkDecision {
  try {
    return decideInner(value, nowMs);
  } catch {
    return rejected();
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function rejected(): AccountLinkRejected {
  return { ok: false, code: 'ACCOUNT_LINK_REJECTED' };
}

function granted(
  status: AccountLinkStatus,
  principalKey: string,
  phoneUserId: string,
  intentId: string,
): AccountLinkGranted {
  return {
    ok: true,
    status,
    principalKey,
    phoneUserId,
    intentId,
    assetsMerged: false,
    creditsGranted: false,
    administratorGranted: false,
  };
}

function decideInner(value: unknown, nowMs: number): LinkDecision {
  if (!isNonnegSafeInteger(nowMs)) return rejected();

  const root = strictRecord(value, [
    'schema',
    'confirmation',
    'aiuser',
    'phone',
    'intent',
    'existingByAiuser',
    'existingByPhone',
  ]);
  if (root === null) return rejected();

  if (readDataProp(root, 'schema') !== SCHEMA) return rejected();

  const confirmation = readDataProp(root, 'confirmation');
  if (parseAiUserAccountLinkConfirmation(confirmation) === null) {
    return rejected();
  }

  const aiuser = parseAiuserProof(readDataProp(root, 'aiuser'));
  if (aiuser === null) return rejected();

  const phone = parsePhoneProof(readDataProp(root, 'phone'));
  if (phone === null) return rejected();

  const intent = parseIntent(readDataProp(root, 'intent'));
  if (intent === null) return rejected();

  // --- Both proofs: active, unexpired, fresh, correctly dated -------------
  if (aiuser.authenticatedAt > nowMs) return rejected(); // issued at/before now
  if (nowMs >= aiuser.expiresAt) return rejected(); // unexpired (strict)
  if (nowMs - aiuser.authenticatedAt > PROOF_MAX_AGE_MS) return rejected();
  if (aiuser.expiresAt <= aiuser.authenticatedAt) return rejected(); // expiry > auth
  if (aiuser.expiresAt - aiuser.authenticatedAt > AIUSER_LIFETIME_MAX_MS) {
    return rejected();
  }

  if (phone.authenticatedAt > nowMs) return rejected();
  if (nowMs >= phone.expiresAt) return rejected();
  if (nowMs - phone.authenticatedAt > PROOF_MAX_AGE_MS) return rejected();
  if (phone.expiresAt <= phone.authenticatedAt) return rejected();
  if (phone.expiresAt - phone.authenticatedAt > PHONE_LIFETIME_MAX_MS) {
    return rejected();
  }

  // --- Intent: not consumed, current window, positive bounded TTL ---------
  if (intent.createdAt > nowMs) return rejected(); // createdAt <= now
  if (nowMs >= intent.expiresAt) return rejected(); // now < expiresAt (strict)
  if (intent.expiresAt <= intent.createdAt) return rejected(); // positive TTL
  if (intent.expiresAt - intent.createdAt > INTENT_TTL_MAX_MS) return rejected();
  // Not replayed before either proof was issued.
  if (intent.createdAt < aiuser.authenticatedAt) return rejected();
  if (intent.createdAt < phone.authenticatedAt) return rejected();

  // --- Exact bindings (cross-account bindings denied) ---------------------
  if (intent.principalKey !== aiuser.principalKey) return rejected();
  if (intent.phoneUserId !== phone.userId) return rejected();
  if (intent.aiuserSessionBinding !== aiuser.sessionBinding) return rejected();
  if (intent.phoneSessionBinding !== phone.sessionBinding) return rejected();

  // --- Existing mapping history -------------------------------------------
  const existingByAiuser = readDataProp(root, 'existingByAiuser');
  const existingByPhone = readDataProp(root, 'existingByPhone');
  const principalKey = aiuser.principalKey;
  const phoneUserId = phone.userId;

  if (existingByAiuser === null && existingByPhone === null) {
    return granted('link_allowed', principalKey, phoneUserId, intent.id);
  }
  if (
    existingByAiuser !== null &&
    existingByPhone !== null &&
    isExactMapping(existingByAiuser, principalKey, phoneUserId) &&
    isExactMapping(existingByPhone, principalKey, phoneUserId)
  ) {
    return granted('already_linked', principalKey, phoneUserId, intent.id);
  }
  return rejected();
}
