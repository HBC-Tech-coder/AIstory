import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";

/**
 * The only real runtime secret source for the Linghao Passport v4 local test
 * surface. The value itself is never accepted from an environment variable.
 */
export const LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE";
export const LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH =
  "C:\\Users\\sunat\\AppData\\Local\\AIstory\\secrets\\linghao-passport-v4\\client-secret.v1";

export const LINGHAO_PASSPORT_V4_SECRET_MIN_BYTES = 32;
export const LINGHAO_PASSPORT_V4_SECRET_MAX_BYTES = 256;

export type LinghaoPassportV4SecretReader = (filePath: string) => string;

export interface LinghaoPassportV4SecretFileSystem {
  lstat(filePath: string): Stats;
  realpath(filePath: string): string;
  open(filePath: string): number;
  fstat(fileDescriptor: number): Stats;
  read(
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): number;
  close(fileDescriptor: number): void;
}

export interface LinghaoPassportV4SecretFileReadOptions {
  /**
   * Test seam only. Production callers never pass this: the exact registered
   * path is the default and is already checked before this module is entered.
   */
  readonly exactPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: LinghaoPassportV4SecretFileSystem;
}

const DEFAULT_FILE_SYSTEM: LinghaoPassportV4SecretFileSystem = {
  lstat: (filePath) => lstatSync(filePath),
  realpath: (filePath) => realpathSync.native(filePath),
  open: (filePath) => openSync(filePath, "r"),
  fstat: (fileDescriptor) => fstatSync(fileDescriptor),
  read: (fileDescriptor, buffer, offset, length, position) =>
    readSync(fileDescriptor, buffer, offset, length, position),
  close: (fileDescriptor) => closeSync(fileDescriptor),
};

function fail(): never {
  throw new Error("client secret file is unavailable");
}

function canonicalPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) fail();
  return path.win32.normalize(path.win32.resolve(value)).toLowerCase();
}

function sameIdentityAndSize(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function assertRegularSingleLinkFile(stats: Stats, expectedBytes: number): void {
  if (!stats.isFile()) fail();
  if (stats.isSymbolicLink()) fail();
  if (stats.nlink !== 1) fail();
  if (
    stats.size < LINGHAO_PASSPORT_V4_SECRET_MIN_BYTES ||
    stats.size > LINGHAO_PASSPORT_V4_SECRET_MAX_BYTES ||
    stats.size !== expectedBytes
  ) {
    fail();
  }
}

/**
 * Reads the protected secret through one open handle.
 *
 * Pre-open lstat and post-open fstat must describe the same single-link regular
 * file. The exact bounded byte count is read once; the mutable buffer is zeroed
 * in `finally`. Every validation failure is deliberately indistinguishable and
 * never contains the secret, its path, or a byte of its content.
 */
export function readLinghaoPassportV4ClientSecretFile(
  filePath: string,
  options: LinghaoPassportV4SecretFileReadOptions = {},
): string {
  if ((options.platform ?? process.platform) !== "win32") fail();
  const exactPath =
    options.exactPath ?? LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH;
  if (filePath !== exactPath) fail();

  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const expectedCanonical = canonicalPath(exactPath);
  const buffer = Buffer.alloc(LINGHAO_PASSPORT_V4_SECRET_MAX_BYTES + 1);
  let fileDescriptor: number | undefined;
  try {
    const before = fileSystem.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail();
    if (
      before.size < LINGHAO_PASSPORT_V4_SECRET_MIN_BYTES ||
      before.size > LINGHAO_PASSPORT_V4_SECRET_MAX_BYTES
    ) {
      fail();
    }

    let realPath: string;
    try {
      realPath = fileSystem.realpath(filePath);
    } catch {
      fail();
    }
    if (canonicalPath(realPath) !== expectedCanonical) fail();

    try {
      fileDescriptor = fileSystem.open(filePath);
    } catch {
      fail();
    }

    const opened = fileSystem.fstat(fileDescriptor);
    if (!before.isFile() || !opened.isFile() || opened.isSymbolicLink()) fail();
    if (opened.nlink !== 1) fail();
    if (!sameIdentityAndSize(before, opened)) fail();
    assertRegularSingleLinkFile(opened, before.size);

    const size = opened.size;
    let total = 0;
    while (total < size + 1) {
      const read = fileSystem.read(
        fileDescriptor,
        buffer,
        total,
        size + 1 - total,
        total,
      );
      if (read <= 0) break;
      total += read;
    }
    if (total !== size) fail();

    const after = fileSystem.fstat(fileDescriptor);
    assertRegularSingleLinkFile(after, size);
    if (!sameIdentityAndSize(opened, after)) fail();

    if (
      buffer[0] === 0xef &&
      buffer[1] === 0xbb &&
      buffer[2] === 0xbf
    ) {
      fail();
    }

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } catch {
      fail();
    }
    if (
      decoded.length < LINGHAO_PASSPORT_V4_SECRET_MIN_BYTES ||
      decoded.length > LINGHAO_PASSPORT_V4_SECRET_MAX_BYTES ||
      !/^[\x21-\x7e]+$/.test(decoded)
    ) {
      fail();
    }
    return decoded;
  } catch {
    fail();
  } finally {
    buffer.fill(0);
    if (fileDescriptor !== undefined) {
      try {
        fileSystem.close(fileDescriptor);
      } catch {
        // Closing is best effort; the read result has already been decided.
      }
    }
  }
  return fail();
}

