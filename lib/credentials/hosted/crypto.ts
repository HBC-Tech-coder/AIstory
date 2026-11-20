import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { CredentialModality } from "@/lib/credentials/types";
import {
  findHostedCredentialRule,
  type HostedCredentialConfig,
  HostedCredentialUnavailableError,
  isAllowedHostedCredentialTarget,
} from "./config";
import type { HostedCredentialProvider } from "./types";

const ENVELOPE_VERSION = 1;
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export type HostedCredentialPlaintext = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type HostedCredentialEnvelope = {
  envelopeVersion: 1;
  credentialId: string;
  ownerUserId: string;
  tenantId: string;
  provider: HostedCredentialProvider;
  capabilities: CredentialModality[];
  defaultFor: CredentialModality[];
  maskedLabel: string;
  ciphertext: string;
  nonce: string;
  tag: string;
  wrappedDek: string;
  wrapNonce: string;
  wrapTag: string;
  kekVersion: string;
};

function canonicalAad(
  kind: "payload" | "dek",
  identity: Pick<
    HostedCredentialEnvelope,
    "tenantId" | "ownerUserId" | "credentialId" | "provider" | "envelopeVersion"
  >,
): Buffer {
  return Buffer.from(JSON.stringify([
    `aistory-hosted-byok-${kind}`,
    identity.tenantId,
    identity.ownerUserId,
    identity.credentialId,
    identity.provider,
    identity.envelopeVersion,
  ]), "utf8");
}

function encryptBytes(
  plaintext: Buffer,
  key: Buffer,
  aad: Buffer,
): { ciphertext: string; nonce: string; tag: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptBytes(
  encrypted: { ciphertext: string; nonce: string; tag: string },
  key: Buffer,
  aad: Buffer,
): Buffer {
  const nonce = Buffer.from(encrypted.nonce, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new HostedCredentialUnavailableError("encryption_unavailable", 409);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new HostedCredentialUnavailableError("encryption_unavailable", 409);
  }
}

function validateIdentity(input: {
  credentialId: string;
  ownerUserId: string;
  tenantId: string;
}): void {
  if (
    !SAFE_ID.test(input.credentialId)
    || !SAFE_ID.test(input.ownerUserId)
    || !SAFE_TENANT.test(input.tenantId)
  ) throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
}

function validatePlaintext(
  plaintext: HostedCredentialPlaintext,
  config: HostedCredentialConfig,
  provider: HostedCredentialProvider,
): HostedCredentialPlaintext {
  const apiKey = plaintext.apiKey.trim();
  const baseUrl = plaintext.baseUrl.trim();
  const model = plaintext.model.trim();
  const rule = findHostedCredentialRule(config, provider);
  if (
    apiKey.length < 8
    || apiKey.length > 4096
    || baseUrl.length > 500
    || model.length > 160
    || !isAllowedHostedCredentialTarget(rule, baseUrl, model)
  ) throw new HostedCredentialUnavailableError("provider_allowlist_unavailable", 403);
  return { apiKey, baseUrl, model };
}

export function encryptHostedCredential(input: {
  config: HostedCredentialConfig;
  credentialId: string;
  ownerUserId: string;
  tenantId: string;
  provider: HostedCredentialProvider;
  capabilities: CredentialModality[];
  defaultFor: CredentialModality[];
  maskedLabel: string;
  plaintext: HostedCredentialPlaintext;
}): HostedCredentialEnvelope {
  validateIdentity(input);
  const plaintext = validatePlaintext(input.plaintext, input.config, input.provider);
  const identity = {
    envelopeVersion: 1 as const,
    credentialId: input.credentialId,
    ownerUserId: input.ownerUserId,
    tenantId: input.tenantId,
    provider: input.provider,
  };
  const dek = randomBytes(32);
  const payload = Buffer.from(JSON.stringify(plaintext), "utf8");
  try {
    const encryptedPayload = encryptBytes(payload, dek, canonicalAad("payload", identity));
    const activeKek = input.config.keyRing.keys.get(input.config.keyRing.activeVersion);
    if (!activeKek) throw new HostedCredentialUnavailableError("encryption_unavailable");
    const encryptedDek = encryptBytes(dek, activeKek, canonicalAad("dek", identity));
    return {
      ...identity,
      capabilities: [...input.capabilities],
      defaultFor: [...input.defaultFor],
      maskedLabel: input.maskedLabel,
      ciphertext: encryptedPayload.ciphertext,
      nonce: encryptedPayload.nonce,
      tag: encryptedPayload.tag,
      wrappedDek: encryptedDek.ciphertext,
      wrapNonce: encryptedDek.nonce,
      wrapTag: encryptedDek.tag,
      kekVersion: input.config.keyRing.activeVersion,
    };
  } finally {
    dek.fill(0);
    payload.fill(0);
  }
}

export function decryptHostedCredential(
  envelope: HostedCredentialEnvelope,
  config: HostedCredentialConfig,
): HostedCredentialPlaintext {
  validateIdentity(envelope);
  if (envelope.envelopeVersion !== ENVELOPE_VERSION) {
    throw new HostedCredentialUnavailableError("encryption_unavailable", 409);
  }
  const kek = config.keyRing.keys.get(envelope.kekVersion);
  if (!kek) throw new HostedCredentialUnavailableError("encryption_unavailable", 409);
  const identity = {
    envelopeVersion: envelope.envelopeVersion,
    credentialId: envelope.credentialId,
    ownerUserId: envelope.ownerUserId,
    tenantId: envelope.tenantId,
    provider: envelope.provider,
  };
  const dek = decryptBytes({
    ciphertext: envelope.wrappedDek,
    nonce: envelope.wrapNonce,
    tag: envelope.wrapTag,
  }, kek, canonicalAad("dek", identity));
  let payload: Buffer | undefined;
  try {
    payload = decryptBytes({
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      tag: envelope.tag,
    }, dek, canonicalAad("payload", identity));
    const parsed = JSON.parse(payload.toString("utf8")) as HostedCredentialPlaintext;
    return validatePlaintext(parsed, config, envelope.provider);
  } catch (error) {
    if (error instanceof HostedCredentialUnavailableError) throw error;
    throw new HostedCredentialUnavailableError("encryption_unavailable", 409);
  } finally {
    dek.fill(0);
    payload?.fill(0);
  }
}

export function rewrapHostedCredentialDek(
  envelope: HostedCredentialEnvelope,
  config: HostedCredentialConfig,
): HostedCredentialEnvelope {
  if (envelope.kekVersion === config.keyRing.activeVersion) return { ...envelope };
  const oldKek = config.keyRing.keys.get(envelope.kekVersion);
  const newKek = config.keyRing.keys.get(config.keyRing.activeVersion);
  if (!oldKek || !newKek) {
    throw new HostedCredentialUnavailableError("encryption_unavailable", 409);
  }
  const identity = {
    envelopeVersion: envelope.envelopeVersion,
    credentialId: envelope.credentialId,
    ownerUserId: envelope.ownerUserId,
    tenantId: envelope.tenantId,
    provider: envelope.provider,
  };
  const dek = decryptBytes({
    ciphertext: envelope.wrappedDek,
    nonce: envelope.wrapNonce,
    tag: envelope.wrapTag,
  }, oldKek, canonicalAad("dek", identity));
  try {
    const wrapped = encryptBytes(dek, newKek, canonicalAad("dek", identity));
    return {
      ...envelope,
      wrappedDek: wrapped.ciphertext,
      wrapNonce: wrapped.nonce,
      wrapTag: wrapped.tag,
      kekVersion: config.keyRing.activeVersion,
    };
  } finally {
    dek.fill(0);
  }
}
