import "server-only";

import { constants } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { createProductionSupabaseServiceClient } from "@/lib/production/databaseGate";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_PATHS,
  linghaoPassportV4ProductionConfigFileReference,
  validateLinghaoPassportV4HostReceipt,
  validateLinghaoPassportV4ProductionConfiguration,
  validateLinghaoPassportV4RegistryReceipt,
  type LinghaoPassportV4ProductionConfiguration,
  type LinghaoPassportV4ProductionEnvironment,
} from "./linghaoPassportV4ProductionContract";
import {
  assertLinghaoPassportV4DurableAuthorityGate,
  type LinghaoPassportV4DurableAuthority,
} from "./linghaoPassportV4DurableAuthority";
import { createLinghaoPassportV4DurableAuthority } from "./linghaoPassportV4DurableRepository";

export type LinghaoPassportV4ProtectedMetadata = Readonly<{
  regular: boolean;
  symbolicLink: boolean;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
  size: number;
}>;

export type LinghaoPassportV4ProductionMaterials = Readonly<{
  configuration: LinghaoPassportV4ProductionConfiguration;
  clientSecret: string;
  stateSealKey: Uint8Array;
  authority: LinghaoPassportV4DurableAuthority;
}>;

function reject(): never {
  throw new Error("linghao_passport_v4_production_runtime_unavailable");
}

export function assertLinghaoPassportV4ProtectedFile(
  metadata: LinghaoPassportV4ProtectedMetadata,
  expectedUid: number,
  expectedGid: number,
  maximumBytes: number,
): void {
  const permission = metadata.mode & 0o777;
  if (
    !metadata.regular ||
    metadata.symbolicLink ||
    metadata.uid !== expectedUid ||
    metadata.gid !== expectedGid ||
    metadata.nlink !== 1 ||
    (permission !== 0o400 && permission !== 0o600) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    reject();
  }
}

function metadata(info: Awaited<ReturnType<typeof lstat>>): LinghaoPassportV4ProtectedMetadata {
  return {
    regular: info.isFile(),
    symbolicLink: info.isSymbolicLink(),
    uid: Number(info.uid),
    gid: Number(info.gid),
    mode: Number(info.mode),
    nlink: Number(info.nlink),
    size: Number(info.size),
  };
}

async function assertParents(file: string, uid: number): Promise<void> {
  if (path.posix.normalize(file) !== file || !file.startsWith("/")) reject();
  let current = path.posix.dirname(file);
  for (;;) {
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o022) !== 0 ||
      ![0, uid].includes(info.uid) ||
      (await realpath(current)) !== current
    ) {
      reject();
    }
    if (current === "/") break;
    current = path.posix.dirname(current);
  }
}

async function readProtected(
  file: string,
  uid: number,
  gid: number,
  maximumBytes: number,
): Promise<Buffer> {
  await assertParents(file, uid);
  const before = await lstat(file);
  assertLinghaoPassportV4ProtectedFile(metadata(before), uid, gid, maximumBytes);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertLinghaoPassportV4ProtectedFile(metadata(opened), uid, gid, maximumBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino) reject();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    for (;;) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (size > maximumBytes) reject();
    }
    const after = await handle.stat();
    const leaf = await lstat(file);
    assertLinghaoPassportV4ProtectedFile(metadata(after), uid, gid, maximumBytes);
    assertLinghaoPassportV4ProtectedFile(metadata(leaf), uid, gid, maximumBytes);
    if (
      size !== before.size ||
      after.size !== size ||
      after.mtimeMs !== before.mtimeMs ||
      leaf.dev !== before.dev ||
      leaf.ino !== before.ino
    ) {
      reject();
    }
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function assertProtectedDirectory(directory: string, uid: number, gid: number): Promise<void> {
  await assertParents(`${directory}/entry`, uid);
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    info.gid !== gid ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  ) {
    reject();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return reject();
  }
}

function verifyHash(bytes: Buffer, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest();
  const expectedBytes = Buffer.from(expected, "hex");
  if (expectedBytes.byteLength !== actual.byteLength || !timingSafeEqual(actual, expectedBytes)) reject();
}

export function decodeLinghaoPassportV4StateSealKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) reject();
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) {
    key.fill(0);
    reject();
  }
  const output = Uint8Array.from(key);
  key.fill(0);
  return output;
}

export async function loadLinghaoPassportV4ProductionMaterials(
  environment: LinghaoPassportV4ProductionEnvironment = process.env,
): Promise<LinghaoPassportV4ProductionMaterials | null> {
  const configFile = linghaoPassportV4ProductionConfigFileReference(environment);
  if (configFile === null || !process.getuid || !process.getgid) return null;
  const uid = process.getuid();
  const gid = process.getgid();
  const configBytes = await readProtected(configFile, uid, gid, 16 * 1024);
  const configuration = validateLinghaoPassportV4ProductionConfiguration(parseJson(configBytes));
  if (configuration.recipientUid !== uid || configuration.recipientGid !== gid) reject();
  const registryBytes = await readProtected(configuration.registryReceiptFile, uid, gid, 16 * 1024);
  verifyHash(registryBytes, configuration.registryReceiptSha256);
  validateLinghaoPassportV4RegistryReceipt(parseJson(registryBytes));
  const hostBytes = await readProtected(configuration.hostReceiptFile, uid, gid, 16 * 1024);
  verifyHash(hostBytes, configuration.hostReceiptSha256);
  validateLinghaoPassportV4HostReceipt(parseJson(hostBytes), configuration);
  await assertProtectedDirectory(configuration.stateDirectory, uid, gid);
  assertLinghaoPassportV4DurableAuthorityGate(environment);

  // The database credential is resolved only after both non-secret receipts
  // and the exact independent Passport gate have passed.
  const authority = createLinghaoPassportV4DurableAuthority(
    createProductionSupabaseServiceClient(environment),
    environment,
  );
  await authority.assertReady();

  const secretBytes = await readProtected(configuration.secretFile, uid, gid, 512);
  const stateKeyBytes = await readProtected(configuration.stateSealKeyFile, uid, gid, 128);
  try {
    const clientSecret = new TextDecoder("utf-8", { fatal: true })
      .decode(secretBytes)
      .replace(/\n$/, "");
    const encodedStateKey = new TextDecoder("utf-8", { fatal: true })
      .decode(stateKeyBytes)
      .replace(/\n$/, "");
    if (
      clientSecret.length < 32 ||
      clientSecret.length > 256 ||
      !/^[\x21-\x7e]+$/.test(clientSecret) ||
      clientSecret === encodedStateKey
    ) {
      reject();
    }
    return Object.freeze({
      configuration,
      clientSecret,
      stateSealKey: decodeLinghaoPassportV4StateSealKey(encodedStateKey),
      authority,
    });
  } catch {
    return reject();
  } finally {
    secretBytes.fill(0);
    stateKeyBytes.fill(0);
  }
}

export const LINGHAO_PASSPORT_V4_EXPECTED_STATE_KEY_FILE =
  LINGHAO_PASSPORT_V4_PRODUCTION_PATHS.stateSealKeyFile;
