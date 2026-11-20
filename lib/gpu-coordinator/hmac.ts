import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { CoordinatorResponseEnvelope } from "./types";

export const COORDINATOR_HMAC_HEADERS = {
  keyId: "x-aistory-key-id",
  timestamp: "x-aistory-timestamp",
  nonce: "x-aistory-nonce",
  requestId: "x-aistory-request-id",
  contentSha256: "x-aistory-content-sha256",
  signature: "x-aistory-signature",
} as const;

export type CoordinatorHmacKey = {
  keyId: string;
  secret: Uint8Array;
};

export type CoordinatorHmacKeyRing = {
  current: CoordinatorHmacKey;
  previous?: CoordinatorHmacKey & {
    validUntil: Date;
  };
};

export type CoordinatorReplayGuard = {
  consume(
    keyId: string,
    nonce: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
};

export type VerifiedCoordinatorRequest = {
  keyId: string;
  timestamp: number;
  nonce: string;
  requestId: string;
  contentSha256: string;
};

export class CoordinatorHmacError extends Error {
  constructor(
    readonly code:
      | "hmac_signature_invalid"
      | "hmac_replay_rejected"
      | "request_stale"
      | "bad_request",
  ) {
    super(code);
    this.name = "CoordinatorHmacError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmac(secret: Uint8Array, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function cleanKeyId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
    throw new CoordinatorHmacError("bad_request");
  }
  return value;
}

function cleanNonce(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new CoordinatorHmacError("bad_request");
  }
  return value;
}

function cleanRequestId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value)) {
    throw new CoordinatorHmacError("bad_request");
  }
  return value;
}

function cleanHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new CoordinatorHmacError("bad_request");
  }
  return value;
}

function cleanSignature(value: string): string {
  const match = /^v1=([a-f0-9]{64})$/.exec(value);
  if (!match) throw new CoordinatorHmacError("bad_request");
  return match[1]!;
}

function signatureMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function canonicalCoordinatorPath(value: string): string {
  const url = new URL(value, "https://coordinator.invalid");
  if (
    url.origin !== "https://coordinator.invalid" ||
    url.hash ||
    !url.pathname.startsWith("/") ||
    url.pathname.includes("//")
  ) {
    throw new CoordinatorHmacError("bad_request");
  }
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const [key, item] of url.searchParams.entries()) {
    if (seen.has(key)) throw new CoordinatorHmacError("bad_request");
    seen.add(key);
    pairs.push([key, item]);
  }
  pairs.sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(pairs).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function canonicalCoordinatorRequest(input: {
  keyId: string;
  timestamp: number;
  nonce: string;
  requestId: string;
  method: string;
  path: string;
  contentSha256: string;
}): string {
  return [
    "aistory-hmac-v1",
    cleanKeyId(input.keyId),
    String(input.timestamp),
    cleanNonce(input.nonce),
    cleanRequestId(input.requestId),
    input.method.toUpperCase(),
    canonicalCoordinatorPath(input.path),
    cleanHash(input.contentSha256),
    "",
  ].join("\n");
}

export function canonicalCoordinatorResponse(input: {
  keyId: string;
  timestamp: number;
  nonce: string;
  requestId: string;
  status: number;
  path: string;
  contentSha256: string;
}): string {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new CoordinatorHmacError("bad_request");
  }
  return [
    "aistory-response-v1",
    cleanKeyId(input.keyId),
    String(input.timestamp),
    cleanNonce(input.nonce),
    cleanRequestId(input.requestId),
    String(input.status),
    canonicalCoordinatorPath(input.path),
    cleanHash(input.contentSha256),
    "",
  ].join("\n");
}

function keyForRequest(
  keyRing: CoordinatorHmacKeyRing,
  keyId: string,
  now: Date,
): CoordinatorHmacKey | undefined {
  if (keyRing.current.keyId === keyId) return keyRing.current;
  if (
    keyRing.previous?.keyId === keyId &&
    keyRing.previous.validUntil.getTime() >= now.getTime()
  ) {
    return keyRing.previous;
  }
  return undefined;
}

function header(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) throw new CoordinatorHmacError("bad_request");
  return value;
}

export async function verifyCoordinatorRequest(input: {
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array;
  keyRing: CoordinatorHmacKeyRing;
  replayGuard: CoordinatorReplayGuard;
  now: Date;
  clockWindowSeconds?: number;
}): Promise<VerifiedCoordinatorRequest> {
  if (!["POST", "PUT"].includes(input.method.toUpperCase())) {
    throw new CoordinatorHmacError("bad_request");
  }
  const keyId = cleanKeyId(header(input.headers, COORDINATOR_HMAC_HEADERS.keyId));
  const nonce = cleanNonce(header(input.headers, COORDINATOR_HMAC_HEADERS.nonce));
  const requestId = cleanRequestId(
    header(input.headers, COORDINATOR_HMAC_HEADERS.requestId),
  );
  const contentSha256 = cleanHash(
    header(input.headers, COORDINATOR_HMAC_HEADERS.contentSha256),
  );
  const signature = cleanSignature(
    header(input.headers, COORDINATOR_HMAC_HEADERS.signature),
  );
  const timestampText = header(
    input.headers,
    COORDINATOR_HMAC_HEADERS.timestamp,
  );
  if (!/^\d{10}$/.test(timestampText)) {
    throw new CoordinatorHmacError("bad_request");
  }
  const timestamp = Number(timestampText);
  const windowSeconds = Math.min(
    600,
    Math.max(30, input.clockWindowSeconds ?? 300),
  );
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > windowSeconds) {
    throw new CoordinatorHmacError("request_stale");
  }
  if (sha256(input.body) !== contentSha256) {
    throw new CoordinatorHmacError("hmac_signature_invalid");
  }
  const key = keyForRequest(input.keyRing, keyId, input.now);
  if (!key || key.secret.byteLength < 32) {
    throw new CoordinatorHmacError("hmac_signature_invalid");
  }
  const canonical = canonicalCoordinatorRequest({
    keyId,
    timestamp,
    nonce,
    requestId,
    method: input.method,
    path: input.path,
    contentSha256,
  });
  if (!signatureMatches(hmac(key.secret, canonical), signature)) {
    throw new CoordinatorHmacError("hmac_signature_invalid");
  }
  const consumed = await input.replayGuard.consume(
    keyId,
    nonce,
    new Date((timestamp + windowSeconds) * 1000),
    input.now,
  );
  if (!consumed) throw new CoordinatorHmacError("hmac_replay_rejected");
  return { keyId, timestamp, nonce, requestId, contentSha256 };
}

export function signCoordinatorRequest(input: {
  method: "POST";
  path: string;
  body: Uint8Array;
  key: CoordinatorHmacKey;
  timestamp: number;
  nonce: string;
  requestId: string;
}): Headers {
  if (input.key.secret.byteLength < 32) {
    throw new CoordinatorHmacError("bad_request");
  }
  const contentSha256 = sha256(input.body);
  const canonical = canonicalCoordinatorRequest({
    keyId: input.key.keyId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    contentSha256,
  });
  return new Headers({
    [COORDINATOR_HMAC_HEADERS.keyId]: input.key.keyId,
    [COORDINATOR_HMAC_HEADERS.timestamp]: String(input.timestamp),
    [COORDINATOR_HMAC_HEADERS.nonce]: input.nonce,
    [COORDINATOR_HMAC_HEADERS.requestId]: input.requestId,
    [COORDINATOR_HMAC_HEADERS.contentSha256]: contentSha256,
    [COORDINATOR_HMAC_HEADERS.signature]: `v1=${hmac(
      input.key.secret,
      canonical,
    )}`,
    "content-type": "application/json",
  });
}

export function signCoordinatorResponse<T>(input: {
  envelope: CoordinatorResponseEnvelope<T>;
  status: number;
  path: string;
  key: CoordinatorHmacKey;
  now: Date;
  nonce?: string;
}): {
  body: Uint8Array;
  headers: Headers;
} {
  if (input.key.secret.byteLength < 32) {
    throw new CoordinatorHmacError("bad_request");
  }
  const body = new TextEncoder().encode(JSON.stringify(input.envelope));
  const timestamp = Math.floor(input.now.getTime() / 1000);
  const nonce = input.nonce ?? randomBytes(24).toString("base64url");
  const contentSha256 = sha256(body);
  const canonical = canonicalCoordinatorResponse({
    keyId: input.key.keyId,
    timestamp,
    nonce,
    requestId: input.envelope.requestId,
    status: input.status,
    path: input.path,
    contentSha256,
  });
  return {
    body,
    headers: new Headers({
      [COORDINATOR_HMAC_HEADERS.keyId]: input.key.keyId,
      [COORDINATOR_HMAC_HEADERS.timestamp]: String(timestamp),
      [COORDINATOR_HMAC_HEADERS.nonce]: nonce,
      [COORDINATOR_HMAC_HEADERS.requestId]: input.envelope.requestId,
      [COORDINATOR_HMAC_HEADERS.contentSha256]: contentSha256,
      [COORDINATOR_HMAC_HEADERS.signature]: `v1=${hmac(
        input.key.secret,
        canonical,
      )}`,
      "content-type": "application/json",
      "cache-control": "no-store",
    }),
  };
}

export function verifyCoordinatorResponse(input: {
  status: number;
  path: string;
  headers: Headers;
  body: Uint8Array;
  keyRing: CoordinatorHmacKeyRing;
  now: Date;
  clockWindowSeconds?: number;
}): VerifiedCoordinatorRequest {
  const keyId = cleanKeyId(header(input.headers, COORDINATOR_HMAC_HEADERS.keyId));
  const nonce = cleanNonce(header(input.headers, COORDINATOR_HMAC_HEADERS.nonce));
  const requestId = cleanRequestId(
    header(input.headers, COORDINATOR_HMAC_HEADERS.requestId),
  );
  const contentSha256 = cleanHash(
    header(input.headers, COORDINATOR_HMAC_HEADERS.contentSha256),
  );
  const signature = cleanSignature(
    header(input.headers, COORDINATOR_HMAC_HEADERS.signature),
  );
  const timestampText = header(
    input.headers,
    COORDINATOR_HMAC_HEADERS.timestamp,
  );
  if (!/^\d{10}$/.test(timestampText)) {
    throw new CoordinatorHmacError("bad_request");
  }
  const timestamp = Number(timestampText);
  const windowSeconds = Math.min(
    600,
    Math.max(30, input.clockWindowSeconds ?? 300),
  );
  if (
    Math.abs(Math.floor(input.now.getTime() / 1000) - timestamp) >
    windowSeconds
  ) {
    throw new CoordinatorHmacError("request_stale");
  }
  if (sha256(input.body) !== contentSha256) {
    throw new CoordinatorHmacError("hmac_signature_invalid");
  }
  const key = keyForRequest(input.keyRing, keyId, input.now);
  if (!key) throw new CoordinatorHmacError("hmac_signature_invalid");
  const canonical = canonicalCoordinatorResponse({
    keyId,
    timestamp,
    nonce,
    requestId,
    status: input.status,
    path: input.path,
    contentSha256,
  });
  if (!signatureMatches(hmac(key.secret, canonical), signature)) {
    throw new CoordinatorHmacError("hmac_signature_invalid");
  }
  return { keyId, timestamp, nonce, requestId, contentSha256 };
}

export function decodeCoordinatorHmacSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new CoordinatorHmacError("bad_request");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength < 32 ||
    decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw new CoordinatorHmacError("bad_request");
  }
  return decoded;
}

export const COORDINATOR_HMAC_TEST_VECTOR_INPUT = {
  keyId: "connector-test-current",
  secretBase64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  timestamp: 1785400000,
  nonce: "test-nonce-000000000001",
  requestId: "req-test-0001",
  method: "POST",
  path: "/api/gpu-coordinator/v1/heartbeat?beta=two&alpha=1",
  bodyUtf8:
    '{"connectorId":"connector-test","protocolVersion":"1.0","sequence":7}',
  responseStatus: 200,
  responseNonce: "test-response-nonce-000001",
  responseBodyUtf8:
    '{"protocolVersion":"1.0","requestId":"req-test-0001","serverTime":"2026-07-30T00:00:00.000Z","sequence":7,"ok":true,"control":{"revoked":false,"minimumConnectorVersion":"0.2.0","currentKeyId":"connector-test-current","acceptedKeyIds":["connector-test-current"]},"data":{"acceptedSequence":7}}',
} as const;

export const COORDINATOR_HMAC_TEST_VECTOR_EXPECTED = {
  canonicalPath: "/api/gpu-coordinator/v1/heartbeat?alpha=1&beta=two",
  requestBodySha256:
    "90ab1be8fcb57880460363421aff9a22fa5778d7aefd525edef4b79bd6c3f71e",
  canonicalRequestUtf8:
    "aistory-hmac-v1\nconnector-test-current\n1785400000\ntest-nonce-000000000001\nreq-test-0001\nPOST\n/api/gpu-coordinator/v1/heartbeat?alpha=1&beta=two\n90ab1be8fcb57880460363421aff9a22fa5778d7aefd525edef4b79bd6c3f71e\n",
  requestSignatureHex:
    "2a9e3797529a09e3817c509abb64cce06faee48bdaee2c96a5b219c33e108496",
  responseBodySha256:
    "ecb7ab4e264e0518b7f3086cc122992d54ad1e6a0cebdd971f6aff45063c75d9",
  canonicalResponseUtf8:
    "aistory-response-v1\nconnector-test-current\n1785400000\ntest-response-nonce-000001\nreq-test-0001\n200\n/api/gpu-coordinator/v1/heartbeat?alpha=1&beta=two\necb7ab4e264e0518b7f3086cc122992d54ad1e6a0cebdd971f6aff45063c75d9\n",
  responseSignatureHex:
    "73fb9af2906cf79c21a86e01af44edb470e50e7337748f3d21ad5c8b6ebb1807",
} as const;
