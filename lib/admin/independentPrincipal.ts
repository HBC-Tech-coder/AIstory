import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  INDEPENDENT_ADMIN_PASSWORD_POLICY,
  isIndependentAdminPasswordAllowed,
} from "./independentPasswordPolicy";

export const INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID =
  "aistory-independent-admin-principal-v1";
export const INDEPENDENT_ADMIN_PRINCIPAL_MODE =
  `${INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID}:local_fake_only`;
export const INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE =
  `${INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID}:production_v1`;
export const INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV =
  "AISTORY_ADMIN_PRINCIPAL_MODE";
export const INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV =
  "AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE";
export const INDEPENDENT_ADMIN_PRINCIPAL_COOKIE =
  "__Host-aistory_admin_principal_v1";

const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{4,63}$/;
const PRINCIPAL_ID_PATTERN = /^iap_[a-f0-9]{32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CREDENTIAL_FILE_BYTES = 4096;
const MAX_LOGIN_BODY_BYTES = 4096;
const MAX_SESSION_TOKEN_BYTES = 4096;
const MAX_SCRYPT_QUEUE_DEPTH = 8;
const SESSION_TTL_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 5;
const MAX_FAKE_RATE_BUCKETS = 256;
const MAX_FAKE_AUDIT_EVENTS = 2048;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const PASSWORD_DOMAIN = "aistory:independent-admin:password:v1";
const USERNAME_KEY_DOMAIN = "aistory:independent-admin:username-key:v1";
const USERNAME_DOMAIN = "aistory:independent-admin:username:v1";
const SESSION_KEY_DOMAIN = "aistory:independent-admin:session-key:v1";
const SESSION_ROTATION_DOMAIN = "aistory:independent-admin:session-rotation:v1";
const RATE_KEY_DOMAIN = "aistory:independent-admin:rate-key:v1";

type PrincipalEnvironment = Record<string, string | undefined>;

export type IndependentAdminPrincipalCredential = Readonly<{
  schemaVersion: 1;
  policyId: typeof INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID;
  principalId: string;
  credentialEpoch: string;
  status: "active";
  usernameVerifierHmacSha256: string;
  passwordVerifier: Readonly<{
    algorithm: "scrypt-v1";
    saltBase64url: string;
    digestBase64url: string;
    N: typeof SCRYPT_N;
    r: typeof SCRYPT_R;
    p: typeof SCRYPT_P;
    keyLength: typeof SCRYPT_KEY_LENGTH;
    maxmem: typeof SCRYPT_MAXMEM;
  }>;
  keyMaterialBase64url: string;
}>;

export type IndependentAdminPrincipalActor = Readonly<{
  principalId: string;
  roles: readonly ["super_admin"] | readonly [];
  mode: "local_fake_only" | "production";
}>;

export type IndependentAdminPrincipalAuditEvent = Readonly<{
  sequence: number;
  event:
    | "origin_rejected"
    | "invalid_credentials"
    | "rate_limited"
    | "login_succeeded"
    | "session_rotated"
    | "logout";
  principalId?: string;
  occurredAt: number;
}>;

export interface IndependentAdminPrincipalAuthStateStore {
  reserveLoginAttempts(
    bucketHashes: readonly [string, string],
    now: number,
  ): Promise<Readonly<{ allowed: boolean; retryAfterSeconds: number }>>;
  recordInvalidCredentials(now: number): Promise<void>;
  commitLoginSuccess(input: {
    principalId: string;
    sessionIdHash: string;
    expiresAt: number;
    bucketHashes: readonly string[];
    now: number;
  }): Promise<void>;
  isSessionCurrent(input: {
    principalId: string;
    sessionIdHash: string;
    now: number;
  }): Promise<boolean>;
  revokeSession(input: {
    principalId: string;
    sessionIdHash: string;
    now: number;
  }): Promise<void>;
  rotateSession(input: {
    principalId: string;
    currentSessionIdHash: string;
    nextSessionIdHash: string;
    nextExpiresAt: number;
    now: number;
  }): Promise<void>;
  appendSecurityEvent(
    event: Omit<IndependentAdminPrincipalAuditEvent, "sequence">,
  ): Promise<void>;
}

type PrincipalSessionPayload = Readonly<{
  schemaVersion: 1;
  policyId: typeof INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type IndependentAdminPrincipalRuntime = {
  // Server-owned DB projection only. Never populated from an HTTP body/cookie.
  credential?: IndependentAdminPrincipalCredential;
  mustChangePassword?: boolean;
  passwordSubject?: "principal";
  env?: PrincipalEnvironment;
  workspaceRoot?: string;
  now?: number;
  loadCredentialFile?: (
    fileReference: string,
    workspaceRoot: string,
  ) => Promise<string>;
  store: IndependentAdminPrincipalAuthStateStore;
  randomSessionBytes?: () => Buffer;
  onPasswordKdf?: () => void;
  expectedMode?:
    | typeof INDEPENDENT_ADMIN_PRINCIPAL_MODE
    | typeof INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE;
  actorMode?: IndependentAdminPrincipalActor["mode"];
  expectedOrigin?: string;
  clientBucket?: string;
};

export type IndependentAdminPrincipalCredentialBinding = Readonly<{
  principalId: string;
  credentialBindingSha256: string;
  credentialEpochSha256: string;
  passwordVerifierReferenceSha256: string;
  passwordAlgorithm: "scrypt-v1";
  passwordParameters: Readonly<{
    N: typeof SCRYPT_N;
    r: typeof SCRYPT_R;
    p: typeof SCRYPT_P;
    keyLength: typeof SCRYPT_KEY_LENGTH;
    maxmem: typeof SCRYPT_MAXMEM;
  }>;
}>;

export type IndependentAdminPrincipalSessionContext = Readonly<{
  mustChangePassword: boolean;
  actor: IndependentAdminPrincipalActor;
  binding: IndependentAdminPrincipalCredentialBinding;
  sessionIdHash: string;
  issuedAt: number;
  expiresAt: number;
}>;

export class IndependentAdminPrincipalError extends Error {
  readonly code:
    | "ADMIN_PRINCIPAL_UNAVAILABLE"
    | "ADMIN_PRINCIPAL_FORBIDDEN"
    | "ADMIN_PRINCIPAL_RATE_LIMITED";
  readonly status: 403 | 429 | 503;
  readonly retryAfterSeconds?: number;

  constructor(
    code: IndependentAdminPrincipalError["code"],
    status: IndependentAdminPrincipalError["status"],
    retryAfterSeconds?: number,
  ) {
    super(
      code === "ADMIN_PRINCIPAL_UNAVAILABLE"
        ? "Administrator sign-in is unavailable."
        : "Administrator sign-in failed.",
    );
    this.name = "IndependentAdminPrincipalError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function failCredential(): never {
  throw new Error("Independent administrator credential is unavailable.");
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) failCredential();
  return descriptor.value;
}

function exactPlainRecord(
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
  return keys.length === expectedKeys.length
    && keys.every((key) => {
      if (typeof key !== "string" || !expectedKeys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor
        && "value" in descriptor
        && descriptor.get === undefined
        && descriptor.set === undefined;
    });
}

function decodeBase64url(value: unknown, expectedBytes: number): Buffer {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    failCredential();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== expectedBytes
    || decoded.toString("base64url") !== value
  ) failCredential();
  return decoded;
}

export function validateIndependentAdminPrincipalCredential(
  value: unknown,
): IndependentAdminPrincipalCredential {
  const keys = [
    "schemaVersion",
    "policyId",
    "principalId",
    "credentialEpoch",
    "status",
    "usernameVerifierHmacSha256",
    "passwordVerifier",
    "keyMaterialBase64url",
  ] as const;
  if (!exactPlainRecord(value, keys)) failCredential();
  const passwordVerifier = ownDataValue(value, "passwordVerifier");
  const passwordKeys = [
    "algorithm",
    "saltBase64url",
    "digestBase64url",
    "N",
    "r",
    "p",
    "keyLength",
    "maxmem",
  ] as const;
  if (!exactPlainRecord(passwordVerifier, passwordKeys)) failCredential();

  const schemaVersion = ownDataValue(value, "schemaVersion");
  const policyId = ownDataValue(value, "policyId");
  const principalId = ownDataValue(value, "principalId");
  const credentialEpoch = ownDataValue(value, "credentialEpoch");
  const status = ownDataValue(value, "status");
  const usernameVerifierHmacSha256 = ownDataValue(
    value,
    "usernameVerifierHmacSha256",
  );
  const keyMaterialBase64url = ownDataValue(value, "keyMaterialBase64url");
  const algorithm = ownDataValue(passwordVerifier, "algorithm");
  const saltBase64url = ownDataValue(passwordVerifier, "saltBase64url");
  const digestBase64url = ownDataValue(passwordVerifier, "digestBase64url");
  const N = ownDataValue(passwordVerifier, "N");
  const r = ownDataValue(passwordVerifier, "r");
  const p = ownDataValue(passwordVerifier, "p");
  const keyLength = ownDataValue(passwordVerifier, "keyLength");
  const maxmem = ownDataValue(passwordVerifier, "maxmem");
  if (
    schemaVersion !== 1
    || policyId !== INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID
    || typeof principalId !== "string"
    || !PRINCIPAL_ID_PATTERN.test(principalId)
    || typeof credentialEpoch !== "string"
    || status !== "active"
    || typeof usernameVerifierHmacSha256 !== "string"
    || !HASH_PATTERN.test(usernameVerifierHmacSha256)
    || typeof saltBase64url !== "string"
    || typeof digestBase64url !== "string"
    || typeof keyMaterialBase64url !== "string"
    || algorithm !== "scrypt-v1"
    || N !== SCRYPT_N
    || r !== SCRYPT_R
    || p !== SCRYPT_P
    || keyLength !== SCRYPT_KEY_LENGTH
    || maxmem !== SCRYPT_MAXMEM
  ) failCredential();
  decodeBase64url(credentialEpoch, 16);
  decodeBase64url(saltBase64url, 32);
  decodeBase64url(digestBase64url, SCRYPT_KEY_LENGTH);
  decodeBase64url(keyMaterialBase64url, 64);

  return Object.freeze({
    schemaVersion: 1,
    policyId: INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID,
    principalId,
    credentialEpoch,
    status: "active",
    usernameVerifierHmacSha256,
    passwordVerifier: Object.freeze({
      algorithm: "scrypt-v1",
      saltBase64url,
      digestBase64url,
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: SCRYPT_KEY_LENGTH,
      maxmem: SCRYPT_MAXMEM,
    } as const),
    keyMaterialBase64url,
  });
}

export function serializeIndependentAdminPrincipalCredential(
  credential: IndependentAdminPrincipalCredential,
): string {
  return `${JSON.stringify(credential, null, 2)}\n`;
}

export function parseIndependentAdminPrincipalCredential(
  raw: string,
): IndependentAdminPrincipalCredential {
  if (
    raw.length < 2
    || Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_FILE_BYTES
    || raw.charCodeAt(0) === 0xfeff
  ) failCredential();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    failCredential();
  }
  const credential = validateIndependentAdminPrincipalCredential(parsed);
  if (raw !== serializeIndependentAdminPrincipalCredential(credential)) {
    failCredential();
  }
  return credential;
}

export function projectIndependentAdminPrincipalCredentialBinding(
  credential: IndependentAdminPrincipalCredential,
): IndependentAdminPrincipalCredentialBinding {
  const serialized = serializeIndependentAdminPrincipalCredential(credential);
  return Object.freeze({
    principalId: credential.principalId,
    credentialBindingSha256: createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex"),
    credentialEpochSha256: createHash("sha256")
      .update(credential.credentialEpoch, "utf8")
      .digest("hex"),
    passwordVerifierReferenceSha256: createHash("sha256")
      .update(credential.passwordVerifier.digestBase64url, "utf8")
      .digest("hex"),
    passwordAlgorithm: "scrypt-v1",
    passwordParameters: Object.freeze({
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: SCRYPT_KEY_LENGTH,
      maxmem: SCRYPT_MAXMEM,
    }),
  });
}

function normalizeLoginName(value: string): string | undefined {
  return USERNAME_PATTERN.test(value) ? value : undefined;
}

function deriveKey(keyMaterial: Buffer, domain: string): Buffer {
  return createHmac("sha256", keyMaterial).update(domain).digest();
}

function sessionSigningKey(
  credential: IndependentAdminPrincipalCredential,
): Buffer {
  const keyMaterial = decodeBase64url(credential.keyMaterialBase64url, 64);
  return createHmac("sha256", deriveKey(keyMaterial, SESSION_KEY_DOMAIN))
    .update(credential.credentialEpoch, "utf8")
    .digest();
}

function usernameVerifier(username: string, keyMaterial: Buffer): string {
  return createHmac(
    "sha256",
    deriveKey(keyMaterial, USERNAME_KEY_DOMAIN),
  )
    .update(USERNAME_DOMAIN)
    .update("\n")
    .update(username)
    .digest("hex");
}

let scryptQueue: Promise<void> = Promise.resolve();
let scryptQueueDepth = 0;

async function derivePasswordVerifier(
  username: string,
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  if (scryptQueueDepth >= MAX_SCRYPT_QUEUE_DEPTH) failCredential();
  scryptQueueDepth += 1;
  const previous = scryptQueue;
  let release: () => void = () => undefined;
  scryptQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const passwordBytes = Buffer.from(password, "utf8");
  const material = Buffer.concat([
    Buffer.from(`${PASSWORD_DOMAIN}\n${username}\0`, "utf8"),
    passwordBytes,
  ]);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        material,
        salt,
        SCRYPT_KEY_LENGTH,
        {
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          maxmem: SCRYPT_MAXMEM,
        },
        (error, derivedKey) => {
          if (error) reject(error);
          else resolve(Buffer.from(derivedKey));
        },
      );
    });
  } finally {
    passwordBytes.fill(0);
    material.fill(0);
    scryptQueueDepth -= 1;
    release();
  }
}

export async function createIndependentAdminPrincipalCredential(input: {
  username: string;
  password: string;
  random?: (bytes: number) => Buffer;
}): Promise<IndependentAdminPrincipalCredential> {
  const username = normalizeLoginName(input.username);
  const passwordBytes = Buffer.byteLength(input.password, "utf8");
  if (
    !username
    || passwordBytes > INDEPENDENT_ADMIN_PASSWORD_POLICY.maximumUtf8Bytes
    || !isIndependentAdminPasswordAllowed(input.password)
  ) failCredential();
  const random = input.random ?? randomBytes;
  const principalId = `iap_${random(16).toString("hex")}`;
  const credentialEpoch = random(16).toString("base64url");
  const salt = random(32);
  const keyMaterial = random(64);
  if (
    !PRINCIPAL_ID_PATTERN.test(principalId)
    || decodeBase64url(credentialEpoch, 16).length !== 16
    || salt.length !== 32
    || keyMaterial.length !== 64
  ) failCredential();
  const digest = await derivePasswordVerifier(username, input.password, salt);
  return validateIndependentAdminPrincipalCredential({
    schemaVersion: 1,
    policyId: INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID,
    principalId,
    credentialEpoch,
    status: "active",
    usernameVerifierHmacSha256: usernameVerifier(username, keyMaterial),
    passwordVerifier: {
      algorithm: "scrypt-v1",
      saltBase64url: salt.toString("base64url"),
      digestBase64url: digest.toString("base64url"),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: SCRYPT_KEY_LENGTH,
      maxmem: SCRYPT_MAXMEM,
    },
    keyMaterialBase64url: keyMaterial.toString("base64url"),
  });
}

export async function createRotatedIndependentAdminPrincipalCredential(input: {
  current: IndependentAdminPrincipalCredential;
  username: string;
  password: string;
  random?: (bytes: number) => Buffer;
}): Promise<IndependentAdminPrincipalCredential> {
  const generated = await createIndependentAdminPrincipalCredential({
    username: input.username,
    password: input.password,
    random: input.random,
  });
  return validateIndependentAdminPrincipalCredential({
    ...generated,
    principalId: input.current.principalId,
  });
}

function normalizePathForComparison(value: string): string {
  return path.posix.normalize(value);
}

// The first-change contract uses the random principal as its KDF subject, not
// the login name, so the password-change endpoint need not retain/echo a name.
export async function createFirstChangeIndependentAdminCredential(input: {
  username: string;
  password: string;
}): Promise<IndependentAdminPrincipalCredential> {
  const publicDefault = input.username === "admin" && input.password === "admin888";
  if ((!normalizeLoginName(input.username) && input.username !== "admin")
    || (!publicDefault && !isIndependentAdminPasswordAllowed(input.password))) failCredential();
  const principalId = `iap_${randomBytes(16).toString("hex")}`;
  const key = randomBytes(64);
  const salt = randomBytes(32);
  const derived = await derivePasswordVerifier(principalId, input.password, salt);
  try {
    return validateIndependentAdminPrincipalCredential({ schemaVersion: 1,
      policyId: INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID, principalId,
      credentialEpoch: randomBytes(16).toString("base64url"), status: "active",
      usernameVerifierHmacSha256: usernameVerifier(input.username, key), keyMaterialBase64url: key.toString("base64url"),
      passwordVerifier: { algorithm: "scrypt-v1", saltBase64url: salt.toString("base64url"),
        digestBase64url: derived.toString("base64url"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
        keyLength: SCRYPT_KEY_LENGTH, maxmem: SCRYPT_MAXMEM } });
  } finally { derived.fill(0); key.fill(0); }
}

export async function verifyFirstChangeIndependentAdminPassword(
  credential: IndependentAdminPrincipalCredential,
  password: string,
): Promise<boolean> {
  const checked = validateIndependentAdminPrincipalCredential(credential);
  if (typeof password !== "string"
    || Buffer.byteLength(password, "utf8") > INDEPENDENT_ADMIN_PASSWORD_POLICY.maximumUtf8Bytes) return false;
  const derived = await derivePasswordVerifier(checked.principalId, password,
    decodeBase64url(checked.passwordVerifier.saltBase64url, 32));
  try {
    return safeEqual(derived, decodeBase64url(checked.passwordVerifier.digestBase64url, 64));
  } finally { derived.fill(0); }
}

export async function rotateFirstChangeIndependentAdminPassword(
  credential: IndependentAdminPrincipalCredential,
  password: string,
): Promise<IndependentAdminPrincipalCredential> {
  const checked = validateIndependentAdminPrincipalCredential(credential);
  if (!isIndependentAdminPasswordAllowed(password)) failCredential();
  const salt = randomBytes(32);
  const derived = await derivePasswordVerifier(checked.principalId, password, salt);
  try {
    return validateIndependentAdminPrincipalCredential({
      ...checked,
      credentialEpoch: randomBytes(16).toString("base64url"),
      passwordVerifier: { ...checked.passwordVerifier,
        saltBase64url: salt.toString("base64url"), digestBase64url: derived.toString("base64url") },
    });
  } finally { derived.fill(0); }
}


function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return relative === ""
    || (
      !path.posix.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith("../")
    );
}

export async function assertIndependentAdminPrincipalProtectedDirectoryChain(
  directory: string,
  options: Readonly<{
    effectiveUid: number | undefined;
    ownerOnlyLeaf: boolean;
  }>,
): Promise<void> {
  let current = path.posix.resolve(directory);
  const leaf = current;
  while (true) {
    const metadata = await lstat(current);
    const disallowedMode = current === leaf && options.ownerOnlyLeaf
      ? 0o077
      : 0o022;
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (metadata.uid !== 0 && metadata.uid !== options.effectiveUid)
      || (metadata.mode & disallowedMode) !== 0
      || normalizePathForComparison(await realpath(current))
        !== normalizePathForComparison(current)
    ) failCredential();
    const parent = path.posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function validateIndependentAdminPrincipalFileReference(
  fileReference: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    platform !== "linux"
    || !fileReference
    || fileReference.includes("\0")
    || fileReference.startsWith("//")
    || !path.posix.isAbsolute(fileReference)
  ) failCredential();
  const resolved = path.posix.resolve(fileReference);
  if (isInsideDirectory(path.posix.resolve(workspaceRoot), resolved)) {
    failCredential();
  }
  return resolved;
}

async function readProtectedCredentialFile(
  fileReference: string,
  workspaceRoot: string,
): Promise<string> {
  const resolved = validateIndependentAdminPrincipalFileReference(
    fileReference,
    workspaceRoot,
  );
  const parent = path.posix.dirname(resolved);
  const effectiveUid = process.geteuid?.();
  await assertIndependentAdminPrincipalProtectedDirectoryChain(parent, {
    effectiveUid,
    ownerOnlyLeaf: true,
  });
  const linkMetadata = await lstat(resolved);
  if (
    !linkMetadata.isFile()
    || linkMetadata.isSymbolicLink()
    || (linkMetadata.uid !== 0 && linkMetadata.uid !== effectiveUid)
    || (linkMetadata.mode & 0o077) !== 0
    || linkMetadata.nlink !== 1
    || linkMetadata.size < 2
    || linkMetadata.size > MAX_CREDENTIAL_FILE_BYTES
  ) failCredential();
  if (
    normalizePathForComparison(await realpath(resolved))
    !== normalizePathForComparison(resolved)
  ) failCredential();
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || (before.uid !== 0 && before.uid !== effectiveUid)
      || (before.mode & 0o077) !== 0
      || before.nlink !== 1
      || before.dev !== linkMetadata.dev
      || before.ino !== linkMetadata.ino
      || before.size !== linkMetadata.size
      || before.mtimeMs !== linkMetadata.mtimeMs
    ) failCredential();
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.nlink !== 1
      || Buffer.byteLength(raw, "utf8") !== after.size
    ) failCredential();
    return raw;
  } finally {
    await handle.close();
  }
}

async function loadCredential(
  runtime: IndependentAdminPrincipalRuntime,
): Promise<IndependentAdminPrincipalCredential> {
  const env = runtime.env ?? process.env;
  const expectedMode = runtime.expectedMode
    ?? INDEPENDENT_ADMIN_PRINCIPAL_MODE;
  if (env[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV] !== expectedMode) {
    failCredential();
  }
  if (runtime.credential) {
    return validateIndependentAdminPrincipalCredential(runtime.credential);
  }
  const reference = env[
    INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV
  ]?.trim();
  if (!reference) failCredential();
  const raw = await (
    runtime.loadCredentialFile ?? readProtectedCredentialFile
  )(reference, runtime.workspaceRoot ?? process.cwd());
  return parseIndependentAdminPrincipalCredential(raw);
}

export async function loadIndependentAdminPrincipalCredential(
  runtime: IndependentAdminPrincipalRuntime,
): Promise<IndependentAdminPrincipalCredential> {
  return loadCredential(runtime);
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeSession(payload: PrincipalSessionPayload, key: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function parseSession(
  token: string,
  credential: IndependentAdminPrincipalCredential,
): PrincipalSessionPayload | undefined {
  if (Buffer.byteLength(token, "utf8") > MAX_SESSION_TOKEN_BYTES) {
    return undefined;
  }
  const [encoded, provided, extra] = token.split(".");
  if (!encoded || !provided || extra) return undefined;
  const sessionKey = sessionSigningKey(credential);
  const expected = createHmac("sha256", sessionKey)
    .update(encoded)
    .digest("base64url");
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (!safeEqual(left, right)) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    const keys = [
      "schemaVersion",
      "policyId",
      "sessionId",
      "issuedAt",
      "expiresAt",
    ] as const;
    if (!exactPlainRecord(parsed, keys)) return undefined;
    const payload = parsed as Record<string, unknown>;
    if (
      payload.schemaVersion !== 1
      || payload.policyId !== INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID
      || typeof payload.sessionId !== "string"
      || decodeBase64url(payload.sessionId, 32).length !== 32
      || typeof payload.issuedAt !== "number"
      || !Number.isSafeInteger(payload.issuedAt)
      || typeof payload.expiresAt !== "number"
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= payload.issuedAt
      || payload.expiresAt - payload.issuedAt > SESSION_TTL_MS
    ) return undefined;
    return payload as PrincipalSessionPayload;
  } catch {
    return undefined;
  }
}

function sessionIdHash(sessionId: string, keyMaterial: Buffer): string {
  return createHmac("sha256", deriveKey(keyMaterial, SESSION_KEY_DOMAIN))
    .update(sessionId)
    .digest("hex");
}

function rotatedSessionId(
  currentSessionId: string,
  credential: IndependentAdminPrincipalCredential,
): string {
  return createHmac("sha256", sessionSigningKey(credential))
    .update(SESSION_ROTATION_DOMAIN, "utf8")
    .update("\n", "utf8")
    .update(currentSessionId, "utf8")
    .digest("base64url");
}

function rateBucketHash(
  username: string,
  clientBucket: string,
  keyMaterial: Buffer,
): string {
  return createHmac("sha256", deriveKey(keyMaterial, RATE_KEY_DOMAIN))
    .update(username)
    .update("\n")
    .update(clientBucket)
    .digest("hex");
}

export async function authenticateIndependentAdminPrincipal(input: {
  username: string;
  password: string;
  clientBucket: string;
  runtime: IndependentAdminPrincipalRuntime;
}): Promise<Readonly<{
  actor: IndependentAdminPrincipalActor;
  sessionToken: string;
}>> {
  let credential: IndependentAdminPrincipalCredential;
  try {
    credential = await loadCredential(input.runtime);
  } catch {
    throw new IndependentAdminPrincipalError(
      "ADMIN_PRINCIPAL_UNAVAILABLE",
      503,
    );
  }
  const now = input.runtime.now ?? Date.now();
  const keyMaterial = decodeBase64url(credential.keyMaterialBase64url, 64);
  const normalizedUsername = input.runtime.passwordSubject === "principal" && input.username === "admin"
    ? "admin" : normalizeLoginName(input.username);
  const passwordBytes = Buffer.byteLength(input.password, "utf8");
  const boundedUsername = normalizedUsername ?? "invalid-admin-principal";
  const boundedPassword = passwordBytes <= INDEPENDENT_ADMIN_PASSWORD_POLICY.maximumUtf8Bytes
    ? input.password
    : "";
  const bucketHash = rateBucketHash(
    boundedUsername,
    input.clientBucket,
    keyMaterial,
  );
  const globalBucketHash = rateBucketHash(
    "__global__",
    input.clientBucket,
    keyMaterial,
  );
  const reservation = await input.runtime.store.reserveLoginAttempts(
    [globalBucketHash, bucketHash],
    now,
  );
  if (!reservation.allowed) {
    throw new IndependentAdminPrincipalError(
      "ADMIN_PRINCIPAL_RATE_LIMITED",
      429,
      reservation.retryAfterSeconds,
    );
  }

  input.runtime.onPasswordKdf?.();
  const derived = await derivePasswordVerifier(
    input.runtime.passwordSubject === "principal"
      ? credential.principalId : boundedUsername,
    boundedPassword,
    decodeBase64url(credential.passwordVerifier.saltBase64url, 32),
  );
  const expectedPassword = decodeBase64url(
    credential.passwordVerifier.digestBase64url,
    SCRYPT_KEY_LENGTH,
  );
  const suppliedUsernameVerifier = usernameVerifier(
    boundedUsername,
    keyMaterial,
  );
  const usernameMatches = normalizedUsername !== undefined
    && safeEqual(
      Buffer.from(suppliedUsernameVerifier, "hex"),
      Buffer.from(credential.usernameVerifierHmacSha256, "hex"),
    );
  const passwordMatches = safeEqual(derived, expectedPassword);
  derived.fill(0);
  if (!usernameMatches || !passwordMatches) {
    await input.runtime.store.recordInvalidCredentials(now);
    throw new IndependentAdminPrincipalError(
      "ADMIN_PRINCIPAL_FORBIDDEN",
      403,
    );
  }

  const sessionId = (
    input.runtime.randomSessionBytes ?? (() => randomBytes(32))
  )().toString("base64url");
  decodeBase64url(sessionId, 32);
  const payload: PrincipalSessionPayload = {
    schemaVersion: 1,
    policyId: INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID,
    sessionId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  const hashedSessionId = sessionIdHash(sessionId, keyMaterial);
  await input.runtime.store.commitLoginSuccess({
    principalId: credential.principalId,
    sessionIdHash: hashedSessionId,
    expiresAt: payload.expiresAt,
    bucketHashes: [bucketHash, globalBucketHash],
    now,
  });
  return Object.freeze({
    actor: Object.freeze({
      principalId: credential.principalId,
      roles: input.runtime.mustChangePassword
        ? Object.freeze([] as const) : Object.freeze(["super_admin"] as const),
      mode: input.runtime.actorMode ?? "local_fake_only",
    }),
    sessionToken: encodeSession(
      payload,
      sessionSigningKey(credential),
    ),
  });
}

export async function resolveIndependentAdminPrincipalSessionContext(
  token: string | undefined,
  runtime: IndependentAdminPrincipalRuntime,
): Promise<IndependentAdminPrincipalSessionContext | undefined> {
  if (!token) return undefined;
  const credential = await loadCredential(runtime);
  const payload = parseSession(token, credential);
  const now = runtime.now ?? Date.now();
  if (!payload || payload.expiresAt <= now || payload.issuedAt > now) {
    return undefined;
  }
  const keyMaterial = decodeBase64url(credential.keyMaterialBase64url, 64);
  const hashedSessionId = sessionIdHash(payload.sessionId, keyMaterial);
  if (!await runtime.store.isSessionCurrent({
    principalId: credential.principalId,
    sessionIdHash: hashedSessionId,
    now,
  })) return undefined;
  return Object.freeze({
    mustChangePassword: runtime.mustChangePassword === true,
    actor: Object.freeze({
      principalId: credential.principalId,
      roles: runtime.mustChangePassword
        ? Object.freeze([] as const) : Object.freeze(["super_admin"] as const),
      mode: runtime.actorMode ?? "local_fake_only",
    }),
    binding: projectIndependentAdminPrincipalCredentialBinding(credential),
    sessionIdHash: hashedSessionId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

export async function verifyIndependentAdminPrincipalSession(
  token: string | undefined,
  runtime: IndependentAdminPrincipalRuntime,
): Promise<IndependentAdminPrincipalActor | undefined> {
  try {
    const context = await resolveIndependentAdminPrincipalSessionContext(
      token,
      runtime,
    );
    return context?.mustChangePassword ? undefined : context?.actor;
  } catch {
    return undefined;
  }
}

export async function rotateIndependentAdminPrincipalSession(
  token: string | undefined,
  runtime: IndependentAdminPrincipalRuntime,
): Promise<string | undefined> {
  if (!token || runtime.mustChangePassword) return undefined;
  const credential = await loadCredential(runtime);
  const current = parseSession(token, credential);
  const now = runtime.now ?? Date.now();
  if (
    !current
    || current.expiresAt <= now
    || current.issuedAt > now
  ) return undefined;
  const keyMaterial = decodeBase64url(credential.keyMaterialBase64url, 64);
  const nextSessionId = rotatedSessionId(current.sessionId, credential);
  decodeBase64url(nextSessionId, 32);
  const nextPayload: PrincipalSessionPayload = {
    schemaVersion: 1,
    policyId: INDEPENDENT_ADMIN_PRINCIPAL_POLICY_ID,
    sessionId: nextSessionId,
    issuedAt: current.issuedAt,
    expiresAt: current.expiresAt,
  };
  await runtime.store.rotateSession({
    principalId: credential.principalId,
    currentSessionIdHash: sessionIdHash(current.sessionId, keyMaterial),
    nextSessionIdHash: sessionIdHash(nextSessionId, keyMaterial),
    nextExpiresAt: nextPayload.expiresAt,
    now,
  });
  return encodeSession(
    nextPayload,
    sessionSigningKey(credential),
  );
}

export async function revokeIndependentAdminPrincipalSession(
  token: string | undefined,
  runtime: IndependentAdminPrincipalRuntime,
): Promise<void> {
  if (!token) return;
  try {
    const credential = await loadCredential(runtime);
    const payload = parseSession(token, credential);
    if (!payload) return;
    const keyMaterial = decodeBase64url(credential.keyMaterialBase64url, 64);
    await runtime.store.revokeSession({
      principalId: credential.principalId,
      sessionIdHash: sessionIdHash(payload.sessionId, keyMaterial),
      now: runtime.now ?? Date.now(),
    });
  } catch {
    // A malformed or retired credential/session remains logged out.
  }
}

export async function requireIndependentAdminPrincipalRole(
  token: string | undefined,
  role: "super_admin",
  runtime: IndependentAdminPrincipalRuntime,
): Promise<IndependentAdminPrincipalActor | undefined> {
  if (role !== "super_admin") return undefined;
  const actor = await verifyIndependentAdminPrincipalSession(token, runtime);
  return actor?.roles[0] === role ? actor : undefined;
}

function sameOrigin(
  request: Request,
  expectedOrigin?: string,
): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    const requestUrl = new URL(request.url);
    if (expectedOrigin) {
      const expected = new URL(expectedOrigin);
      return expected.protocol === "https:"
        && expected.username === ""
        && expected.password === ""
        && expected.pathname === "/"
        && expected.search === ""
        && expected.hash === ""
        && parsedOrigin.protocol === "https:"
        && parsedOrigin.username === ""
        && parsedOrigin.password === ""
        && parsedOrigin.pathname === "/"
        && parsedOrigin.search === ""
        && parsedOrigin.hash === ""
        && parsedOrigin.origin === expected.origin
        && requestUrl.origin === expected.origin
        && host.trim().toLowerCase() === expected.host.toLowerCase();
    }
    const loopback = requestUrl.hostname === "localhost"
      || requestUrl.hostname === "127.0.0.1"
      || requestUrl.hostname === "[::1]";
    return loopback
      && (requestUrl.protocol === "http:" || requestUrl.protocol === "https:")
      && origin === parsedOrigin.origin
      && parsedOrigin.origin === requestUrl.origin
      && host.trim().toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

function loginJson(
  body: Record<string, unknown>,
  init: ResponseInit,
): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

async function readBoundedRequestText(
  request: Request,
  maximumBytes: number,
): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (
    declared
    && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)
  ) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  if (declared && Number(declared) !== total) return undefined;
  return Buffer.concat(chunks, total).toString("utf8");
}

export type IndependentAdminPrincipalLoginRequestInspection = Readonly<
  | { kind: "valid"; username: string; password: string }
  | { kind: "origin_rejected" }
  | { kind: "invalid" }
>;

export async function inspectIndependentAdminPrincipalLoginRequest(
  request: Request,
  expectedOrigin?: string,
): Promise<IndependentAdminPrincipalLoginRequestInspection> {
  if (!sameOrigin(request, expectedOrigin)) {
    return Object.freeze({ kind: "origin_rejected" });
  }
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(
    request.headers.get("content-type")?.trim() ?? "",
  )) return Object.freeze({ kind: "invalid" });
  try {
    const raw = await readBoundedRequestText(request, MAX_LOGIN_BODY_BYTES);
    if (raw === undefined) return Object.freeze({ kind: "invalid" });
    const body = JSON.parse(raw) as unknown;
    if (
      !exactPlainRecord(body, ["username", "password"])
      || typeof body.username !== "string"
      || typeof body.password !== "string"
    ) return Object.freeze({ kind: "invalid" });
    return Object.freeze({
      kind: "valid",
      username: body.username,
      password: body.password,
    });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

export async function handleIndependentAdminPrincipalLoginRequest(
  request: Request,
  runtime: IndependentAdminPrincipalRuntime,
  prevalidatedInspection?: IndependentAdminPrincipalLoginRequestInspection,
): Promise<Readonly<{ response: Response; sessionToken?: string }>> {
  const now = runtime.now ?? Date.now();
  const expectedMode = runtime.expectedMode
    ?? INDEPENDENT_ADMIN_PRINCIPAL_MODE;
  if (
    (runtime.env ?? process.env)[INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV]
      !== expectedMode
  ) {
    return Object.freeze({
      response: loginJson(
        { error: "Administrator sign-in is unavailable." },
        { status: 503 },
      ),
    });
  }
  const inspection = prevalidatedInspection
    ?? await inspectIndependentAdminPrincipalLoginRequest(
      request,
      runtime.expectedOrigin,
    );
  if (inspection.kind === "origin_rejected") {
    await runtime.store.appendSecurityEvent({
      event: "origin_rejected",
      occurredAt: now,
    });
    return Object.freeze({
      response: loginJson({ error: "Forbidden" }, { status: 403 }),
    });
  }
  if (inspection.kind === "invalid") {
    return Object.freeze({
      response: loginJson(
        { error: "Administrator sign-in failed." },
        { status: 403 },
      ),
    });
  }
  try {
    const authenticated = await authenticateIndependentAdminPrincipal({
      username: inspection.username,
      password: inspection.password,
      clientBucket: runtime.clientBucket ?? "direct-client",
      runtime,
    });
    return Object.freeze({
      response: loginJson(
        {
          ok: true,
          authMode: runtime.actorMode === "production"
            ? "independent"
            : "local_fake_only",
          state: runtime.mustChangePassword ? "password_change_required" : "console",
        },
        { status: 200 },
      ),
      sessionToken: authenticated.sessionToken,
    });
  } catch (error) {
    if (error instanceof IndependentAdminPrincipalError) {
      const headers = error.retryAfterSeconds
        ? { "Retry-After": String(error.retryAfterSeconds) }
        : undefined;
      return Object.freeze({
        response: loginJson(
          { error: error.message },
          { status: error.status, headers },
        ),
      });
    }
    return Object.freeze({
      response: loginJson(
        { error: "Administrator sign-in is unavailable." },
        { status: 503 },
      ),
    });
  }
}

export function independentAdminPrincipalCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: true,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export class InMemoryIndependentAdminPrincipalAuthStateStore
implements IndependentAdminPrincipalAuthStateStore {
  private readonly attempts = new Map<string, number[]>();
  private readonly activeSessions = new Map<
    string,
    { sessionIdHash: string; expiresAt: number }
  >();
  private readonly audit: IndependentAdminPrincipalAuditEvent[] = [];
  private readonly rotationReplays = new Map<string, string>();
  private sequence = 0;

  async reserveLoginAttempts(
    bucketHashes: readonly [string, string],
    now: number,
  ) {
    for (const [key, attempts] of this.attempts) {
      const live = attempts.filter((attempt) => attempt > now - RATE_WINDOW_MS);
      if (live.length) this.attempts.set(key, live);
      else this.attempts.delete(key);
    }
    const uniqueBuckets = [...new Set(bucketHashes)].sort();
    if (
      uniqueBuckets.some((bucketHash) => !this.attempts.has(bucketHash))
      && this.attempts.size + uniqueBuckets.filter(
        (bucketHash) => !this.attempts.has(bucketHash),
      ).length > MAX_FAKE_RATE_BUCKETS
    ) {
      await this.appendSecurityEvent({
        event: "rate_limited",
        occurredAt: now,
      });
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.ceil(RATE_WINDOW_MS / 1000),
      });
    }
    let retryAfterSeconds = 0;
    const liveByBucket = new Map<string, number[]>();
    for (const bucketHash of uniqueBuckets) {
      const current = (this.attempts.get(bucketHash) ?? [])
        .filter((attempt) => attempt > now - RATE_WINDOW_MS);
      liveByBucket.set(bucketHash, current);
      if (current.length >= RATE_MAX_ATTEMPTS) {
        retryAfterSeconds = Math.max(
          retryAfterSeconds,
          Math.max(
            1,
            Math.ceil((current[0]! + RATE_WINDOW_MS - now) / 1000),
          ),
        );
      }
    }
    if (retryAfterSeconds) {
      for (const [bucketHash, current] of liveByBucket) {
        this.attempts.set(bucketHash, current);
      }
      await this.appendSecurityEvent({
        event: "rate_limited",
        occurredAt: now,
      });
      return Object.freeze({ allowed: false, retryAfterSeconds });
    }
    for (const [bucketHash, current] of liveByBucket) {
      current.push(now);
      this.attempts.set(bucketHash, current);
    }
    return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
  }

  async recordInvalidCredentials(now: number): Promise<void> {
    await this.appendSecurityEvent({
      event: "invalid_credentials",
      occurredAt: now,
    });
  }

  async commitLoginSuccess(input: {
    principalId: string;
    sessionIdHash: string;
    expiresAt: number;
    bucketHashes: readonly string[];
    now: number;
  }): Promise<void> {
    const previous = this.activeSessions.get(input.principalId);
    const requiredAuditSlots = previous ? 2 : 1;
    if (this.audit.length + requiredAuditSlots > MAX_FAKE_AUDIT_EVENTS) {
      throw new Error("Independent administrator audit is unavailable.");
    }
    if (previous) {
      await this.appendSecurityEvent({
        event: "session_rotated",
        principalId: input.principalId,
        occurredAt: input.now,
      });
    }
    await this.appendSecurityEvent({
      event: "login_succeeded",
      principalId: input.principalId,
      occurredAt: input.now,
    });
    this.activeSessions.set(input.principalId, {
      sessionIdHash: input.sessionIdHash,
      expiresAt: input.expiresAt,
    });
    for (const bucketHash of input.bucketHashes) {
      this.attempts.delete(bucketHash);
    }
  }

  async isSessionCurrent(input: {
    principalId: string;
    sessionIdHash: string;
    now: number;
  }): Promise<boolean> {
    const current = this.activeSessions.get(input.principalId);
    return !!current
      && current.expiresAt > input.now
      && safeEqual(
        Buffer.from(current.sessionIdHash, "hex"),
        Buffer.from(input.sessionIdHash, "hex"),
      );
  }

  async revokeSession(input: {
    principalId: string;
    sessionIdHash: string;
    now: number;
  }): Promise<void> {
    if (await this.isSessionCurrent(input)) {
      await this.appendSecurityEvent({
        event: "logout",
        principalId: input.principalId,
        occurredAt: input.now,
      });
      this.activeSessions.delete(input.principalId);
    }
  }

  async rotateSession(input: {
    principalId: string;
    currentSessionIdHash: string;
    nextSessionIdHash: string;
    nextExpiresAt: number;
    now: number;
  }): Promise<void> {
    if (
      this.rotationReplays.get(input.currentSessionIdHash)
        === input.nextSessionIdHash
      && await this.isSessionCurrent({
        principalId: input.principalId,
        sessionIdHash: input.nextSessionIdHash,
        now: input.now,
      })
    ) return;
    if (!await this.isSessionCurrent({
      principalId: input.principalId,
      sessionIdHash: input.currentSessionIdHash,
      now: input.now,
    })) {
      throw new Error("Independent administrator session is unavailable.");
    }
    await this.appendSecurityEvent({
      event: "session_rotated",
      principalId: input.principalId,
      occurredAt: input.now,
    });
    this.rotationReplays.set(
      input.currentSessionIdHash,
      input.nextSessionIdHash,
    );
    this.activeSessions.set(input.principalId, {
      sessionIdHash: input.nextSessionIdHash,
      expiresAt: input.nextExpiresAt,
    });
  }

  async appendSecurityEvent(
    event: Omit<IndependentAdminPrincipalAuditEvent, "sequence">,
  ): Promise<void> {
    if (this.audit.length >= MAX_FAKE_AUDIT_EVENTS) {
      throw new Error("Independent administrator audit is unavailable.");
    }
    this.sequence += 1;
    this.audit.push(Object.freeze({ sequence: this.sequence, ...event }));
  }

  listAudit(): readonly IndependentAdminPrincipalAuditEvent[] {
    return Object.freeze(this.audit.slice());
  }
}
