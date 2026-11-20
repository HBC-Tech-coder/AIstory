import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256 } from "./linghaoPassportV4ProductionContract";

export const LINGHAO_PASSPORT_V4_STATE_SEAL_KEY_REFERENCE =
  "ref_aistory_linghao_passport_v4_state_seal_v1" as const;

export type LinghaoPassportV4SealedKind =
  | "authorization_transaction"
  | "session_result"
  | "id_token_hint"
  | "access_token"
  | "refresh_token";

const ENVELOPE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{1,21846})\.([A-Za-z0-9_-]{22})$/;
const MAX_PLAINTEXT_BYTES = 12 * 1024;

function reject(): never {
  throw new Error("linghao_passport_v4_state_seal_rejected");
}

function aad(kind: LinghaoPassportV4SealedKind, contextHash: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(contextHash)) reject();
  return Buffer.from(
    [
      "aistory.linghao-passport-v4.state-seal.v1",
      LINGHAO_PASSPORT_V4_PRODUCTION_REGISTRATION_SHA256,
      LINGHAO_PASSPORT_V4_STATE_SEAL_KEY_REFERENCE,
      kind,
      contextHash,
    ].join("\0"),
    "utf8",
  );
}

function exactKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) reject();
  return Buffer.from(key);
}

function exactPlaintext(plaintext: Uint8Array): Buffer {
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.byteLength < 1 ||
    plaintext.byteLength > MAX_PLAINTEXT_BYTES
  ) {
    reject();
  }
  return Buffer.from(plaintext);
}

export function sealLinghaoPassportV4State(
  kind: LinghaoPassportV4SealedKind,
  contextHash: string,
  plaintext: Uint8Array,
  key: Uint8Array,
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): string {
  const keyBuffer = exactKey(key);
  const body = exactPlaintext(plaintext);
  const nonceBytes = randomBytes(12);
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== 12) {
    keyBuffer.fill(0);
    body.fill(0);
    reject();
  }
  const nonce = Buffer.from(nonceBytes);
  try {
    const cipher = createCipheriv("aes-256-gcm", keyBuffer, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad(kind, contextHash), { plaintextLength: body.byteLength });
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
  } catch {
    return reject();
  } finally {
    keyBuffer.fill(0);
    body.fill(0);
    nonce.fill(0);
  }
}

export function openLinghaoPassportV4State(
  kind: LinghaoPassportV4SealedKind,
  contextHash: string,
  envelope: string,
  key: Uint8Array,
): Uint8Array {
  if (typeof envelope !== "string" || envelope.length > 22_000) reject();
  const match = ENVELOPE.exec(envelope);
  if (!match) reject();
  const keyBuffer = exactKey(key);
  const nonce = Buffer.from(match[1]!, "base64url");
  const encrypted = Buffer.from(match[2]!, "base64url");
  const tag = Buffer.from(match[3]!, "base64url");
  if (
    nonce.byteLength !== 12 ||
    tag.byteLength !== 16 ||
    encrypted.byteLength < 1 ||
    encrypted.byteLength > MAX_PLAINTEXT_BYTES
  ) {
    keyBuffer.fill(0);
    reject();
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBuffer, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(kind, contextHash), { plaintextLength: encrypted.byteLength });
    decipher.setAuthTag(tag);
    return new Uint8Array(
      Buffer.concat([decipher.update(encrypted), decipher.final()]),
    );
  } catch {
    return reject();
  } finally {
    keyBuffer.fill(0);
    nonce.fill(0);
    encrypted.fill(0);
    tag.fill(0);
  }
}

export function isLinghaoPassportV4StateEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.length <= 22_000 && ENVELOPE.test(value);
}
